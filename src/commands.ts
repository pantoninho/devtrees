/**
 * Commands (orchestration).
 *
 * `up` and `down` wire the deep cores (anchor resolver, stack model, allocator,
 * deriver) to the adapters (driver, filesystem, registry). They own no domain
 * logic of their own — they sequence the modules and perform the I/O. Every
 * side-effecting collaborator is injected so the orchestration is exercisable in
 * an e2e against a temp git repo + stub process-compose.
 */

import {
  allocateBlock,
  type AllocatorOptions,
  DEFAULT_ALLOCATOR,
  type RegistrySnapshot,
} from "./allocator.js";
import { resolveAnchor, type GitProbe } from "./anchor.js";
import {
  bracedEnvVars,
  deriveSharedConfig,
  deriveWorktreeConfig,
  type BracedEnvVar,
  type DerivedConfig,
  type DroppedEdge,
} from "./deriver.js";
import {
  discoverInstances,
  PROBE_RETRY_DELAYS_MS,
  probeSocket as defaultProbeSocket,
  probeUntilDefinitive,
  readDeclaredPorts,
  type InstanceInfo,
  type InstanceStatus,
  type Service,
} from "./instances.js";
import {
  SHARED_INSTANCE_ID,
  SHARED_REGISTRY_KEY,
  assertSocketPathFits,
  ensureRunDir,
  instancePaths,
  logsDir,
  sharedInstancePaths,
} from "./paths.js";
import {
  formatBracedEnvVarWarning,
  formatDroppedEdgeWarning,
  formatDroppedNamespaceEdgeWarning,
  formatSharedFieldChangeWarning,
} from "./output.js";
import { findDeadReservations, findOrphans, parseWorktreeIds } from "./prune.js";
import { reapShutdownHooks, type ReapDeps, type ReapOutcome } from "./reaper.js";
import { loadStack, type ResolvedService, type ResolvedStack, type Tier } from "./stack.js";
import {
  boundedDown,
  DownTimeoutError,
  readProcessTable,
  readSupervisedTable,
  type ForceKilled,
  type ServiceProcess,
  type StopDriver,
  type StopResult,
  type StopSeams,
} from "./bounded-down.js";
import {
  createDriver,
  downTimeoutMs,
  mergeAsyncIterables,
  READ_TIMEOUT_MS,
  reloadTimeoutMs,
  type DriverDeps,
  type LogEvent,
  type ServiceStatus,
  type StreamLogsOptions,
} from "./driver.js";
import { readRegistry, withLifecycleLock, withRegistryLock, withSharedLock } from "./registry.js";
import {
  defaultIsPortFree,
  defaultPortHolder,
  identifyHolderViaLsof,
  type PortHolderReport,
} from "./port-probe.js";
import { acceptsConnections, forwarderLabel, isPortForwarder } from "./port-connect.js";
import {
  clearDownIncomplete,
  daemonHooksSkipped,
  unsignalledServices,
  downIncomplete,
  readDownIncomplete,
  writeDownIncomplete,
  findPortSurvivors,
  processSurvivor,
  type DownSurvivor,
  type PortSurvivorSeams,
} from "./down-survivors.js";
import { sharedExtendedFields, sharedStackHash, stackHash } from "./hash.js";
import { boundedRestart } from "./bounded-restart.js";
import {
  assertNotLastRunning,
  assertNotPending,
  instanceExitedError,
  instanceNotRunningError,
  partitionRunning,
  stopTimeoutMs,
} from "./stop-services.js";
import {
  declaredServices,
  expandNamespaces,
  notBootedNamespaces,
  orderedTargets,
  sharedAmong,
  unbootedServices,
  unknownService,
  type DeclaredService,
} from "./service-targets.js";
import {
  readStoredHash as defaultReadStoredHash,
  writeStoredHash as defaultWriteStoredHash,
} from "./hashes.js";
import {
  readSharedState,
  sharedFieldChanges,
  writeSharedState,
  type SharedFieldChange,
  type SharedState,
} from "./shared-state.js";
import {
  createWaitForHealth,
  createWaitForSharedHealth,
  isGone,
  readStatusesWithin,
  sharedServiceDeadError,
  type RestartedService,
  type WaitForHealth,
  type WaitingCommand,
  type WaitForSharedHealth,
} from "./health.js";
import {
  DEFAULT_NAMESPACE,
  declaredNamespaces,
  droppedNamespaceEdges,
  formatUpCommand,
  namespaceSelected,
  resolveRunningSelection,
  serviceNamespaces,
  type DroppedNamespaceEdge,
  type NamespaceNotRunning,
} from "./selection.js";
import {
  clearPendingReload,
  identifyOldRuns,
  isProcessAlive,
  namespaceOf,
  planPendingReload,
  readPendingReload,
  stuckFromMarker,
  provenNamespaces,
  writePendingReload,
  type PendingReload,
  type StuckReload,
} from "./reload-pending.js";
import { classifyService, dependencyOrder, findDeadServices } from "./service-state.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { TARGET_CANDIDATES, fencedBlock, upsertBlock } from "./onboarding.js";

// The health-gate contracts (and their driver-backed defaults) live in the
// health module (issue #87); re-exported here so `CommandDeps` callers keep a
// single import site.
export type { WaitForHealth, WaitForSharedHealth } from "./health.js";

/**
 * Thrown when `up` detects config drift against a running instance and the
 * driver could not hot-reload (older process-compose without `project
 * update`, or any failure to apply the new config). The instance keeps
 * running unchanged; the CLI maps this to the `CONFIG_DRIFT` error
 * envelope so an agent can decide whether to `down` + `up` or hand off to
 * a human (ADR-0005).
 *
 * `details.reason` lets an agent branch without parsing the message:
 * `timeout` means process-compose is still waiting for a changed service's
 * old process to exit (it is no longer listed, but the pending-reload marker
 * records it, so `down` force-kills it before stopping, #206).
 * `not_supported` / `error`
 * mean the reload was refused and the instance is untouched.
 * `reload_pending` (#191) means `up` did not reload at all: an earlier
 * reload is still waiting on an old process, and a second one would start an
 * untracked copy of the service. `details.services` names the stuck services
 * and `details.pids` the old processes to kill (empty when the old process
 * has exited but the service is not back yet). It can fire with no drift: reverting devtrees.yaml
 * does not stop process-compose applying the pending config.
 */
type ConfigDriftDetails =
  | { readonly reason: "timeout" | "not_supported" | "error" }
  | {
      readonly reason: "reload_pending";
      readonly services: ReadonlyArray<string>;
      readonly pids: ReadonlyArray<number>;
    };

class ConfigDriftError extends Error {
  readonly code = "CONFIG_DRIFT";
  readonly details: ConfigDriftDetails;
  constructor(message: string, details: ConfigDriftDetails) {
    super(message);
    this.name = "ConfigDriftError";
    this.details = details;
  }
}

/**
 * Thrown when this worktree's shared subset (its `shared`-tier services)
 * diverges from what the running shared instance was started with
 * (issue #83) — typically a branch that added, removed, or edited a shared
 * service. Injecting this worktree's recomputed numbers would not match the
 * ports the shared instance actually bound, so `up`/`env` fail loudly with
 * the `SHARED_DRIFT` envelope instead of silently injecting wrong
 * connection info. Remediation mirrors the worktree-level `CONFIG_DRIFT`
 * UX: `devtrees down --shared && devtrees up` restarts shared from this
 * worktree's config and re-persists the new map.
 */
class SharedDriftError extends Error {
  readonly code = "SHARED_DRIFT" as const;
  readonly details: {
    readonly worktree_id: string;
    readonly running_hash: string;
    readonly local_hash: string;
  };
  constructor(
    message: string,
    details: {
      readonly worktree_id: string;
      readonly running_hash: string;
      readonly local_hash: string;
    },
  ) {
    super(message);
    this.name = "SharedDriftError";
    this.details = details;
  }
}

/**
 * Thrown when the lazy-started shared instance dies before binding its
 * control socket (issue #92): `driver.up` is fire-and-forget, so an instantly
 * crashing process-compose (bad config, missing binary deps, port conflict at
 * bind time) is only observable as the socket never appearing. The socket
 * wait used to return silently on deadline, letting `up` report
 * `shared_started: true` for an instance that was already dead; now the
 * deadline surfaces as the `SHARED_START_FAILED` envelope (ADR-0005).
 *
 * `details.config_path` is the shared instance's derived config — the file
 * the remediation tells you to run by hand. It was a literal `<shared
 * config>` placeholder until #157's follow-up, which is a remediation nobody
 * can copy-paste; the worktree envelope carries the same field for the same
 * reason (additive under ADR-0005).
 */
class SharedStartFailedError extends Error {
  readonly code = "SHARED_START_FAILED" as const;
  readonly details: {
    readonly socket_path: string;
    readonly config_path: string;
    readonly timeout_ms: number;
  };
  constructor(
    message: string,
    details: { socket_path: string; config_path: string; timeout_ms: number },
  ) {
    super(message);
    this.name = "SharedStartFailedError";
    this.details = details;
  }
}

/**
 * The worktree-instance counterpart of `SharedStartFailedError` (issue #157).
 * Both instances are spawned fire-and-forget and both are only observable as
 * "the socket never appeared", but they are different instances with
 * different remediation: this one is torn down with `devtrees down` and
 * debugged against *this worktree's* derived config, the shared one with
 * `devtrees down --shared` and the shared config. Until #157 the worktree
 * wait threw `SharedStartFailedError`, so a stack that declared no shared
 * tier at all still failed with `SHARED_START_FAILED` pointing at its own
 * socket — issue #154 was diagnosed against a shared instance that did not
 * exist. `details` carries the worktree id and config path so an agent can
 * act without a second round-trip.
 */
class WorktreeStartFailedError extends Error {
  readonly code = "WORKTREE_START_FAILED" as const;
  readonly details: {
    readonly worktree_id: string;
    readonly socket_path: string;
    readonly config_path: string;
    readonly timeout_ms: number;
  };
  constructor(
    message: string,
    details: {
      worktree_id: string;
      socket_path: string;
      config_path: string;
      timeout_ms: number;
    },
  ) {
    super(message);
    this.name = "WorktreeStartFailedError";
    this.details = details;
  }
}

/**
 * Thrown when an `up` selects zero isolated services (issues #176, #203,
 * ADR-0008): a bare fresh `up` whose implicit `default` namespace is empty,
 * or an explicit `-n` naming only namespaces with no services. Starting an
 * empty instance and reporting it healthy would be a lie, and process-compose
 * exits after hot-reloading an empty project (#203). `details.namespaces`
 * lists the namespaces the stack declares so an agent can retry with `-n`
 * without a second round-trip; `selected_namespaces` is what was asked for.
 */
class NoServicesSelectedError extends Error {
  readonly code = "NO_SERVICES_SELECTED" as const;
  readonly details: {
    readonly worktree_id: string;
    readonly selected_namespaces: ReadonlyArray<string>;
    readonly namespaces: ReadonlyArray<string>;
  };
  constructor(
    worktreeId: string,
    available: ReadonlyArray<string>,
    selected: ReadonlyArray<string> = [DEFAULT_NAMESPACE],
    explicit = false,
    command: "up" | NamedServiceCommand = "up",
  ) {
    const example = available[0] ?? "<ns>";
    const why = explicit
      ? `\`-n ${selected.join(", ")}\` names no namespace with ${command === "up" ? "services in this stack" : "isolated services in this instance"}.`
      : `A bare \`devtrees up\` starts only the \`${DEFAULT_NAMESPACE}\` namespace ` +
        `(services with no \`namespace:\`), and this stack has none.`;
    // A per-service verb (#224) touched nothing; `up` says how to select.
    const next =
      command === "up"
        ? `Name the ones to start with -n, e.g. \`devtrees up -n ${example}\` ` +
          `(repeat -n for several).`
        : `Nothing was touched.`;
    super(
      `devtrees ${command}: no services selected (NO_SERVICES_SELECTED) for '${worktreeId}'. ${why} ` +
        `Available namespaces: ${available.join(", ")}. ${next}`,
    );
    this.name = "NoServicesSelectedError";
    this.details = {
      worktree_id: worktreeId,
      selected_namespaces: selected,
      namespaces: available,
    };
  }
}

/**
 * Thrown when `up -n` on a running instance names a namespace the instance
 * was not booted with (ADR-0008, issue #170). process-compose omits
 * `-n`-excluded services from the project and cannot add them at runtime, so
 * the only honest answer is to fail, name what is missing, and say how to
 * boot with it. Nothing is started or stopped; the instance keeps running.
 */
class NamespaceNotRunningError extends Error {
  readonly code = "NAMESPACE_NOT_RUNNING" as const;
  constructor(
    message: string,
    readonly details: {
      readonly worktree_id: string;
      readonly namespaces: ReadonlyArray<string>;
      readonly services: ReadonlyArray<string>;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "NamespaceNotRunningError";
  }
}

/**
 * Thrown when `up` asks process-compose to restart a dead selected service
 * on a running instance and the start request itself fails (ADR-0008, issue
 * #178): process-compose refused or errored. Distinct from `HEALTH_TIMEOUT`,
 * which is a service that started but never became healthy. Nothing is
 * stopped; the instance keeps running and `details.remedy` is the `down` +
 * `up` that restarts the whole stack.
 */
class ServiceStartFailedError extends Error {
  readonly code = "SERVICE_START_FAILED" as const;
  constructor(
    message: string,
    readonly details: {
      readonly worktree_id: string;
      readonly services: ReadonlyArray<{ readonly name: string; readonly message: string }>;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "ServiceStartFailedError";
  }
}

/**
 * Thrown when `up` was about to restart dead services on a running instance
 * and found, under the lifecycle lock, that the instance had stopped (issue
 * #178): a concurrent `devtrees down` got there first. Nothing is started, so
 * no process is left behind outside a supervisor. `INSTANCE_NOT_FOUND`
 * because that is the state `up` found: no instance for this worktree is
 * running any more, and the next `up` starts a fresh one.
 */
class InstanceGoneError extends Error {
  readonly code = "INSTANCE_NOT_FOUND" as const;
  constructor(readonly details: { readonly worktree_id: string }) {
    super(
      `devtrees up: '${details.worktree_id}' stopped while this \`up\` was checking it ` +
        `(most likely a concurrent \`devtrees down\`). Nothing was started. Run ` +
        `\`devtrees up\` to start it again.`,
    );
    this.name = "InstanceGoneError";
  }
}

/**
 * Thrown when a control socket still exists but repeated probes could not
 * tell whether process-compose behind it is alive (issue #186): every connect
 * timed out, or was refused while a process still held the socket. `up` and
 * `down` refuse to guess. Treating the instance as gone would unlink its
 * socket and orphan a possibly live process-compose and its services, which
 * keep their ports, so a fresh `up` would then collide on them. The socket is
 * kept and nothing is started or stopped. `details.instance` is the worktree
 * id, or `shared` for the shared instance.
 */
class InstanceUnresponsiveError extends Error {
  readonly code = "INSTANCE_UNRESPONSIVE" as const;
  constructor(
    command: string,
    readonly details: {
      readonly instance: string;
      readonly socket_path: string;
      readonly attempts: number;
      readonly remedy: string;
    },
  ) {
    super(
      `devtrees ${command}: the ${details.instance === SHARED_INSTANCE_ID ? "shared" : `'${details.instance}'`} ` +
        `instance's control socket did not answer after ${details.attempts} ` +
        `probe${details.attempts === 1 ? "" : "s"} ` +
        `(${details.socket_path}); process-compose may be busy or frozen. Nothing was ` +
        `started or stopped and the socket was kept. ${details.remedy}`,
    );
    this.name = "InstanceUnresponsiveError";
  }
}

/**
 * The namespace selection a **fresh** start applies (issue #176, ADR-0008).
 * Namespaces are opt-in: with no `-n`, only the implicit `default` namespace
 * starts; `-n` is exact and forwarded verbatim (it never implies `default`).
 * The returned `namespaces` is never empty, so the worktree up-spawn always
 * passes `-n` and process-compose never falls back to "every namespace".
 *
 * Throws `NoServicesSelectedError` when the selection resolves to zero
 * isolated services — bare or explicit `-n` (#203: an empty instance is
 * useless, and process-compose exits after reloading one). Only isolated
 * services are counted: namespace selection applies to this worktree's
 * instance only (shared services cannot declare a namespace, #130). A stack
 * with no isolated services at all keeps starting (shared only).
 *
 * Not used on the running-instance path: what a bare `up` targets there is
 * #177's to define; `assertExplicitSelectionNotEmpty` covers explicit `-n`.
 */
function resolveFreshSelection(
  stack: ResolvedStack,
  worktreeId: string,
  requested: ReadonlyArray<string> | undefined,
): { readonly namespaces: ReadonlyArray<string>; readonly services: ResolvedService[] } {
  const bare = requested === undefined || requested.length === 0;
  const namespaces = bare ? [DEFAULT_NAMESPACE] : requested;
  const isolated = stack.services.filter((s) => s.tier === "isolated");
  const services = isolated.filter((s) => namespaceSelected(s, namespaces));
  if (services.length === 0 && isolated.length > 0) {
    throw new NoServicesSelectedError(worktreeId, declaredNamespaces(isolated), namespaces, !bare);
  }
  return { namespaces, services };
}

/**
 * Pure pre-check for an explicit `-n` (#203): fail `NO_SERVICES_SELECTED` when
 * the namespaces select no isolated service in the stack, on a fresh and a
 * running instance alike, before any port allocation or state write. On a
 * running instance nothing is "missing" from such a selection, so this is
 * not `NAMESPACE_NOT_RUNNING`. A bare `up` is not checked here: its target
 * depends on whether the instance is running.
 */
function assertExplicitSelectionNotEmpty(
  stack: ResolvedStack,
  worktreeId: string,
  requested: ReadonlyArray<string> | undefined,
): void {
  if (requested === undefined || requested.length === 0) return;
  resolveFreshSelection(stack, worktreeId, requested);
}

/**
 * Compare this worktree's shared subset against the persisted identity of
 * the running shared instance; throw `SharedDriftError` on mismatch. The
 * hash is order-insensitive (`sharedStackHash`), so pure reordering in
 * `devtrees.yaml` never trips it — only semantic divergence does.
 */
function assertSharedSubsetMatches(
  stack: ResolvedStack,
  state: SharedState,
  worktreeId: string,
): void {
  const localHash = sharedStackHash(stack);
  if (localHash === state.hash) return;
  throw new SharedDriftError(
    `this worktree's shared services diverge from what the running shared instance ` +
      `was started with (likely a branch that added, removed, or edited a shared service). ` +
      `Refusing to inject port numbers the shared instance never bound. ` +
      `Run \`devtrees down --shared && devtrees up\` to restart shared from this worktree's config.`,
    { worktree_id: worktreeId, running_hash: state.hash, local_hash: localHash },
  );
}

/**
 * The name→port map the shared instance binds: every shared service's
 * declared named port, resolved through the repo-wide shared block. This is
 * what gets persisted at shared start and injected into every worktree.
 */
function collectSharedPorts(
  stack: ResolvedStack,
  sharedPortFor: (name: string) => number | undefined,
): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const service of stack.services) {
    if (service.tier !== "shared") continue;
    for (const name of service.ports) {
      const port = sharedPortFor(name);
      if (port !== undefined) ports[name] = port;
    }
  }
  return ports;
}

/** Type of the lock-guarded mutator the caller passes for testability. */
export type WithRegistryLock = (
  anchor: string,
  mutate: (snapshot: RegistrySnapshot) => RegistrySnapshot | Promise<RegistrySnapshot>,
) => Promise<RegistrySnapshot>;

