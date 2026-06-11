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
import { deriveSharedConfig, deriveWorktreeConfig, type DroppedEdge } from "./deriver.js";
import {
  discoverInstances,
  probeSocket as defaultProbeSocket,
  type InstanceInfo,
  type InstanceStatus,
  type Service,
} from "./instances.js";
import { SHARED_REGISTRY_KEY, instancePaths, sharedInstancePaths } from "./paths.js";
import { findOrphans, parseWorktreeIds } from "./prune.js";
import { loadStack, type ResolvedService, type ResolvedStack } from "./stack.js";
import {
  createDriver,
  mergeAsyncIterables,
  type DriverDeps,
  type LogEvent,
  type ServiceStatus,
  type StreamLogsOptions,
} from "./driver.js";
import { readRegistry, withLifecycleLock, withRegistryLock, withSharedLock } from "./registry.js";
import { defaultIsPortFree, defaultPortHolder, type PortHolderReport } from "./port-probe.js";
import { sharedStackHash, stackHash } from "./hash.js";
import {
  readStoredHash as defaultReadStoredHash,
  writeStoredHash as defaultWriteStoredHash,
} from "./hashes.js";
import { readSharedState, writeSharedState, type SharedState } from "./shared-state.js";
import {
  createWaitForHealth,
  createWaitForSharedHealth,
  type WaitForHealth,
  type WaitForSharedHealth,
} from "./health.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
 */