/** Type of the async shared lifecycle lock the caller passes for testability. */
export type WithSharedLock = <T>(anchor: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Type of the per-instance lifecycle lock (issue #91) the caller passes for
 * testability — `withLifecycleLock` in src/registry.ts keyed by instance id.
 */
export type WithLifecycleLock = <T>(
  anchor: string,
  instanceId: string,
  fn: () => Promise<T>,
) => Promise<T>;

/**
 * Which worktree instance a post-spawn socket wait is watching (issue #157).
 * The wait used to know only the socket path, which is why its failure could
 * not say whose socket it was and borrowed the shared instance's envelope;
 * carrying the id and the derived config lets `WORKTREE_START_FAILED` name
 * the instance and point at the file worth running by hand.
 */
export interface WorktreeInstanceRef {
  readonly worktreeId: string;
  readonly configPath: string;
}

/** One row of `details.collisions[]` in the `STALE_PORT_BLOCK` error envelope. */
interface PortCollision {
  readonly port_name: string;
  readonly port: number;
  readonly pid: number | null;
  readonly command: string | null;
  /**
   * Whether the holder accepts a TCP connection (#155). `false` is a holder
   * that keeps the port but refuses connections, like a container runtime's
   * stale port forward: it cannot answer the new service's traffic, and it
   * may be one process serving every instance, so it is not to be killed.
   */
  readonly accepts_connections: boolean;
  /**
   * The holder is a container runtime's port forwarder (OrbStack Helper,
   * `com.docker.backend`, ...), which serves every instance's containers:
   * never kill it, stop the container that publishes the port (#155).
   */
  readonly port_forwarder: boolean;
}

/**
 * Thrown when `up`'s pre-flight check finds foreign listeners squatting on
 * one or more of the worktree's declared named ports — typically orphaned
 * child processes from a prior session that survived their parent
 * process-compose's exit (issue #58). The allocator's stability-first
 * fast-path returns the registry-recorded block verbatim without
 * re-probing (by design), so without this check `up` would hand the block
 * to a fresh process-compose and the stale listener would silently win
 * EADDRINUSE against the new service.
 *
 * The CLI maps this to the `STALE_PORT_BLOCK` error envelope; the
 * `details.collisions[]` list names each (port_name, port, pid, command)
 * so the agent can kill the right PIDs before retrying.
 */
class StalePortBlockError extends Error {
  readonly code = "STALE_PORT_BLOCK" as const;
  readonly details: {
    readonly block_base: number;
    readonly worktree_id: string;
    readonly collisions: ReadonlyArray<PortCollision>;
  };
  constructor(
    message: string,
    details: {
      readonly block_base: number;
      readonly worktree_id: string;
      readonly collisions: ReadonlyArray<PortCollision>;
    },
  ) {
    super(message);
    this.name = "StalePortBlockError";
    this.details = details;
  }
}

/**
 * Probe a concrete port and report who, if anyone, is listening on it.
 * Default: `defaultPortHolder` (EADDRINUSE bind + best-effort `lsof` for the
 * PID and command). Injected so unit tests can drive the routing of
 * `assertBlockPortsFree` without touching the network.
 */
export type PortHolderProbe = (port: number) => Promise<PortHolderReport> | PortHolderReport;

/**
 * Pre-flight: probe each declared named port the worktree owns and throw
 * `StalePortBlockError` if any of them is held by a foreign process. The
 * `ownInstanceLive` flag short-circuits the check on the idempotent re-up
 * path — when our own control socket is already present, the listeners on
 * those ports ARE our own, so any "in use" report is a false positive that
 * would break re-runs.
 *
 * Only the worktree's *isolated*-tier named ports are probed (not the full
 * 32-port block — random idle ports in the block don't matter, only declared
 * ones get bound by the stack).
 */
async function assertBlockPortsFree(args: {
  readonly stack: ResolvedStack;
  readonly worktreeId: string;
  readonly blockBase: number;
  readonly portFor: (name: string) => number | undefined;
  readonly portHolder: PortHolderProbe;
  readonly portAccepts: (port: number) => Promise<boolean>;
  readonly warn: (message: string) => void;
  readonly ownInstanceLive: boolean;
}): Promise<void> {
  if (args.ownInstanceLive) return;
  const { stack, worktreeId, blockBase, portFor, portHolder, portAccepts } = args;
  const collisions = await collectPortCollisions(stack, portFor, portHolder, portAccepts);
  if (collisions.length === 0) return;
  // A holder that refuses connections cannot answer the new service's
  // traffic, so it is not the silent failure this check exists for (#155):
  // warn about it and go on. If it does block the service's bind, the
  // service fails loudly (HEALTH_TIMEOUT naming it), never silently.
  if (collisions.every((c) => !c.accepts_connections)) {
    args.warn(refusingHoldersWarning(collisions));
    return;
  }
  throw new StalePortBlockError(
    `devtrees up: ports in this worktree's allocated block are held by foreign processes — ` +
      `likely orphaned children from a prior session. Kill each process listed below, except ` +
      `one labelled not to kill, then retry \`devtrees up\`:\n` +
      collisions.map(describeCollision).join("\n"),
    { block_base: blockBase, worktree_id: worktreeId, collisions },
  );
}

/** `  WEB_PORT 40480: pid 123 (node)`, with a label for a holder not to kill (#155). */
function describeCollision(c: PortCollision): string {
  const who =
    c.pid === null
      ? `holder not identified (try \`lsof -nP -iTCP:${c.port}\`)`
      : `pid ${c.pid} (${c.command ?? "unknown command"})`;
  return `  ${c.port_name} ${c.port}: ${who}${collisionLabel(c)}`;
}

/** Why a holder is not one to kill, if it is not (#155). */
function collisionLabel(c: PortCollision): string {
  if (!c.accepts_connections) return ` — ${REFUSING_LABEL}`;
  if (c.port_forwarder) return ` — ${forwarderLabel(c.port)}`;
  return "";
}

const REFUSING_LABEL =
  "refuses connections: likely a container runtime's stale port forward, which may serve " +
  "other instances too; do not kill it";

/** The warning `up` prints when every holder refuses connections (#155). */
function refusingHoldersWarning(collisions: ReadonlyArray<PortCollision>): string {
  return (
    `devtrees up: ports in this worktree's allocated block are held, but every holder refuses ` +
    `connections, so none is treated as an orphan. If a service then fails to bind its port, ` +
    `free it and retry:\n` +
    collisions.map(describeCollision).join("\n")
  );
}

/**
 * Walk the stack's declared isolated-tier named ports, probe each via the
 * `portHolder` seam, and collect a row for every port held by something.
 * Pure modulo the seam — separated from `assertBlockPortsFree` so the loop
 * stays cheap to keep in head and the orchestrator's complexity stays low.
 */
async function collectPortCollisions(
  stack: ResolvedStack,
  portFor: (name: string) => number | undefined,
  portHolder: PortHolderProbe,
  portAccepts: (port: number) => Promise<boolean>,
): Promise<PortCollision[]> {
  const collisions: PortCollision[] = [];
  for (const service of stack.services) {
    if (service.tier !== "isolated") continue;
    for (const portName of service.ports) {
      const port = portFor(portName);
      if (port === undefined) continue;
      const report = await portHolder(port);
      if (report.free) continue;
      collisions.push({
        port_name: portName,
        port,
        pid: report.pid,
        command: report.command,
        accepts_connections: await portAccepts(port),
        port_forwarder: isPortForwarder(report.command),
      });
    }
  }
  return collisions;
}

/** Default health-wait window for the worktree instance — overridable per call. */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export interface CommandDeps {
  /** Working directory to resolve the worktree from. Default: process.cwd(). */
  readonly cwd?: string;
  /** Inject git. Default: runs the real `git` in `cwd`. */
  readonly git?: GitProbe;
  /** Read the stack from a directory. Default: reads `devtrees.yaml` from disk. */
  readonly readStack?: (dir: string) => ReturnType<typeof loadStack>;
  /**
   * Acquire the allocation-registry lock, run a read-modify-write against an
   * atomic snapshot, and persist the result. Default: real flock under the
   * anchor (`registry.ts`). Injected so tests can stub it.
   */
  readonly withRegistryLock?: WithRegistryLock;
  /**
   * Read the persisted allocation registry without acquiring the lock — used by
   * pure-read commands (e.g. `env`, #32) that must not interfere with concurrent
   * `up`s. Default: real read from `<anchor>/devtrees/registry.json`.
   */
  readonly readRegistry?: (anchor: string) => RegistrySnapshot;
  /**
   * Async lifecycle lock around shared-instance start/stop. Default: real
   * lockfile at <anchor>/devtrees/shared.lock. Injected so tests can stub it.
   */
  readonly withSharedLock?: WithSharedLock;
  /**
   * Per-worktree lifecycle lock held across `runUp`'s liveness-check →
   * config-write → spawn → socket-wait window (issue #91), so two concurrent
   * `up`s in the same worktree cannot double-spawn. Default: real lockfile at
   * `<anchor>/devtrees/<worktreeId>.lock`. Injected so tests can observe or
   * replace the hold window.
   */
  readonly withLifecycleLock?: WithLifecycleLock;
  /**
   * Poll until the worktree instance's control socket is observable on disk
   * after `driver.up` (issue #91). Runs INSIDE the lifecycle lock: `driver.up`
   * is fire-and-forget, so releasing the lock before the socket exists would
   * let a concurrent up's liveness gate miss the spawn and double-start.
   * Default: real `waitForWorktreeSocket` poll, which fails with
   * `WORKTREE_START_FAILED` naming *this* instance (issue #157). Injected so
   * unit tests with a stub spawner that never binds a socket don't pay the
   * poll timeout.
   */
  readonly waitForSocketFile?: (socketPath: string, instance: WorktreeInstanceRef) => Promise<void>;
  /**
   * Wait for shared services to be healthy before bringing the worktree
   * instance up — orchestration-layer stand-in for the dropped cross-tier
   * `depends_on` edges (ADR-0003). Default: polls the driver's
   * `getServiceStatuses` over the shared UDS (issue #87). Injected so tests
   * can stub it.
   */
  readonly waitForSharedHealth?: WaitForSharedHealth;
  /**
   * Wait for the worktree instance's services to be healthy after `driver.up`
   * — the gate that turns "up returned" into "the stack is serving traffic"
   * (PRD #26, ADR-0005). Default: polls the driver's `getServiceStatuses`
   * over the worktree instance's UDS (issue #87); injected so tests stub it.
   */
  readonly waitForHealth?: WaitForHealth;
  /** Health-wait window for the worktree instance. Default: 120s. */
  readonly waitTimeoutMs?: number;
  /**
   * How long the shared lazy-start waits for the spawned instance to bind its
   * control socket before failing with `SHARED_START_FAILED` (issue #92).
   * Default: 3s — generous for a healthy process-compose, short enough that
   * an instantly-dying one fails fast. Injected so tests don't sit out the
   * full window.
   */
  readonly sharedSocketTimeoutMs?: number;
  /**
   * The worktree-instance counterpart of `sharedSocketTimeoutMs` — how long
   * the post-spawn socket wait gives this worktree's instance before failing
   * with `WORKTREE_START_FAILED` (issue #157). Same 3s default and same
   * reason for the seam: tests that exercise the real wait shouldn't sit out
   * the full window.
   */
  readonly worktreeSocketTimeoutMs?: number;
  /**
   * Read the per-service runtime state for the worktree instance after health
   * is reached, so `runUp` can publish `services[]` in the issue-#30 state
   * envelope. Default: shells out to the driver's `getServiceStatuses` (same
   * primitive `ls --json` uses, issue #29). Injected so tests stub it.
   */
  readonly getServiceStatuses?: (
    socketPath: string,
    opts?: { readonly timeoutMs?: number },
  ) => Promise<ServiceStatus[]>;
  /** Is a concrete port free to bind? Default: probes a real TCP bind. */
  readonly isPortFree?: (port: number) => boolean | Promise<boolean>;
  /**
   * Probe a control socket for an actual listener (issue #80). The socket
   * *file* lives in anchor state, which survives `kill -9` and reboots, so
   * the write paths must not treat its existence as liveness. Default: real
   * UDS connect probe (`instances.ts`, the same primitive `ls` reports
   * stale instances with). Injected so unit tests can simulate live/crashed
   * instances without binding real sockets.
   */
  readonly probeSocket?: (socketPath: string) => Promise<InstanceStatus>;
  /**
   * Backoff between re-probes while a socket's liveness stays `unknown`
   * (issue #186). Default: `PROBE_RETRY_DELAYS_MS`. Injected so tests of the
   * unknown path don't sit out the real backoff.
   */
  readonly probeRetryDelaysMs?: ReadonlyArray<number>;
  /**
   * Identify the holder of a concrete port — used by `up`'s pre-flight
   * stale-port-block check (#58). Default: `defaultPortHolder` (bind probe
   * + best-effort `lsof`). Injected so unit tests can drive the routing
   * without touching the network.
   */
  readonly portHolder?: PortHolderProbe;
  /**
   * Does anything accept a TCP connection on a port (#155)? `up` uses it to
   * tell a refusing holder (a stale port forward) from an orphan, and `down`
   * to find a listener that outlived the stop. Default: `acceptsConnections`
   * (a loopback connect). Injected so unit tests stay off the network.
   */
  readonly portAccepts?: (port: number) => Promise<boolean>;
  /**
   * Who holds a port, for a listener `down` finds still alive (#155).
   * Default: `identifyHolderViaLsof`.
   */
  readonly identifyPortHolder?: (port: number) => {
    readonly pid: number | null;
    readonly command: string | null;
  };
  /**
   * How long `down` lets a booted service's port take to close after the
   * stop before it counts the listener as a survivor (#155). Default: 3s.
   */
  readonly portSettleMs?: number;
  /**
   * Allocator defaults — `port_base` and `block_size`. The stack's `allocator`
   * field overrides these on a field-by-field basis. Default: 20000 / 32.
   */
  readonly allocator?: AllocatorOptions;
  readonly driver?: DriverDeps;
  /**
   * Seams and budgets for the bounded stop (issue #190): the process-table
   * read, the kill, the base `down` budget and the post-escalation grace.
   * Default: real `ps`/`process.kill`, 30s base, 10s grace.
   */
  readonly stop?: StopSeams;
  /**
   * Verify the installed process-compose meets the minimum version (issue
   * #173). Default: one `process-compose version --short` shell-out through
   * the driver. Injected so unit tests don't spawn the version probe.
   */
  readonly assertProcessComposeVersion?: () => Promise<void>;
  /**
   * Read the resolved-stack hash previously stored for a worktree (issue #31).
   * Default: reads `<anchor>/devtrees/hashes.json`. Injected so noop / drift
   * branch tests can run without touching disk.
   */
  readonly readStoredHash?: (anchor: string, worktreeId: string) => string | undefined;
  /**
   * Persist the resolved-stack hash for a worktree (issue #31). Default:
   * writes to `<anchor>/devtrees/hashes.json`.
   */
  readonly writeStoredHash?: (anchor: string, worktreeId: string, hash: string) => void;
  /**
   * Attach the TUI after a successful up. Default: only when both stdout and
   * stderr are TTYs (ADR-0005 — agent invocations shouldn't be hijacked by
   * the TUI). Setting this explicitly overrides the auto-detect.
   */
  readonly attach?: boolean;
  /**
   * Inject the TTY check so unit tests can prove the auto-detect logic
   * without touching `process.stdout.isTTY`. Default: returns true only when
   * both stdout and stderr are TTYs. Ignored when `attach` is set explicitly.
   */
  readonly isTTY?: () => boolean;
  /** Sink for non-fatal warnings (e.g. unmanaged port detection). Default: stderr. */
  readonly warn?: (message: string) => void;
  /**
   * process-compose namespaces to start (issue #128) — the `-n/--namespace`
   * selection. Forwarded verbatim to the worktree up-spawn AND used to narrow
   * the worktree health-wait's expected set, so `up -n default` neither spawns
   * nor waits on a probed service in an excluded namespace. Exact: `-n app`
   * does not imply `default`. Empty / omitted on a fresh start selects only
   * the `default` namespace (namespaces are opt-in, issue #176 / ADR-0008),
   * and fails with `NO_SERVICES_SELECTED` if that selects nothing.
   */
  readonly namespaces?: ReadonlyArray<string>;
  /**
   * Run a torn-down instance's derived `shutdown.command`(s) directly —
   * socket-free, from the anchor — to reap out-of-band resources when the
   * supervisor is dead (issue #148). On the dead-supervisor `down` path the
   * hook never fired (no process-compose to launch it), so devtrees runs it
   * itself. Default: the real `reapShutdownHooks`; injected for tests.
   */
  readonly reap?: Reaper;
  /**
   * Is a PID still alive? Used by `up` to tell whether an old process a
   * timed-out reload is waiting on has exited (issue #191). Default: signal
   * 0. Injected so tests can drive the pending-reload guard without real
   * processes.
   */
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface UpResult {
  readonly worktreeId: string;
  readonly socketPath: string;
  /**
   * Flat env injection: this worktree's own named ports + the shared services'
   * named ports + the worktree id. Connection info for shared services is in
   * here so an isolated service can reach a shared one through `${...}` with
   * no extra wiring.
   */
  readonly env: Record<string, string>;
  /** True iff this `up` triggered the lazy start of the shared instance. */
  readonly sharedStarted: boolean;
  /**
   * Base port of this worktree's allocation block (issue #30). The `env`
   * named-port numbers all fall within `[blockBase, blockBase + blockSize)`;
   * `block_base` in the `up --json` envelope is this value.
   */
  readonly blockBase: number;
  /**
   * One row per service the driver reports running on this worktree's
   * instance after the health-wait — same shape `ls --json` (issue #29)
   * publishes. Degrades to `[]` on a getServiceStatuses error so a flaky
   * driver call cannot fail an otherwise-healthy `up`.
   */
  readonly services: ReadonlyArray<Service>;
  /**
   * `depends_on` edges process-compose dropped because their target is in no
   * selected namespace (ADR-0008, #179) — computed from the fresh selection,
   * or the effective one on a running instance. Each was also warned about on
   * stderr as `up` ran. Empty when nothing was dropped.
   */
  readonly droppedNamespaceEdges: ReadonlyArray<DroppedNamespaceEdge>;
  /**
   * `${NAME}` references to devtrees-injected variables in service commands
   * (#200): process-compose expands them from its own environment, so they run
   * empty. Each was warned about on stderr; the command is never rewritten.
   */
  readonly bracedEnvVars: ReadonlyArray<BracedEnvVar>;
  /**
   * Shared-service fields (shutdown, is_daemon, ...) edited since the running
   * shared instance started (#185). They do not apply until
   * `devtrees down --shared && devtrees up`; each was warned about on stderr.
   * Empty when nothing changed, shared was just started, or its state
   * predates the record.
   */
  readonly sharedFieldChanges: ReadonlyArray<SharedFieldChange>;
  /**
   * Dead selected isolated services this `up` restarted on a running
   * instance before its health wait (ADR-0008, issue #178), in declaration
   * order. Always empty on a fresh start.
   */
  readonly restarted: ReadonlyArray<string>;
}

/**
 * Result of `runUpDryRun` (#124): the full derivation pipeline's output —
 * the worktree-isolated config (and, when the stack declares shared services,
 * the shared config) plus the env injection a real `up` would apply — with
 * *no* side effects. Nothing is written to disk, no `process-compose` is
 * spawned, no socket is created, no instance is registered, no health wait
 * runs. Port allocation may still briefly take the registry lock to pick a
 * non-colliding block; that is the only registry touch and it neither starts
 * nor registers an instance.
 *
 * The envelope is the agent-readable preview of what `devtrees up` would run:
 * a sibling can read the allocated `WEB_PORT`/`DB_PORT` off `env` and the full
 * process-compose document off `config` without touching the filesystem
 * (PRD #26 / ADR-0005). This is the "preview the derived config" use case,
 * served with no disk write (#125).
 */
export interface DryRunResult {
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  /** The anchor (git common dir) the shared config's processes run in. */
  readonly anchor: string;
  /**
   * Flat env injection the worktree instance would receive: this worktree's
   * own named ports + the shared services' named ports + the worktree id.
   * Same shape `runUp` returns; a sibling reads the allocated
   * `WEB_PORT` (and shared `DB_PORT`) off here.
   */
  readonly env: Record<string, string>;
  /** The derived worktree-isolated process-compose config. */
  readonly config: DerivedConfig;
  /** Env injection for the shared instance — present iff the stack has shared services. */
  readonly sharedEnv?: Record<string, string>;
  /** The derived shared process-compose config — present iff the stack has shared services. */
  readonly sharedConfig?: DerivedConfig;
  /**
   * Every cross-tier `depends_on` edge the derivation stripped (ADR-0003), the
   * same list the real `up` warns about. Empty when nothing was dropped — a
   * preview that silently loses an authored edge reads as a config typo rather
   * than a documented design decision (issue #168).
   */
  readonly droppedEdges: ReadonlyArray<DroppedEdge>;
  /**
   * Which path the previewed `up` takes (#210): `"fresh"` when this
   * worktree's instance is not running (a new process-compose would be
   * spawned), `"running"` when it is (the instance would be verified,
   * reloaded on drift and repaired, ADR-0008). Decided by a read-only
   * liveness probe of the control socket.
   */
  readonly instance: "fresh" | "running";
  /**
   * The effective namespace selection. Fresh (#176): the `-n` values
   * verbatim, or `["default"]` for a bare `up` (namespaces are opt-in,
   * ADR-0008). Running (#210): the `-n` values, or for a bare `up` the
   * namespaces the instance was booted with, read back from process-compose.
   */
  readonly namespaces: ReadonlyArray<string>;
  /**
   * The isolated services that selection covers, in declaration order — the
   * set the real `up` would spawn (fresh) or check (running) and health-wait
   * on. Compare it with `up.services` as a set: that lists the project's rows
   * in process-compose's order (by name), and on a running instance every
   * service in the project, not only the selected ones. `config` still carries every service: the selection is applied by
   * process-compose's `-n` at launch, not by removing services from the
   * derived config.
   */
  readonly selectedServices: ReadonlyArray<string>;
  /**
   * `depends_on` edges the selection loses because their target is in no
   * selected namespace (ADR-0008, #179): process-compose drops them and
   * starts the dependent ungated. Empty when none would be.
   */
  readonly droppedNamespaceEdges: ReadonlyArray<DroppedNamespaceEdge>;
  /**
   * Running only (#210): the stack changed since the instance was last
   * synced, so the real `up` would hot-reload it. Always `false` on a fresh
   * preview.
   */
  readonly wouldReload: boolean;
  /**
   * Running only (#210): dead selected isolated services the real `up` would
   * restart, in `depends_on` order. Always empty on a fresh preview.
   */
  readonly wouldRestart: ReadonlyArray<string>;
  /** `${NAME}` references to injected variables in service commands (#200). */
  readonly bracedEnvVars: ReadonlyArray<BracedEnvVar>;
}

export interface DownOptions {
  /**
   * When true, tears down the shared instance (CONTEXT.md "Shared instance":
   * lifecycle is decoupled from any single worktree's `down`). Defaults to
   * false — a plain `devtrees down` only stops this worktree's instance and
   * leaves shared running for the others.
   */
  readonly shared?: boolean;
}

function resolve(deps: CommandDeps) {
  const cwd = deps.cwd ?? process.cwd();
  const git = deps.git ?? defaultGit(cwd);
  const anchor = resolveAnchor(cwd, git);
  return { cwd, anchor };
}

/**
 * Merge the per-repo allocator overrides parsed from `devtrees.yaml` over the
 * deps-level defaults, on a field-by-field basis. The result is what the
 * allocator runs with.
 */
function resolveAllocatorOptions(
  stack: ResolvedStack,
  fallback: AllocatorOptions,
): AllocatorOptions {
  const overrides = stack.allocator;
  if (overrides === undefined) return fallback;
  return {
    portBase: overrides.portBase ?? fallback.portBase,
    blockSize: overrides.blockSize ?? fallback.blockSize,
  };
}

/**
 * Map every named port a tier's services declare to a fixed offset within
 * its allocated block — first service's ports get offset 0, 1, 2, ...; next
 * service's continue. Throws if the count exceeds `blockSize`.
 */
function buildOffsetMap(
  services: ReadonlyArray<ResolvedService>,
  tier: "isolated" | "shared",
  blockSize: number,
): Map<string, number> {
  const out = new Map<string, number>();
  let next = 0;
  for (const service of services) {
    if (service.tier !== tier) continue;
    for (const portName of service.ports) {
      out.set(portName, next++);
    }
  }
  if (next > blockSize) {
    throw new Error(`stack declares ${next} ${tier} named ports but block_size is ${blockSize}`);
  }
  return out;
}

/** Does the stack contain at least one service in the given tier? */
function hasTier(stack: ResolvedStack, tier: "isolated" | "shared"): boolean {
  return stack.services.some((s) => s.tier === tier);
}

/**
 * Create the directories every authored `log_location` file needs (issue #136)
 * so process-compose can open the file — it opens but does not `mkdir -p` the
 * path itself. Created lazily: a stack where no service authored a
 * `log_location` makes no dir at all, so a plain stack never sprouts an empty
 * `devtrees/logs/<instanceId>/` (acceptance: "no empty logs dir surprise"). For
 * a nested location (e.g. `sub/api.log`) the file's *parent* dir is created, so
 * `<logsBase>/sub/` exists before launch. `logsBase` is the per-instance logs
 * dir (`logsDir(anchor, instanceId)`); the authored values are already validated
 * to be relative and non-escaping, so the join stays under it.
 */
function ensureLogsDir(stack: ResolvedStack, logsBase: string, tier: Tier): void {
  for (const svc of stack.services) {
    if (svc.tier !== tier || svc.logLocation === undefined) continue;
    mkdirSync(dirname(join(logsBase, svc.logLocation)), { recursive: true });
  }
}

interface AllocatedPortMaps {
  readonly blockBase: number;
  readonly sharedBase?: number;
  /** Resolve an isolated-tier named port to a concrete number, or `undefined` if unknown. */
  readonly portFor: (name: string) => number | undefined;
  /** Resolve a shared-tier named port; `undefined` when the stack has no shared services. */
  readonly sharedPortFor: (name: string) => number | undefined;
}

/**
 * The named-port → number resolvers for a worktree block at `blockBase` and,
 * when the stack has shared services, a shared block at `sharedBase`: each
 * name resolves to its block's base plus its positional offset. Shared by
 * `allocateAndBuildPortMaps` (under the registry lock) and `runEnv` (a
 * lock-free read).
 */
function namedPortResolvers(
  stack: ResolvedStack,
  options: AllocatorOptions,
  blockBase: number,
  sharedBase: number | undefined,
): Pick<AllocatedPortMaps, "portFor" | "sharedPortFor"> {
  const isolatedOffsets = buildOffsetMap(stack.services, "isolated", options.blockSize);
  const sharedOffsets =
    sharedBase === undefined
      ? new Map<string, number>()
      : buildOffsetMap(stack.services, "shared", options.blockSize);
  const at = (base: number | undefined, offset: number | undefined) =>
    base === undefined || offset === undefined ? undefined : base + offset;
  return {
    portFor: (name) => at(blockBase, isolatedOffsets.get(name)),
    sharedPortFor: (name) => at(sharedBase, sharedOffsets.get(name)),
  };
}

/**
 * Allocate this worktree's port block — and, if the stack declares shared
 * services, the shared block — under one read-modify-write of the registry
 * lock, then build the named-port → number resolvers from the resulting
 * offsets. Both `runUp` and `runUpDryRun` need the same allocation pass; the
 * only thing they do differently is what they do with the resolved ports
 * afterwards.
 */
async function allocateAndBuildPortMaps(args: {
  readonly anchor: string;
  readonly worktreeId: string;
  readonly stack: ResolvedStack;
  readonly options: AllocatorOptions;
  readonly lock: WithRegistryLock;
  readonly isPortFree: (port: number) => boolean | Promise<boolean>;
}): Promise<AllocatedPortMaps> {
  const { anchor, worktreeId, stack, options, lock, isPortFree } = args;
  const sharedNeeded = hasTier(stack, "shared");

  let blockBase = -1;
  let sharedBase: number | undefined;
  await lock(anchor, async (snapshot) => {
    let next = snapshot;
    const block = await allocateBlock(worktreeId, next, options, isPortFree);
    blockBase = block.base;
    if (next[worktreeId] === undefined) {
      next = { ...next, [worktreeId]: block.base };
    }
    if (sharedNeeded) {
      const sblock = await allocateBlock(SHARED_REGISTRY_KEY, next, options, isPortFree);
      sharedBase = sblock.base;
      if (next[SHARED_REGISTRY_KEY] === undefined) {
        next = { ...next, [SHARED_REGISTRY_KEY]: sblock.base };
      }
    }
    return next === snapshot ? snapshot : next;
  });

  const { portFor, sharedPortFor } = namedPortResolvers(stack, options, blockBase, sharedBase);

  return sharedBase === undefined
    ? { blockBase, portFor, sharedPortFor }
    : { blockBase, sharedBase, portFor, sharedPortFor };
}

/**
 * Resolve every dependency seam `runUp` reads. Centralising the `??` defaults
 * here keeps the orchestrator's body free of injection plumbing and bounds
 * its cyclomatic complexity to the genuine domain branches (idempotency,
 * dropped-edge wait, attach-after-up) rather than counting one extra
 * decision per nullish-coalesce.
 */
function resolveUpSeams(deps: CommandDeps) {
  return {
    readStack: deps.readStack ?? loadStack,
    lock: deps.withRegistryLock ?? defaultWithRegistryLock,
    sharedLock: deps.withSharedLock ?? defaultWithSharedLock,
    isPortFree: deps.isPortFree ?? defaultIsPortFree,
    ...resolvePortSeams(deps),
    warn: deps.warn ?? defaultWarn,
    readHash: deps.readStoredHash ?? defaultReadStoredHash,
    writeHash: deps.writeStoredHash ?? defaultWriteStoredHash,
    probe: resolveProbe(deps),
    ...resolveLifecycleSeams(deps),
  } as const;
}

/** The pre-flight's port seams (#58, #155): who holds a port, and does it serve it. */
function resolvePortSeams(deps: CommandDeps) {
  return {
    portHolder: deps.portHolder ?? defaultPortHolder,
    portAccepts: deps.portAccepts ?? acceptsConnections,
  } as const;
}

/**
 * Resolve the #91 lifecycle-lock seams — split from `resolveUpSeams`'s body
 * for the same reason `resolveProbe` is: each resolver stays a flat
 * default-bundle whose per-`??` cyclomatic count never creeps toward the
 * audit gate's complexity threshold.
 */
function resolveLifecycleSeams(deps: CommandDeps) {
  return {
    lifecycleLock: deps.withLifecycleLock ?? defaultWithLifecycleLock,
    waitForSocketFile:
      deps.waitForSocketFile ??
      ((socketPath, instance) =>
        waitForWorktreeSocket(socketPath, instance, deps.worktreeSocketTimeoutMs)),
  } as const;
}

/** A socket-liveness probe plus its retry backoff for `unknown` (#80, #186). */
interface LivenessProbe {
  readonly probe: (socketPath: string) => Promise<InstanceStatus>;
  readonly retryDelaysMs: ReadonlyArray<number>;
}

/**
 * Resolve the #80 socket-liveness probe seam — needed by both `runUp` (via
 * `resolveUpSeams`) and `runDown`, which doesn't share the up-seam bundle.
 */
function resolveProbe(deps: CommandDeps): LivenessProbe {
  return {
    probe: deps.probeSocket ?? defaultProbeSocket,
    retryDelaysMs: deps.probeRetryDelaysMs ?? PROBE_RETRY_DELAYS_MS,
  };
}

/** Which command is asking, and about which instance — for the #186 envelope. */
interface LivenessContext {
  readonly command: "up" | "down" | NamedServiceCommand;
  /** The exact command to retry, when it is more than the verb (`devtrees restart web`). */
  readonly retry?: string;
  /** Worktree id, or `SHARED_INSTANCE_ID` for the shared instance. */
  readonly instance: string;
}

/**
 * Liveness gate for the write paths (issue #80). A control-socket *file* is
 * not proof of a live instance — it lives in anchor state, which survives
 * `kill -9` and reboots, so after a crash the file points at nothing. Probe
 * the UDS (retrying while the answer is `unknown`):
 *
 *  - a listener means live (`true`);
 *  - a definitive "nothing listening" means the file is an orphan, so unlink
 *    it and report "not live" (`false`) — the caller then falls through to
 *    its fresh-start (or idempotent no-op) path;
 *  - still `unknown` after the retries (#186) throws `INSTANCE_UNRESPONSIVE`
 *    and keeps the socket. Every caller is about to start or stop processes,
 *    and guessing either way is worse than failing: "not live" would orphan
 *    a live process-compose (and a fresh start would collide on its ports),
 *    "live" would hand the driver a socket that does not answer.
 */
async function socketIsLive(
  socketPath: string,
  liveness: LivenessProbe,
  context: LivenessContext,
  /** `up --dry-run` (#210): answer the same question, but leave a stale file. */
  opts: { readonly readOnly?: boolean } = {},
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  const status = await probeUntilDefinitive(socketPath, liveness.probe, liveness.retryDelaysMs);
  if (status === "running") return true;
  if (status === "stale") {
    if (opts.readOnly !== true) rmSync(socketPath, { force: true });
    return false;
  }
  throw new InstanceUnresponsiveError(context.command, {
    instance: context.instance,
    socket_path: socketPath,
    attempts: liveness.retryDelaysMs.length + 1,
    remedy: unresponsiveRemedy(socketPath, context),
  });
}

/** The `details.remedy` an `INSTANCE_UNRESPONSIVE` envelope carries (#186). */
function unresponsiveRemedy(socketPath: string, context: LivenessContext): string {
  const down = context.instance === SHARED_INSTANCE_ID ? "devtrees down --shared" : "devtrees down";
  const retry =
    context.retry ?? (context.command === "down" ? down : `devtrees ${context.command}`);
  return (
    `Retry \`${retry}\` in a moment. If it keeps failing, find the process-compose ` +
    `holding the socket with \`lsof -U -a ${socketPath}\`: resume it if it is stopped ` +
    `(\`kill -CONT <pid>\`), or kill it, then run \`${down}\` to clean up.`
  );
}

/**
 * Bring up this worktree's isolated stack, idempotently.
 *
 * Three branches (issue #31):
 *  - **First up** (socket absent): allocate ports, write derived config,
 *    `driver.up`, health-wait, persist the stack-hash, return envelope.
 *  - **Already up, unchanged config** (socket present, stored hash matches):
 *    skip `driver.up` and the registry write, then verify the instance
 *    (`verifyRunning`, ADR-0008) before re-emitting the state envelope.
 *  - **Already up, drifted config** (socket present, stored hash differs):
 *    write the new derived config, call `driver.reloadConfig`. On success,
 *    update the stored hash and verify the instance; on failure
 *    (`not_supported` or otherwise), restore the previous on-disk config
 *    (issue #92) and throw `ConfigDriftError` (code `CONFIG_DRIFT`), leaving
 *    the instance running unchanged.
 *
 * Verifying a running instance (issue #177): selection read back from the
 * project, `NAMESPACE_NOT_RUNNING` for an unbooted `-n`, and the same health
 * wait as a fresh headless start. Dead selected isolated services are
 * restarted first (#178; `SERVICE_START_FAILED` if process-compose refuses),
 * and one that does not become healthy fails with `HEALTH_TIMEOUT`. Never
 * attaches, never stops anything.
 *
 * Dead shared services (ADR-0008), on both paths: a shared instance found
 * already running is checked inside the lock right after
 * `ensureSharedStarted` and fails with `SHARED_SERVICE_DEAD`; one this call
 * lazy-started is covered by the shared-health wait, which fails fast with
 * the same code.
 *
 * Pre-flight stale-port-block check (issue #58): when the worktree's
 * control socket is absent (first up — not the idempotent re-up path),
 * `runUp` probes each declared named port the worktree owns and throws
 * `StalePortBlockError` (code `STALE_PORT_BLOCK`) if any of them is held
 * by a foreign process. The allocator deliberately does NOT re-probe a
 * registered block (stability-first), so without this check `up` would
 * hand the block to process-compose and the orphan listener would silently
 * win EADDRINUSE against the new service, leaving the agent with a
 * "Completed" service status and no diagnostic. The check is skipped on
 * the idempotent path because the listeners on those ports are our own.
 *
 * Shared-tier liveness runs *before* the idempotency dispatch (issue #56).
 * The shared instance is repo-wide and its lifecycle is independent of any
 * one worktree's (ADR-0001), so a prior `down --shared` can leave shared
 * dead while this worktree's socket is still present. `ensureSharedStarted`
 * is idempotent (gated by socket-presence + `withSharedLock`), so calling
 * it from both branches is safe and cheap. The `shared_started` value
 * threaded into the returned envelope reflects whether THIS call brought
 * shared up (`true`) or found it already running (`false`).
 */
export async function runUp(deps: CommandDeps = {}): Promise<UpResult> {
  const { anchor } = resolve(deps);
  const seams = resolveUpSeams(deps);
  const { readStack, lock, sharedLock, isPortFree, portHolder, portAccepts, warn } = seams;
  const { readHash, writeHash } = seams;

  const stack = readStack(anchor.worktreeRoot);

  // An explicit `-n` that selects nothing is an error whether or not the
  // instance is running (#203); checked before any version probe or state.
  assertExplicitSelectionNotEmpty(stack, anchor.worktreeId, deps.namespaces);

  // Refuse an unsupported process-compose before allocating ports or touching
  // any state (issue #173): one cheap subprocess, and nothing to roll back.
  await (
    deps.assertProcessComposeVersion ?? (() => createDriver(deps.driver).assertSupportedVersion())
  )();

  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);
  const sharedNeeded = hasTier(stack, "shared");

  // Lock-guarded read-modify-write: allocate (or look up) both the worktree's
  // own block and — if the stack has shared services — the repo-wide shared
  // block under the same lock. Two concurrent `up`s on different worktrees
  // therefore cannot race to the same block, and the shared block stays
  // consistent regardless of which worktree got there first (acceptance:
  // "shared instance appears in the allocation registry as an anchor-keyed
  // entry with its own block", PRD US-32).
  const { blockBase, portFor, sharedPortFor } = await allocateAndBuildPortMaps({
    anchor: anchor.anchor,
    worktreeId: anchor.worktreeId,
    stack,
    options,
    lock,
    isPortFree,
  });

  // Warn for any port literal in a service command that is outside this
  // worktree's block — a hardcoded number devtrees did not allocate (PRD US-24).
  for (const warning of findUnmanagedPortBinds(stack, blockBase, options.blockSize)) {
    warn(warning);
  }

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  // Fail before any side effect if the control socket can't be bound at all
  // (issue #156): an over-long `sun_path` makes process-compose die silently,
  // which used to surface as an unrelated socket-wait timeout. Cheap, pure,
  // and checked here rather than at the spawn so no config or logs dir is
  // written for a start that cannot succeed.
  assertSocketPathFits(paths.socketPath);
  const driver = createDriver(deps.driver);
  const inst = { configPath: paths.configPath, socketPath: paths.socketPath };

  // Per-worktree lifecycle lock (issue #91): the liveness-check →
  // config-write → spawn → socket-wait window runs as ONE critical section.
  // Without it, two concurrent `up`s in the same worktree (human + agent)
  // both pass the liveness gate and both spawn process-compose against the
  // same socket and port block — the loser's exit-time cleanup then unlinks
  // the winner's socket. Under the lock, the loser blocks until the winner's
  // socket is observable and takes the normal idempotency path below. The
  // long health/attach phases run AFTER release, so the lock never outlives
  // the spawn window on the happy path; a holder stuck inside it surfaces to
  // contenders as LOCK_CONTENTION once the wait budget lapses.
  // Pure of the stack, so the same on every path below (#200).
  const braced = bracedEnvVars(stack);

  const outcome = await seams.lifecycleLock(anchor.anchor, anchor.worktreeId, async () => {
    // Liveness, not file existence (issue #80): probe the control socket for an
    // actual listener. A SIGKILLed instance leaves its socket file behind in
    // anchor state; trusting it would take the already-running branch against a
    // dead instance AND skip the #58 pre-flight below. A stale file is unlinked
    // here so this up falls through to the fresh-start path. A socket whose
    // liveness stays unknown (#186) fails INSTANCE_UNRESPONSIVE instead: a
    // fresh start beside a live-but-busy instance would collide on its ports.
    const ownInstanceLive = await socketIsLive(paths.socketPath, seams.probe, {
      command: "up",
      instance: anchor.worktreeId,
    });

    // Fresh-start namespace selection (issue #176, ADR-0008): resolved here,
    // so a bare `up` that would select nothing fails with
    // NO_SERVICES_SELECTED before any spawn, config write or shared lazy-start
    // (the port reservation has already been made, as for every
    // post-allocation failure). `undefined` on the running-instance path,
    // whose bare-`up` target is #177's to define.
    const freshSelection = ownInstanceLive
      ? undefined
      : resolveFreshSelection(stack, anchor.worktreeId, deps.namespaces);

    // Pre-flight stale-port-block check (issue #58). Self-gates on the
    // own-instance-live flag so the idempotent re-up path skips the probe
    // (those listeners ARE our own); on the first-up path, any listener on a
    // declared named port is by definition foreign and we abort with
    // STALE_PORT_BLOCK so the agent sees a discoverable failure instead of a
    // confusing "Completed" service status downstream of EADDRINUSE.
    await assertBlockPortsFree({
      stack,
      worktreeId: anchor.worktreeId,
      blockBase,
      portFor,
      portHolder,
      portAccepts,
      warn,
      ownInstanceLive,
    });

    // Lazy-start the shared instance if any shared services are declared. Runs
    // BEFORE the idempotency dispatch (issue #56): the shared tier's lifecycle
    // is independent of this worktree's, so a prior `down --shared` can leave
    // shared dead while this worktree's socket is still present. The start is
    // gated by `withSharedLock` and an idempotent socket-presence check so two
    // simultaneous `up`s never double-start it (acceptance). Lock ordering is
    // acyclic — worktree lifecycle lock, then shared — and no holder of the
    // shared lock ever acquires a worktree's, so the nesting cannot deadlock.
    //
    // The call also resolves the authoritative shared name→port map (issue
    // #83): when the instance is already running, the map *it* persisted at
    // start wins over this worktree's positional recomputation, so branch
    // divergence (reordered services) cannot skew the injected numbers — and
    // semantic divergence fails with SHARED_DRIFT before anything is derived
    // or spawned for this worktree.
    let sharedStarted = false;
    let sharedChanges: ReadonlyArray<SharedFieldChange> = [];
    let effectiveSharedPortFor = sharedPortFor;
    if (sharedNeeded) {
      const ensured = await ensureSharedStarted(
        anchor.anchor,
        stack,
        anchor.worktreeId,
        sharedPortFor,
        sharedLock,
        { driver, probe: seams.probe, socketTimeoutMs: deps.sharedSocketTimeoutMs, warn },
      );
      sharedStarted = ensured.started;
      sharedChanges = ensured.fieldChanges;
      if (ensured.ports !== undefined) {
        const ports = ensured.ports;
        effectiveSharedPortFor = (name) => ports[name];
      }
      // A shared instance found already running may be carrying a dead
      // service (ADR-0008). Fail here, on the fresh path as much as the
      // running one, before this worktree derives or spawns anything against
      // it. One read; reported, never restarted. A shared instance this call
      // just started is covered by the shared-health wait instead.
      if (!sharedStarted) {
        await assertSharedServicesAlive(
          stack,
          sharedInstancePaths(anchor.anchor).socketPath,
          statusReader(deps, driver),
        );
      }
    }

    const derived = deriveWorktreeConfig(stack, {
      worktreeId: anchor.worktreeId,
      worktreeRoot: anchor.worktreeRoot,
      anchor: anchor.anchor,
      portFor,
      sharedPortFor: effectiveSharedPortFor,
    });

    // Surface every cross-tier `depends_on` edge devtrees just dropped. Silent
    // dropping would make the orchestration-layer wiring a mystery (ADR-0003
    // "Consequences").
    for (const edge of derived.droppedEdges) {
      warn(formatDroppedEdgeWarning(edge));
    }

    // `${NAME}` of an injected variable in a command runs empty: process-compose
    // expands it from its own environment (#200). Warned, never rewritten.
    warnBracedEnvVars(braced, warn);

    // Idempotency branch (issue #31): if this worktree's control socket is held
    // by a live listener (probed above, #80 — file existence alone is not
    // enough), the instance is up. Compare the current resolved-stack hash to
    // the one stored from the previous successful `up`:
    //   - match  -> noop (no driver.up, no registry write)
    //   - drift  -> attempt hot-reload via the driver; map failure to CONFIG_DRIFT.
    // Either way the instance is then verified outside the lock (ADR-0008).
    if (freshSelection === undefined) {
      await reconcileRunning({
        stack,
        anchor,
        paths,
        derived,
        inst,
        driver,
        deps,
        readHash,
        writeHash,
      });
      return { kind: "running", env: derived.env, sharedStarted, sharedChanges } as const;
    }

    // Same-tier edges the fresh selection leaves dangling (ADR-0008, #179):
    // process-compose drops them at launch and only says so in its own log.
    // Warned before the spawn, so the line is on screen before any attach and
    // survives a later HEALTH_TIMEOUT. The running path warns in
    // `verifyRunning`, against the selection it reads back.
    const nsEdges = warnDroppedNamespaceEdges(stack, freshSelection.services, warn);

    // The run dir now lives outside the git dir (issue #156), so the anchor
    // state dir the derived config goes in has to be created on its own —
    // creating the run dir no longer implies it.
    mkdirSync(paths.stateDir, { recursive: true });
    ensureRunDir(anchor.anchor);
    // Create this worktree instance's logs dir so process-compose can open any
    // `log_location` file the derived config points at (issue #136). Only the
    // isolated services land in this instance, so scope dir creation to them.
    ensureLogsDir(stack, logsDir(anchor.anchor, anchor.worktreeId), "isolated");
    writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");
    // A pending-reload marker (#191) describes an instance that is gone now,
    // and so does a DOWN_INCOMPLETE (#155) marker.
    clearPendingReload(anchor.anchor, anchor.worktreeId);
    clearDownIncomplete(anchor.anchor, anchor.worktreeId);

    // Shared-health wait: gate the worktree start on the shared services'
    // readiness probes whenever this worktree drops a cross-tier `depends_on`
    // edge — orchestration-layer stand-in for the edge process-compose can't
    // express across instances (ADR-0003). Skipped when there are no such edges
    // (a stack with shared services nobody isolated depends on doesn't need it).
    if (derived.droppedEdges.length > 0) {
      const sharedPaths = sharedInstancePaths(anchor.anchor);
      const sharedServices = stack.services.filter((s) => s.tier === "shared");
      const sharedNames = sharedServices.map((s) => s.name);
      warn(formatHealthWaitNotice(sharedNames));
      const wait =
        deps.waitForSharedHealth ??
        createWaitForSharedHealth(
          { getServiceStatuses: statusReader(deps, driver) },
          { notify: warn, probe: probeOf(deps) },
        );
      await wait({
        anchor: anchor.anchor,
        socketPath: sharedPaths.socketPath,
        sharedServiceNames: sharedNames,
        probedServiceNames: probedNames(sharedServices),
      });
    }

    // Always a non-empty selection: a bare fresh `up` passes `-n default`, so
    // process-compose never falls back to starting every namespace (#176).
    await driver.up(inst, freshSelection.namespaces);

    // `driver.up` is fire-and-forget: spawn returns before the child binds the
    // UDS. Hold the lifecycle lock until the socket is observable so the next
    // contender's liveness gate sees this start as complete instead of racing
    // a second spawn against it (same reasoning as `ensureSharedStarted`).
    // Fails with `WORKTREE_START_FAILED` on deadline — the failure belongs to
    // THIS instance, not the shared one it used to be blamed on (issue #157).
    await seams.waitForSocketFile(paths.socketPath, {
      worktreeId: anchor.worktreeId,
      configPath: paths.configPath,
    });

    // Record the resolved-stack hash BEFORE releasing the lock: a loser that
    // reconciles the moment we release must see this config as current — a
    // missing hash would route it down the drift path and hot-reload a config
    // the instance was just started from (issue #31 bookkeeping, #91 timing).
    writeHash(anchor.anchor, anchor.worktreeId, stackHash(stack));

    return {
      kind: "started",
      env: derived.env,
      sharedStarted,
      sharedChanges,
      selected: freshSelection.services,
      namespaces: freshSelection.namespaces,
      droppedNamespaceEdges: nsEdges,
    } as const;
  });

  const result = {
    worktreeId: anchor.worktreeId,
    socketPath: paths.socketPath,
    env: outcome.env,
    sharedStarted: outcome.sharedStarted,
    sharedFieldChanges: outcome.sharedChanges,
    bracedEnvVars: braced,
    blockBase,
  } as const;

  if (outcome.kind === "running") {
    // Already-running instance (ADR-0008): verify it instead of trusting that
    // it exists. Runs AFTER the lifecycle lock is released, like the fresh
    // path's health wait, so a slow wait never shows up as LOCK_CONTENTION to
    // a concurrent `up`. Headless always — this path never attaches a TTY.
    const verified = await verifyRunning({
      stack,
      anchor,
      socketPath: paths.socketPath,
      deps,
      driver,
      warn,
    });
    const services = await collectIsolatedServices(
      stack,
      paths.socketPath,
      portFor,
      deps,
      driver,
      verified.rows,
    );
    return {
      ...result,
      services,
      droppedNamespaceEdges: verified.droppedNamespaceEdges,
      restarted: verified.restarted,
    };
  }

  if (shouldAttachAfterUp(deps)) {
    // Attach path (#132): the server is already started detached, and
    // `process-compose attach` renders each service transitioning starting ->
    // ready live. Attach NOW — before any health-wait — so the human watches
    // the stack come up instead of staring at a blank terminal for the whole
    // (possibly 30-60s) wait. The live TUI IS the progress indicator AND the
    // health signal: the human watching it decides when the stack is ready, so
    // `up` returns when they detach. The silent health-wait + HEALTH_TIMEOUT
    // gate only matters for the headless paths below, where nothing renders the
    // state that already exists during the wait.
    await driver.attach(inst);
    // Snapshot the per-service rows after the human detaches so the post-TUI
    // summary line reflects the state at detach time. Best-effort (issue #29).
    const services = await collectIsolatedServices(stack, paths.socketPath, portFor, deps, driver);
    return {
      ...result,
      services,
      droppedNamespaceEdges: outcome.droppedNamespaceEdges,
      restarted: [],
    };
  }

  // Headless paths (`--json` / `--no-attach`): no TUI to render progress, so the
  // silent health-wait is what turns "up returned" into "the stack is serving
  // traffic" (PRD #26, ADR-0005), and HEALTH_TIMEOUT surfaces a stuck start.
  await waitForWorktreeHealth(stack, outcome, paths.socketPath, deps, driver, warn);

  // After the health-wait, snapshot the per-service runtime rows so the
  // issue-#30 `up --json` envelope can publish them without a follow-up
  // `ls --json`. Best-effort: a driver-side hiccup here must not turn the
  // healthy worktree into a failed `up` (same containment rule `ls --json`
  // applies, issue #29).
  const services = await collectIsolatedServices(stack, paths.socketPath, portFor, deps, driver);

  return {
    ...result,
    services,
    droppedNamespaceEdges: outcome.droppedNamespaceEdges,
    restarted: [],
  };
}

/**
 * Read this worktree instance's per-service runtime state and zip it with the
 * named-port allocations devtrees injected at derivation time. Returns the
 * same `Service` rows `discoverInstances` produces — that's the slice-#29
 * shape `up --json` reuses.
 *
 * Best-effort: a driver-side hiccup (process-compose has gone away between
 * the health-wait and now, a permission glitch on the UDS, …) yields an
 * empty array rather than throwing — the worktree itself is healthy at this
 * point, and an agent reading the envelope can still see the port block and
 * env, just without per-service rows.
 */
async function collectIsolatedServices(
  stack: ResolvedStack,
  socketPath: string,
  portFor: (name: string) => number | undefined,
  deps: CommandDeps,
  driver: ReturnType<typeof createDriver>,
  /** Rows the caller already read from this instance; skips the re-read. */
  preRead?: ServiceStatus[],
): Promise<Service[]> {
  let statuses: ServiceStatus[];
  try {
    statuses = preRead ?? (await statusReader(deps, driver)(socketPath));
  } catch {
    return [];
  }
  const portsByService = new Map<string, Record<string, number>>();
  for (const svc of stack.services) {
    if (svc.tier !== "isolated") continue;
    const portMap: Record<string, number> = {};
    for (const name of svc.ports) {
      const port = portFor(name);
      if (port !== undefined) portMap[name] = port;
    }
    portsByService.set(svc.name, portMap);
  }
  return statuses.map((s) => ({
    name: s.name,
    status: s.status,
    health: s.health,
    ports: portsByService.get(s.name) ?? {},
  }));
}

/**
 * Run the full derivation pipeline a real `up` would run — load the stack,
 * allocate this worktree's collision-free port block (and the repo-wide shared
 * block when the stack has shared services), derive the worktree-isolated
 * config and env, and the shared config and env — then STOP before any side
 * effect (#124). The result is the agent-readable preview of what `devtrees
 * up` would run.
 *
 * Instance-aware (#210): when this worktree's instance is running, the
 * preview is of the running-instance path — the namespaces it was booted
 * with (for a bare `up`), whether the config would be hot-reloaded, which
 * dead services would be restarted, and the errors that path raises
 * (`NAMESPACE_NOT_RUNNING`, `CONFIG_DRIFT` with `reload_pending`). That needs
 * read-only probes of the instance: a liveness probe of its control socket
 * and one `process list` read (`previewRunning`).
 *
 * No side effects, by design (the dry-run invariant, ADR-0005):
 *
 *  - No `process-compose` spawn, no reload, no restart, no health/readiness
 *    wait; a stale control-socket file is left in place (the real `up`
 *    unlinks it).
 *  - No config files written under `<anchor>/devtrees/` — neither the
 *    worktree config nor the shared config touch disk.
 *  - No instance registered: the registry's allocation entry IS read-modify-
 *    written (allocation needs a non-colliding block), but no *instance* is
 *    recorded. The stored-stack hash and the pending-reload marker are read
 *    but never written, the per-worktree lifecycle lock is never taken, and
 *    the shared instance is never lazy-started.
 *
 * The one registry touch — `allocateAndBuildPortMaps`'s lock-guarded
 * read-modify-write — is acceptable for a dry run because it neither starts
 * nor registers an instance; it only reserves (or looks up) a block so the
 * previewed ports match what a real `up` would use. If allocation can't get
 * the lock, the caller surfaces `LOCK_CONTENTION` through the standard error
 * envelope. A real `up` racing this dry run could still pick a different
 * block, so the preview reflects a possible (not guaranteed) allocation.
 *
 * Nothing is materialized to disk: the derived config(s) are returned
 * in-memory for the caller to print to stdout — the "preview the derived
 * config" use case, served with no disk write (#125).
 */
export async function runUpDryRun(deps: CommandDeps = {}): Promise<DryRunResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;

  const stack = readStack(anchor.worktreeRoot);
  // The same explicit-`-n` check the real `up` makes first (#203).
  assertExplicitSelectionNotEmpty(stack, anchor.worktreeId, deps.namespaces);
  // Preview the path the real `up` would take (#210): the running-instance
  // one when this worktree's instance is live, else a fresh start (#176). Both
  // raise the errors the real `up` would, and both run before the registry is
  // touched, so a failing preview has no side effect at all.
  const socketPath = instancePaths(anchor.anchor, anchor.worktreeId).socketPath;
  const live = await socketIsLive(
    socketPath,
    resolveProbe(deps),
    { command: "up", instance: anchor.worktreeId },
    { readOnly: true },
  );
  const preview: RunningPreview = live
    ? await previewRunning(stack, anchor, socketPath, deps)
    : { plan: previewFresh(stack, anchor.worktreeId, deps.namespaces) };
  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);
  const sharedNeeded = hasTier(stack, "shared");

  const { portFor, sharedPortFor } = await allocateAndBuildPortMaps({
    anchor: anchor.anchor,
    worktreeId: anchor.worktreeId,
    stack,
    options,
    lock,
    isPortFree,
  });

  const derivedWt = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    anchor: anchor.anchor,
    portFor,
    sharedPortFor,
  });

  // Only the reload filter needs the new derived config; every error is raised above.
  const plan = withoutReloadRestarted(preview, derivedWt.config);

  const base: DryRunResult = {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    anchor: anchor.anchor,
    env: derivedWt.env,
    config: derivedWt.config,
    droppedEdges: derivedWt.droppedEdges,
    ...plan,
    bracedEnvVars: bracedEnvVars(stack),
  };

  if (!sharedNeeded) return base;

  const derivedShared = deriveSharedConfig(stack, {
    workingDir: anchor.anchor,
    anchor: anchor.anchor,
    portFor: sharedPortFor,
  });
  return {
    ...base,
    sharedEnv: derivedShared.env,
    sharedConfig: derivedShared.config,
    // `deriveSharedConfig` can only ever report `shared -> isolated` edges, and
    // `validateStack` rejects those at load time, so this concatenation is a
    // no-op today. It is written as a concatenation anyway so the preview stays
    // exhaustive if that validation ever loosens.
    droppedEdges: [...derivedWt.droppedEdges, ...derivedShared.droppedEdges],
  };
}

/** The part of a `DryRunResult` that depends on which path `up` would take (#210). */
type DryRunPlan = Pick<
  DryRunResult,
  | "instance"
  | "namespaces"
  | "selectedServices"
  | "droppedNamespaceEdges"
  | "wouldReload"
  | "wouldRestart"
>;

/** A fresh start's preview (#176): `-n` verbatim, or `default` for a bare `up`. */
function previewFresh(
  stack: ResolvedStack,
  worktreeId: string,
  requested: ReadonlyArray<string> | undefined,
): DryRunPlan {
  const selection = resolveFreshSelection(stack, worktreeId, requested);
  return {
    instance: "fresh",
    namespaces: selection.namespaces,
    selectedServices: selection.services.map((s) => s.name),
    droppedNamespaceEdges: droppedNamespaceEdges(stack.services, selection.services),
    wouldReload: false,
    wouldRestart: [],
  };
}

/**
 * A running instance's preview (#210), decided by the same checks the real
 * `up` makes, in the same order, from read-only inputs: one bounded `process
 * list` read, the stored stack hash, the pending-reload marker and the
 * on-disk derived config. It raises `reload_pending` (`assertNoPendingReload`,
 * which `reconcileRunning` uses) and `NAMESPACE_NOT_RUNNING`
 * (`planRunningInstance`, which `verifyRunning` uses). Nothing is reloaded,
 * restarted or written, no lock is taken, and a converged marker is left for
 * the real `up` to clear.
 *
 * The real `up` hot-reloads a drifted stack *before* it reads the selection
 * back, so on drift the preview decides against the project as the reload
 * would leave it (`rowsAfterReload`), not as it is now.
 *
 * The read is capped at `--wait-timeout` when given, else at
 * `READ_TIMEOUT_MS` (5s), not the real `up`'s 120s default: a process-compose
 * too slow to answer (or frozen, e.g. SIGSTOPped) fails `HEALTH_TIMEOUT`
 * sooner than the real `up` would.
 *
 * What it cannot preview is the outcome of the side effects themselves: a
 * reload process-compose refuses (`CONFIG_DRIFT`), a restart it refuses
 * (`SERVICE_START_FAILED`), or a service that never becomes healthy
 * (`HEALTH_TIMEOUT`).
 */