class ConfigDriftError extends Error {
  readonly code = "CONFIG_DRIFT";
  constructor(message: string) {
    super(message);
    this.name = "ConfigDriftError";
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
 */
class SharedStartFailedError extends Error {
  readonly code = "SHARED_START_FAILED" as const;
  readonly details: {
    readonly socket_path: string;
    readonly timeout_ms: number;
  };
  constructor(message: string, details: { socket_path: string; timeout_ms: number }) {
    super(message);
    this.name = "SharedStartFailedError";
    this.details = details;
  }
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

/** One row of `details.collisions[]` in the `STALE_PORT_BLOCK` error envelope. */
interface PortCollision {
  readonly port_name: string;
  readonly port: number;
  readonly pid: number | null;
  readonly command: string | null;
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
  readonly ownInstanceLive: boolean;
}): Promise<void> {
  if (args.ownInstanceLive) return;
  const { stack, worktreeId, blockBase, portFor, portHolder } = args;
  const collisions = await collectPortCollisions(stack, portFor, portHolder);
  if (collisions.length === 0) return;
  throw new StalePortBlockError(
    `devtrees up: ports in this worktree's allocated block are held by foreign processes — ` +
      `likely orphaned children from a prior session. Inspect and kill the listed PIDs, then ` +
      `retry \`devtrees up\`.`,
    { block_base: blockBase, worktree_id: worktreeId, collisions },
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
): Promise<PortCollision[]> {
  const collisions: PortCollision[] = [];
  for (const service of stack.services) {
    if (service.tier !== "isolated") continue;
    for (const portName of service.ports) {
      const port = portFor(portName);
      if (port === undefined) continue;
      const report = await portHolder(port);
      if (report.free) continue;
      collisions.push({ port_name: portName, port, pid: report.pid, command: report.command });
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
   * Default: real `waitForSocket` poll. Injected so unit tests with a stub
   * spawner that never binds a socket don't pay the poll timeout.
   */
  readonly waitForSocketFile?: (socketPath: string) => Promise<void>;
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
   * Read the per-service runtime state for the worktree instance after health
   * is reached, so `runUp` can publish `services[]` in the issue-#30 state
   * envelope. Default: shells out to the driver's `getServiceStatuses` (same
   * primitive `ls --json` uses, issue #29). Injected so tests stub it.
   */
  readonly getServiceStatuses?: (socketPath: string) => Promise<ServiceStatus[]>;
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
   * Identify the holder of a concrete port — used by `up`'s pre-flight
   * stale-port-block check (#58). Default: `defaultPortHolder` (bind probe
   * + best-effort `lsof`). Injected so unit tests can drive the routing
   * without touching the network.
   */
  readonly portHolder?: PortHolderProbe;
  /**
   * Allocator defaults — `port_base` and `block_size`. The stack's `allocator`
   * field overrides these on a field-by-field basis. Default: 20000 / 32.
   */
  readonly allocator?: AllocatorOptions;
  readonly driver?: DriverDeps;
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
}

export interface GenerateResult {
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  /** Path of the written worktree-isolated config. */
  readonly worktreePath: string;
  /** Path of the written shared config — present iff the stack has shared services. */
  readonly sharedPath?: string;
  /**
   * Env injection the worktree instance would receive — this worktree's own
   * named ports + the shared services' named ports + the worktree id. Same
   * shape `runUp` returns; lets callers re-derive identically.
   */
  readonly env: Record<string, string>;
  /** Env injection for the shared instance — present iff a shared file was written. */
  readonly sharedEnv?: Record<string, string>;
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

interface AllocatedPortMaps {
  readonly blockBase: number;
  readonly sharedBase?: number;
  /** Resolve an isolated-tier named port to a concrete number, or `undefined` if unknown. */
  readonly portFor: (name: string) => number | undefined;
  /** Resolve a shared-tier named port; `undefined` when the stack has no shared services. */
  readonly sharedPortFor: (name: string) => number | undefined;
}

/**
 * Allocate this worktree's port block — and, if the stack declares shared
 * services, the shared block — under one read-modify-write of the registry
 * lock, then build the named-port → number resolvers from the resulting
 * offsets. Both `runUp` and `runGenerate` need the same allocation pass; the
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

  const isolatedOffsets = buildOffsetMap(stack.services, "isolated", options.blockSize);
  const sharedOffsets = sharedNeeded
    ? buildOffsetMap(stack.services, "shared", options.blockSize)
    : new Map<string, number>();

  const portFor = (name: string): number | undefined => {
    const offset = isolatedOffsets.get(name);
    return offset === undefined ? undefined : blockBase + offset;
  };
  const sharedPortFor = (name: string): number | undefined => {
    if (sharedBase === undefined) return undefined;
    const offset = sharedOffsets.get(name);
    return offset === undefined ? undefined : sharedBase + offset;
  };

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
    portHolder: deps.portHolder ?? defaultPortHolder,
    warn: deps.warn ?? defaultWarn,
    readHash: deps.readStoredHash ?? defaultReadStoredHash,
    writeHash: deps.writeStoredHash ?? defaultWriteStoredHash,
    probe: resolveProbe(deps),
    ...resolveLifecycleSeams(deps),
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
    waitForSocketFile: deps.waitForSocketFile ?? waitForSocket,
  } as const;
}

/**
 * Resolve the #80 socket-liveness probe seam — needed by both `runUp` (via
 * `resolveUpSeams`) and `runDown`, which doesn't share the up-seam bundle.
 */
function resolveProbe(deps: CommandDeps): (socketPath: string) => Promise<InstanceStatus> {
  return deps.probeSocket ?? defaultProbeSocket;
}

/**
 * Liveness gate for the write paths (issue #80). A control-socket *file* is
 * not proof of a live instance — it lives in anchor state, which survives
 * `kill -9` and reboots, so after a crash the file points at nothing. Probe
 * the UDS: a listener means live; anything else means the file is an orphan,
 * so unlink it and report "not live" — the caller then falls through to its
 * fresh-start (or idempotent no-op) path instead of trusting a dead instance.
 */
async function socketIsLive(
  socketPath: string,
  probe: (socketPath: string) => Promise<InstanceStatus>,
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  if ((await probe(socketPath)) === "running") return true;
  rmSync(socketPath, { force: true });
  return false;
}

/**
 * Bring up this worktree's isolated stack, idempotently.
 *
 * Three branches (issue #31):
 *  - **First up** (socket absent): allocate ports, write derived config,
 *    `driver.up`, health-wait, persist the stack-hash, return envelope.
 *  - **Already up, unchanged config** (socket present, stored hash matches):
 *    noop — skip `driver.up`, skip registry write, just re-emit the state
 *    envelope an agent would see from a fresh `up`.
 *  - **Already up, drifted config** (socket present, stored hash differs):
 *    write the new derived config, call `driver.reloadConfig`. On success,
 *    update the stored hash and return the new envelope; on failure
 *    (`not_supported` or otherwise), restore the previous on-disk config
 *    (issue #92) and throw `ConfigDriftError` (code `CONFIG_DRIFT`), leaving
 *    the instance running unchanged.
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
  const { readStack, lock, sharedLock, isPortFree, portHolder, warn, readHash, writeHash } = seams;

  const stack = readStack(anchor.worktreeRoot);
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
  const outcome = await seams.lifecycleLock(anchor.anchor, anchor.worktreeId, async () => {
    // Liveness, not file existence (issue #80): probe the control socket for an
    // actual listener. A SIGKILLed instance leaves its socket file behind in
    // anchor state; trusting it would take the already-running branch against a
    // dead instance AND skip the #58 pre-flight below. A stale file is unlinked
    // here so this up falls through to the fresh-start path.
    const ownInstanceLive = await socketIsLive(paths.socketPath, seams.probe);

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
    let effectiveSharedPortFor = sharedPortFor;
    if (sharedNeeded) {
      const ensured = await ensureSharedStarted(
        anchor.anchor,
        stack,
        anchor.worktreeId,
        sharedPortFor,
        sharedLock,
        { driver, probe: seams.probe, socketTimeoutMs: deps.sharedSocketTimeoutMs },
      );
      sharedStarted = ensured.started;
      if (ensured.ports !== undefined) {
        const ports = ensured.ports;
        effectiveSharedPortFor = (name) => ports[name];
      }
    }

    const derived = deriveWorktreeConfig(stack, {
      worktreeId: anchor.worktreeId,
      worktreeRoot: anchor.worktreeRoot,
      portFor,
      sharedPortFor: effectiveSharedPortFor,
    });

    // Surface every cross-tier `depends_on` edge devtrees just dropped. Silent
    // dropping would make the orchestration-layer wiring a mystery (ADR-0003
    // "Consequences").
    for (const edge of derived.droppedEdges) {
      warn(formatDroppedEdgeWarning(edge));
    }

    // Idempotency branch (issue #31): if this worktree's control socket is held
    // by a live listener (probed above, #80 — file existence alone is not
    // enough), the instance is up. Compare the current resolved-stack hash to
    // the one stored from the previous successful `up`:
    //   - match  -> noop, re-emit the envelope (no driver.up, no registry write)
    //   - drift  -> attempt hot-reload via the driver; map failure to CONFIG_DRIFT.
    if (ownInstanceLive) {
      const result = await reconcileRunning({
        stack,
        anchor,
        paths,
        blockBase,
        portFor,
        derived,
        inst,
        driver,
        readHash,
        writeHash,
        sharedStarted,
        deps,
      });
      return { kind: "reconciled", result } as const;
    }

    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");

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
      const wait = deps.waitForSharedHealth ?? createWaitForSharedHealth(driver);
      await wait({
        anchor: anchor.anchor,
        socketPath: sharedPaths.socketPath,
        sharedServiceNames: sharedNames,
        probedServiceNames: probedNames(sharedServices),
      });
    }

    await driver.up(inst);

    // `driver.up` is fire-and-forget: spawn returns before the child binds the
    // UDS. Hold the lifecycle lock until the socket is observable so the next
    // contender's liveness gate sees this start as complete instead of racing
    // a second spawn against it (same reasoning as `ensureSharedStarted`).
    await seams.waitForSocketFile(paths.socketPath);

    // Record the resolved-stack hash BEFORE releasing the lock: a loser that
    // reconciles the moment we release must see this config as current — a
    // missing hash would route it down the drift path and hot-reload a config
    // the instance was just started from (issue #31 bookkeeping, #91 timing).
    writeHash(anchor.anchor, anchor.worktreeId, stackHash(stack));

    return { kind: "started", env: derived.env, sharedStarted } as const;
  });

  if (outcome.kind === "reconciled") return outcome.result;

  await waitForWorktreeHealth(stack, paths.socketPath, deps, driver);

  // After the health-wait, snapshot the per-service runtime rows so the
  // issue-#30 `up --json` envelope can publish them without a follow-up
  // `ls --json`. Best-effort: a driver-side hiccup here must not turn the
  // healthy worktree into a failed `up` (same containment rule `ls --json`
  // applies, issue #29).
  const services = await collectIsolatedServices(stack, paths.socketPath, portFor, deps, driver);

  if (shouldAttachAfterUp(deps)) await driver.attach(inst);

  return {
    worktreeId: anchor.worktreeId,
    socketPath: paths.socketPath,
    env: outcome.env,
    sharedStarted: outcome.sharedStarted,
    blockBase,
    services,
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
): Promise<Service[]> {
  const fetch = deps.getServiceStatuses ?? ((s: string) => driver.getServiceStatuses(s));
  let statuses: ServiceStatus[];
  try {
    statuses = await fetch(socketPath);
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
 * Emit the derived process-compose config(s) to disk without starting anything.
 * Allocates port blocks the same way `runUp` does — so the emitted files reflect
 * the very ports `up` would use — but does not spawn `process-compose` and does
 * not lazy-start the shared instance. Useful for debugging or for running with
 * raw `process-compose -f <derived>.yaml` (acceptance, #10).
 *
 * The worktree-isolated subset is always written. The shared subset is written
 * only when the stack declares shared services.
 */
export async function runGenerate(deps: CommandDeps = {}): Promise<GenerateResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;

  const stack = readStack(anchor.worktreeRoot);
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
    portFor,
    sharedPortFor,
  });

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.configPath, stringifyYaml(derivedWt.config), "utf8");

  if (sharedNeeded) {
    const derivedShared = deriveSharedConfig(stack, {
      workingDir: anchor.anchor,
      portFor: sharedPortFor,
    });
    const sharedPaths = sharedInstancePaths(anchor.anchor);
    writeFileSync(sharedPaths.configPath, stringifyYaml(derivedShared.config), "utf8");
    return {
      worktreeId: anchor.worktreeId,
      worktreeRoot: anchor.worktreeRoot,
      worktreePath: paths.configPath,
      sharedPath: sharedPaths.configPath,
      env: derivedWt.env,
      sharedEnv: derivedShared.env,
    };
  }

  return {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    worktreePath: paths.configPath,
    env: derivedWt.env,
  };
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
    probe: (socketPath: string) => Promise<InstanceStatus>;
    /** Socket-bind wait window for the lazy start (issue #92). Default: 3s. */
    socketTimeoutMs?: number;
  },
): Promise<EnsuredShared> {
  return await sharedLock(anchor, async () => {
    const paths = sharedInstancePaths(anchor);
    if (await socketIsLive(paths.socketPath, deps.probe)) {
      const state = readSharedState(anchor);
      // Legacy fallback: a pre-#83 shared instance left no persisted map.
      // Positional computation is all we have — same behaviour as before.
      if (state === undefined) return { started: false };
      assertSharedSubsetMatches(stack, state, worktreeId);
      return { started: false, ports: state.ports };
    }

    const derived = deriveSharedConfig(stack, {
      workingDir: anchor,
      portFor: sharedPortFor,
    });

    mkdirSync(paths.runDir, { recursive: true });
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
    await waitForSocket(paths.socketPath, deps.socketTimeoutMs);

    // Make the running instance the source of truth: persist what it was
    // started with so every subsequent `up`/`env` — on any branch — injects
    // these numbers, not its own positional recomputation (issue #83).
    const ports = collectSharedPorts(stack, sharedPortFor);
    writeSharedState(anchor, { hash: sharedStackHash(stack), ports });
    return { started: true, ports };
  });
}

/**
 * Poll until `socketPath` exists, or throw `SharedStartFailedError` when the
 * deadline lapses (issue #92). Silently returning here used to let `up`
 * report a shared instance that died before binding as `shared_started:
 * true` — the failure must surface as an error envelope instead.
 */
async function waitForSocket(socketPath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new SharedStartFailedError(
    `devtrees up: the shared instance was spawned but did not bind its control socket ` +
      `within ${timeoutMs}ms — it most likely crashed on startup. ` +
      `Check the shared services' commands (e.g. run \`process-compose -f <shared config>\` by hand) ` +
      `and retry \`devtrees up\`.`,
    { socket_path: socketPath, timeout_ms: timeoutMs },
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
    `and reference it as \${WEB_PORT} instead.`
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
  | { readonly shared: true; readonly worktreeId?: undefined; readonly stopped: boolean }
  | { readonly shared: false; readonly worktreeId: string; readonly stopped: boolean };

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

    const stopped = await sharedLock(anchor.anchor, async () => {
      // Probe, don't trust the file (#80): after a SIGKILL the socket file
      // survives with no listener behind it, and `process-compose down`
      // against the dead UDS fails. A live instance is signalled through the
      // driver; a stale socket is unlinked by the probe gate itself, so
      // either way the call converges to "shared is down" — idempotently.
      const live = await socketIsLive(paths.socketPath, probe);
      if (live) {
        await driver.down({ configPath: paths.configPath, socketPath: paths.socketPath });
      }
      // Best-effort cleanup of the derived config — a future `up` re-derives it.
      rmSync(paths.configPath, { force: true });
      return live;
    });

    // Keep the `__shared__` registry entry across the teardown (issue #51).
    // The next `up` re-uses the same block via the allocator fast-path
    // (src/allocator.ts), giving agents that record `DB_PORT` once a stable
    // value across `down --shared` + `up` cycles. `ls --json` liveness flows
    // from socket presence (instances.ts), not the registry, so dropping the
    // entry was tidy theatre at the cost of port stability.

    return { shared: true, stopped };
  }

  // Worktree branch mirrors the shared branch's idempotency (issue #92): a
  // `down` with nothing running used to shell out unconditionally and surface
  // a raw "process-compose down exited with code N" as UNKNOWN. Probe first
  // (#80 — a stale socket file is unlinked by the gate itself) and skip the
  // driver when no live instance answers; the caller renders the no-op notice
  // from `stopped: false` and still exits 0.
  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  const live = await socketIsLive(paths.socketPath, resolveProbe(deps));
  if (live) {
    await driver.down({ configPath: paths.configPath, socketPath: paths.socketPath });
  }

  return { shared: false, worktreeId: anchor.worktreeId, stopped: live };
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
 * a stale or failing instance does not abort the walk.
 */
export async function runLs(deps: LsDeps = {}): Promise<LsResult> {
  const { anchor } = resolve(deps);
  const discover = deps.discover ?? discoverInstances;
  const driver = createDriver(deps.driver ?? {});
  const instances = await discover(anchor.anchor, {
    getServiceStatuses: (socketPath) => driver.getServiceStatuses(socketPath),
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
  readonly status: "running" | "stale";
  /**
   * Absolute path of the worktree the orphan was anchored at, recovered from
   * the orphan's derived config (`working_dir`) before cleanup. Empty when
   * the derived config was missing or unreadable — the JSON envelope still
   * emits the field so the shape stays stable.
   */
  readonly worktreePath: string;
}

export interface PruneResult {
  readonly anchor: string;
  /** The orphans that were stopped + cleaned. Source order from discovery. */
  readonly pruned: ReadonlyArray<PrunedOrphan>;
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
  const driver = createDriver(deps.driver);

  const instances = await discover(anchor.anchor);
  const porcelain = git(["worktree", "list", "--porcelain"]);
  const liveIds = parseWorktreeIds(porcelain);
  const orphans = findOrphans(instances, liveIds);
  if (orphans.length === 0) return { anchor: anchor.anchor, pruned: [] };

  // Capture identity-only metadata for each orphan *before* tearing down its
  // derived config — `worktreePath` is recovered from the on-disk YAML and
  // is unrecoverable once we remove it (issue #48 acceptance).
  const reported: PrunedOrphan[] = orphans.map((orphan) => ({
    id: orphan.id,
    kind: orphan.kind,
    status: orphan.status,
    worktreePath: readWorktreePath(instancePaths(anchor.anchor, orphan.id).configPath),
  }));

  for (const orphan of orphans) {
    const paths = instancePaths(anchor.anchor, orphan.id);
    if (orphan.status === "running") {
      try {
        await driver.down({
          configPath: paths.configPath,
          socketPath: paths.socketPath,
        });
      } catch {
        // Best-effort: a failed down still leaves us removing the on-disk
        // state below, which is the whole point of prune.
      }
    }
    // Remove the socket file (driver.down typically removes it on a clean
    // exit, but stale/failed orphans need explicit cleanup).
    rmSync(paths.socketPath, { force: true });
    // Remove the derived config — a future `up` re-derives it.
    rmSync(paths.configPath, { force: true });
  }

  // Drop every orphan's registry entry under one lock acquire so concurrent
  // `up`s can re-use the freed block bases.
  await lock(anchor.anchor, (snapshot) => {
    let next = snapshot;
    let changed = false;
    for (const orphan of orphans) {
      if (next[orphan.id] !== undefined) {
        const { [orphan.id]: _drop, ...rest } = next;
        void _drop;
        next = rest;
        changed = true;
      }
    }
    return changed ? next : snapshot;
  });

  return { anchor: anchor.anchor, pruned: reported };
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
   * `runUp` and `runGenerate` produce. Computed without spawning, locking, or
   * persisting (issue #32 "Pure read").
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

  const isolatedOffsets = buildOffsetMap(stack.services, "isolated", options.blockSize);
  const sharedOffsets = sharedNeeded
    ? buildOffsetMap(stack.services, "shared", options.blockSize)
    : new Map<string, number>();

  const portFor = (name: string): number | undefined => {
    const offset = isolatedOffsets.get(name);
    return offset === undefined ? undefined : block.base + offset;
  };
  const sharedPortFor = (name: string): number | undefined => {
    if (sharedBlock === undefined) return undefined;
    const offset = sharedOffsets.get(name);
    return offset === undefined ? undefined : sharedBlock.base + offset;
  };

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
    portFor,
    sharedPortFor: effectiveSharedPortFor,
  });

  return { worktreeId: anchor.worktreeId, env: derived.env };
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
): Error {
  const where = shared ? "the shared instance" : "this worktree's instance";
  const valid =
    validServices.length > 0
      ? `Valid services: ${validServices.join(", ")}.`
      : "Its derived config lists no services.";
  const err = new Error(`unknown service '${service}' in ${where}. ${valid}`) as Error & {
    code?: string;
    details?: Readonly<Record<string, unknown>>;
  };
  err.code = "SERVICE_NOT_FOUND";
  err.details = { service, valid_services: [...validServices] };
  return err;
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

/**
 * Idempotency / drift dispatch for a `runUp` whose worktree instance is
 * already running. Two outcomes:
 *
 *  - **Matching hash** -> noop: skip `driver.up` and the registry write, just
 *    re-collect per-service runtime rows and return the same envelope shape
 *    a fresh `up` would (issue-#30 contract).
 *  - **Drift** -> write the new derived config and call `driver.reloadConfig`.
 *    On success, persist the new hash and return the new envelope; on any
 *    failure, restore the previous on-disk config (issue #92 — the file must
 *    keep matching the still-running instance, `ls` reads ports from it) and
 *    throw `ConfigDriftError` so the CLI emits the `CONFIG_DRIFT` envelope
 *    and the instance keeps running (ADR-0005).
 */
async function reconcileRunning(args: {
  readonly stack: ResolvedStack;
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly paths: {
    readonly runDir: string;
    readonly configPath: string;
    readonly socketPath: string;
  };
  readonly blockBase: number;
  readonly portFor: (name: string) => number | undefined;
  readonly derived: ReturnType<typeof deriveWorktreeConfig>;
  readonly inst: { readonly configPath: string; readonly socketPath: string };
  readonly driver: ReturnType<typeof createDriver>;
  readonly readHash: (anchor: string, id: string) => string | undefined;
  readonly writeHash: (anchor: string, id: string, hash: string) => void;
  /**
   * Whether THIS call lazy-started the shared instance (issue #56). The
   * shared liveness check runs before this dispatch in `runUp`, so the
   * envelope returned from the idempotency branch must surface the same
   * value a fresh-start envelope would.
   */
  readonly sharedStarted: boolean;
  readonly deps: CommandDeps;
}): Promise<UpResult> {
  const { stack, anchor, paths, blockBase, portFor, derived, inst, driver } = args;
  const currentHash = stackHash(stack);
  const storedHash = args.readHash(anchor.anchor, anchor.worktreeId);
  if (storedHash !== currentHash) {
    // The on-disk derived config must always describe the *running* instance
    // (issue #92) — `ls` reads its ports from this file. `driver.reloadConfig`
    // re-reads the config from disk, so the new one has to be written before
    // the attempt; snapshot the old bytes first and restore them on failure
    // so a failed reload never leaves the file describing config the instance
    // is not running.
    mkdirSync(paths.runDir, { recursive: true });
    const previousConfig = existsSync(paths.configPath)
      ? readFileSync(paths.configPath, "utf8")
      : undefined;
    writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");
    const reload = await driver.reloadConfig(inst);
    if (!reload.ok) {
      if (previousConfig === undefined) rmSync(paths.configPath, { force: true });
      else writeFileSync(paths.configPath, previousConfig, "utf8");
      throw new ConfigDriftError(
        `devtrees up: config drift detected for '${anchor.worktreeId}' and the running ` +
          `process-compose could not hot-reload the new config` +
          (reload.message ? ` (${reload.message})` : "") +
          ". The instance is still running — run `devtrees down && devtrees up` to apply the new config.",
      );
    }
    args.writeHash(anchor.anchor, anchor.worktreeId, currentHash);
  }
  const services = await collectIsolatedServices(
    stack,
    paths.socketPath,
    portFor,
    args.deps,
    driver,
  );
  return {
    worktreeId: anchor.worktreeId,
    socketPath: paths.socketPath,
    env: derived.env,
    sharedStarted: args.sharedStarted,
    blockBase,
    services,
  };
}

// --- default I/O implementations -------------------------------------------

function defaultGit(cwd: string): GitProbe {
  return (args) => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const defaultWithRegistryLock: WithRegistryLock = (anchor, mutate) =>
  withRegistryLock(anchor, mutate);

const defaultWithSharedLock: WithSharedLock = (anchor, fn) => withSharedLock(anchor, fn);

/**
 * Wait budget for the per-worktree lifecycle lock (issue #91). The holder's
 * window covers a process spawn plus a ≤3s socket-observable wait (and, with
 * shared services, possibly the shared instance's own spawn and health wait),
 * so the registry lock's default ~1s budget would mislabel an ordinary
 * concurrent `up` as contention. ~10s comfortably covers the spawn window
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
 * Worktree-instance health gate: poll until every isolated service reports a
 * healthy state, or throw `HealthTimeoutError` (code: HEALTH_TIMEOUT) so the
 * caller exits non-zero. The stack is left running on failure — the explicit
 * ADR-0005 choice so the agent can inspect logs after the timeout.
 */
async function waitForWorktreeHealth(
  stack: ResolvedStack,
  socketPath: string,
  deps: CommandDeps,
  driver: { getServiceStatuses(socketPath: string): Promise<ServiceStatus[]> },
): Promise<void> {
  const wait = deps.waitForHealth ?? createWaitForHealth(driver);
  const isolated = stack.services.filter((s) => s.tier === "isolated");
  await wait({
    socketPath,
    serviceNames: isolated.map((s) => s.name),
    probedServiceNames: probedNames(isolated),
    timeoutMs: deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
  });
}

/**
 * The names of the services in `services` that declare a readiness probe.
 * The health waits gate these on `health === "ready"` instead of bare process
 * state — process-compose keeps a probed service's status at `Running` while
 * the probe verdict arrives in the separate readiness field (issue #108).
 */
function probedNames(services: ReadonlyArray<ResolvedService>): string[] {
  return services.filter((s) => s.readinessProbe !== undefined).map((s) => s.name);
}

/** Explicit `attach`/`no-attach` override wins; otherwise consult `isTTY()`. */
function shouldAttachAfterUp(deps: CommandDeps): boolean {
  return deps.attach ?? (deps.isTTY ?? defaultIsTTY)();
}

/**
 * One human-readable line per dropped cross-tier edge. Tells the developer
 * which edge devtrees just lifted out of the derived config and why — the
 * orchestration layer is now responsible for the equivalent gating.
 */
function formatDroppedEdgeWarning(edge: DroppedEdge): string {
  return (
    `devtrees: dropped cross-tier depends_on '${edge.from}' (${edge.fromTier}) -> ` +
    `'${edge.to}' (${edge.toTier}). ` +
    `Process-compose cannot express a dependency across instances (ADR-0003); ` +
    `devtrees waits for shared services to be healthy before starting the worktree instance instead.`
  );
}

/** Single notice that the worktree start is gated on the shared-health wait. */
function formatHealthWaitNotice(sharedNames: ReadonlyArray<string>): string {
  return (
    `devtrees: waiting for shared services to be healthy ` +
    `[${sharedNames.join(", ")}] before starting this worktree's instance...`
  );
}