async function previewRunning(
  stack: ResolvedStack,
  anchor: { readonly anchor: string; readonly worktreeId: string },
  socketPath: string,
  deps: CommandDeps,
): Promise<RunningPreview> {
  const driver = createDriver(deps.driver);
  const rows = await readStatusesWithin(
    { getServiceStatuses: statusReader(deps, driver) },
    socketPath,
    deps.waitTimeoutMs ?? DRY_RUN_READ_TIMEOUT_MS,
    { probe: probeOf(deps) },
  );
  const readHash = deps.readStoredHash ?? defaultReadStoredHash;
  const wouldReload = readHash(anchor.anchor, anchor.worktreeId) !== stackHash(stack);
  const { configPath } = instancePaths(anchor.anchor, anchor.worktreeId);
  const previous = derivedProcesses(
    existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined,
  );
  assertNoPendingReload({
    anchor,
    marker: readPendingReload(anchor.anchor, anchor.worktreeId),
    rows,
    previous,
    isolated: stack.services.filter((s) => s.tier === "isolated"),
    requested: deps.namespaces ?? [],
    isAlive: deps.isProcessAlive ?? isProcessAlive,
  });
  const reload = wouldReload && previous !== undefined;
  const projected = reload ? rowsAfterReload(stack, previous, rows) : rows;
  const plan = planRunningInstance(stack, anchor.worktreeId, projected, deps.namespaces);
  return {
    plan: {
      instance: "running",
      namespaces: plan.namespaces,
      selectedServices: plan.services.map((s) => s.name),
      droppedNamespaceEdges: plan.droppedNamespaceEdges,
      wouldReload,
      wouldRestart: plan.dead,
    },
    ...(reload ? { previous } : {}),
  };
}

/** Budget for the dry run's one `process list` read when `--wait-timeout` is not given (#210). */
const DRY_RUN_READ_TIMEOUT_MS = READ_TIMEOUT_MS;

/**
 * A preview's plan, plus — for a running instance the preview assumes is
 * reloaded — the derived processes it runs now (`withoutReloadRestarted`
 * needs them once the new config is derived).
 */
interface RunningPreview {
  readonly plan: DryRunPlan;
  readonly previous?: DerivedProcessMap;
}

/**
 * The project as a hot-reload of `stack` would leave it (#210), for the
 * preview to decide against. process-compose keeps the namespace selection it
 * booted with across `project update` (ADR-0008): every service of `stack` in
 * a booted namespace is in the project afterwards, new ones included, and a
 * service moved to an unbooted namespace or removed from `devtrees.yaml` is
 * gone (both verified on v1.122.0). The booted namespaces are read the way a
 * bare `up` reads them, but against the config the instance runs now
 * (`previous`), so a service that is absent only because it is new does not
 * mark its namespace unbooted. A namespace booted with no services in it is
 * not provable this way and is treated as unbooted.
 *
 * Rows of services already present are kept, so a dead one still reads dead;
 * a new service reads `Pending`, not dead.
 */
function rowsAfterReload(
  stack: ResolvedStack,
  previous: DerivedProcessMap,
  rows: ReadonlyArray<ServiceStatus>,
): ServiceStatus[] {
  const before = Object.keys(previous).map((name) => ({
    name,
    ...namespaceOf(previous[name]),
  }));
  const present = new Set(rows.map((r) => r.name));
  const booted = resolveRunningSelection(before, present, undefined).namespaces;
  const byName = new Map(rows.map((r) => [r.name, r]));
  return stack.services
    .filter((s) => s.tier === "isolated" && namespaceSelected(s, booted))
    .map((s) => byName.get(s.name) ?? { name: s.name, status: "Pending", health: "unknown" });
}

/**
 * Drop from `wouldRestart` the dead services the reload itself starts again
 * (#210): process-compose restarts every service whose config changed, dead
 * or not, so the real `up` finds those running and does not restart them
 * (verified on v1.122.0). Compared like `planPendingReload` does, on the
 * YAML round-trip of both configs.
 */
function withoutReloadRestarted(running: RunningPreview, next: DerivedConfig): DryRunPlan {
  const { plan, previous } = running;
  if (previous === undefined) return plan;
  const after = derivedProcesses(stringifyYaml(next)) ?? {};
  const unchanged = (name: string) =>
    JSON.stringify(previous[name]) === JSON.stringify(after[name]);
  return { ...plan, wouldRestart: plan.wouldRestart.filter(unchanged) };
}

/**
 * Options for `runAttach`. Default is to attach this worktree's instance;
 * `{ shared: true }` attaches the shared instance instead.
 */
export interface AttachOptions {
  readonly shared?: boolean;
}

/**
 * Attach a TUI to a running instance — this worktree's by default, or the
 * shared one with `{ shared: true }`. The instance is identified by its
 * control socket under the anchor (CONTEXT.md "Control socket"); if that
 * socket is absent the instance is not running and we throw a clear error
 * instead of letting `process-compose attach` fail with a noisy stack
 * (acceptance, #11).
 *
 * No allocation, no spawn of `up`-style detached processes — we run the
 * driver's `attach` foreground so the TUI inherits the user's terminal,
 * then return when the user detaches and the child exits.
 */
export async function runAttach(
  deps: CommandDeps = {},
  options: AttachOptions = {},
): Promise<void> {
  const { anchor } = resolve(deps);
  const driver = createDriver(deps.driver);

  if (options.shared) {
    const paths = sharedInstancePaths(anchor.anchor);
    if (!existsSync(paths.socketPath)) {
      throw new Error(
        "no shared instance is running. Bring it up implicitly via `devtrees up` " +
          "(when the stack declares shared services) before attaching.",
      );
    }
    await driver.attach({ configPath: paths.configPath, socketPath: paths.socketPath });
    return;
  }

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  if (!existsSync(paths.socketPath)) {
    throw new Error(
      `no worktree instance is running for '${anchor.worktreeId}'. ` +
        `Run \`devtrees up\` to bring it up first.`,
    );
  }
  await driver.attach({ configPath: paths.configPath, socketPath: paths.socketPath });
}

/**
 * Outcome of `ensureSharedStarted`: whether THIS call lazy-started the shared
 * instance, and the authoritative name→port map worktrees must inject for
 * shared services (issue #83). `ports` is `undefined` only on the legacy
 * fallback — a shared instance started by a pre-#83 devtrees whose anchor
 * state has no persisted map; the caller falls back to positional offsets.
 */
interface EnsuredShared {
  readonly started: boolean;
  /** Extended shared fields edited since the running instance started (#185). */
  readonly fieldChanges: ReadonlyArray<SharedFieldChange>;
  readonly ports?: Readonly<Record<string, number>>;
}

/**
 * Idempotently lazy-start the shared instance: under the shared lifecycle lock,
 * if its control socket is held by a live listener do nothing; otherwise write
 * a fresh derived shared config and spawn `process-compose` against it. The
 * lock is the gate — two simultaneous callers see a consistent answer and at
 * most one actually starts the instance.
 *
 * Liveness is probed, not inferred from the socket file (#80): a SIGKILLed
 * shared instance leaves its socket behind, and trusting the file would make
 * the shared instance unrestartable without hand-deleting it. A stale socket
 * is unlinked and we fall through to the fresh start.
 *
 * The running instance is the source of truth for shared ports (issue #83):
 *
 *  - On start, the name→port map it binds and the shared-subset hash it was
 *    derived from are persisted in anchor state (`shared-state.json`).
 *  - On the already-running branch, this worktree's shared subset is checked
 *    against that persisted hash — divergence throws `SharedDriftError`
 *    (`SHARED_DRIFT`) instead of letting the caller inject numbers the
 *    instance never bound — and the persisted map is returned for injection.
 */
async function ensureSharedStarted(
  anchor: string,
  stack: ResolvedStack,
  worktreeId: string,
  sharedPortFor: (name: string) => number | undefined,
  sharedLock: WithSharedLock,
  deps: {
    driver: ReturnType<typeof createDriver>;
    probe: LivenessProbe;
    /** Socket-bind wait window for the lazy start (issue #92). Default: 3s. */
    socketTimeoutMs?: number;
    /** Sink for the shared-field-change warnings (#185). */
    warn: (message: string) => void;
  },
): Promise<EnsuredShared> {
  return await sharedLock(anchor, async () => {
    const paths = sharedInstancePaths(anchor);
    // Unknown liveness (#186) fails INSTANCE_UNRESPONSIVE rather than
    // lazy-starting a second shared instance onto the same ports.
    const live = await socketIsLive(paths.socketPath, deps.probe, {
      command: "up",
      instance: SHARED_INSTANCE_ID,
    });
    if (live) {
      const state = readSharedState(anchor);
      // Legacy fallback: a pre-#83 shared instance left no persisted map.
      // Positional computation is all we have — same behaviour as before.
      if (state === undefined) return { started: false, fieldChanges: [] };
      assertSharedSubsetMatches(stack, state, worktreeId);
      const fieldChanges = sharedFieldChanges(state, sharedExtendedFields(stack));
      for (const change of fieldChanges) deps.warn(formatSharedFieldChangeWarning(change));
      return { started: false, ports: state.ports, fieldChanges };
    }

    // Same bind-site guard the worktree instance gets (issue #156) — the
    // shared socket lives in the same run dir, so a run dir that is too long
    // for `sun_path` breaks both instances and must say so, not time out.
    assertSocketPathFits(paths.socketPath);

    const derived = deriveSharedConfig(stack, {
      workingDir: anchor,
      anchor,
      portFor: sharedPortFor,
    });

    // The run dir now lives outside the git dir (issue #156), so the anchor
    // state dir the derived config goes in has to be created on its own.
    mkdirSync(paths.stateDir, { recursive: true });
    ensureRunDir(anchor);
    // Create the shared instance's logs dir so process-compose can open any
    // `log_location` file the derived config points at (issue #136). Only the
    // shared services land in this instance, so scope dir creation to them.
    ensureLogsDir(stack, logsDir(anchor, SHARED_INSTANCE_ID), "shared");
    writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");

    await deps.driver.up({ configPath: paths.configPath, socketPath: paths.socketPath });
    // `driver.up` is fire-and-forget: spawn returns before the child binds the
    // UDS. Hold the shared lock until the socket is observable on disk so a
    // concurrent `up` from another worktree sees the lazy-start as complete and
    // doesn't race a second stub against ours (the loser's exit-time cleanup
    // would unlink the winner's socket). Throws `SHARED_START_FAILED` on
    // deadline (issue #92): a socket that never appears means the instance
    // died before binding, and reporting `shared_started: true` for a corpse
    // would leave the agent debugging healthy-looking output.
    await waitForSharedSocket(paths.socketPath, paths.configPath, deps.socketTimeoutMs);

    // Make the running instance the source of truth: persist what it was
    // started with so every subsequent `up`/`env` — on any branch — injects
    // these numbers, not its own positional recomputation (issue #83).
    const ports = collectSharedPorts(stack, sharedPortFor);
    writeSharedState(anchor, {
      hash: sharedStackHash(stack),
      ports,
      extended: sharedExtendedFields(stack),
    });
    return { started: true, ports, fieldChanges: [] };
  });
}

/**
 * The deadline both post-spawn socket waits run on. Kept as one constant so
 * the worktree and shared waits can't drift apart: #156 established there is
 * no timing component to the failures they report (a bind that can't succeed
 * never succeeds), so this is a fail-fast bound, not a tuning knob.
 */
const SOCKET_WAIT_TIMEOUT_MS = 3000;

/**
 * Poll until `socketPath` shows up on disk; `true` if it did, `false` on
 * deadline. The two callers below turn `false` into their own envelope —
 * this is deliberately the only shared part, because attributing the failure
 * to the wrong instance is exactly the bug #157 fixed.
 */
async function pollForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/**
 * Poll until the *shared* instance's socket exists, or throw
 * `SharedStartFailedError` when the deadline lapses (issue #92). Silently
 * returning here used to let `up` report a shared instance that died before
 * binding as `shared_started: true` — the failure must surface as an error
 * envelope instead.
 */
async function waitForSharedSocket(
  socketPath: string,
  configPath: string,
  timeoutMs = SOCKET_WAIT_TIMEOUT_MS,
): Promise<void> {
  if (await pollForSocket(socketPath, timeoutMs)) return;
  throw new SharedStartFailedError(
    `devtrees up: the shared instance was spawned but did not bind its control socket ` +
      `within ${timeoutMs}ms — it most likely crashed on startup. ` +
      `Check the shared services' commands (e.g. run ` +
      `\`process-compose -f ${configPath}\` by hand) and retry \`devtrees up\`.`,
    { socket_path: socketPath, config_path: configPath, timeout_ms: timeoutMs },
  );
}

/**
 * Poll until *this worktree's* instance socket exists, or throw
 * `WorktreeStartFailedError` when the deadline lapses (issue #157). This wait
 * used to share the shared instance's error, so a stack with no shared tier
 * at all failed with `SHARED_START_FAILED` and sent its reader looking at an
 * instance that was never started (issue #154). The remediation names the
 * worktree's own derived config — running the shared one by hand would start
 * the wrong services.
 */
async function waitForWorktreeSocket(
  socketPath: string,
  instance: WorktreeInstanceRef,
  timeoutMs = SOCKET_WAIT_TIMEOUT_MS,
): Promise<void> {
  if (await pollForSocket(socketPath, timeoutMs)) return;
  throw new WorktreeStartFailedError(
    `devtrees up: this worktree's instance (${instance.worktreeId}) was spawned but did not ` +
      `bind its control socket within ${timeoutMs}ms — it most likely crashed on startup. ` +
      `Check the isolated services' commands (e.g. run ` +
      `\`process-compose -f ${instance.configPath}\` by hand) and retry \`devtrees up\`.`,
    {
      worktree_id: instance.worktreeId,
      socket_path: socketPath,
      config_path: instance.configPath,
      timeout_ms: timeoutMs,
    },
  );
}

// A real port a service binds shows up in its command as `--port 3000` / `:3000` /
// `PORT=3000`; this matches 4–5 digit numbers after an option-like separator.
const PORT_LITERAL_RE = /(?:^|[:=\s])(\d{4,5})(?=\b)/g;
const MIN_USER_PORT = 1024;
const MAX_TCP_PORT = 65535;

/** All distinct user-port-range literals appearing in a command string. */
function extractPortLiterals(command: string): number[] {
  const seen = new Set<number>();
  for (const match of command.matchAll(PORT_LITERAL_RE)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    const n = Number(candidate);
    if (n >= MIN_USER_PORT && n <= MAX_TCP_PORT) seen.add(n);
  }
  return [...seen];
}

function formatUnmanagedPortWarning(
  serviceName: string,
  port: number,
  blockBase: number,
  blockEnd: number,
): string {
  return (
    `devtrees: service '${serviceName}' command appears to bind port ${port}, ` +
    `which is outside this worktree's allocated block [${blockBase}, ${blockEnd - 1}]. ` +
    `Devtrees did not allocate it — declare it as a named port (e.g. ports: [WEB_PORT]) ` +
    `and reference it as $WEB_PORT instead.`
  );
}

/**
 * Heuristic static scan for hardcoded port literals in isolated-service commands
 * that fall outside the worktree's allocated block. If the number is in TCP
 * user-port range (1024–65535) and not inside this worktree's block, devtrees
 * did not manage it (CONTEXT.md "Port block", PRD US-24).
 *
 * Exported for unit tests; the warning emission itself is exercised through
 * `runUp` so callers see a black-box behaviour.
 */
export function findUnmanagedPortBinds(
  stack: ResolvedStack,
  blockBase: number,
  blockSize: number,
): string[] {
  const blockEnd = blockBase + blockSize;
  const isInBlock = (n: number): boolean => n >= blockBase && n < blockEnd;
  return stack.services
    .filter((s) => s.tier === "isolated")
    .flatMap((service) =>
      extractPortLiterals(service.command)
        .filter((n) => !isInBlock(n))
        .map((n) => formatUnmanagedPortWarning(service.name, n, blockBase, blockEnd)),
    );
}

/**
 * Result of `runDown` — operation-output only (issue #48). The teardown action
 * identifies which target it stopped: `{shared: true}` for shared teardown or
 * `{worktreeId: "<id>"}` for worktree teardown. Discriminated union so the
 * type system enforces "exactly one" — the `down --json` envelope mirrors
 * this shape directly.
 *
 * Pre- and post-teardown state (env, services, block_base) is deliberately
 * absent: agents that want either should call `ls --json` before or after
 * `down`. The action envelope used to carry a prior-state snapshot that
 * raced against socket teardown and duplicated `ls --json` — issue #48
 * dropped it.
 */
export type DownResult =
  | {
      readonly shared: true;
      readonly worktreeId?: undefined;
      readonly stopped: boolean;
      /** Service processes devtrees had to SIGKILL to finish the stop (#190). */
      readonly forceKilled?: ReadonlyArray<ForceKilled>;
    }
  | {
      readonly shared: false;
      readonly worktreeId: string;
      readonly stopped: boolean;
      /** Service processes devtrees had to SIGKILL to finish the stop (#190). */
      readonly forceKilled?: ReadonlyArray<ForceKilled>;
      /**
       * Present when the dead-supervisor direct reap (issue #148) failed for at
       * least one shutdown hook — out-of-band resources may have survived. The
       * teardown still completes (on-disk state reclaimed); this flags that the
       * reap itself did not cleanly finish (acceptance #5).
       */
      readonly warning?: ReapWarning;
    };

/**
 * Stop this worktree's instance (default) or — with `{ shared: true }` — the
 * shared instance, and return an operation-identity result.
 *
 * The two lifecycles are decoupled (ADR-0001): worktree `down` never touches
 * shared, so other worktrees keep their connections. Shared teardown is gated
 * by the shared lifecycle lock and idempotent: if the shared instance is not
 * running, the call is a no-op.
 *
 * Shared block stability (#51): `down --shared` preserves the `__shared__`
 * registry entry. The next `up` re-uses the same block via the allocator
 * fast-path, giving agents that record `DB_PORT` once a stable value across
 * `down --shared` + `up` cycles. Lazy-start of the shared instance is still
 * driven by socket absence, not registry presence, and `ls --json` liveness
 * flows from the socket (instances.ts) — the surviving entry is invisible to
 * it.
 *
 * Issue #48 trimmed this command's return to operation-output only: the
 * envelope used to carry a prior-state snapshot (env, services, block_base)
 * that raced socket teardown and duplicated `ls --json`. Agents that want
 * pre- or post-teardown state should call `ls --json` before/after `down`.
 */
export async function runDown(
  deps: CommandDeps = {},
  options: DownOptions = {},
): Promise<DownResult> {
  const { anchor } = resolve(deps);
  const driver = createDriver(deps.driver);

  if (options.shared) {
    const sharedLock = deps.withSharedLock ?? defaultWithSharedLock;
    const probe = resolveProbe(deps);
    const paths = sharedInstancePaths(anchor.anchor);

    const stop = await sharedLock(anchor.anchor, async () => {
      // Probe, don't trust the file (#80): after a SIGKILL the socket file
      // survives with no listener behind it, and `process-compose down`
      // against the dead UDS fails. A live instance is signalled through the
      // driver; a stale socket is unlinked by the probe gate itself, so
      // either way the call converges to "shared is down" — idempotently.
      // Unknown liveness (#186) fails INSTANCE_UNRESPONSIVE: never report
      // "not running" (or drop the config) for an instance that may be live.
      const live = await socketIsLive(paths.socketPath, probe, {
        command: "down",
        instance: SHARED_INSTANCE_ID,
      });
      // A stop that times out (#190) throws DOWN_TIMEOUT before the config
      // is removed, so a retry still finds the instance.
      const forceKilled = live
        ? (await stopInstance(driver, paths, SHARED_INSTANCE_ID, "down", deps.stop)).forceKilled
        : [];
      // Best-effort cleanup of the derived config — a future `up` re-derives it.
      rmSync(paths.configPath, { force: true });
      return { stopped: live, forceKilled };
    });

    // Keep the `__shared__` registry entry across the teardown (issue #51).
    // The next `up` re-uses the same block via the allocator fast-path
    // (src/allocator.ts), giving agents that record `DB_PORT` once a stable
    // value across `down --shared` + `up` cycles. `ls --json` liveness flows
    // from socket presence (instances.ts), not the registry, so dropping the
    // entry was tidy theatre at the cost of port stability.

    return { shared: true, stopped: stop.stopped, forceKilled: stop.forceKilled };
  }

  // Worktree branch mirrors the shared branch's idempotency (issue #92): a
  // `down` with nothing running used to shell out unconditionally and surface
  // a raw "process-compose down exited with code N" as UNKNOWN. Probe first
  // (#80 — a stale socket file is unlinked by the gate itself) and skip the
  // driver when no live instance answers; the caller renders the no-op notice
  // from `stopped: false` and still exits 0.
  //
  // The probe and the stop run under the worktree's lifecycle lock (#178),
  // the same lock `up` holds while it spawns or restarts services: an `up`
  // restarting dead services must never `process start` on a supervisor this
  // `down` is shutting down (the restarted process would outlive it,
  // orphaned). A contended lock waits ~10s, then fails LOCK_CONTENTION.
  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  const lifecycleLock = deps.withLifecycleLock ?? defaultWithLifecycleLock;
  //
  // The stop is bounded (#190), so the lock is never held forever: a
  // concurrent `up` waiting on it fails LOCK_CONTENTION after ~10s while a
  // slow stop runs out its budget.
  const stop = await lifecycleLock(
    anchor.anchor,
    anchor.worktreeId,
    async (): Promise<{
      stopped: StopResult | undefined;
      warning?: ReapWarning;
      survivors?: DownSurvivor[];
    }> => {
      // Unknown liveness (#186) throws INSTANCE_UNRESPONSIVE out of the lock:
      // neither "nothing running" nor the dead-supervisor reap below may run
      // against an instance that might still be live.
      const wasLive = await socketIsLive(paths.socketPath, resolveProbe(deps), {
        command: "down",
        instance: anchor.worktreeId,
      });
      // Live supervisor: a graceful `process-compose down` fires each process's
      // `shutdown.command` from its `working_dir` (the worktree, which is present
      // on the normal `down` path). devtrees must NOT also run the hook directly
      // here — that would double-run it (acceptance #4: no regression).
      // A reload still pending (#191) waits on old processes process-compose
      // no longer lists: the bounded stop kills them first, and lets that
      // reload finish before it stops anything (#206).
      const stopped = wasLive
        ? await stopInstance(
            driver,
            paths,
            anchor.worktreeId,
            "down",
            deps.stop,
            readPendingReload(anchor.anchor, anchor.worktreeId),
          )
        : undefined;
      // process-compose exited on its own while the pending reload settled
      // (#206): its socket file may be left behind, with no listener.
      if (stopped?.supervisorExited) rmSync(paths.socketPath, { force: true });
      // The instance is gone either way, and with it any reload still pending
      // in it (#191). Not reached when the stop throws (DOWN_TIMEOUT keeps it).
      clearPendingReload(anchor.anchor, anchor.worktreeId);
      // Still under the lock, so a concurrent `up` cannot start listeners that
      // would pass for survivors (#155).
      if (stopped === undefined || stopped.supervisorExited) return { stopped };
      const after = await checkAfterStop(stopped, paths.configPath, anchor, deps);
      // Record what to re-check, so the `down` the remedy names converges (#155).
      if ((after.survivors ?? []).length === 0)
        clearDownIncomplete(anchor.anchor, anchor.worktreeId);
      else writeDownIncomplete(anchor.anchor, anchor.worktreeId, bootedServices(stopped));
      return { stopped, ...after };
    },
  );
  if (stop.stopped !== undefined && !stop.stopped.supervisorExited) {
    const forceKilled = stop.stopped.forceKilled;
    if (stop.survivors !== undefined && stop.survivors.length > 0) {
      throw downIncomplete(anchor.worktreeId, stop.survivors, forceKilled, stop.warning?.failures);
    }
    return {
      shared: false,
      worktreeId: anchor.worktreeId,
      stopped: true,
      forceKilled,
      ...(stop.warning !== undefined ? { warning: stop.warning } : {}),
    };
  }

  // Dead-supervisor `down` path (issue #148): the socket probed stale (a
  // SIGKILLed/rebooted supervisor), so no process-compose remains to launch the
  // `shutdown.command`. The hook never fired → out-of-band resources leak. Run
  // it ourselves, socket-free, from the anchor (a directory that exists), so the
  // reap happens even when the supervisor is gone. Idempotent: an already-gone
  // stack's hook reaps nothing. A supervisor that exited on its own during
  // the stop (#206) is reaped the same way, and the instance was stopped.
  const reap = deps.reap ?? reapShutdownHooks;
  const warning = await reapDerivedConfig(paths.configPath, anchor.worktreeId, anchor.anchor, reap);
  // An earlier `down` failed DOWN_INCOMPLETE (#155): with the hooks re-run,
  // check the same ports again, and succeed only once they are free.
  await recheckDownIncomplete(paths.configPath, anchor, deps, warning);

  return {
    shared: false,
    worktreeId: anchor.worktreeId,
    stopped: stop.stopped !== undefined,
    forceKilled: stop.stopped?.forceKilled ?? [],
    ...(warning !== undefined ? { warning } : {}),
  };
}

/** `lsof`'s cap when `down` names a surviving listener (#155): hooks may still load the machine. */
const LSOF_DOWN_TIMEOUT_MS = 5_000;

/**
 * After a worktree's process-compose has stopped (#155): run the shutdown
 * hooks it skipped (daemons whose launch had already exited), then look for
 * anything the instance owned that is still alive: a service descendant the
 * tree sweep could not kill, or a listener on a booted service's named port.
 * Without the pre-stop `process list` there is nothing to judge by, and the
 * check is skipped.
 */
async function checkAfterStop(
  stopped: StopResult,
  configPath: string,
  anchor: { readonly anchor: string; readonly worktreeId: string },
  deps: CommandDeps,
): Promise<{ warning?: ReapWarning; survivors?: DownSurvivor[] }> {
  const config = readDerivedConfig(configPath);
  const processes = (stopped.survivors ?? []).map(processSurvivor);
  if (config === undefined || stopped.statuses === undefined) return { survivors: processes };
  const skipped = daemonHooksSkipped(config, stopped.statuses);
  const warning =
    skipped === undefined
      ? undefined
      : await reapDerivedHooks(skipped, configPath, anchor, deps.reap ?? reapShutdownHooks);
  const listeners = await findPortSurvivors(
    config,
    bootedServices(stopped),
    portSurvivorSeams(deps),
  );
  return {
    survivors: [...processes, ...listeners],
    ...(warning !== undefined ? { warning } : {}),
  };
}

/** The services the pre-stop `process list` showed: the ones the instance had booted. */
function bootedServices(stopped: StopResult): string[] {
  return (stopped.statuses ?? []).map((s) => s.name);
}

/**
 * The dead-supervisor half of #155's convergence: when an earlier `down`
 * failed `DOWN_INCOMPLETE`, check the services it recorded again. Still
 * held: fail `DOWN_INCOMPLETE` again (with any hook that failed this time),
 * keeping the marker. Free: clear it.
 */
async function recheckDownIncomplete(
  configPath: string,
  anchor: { readonly anchor: string; readonly worktreeId: string },
  deps: CommandDeps,
  warning: ReapWarning | undefined,
): Promise<void> {
  const services = readDownIncomplete(anchor.anchor, anchor.worktreeId);
  if (services === undefined) return;
  const config = readDerivedConfig(configPath);
  const survivors =
    config === undefined ? [] : await findPortSurvivors(config, services, portSurvivorSeams(deps));
  if (survivors.length === 0) {
    clearDownIncomplete(anchor.anchor, anchor.worktreeId);
    return;
  }
  throw downIncomplete(anchor.worktreeId, survivors, [], warning?.failures);
}

/** Run `config`'s shutdown hooks from the anchor; a `ReapWarning` when any failed. */
async function reapDerivedHooks(
  config: DerivedConfig,
  configPath: string,
  anchor: { readonly anchor: string; readonly worktreeId: string },
  reap: Reaper,
): Promise<ReapWarning | undefined> {
  const outcome = await reap(config, { cwd: anchor.anchor });
  if (outcome.failures.length === 0) return undefined;
  return {
    orphanId: anchor.worktreeId,
    worktreePath: readWorktreePath(configPath),
    failures: outcome.failures,
  };
}

/** The seams `down`'s listener check runs on (#155). */
function portSurvivorSeams(deps: CommandDeps): PortSurvivorSeams {
  return {
    accepts: deps.portAccepts ?? acceptsConnections,
    identify:
      deps.identifyPortHolder ?? ((port) => identifyHolderViaLsof(port, LSOF_DOWN_TIMEOUT_MS)),
    ...(deps.portSettleMs !== undefined ? { waitMs: deps.portSettleMs } : {}),
  };
}

/**
 * Stop a live instance with the bounded `down` (#190): a budget of 30s plus
 * every `shutdown.timeout_seconds` in its derived config, then a surgical
 * SIGKILL of the service processes that kept it from stopping. The old runs
 * a pending reload is stuck on (`pendingReload`, #206) are killed before
 * the stop, which begins only once that reload has finished. Throws
 * `DOWN_TIMEOUT` (nothing removed) when process-compose still has not
 * exited, or when the reload never finished and the stop was not begun.
 */
function stopInstance(
  driver: StopDriver,
  paths: { readonly configPath: string; readonly socketPath: string },
  instance: string,
  command: "down" | "prune",
  seams: StopSeams | undefined,
  pendingReload?: PendingReload,
): Promise<StopResult> {
  const config = readDerivedConfig(paths.configPath);
  return boundedDown(
    {
      inst: { configPath: paths.configPath, socketPath: paths.socketPath },
      instance,
      command,
      timeoutMs: downTimeoutMs(config, seams?.baseTimeoutMs),
      remedy: (pid, pending) =>
        downTimeoutRemedy(instance, command, paths.socketPath, pid, pending),
      pendingReload,
      unsignalled: unsignalledServices(config),
    },
    driver,
    seams,
  );
}

/**
 * The `details.remedy` a `DOWN_TIMEOUT` carries (#190). devtrees does not
 * kill process-compose itself: that would skip the shutdown hooks it has not
 * run yet. The operator does, knowingly, and the follow-up command cleans up.
 */
function downTimeoutRemedy(
  instance: string,
  command: "down" | "prune",
  socketPath: string,
  processComposePid: number | undefined,
  pending?: { readonly oldRuns: ReadonlyArray<ForceKilled> },
): string {
  const shared = instance === SHARED_INSTANCE_ID;
  const retry =
    command === "prune" ? "devtrees prune" : shared ? "devtrees down --shared" : "devtrees down";
  // A pending reload (#206): process-compose's own shutdown waits on the
  // same old process, so stopping process-compose by hand does not help.
  // Killing the old process does, and is safe while no stop is running.
  if (pending !== undefined) {
    if (pending.oldRuns.length === 0) return `Retry \`${retry}\` in a moment.`;
    const pids = pending.oldRuns.map((r) => r.pid).join(" ");
    return (
      `Kill the old process first (\`kill ${pids}\`, then \`kill -9 ${pids}\` if it ignores ` +
      `that; safe now, as no stop is running), then retry \`${retry}\`. Stopping ` +
      "process-compose by hand does not help: its own shutdown waits on the same process."
    );
  }
  const pid = processComposePid === undefined ? "<pid>" : String(processComposePid);
  const find =
    processComposePid === undefined
      ? `find process-compose with \`lsof -U -a ${socketPath}\` and stop it`
      : "stop process-compose by hand";
  const after = shared
    ? "Shutdown hooks it had not run yet will not run: check for anything they would have cleaned up."
    : "With process-compose gone, devtrees runs the shutdown hooks itself.";
  return (
    `Retry \`${retry}\` in a moment. If it still does not finish, ${find} ` +
    `(\`kill ${pid}\`, then \`kill -9 ${pid}\` if it ignores that) and run \`${retry}\` ` +
    `again to clean up. ${after}`
  );
}

// --- restart (ADR-0009, #222) -----------------------------------------------

export interface RestartResult {
  readonly worktreeId: string;
  /** The services restarted, in the order they were restarted (`depends_on`). */
  readonly restarted: ReadonlyArray<string>;
  /** Their rows once healthy, in restart order, in the `ls --json` shape. */
  readonly services: ReadonlyArray<Service>;
  /** Old-run processes devtrees signalled because they did not exit on their own. */
  readonly forceKilled: ReadonlyArray<ForceKilled>;
  /** Shared services in a `-n` namespace, not restarted (#224). */
  readonly skippedShared: ReadonlyArray<string>;
}

/**
 * `devtrees restart <service...>` (ADR-0009, #222): restart the named
 * isolated services of this worktree's running instance in place, one at a
 * time in `depends_on` order. The instance, its ports and every other
 * service keep running; dependents of a named service are not restarted. A
 * stopped or dead service is simply started.
 *
 * For each service in turn:
 *
 *  1. Under this worktree's lifecycle lock (the one `up` and `down` take):
 *     run every check (`resolveNamedServices`, again for each service so
 *     what changed while the lock was released is caught),
 *     refuse the instance's last running process (`LAST_SERVICES_RUNNING`:
 *     its stop would make process-compose exit), then restart it
 *     (`boundedRestart`: a bounded stop, then a start; old-run
 *     processes it had to signal are reported in `forceKilled`). The lock
 *     is held for one service's restart: its stop (budget: 30s
 *     plus its `shutdown.timeout_seconds`, then the escalation's grace) and
 *     its start (10s at most). A concurrent `up` or `down` waits ~10s for
 *     it, then fails `LOCK_CONTENTION`.
 *  2. With the lock released, wait for it to be healthy, with `up`'s health
 *     wait, before restarting the services that depend on it, so their
 *     `process_healthy` conditions hold. One `--wait-timeout` budget covers
 *     every service.
 *
 * A restart process-compose refuses fails `SERVICE_START_FAILED`; the
 * services after it are not touched. process-compose exiting meanwhile (a
 * one-shot finished during the stop, leaving nothing running) fails
 * `INSTANCE_NOT_FOUND` saying so. A service that does not become healthy, or
 * dies, fails `HEALTH_TIMEOUT` and is left running so `logs` and
 * `ls --json` still work.
 *
 * `namespaces` (`-n`, #224) adds every isolated service of each namespace to
 * `names` (`resolveNamedServices`); shared services in them are skipped and
 * reported in `skippedShared`.
 */
export async function runRestart(
  deps: CommandDeps,
  names: ReadonlyArray<string>,
  namespaces: ReadonlyArray<string> = [],
): Promise<RestartResult> {
  const { anchor } = resolve(deps);
  const lifecycleLock = deps.withLifecycleLock ?? defaultWithLifecycleLock;
  const driver = createDriver(deps.driver);
  const warn = deps.warn ?? defaultWarn;
  // One health-wait budget for every service; the stops and starts do not spend it.
  let budget = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const done: Array<{ name: string; row: Service | undefined }> = [];
  const forceKilled: ForceKilled[] = [];
  let order: string[] | undefined;
  let skippedShared: ReadonlyArray<string> = [];
  for (let i = 0; order === undefined || i < order.length; i++) {
    const step = await lifecycleLock(anchor.anchor, anchor.worktreeId, async () => {
      const restarted = done.map((d) => d.name);
      const target = await resolveRestartStep(deps, names, restarted, namespaces);
      if (order === undefined) {
        order = [...target.services];
        skippedShared = target.skippedShared;
      }
      // Before anything is touched, and again before each later service: a
      // one-shot that finished meanwhile may have left it the last one.
      const ahead = order.slice(i);
      // A service still `Pending` has not started: `process stop` would leave
      // it `Terminating` with no process for good (#223).
      const { pending } = partitionRunning(target.rows, ahead);
      assertNotPending(pending, waitingOn(target), anchor.worktreeId);
      assertRestartKeepsInstance(target, ahead, restarted);
      const name = order[i] ?? "";
      return { target, name, ...(await restartOne(target, name, driver, deps, restarted)) };
    });
    forceKilled.push(...step.forceKilled);
    warnSurvivors(step.survivors, warn);
    const waitStarted = Date.now();
    const rows = await waitForSelectedHealth(
      [restartedService(step.target, step.name)],
      step.target.socketPath,
      deps,
      driver,
      {
        remedy: restartRemedy(step.target),
        warn,
        restarted: [step.restarted],
        command: "restart",
        timeoutMs: Math.max(1, budget),
      },
    );
    budget -= Date.now() - waitStarted;
    done.push({ name: step.name, row: serviceRow(step.target, rows, step.name) });
  }
  return {
    worktreeId: anchor.worktreeId,
    restarted: done.map((d) => d.name),
    services: done.flatMap((d) => (d.row === undefined ? [] : [d.row])),
    forceKilled,
    skippedShared,
  };
}

/**
 * `resolveNamedServices` for one restart step. Two things read differently
 * from the resolver's own errors: a process-compose that never answers the status read is
 * `INSTANCE_UNRESPONSIVE` (nothing was touched; it is not a health wait),
 * and an instance gone after earlier steps restarted services (a concurrent
 * `down` between two lock windows) says which ones.
 */
async function resolveRestartStep(
  deps: CommandDeps,
  names: ReadonlyArray<string>,
  done: ReadonlyArray<string>,
  namespaces: ReadonlyArray<string>,
): Promise<NamedServices> {
  const { anchor } = resolve(deps);
  try {
    return await resolveNamedServices(deps, names, "restart", namespaces);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "HEALTH_TIMEOUT") {
      const socketPath = instancePaths(anchor.anchor, anchor.worktreeId).socketPath;
      const retry = namedServicesInvocation("restart", names, namespaces);
      throw new InstanceUnresponsiveError("restart", {
        instance: anchor.worktreeId,
        socket_path: socketPath,
        attempts: 1,
        remedy: unresponsiveRemedy(socketPath, {
          command: "restart",
          retry,
          instance: anchor.worktreeId,
        }),
      });
    }
    if (code === "INSTANCE_NOT_FOUND" && done.length > 0) {
      throw instanceNotRunningError("restart", anchor.worktreeId, done);
    }
    throw err;
  }
}

/**
 * Refuse to restart a running service that is the instance's last running
 * process (`LAST_SERVICES_RUNNING`, ADR-0009):
 * process-compose exits once nothing runs, taking the instance with it.
 * `process restart` is no way out: it starts the new run while the old one
 * may still hold the port, and the new run dies (and the instance with it)
 * or comes up on another port. Services that are not running are just
 * started, so they never count as last.
 */
function assertRestartKeepsInstance(
  target: NamedServices,
  pending: ReadonlyArray<string>,
  done: ReadonlyArray<string>,
): void {
  for (const name of pending) {
    const row = target.rows.find((r) => r.name === name);
    if (row === undefined || classifyService(row) !== "active") continue;
    assertNotLastRunning(target.rows, [name], target.anchor.worktreeId, {
      remedy: restartRemedy(target),
      done,
    });
  }
}

/**
 * Restart one service with `boundedRestart`. A refusal fails
 * `SERVICE_START_FAILED`, naming the services already restarted, unless
 * process-compose is gone (it exits once nothing runs, so something else
 * finished meanwhile): that is `INSTANCE_NOT_FOUND`.
 */
async function restartOne(
  target: NamedServices,
  name: string,
  driver: ReturnType<typeof createDriver>,
  deps: CommandDeps,
  done: ReadonlyArray<string>,
): Promise<{
  restarted: RestartedService;
  forceKilled: ReadonlyArray<ForceKilled>;
  survivors: ReadonlyArray<ServiceProcess>;
}> {
  const before = target.rows.find((r) => r.name === name);
  const read = statusReader(deps, driver);
  const id = target.anchor.worktreeId;
  const gone = () => isGone(probeOf(deps), target.socketPath);
  const outcome = await boundedRestart(
    {
      socketPath: target.socketPath,
      service: name,
      statuses: target.rows,
      timeoutMs: stopTimeoutMs(target.config, [name], deps.stop?.baseTimeoutMs),
      unsignalled: unsignalledServices(target.config),
      instance: id,
      instanceGone: gone,
    },
    {
      stopProcesses: (socket, services) => driver.stopProcesses(socket, services),
      startProcess: (socket, service) => driver.startProcess(socket, service),
      getServiceStatuses: (socket) => read(socket),
    },
    deps.stop,
  ).catch((err: unknown) => {
    // process-compose exited during the stop: name what was restarted before.
    if ((err as { code?: unknown }).code !== "INSTANCE_NOT_FOUND") throw err;
    throw instanceExitedError(id, [name], done);
  });
  if (!outcome.ok) {
    if (await gone()) throw instanceExitedError(id, [name], done);
    throw restartFailedError(target, name, outcome.message, done);
  }
  return {
    restarted: before?.pid === undefined ? { name } : { name, stalePid: before.pid },
    forceKilled: outcome.forceKilled,
    survivors: outcome.survivors,
  };
}

/** One stderr warning per old-run process SIGKILL could not stop. */
function warnSurvivors(
  survivors: ReadonlyArray<ServiceProcess>,
  warn: (message: string) => void,
): void {
  for (const s of survivors) {
    warn(
      `devtrees restart: WARNING — ${s.service}'s old process (pid ${s.pid}, ${s.command}) ` +
        "survived SIGKILL and may still hold its port.",
    );
  }
}

/** What each service `depends_on`, for `SERVICE_PENDING`'s remedy. */
function waitingOn(target: NamedServices): (service: string) => ReadonlyArray<string> {
  const declared = declaredOf(target);
  return (name) => declared.find((s) => s.name === name)?.dependsOn.map((d) => d.name) ?? [];
}

/** The instance's isolated services, as its derived config declares them. */
function declaredOf(target: NamedServices) {
  return declaredServices(target.config?.processes as DerivedProcessMap | undefined);
}

/** The `down` + `up` that restarts the whole stack with the namespaces booted now. */
function restartRemedy(target: NamedServices): string {
  const declared = declaredOf(target);
  const present = new Set(target.rows.map((r) => r.name));
  const booted = resolveRunningSelection(declared, present, undefined).namespaces;
  return `devtrees down && ${formatUpCommand(declared, booted)}`;
}

/** What a bare `devtrees restart` points to instead (#225). */
export interface BareRestartRemedy {
  /** The `down` + `up` that restarts the whole instance. */
  readonly remedy: string;
  /**
   * Whether the running namespaces were read. When not, `remedy` boots every
   * namespace the stack declares, the widest boot that brings everything back.
   */
  readonly namespacesRead: boolean;
}

/**
 * The remedy a bare `devtrees restart` (no names) points to (ADR-0009, #225):
 * the `down` + `up` that reboots this worktree's instance with the
 * namespaces it runs now, spelled by `formatUpCommand`.
 *
 * A bare `restart` is refused (`INVALID_ARGS`) because it cannot be done in
 * place: process-compose v1.122.0 exits once its last running process stops,
 * and no way of restarting that last process keeps the instance and the
 * port safely. ADR-0009 records the experiments.
 *
 * Read-only and best-effort: it takes no lock, leaves a stale socket file in
 * place, and never fails, so the refusal never fails with another code. When
 * the running namespaces cannot be read (no running instance, or one that
 * does not answer), the remedy boots every declared namespace, from the
 * instance's derived config or else `devtrees.yaml`: a plain `devtrees up`
 * could drop a booted namespace, or select nothing at all
 * (`NO_SERVICES_SELECTED`) in a stack without a `default` one.
 */
export async function bareRestartRemedy(deps: CommandDeps = {}): Promise<BareRestartRemedy> {
  let declared: ReadonlyArray<Pick<ResolvedService, "namespace">> = [];
  try {
    const { anchor } = resolve(deps);
    const paths = instancePaths(anchor.anchor, anchor.worktreeId);
    const configText = existsSync(paths.configPath)
      ? readFileSync(paths.configPath, "utf8")
      : undefined;
    const fromConfig = declaredServices(derivedProcesses(configText));
    declared = fromConfig.length > 0 ? fromConfig : declaredIsolated(deps, anchor.worktreeRoot);
    if (fromConfig.length === 0) return everyNamespace(declared);
    const live = await socketIsLive(
      paths.socketPath,
      resolveProbe(deps),
      { command: "restart", instance: anchor.worktreeId },
      { readOnly: true },
    );
    if (!live) return everyNamespace(declared);
    const rows = await readStatusesWithin(
      { getServiceStatuses: statusReader(deps, createDriver(deps.driver)) },
      paths.socketPath,
      RESTART_READ_TIMEOUT_MS,
      { notify: () => {}, probe: probeOf(deps) },
    );
    const present = new Set(rows.map((r) => r.name));
    const booted = resolveRunningSelection(fromConfig, present, undefined).namespaces;
    if (booted.length === 0) return everyNamespace(declared);
    return {
      remedy: `devtrees down && ${formatUpCommand(fromConfig, booted)}`,
      namespacesRead: true,
    };
  } catch {
    return everyNamespace(declared);
  }
}

/** The bare-restart remedy that boots every declared namespace. */
function everyNamespace(
  declared: ReadonlyArray<Pick<ResolvedService, "namespace">>,
): BareRestartRemedy {
  return { remedy: `devtrees down && ${formatUpCommand(declared, [])}`, namespacesRead: false };
}

/** The isolated services `devtrees.yaml` declares; none when it cannot be read. */
function declaredIsolated(
  deps: CommandDeps,
  worktreeRoot: string,
): ReadonlyArray<Pick<ResolvedService, "namespace">> {
  try {
    return (deps.readStack ?? loadStack)(worktreeRoot).services.filter(
      (s) => s.tier === "isolated",
    );
  } catch {
    return [];
  }
}

/** The service as the health wait needs it: its name and readiness probe. */
function restartedService(
  target: NamedServices,
  name: string,
): Pick<ResolvedService, "name" | "readinessProbe"> {
  const probe = target.config?.processes[name]?.readiness_probe;
  return probe === undefined ? { name } : { name, readinessProbe: probe };
}

/** `name`'s row from the health wait's last read, in the `ls --json` shape. */
function serviceRow(
  target: NamedServices,
  rows: ReadonlyArray<ServiceStatus> | undefined,
  name: string,
): Service | undefined {
  const row = rows?.find((r) => r.name === name);
  if (row === undefined) return undefined;
  const ports = readDeclaredPorts(target.configPath)[name] ?? {};
  return { name, status: row.status, health: row.health, ports };
}

function restartFailedError(
  target: NamedServices,
  name: string,
  message: string,
  done: ReadonlyArray<string>,
): ServiceStartFailedError {
  const worktreeId = target.anchor.worktreeId;
  // The refused service and the ones after it: those before it were restarted.
  const rest = target.services.filter((s) => !done.includes(s));
  const remedy = `devtrees restart ${rest.join(" ")}`;
  const before =
    done.length > 0
      ? `${done.join(", ")} ${done.length === 1 ? "was" : "were"} restarted before it; the`
      : "The";
  return new ServiceStartFailedError(
    `devtrees restart: process-compose refused to restart '${name}' in '${worktreeId}': ` +
      `${message}. ${before} services after it were not touched, and the worktree ` +
      `instance is still running. Retry with \`${remedy}\`, or read why with ` +
      `\`devtrees logs ${name}\`.`,
    { worktree_id: worktreeId, services: [{ name, message }], remedy },
  );
}

/** Inputs unique to `runLs` — same anchor resolution as the other commands. */
export interface LsDeps {
  /** Working directory to resolve the anchor from. Default: process.cwd(). */
  readonly cwd?: string;
  /** Inject git. Default: runs the real `git` in `cwd`. */
  readonly git?: GitProbe;
  /**
   * Discover instances at the anchor. Default: real socket enumeration via
   * `discoverInstances`. Injected so the command can be unit-tested without
   * touching `<anchor>/devtrees/run/`.
   */
  readonly discover?: (
    anchor: string,
    deps: { getServiceStatuses?: (socketPath: string) => Promise<ServiceStatus[]> },
  ) => Promise<InstanceInfo[]>;
  /**
   * Process-compose driver — used (best-effort) to populate each running
   * instance's `services[]` with live runtime state. Defaults to the real
   * driver so `ls --json` answers "is `worker` healthy?" out of the box;
   * tests stub it.
   */
  readonly driver?: DriverDeps;
  /**
   * Budget for one instance's service read, retries included (#226). Default:
   * `READ_TIMEOUT_MS` (5s). An instance that does not answer within it is
   * listed with its services unknown.
   */
  readonly readTimeoutMs?: number;
  /** Socket probe the bounded read uses after a failed read. Default: `probeSocket`. */
  readonly probeSocket?: (socketPath: string) => Promise<InstanceStatus>;
}

export interface LsResult {
  /** The anchor instances were discovered from — useful for human-readable output. */
  readonly anchor: string;
  readonly instances: ReadonlyArray<InstanceInfo>;
}

/**
 * List every devtrees instance across the repo. Resolves the anchor from `cwd`
 * the same way `up`/`down` do, then defers to the discovery primitive — no
 * domain logic here, just wiring. The result is structured (not pre-formatted)
 * so the CLI shell, JSON output, and future callers (e.g. #9 prune) can
 * consume the same data.
 *
 * `ls` stays lock-free: discovery never writes the allocation registry, and
 * the driver's `getServiceStatuses` call talks to each instance's UDS only —
 * a stale or failing instance does not abort the walk. Each read is bounded
 * (#226): one that does not answer in time lists the instance as
 * `unresponsive` instead of hanging `ls`.
 */
export async function runLs(deps: LsDeps = {}): Promise<LsResult> {
  const { anchor } = resolve(deps);
  const discover = deps.discover ?? discoverInstances;
  const driver = createDriver(deps.driver ?? {});
  const budgetMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  // Each instance's read is bounded like the dry run's (#210, #226): retried
  // while it fails, killed at the deadline. Discovery reads every instance
  // in parallel, so a wedged one costs `ls` one budget, not one per instance.
  const instances = await discover(anchor.anchor, {
    getServiceStatuses: (socketPath) =>
      readStatusesWithin(driver, socketPath, budgetMs, {
        probe: deps.probeSocket ?? defaultProbeSocket,
      }),
  });
  return { anchor: anchor.anchor, instances };
}

/** Inputs unique to `runPrune` — same anchor resolution as the other commands. */
export interface PruneDeps {
  /** Working directory to resolve the anchor from. Default: process.cwd(). */
  readonly cwd?: string;
  /**
   * Inject git. Default: runs the real `git` in `cwd`. Prune additionally
   * calls `git worktree list --porcelain` to enumerate live worktrees —
   * devtrees does not manage git, so this is the authoritative liveness
   * signal (#9 acceptance).
   */
  readonly git?: GitProbe;
  /**
   * Discover instances at the anchor. Default: real socket enumeration via
   * `discoverInstances`. Injected so the command can be unit-tested without
   * touching `<anchor>/devtrees/run/`.
   */
  readonly discover?: (anchor: string) => Promise<InstanceInfo[]>;
  /**
   * Driver for invoking `process-compose down` on a running orphan. Default:
   * real shell-out. Injected so tests can assert on the spawn surface
   * without launching `process-compose`.
   */
  readonly driver?: DriverDeps;
  /**
   * Acquire the allocation-registry lock to delete each orphan's entry under
   * the same read-modify-write semantics `up`/`down` use. Default: real lock
   * under the anchor.
   */
  readonly withRegistryLock?: WithRegistryLock;
  /**
   * Read the allocation registry to reconcile its keys directly against the
   * live worktree id set (issue #142). This is the socket-independent
   * complement to socket-keyed discovery: a worktree taken `down` and then
   * `git worktree remove`d leaves no socket, so its reservation is invisible
   * to `discover` — but it still leaks a registry entry and an orphaned
   * derived config. Default: real `readRegistry` under the anchor.
   */
  readonly readRegistry?: (anchor: string) => RegistrySnapshot;
  /**
   * Run an orphan's derived `shutdown.command`(s) directly — socket-free, from
   * a cwd that exists (the anchor) — to reap its out-of-band resources (issue
   * #148). The graceful `process-compose down` cannot fire the hook once `git
   * worktree remove` has deleted the worktree's `working_dir`, so devtrees runs
   * it itself. Default: the real `reapShutdownHooks`. Injected so tests can
   * observe the reap surface without spawning a shell.
   */
  readonly reap?: Reaper;
  /** Seams and budgets for the bounded orphan stop (#190); see `CommandDeps.stop`. */
  readonly stop?: StopSeams;
}

/** Type of the orphan-reap collaborator `runPrune`/`runDown` inject (issue #148). */
export type Reaper = (config: DerivedConfig, deps: ReapDeps) => Promise<ReapOutcome>;

/**
 * A reap that failed for at least one of an orphan's shutdown hooks (issue
 * #148). Surfaced so `prune`/`down` report that out-of-band resources may
 * survive rather than claiming a clean teardown (acceptance #5). The reap is
 * the author's `shutdown.command`; devtrees only knows its exit status.
 */
export interface ReapWarning {
  readonly orphanId: string;
  /** Absolute path the orphan was anchored at, for the operator's context. */
  readonly worktreePath: string;
  readonly failures: ReadonlyArray<{
    readonly process: string;
    readonly command: string;
    readonly reason: "launch" | "exit" | "timeout";
    readonly message?: string;
  }>;
}

/**
 * One reconciled-away orphan as `runPrune` reports it (issue #48). Identity
 * plus the worktree path the orphan was anchored at — no status, no ports,
 * no services, no block_base (all of which described pre-prune state that
 * no longer exists once the orphan is gone). The CLI's human renderer
 * still wants `status` for the "was running"/"was stale" prose, so it's
 * retained on the in-process type and dropped on its way through
 * `formatPrune`'s JSON path.
 */
export interface PrunedOrphan {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  /** Prior status at discovery — used by the human renderer only. */
  readonly status: "running" | "stale" | "unknown";
  /**
   * Absolute path of the worktree the orphan was anchored at, recovered from
   * the orphan's derived config (`working_dir`) before cleanup. Empty when
   * the derived config was missing or unreadable — the JSON envelope still
   * emits the field so the shape stays stable.
   */
  readonly worktreePath: string;
  /** Service processes devtrees had to SIGKILL to stop the orphan (#190). */
  readonly forceKilled?: ReadonlyArray<ForceKilled>;
}

export interface PruneResult {
  readonly anchor: string;
  /** The orphans that were stopped + cleaned. Source order from discovery. */
  readonly pruned: ReadonlyArray<PrunedOrphan>;
  /**
   * Orphans whose `shutdown.command` reap failed (issue #148) — out-of-band
   * resources may have survived. Empty on a clean sweep. The orphan is still
   * listed in `pruned` (on-disk state is reclaimed regardless), but this list
   * tells an agent/operator the reap itself did not cleanly complete.
   */
  readonly warnings: ReadonlyArray<ReapWarning>;
  /**
   * Orphans prune could NOT reclaim (issue #186): their liveness was unknown
   * (a possibly-live process-compose that did not answer the probe) and the
   * graceful `process-compose down` failed — or their bounded `down` timed
   * out with process-compose still running (`DOWN_TIMEOUT`, issue #190),
   * whatever their liveness. Their socket, derived config and
   * registry entry are all kept so the instance stays visible to `ls` and a
   * later `prune` can retry; unlinking the socket would orphan a live
   * supervisor on its ports. Never listed in `pruned`.
   */
  readonly unreclaimed: ReadonlyArray<UnreclaimedOrphan>;
}

/** An orphan `prune` left in place because it could not stop it (#186). */
export interface UnreclaimedOrphan {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  readonly worktreePath: string;
  readonly socketPath: string;
  /** Why the graceful `process-compose down` failed. */
  readonly message: string;
  /** Service processes devtrees SIGKILLed before the stop timed out (#190). */
  readonly forceKilled?: ReadonlyArray<ForceKilled>;
}

/**
 * Reconcile devtrees' notion of running instances against `git worktree list`
 * and reclaim any orphan state.
 *
 * Devtrees does not manage git worktrees (CONTEXT.md "Devtrees"); when a
 * developer runs `git worktree remove` while the stack is still up, the
 * instance's anchor state survives unnoticed. `runPrune` walks the discovered
 * instances, treats any worktree-kind instance whose worktree dir is no
 * longer in `git worktree list` as an orphan, and cleans it up:
 *
 *   1. If the orphan is still running, ask the driver to stop it. Errors are
 *      swallowed — the whole point of prune is to reclaim stale state, and a
 *      `process-compose down` against a half-dead socket must not abort the
 *      sweep over other orphans.
 *   2. Remove the orphan's control socket and derived config from the anchor
 *      state.
 *   3. Drop the orphan's allocation-registry entry under the registry lock.
 *
 * Exception (#186): an orphan whose liveness was `unknown` and whose `down`
 * failed is left entirely in place (socket, config, registry entry) and
 * reported in `unreclaimed`, never in `pruned`. So is any orphan whose
 * bounded `down` timed out with process-compose still running (#190).
 *
 * The shared instance is never an orphan: it is anchored at the git common
 * dir, not at any single worktree, and its lifecycle is decoupled from any
 * worktree's `down` (ADR-0001). Tear it down explicitly with `down --shared`.
 */
export async function runPrune(deps: PruneDeps = {}): Promise<PruneResult> {
  const cwd = deps.cwd ?? process.cwd();
  const git = deps.git ?? defaultGit(cwd);
  const anchor = resolveAnchor(cwd, git);
  const discover = deps.discover ?? discoverInstances;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const readReg = deps.readRegistry ?? readRegistry;
  const driver = createDriver(deps.driver);
  const reap = deps.reap ?? reapShutdownHooks;

  const instances = await discover(anchor.anchor);
  const porcelain = git(["worktree", "list", "--porcelain"]);
  const liveIds = parseWorktreeIds(porcelain);
  const socketOrphans = findOrphans(instances, liveIds);

  // Socket-independent reconciliation (issue #142): a worktree taken `down`
  // then `git worktree remove`d leaves no socket, so `discover` can't see it —
  // but its registry reservation and derived config leak. `findDeadReservations`
  // reconciles the registry keys directly against the live worktree set
  // (skipping ids already found via socket so a double-keyed orphan is
  // reported once). Each dead reservation becomes an identity-only synthetic
  // orphan so it flows through the same cleanup + reporting path below.
  const discoveredIds = new Set(socketOrphans.map((o) => o.id));
  const deadReservations = findDeadReservations(
    Object.keys(readReg(anchor.anchor)),
    liveIds,
    discoveredIds,
  ).map<InstanceInfo>((id) => ({
    id,
    kind: "worktree",
    // No live process backs a dead reservation — identity only.
    status: "stale",
    socketPath: instancePaths(anchor.anchor, id).socketPath,
    ports: {},
    blockBase: undefined,
    services: [],
  }));

  const orphans = [...socketOrphans, ...deadReservations];
  if (orphans.length === 0) {
    return { anchor: anchor.anchor, pruned: [], warnings: [], unreclaimed: [] };
  }

  // Capture identity-only metadata for each orphan *before* tearing down its
  // derived config — `worktreePath` is recovered from the on-disk YAML and
  // is unrecoverable once we remove it (issue #48 acceptance).
  const reported: PrunedOrphan[] = orphans.map((orphan) => ({
    id: orphan.id,
    kind: orphan.kind,
    status: orphan.status,
    worktreePath: readWorktreePath(instancePaths(anchor.anchor, orphan.id).configPath),
  }));

  const warnings: ReapWarning[] = [];
  const unreclaimed: UnreclaimedOrphan[] = [];
  const forceKilled = new Map<string, ReadonlyArray<ForceKilled>>();
  for (const [i, orphan] of orphans.entries()) {
    const outcome = await reapAndCleanupOrphan(orphan, anchor.anchor, reap, driver, deps.stop);
    if (outcome.warning !== undefined) warnings.push(outcome.warning);
    forceKilled.set(orphan.id, outcome.forceKilled);
    if (outcome.downFailure !== undefined) {
      unreclaimed.push({
        id: orphan.id,
        kind: orphan.kind,
        worktreePath: reported[i]?.worktreePath ?? "",
        socketPath: orphan.socketPath,
        message: outcome.downFailure,
        forceKilled: outcome.forceKilled,
      });
    }
  }
  const keptIds = new Set(unreclaimed.map((u) => u.id));
  const reclaimed = orphans.filter((o) => !keptIds.has(o.id));

  // Drop every reclaimed orphan's registry entry under one lock acquire so
  // concurrent `up`s can re-use the freed block bases. An unreclaimed one
  // keeps its entry: its supervisor may still hold those ports (#186).
  await lock(anchor.anchor, (snapshot) => {
    let next = snapshot;
    let changed = false;
    for (const orphan of reclaimed) {
      if (next[orphan.id] !== undefined) {
        const { [orphan.id]: _drop, ...rest } = next;
        void _drop;
        next = rest;
        changed = true;
      }
    }
    return changed ? next : snapshot;
  });

  return {
    anchor: anchor.anchor,
    pruned: reported
      .filter((r) => !keptIds.has(r.id))
      .map((r) => ({ ...r, forceKilled: forceKilled.get(r.id) ?? [] })),
    warnings,
    unreclaimed,
  };
}

/**
 * Reap one orphan's out-of-band resources, stop its supervisor if live, and
 * clear its on-disk state (issue #148). Factored out of `runPrune`'s loop so
 * the orchestrator stays under the complexity gate. `warning` is set when the
 * reap failed. `downFailure` is set when the orphan's liveness was `unknown`
 * and the graceful `down` failed (#186): its on-disk state is then left in
 * place rather than unlinking the socket of a possibly-live supervisor.
 *
 * The reap runs each derived `shutdown.command` ourselves, socket-free, from
 * the anchor — a directory that still exists — instead of relying on
 * `process-compose down`'s graceful path, which cannot launch the hook once
 * `git worktree remove` deleted the `working_dir`. Done for BOTH a live and a
 * stale supervisor (acceptance #1/#2). The config is read BEFORE deletion: the
 * author's hook removes the `.project` record, so a surviving record proves it
 * never ran (acceptance #3).
 */
async function reapAndCleanupOrphan(
  orphan: InstanceInfo,
  anchor: string,
  reap: Reaper,
  driver: ReturnType<typeof createDriver>,
  seams: StopSeams | undefined,
): Promise<{
  warning?: ReapWarning;
  downFailure?: string;
  forceKilled: ReadonlyArray<ForceKilled>;
}> {
  const paths = instancePaths(anchor, orphan.id);
  // Use the socket path discovery actually found, not the canonical one: an
  // instance started before #156 still has its socket in the old
  // `<anchor>/devtrees/run` dir, and prune is exactly the path that has to be
  // able to reclaim it.
  const socketPath = orphan.socketPath;
  const warning = await reapDerivedConfig(paths.configPath, orphan.id, anchor, reap);
  const stop = await stopOrphanSupervisor(
    orphan,
    paths.configPath,
    driver,
    seams,
    readPendingReload(anchor, orphan.id),
  );
  const reapPart = warning === undefined ? {} : { warning };
  // An `unknown` orphan (#186) whose `down` failed may still be a live
  // supervisor, and one whose bounded `down` timed out (#190) certainly is:
  // keep its socket and config so it stays visible and a later prune can
  // retry, instead of recreating the invisible orphan.
  if (stop.failure !== undefined && (orphan.status === "unknown" || stop.failure.timedOut)) {
    return { ...reapPart, downFailure: stop.failure.message, forceKilled: stop.forceKilled };
  }
  // Remove the socket file (driver.down typically removes it on a clean exit,
  // but stale/failed orphans need explicit cleanup) and the derived config.
  rmSync(socketPath, { force: true });
  rmSync(paths.configPath, { force: true });
  clearPendingReload(anchor, orphan.id);
  return { ...reapPart, forceKilled: stop.forceKilled };
}

/**
 * Stop a possibly-live orphan's supervisor with the bounded `down` (#190)
 * over its socket. The direct hook run in `reapAndCleanupOrphan` IS the reap;
 * this just reclaims the process-compose. An `unknown` orphan (#186) gets the
 * same attempt a running one does; a stale one has nothing to stop.
 * Best-effort: returns the failure rather than throwing, so one half-dead
 * orphan never aborts the sweep. `timedOut` marks a `DOWN_TIMEOUT`: the
 * supervisor is known to be still running.
 */
async function stopOrphanSupervisor(
  orphan: InstanceInfo,
  configPath: string,
  driver: ReturnType<typeof createDriver>,
  seams: StopSeams | undefined,
  pendingReload: PendingReload | undefined,
): Promise<{
  forceKilled: ReadonlyArray<ForceKilled>;
  failure?: { readonly message: string; readonly timedOut: boolean };
}> {
  if (orphan.status === "stale") return { forceKilled: [] };
  try {
    const paths = { configPath, socketPath: orphan.socketPath };
    return await stopInstance(driver, paths, orphan.id, "prune", seams, pendingReload);
  } catch (err) {
    if (err instanceof DownTimeoutError) {
      return {
        forceKilled: err.details.force_killed,
        failure: { message: err.message, timedOut: true },
      };
    }
    return {
      forceKilled: [],
      failure: { message: err instanceof Error ? err.message : String(err), timedOut: false },
    };
  }
}

/**
 * Read a torn-down instance's derived config and run its `shutdown.command`(s)
 * directly from the anchor (issue #148). Returns a `ReapWarning` when at least
 * one hook failed (so the caller can reflect it in the structured result —
 * acceptance #5), else `undefined`. A missing/unparsable config (nothing to
 * reap) yields `undefined`. Shared by `runPrune` and `runDown`'s dead-supervisor
 * path so both reap identically.
 */
async function reapDerivedConfig(
  configPath: string,
  orphanId: string,
  anchor: string,
  reap: Reaper,
): Promise<ReapWarning | undefined> {
  const config = readDerivedConfig(configPath);
  if (config === undefined) return undefined;
  const outcome = await reap(config, { cwd: anchor });
  if (outcome.failures.length === 0) return undefined;
  return { orphanId, worktreePath: readWorktreePath(configPath), failures: outcome.failures };
}

/**
 * Read and parse an orphan's full derived process-compose config from disk
 * (issue #148). Returns `undefined` when the file is missing or unparsable —
 * an orphan with no on-disk config has no `shutdown.command` to run, so the
 * reaper has nothing to do. Best-effort, like `readWorktreePath`: a malformed
 * config must not abort the sweep.
 */
function readDerivedConfig(configPath: string): DerivedConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const doc = parseYaml(readFileSync(configPath, "utf8")) as DerivedConfig | null;
    if (doc === null || typeof doc !== "object" || typeof doc.processes !== "object") {
      return undefined;
    }
    return doc;
  } catch {
    return undefined;
  }
}

/**
 * Recover the `working_dir` of the first process in a derived process-compose
 * config — devtrees always pins this to the worktree root at `up` time, so
 * the path is the orphan's last-known anchor location. Returns "" when the
 * file is missing or unparsable; `runPrune` still emits the field so the
 * envelope shape stays stable.
 */
function readWorktreePath(configPath: string): string {
  if (!existsSync(configPath)) return "";
  try {
    const doc = (parseYaml(readFileSync(configPath, "utf8")) ?? {}) as {
      processes?: Record<string, { working_dir?: unknown }>;
    };
    for (const proc of Object.values(doc.processes ?? {})) {
      if (typeof proc.working_dir === "string" && proc.working_dir !== "") {
        return proc.working_dir;
      }
    }
  } catch {
    // Best-effort: a malformed config can't block the sweep.
  }
  return "";
}

export interface EnvResult {
  readonly worktreeId: string;
  /**
   * The injected-value map the worktree instance would receive — same shape
   * `runUp` produces. Computed without spawning, locking, or persisting
   * (issue #32 "Pure read").
   */
  readonly env: Record<string, string>;
}

/**
 * Emit the injected-value map for this worktree without starting anything,
 * without acquiring the allocation-registry lock, and without writing.
 *
 * The map is exactly what the config deriver would inject (CONTEXT.md
 * "Injected value"): this worktree's named ports + the shared services' named
 * ports + the worktree id. The registry is read directly (no lock). When the
 * worktree (or shared) entry is absent, the allocator's deterministic
 * hash-and-probe yields the "would-be" block against the read snapshot — the
 * same answer a follow-up `up` would persist, barring a concurrent allocation
 * (the racy edge case the spec explicitly accepts).
 */
export async function runEnv(deps: CommandDeps = {}): Promise<EnvResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  const readReg = deps.readRegistry ?? readRegistry;

  const stack = readStack(anchor.worktreeRoot);
  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);
  const sharedNeeded = hasTier(stack, "shared");

  // Pure read — no lock. If the registry has no entry for this worktree (or
  // shared), `allocateBlock` returns what a future `up` would pick against
  // this snapshot. No write happens here.
  const snapshot = readReg(anchor.anchor);
  const block = await allocateBlock(anchor.worktreeId, snapshot, options, isPortFree);
  const sharedBlock = sharedNeeded
    ? await allocateBlock(SHARED_REGISTRY_KEY, snapshot, options, isPortFree)
    : undefined;

  const { portFor, sharedPortFor } = namedPortResolvers(
    stack,
    options,
    block.base,
    sharedBlock?.base,
  );

  // Shared ports come from the running instance, not positional offsets
  // (issue #83): when the shared socket is live and a persisted map exists,
  // report the numbers the instance actually bound — and fail with
  // SHARED_DRIFT when this worktree's shared subset diverges, exactly as
  // `up` would, instead of reporting connection info that is wrong. With no
  // running instance, a future `up` would lazy-start shared from THIS
  // worktree's stack, so the positional computation is the right prediction.
  let effectiveSharedPortFor = sharedPortFor;
  if (sharedNeeded && existsSync(sharedInstancePaths(anchor.anchor).socketPath)) {
    const state = readSharedState(anchor.anchor);
    if (state !== undefined) {
      assertSharedSubsetMatches(stack, state, anchor.worktreeId);
      const ports = state.ports;
      effectiveSharedPortFor = (name) => ports[name];
    }
  }

  const derived = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    anchor: anchor.anchor,
    portFor,
    sharedPortFor: effectiveSharedPortFor,
  });

  return { worktreeId: anchor.worktreeId, env: derived.env };
}

/** Inputs unique to `runInit` — just the directory to write the block into. */
export interface InitDeps {
  /**
   * Directory of the consuming repo to write the agent-instructions file into.
   * Default: `process.cwd()`. `init --agents` writes into the project the agent
   * is driving — no anchor / git resolution, since the block is repo-agnostic.
   */
  readonly cwd?: string;
}

/**
 * Result of `runInit` — what file the block landed in and whether it already
 * existed (issue #118). `target` is the bare filename (`AGENTS.md` /
 * `CLAUDE.md`) the CLI envelope names; `path` is its absolute location;
 * `action` distinguishes a freshly-created file from an in-place update of an
 * existing one, which the `--json` envelope surfaces as created-vs-updated.
 */
export interface InitResult {
  /** The chosen target filename — `AGENTS.md` or `CLAUDE.md`. */
  readonly target: string;
  /** Absolute path of the file written. */
  readonly path: string;
  /** `created` when the file did not exist before this run; `updated` otherwise. */
  readonly action: "created" | "updated";
}

/**
 * Write the canonical coding-agent onboarding block into the consuming repo's
 * agent-instructions file (issue #118).
 *
 * Target detection (acceptance): an existing `AGENTS.md` wins, else an existing
 * `CLAUDE.md`, else `AGENTS.md` is created. The block is written between the
 * `<!-- devtrees:start -->` / `<!-- devtrees:end -->` markers via `upsertBlock`,
 * so re-running replaces the managed region in place — never duplicating or
 * appending it twice — while leaving any surrounding hand-written content
 * untouched.
 *
 * The block text comes from `ONBOARDING_BLOCK` (src/onboarding.ts), the single
 * source of truth the README also quotes — so the generated file and the README
 * cannot drift (pinned by `onboarding.test.ts`). Pure I/O: no anchor, no lock,
 * no spawn.
 */
export async function runInit(deps: InitDeps = {}): Promise<InitResult> {
  const cwd = deps.cwd ?? process.cwd();

  // Prefer the first candidate that already exists; otherwise create the first
  // candidate (AGENTS.md). `action` reflects whether we created or updated it.
  const existing = TARGET_CANDIDATES.find((name) => existsSync(join(cwd, name)));
  const target = existing ?? TARGET_CANDIDATES[0];
  const path = join(cwd, target);
  const action: InitResult["action"] = existing === undefined ? "created" : "updated";

  const current = existing === undefined ? "" : readFileSync(path, "utf8");
  writeFileSync(path, upsertBlock(current, fencedBlock()), "utf8");

  return { target, path, action };
}

/**
 * Options governing a `devtrees logs` call. The single-service form passes
 * `service`; `--all` (interleave every service in the instance) sets `all`.
 * `--shared` flips socket selection from the worktree instance to the shared
 * one. `follow` and `tail` thread straight through to the driver; `sinceMs`
 * is applied as a client-side filter on the merged event stream (issue #88).
 */
export interface LogsOptions {
  /** Name of one service to stream. Mutually exclusive with `all`. */
  readonly service?: string;
  /** Interleave every service in the target instance. Reads the derived config to enumerate. */
  readonly all?: boolean;
  /** Read the shared instance's socket instead of the worktree's. */
  readonly shared?: boolean;
  /** Keep streaming after the historical buffer drains. */
  readonly follow?: boolean;
  /** Start from the last N lines. */
  readonly tail?: number;
  /**
   * Only emit events from the last `sinceMs` milliseconds. process-compose's
   * `process logs` CLI exposes no `--since` flag, so this is a client-side
   * filter on the driver's `LogEvent.ts` (stamped when each line is read):
   * the cutoff is computed once when `runLogs` is called and older events are
   * dropped. Most useful with `follow`, where the stream spans real time.
   * Must be a finite, non-negative number of milliseconds.
   */
  readonly sinceMs?: number;
}

export interface LogsResult {
  /** Services this call is streaming. One entry for the single-service form; many for `--all`. */
  readonly services: ReadonlyArray<string>;
  /** Merged log stream. Iterating consumes the spawn(s); cancelling the iterator kills the children. */
  readonly events: AsyncIterable<LogEvent>;
}

/**
 * Stream a service's logs from a running instance without taking any lock.
 *
 * Socket selection — `options.shared` flips between this worktree's control
 * socket and the shared instance's. If the target socket is missing, the
 * instance is not running and we throw a clear error here that `classifyError`
 * maps to the `INSTANCE_NOT_FOUND` envelope (ADR-0005). The lock-free path
 * (acceptance, #33) is what lets concurrent agents tail sibling worktrees
 * without serializing on a shared mutex.
 *
 * `--all` enumerates services from the derived config on disk — the same file
 * `devtrees up` writes — so we don't need a process-compose round-trip to list
 * processes. One driver `streamLogs` call per service; their outputs are
 * merged into a single async iterable.
 */
export async function runLogs(
  deps: CommandDeps = {},
  options: LogsOptions = {},
): Promise<LogsResult> {
  if (options.sinceMs !== undefined && (!Number.isFinite(options.sinceMs) || options.sinceMs < 0)) {
    throw new Error(
      `devtrees logs: sinceMs must be a finite, non-negative number of milliseconds, ` +
        `got ${String(options.sinceMs)}.`,
    );
  }

  const { anchor } = resolve(deps);
  const paths = options.shared
    ? sharedInstancePaths(anchor.anchor)
    : instancePaths(anchor.anchor, anchor.worktreeId);

  if (!existsSync(paths.socketPath)) {
    if (options.shared) {
      throw new Error(
        "no shared instance is running. Bring it up implicitly via `devtrees up` " +
          "(when the stack declares shared services) before tailing its logs.",
      );
    }
    throw new Error(
      `no worktree instance is running for '${anchor.worktreeId}'. ` +
        "Run `devtrees up` to bring it up first.",
    );
  }

  const known = readDerivedServices(paths.configPath);
  if (!options.all && options.service !== undefined && !known.includes(options.service)) {
    // Fail fast before spawning: `process-compose process logs <unknown>`
    // blocks forever instead of erroring, which would hang an agent until its
    // own timeout (#109). The derived config on disk is authoritative for the
    // running instance, so an absent name there is a user error, not a race.
    throw serviceNotFoundError(options.service, known, options.shared === true);
  }
  const services = options.all ? known : options.service !== undefined ? [options.service] : [];
  if (services.length === 0) {
    throw new Error("devtrees logs: specify a service (e.g. `devtrees logs web`) or pass `--all`.");
  }

  const driver = createDriver(deps.driver);
  const streams = services.map((service) => {
    const driverOpts: StreamLogsOptions = {
      service,
      follow: options.follow,
      tail: options.tail,
    };
    return driver.streamLogs(paths.socketPath, driverOpts);
  });

  const merged = mergeAsyncIterables(streams);
  const events =
    options.sinceMs !== undefined
      ? filterLogEventsSince(merged, Date.now() - options.sinceMs)
      : merged;

  return { services, events };
}

/**
 * Drop log events whose `ts` is strictly older than `cutoffMs` (epoch ms).
 * Client-side stand-in for a `--since` flag process-compose does not offer
 * (issue #88). Events whose `ts` fails to parse are kept — a malformed
 * timestamp must never silently swallow a log line.
 */
export async function* filterLogEventsSince(
  events: AsyncIterable<LogEvent>,
  cutoffMs: number,
): AsyncIterable<LogEvent> {
  for await (const event of events) {
    const ts = Date.parse(event.ts);
    if (Number.isNaN(ts) || ts >= cutoffMs) yield event;
  }
}

/**
 * Build the documented `SERVICE_NOT_FOUND` error (#109): tagged with the
 * stable code so `classifyError` routes it into the JSON envelope, and
 * carrying `{service, valid_services}` details so an agent can correct the
 * name without a second round-trip. Mirrors the `invalidArgsError` /
 * `StalePortBlockError` tagging convention.
 */
function serviceNotFoundError(
  service: string,
  validServices: ReadonlyArray<string>,
  shared: boolean,
  /** The per-service verb raising it (#223); `logs` keeps its historical text. */
  command?: NamedServiceCommand,
): Error {
  const where = shared ? "the shared instance" : "this worktree's instance";
  const valid =
    validServices.length > 0
      ? `Valid services: ${validServices.join(", ")}.`
      : "Its derived config lists no services.";
  const prefix = command === undefined ? "" : `devtrees ${command}: `;
  const err = new Error(`${prefix}unknown service '${service}' in ${where}. ${valid}`) as Error & {
    code?: string;
    details?: Readonly<Record<string, unknown>>;
  };
  err.code = "SERVICE_NOT_FOUND";
  err.details = { service, valid_services: [...validServices] };
  return err;
}

/** The verbs that act on named services of this worktree's instance (ADR-0009). */
type NamedServiceCommand = "restart";

/** What `resolveNamedServices` hands a per-service verb. */
interface NamedServices {
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly socketPath: string;
  readonly configPath: string;
  /** The running instance's derived config, the source of the declared services. */
  readonly config: DerivedConfig | undefined;
  /** The named isolated services, in `depends_on` order, each in the running project. */
  readonly services: ReadonlyArray<string>;
  /** The `process list` read the checks were made against. */
  readonly rows: ServiceStatus[];
  /** Shared services in a `-n` namespace (#224): skipped, for the verb to report. */
  readonly skippedShared: ReadonlyArray<string>;
}

/**
 * Resolve the services a per-service verb names (ADR-0009). Every check runs
 * before anything is touched, in this order:
 *
 *  1. no running worktree instance fails `INSTANCE_NOT_FOUND` (liveness is
 *     probed, as on every write path, #80; unknown liveness fails
 *     `INSTANCE_UNRESPONSIVE`, #186);
 *  2. the declared services are the running instance's derived config, not
 *     `devtrees.yaml`, which may have changed since;
 *  3. a shared service (from `devtrees.yaml`, tolerated when broken, and the
 *     shared derived config) fails `SHARED_SERVICE_REFUSED`
 *     (`details: {services, remedy}`);
 *  4. an unknown name fails `SERVICE_NOT_FOUND` (`details: {service,
 *     valid_services[]}`, as for `logs`, listing the derived config's
 *     services);
 *  5. a hot-reload still pending (#191, #206) fails `CONFIG_DRIFT` with
 *     `reason: reload_pending`, exactly as `up` refuses: the pending update
 *     would start the new copy and undo the verb;
 *  6. a declared service the instance did not boot (its namespace was not
 *     selected) fails `NAMESPACE_NOT_RUNNING`, as `up -n` does (ADR-0008),
 *     `details: {worktree_id, namespaces, services, remedy}`.
 *
 * `namespaces` (`-n`, #224) adds every isolated service of each namespace to
 * `names` (`expandNamespaces`, against the derived config); every check above
 * then applies to the union. Between checks 4 and 5, a namespace with no
 * isolated service fails `NO_SERVICES_SELECTED`. Shared services in the
 * namespaces are not added: they are returned in `skippedShared`.
 *
 * Returns the named services in `depends_on` order, with the rows. Takes no
 * lock: the caller holds this worktree's lifecycle lock around it and the
 * action, so a concurrent `down` cannot stop the instance in between.
 */
async function resolveNamedServices(
  deps: CommandDeps,
  named: ReadonlyArray<string>,
  command: NamedServiceCommand,
  namespaces: ReadonlyArray<string> = [],
): Promise<NamedServices> {
  const { anchor } = resolve(deps);
  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  const retry = namedServicesInvocation(command, named, namespaces);
  const live = await socketIsLive(paths.socketPath, resolveProbe(deps), {
    command,
    instance: anchor.worktreeId,
    retry,
  });
  if (!live) throw instanceNotRunningError(command, anchor.worktreeId);
  const configText = existsSync(paths.configPath)
    ? readFileSync(paths.configPath, "utf8")
    : undefined;
  const processes = derivedProcesses(configText);
  const declared = declaredServices(processes);
  const { names, skippedShared } = checkedSelection(
    deps,
    anchor,
    declared,
    { named, namespaces },
    command,
  );
  const rows = await readStatusesWithin(
    { getServiceStatuses: statusReader(deps, createDriver(deps.driver)) },
    paths.socketPath,
    Math.min(deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, READ_TIMEOUT_MS),
    { notify: deps.warn ?? defaultWarn, probe: probeOf(deps) },
  );
  assertNoPendingReload({
    anchor,
    marker: readPendingReload(anchor.anchor, anchor.worktreeId),
    rows,
    previous: processes,
    isolated: declared,
    requested: [],
    isAlive: deps.isProcessAlive ?? isProcessAlive,
    command,
    retry,
  });
  const targets = orderedTargets(declared, names);
  const present = new Set(rows.map((r) => r.name));
  const missing = unbootedServices(targets, present);
  if (missing.length > 0) {
    const booted = resolveRunningSelection(declared, present, undefined).namespaces;
    const notRunning = notBootedNamespaces(missing);
    throw namespaceNotRunningError(
      anchor.worktreeId,
      notRunning,
      [...booted, ...notRunning.map((n) => n.namespace)],
      command,
      declared,
    );
  }
  return {
    anchor: { anchor: anchor.anchor, worktreeId: anchor.worktreeId },
    socketPath: paths.socketPath,
    configPath: paths.configPath,
    config: readDerivedConfig(paths.configPath),
    services: targets.map((s) => s.name),
    rows,
    skippedShared,
  };
}

/**
 * Checks 3 and 4 of `resolveNamedServices` on the named services, then the
 * `-n` expansion (#224): a namespace with no isolated service fails
 * `NO_SERVICES_SELECTED`. Returns the union of the names and the expansion,
 * each once, and the shared services the expansion skipped.
 */
function checkedSelection(
  deps: CommandDeps,
  anchor: { readonly anchor: string; readonly worktreeId: string; readonly worktreeRoot: string },
  declared: ReadonlyArray<DeclaredService>,
  selection: { readonly named: ReadonlyArray<string>; readonly namespaces: ReadonlyArray<string> },
  command: NamedServiceCommand,
): { names: string[]; skippedShared: ReadonlyArray<string> } {
  const { named, namespaces } = selection;
  const repoShared = sharedServices(deps, anchor);
  const shared = sharedAmong(
    repoShared.map((s) => s.name),
    declared,
    named,
  );
  if (shared.length > 0) throw sharedServiceRefusedError(shared, command);
  const unknown = unknownService(declared, named);
  if (unknown !== undefined) {
    throw serviceNotFoundError(
      unknown,
      declared.map((s) => s.name),
      false,
      command,
    );
  }
  const expansion = expandNamespaces(declared, repoShared, namespaces);
  if (expansion.empty.length > 0) {
    throw new NoServicesSelectedError(
      anchor.worktreeId,
      declaredNamespaces(declared),
      expansion.empty,
      true,
      command,
    );
  }
  return {
    names: [...new Set([...named, ...expansion.services])],
    skippedShared: expansion.skippedShared,
  };
}

/** The command line a per-service verb was run as, for retry and remedy text. */
function namedServicesInvocation(
  command: NamedServiceCommand,
  names: ReadonlyArray<string>,
  namespaces: ReadonlyArray<string> = [],
): string {
  const flags = [...new Set(namespaces)].map((ns) => `-n ${ns}`);
  return [`devtrees ${command}`, ...new Set(names), ...flags].join(" ");
}

/**
 * The repo's shared services, with their namespaces, so a per-service verb
 * can refuse them by name and skip them in a `-n` expansion (#224): from
 * `devtrees.yaml`, and from the shared instance's derived config.
 * Best-effort: a broken `devtrees.yaml` adds none, and must not block a
 * command on a running instance.
 */
function sharedServices(
  deps: CommandDeps,
  anchor: { readonly anchor: string; readonly worktreeRoot: string },
): Array<Pick<ResolvedService, "name" | "namespace">> {
  const fromConfig = declaredServices(
    readDerivedConfig(sharedInstancePaths(anchor.anchor).configPath)?.processes as
      | DerivedProcessMap
      | undefined,
  );
  let fromStack: Array<Pick<ResolvedService, "name" | "namespace">> = [];
  try {
    const stack = (deps.readStack ?? loadStack)(anchor.worktreeRoot);
    fromStack = stack.services.filter((s) => s.tier === "shared");
  } catch {
    // The shared derived config still names them.
  }
  return [...fromStack, ...fromConfig];
}

/**
 * Thrown when a per-service verb names a shared service (ADR-0009). The
 * shared instance serves every worktree, so a worktree's command never stops
 * or restarts one of its processes (ADR-0001, ADR-0008). Nothing is touched;
 * `details.remedy` is the repo-wide way to bounce it, which affects every
 * worktree.
 */
class SharedServiceRefusedError extends Error {
  readonly code = "SHARED_SERVICE_REFUSED" as const;
  constructor(
    message: string,
    readonly details: {
      readonly services: ReadonlyArray<string>;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "SharedServiceRefusedError";
  }
}

function sharedServiceRefusedError(
  services: ReadonlyArray<string>,
  command: NamedServiceCommand,
): SharedServiceRefusedError {
  const remedy = "devtrees down --shared && devtrees up";
  const quoted = services.map((s) => `'${s}'`).join(", ");
  const one = services.length === 1;
  return new SharedServiceRefusedError(
    `devtrees ${command}: ${quoted} ${one ? "is a shared service" : "are shared services"}. ` +
      `The shared instance serves every worktree, so devtrees does not ${command} its ` +
      `services from a worktree. Nothing was touched. \`${remedy}\` restarts the shared ` +
      `instance, for every worktree.`,
    { services, remedy },
  );
}

/**
 * Read the derived process-compose config from disk and return its service
 * names in source order. Used by `--all` to know which services to spawn a
 * `process logs` subprocess for, and by the single-service path to validate
 * the name before streaming (#109). The config is the same file `devtrees up`
 * writes, so the list is authoritative for the running instance.
 */
function readDerivedServices(configPath: string): string[] {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as { processes?: Record<string, unknown> } | null;
    if (parsed === null || typeof parsed !== "object") return [];
    return Object.keys(parsed.processes ?? {});
  } catch {
    // Treat any read/parse failure as "no services known"; the caller errors
    // with a usage hint via the empty-services check above.
    return [];
  }
}

/** Remediation for a reload process-compose refused: the instance is untouched. */
const RELOAD_FAILED_REMEDIATION =
  ". The instance is still running — run `devtrees down && devtrees up` to apply the new config.";

/**
 * A timed-out reload means process-compose is still waiting for an old
 * process to exit. `down` force-kills that process before stopping, since
 * the pending-reload marker records it (#206). Killing it unblocks
 * process-compose, which then finishes applying the new config. A second
 * reload before then would start a new copy next to the old process, and
 * the pending update would later start another one, orphaning the first
 * copy; `up` therefore refuses with `reload_pending` until then (#191).
 */
const RELOAD_TIMEOUT_REMEDIATION =
  ". The instance is still running, but process-compose stays blocked until the old " +
  "process exits (`devtrees down` force-kills it before stopping). Kill the " +
  "service's old process to let the reload finish, then run `devtrees up` again to " +
  "resync the on-disk config and stored hash; until that process has exited, " +
  "`devtrees up` refuses with `reload_pending` instead of reloading again (a second reload would start an untracked " +
  "copy of the service). To prevent this, give the service a `shutdown.command` that really " +
  "stops the process; `shutdown.timeout_seconds` does not help when a `shutdown.command` " +
  "exits 0 without stopping it (it only bounds the command itself, and only the plain " +
  "SIGTERM path escalates to SIGKILL after it).";

/**
 * Config drift step for a `runUp` whose worktree instance is already
 * running. Runs inside the lifecycle lock; `verifyRunning` checks the
 * instance afterwards. Outcomes:
 *
 *  - **Reload pending** (#191) -> a previous reload is still waiting on an
 *    old process (`assertNoPendingReload`): throw `ConfigDriftError` with
 *    `reason: "reload_pending"` before touching anything. Checked whenever a
 *    marker exists, and on every drift.
 *  - **Matching hash** -> noop: skip `driver.up`, the reload and the
 *    registry write.
 *  - **Drift** -> write the new derived config and call `driver.reloadConfig`.
 *    On success, persist the new hash; on any
 *    failure, restore the previous on-disk config (issue #92 — the file must
 *    keep matching the still-running instance, `ls` reads ports from it) and
 *    throw `ConfigDriftError` so the CLI emits the `CONFIG_DRIFT` envelope
 *    and the instance keeps running (ADR-0005). A timeout also persists the
 *    pending-reload marker, from the `process list` snapshot taken before
 *    the reload.
 */
async function reconcileRunning(args: {
  readonly stack: ResolvedStack;
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly paths: {
    readonly configPath: string;
    readonly socketPath: string;
  };
  readonly derived: ReturnType<typeof deriveWorktreeConfig>;
  readonly inst: { readonly configPath: string; readonly socketPath: string };
  readonly driver: ReturnType<typeof createDriver>;
  readonly deps: CommandDeps;
  readonly readHash: (anchor: string, id: string) => string | undefined;
  readonly writeHash: (anchor: string, id: string, hash: string) => void;
}): Promise<void> {
  const { anchor, paths } = args;
  const currentHash = stackHash(args.stack);
  const drift = args.readHash(anchor.anchor, anchor.worktreeId) !== currentHash;
  const marker = readPendingReload(anchor.anchor, anchor.worktreeId);
  if (!drift && marker === undefined) return;
  // The on-disk derived config must always describe the *running* instance
  // (issue #92) — `ls` reads its ports from this file. `driver.reloadConfig`
  // re-reads the config from disk, so the new one has to be written before
  // the attempt; snapshot the old bytes first and restore them on failure
  // so a failed reload never leaves the file describing config the instance
  // is not running.
  mkdirSync(dirname(paths.configPath), { recursive: true });
  const previousConfig = existsSync(paths.configPath)
    ? readFileSync(paths.configPath, "utf8")
    : undefined;
  // One bounded read; it doubles as the pre-reload snapshot the marker's old
  // PIDs come from. A failed read is `undefined`, not evidence of anything.
  const rows = await statusReader(args.deps, args.driver)(paths.socketPath, {
    timeoutMs: READ_TIMEOUT_MS,
  }).catch(() => undefined);
  const converged = assertNoPendingReload({
    anchor,
    marker,
    rows,
    previous: derivedProcesses(previousConfig),
    isolated: args.stack.services.filter((s) => s.tier === "isolated"),
    requested: args.deps.namespaces ?? [],
    isAlive: args.deps.isProcessAlive ?? isProcessAlive,
  });
  if (converged) clearPendingReload(anchor.anchor, anchor.worktreeId);
  if (!drift) return;
  await applyReload({ ...args, previousConfig, rows });
  args.writeHash(anchor.anchor, anchor.worktreeId, currentHash);
}

/**
 * Write the new derived config and hot-reload it. On failure, restore the
 * previous config (#92), persist the pending-reload marker if it timed out
 * (#191), and throw `ConfigDriftError`.
 */
async function applyReload(args: {
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly paths: { readonly configPath: string };
  readonly derived: ReturnType<typeof deriveWorktreeConfig>;
  readonly inst: { readonly configPath: string; readonly socketPath: string };
  readonly driver: ReturnType<typeof createDriver>;
  readonly deps: CommandDeps;
  readonly previousConfig: string | undefined;
  readonly rows: ServiceStatus[] | undefined;
  readonly writeHash: (anchor: string, id: string, hash: string) => void;
}): Promise<void> {
  const { anchor, paths, derived, previousConfig } = args;
  const nextConfig = stringifyYaml(derived.config);
  writeFileSync(paths.configPath, nextConfig, "utf8");
  const reload = await args.driver.reloadConfig(args.inst, {
    timeoutMs: reloadTimeoutMs(derived.config),
  });
  if (reload.ok) return;
  if (previousConfig === undefined) rmSync(paths.configPath, { force: true });
  else writeFileSync(paths.configPath, previousConfig, "utf8");
  if (reload.reason === "timeout") {
    await persistPendingReload({ ...args, nextConfig });
    // process-compose will end up running the NEW config, while the restored
    // on-disk config and the stored hash still describe the old one. Forget
    // the hash so the first `up` after the reload converges sees drift and
    // re-applies whatever devtrees.yaml says then: a no-op if it still holds
    // the new config, a restart if it was reverted meanwhile.
    args.writeHash(anchor.anchor, anchor.worktreeId, RELOAD_TIMED_OUT_HASH);
  }
  throw new ConfigDriftError(
    `devtrees up: config drift detected for '${anchor.worktreeId}' and the running ` +
      `process-compose could not hot-reload the new config` +
      (reload.message ? ` (${reload.message})` : "") +
      (reload.reason === "timeout" ? RELOAD_TIMEOUT_REMEDIATION : RELOAD_FAILED_REMEDIATION),
    { reason: reload.reason },
  );
}

/**
 * Persist the pending-reload marker for a timed-out reload (#191). The old
 * runs' identity is read from `ps` while they still run (#206), so a later
 * `down` can force-kill them without risking a reused pid.
 */
async function persistPendingReload(args: {
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly inst: { readonly socketPath: string };
  readonly deps: CommandDeps;
  readonly previousConfig: string | undefined;
  readonly nextConfig: string;
  readonly rows: ServiceStatus[] | undefined;
  readonly driver: { getServiceStatuses(socketPath: string): Promise<ServiceStatus[]> };
}): Promise<void> {
  // Both sides read back from YAML, so the per-service diff compares like
  // with like.
  const plan = planPendingReload(
    derivedProcesses(args.previousConfig),
    derivedProcesses(args.nextConfig) ?? {},
    args.rows,
  );
  const readTable = args.deps.stop?.readProcessTable ?? readProcessTable;
  // Retried while empty or without the supervisor (a `ps` that failed under
  // load): a run without an identity is one `down` can never kill.
  if (plan.oldRuns.length === 0) {
    writePendingReload(args.anchor.anchor, args.anchor.worktreeId, plan);
    return;
  }
  // Which old runs process-compose has already dropped: their update is
  // stopping them now, so `down` counts their grace period from here.
  const listed = await args.driver
    .getServiceStatuses(args.inst.socketPath)
    .then((rows) => ({ rows, at: Date.now() }))
    .catch(() => undefined);
  const { table, supervisorPid } = await readSupervisedTable(readTable, args.inst.socketPath, {
    delayMs: args.deps.stop?.pollMs,
  });
  const marker = identifyOldRuns(plan, table, supervisorPid, listed);
  writePendingReload(args.anchor.anchor, args.anchor.worktreeId, marker);
}

type DerivedProcessMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The `processes` map of a derived config's YAML, or `undefined` if unreadable. */
function derivedProcesses(yaml: string | undefined): DerivedProcessMap | undefined {
  if (yaml === undefined) return undefined;
  try {
    const processes = (parseYaml(yaml) as { processes?: unknown } | null)?.processes;
    return processes !== null && typeof processes === "object"
      ? (processes as DerivedProcessMap)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stored-hash sentinel written when a reload times out (#191). It never
 * equals a real stack hash, so the next `up` always takes the drift path.
 */
const RELOAD_TIMED_OUT_HASH = "reload-timed-out";

/**
 * Refuse to reload while a previous reload is still pending (#191; see
 * src/reload-pending.ts). The marker is checked whenever there is one.
 * Pure, so `up --dry-run` can raise the same refusal (#210): returns `true`
 * when a successful read shows the reload converged, and the caller (the
 * real `up` only) then clears the marker; a failed read leaves it in place,
 * with only the old PIDs as evidence.
 */
function assertNoPendingReload(args: {
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly marker: PendingReload | undefined;
  readonly rows: ServiceStatus[] | undefined;
  readonly previous: DerivedProcessMap | undefined;
  readonly isolated: ReadonlyArray<Pick<ResolvedService, "name" | "namespace">>;
  readonly requested: ReadonlyArray<string>;
  readonly isAlive: (pid: number) => boolean;
  /** Who is refusing (#222): `restart` refuses too, as the update would wait on its new run forever. */
  readonly command?: "up" | NamedServiceCommand;
  /** What the remedy says to rerun once the reload is done. Default `devtrees up`. */
  readonly retry?: string;
}): boolean {
  const { anchor, marker, rows } = args;
  if (marker === undefined) return false;
  const stuck = stuckFromMarker(marker, rows, args.isAlive);
  if (stuck !== undefined) {
    throw reloadPendingError(
      anchor.worktreeId,
      stuck,
      pendingRemedyUp({ ...args, stuck }),
      args.command,
      args.retry,
    );
  }
  return rows !== undefined;
}

/**
 * The `down` + `up` that reboots the instance with the namespaces it runs:
 * the ones this `up` asked for, those the project proves booted (a narrower
 * `-n` must not drop the rest), and the stuck services' own when they have
 * exactly one (they were running before the reload).
 */
function pendingRemedyUp(args: {
  readonly rows: ServiceStatus[] | undefined;
  readonly previous: DerivedProcessMap | undefined;
  readonly isolated: ReadonlyArray<Pick<ResolvedService, "name" | "namespace">>;
  readonly requested: ReadonlyArray<string>;
  readonly stuck: StuckReload;
}): string {
  const proven =
    args.previous !== undefined && args.rows !== undefined
      ? provenNamespaces(args.previous, args.rows)
      : [];
  const stuckOwn = args.isolated
    .filter((s) => args.stuck.services.includes(s.name))
    .map((s) => serviceNamespaces(s))
    .flatMap((ns) => (ns.length === 1 ? ns : []));
  const namespaces = [...new Set([...args.requested, ...proven, ...stuckOwn])].sort();
  return `devtrees down && ${formatUpCommand(args.isolated, namespaces)}`;
}

/**
 * Why a command refuses while a hot-reload is pending (#191). A restart (#222): the update is
 * waiting on the old run, and a run started now is one it does not know
 * about, so it would wait on it forever.
 */
const PENDING_RELOAD_CONSEQUENCE: Readonly<Record<"up" | NamedServiceCommand, string>> = {
  up:
    "Reloading again now would make process-compose start a second, untracked copy, " +
    "so nothing was reloaded and the instance is unchanged.",
  restart:
    "The update is still waiting on the old run, and a run restarted now would be one it " +
    "does not know about and would wait on forever, so nothing was restarted and the " +
    "instance is unchanged.",
};

function reloadPendingError(
  worktreeId: string,
  stuck: StuckReload,
  rebootCommand: string,
  command: "up" | NamedServiceCommand = "up",
  retry = "devtrees up",
): ConfigDriftError {
  const names = stuck.services.map((s) => `'${s}'`).join(", ");
  const pids = stuck.pids.join(" ");
  const [waitingOn, remedy] =
    stuck.pids.length > 0
      ? [
          `its old process (pid ${stuck.pids.join(", ")}) has not exited`,
          `Kill the old process (\`kill ${pids}\`), then run \`${retry}\` again.`,
        ]
      : [
          `its old process has exited, but process-compose has not brought it back yet`,
          `Wait a moment for process-compose to start the new one, then run ` +
            `\`${retry}\` again. If this persists, run \`${rebootCommand}\`.`,
        ];
  const consequence = PENDING_RELOAD_CONSEQUENCE[command];
  return new ConfigDriftError(
    `devtrees ${command}: a previous hot-reload of '${worktreeId}' is still pending for ` +
      `${names}: ${waitingOn}. ${consequence} ${remedy}`,
    { reason: "reload_pending", services: stuck.services, pids: stuck.pids },
  );
}

/**
 * Verify an already-running worktree instance against what this `up` asked
 * for (ADR-0008, issue #177). `up` never reports success on the strength of
 * the instance merely existing:
 *
 *  1. **Selection.** Read the project back from process-compose, retrying a
 *     failed read up to `--wait-timeout` (then `HEALTH_TIMEOUT`). A bare `up`
 *     targets the namespaces whose declared services are all present (the
 *     boot-time selection); `-n` is exact, and a requested namespace whose
 *     services are absent fails with `NAMESPACE_NOT_RUNNING` (#170) — they
 *     cannot be added to a running instance.
 *  2. **Restart.** Every dead selected isolated service (`classifyService`:
 *     a crash, a kill, a non-zero exit; not an exit-0 one-shot, not one
 *     process-compose is already `Restarting`) is started again over the
 *     control socket (#162, #178), in `depends_on` order, under the
 *     lifecycle lock so a concurrent `down` cannot race it
 *     (`restartDeadServices`). A start request process-compose refuses fails
 *     with `SERVICE_START_FAILED`; an instance that stopped meanwhile fails
 *     with `INSTANCE_NOT_FOUND`.
 *  3. **Health.** Wait on every selected isolated service with the same
 *     machinery and `--wait-timeout` as a fresh headless start. A healthy
 *     instance passes on the first poll; a restarted service that never
 *     becomes healthy, or dies again, fails with `HEALTH_TIMEOUT` naming it.
 *
 * Dead shared services are checked earlier, inside the lifecycle lock, on
 * both paths (`assertSharedServicesAlive`), and are never restarted. Returns
 * the rows the last poll saw, so the envelope needs no extra read, the
 * names of the services it restarted, and the `depends_on` edges the
 * effective selection drops (#179), each already warned about.
 *
 * Never stops anything, and restarts only selected services: a narrower `-n`
 * than what is running only narrows what is checked and restarted.
 */
async function verifyRunning(args: {
  readonly stack: ResolvedStack;
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly socketPath: string;
  readonly deps: CommandDeps;
  readonly driver: ReturnType<typeof createDriver>;
  readonly warn: (message: string) => void;
}): Promise<{
  readonly rows: ServiceStatus[] | undefined;
  readonly droppedNamespaceEdges: ReadonlyArray<DroppedNamespaceEdge>;
  readonly restarted: string[];
}> {
  const { stack, anchor, socketPath, deps, driver } = args;
  const timeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  // The boot-time selection only exists in the live project, so `up` needs
  // one successful read before it can say anything; a read that keeps
  // failing is HEALTH_TIMEOUT, never a success over an unknown selection.
  const rows = await readStatusesWithin(
    { getServiceStatuses: statusReader(deps, driver) },
    socketPath,
    timeoutMs,
    { notify: args.warn, probe: probeOf(deps) },
  );
  const selection = planRunningInstance(stack, anchor.worktreeId, rows, deps.namespaces);
  const nsEdges = selection.droppedNamespaceEdges;
  for (const edge of nsEdges) args.warn(formatDroppedNamespaceEdgeWarning(edge));

  const remedy = `devtrees down && ${formatUpCommand(stack.services, selection.namespaces)}`;
  const { restarted, firstRead } = await restartDeadServices({
    ...args,
    rows,
    names: selection.services.map((s) => s.name),
    remedy,
  });
  // Outside the lifecycle lock, like the fresh path's wait.
  const lastRows = await waitForSelectedHealth(selection.services, socketPath, deps, driver, {
    remedy,
    warn: args.warn,
    ...(restarted.length === 0 ? { firstRead } : { restarted }),
  });
  return {
    rows: lastRows,
    droppedNamespaceEdges: nsEdges,
    restarted: restarted.map((r) => r.name),
  };
}

/**
 * What `up` does to a running instance, decided from one `process list` read
 * (ADR-0008). Pure: the real `up` (`verifyRunning`) and `up --dry-run`
 * (`previewRunning`, #210) both decide through it, so the preview cannot
 * drift from the command it previews.
 *
 *  - **Selection.** A bare `up` targets the namespaces whose declared
 *    services are all present (the boot-time selection); `-n` is exact, and a
 *    requested namespace whose services are absent throws
 *    `NAMESPACE_NOT_RUNNING` (#170).
 *  - **Dropped edges** (#179) against that effective selection. A target
 *    counts as kept when it is in the project, so a narrower `-n` than the
 *    boot selection does not report edges to services still running.
 *  - **Dead** selected isolated services, in `depends_on` order: the ones
 *    `up` would restart (#178), given the same read.
 */
function planRunningInstance(
  stack: ResolvedStack,
  worktreeId: string,
  rows: ReadonlyArray<ServiceStatus>,
  requested: ReadonlyArray<string> | undefined,
): {
  readonly namespaces: ReadonlyArray<string>;
  readonly services: ReadonlyArray<ResolvedService>;
  readonly droppedNamespaceEdges: DroppedNamespaceEdge[];
  readonly dead: string[];
} {
  const isolated = stack.services.filter((s) => s.tier === "isolated");
  const present = new Set(rows.map((r) => r.name));
  const selection = resolveRunningSelection(isolated, present, requested);
  if (selection.notRunning.length > 0) {
    throw namespaceNotRunningError(worktreeId, selection.notRunning, requested ?? []);
  }
  const names = selection.services.map((s) => s.name);
  const dead = findDeadServices(rows, names).map((d) => d.name);
  return {
    namespaces: selection.namespaces,
    services: selection.services,
    droppedNamespaceEdges: droppedNamespaceEdges(stack.services, selection.services, present),
    dead: dependencyOrder(stack.services, dead),
  };
}

/**
 * Restart every dead service among `names` (ADR-0008, issue #178), under the
 * worktree's lifecycle lock. `rows` is the unlocked read `verifyRunning`
 * already made: when it shows nothing dead, no lock is taken and nothing is
 * started.
 *
 * Otherwise, inside the lock — the one `up`'s spawn and `down` hold — the
 * socket is probed again and the rows re-read, and only the services dead in
 * that fresh read are started. The lock is what keeps a concurrent `down`
 * from racing the restart: without it, `up` read the services `down` had just
 * SIGTERM'd as dead and started them on a supervisor that was shutting down,
 * leaving them orphaned. Under the lock either `down` has finished (the
 * socket is gone: `InstanceGoneError`, nothing started) or it has not begun.
 *
 * Returns the services started (each with the pid of the run that died, so
 * the health wait can tell that stale row from the restarted run dying again)
 * and the rows to serve as the wait's first poll when nothing was started.
 */
async function restartDeadServices(args: {
  readonly stack: ResolvedStack;
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly rows: ServiceStatus[];
  readonly names: ReadonlyArray<string>;
  readonly socketPath: string;
  readonly deps: CommandDeps;
  readonly driver: ReturnType<typeof createDriver>;
  readonly remedy: string;
  readonly warn: (message: string) => void;
}): Promise<{ restarted: RestartedService[]; firstRead: ServiceStatus[] }> {
  if (findDeadServices(args.rows, args.names).length === 0) {
    return { restarted: [], firstRead: args.rows };
  }
  const { lifecycleLock } = resolveLifecycleSeams(args.deps);
  return lifecycleLock(args.anchor.anchor, args.anchor.worktreeId, async () => {
    // Unknown liveness (#186) fails INSTANCE_UNRESPONSIVE: it is neither
    // "gone" (INSTANCE_NOT_FOUND) nor safe to `process start` against.
    const live = await socketIsLive(args.socketPath, resolveProbe(args.deps), {
      command: "up",
      instance: args.anchor.worktreeId,
    });
    if (!live) {
      throw new InstanceGoneError({ worktree_id: args.anchor.worktreeId });
    }
    const fresh = await readStatusesWithin(
      { getServiceStatuses: statusReader(args.deps, args.driver) },
      args.socketPath,
      Math.min(args.deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, RESTART_READ_TIMEOUT_MS),
      { notify: args.warn },
    );
    const dead = findDeadServices(fresh, args.names).map((d) => d.name);
    const restarted = await startServices({
      ...args,
      rows: fresh,
      names: dependencyOrder(args.stack.services, dead),
    });
    return { restarted, firstRead: fresh };
  });
}

/** Budget for the re-read `restartDeadServices` makes under the lock. */
const RESTART_READ_TIMEOUT_MS = READ_TIMEOUT_MS;

/**
 * Start `names` over the instance's control socket, in the order given (the
 * caller orders them by `depends_on`: `process start` ignores it). Every
 * service is attempted even if an earlier one is refused; any refusal then
 * fails with `SERVICE_START_FAILED` naming each refused service. A service
 * process-compose reports as already running was started by someone else
 * (another `up`, its restart policy), so it is not in the result. Nothing is
 * stopped.
 */
async function startServices(args: {
  readonly anchor: { readonly worktreeId: string };
  readonly rows: ReadonlyArray<ServiceStatus>;
  readonly names: ReadonlyArray<string>;
  readonly socketPath: string;
  readonly driver: ReturnType<typeof createDriver>;
  readonly remedy: string;
}): Promise<RestartedService[]> {
  const pids = new Map(args.rows.map((r) => [r.name, r.pid]));
  const restarted: RestartedService[] = [];
  const failed: Array<{ name: string; message: string }> = [];
  for (const name of args.names) {
    const outcome = await args.driver.startProcess(args.socketPath, name);
    if (!outcome.ok) {
      failed.push({ name, message: outcome.message });
      continue;
    }
    if (outcome.alreadyRunning) continue;
    const stalePid = pids.get(name);
    restarted.push(stalePid === undefined ? { name } : { name, stalePid });
  }
  if (failed.length > 0) {
    throw serviceStartFailedError(args.anchor.worktreeId, failed, args.remedy);
  }
  return restarted;
}

function serviceStartFailedError(
  worktreeId: string,
  failed: ReadonlyArray<{ readonly name: string; readonly message: string }>,
  remedy: string,
): ServiceStartFailedError {
  const reasons = failed.map((f) => `${f.name} (${f.message})`).join(", ");
  return new ServiceStartFailedError(
    `devtrees up: could not restart dead service(s) in '${worktreeId}': ${reasons}. ` +
      `process-compose refused the start request. Run \`${remedy}\` to restart the whole ` +
      `stack. Nothing was stopped; the worktree instance is still running.`,
    { worktree_id: worktreeId, services: failed, remedy },
  );
}

/**
 * Compute the `depends_on` edges `selected` leaves dangling (ADR-0008, #179)
 * and warn once per edge; returns them for the `up --json` envelope. `kept`
 * is forwarded to `droppedNamespaceEdges` (the project's services on a
 * running instance; omitted on a fresh start).
 */
function warnDroppedNamespaceEdges(
  stack: ResolvedStack,
  selected: ReadonlyArray<ResolvedService>,
  warn: (message: string) => void,
  kept?: ReadonlySet<string>,
): DroppedNamespaceEdge[] {
  const edges = droppedNamespaceEdges(stack.services, selected, kept);
  for (const edge of edges) warn(formatDroppedNamespaceEdgeWarning(edge));
  return edges;
}

/** One stderr line per braced injected variable (#200). */
function warnBracedEnvVars(
  vars: ReadonlyArray<BracedEnvVar>,
  warn: (message: string) => void,
): void {
  for (const v of vars) warn(formatBracedEnvVarWarning(v));
}

function namespaceNotRunningError(
  worktreeId: string,
  notRunning: ReadonlyArray<NamespaceNotRunning>,
  requested: ReadonlyArray<string>,
  command: "up" | NamedServiceCommand = "up",
  declared?: ReadonlyArray<Pick<ResolvedService, "namespace">>,
): NamespaceNotRunningError {
  const namespaces = notRunning.map((n) => n.namespace);
  const services = [...new Set(notRunning.flatMap((n) => n.missingServices))];
  const flags = [...new Set(requested)].map((ns) => `-n ${ns}`).join(" ");
  // A per-service verb (#223) spells the boot with `formatUpCommand`, as the
  // other remedies do; `up` keeps its own `-n` list.
  const remedy =
    declared === undefined
      ? `devtrees down && devtrees up ${flags}`
      : `devtrees down && ${formatUpCommand(declared, requested)}`;
  const quoted = namespaces.map((ns) => `'${ns}'`).join(", ");
  const one = namespaces.length === 1;
  return new NamespaceNotRunningError(
    `devtrees ${command}: namespace${one ? "" : "s"} ${quoted} ${one ? "is" : "are"} not running in ` +
      `'${worktreeId}' (not started: ${services.join(", ")}). A running instance keeps the ` +
      `namespaces it was booted with and cannot add more. Run \`${remedy}\` to boot with ` +
      `them. Nothing was started or stopped.`,
    { worktree_id: worktreeId, namespaces, services, remedy },
  );
}

/**
 * Fail with `SHARED_SERVICE_DEAD` when a declared shared service is dead in
 * an already-running shared instance (ADR-0008). Runs on the fresh and the
 * running path alike, inside the lifecycle lock right after
 * `ensureSharedStarted`. One read, no wait: shared services
 * are reported, not restarted or waited on. Every declared shared service is
 * checked — the shared instance is booted without `-n`, so namespace
 * selection does not narrow it. A failed read is not evidence of a dead
 * service, so it passes.
 */
async function assertSharedServicesAlive(
  stack: ResolvedStack,
  sharedSocketPath: string,
  fetch: (socketPath: string) => Promise<ServiceStatus[]>,
): Promise<void> {
  const rows = await fetch(sharedSocketPath).catch(() => undefined);
  if (rows === undefined) return;
  const names = stack.services.filter((s) => s.tier === "shared").map((s) => s.name);
  const dead = findDeadServices(rows, names);
  if (dead.length > 0) throw sharedServiceDeadError(dead);
}

// --- default I/O implementations -------------------------------------------

function defaultGit(cwd: string): GitProbe {
  return (args) => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const defaultWithRegistryLock: WithRegistryLock = (anchor, mutate) =>
  withRegistryLock(anchor, mutate);

const defaultWithSharedLock: WithSharedLock = (anchor, fn) => withSharedLock(anchor, fn);

/**
 * Wait budget for the per-worktree lifecycle lock (issue #91), for `up` and
 * the worktree `down` alike (#178). The holder's window covers a process
 * spawn plus a ≤3s socket-observable wait (and, with shared services,
 * possibly the shared instance's own spawn and health wait), an `up`'s
 * restart of dead services (each `process start` bounded at 10s), or a
 * `down`'s graceful stop, so the registry lock's default ~1s budget would
 * mislabel an ordinary concurrent `up` or `down` as contention. ~10s comfortably covers the spawn window
 * while still bounding the wait on a genuinely stuck holder — beyond it the
 * caller sees LOCK_CONTENTION ("retry later"), never a half-dead socket.
 */
const UP_LIFECYCLE_LOCK_OPTIONS = { retries: 100, retryDelayMs: 100 } as const;

const defaultWithLifecycleLock: WithLifecycleLock = (anchor, instanceId, fn) =>
  withLifecycleLock(anchor, instanceId, fn, UP_LIFECYCLE_LOCK_OPTIONS);

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Both stdout AND stderr must be TTYs for the auto-detect to mean "a human at
 * a terminal is watching". If either is redirected (a pipe, a CI log capture,
 * an agent's pty wrapper that only inherits stdout), we skip the TUI so the
 * caller gets the headless behaviour they implicitly asked for (ADR-0005).
 */
function defaultIsTTY(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

/**
 * Worktree-instance health gate on a fresh start: wait on the isolated
 * services process-compose actually started — the isolated tier intersected
 * with the selected namespaces (issue #128). Without the namespace narrowing,
 * `up -n default` would wait on a probed service in an excluded namespace
 * process-compose never started and HEALTH_TIMEOUT (the critical #108
 * interaction).
 */
async function waitForWorktreeHealth(
  stack: ResolvedStack,
  fresh: {
    readonly selected: ReadonlyArray<ResolvedService>;
    readonly namespaces: ReadonlyArray<string>;
  },
  socketPath: string,
  deps: CommandDeps,
  driver: {
    getServiceStatuses(
      socketPath: string,
      opts?: { readonly timeoutMs?: number },
    ): Promise<ServiceStatus[]>;
  },
  warn: (message: string) => void,
): Promise<void> {
  // `isolated` is the fresh selection (`resolveFreshSelection`): the isolated
  // tier intersected with the selected namespaces (issue #128) — `default`
  // alone on a bare `up` (#176).
  await waitForSelectedHealth(fresh.selected, socketPath, deps, driver, {
    remedy: `devtrees down && ${formatUpCommand(stack.services, fresh.namespaces)}`,
    warn,
  });
}

/**
 * The one health wait both `up` paths share: poll until every service in
 * `services` reports a healthy state, or throw `HealthTimeoutError` (code:
 * HEALTH_TIMEOUT) — on the deadline, or early when a selected service is dead
 * (ADR-0008). The stack is left running on failure — the explicit ADR-0005
 * choice so the agent can inspect logs after the timeout.
 */
async function waitForSelectedHealth(
  services: ReadonlyArray<Pick<ResolvedService, "name" | "readinessProbe">>,
  socketPath: string,
  deps: CommandDeps,
  driver: {
    getServiceStatuses(
      socketPath: string,
      opts?: { readonly timeoutMs?: number },
    ): Promise<ServiceStatus[]>;
  },
  opts: {
    readonly remedy: string;
    /** Told once when status reads start failing and being retried. */
    readonly warn?: (message: string) => void;
    /**
     * Rows the caller just read from this instance. Served as the first poll
     * so an already-healthy running instance costs no extra process-compose
     * round-trip.
     */
    readonly firstRead?: ServiceStatus[];
    /** Services the caller just restarted (issue #178); see `WaitForHealth`. */
    readonly restarted?: ReadonlyArray<RestartedService>;
    /** The waiting command, for its messages (default `up`). */
    readonly command?: WaitingCommand;
    /** The wait window. Default: `deps.waitTimeoutMs`, else 120s. */
    readonly timeoutMs?: number;
  },
): Promise<ServiceStatus[] | undefined> {
  const read = statusReader(deps, driver);
  let primed = opts.firstRead;
  // The rows the wait last saw — on success, the poll that passed — so the
  // caller can build its envelope without another process-compose round-trip.
  let lastRows = opts.firstRead;
  const getServiceStatuses = async (
    path: string,
    readOpts?: { readonly timeoutMs?: number },
  ): Promise<ServiceStatus[]> => {
    if (primed !== undefined) {
      const rows = primed;
      primed = undefined;
      return rows;
    }
    lastRows = await read(path, readOpts);
    return lastRows;
  };
  const wait =
    deps.waitForHealth ??
    createWaitForHealth({ getServiceStatuses }, { notify: opts.warn, probe: probeOf(deps) });
  await wait({
    socketPath,
    serviceNames: services.map((s) => s.name),
    probedServiceNames: probedNames(services),
    timeoutMs: opts.timeoutMs ?? deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    remedy: opts.remedy,
    ...(opts.restarted !== undefined ? { restarted: opts.restarted } : {}),
    ...(opts.command !== undefined ? { command: opts.command } : {}),
  });
  return lastRows;
}

/** The control-socket probe the health waits use after a failed read (#205): the injected seam, else `probeSocket`. */
function probeOf(deps: CommandDeps): (socketPath: string) => Promise<InstanceStatus> {
  return deps.probeSocket ?? defaultProbeSocket;
}

/** The per-service status read: the injected seam, else the driver. */
function statusReader(
  deps: CommandDeps,
  driver: {
    getServiceStatuses(
      socketPath: string,
      opts?: { readonly timeoutMs?: number },
    ): Promise<ServiceStatus[]>;
  },
): (socketPath: string, opts?: { readonly timeoutMs?: number }) => Promise<ServiceStatus[]> {
  return (
    deps.getServiceStatuses ??
    ((socketPath, readOpts) => driver.getServiceStatuses(socketPath, readOpts))
  );
}

/**
 * The names of the services in `services` that declare a readiness probe.
 * The health waits gate these on `health === "ready"` instead of bare process
 * state — process-compose keeps a probed service's status at `Running` while
 * the probe verdict arrives in the separate readiness field (issue #108).
 */
function probedNames(
  services: ReadonlyArray<Pick<ResolvedService, "name" | "readinessProbe">>,
): string[] {
  return services.filter((s) => s.readinessProbe !== undefined).map((s) => s.name);
}

/** Explicit `attach`/`no-attach` override wins; otherwise consult `isTTY()`. */
function shouldAttachAfterUp(deps: CommandDeps): boolean {
  return deps.attach ?? (deps.isTTY ?? defaultIsTTY)();
}

/** Single notice that the worktree start is gated on the shared-health wait. */
function formatHealthWaitNotice(sharedNames: ReadonlyArray<string>): string {
  return (
    `devtrees: waiting for shared services to be healthy ` +
    `[${sharedNames.join(", ")}] before starting this worktree's instance...`
  );
}
