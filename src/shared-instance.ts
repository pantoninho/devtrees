/**
 * The shared instance (ADR-0001): the one process-compose instance, anchored
 * at the git common dir, that runs every shared service some `up` selected
 * (ADR-0010). This module owns its lifecycle: the shared lifecycle lock,
 * the anchor state it reads and writes (the shared state, the shared port
 * map and the shared-step markers) and the shared control socket. `up`,
 * `up --dry-run` and `env` (#257), `down --shared`, `down --shared -n`, `ls`'s
 * shared ports and `prune --shared-ports` (#258) reach the shared instance
 * only through the `SharedInstance` it opens.
 *
 * The rules a caller used to have to remember hold here instead:
 *
 *  - everything that changes the shared instance (a lazy start, an add, a
 *    restart of a dead service, a port-map write, a shared-step marker) runs
 *    under the shared lifecycle lock;
 *  - the selected shared services are checked for drift before anything is
 *    restarted or added (#236, #240), and only they are (ADR-0010);
 *  - the shared port map is read and reconciled under that lock, its
 *    conflicts refuse the `up` before anything changes, and it is recorded
 *    only once nothing refused (#238, ADR-0011);
 *  - a teardown runs under that same lock, so it never interleaves with an
 *    `up`'s shared step; a namespaced one waits for in-flight commands
 *    outside it, and only for the ones that use its targets (ADR-0012);
 *  - the shared port map survives every teardown, and only
 *    `prune --shared-ports` shrinks it, under the lock (ADR-0011);
 *  - the read-only previews (`up --dry-run`, `env`, `down --shared -n
 *    --dry-run`, `prune --shared-ports --dry-run`, `ls`) take no lock, start
 *    or stop nothing and write nothing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  DEVTREES_METADATA_KEY,
  deriveSharedConfig,
  type DerivedConfig,
  type DerivedShared,
} from "./deriver.js";
import { stopInstance, type ForceKilled, type StopDriver, type StopSeams } from "./bounded-down.js";
import { StopRefusedError, warnSurvivors } from "./bounded-stop.js";
import { daemonHooksSkipped } from "./down-survivors.js";
import {
  READ_TIMEOUT_MS,
  reloadTimeoutMs,
  type Driver,
  type InstanceRef,
  type ServiceStatus,
} from "./driver.js";
import { sharedExtendedFields, sharedStackHash } from "./hash.js";
import {
  createWaitForSharedHealth,
  createWaitForSharedReady,
  probedNames,
  readStatusesWithin,
  sharedServiceDeadError,
  type RestartedService,
  type WaitForSharedHealth,
  type WaitForSharedReady,
} from "./health.js";
import {
  discoverInstances,
  readDerivedConfig,
  readWorktreePath,
  type DiscoverDeps,
  type InstanceInfo,
  type InstanceStatus,
} from "./instances.js";
import { SOCKET_WAIT_TIMEOUT_MS, pollForSocket, type LivenessProbe } from "./liveness.js";
import {
  openSharedLiveInstance,
  type LiveInstance,
  type LiveInstanceSeams,
  type OpenContext,
  type OpenOptions,
} from "./live-instance.js";
import { formatSharedFieldChangeWarning } from "./output.js";
import {
  SHARED_INSTANCE_ID,
  assertSocketPathFits,
  ensureLogsDir,
  ensureRunDir,
  instancePaths,
  logsDir,
  sharedInstancePaths,
  stateDir,
} from "./paths.js";
import { reapShutdownHooks, type ReapDeps, type ReapOutcome } from "./reaper.js";
import { readPendingReload } from "./reload-pending.js";
import {
  assertNoWorktreeLifecycleLocks,
  inFlightWorktrees,
  withSharedLock,
  writeSharedStepMarker,
} from "./registry.js";
import {
  declaredServices,
  isAlwaysOnShared,
  selectSharedServices,
  serviceNamespaces,
  sharedServicesOf,
  type DeclaredService,
  type DerivedProcesses,
} from "./selection.js";
import { dependencyOrder, findDeadServices } from "./service-state.js";
import {
  inProgressDependants,
  namespacedRecoveryRemedy,
  planSharedDown,
  recordedSharedEdges,
  removesLastRunning,
  sharedStepServices,
  stackSharedEdges,
  withoutProcesses,
  withoutServiceRecords,
  worktreeDependants,
  type SharedDependant,
  type SharedDownPlan,
  type WorktreeEdges,
} from "./shared-down.js";
import {
  UNKNOWN_REVISION,
  planSharedSelection,
  sharedRecords,
  withServiceRecords,
  type SharedPlan,
} from "./shared-drift.js";
import {
  blockingPortConflicts,
  inSharedBlock,
  liveSharedPortsOf,
  planSharedPorts,
  readSharedPortMap,
  readSharedPortMapFile,
  sharedPortMapFile,
  sharedPortOrigins,
  staleEnvWarning,
  writeSharedPortMap,
  type PortMapConflict,
  type SharedBlock,
  type SharedPortEntry,
  type SharedPortPlan,
} from "./shared-ports.js";
import {
  readSharedState,
  sharedFieldChanges,
  writeSharedState,
  type SharedFieldChange,
  type SharedServiceRecord,
  type SharedState,
} from "./shared-state.js";
import { loadStack, type ResolvedService, type ResolvedStack } from "./stack.js";
import { partitionRunning } from "./stop-services.js";

/** What the shared instance module needs from its caller: the anchor and the I/O seams. */
export interface SharedInstanceDeps {
  /** The anchor (the git common dir) the shared instance is rooted at. */
  readonly anchor: string;
  readonly driver: Driver;
  /**
   * The shared lifecycle lock every change to the shared instance runs
   * under. Default: the real lock, with a ~10s budget (`withSharedLock`).
   */
  readonly sharedLock?: WithSharedLock | undefined;
  /** The control-socket liveness probe (#80, #186). */
  readonly liveness: LivenessProbe;
  /** The control-socket probe the health waits use after a failed read (#205). */
  readonly probeSocket: (socketPath: string) => Promise<InstanceStatus>;
  readonly warn: (message: string) => void;
  /** Budget of the selected shared services' health wait (`--wait-timeout`). */
  readonly waitTimeoutMs: number;
  /** Budget of `up --dry-run`'s one `process list` read of the shared instance. */
  readonly previewReadTimeoutMs: number;
  /** Socket-bind wait window for the lazy start (issue #92). Default: 3s. */
  readonly socketTimeoutMs?: number | undefined;
  /** The selected shared services' health wait; default `createWaitForSharedReady`. */
  readonly waitForSharedReady?: WaitForSharedReady | undefined;
  /** The cross-tier health gate (ADR-0003); default `createWaitForSharedHealth`. */
  readonly waitForSharedHealth?: WaitForSharedHealth | undefined;
  /** The bounded stop's seams (#190), for the teardowns. */
  readonly stop?: StopSeams | undefined;
  /**
   * Discover the instances at the anchor, for a teardown's dependants and
   * `prune --shared-ports`'s holders. Default: `discoverInstances`.
   */
  readonly discover?: ((anchor: string, deps: DiscoverDeps) => Promise<InstanceInfo[]>) | undefined;
  /** Read a worktree's `devtrees.yaml`, for a pre-#239 instance's edges. Default: `loadStack`. */
  readonly readStack?: ((dir: string) => ResolvedStack) | undefined;
  /** Run the daemon shutdown hooks process-compose skipped (#155). Default: `reapShutdownHooks`. */
  readonly reap?: ((config: DerivedConfig, deps: ReapDeps) => Promise<ReapOutcome>) | undefined;
  /**
   * How long `down --shared -n` waits, outside the shared lock, for an
   * in-flight lifecycle command that uses its targets (#239). Default: 15s.
   */
  readonly lifecycleWaitMs?: number | undefined;
}

/** The shared side of one `up` (or its preview). */
export interface SharedRequest {
  readonly stack: ResolvedStack;
  readonly worktreeId: string;
  /**
   * The shared services the `up` selects (`UpSelection.shared`,
   * `selectSharedServices`): always-on, selected namespaced, and their shared
   * dependencies, in declaration order.
   */
  readonly selected: ReadonlyArray<ResolvedService>;
  /** The namespaces the `up` selects; they shape the remedy for broken shared services (#239). */
  readonly namespaces: ReadonlyArray<string>;
  /** How a shared named port resolves before the shared port map is consulted. */
  readonly seed: SharedPortSeed;
}

/** `ensure`'s request: the shared side of a real `up`. */
export interface EnsureRequest extends SharedRequest {
  /** Run the shared health wait before returning (the fresh path), not as `ready`. */
  readonly waitNow: boolean;
  /** The isolated services this `up` boots, for its shared-step marker; `undefined`: every one. */
  readonly booted?: ReadonlyArray<string> | undefined;
}

/** What `up --dry-run` previews of the shared instance. */
export interface SharedPreview {
  /** Shared named port → the number the real `up` would inject (the stable map, #238). */
  readonly portFor: (name: string) => number | undefined;
  /** The dead selected shared services the real `up` would restart (#240). */
  readonly wouldRestart: string[];
  /** What a lazy start would spawn; `undefined` when the stack has no shared tier. */
  readonly derived?: DerivedShared;
}

/** The shared ports `env` reports (#238). */
export interface SharedPorts {
  readonly ports: Readonly<Record<string, number>>;
  readonly origins: Record<string, SharedPortEntry>;
}

/** The shared instance, as every command that reaches it sees it. */
export interface SharedInstance {
  /**
   * Bring the selected shared services up (#236, #240, ADR-0010): lazy-start
   * the shared instance, add the selected namespaced services it lacks,
   * revive re-added ones and restart dead ones, all under the shared
   * lifecycle lock, after the scoped drift check. Writes the shared-step
   * marker, and records the shared port map once nothing refused.
   */
  ensure(request: EnsureRequest): Promise<SharedOutcome>;
  /** The same decisions, read-only, for `up --dry-run` (#210, #238, #240). */
  preview(request: SharedRequest): Promise<SharedPreview>;
  /**
   * The shared ports `env` injects, read-only, after the drift check of the
   * always-on shared services `up` would make (#83, #236). `undefined` when
   * the stack has no shared tier.
   */
  ports(request: Omit<SharedRequest, "selected" | "namespaces">): Promise<SharedPorts | undefined>;
  /** `down --shared`: stop the whole shared instance, under the shared lifecycle lock. */
  down(): Promise<SharedDownResult>;
  /**
   * `down --shared -n`: stop and remove only the named namespaces' shared
   * services (#239, ADR-0012), under the shared lifecycle lock.
   */
  downNamespaces(options: SharedNamespaceDownOptions): Promise<SharedNamespaceDownResult>;
  /** `down --shared -n --dry-run`: the same reads, no lock, no effect (#239). */
  previewDownNamespaces(options: SharedNamespaceDownOptions): Promise<SharedNamespaceDownPreview>;
  /**
   * The shared port map as `ls` reports it (#238); `running`: discovery found
   * the shared instance running.
   */
  portMap(running: boolean): Record<string, SharedPortEntry>;
  /** `prune --shared-ports` (#238, ADR-0011), or its `--dry-run`. */
  prunePorts(request: PrunePortsRequest): Promise<PruneSharedPortsResult>;
  /**
   * The shared instance's control socket and derived config, for `attach`
   * and `logs`; `undefined` when no socket file is there (not probed).
   */
  endpoint(): InstanceRef | undefined;
  /**
   * The shared services the shared derived config declares, with their
   * namespaces: what the shared instance was last given, not this
   * worktree's `devtrees.yaml`. Empty when there is no config.
   */
  services(): DeclaredService[];
}

/** Open the shared instance anchored at `deps.anchor`. */
export function openSharedInstance(deps: SharedInstanceDeps): SharedInstance {
  return {
    ensure: (request) => prepareShared(deps, request),
    preview: (request) => previewShared(deps, request),
    ports: (request) => readPorts(deps, request),
    down: () => down(deps),
    downNamespaces: (options) => downNamespaces(deps, options),
    previewDownNamespaces: (options) => previewDownNamespaces(deps, options),
    portMap: (running) => portMap(deps.anchor, running),
    prunePorts: (request) => prunePorts(deps, request),
    endpoint: () => endpoint(deps.anchor),
    services: () =>
      declaredServices(
        readDerivedConfig(sharedInstancePaths(deps.anchor).configPath)?.processes as
          | DerivedProcesses
          | undefined,
      ),
  };
}

/** The control socket and derived config of a shared instance whose socket file is there. */
function endpoint(anchor: string): InstanceRef | undefined {
  const paths = sharedInstancePaths(anchor);
  if (!existsSync(paths.socketPath)) return undefined;
  return { configPath: paths.configPath, socketPath: paths.socketPath };
}

/**
 * The shared lifecycle lock gets the same ~10s budget as a worktree's
 * (#240): besides a lazy start's spawn and socket wait, or an add's reload,
 * its holder may now be restarting dead shared services (each `process
 * start` bounded at 10s). A concurrent `up` from another worktree should wait
 * that out and then find them running, not fail `LOCK_CONTENTION` after the
 * registry lock's ~1s.
 */
const SHARED_LOCK_OPTIONS = { retries: 100, retryDelayMs: 100 } as const;

/** The injected shared lifecycle lock, else the real one. */
function lockOf(deps: SharedInstanceDeps): WithSharedLock {
  return deps.sharedLock ?? ((anchor, fn) => withSharedLock(anchor, fn, SHARED_LOCK_OPTIONS));
}

/** Does the stack declare any shared service? */
function hasSharedTier(stack: ResolvedStack): boolean {
  return sharedServicesOf(stack).length > 0;
}

/**
 * `up --dry-run`'s shared side: the stable shared port map's numbers, read
 * and never recorded, the dead selected services the real `up` would
 * restart, and what a lazy start would spawn (the selected services only,
 * #236). Raises the `SHARED_PORT_CONFLICT` the real `up` would.
 */
async function previewShared(
  deps: SharedInstanceDeps,
  request: SharedRequest,
): Promise<SharedPreview> {
  const { stack, seed, selected } = request;
  if (!hasSharedTier(stack)) {
    return { portFor: seed.positional, wouldRestart: [] };
  }
  const { ports } = previewSharedPorts({
    command: "up --dry-run",
    anchor: deps.anchor,
    stack,
    seed,
    running: await sharedSocketLive(deps),
    warn: deps.warn,
  });
  const portFor = (name: string) => ports[name];
  const wouldRestart = await previewSharedRestarts(deps, stack, selected);
  const derived = deriveSharedConfig(stack, {
    workingDir: deps.anchor,
    anchor: deps.anchor,
    portFor,
    services: selected.map((s) => s.name),
  });
  return { portFor, wouldRestart, derived };
}

/**
 * `env`'s shared ports (#238), from the stable shared port map reconciled
 * with the running instance's numbers (#83): read, never written, so a name
 * no `up` has recorded yet is reported `predicted`. When the shared socket is
 * live, fail with SHARED_DRIFT when an always-on shared service diverges,
 * exactly as `up` would, instead of reporting connection info that is wrong.
 * `env` takes no `-n`, so only the always-on shared services (no
 * `namespace:`) are checked (#236). A probe, not the socket file: a leftover
 * socket is not a running instance.
 */
async function readPorts(
  deps: SharedInstanceDeps,
  request: Omit<SharedRequest, "selected" | "namespaces">,
): Promise<SharedPorts | undefined> {
  const { stack } = request;
  if (!hasSharedTier(stack)) return undefined;
  const running = await sharedSocketLive(deps);
  if (running) {
    const state = readRecordedSharedState(deps.anchor, stack);
    if (state !== undefined) {
      const plan = planSharedSelection(selectSharedServices(stack, []), state.services);
      assertSharedPlanClean(plan, { worktreeId: request.worktreeId, state, stack });
    }
  }
  return previewSharedPorts({
    command: "env",
    anchor: deps.anchor,
    stack,
    seed: request.seed,
    running,
    warn: deps.warn,
  });
}

/** Type of the async shared lifecycle lock the caller passes for testability. */
export type WithSharedLock = <T>(anchor: string, fn: () => Promise<T>) => Promise<T>;

/** The shared-tier outcome of one `up` (#236): what it started, added and injects. */
export interface SharedOutcome {
  /** This `up` lazy-started the shared instance. */
  readonly started: boolean;
  /** Namespaced shared services this `up` added to the running shared instance. */
  readonly activated: ReadonlyArray<string>;
  /** Dead selected shared services this `up` restarted (#240). */
  readonly restarted: ReadonlyArray<string>;
  /**
   * Wait for the selected shared services to be healthy (#240), including
   * in a shared instance this `up` just started (#262). The caller
   * decides when to run it: on the fresh path inside the worktree lifecycle
   * lock, before the worktree spawns; on the running path after the lock is
   * released, like the rest of verification (ADR-0008).
   */
  readonly ready: () => Promise<void>;
  /**
   * The cross-tier health gate (ADR-0003): wait for the selected shared
   * services' readiness before the worktree instance spawns, with a notice
   * naming them. The caller runs it when its worktree config dropped a
   * cross-tier `depends_on` edge; nothing to wait for when none is selected.
   */
  readonly awaitDependencies: () => Promise<void>;
  readonly fieldChanges: ReadonlyArray<SharedFieldChange>;
  /** Shared named port → the number to inject. */
  readonly portFor: (name: string) => number | undefined;
  /** The shared services this `up` selects, in declaration order. */
  readonly selected: ReadonlyArray<ResolvedService>;
}

/**
 * Bring the shared tier to what this `up` selects (#236, ADR-0010): lazy-start
 * the shared instance or add the selected namespaced shared services it lacks,
 * and restart the selected ones it runs that are dead (#240, ADR-0008), all
 * under the shared lifecycle lock (`ensureSharedStarted`).
 *
 * A wait (run here with `waitNow`, else returned as the outcome's `ready`)
 * waits for every selected shared service to be healthy
 * (`createWaitForSharedReady`): the ones this `up` started, restarted or
 * added, and any another worktree's `up` restarted that has not passed its
 * readiness probe yet. Without that wait an `up` racing the restart would
 * read the service `Running`, restart nothing, and report success before it
 * serves; and a lazy start whose shared service exited at once would be
 * reported started (#262). A lazy-started instance that is gone by then
 * exited on its own: `SHARED_START_FAILED`.
 */
async function prepareShared(
  deps: SharedInstanceDeps,
  request: EnsureRequest,
): Promise<SharedOutcome> {
  const { stack, seed, selected } = request;
  const { anchor } = deps;
  const ready = async (): Promise<void> => {};
  if (!hasSharedTier(stack)) {
    // No shared step: this `up` uses no shared service and injects no shared
    // port. Written without the shared lock, since nothing it claims can
    // change under a teardown (#244 follow-up).
    writeSharedStepMarker(anchor, request.worktreeId, { services: [], ports: [] });
    return {
      started: false,
      activated: [],
      restarted: [],
      ready,
      awaitDependencies: ready,
      fieldChanges: [],
      portFor: seed.positional,
      selected: [],
    };
  }
  const ensured = await ensureSharedStarted(
    anchor,
    stack,
    request.worktreeId,
    selected,
    seed,
    lockOf(deps),
    {
      driver: deps.driver,
      seams: liveSeams(deps),
      socketTimeoutMs: deps.socketTimeoutMs,
      warn: deps.warn,
      remedyFor: sharedRemedyFor(stack, request.namespaces, anchor),
      stepServices: sharedStepServices(
        stack,
        selected.map((s) => s.name),
        request.booted,
      ),
    },
  );
  const wait = () => waitSharedReady(deps, request, ensured);
  if (request.waitNow) await wait();
  const ports = ensured.ports;
  return {
    started: ensured.started,
    activated: ensured.activated,
    restarted: ensured.restarted.map((r) => r.name),
    ready: request.waitNow ? ready : wait,
    awaitDependencies: () => waitForDependencies(deps, request),
    fieldChanges: ensured.fieldChanges,
    portFor: ports === undefined ? seed.positional : (name) => ports[name],
    selected,
  };
}

/**
 * Wait, with `--wait-timeout`, for the selected shared services of an
 * already-running shared instance to be healthy (#240). A healthy instance
 * costs one `process list` read.
 */
async function waitSharedReady(
  deps: SharedInstanceDeps,
  request: SharedRequest,
  ensured: Pick<EnsuredShared, "started" | "restarted">,
): Promise<void> {
  const { selected } = request;
  const { restarted } = ensured;
  const paths = sharedInstancePaths(deps.anchor);
  if (restarted.length > 0) {
    deps.warn(
      `devtrees up: restarted dead shared service(s): ${restarted.map((r) => r.name).join(", ")}; ` +
        `waiting for them to be healthy...`,
    );
  }
  const wait =
    deps.waitForSharedReady ??
    createWaitForSharedReady(deps.driver, { notify: deps.warn, probe: deps.probeSocket });
  await wait({
    socketPath: paths.socketPath,
    serviceNames: selected.map((s) => s.name),
    restarted,
    probedServiceNames: probedNames(selected),
    timeoutMs: deps.waitTimeoutMs,
    remedyFor: sharedRemedyFor(request.stack, request.namespaces, deps.anchor),
  }).catch((err: unknown) => {
    // A shared instance this `up` just started that is gone already exited on
    // its own (#262): process-compose exits once nothing runs, so every shared
    // service it started died at once. That is a failed start, not a `down`.
    if (!ensured.started || (err as { code?: unknown }).code !== "INSTANCE_NOT_FOUND") throw err;
    throw sharedStartFailed(paths, deps.socketTimeoutMs ?? SOCKET_WAIT_TIMEOUT_MS, true);
  });
}

/**
 * Shared-health wait: gate the worktree start on the selected shared
 * services' readiness probes, the orchestration-layer stand-in for the
 * cross-tier `depends_on` edge process-compose can't express across
 * instances (ADR-0003). Only the selected shared services are waited on
 * (#236): an unselected namespaced one is not running for this worktree, so
 * an edge to it is dropped like any other cross-tier edge and gates nothing.
 */
async function waitForDependencies(
  deps: SharedInstanceDeps,
  request: SharedRequest,
): Promise<void> {
  const { selected } = request;
  if (selected.length === 0) return;
  const names = selected.map((s) => s.name);
  deps.warn(formatHealthWaitNotice(names));
  const wait =
    deps.waitForSharedHealth ??
    createWaitForSharedHealth(deps.driver, { notify: deps.warn, probe: deps.probeSocket });
  await wait({
    anchor: deps.anchor,
    socketPath: sharedInstancePaths(deps.anchor).socketPath,
    sharedServiceNames: names,
    probedServiceNames: probedNames(selected),
    remedyFor: sharedRemedyFor(request.stack, request.namespaces, deps.anchor),
  });
}

/**
 * The dead selected shared services the real `up` would restart (#240),
 * decided as `reconcileLiveShared` decides them but read-only: no lock, no
 * start, no socket unlinked. Empty whenever the real `up` would restart
 * nothing on the shared instance — it is not running or not readable (a
 * liveness that stays unknown included; the real `up` would fail
 * `INSTANCE_UNRESPONSIVE`), it records no state, or a selected service
 * drifted (`SHARED_DRIFT`). It cannot preview a refused start or a restart
 * that dies again.
 */
async function previewSharedRestarts(
  deps: SharedInstanceDeps,
  stack: ResolvedStack,
  selected: ReadonlyArray<ResolvedService>,
): Promise<string[]> {
  if (selected.length === 0) return [];
  const { anchor } = deps;
  const shared = await openSharedReadOnly(deps);
  if (shared === undefined) return [];
  const state = readRecordedSharedState(anchor, stack);
  if (state === undefined) return [];
  const plan = planSharedSelection(selected, state.services);
  if (plan.drifted.length > 0 || plan.portConflicts.length > 0) return [];
  const rows = await shared.tryRows(deps.previewReadTimeoutMs);
  if (rows === undefined) return [];
  const added = new Set(servicesToAdd(selected, plan, state, rows).map((s) => s.name));
  const names = selected.map((s) => s.name).filter((name) => !added.has(name));
  return dependencyOrder(
    stack.services,
    findDeadServices(rows, names).map((d) => d.name),
  );
}

/** A read-only liveness probe of the shared socket: unlinks nothing, and unknown reads as down. */
async function sharedSocketLive(deps: SharedInstanceDeps): Promise<boolean> {
  return (await openSharedReadOnly(deps)) !== undefined;
}

/** The shared instance opened read-only (#259): a stale file is kept, and unknown reads as down. */
async function openSharedReadOnly(deps: SharedInstanceDeps): Promise<LiveInstance | undefined> {
  return await openShared(deps, { command: "up" }, { readOnly: true }).catch(() => undefined);
}

/** Open the shared instance through the live instance handle (#259). */
async function openShared(
  deps: SharedInstanceDeps,
  context: OpenContext,
  options: OpenOptions = {},
): Promise<LiveInstance | undefined> {
  return await openSharedLiveInstance(deps.anchor, liveSeams(deps), context, options);
}

/** The live instance handle's seams over the shared instance module's. */
function liveSeams(deps: SharedInstanceDeps): LiveInstanceSeams {
  return { driver: deps.driver, liveness: deps.liveness, probeSocket: deps.probeSocket };
}

/**
 * The shared ports a read-only command (`env`, `up --dry-run`) reports (#238):
 * the stable map's plan, without recording it, and each port's origin. Raises
 * the `SHARED_PORT_CONFLICT` an `up` of this stack would; a stale env entry
 * only blocks an `up` that adds its service, so it is not raised here.
 */
function previewSharedPorts(args: {
  readonly command: "env" | "up --dry-run";
  readonly anchor: string;
  readonly stack: ResolvedStack;
  readonly seed: SharedPortSeed;
  readonly running: boolean;
  readonly warn: (message: string) => void;
}): { ports: Readonly<Record<string, number>>; origins: Record<string, SharedPortEntry> } {
  const plan = readSharedPortPlan(args.anchor, args.stack, args.seed, args.running, args.warn);
  assertSharedPortsClean({ ...args, portPlan: plan, binding: [] });
  const active = args.running ? (readSharedState(args.anchor)?.ports ?? {}) : {};
  return {
    ports: plan.ports,
    origins: sharedPortOrigins(plan.ports, plan.recorded, active),
  };
}

/**
 * Outcome of `ensureSharedStarted`: whether THIS call lazy-started the shared
 * instance, which selected shared services it added to the running one
 * (#236), and the authoritative name→port map worktrees must inject for
 * shared services (issue #83). `ports` is `undefined` only on the legacy
 * fallback — a shared instance started by a pre-#83 devtrees whose anchor
 * state has no persisted map; the caller falls back to positional offsets.
 */
interface EnsuredShared {
  readonly started: boolean;
  /**
   * Shared services this call added to an already-running shared
   * instance (#236), in declaration order: selected services it did not run,
   * including ones recorded by an earlier add whose reload timed out and never
   * landed. Empty when it started the instance (`started`), or when everything
   * selected was already running.
   */
  readonly activated: ReadonlyArray<string>;
  /**
   * Dead selected shared services this call started again on the running
   * shared instance (#240), in the order started (`depends_on`), each with
   * the pid of the run that died. Empty when it started the instance itself.
   */
  readonly restarted: ReadonlyArray<RestartedService>;
  /** Extended shared fields edited since the running instance started (#185). */
  readonly fieldChanges: ReadonlyArray<SharedFieldChange>;
  readonly ports?: Readonly<Record<string, number>>;
}

/** How a shared named port resolves before the running instance is consulted. */
export interface SharedPortSeed {
  /** This worktree's positional number for a shared named port. */
  readonly positional: (name: string) => number | undefined;
  /** The repo-wide shared block; `undefined` when the stack has no shared tier. */
  readonly block: SharedBlock | undefined;
}

/** What `ensureSharedStarted` needs besides the stack and the selection. */
interface EnsureSharedDeps {
  readonly driver: Driver;
  /** The live instance handle's seams (#259), for the shared instance's liveness and reads. */
  readonly seams: LiveInstanceSeams;
  /** Socket-bind wait window for the lazy start (issue #92). Default: 3s. */
  readonly socketTimeoutMs?: number;
  /** Sink for the shared-field-change warnings (#185). */
  readonly warn: (message: string) => void;
  /** The remedy for broken or drifted selected shared services (#239). */
  readonly remedyFor?: (services: ReadonlyArray<string>) => string;
  /**
   * The shared services the shared-step marker names (#244 follow-up): the
   * selected ones plus the shared targets of the booted isolated services'
   * cross-tier edges (`sharedStepServices`). Default: the selected ones.
   */
  readonly stepServices?: ReadonlyArray<string>;
}

/**
 * Idempotently lazy-start the shared instance with the shared services this
 * `up` selects, or add the selected ones it does not run yet. Under the shared
 * lifecycle lock, so two simultaneous callers see a consistent answer and at
 * most one starts (or extends) the instance.
 *
 * Liveness is probed, not inferred from the socket file (#80): a SIGKILLed
 * shared instance leaves its socket behind, and trusting the file would make
 * the shared instance unrestartable without hand-deleting it. A stale socket
 * is unlinked and we fall through to the fresh start.
 *
 * The running instance is the source of truth for shared ports (issue #83):
 *
 *  - On start, the name→port map it binds and the revision of each shared
 *    service it runs are persisted in anchor state (`shared-state.json`).
 *  - On the already-running branch, each SELECTED shared service is checked
 *    against its recorded revision — divergence throws `SHARED_DRIFT` instead
 *    of letting the caller inject numbers the instance never bound (#83);
 *    a shared service the `up` does not select is not checked (#236) — and
 *    the persisted map is returned for injection.
 *  - A selected namespaced shared service the instance does not run yet is
 *    added to it (#236, ADR-0010): its process is appended to the shared
 *    derived config and process-compose re-reads it. The processes already in
 *    that config are kept byte-for-byte, so process-compose leaves them
 *    running; it only starts the new ones.
 *
 * With nothing selected (every shared service is namespaced and none is
 * selected) a stopped shared instance is not started.
 */
async function ensureSharedStarted(
  anchor: string,
  stack: ResolvedStack,
  worktreeId: string,
  selected: ReadonlyArray<ResolvedService>,
  seed: SharedPortSeed,
  sharedLock: WithSharedLock,
  deps: EnsureSharedDeps,
): Promise<EnsuredShared> {
  return await sharedLock(anchor, async () => {
    // Unknown liveness (#186) fails INSTANCE_UNRESPONSIVE rather than
    // lazy-starting a second shared instance onto the same ports.
    const shared = await openSharedLiveInstance(anchor, deps.seams, { command: "up" });
    const live = shared !== undefined;
    // The stable shared port map (#238): read and reconciled under the shared
    // lock, so two `up`s from different branches cannot both assign a name.
    const portPlan = readSharedPortPlan(anchor, stack, seed, live, deps.warn);
    // The shared-step marker (#244 follow-up): under the shared lock, before
    // anything is started, name the shared services this `up` uses (the ones
    // it selected, and the ones its booted isolated services depend on, which
    // selection never pulls in) and the shared ports it injects. A `down
    // --shared -n` (also under this lock) then waits for this worktree only
    // when it targets one of them, and `prune --shared-ports` keeps those
    // ports. Cleared with the worktree lifecycle lock.
    writeSharedStepMarker(anchor, worktreeId, {
      services: deps.stepServices ?? selected.map((s) => s.name),
      ports: portNamesOf(sharedServicesOf(stack)),
    });
    const step = { anchor, stack, selected, portPlan, deps };
    if (shared !== undefined) return await reconcileLiveShared({ ...step, worktreeId, shared });
    // A fresh start binds every selected service's ports.
    assertSharedPortsClean({ command: "up", ...step, binding: selected, warn: deps.warn });
    recordSharedPorts(anchor, portPlan);
    if (selected.length === 0) {
      return {
        started: false,
        activated: [],
        restarted: [],
        fieldChanges: [],
        ports: portPlan.ports,
      };
    }
    return await startShared(step);
  });
}

/** Inputs shared by the start and reconcile branches of `ensureSharedStarted`. */
interface SharedStep {
  readonly anchor: string;
  readonly stack: ResolvedStack;
  readonly selected: ReadonlyArray<ResolvedService>;
  /** The shared ports, from the stable map (#238). */
  readonly portPlan: SharedPortPlan;
  readonly deps: EnsureSharedDeps;
}

/**
 * The shared instance is running: check the selected shared services against
 * what it runs, then add the selected ones it lacks (#236).
 */
async function reconcileLiveShared(
  step: SharedStep & { readonly worktreeId: string; readonly shared: LiveInstance },
): Promise<EnsuredShared> {
  const { anchor, stack, selected, portPlan, deps, shared } = step;
  const ports = portPlan.ports;
  const state = readRecordedSharedState(anchor, stack);
  // Legacy fallback: a pre-#83 shared instance left no persisted state. Its
  // ports come from the stable map, seeded from its derived config (#238), as
  // long as nothing has to be added: what that instance runs cannot be known.
  if (state === undefined) {
    assertSharedPortsClean({ command: "up", ...step, binding: [], warn: deps.warn });
    const legacy = await legacySharedInstance(selected, anchor, shared);
    recordSharedPorts(anchor, portPlan);
    return { ...legacy, ports };
  }
  const plan = planSharedSelection(selected, state.services);
  // Drift first (#240): a drifted selected service fails SHARED_DRIFT before
  // anything is restarted or added, since a restart would run the instance's
  // definition, not this worktree's.
  assertSharedPlanClean(plan, {
    worktreeId: step.worktreeId,
    state,
    stack,
    ...(deps.remedyFor !== undefined ? { remedyFor: deps.remedyFor } : {}),
  });
  const selectedNames = selected.map((s) => s.name);
  const fieldChanges = sharedFieldChanges(state, pick(sharedExtendedFields(stack), selectedNames));
  for (const change of fieldChanges) deps.warn(formatSharedFieldChangeWarning(change));
  // One read, under the shared lock, decides both what to add and what to
  // restart: a concurrent `up` from another worktree waits for this one and
  // then reads the services it restarted as running.
  // One `process list` read; `undefined` when it cannot be read. Lets a
  // retried `up` see a service a timed-out add recorded but process-compose
  // never started (#236).
  const rows = await readSelectedSharedRows(selected, plan, state, shared);
  const toAdd = servicesToAdd(selected, plan, state, rows);
  // Port conflicts after drift and before anything changes (#238): an added
  // service binds its recorded ports, which must not be another name's or
  // differ from what a running shared process was given for them. Only then
  // is the map recorded, so a refused `up` records nothing.
  assertSharedPortsClean({ command: "up", ...step, binding: toAdd, warn: deps.warn });
  recordSharedPorts(anchor, portPlan);
  // Restart before adding: a service being added may `depends_on` a dead one.
  // Only the dead selected services the instance already runs (#240,
  // ADR-0008), with rows read under the shared lock, so two worktrees racing
  // start each one once: the second reads the first's restart as running.
  // Dead versus done is `classifyService`'s (an exit-0 one-shot is never
  // rerun, a `Restarting` one is left to process-compose), and a running
  // shared service is never stopped, restarted or reloaded: other worktrees
  // use it. A refused start is `SHARED_SERVICE_DEAD` `start_refused`.
  const restarted = await shared.restartDead({
    rows: rows ?? [],
    names: selectedNames.filter((name) => !toAdd.some((s) => s.name === name)),
    order: stack.services,
    remedyFor: deps.remedyFor,
  });
  if (toAdd.length === 0) {
    return { started: false, activated: [], restarted, ports, fieldChanges };
  }
  // Read before the add: a process the instance already lists is one a
  // removal (`down --shared -n`, #239) stopped but whose reload never landed.
  const before = rows ?? (await shared.tryRows());
  await activateShared({ ...step, state, missing: toAdd, ports });
  const revived = await reviveReAdded(step, toAdd, before ?? []);
  return {
    started: false,
    activated: toAdd.map((s) => s.name),
    restarted: [...restarted, ...revived],
    ports,
    fieldChanges,
  };
}

/**
 * Start the added services the shared instance already listed, stopped
 * (#239): a `down --shared -n` stopped them, and its removing reload timed
 * out and never landed. The add re-sends their unchanged definition, so
 * process-compose's reload leaves them as they are, stopped. Started like a
 * dead shared service (#240), and waited on with them.
 */
async function reviveReAdded(
  step: SharedStep & { readonly shared: LiveInstance },
  added: ReadonlyArray<ResolvedService>,
  before: ReadonlyArray<ServiceStatus>,
): Promise<RestartedService[]> {
  const listed = new Set(before.map((r) => r.name));
  return await step.shared.restartDead({
    rows: before,
    names: added.map((s) => s.name).filter((name) => listed.has(name)),
    order: step.stack.services,
    remedyFor: step.deps.remedyFor,
  });
}

/**
 * One `process list` read of the running shared instance, when some selected
 * shared service is recorded as running there (`undefined` otherwise, or when
 * the read fails). Nothing recorded means nothing to restart or re-add.
 */
async function readSelectedSharedRows(
  selected: ReadonlyArray<ResolvedService>,
  plan: SharedPlan,
  state: RecordedSharedState,
  shared: LiveInstance,
): Promise<ServiceStatus[] | undefined> {
  const missing = new Set(plan.missing.map((s) => s.name));
  const recorded = selected.some((s) => !missing.has(s.name) && state.services[s.name]);
  return recorded ? await shared.tryRows() : undefined;
}

/**
 * The selected shared services to add to the running instance: the ones it
 * has no record of, plus — when its `process list` could be read (`rows`) —
 * recorded ones it does not actually run. The second kind is a service an
 * earlier add recorded after its reload timed out, which process-compose
 * never applied: a retried `up` re-sends the reload rather than trusting the
 * record. A missing row is otherwise invisible: the dead-service check counts
 * "no row" as not dead.
 */
function servicesToAdd(
  selected: ReadonlyArray<ResolvedService>,
  plan: SharedPlan,
  state: RecordedSharedState,
  rows: ReadonlyArray<ServiceStatus> | undefined,
): ResolvedService[] {
  const missing = new Set(plan.missing.map((s) => s.name));
  const recorded = selected.filter((s) => !missing.has(s.name) && state.services[s.name]);
  const present = new Set((rows ?? []).map((r) => r.name));
  const absent = new Set(
    rows === undefined ? [] : recorded.filter((s) => !present.has(s.name)).map((s) => s.name),
  );
  return selected.filter((s) => missing.has(s.name) || absent.has(s.name));
}

/**
 * A running shared instance started by a devtrees older than #83 left no
 * state, so what it runs is unknown. Always-on shared services keep the old
 * positional fallback; a selected namespaced one cannot be added safely and
 * fails `SHARED_ACTIVATION_FAILED` instead of an `up` that silently runs
 * without it. A dead selected one is reported, not restarted
 * (`SHARED_SERVICE_DEAD`, `reason: "unknown_revision"`): with no recorded
 * revision there is no drift check to make before a restart (#240).
 */
async function legacySharedInstance(
  selected: ReadonlyArray<ResolvedService>,
  anchor: string,
  shared: LiveInstance,
): Promise<EnsuredShared> {
  const namespaced = selected.filter((s) => !isAlwaysOnShared(s)).map((s) => s.name);
  if (namespaced.length > 0) {
    throw new SharedActivationFailedError(
      `devtrees up: cannot add shared service(s) ${namespaced.map((s) => `'${s}'`).join(", ")} ` +
        `to the running shared instance: it was started by a devtrees that records no shared ` +
        `state, so what it runs is unknown. Nothing was changed. Next: ` +
        `${SHARED_DRIFT_REMEDY} (for every worktree).`,
      {
        services: namespaced,
        reason: "not_supported",
        config_path: sharedInstancePaths(anchor).configPath,
        remedy: `${SHARED_DRIFT_REMEDY} (for every worktree)`,
      },
    );
  }
  const rows = selected.length > 0 ? await shared.tryRows() : undefined;
  const dead = findDeadServices(
    rows ?? [],
    selected.map((s) => s.name),
  );
  if (dead.length > 0) throw sharedServiceDeadError(dead, { reason: "unknown_revision" });
  return { started: false, activated: [], restarted: [], fieldChanges: [] };
}

/** Lazy-start the shared instance with exactly the selected shared services. */
async function startShared(step: SharedStep): Promise<EnsuredShared> {
  const { anchor, stack, selected, portPlan, deps } = step;
  const paths = sharedInstancePaths(anchor);
  // Same bind-site guard the worktree instance gets (issue #156) — the
  // shared socket lives in the same run dir, so a run dir that is too long
  // for `sun_path` breaks both instances and must say so, not time out.
  assertSocketPathFits(paths.socketPath);

  // The stable map (#238): a name some earlier `up` predicted keeps its number.
  const ports = portPlan.ports;
  const derived = deriveSharedConfig(stack, {
    workingDir: anchor,
    anchor,
    portFor: (name) => ports[name],
    services: selected.map((s) => s.name),
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
  const subset = { ...stack, services: [...selected] };
  writeSharedState(anchor, {
    // The pre-#236 whole-subset hash, over the always-on shared services
    // only: a devtrees older than #236 compares its own (always-on only)
    // shared subset against this, so it keeps working beside this instance.
    hash: sharedStackHash({ ...stack, services: selected.filter(isAlwaysOnShared) }),
    ports: pick(ports, portNamesOf(selected)),
    extended: sharedExtendedFields(subset),
    services: sharedRecords(selected),
  });
  return { started: true, activated: [], restarted: [], ports, fieldChanges: [] };
}

/**
 * Add `missing` shared services to the running shared instance (#236,
 * ADR-0010). The shared derived config on disk is what the instance runs; its
 * processes are kept exactly as they are and the new ones appended, so
 * process-compose's reload sees the old ones unchanged and leaves them
 * running (verified on v1.122.0: same PIDs before and after) while it starts
 * the new ones. Then the new services are recorded in the shared state.
 *
 * On a refused reload the previous config is restored and nothing is
 * recorded. On a timed-out one the new config stays and the services are
 * recorded: process-compose may still be applying it, and a later reload
 * from a config without them would stop them again. A retried `up` that
 * finds a recorded service absent from the instance re-sends the reload
 * (`servicesToAdd`); it is idempotent, the config already holds the process.
 */
async function activateShared(
  step: SharedStep & {
    readonly state: RecordedSharedState;
    readonly missing: ReadonlyArray<ResolvedService>;
    readonly ports: Readonly<Record<string, number>>;
  },
): Promise<void> {
  const { anchor, stack, state, missing, ports, deps } = step;
  const paths = sharedInstancePaths(anchor);
  const names = missing.map((s) => s.name);
  const previousYaml = existsSync(paths.configPath)
    ? readFileSync(paths.configPath, "utf8")
    : undefined;
  const previous = previousYaml === undefined ? undefined : readDerivedConfig(paths.configPath);
  if (previousYaml === undefined || previous === undefined) {
    throw activationFailed(names, "error", paths.configPath, "its derived config is missing");
  }
  const added = deriveSharedConfig(stack, {
    workingDir: anchor,
    anchor,
    portFor: (name) => ports[name],
    services: names,
  }).config;
  ensureLogsDir(stack, logsDir(anchor, SHARED_INSTANCE_ID), "shared");
  const merged = mergeDerived(previous, added);
  writeFileSync(paths.configPath, stringifyYaml(merged), "utf8");

  // Same budget as a worktree hot-reload (#188): the base plus the merged
  // config's shutdown timeouts. An add stops nothing, so it rarely matters.
  const reload = await deps.driver.reloadConfig(
    { configPath: paths.configPath, socketPath: paths.socketPath },
    { timeoutMs: reloadTimeoutMs(merged) },
  );
  if (!reload.ok && reload.reason !== "timeout") {
    writeFileSync(paths.configPath, previousYaml, "utf8");
    throw activationFailed(names, reload.reason, paths.configPath, reload.message);
  }
  writeSharedState(anchor, {
    hash: state.hash,
    ports: { ...state.ports, ...pick(ports, portNamesOf(missing)) },
    extended: { ...state.extended, ...sharedExtendedFields({ ...stack, services: [...missing] }) },
    services: { ...state.services, ...sharedRecords(missing) },
  });
  if (!reload.ok) {
    throw activationFailed(names, reload.reason, paths.configPath, reload.message);
  }
}

/**
 * A derived config with `added`'s processes appended to `base`'s. `base`'s
 * own processes are kept as they are, so a reload restarts none of them.
 */
function mergeDerived(base: DerivedConfig, added: DerivedConfig): DerivedConfig {
  const baseMeta = base[DEVTREES_METADATA_KEY]?.ports_by_service ?? {};
  const addedMeta = added[DEVTREES_METADATA_KEY].ports_by_service;
  return {
    ...base,
    processes: { ...base.processes, ...added.processes },
    [DEVTREES_METADATA_KEY]: { ports_by_service: { ...baseMeta, ...addedMeta } },
  };
}

function activationFailed(
  services: ReadonlyArray<string>,
  reason: "not_supported" | "error" | "timeout",
  configPath: string,
  cause: string | undefined,
): SharedActivationFailedError {
  const outcome =
    reason === "timeout"
      ? "did not finish within its budget; process-compose may still be starting them"
      : "was refused, and the shared config was restored";
  const remedy =
    reason === "timeout" ? "retry `devtrees up`" : `${SHARED_DRIFT_REMEDY} (for every worktree)`;
  return new SharedActivationFailedError(
    `devtrees up: adding shared service(s) ${services.map((s) => `'${s}'`).join(", ")} ` +
      `to the running shared instance ${outcome}` +
      `${cause !== undefined ? ` (${cause})` : ""}. The shared services it already ran are ` +
      `untouched. Next: ${remedy}.`,
    { services: [...services], reason, config_path: configPath, remedy },
  );
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
  throw sharedStartFailed({ socketPath, configPath }, timeoutMs, false);
}

/**
 * `SHARED_START_FAILED` for a lazy start that never bound its control socket
 * (`bound: false`, #92), or bound it and then exited because every shared
 * service it started had exited (`bound: true`, #262). Which one a crashing
 * command produces is a race (the socket lives for a few ms), so both carry
 * the same details and the same remedy.
 */
function sharedStartFailed(
  paths: { readonly socketPath: string; readonly configPath: string },
  timeoutMs: number,
  bound: boolean,
): SharedStartFailedError {
  const what = bound
    ? "bound its control socket and then exited: process-compose exits once nothing runs, " +
      "so every shared service it started most likely exited at once"
    : `did not bind its control socket within ${timeoutMs}ms — it most likely crashed on startup`;
  return new SharedStartFailedError(
    `devtrees up: the shared instance was spawned but ${what}. ` +
      `Check the shared services' commands (e.g. run ` +
      `\`process-compose -f ${paths.configPath}\` by hand) and retry \`devtrees up\`.`,
    { socket_path: paths.socketPath, config_path: paths.configPath, timeout_ms: timeoutMs },
  );
}

/** Single notice that the worktree start is gated on the shared-health wait. */
function formatHealthWaitNotice(sharedNames: ReadonlyArray<string>): string {
  return (
    `devtrees: waiting for shared services to be healthy ` +
    `[${sharedNames.join(", ")}] before starting this worktree's instance...`
  );
}

/** Remedy for drift in the shared instance: restart it from this worktree's config. */
const SHARED_DRIFT_REMEDY = "devtrees down --shared && devtrees up";

/**
 * The remedy for broken or drifted shared services (#239): the forced
 * namespaced teardown `namespacedRecoveryRemedy` builds, else the full one.
 * Its namespaces come from the running shared derived config, read when the
 * remedy is built, because that is what the teardown selects its targets
 * from: in the drift case it is not this worktree's `devtrees.yaml`.
 */
function sharedRemedyFor(
  stack: ResolvedStack,
  upNamespaces: ReadonlyArray<string>,
  anchor: string,
): (services: ReadonlyArray<string>) => string {
  return (names) =>
    namespacedRecoveryRemedy(
      stack,
      upNamespaces,
      names,
      readDerivedConfig(sharedInstancePaths(anchor).configPath),
    ) ?? SHARED_DRIFT_REMEDY;
}

/** First 12 hex chars of a revision, for prose; the envelope carries it whole. */
function shortRevision(hash: string): string {
  return hash === UNKNOWN_REVISION ? "unknown (started by an older devtrees)" : hash.slice(0, 12);
}

/**
 * Throw `SHARED_DRIFT` when a selected shared service runs at another
 * revision than this worktree defines, or would take a named port a running
 * shared service owns (#83, scoped to the selection by #236). Revisions are
 * per service (`sharedServiceHash`), so reordering `devtrees.yaml` never
 * trips it, and neither does any edit to a shared service this `up` does not
 * select.
 */
function assertSharedPlanClean(
  plan: SharedPlan,
  ctx: {
    readonly worktreeId: string;
    readonly state: SharedState;
    readonly stack: ResolvedStack;
    /** The remedy for the drifted services (#239); default: the full teardown. */
    readonly remedyFor?: (services: ReadonlyArray<string>) => string;
  },
): void {
  if (plan.drifted.length === 0 && plan.portConflicts.length === 0) return;
  const drifted = plan.drifted.map(
    (d) =>
      `'${d.service}' (running ${shortRevision(d.runningHash)}, ` +
      `this worktree ${shortRevision(d.localHash)})`,
  );
  const conflicts = plan.portConflicts.map(
    (c) => `'${c.service}' declares ${c.port}, which running shared service '${c.owner}' owns`,
  );
  // A port conflict needs the owner gone too: only the full teardown is sure to.
  const remedy =
    plan.portConflicts.length === 0 && ctx.remedyFor !== undefined
      ? ctx.remedyFor(plan.drifted.map((d) => d.service))
      : SHARED_DRIFT_REMEDY;
  const advice =
    remedy === SHARED_DRIFT_REMEDY
      ? `Run \`${SHARED_DRIFT_REMEDY}\` to restart shared from this worktree's config ` +
        `(this stops the shared instance for every worktree).`
      : `Run \`${remedy}\` to restart only those shared services from this worktree's ` +
        `config: the other shared services keep running, and \`--force\` interrupts the ` +
        `worktrees that use these, as the full \`${SHARED_DRIFT_REMEDY}\` would.`;
  throw new SharedDriftError(
    `the shared instance runs a different definition of shared services this up selects: ` +
      `${[...drifted, ...conflicts].join("; ")} ` +
      `(likely a branch that edited a shared service). ` +
      `Refusing to inject port numbers the shared instance never bound. ` +
      `An up that does not select these services is unaffected. ${advice}`,
    {
      worktree_id: ctx.worktreeId,
      running_hash: ctx.state.hash,
      local_hash: sharedStackHash({
        ...ctx.stack,
        services: sharedServicesOf(ctx.stack).filter(isAlwaysOnShared),
      }),
      services: plan.drifted.map((d) => ({
        service: d.service,
        running_hash: d.runningHash,
        local_hash: d.localHash,
      })),
      port_conflicts: plan.portConflicts.map((c) => ({ ...c })),
      remedy,
    },
  );
}

/** Persisted shared state with its per-service records always present (#236). */
type RecordedSharedState = SharedState & {
  readonly services: Readonly<Record<string, SharedServiceRecord>>;
};

/**
 * The persisted shared state with per-service records (#236): as written, or
 * reconstructed for a pre-#236 state from the processes the instance runs —
 * read from its derived config, or, when that cannot be read, taken to be
 * this stack's always-on shared services. `undefined` when no state exists.
 */
function readRecordedSharedState(
  anchor: string,
  stack: ResolvedStack,
): RecordedSharedState | undefined {
  const state = readSharedState(anchor);
  if (state === undefined) return undefined;
  const processes = readDerivedConfig(sharedInstancePaths(anchor).configPath)?.processes;
  const running =
    processes !== undefined
      ? Object.keys(processes)
      : sharedServicesOf(stack)
          .filter(isAlwaysOnShared)
          .map((s) => s.name);
  const recorded = withServiceRecords(state, stack, running);
  return { ...recorded, services: recorded.services ?? {} };
}

/**
 * The shared port plan for `stack` (#238, ADR-0011): the persisted shared port
 * map reconciled with what the shared instance handed out — its bound ports
 * and the env in its derived config — then a number for every shared named
 * port the stack declares that the map does not hold yet. A shared instance
 * started before #238 has no map; this is how its live numbers seed one.
 * A pure read: only `recordSharedPorts`, under the shared lock, writes.
 */
function readSharedPortPlan(
  anchor: string,
  stack: ResolvedStack,
  seed: SharedPortSeed,
  running: boolean,
  warn: (message: string) => void,
): SharedPortPlan {
  const processes = readDerivedConfig(sharedInstancePaths(anchor).configPath)?.processes;
  const read = readSharedPortMapFile(anchor, warn);
  return planSharedPorts({
    names: portNamesOf(sharedServicesOf(stack)),
    recorded: read.map,
    live: liveSharedPortsOf(readSharedState(anchor)?.ports, processes),
    running,
    positional: seed.positional,
    block: seed.block,
    // A map with an invalid entry is rewritten without it by the next `up`,
    // so the warning does not repeat (`env` and the dry run only read).
    repair: read.invalid.length > 0,
  });
}

/**
 * Fail `SHARED_PORT_CONFLICT` on a conflict this command must not go past
 * (`blockingPortConflicts`): one involving a shared port the stack declares,
 * or a stale env entry for a port `binding` (the services this `up` starts or
 * adds) would bind. A stale env entry that blocks nothing is warned about,
 * and so is a recorded port outside the current shared block.
 */
function assertSharedPortsClean(args: {
  readonly command: "up" | "env" | "up --dry-run";
  readonly anchor: string;
  readonly portPlan: SharedPortPlan;
  readonly stack: ResolvedStack;
  readonly binding: ReadonlyArray<ResolvedService>;
  readonly warn: (message: string) => void;
}): void {
  const declared = new Set(portNamesOf(sharedServicesOf(args.stack)));
  const binding = new Set(portNamesOf(args.binding));
  const blocking = blockingPortConflicts(args.portPlan.conflicts, declared, binding);
  if (blocking.length > 0) throw sharedPortConflictError(args.command, args.anchor, blocking);
  for (const conflict of args.portPlan.conflicts) {
    if (conflict.reason === "stale_env") args.warn(staleEnvWarning(conflict));
  }
  for (const warning of args.portPlan.warnings) args.warn(warning);
}

/** `SHARED_PORT_CONFLICT`'s remedy when the shared block is full: drop unused names. */
const PRUNE_SHARED_PORTS_REMEDY = "devtrees prune --shared-ports";

function sharedPortConflictError(
  command: string,
  anchor: string,
  conflicts: ReadonlyArray<PortMapConflict>,
): SharedPortConflictError {
  const mapPath = sharedPortMapFile(anchor);
  const onlyFull = conflicts.every((c) => c.reason === "block_full");
  const remedy = onlyFull ? PRUNE_SHARED_PORTS_REMEDY : SHARED_DRIFT_REMEDY;
  const next = onlyFull
    ? `Next: \`${remedy}\` drops the recorded names no instance holds; if it frees nothing, ` +
      `raise \`block_size\` in devtrees.yaml.`
    : `Next: \`${remedy}\`, for every worktree (it stops the shared instance for all of them). ` +
      `If two entries of ${mapPath} name one port, that survives a restart: surface it to a ` +
      `human, who removes one of them.`;
  return new SharedPortConflictError(
    `devtrees ${command}: refusing to hand one shared port to two names, move a recorded one, ` +
      `or start a service without its port:\n${conflicts.map(describePortConflict).join("\n")}\n` +
      `Nothing was started, added or recorded. ${next}`,
    { conflicts: conflicts.map(portConflictJson), map_path: mapPath, remedy },
  );
}

function describePortConflict(c: PortMapConflict): string {
  if (c.reason === "block_full") {
    return `  ${c.portName}: no free number left in the shared block (every one is recorded)`;
  }
  const recorded = c.recordedPort === undefined ? "unrecorded" : `recorded ${c.recordedPort}`;
  if (c.reason === "port_taken") return `  ${c.portName} ${c.port}: held by ${c.holder ?? "?"}`;
  if (c.reason === "bound_mismatch") {
    return `  ${c.portName}: ${recorded}, but a running shared service binds ${c.port}`;
  }
  return `  ${c.portName}: ${recorded}, but running shared service '${c.process ?? "?"}' was started with ${c.port}`;
}

function portConflictJson(c: PortMapConflict): Record<string, string | number> {
  return {
    reason: c.reason,
    port_name: c.portName,
    ...(c.port !== undefined ? { port: c.port } : {}),
    ...(c.recordedPort !== undefined ? { recorded_port: c.recordedPort } : {}),
    ...(c.holder !== undefined ? { holder: c.holder } : {}),
    ...(c.process !== undefined ? { process: c.process } : {}),
  };
}

/** Persist the plan's map when it holds anything new. Only `up`, under the shared lock. */
function recordSharedPorts(anchor: string, plan: SharedPortPlan): void {
  if (plan.changed) writeSharedPortMap(anchor, plan.map);
}

// --- teardown: `down --shared` and `down --shared -n` (#258, ADR-0012) -----

/** What `down --shared` did. */
export interface SharedDownResult {
  /** A live shared instance answered, and was stopped. */
  readonly stopped: boolean;
  /** Service processes devtrees had to SIGKILL to finish the stop (#190). */
  readonly forceKilled: ReadonlyArray<ForceKilled>;
}

/**
 * `down --shared`: stop the whole shared instance under the shared
 * lifecycle lock, idempotently; when it is not running the call is a no-op.
 *
 * Probe, don't trust the file (#80): after a SIGKILL the socket file
 * survives with no listener behind it, and `process-compose down` against
 * the dead UDS fails. A live instance is signalled through the driver; a
 * stale socket is unlinked by the probe gate itself, so either way the call
 * converges to "shared is down". Unknown liveness (#186) fails
 * INSTANCE_UNRESPONSIVE: never report "not running" (or drop the config)
 * for an instance that may be live. A stop that times out (#190) throws
 * DOWN_TIMEOUT before the config is removed, so a retry still finds the
 * instance.
 *
 * The shared port map and the `__shared__` registry entry survive it (#51,
 * ADR-0011), so a consumer that remembers a shared port keeps a valid number.
 */
async function down(deps: SharedInstanceDeps): Promise<SharedDownResult> {
  const paths = sharedInstancePaths(deps.anchor);
  return await lockOf(deps)(deps.anchor, async () => {
    const live = (await openShared(deps, { command: "down" })) !== undefined;
    const forceKilled = live
      ? (await stopInstance(deps.driver, paths, SHARED_INSTANCE_ID, "down", deps.stop)).forceKilled
      : [];
    // Best-effort cleanup of the derived config — a future `up` re-derives it.
    rmSync(paths.configPath, { force: true });
    return { stopped: live, forceKilled };
  });
}

/** `down --shared -n <namespace>...` (#239): which namespaces, and whether to override worktree dependants. */
export interface SharedNamespaceDownOptions {
  readonly namespaces: ReadonlyArray<string>;
  /** Remove the services even though a live worktree's isolated service depends on them. */
  readonly force?: boolean;
}

/** What `down --shared -n` did (#239). */
export interface SharedNamespaceDownResult {
  readonly shared: true;
  /**
   * devtrees stopped a running shared process (or the whole instance). `false`
   * on the no-op, and when it only removed services that were already stopped.
   */
  readonly stopped: boolean;
  readonly namespaces: ReadonlyArray<string>;
  /** The shared services of the named namespaces, in config order. */
  readonly services: ReadonlyArray<string>;
  /**
   * What left the shared instance: `services`, plus leftovers of an earlier
   * removal whose reload timed out. Empty on the no-op.
   */
  readonly removed: ReadonlyArray<string>;
  /** Named namespaces with no shared service in the shared instance: nothing to do for them. */
  readonly inactiveNamespaces: ReadonlyArray<string>;
  /** They were the last running shared services: the whole shared instance was stopped. */
  readonly instanceStopped: boolean;
  /** Worktree dependants `--force` overrode (empty without `--force`). */
  readonly dependants: ReadonlyArray<SharedDependant>;
  readonly forceKilled: ReadonlyArray<ForceKilled>;
}

/** What `down --shared -n --dry-run` previews (#239): the same reads, no lock, no effect. */
export interface SharedNamespaceDownPreview {
  readonly namespaces: ReadonlyArray<string>;
  /** Whether a live shared instance answered. */
  readonly running: boolean;
  readonly services: ReadonlyArray<string>;
  readonly inactiveNamespaces: ReadonlyArray<string>;
  readonly wouldStopInstance: boolean;
  /** Every dependant found, shared and worktree alike. */
  readonly dependants: ReadonlyArray<SharedDependant>;
  /** The real run would fail `SHARED_IN_USE` (with the same `--force`). */
  readonly blocked: boolean;
}

/** What a namespaced shared teardown found, under the shared lock or (dry run) without it. */
interface SharedDownInspection {
  /** The shared instance, opened live (#259); `undefined` when it is not running. */
  readonly instance: LiveInstance | undefined;
  readonly config: DerivedConfig | undefined;
  readonly rows: ReadonlyArray<ServiceStatus>;
  readonly plan: SharedDownPlan;
  /** Processes the shared instance still lists that its config no longer holds: a timed-out removal. */
  readonly leftovers: ReadonlyArray<string>;
  readonly dependants: ReadonlyArray<SharedDependant>;
  /** Removing the targets leaves nothing running, so it is a full `down --shared`. */
  readonly last: boolean;
  /** The command that retries this teardown. */
  readonly retry: string;
}

/** The command to retry, and the one `INSTANCE_UNRESPONSIVE` names. */
function sharedDownCommand(namespaces: ReadonlyArray<string>, force?: boolean): string {
  const ns = namespaces.map((n) => `-n ${n}`).join(" ");
  return `devtrees down --shared ${ns}${force === true ? " --force" : ""}`;
}

/**
 * Stop and remove only the shared services of `namespaces` (#239,
 * ADR-0012), under the shared lifecycle lock, so it never interleaves with
 * an `up` that is adding or restarting shared services (#236, #240):
 *
 *  1. Probe the shared instance; not running is the idempotent no-op.
 *  2. Pick the targets from the shared derived config (`planSharedDown`).
 *     None is the same no-op: a namespace with no running shared service is
 *     reported in `inactiveNamespaces`, never an error.
 *  3. Refuse `SHARED_IN_USE` while something still depends on a target.
 *  4. When the targets are the last running shared services, stop the whole
 *     shared instance, exactly as `down --shared`.
 *  5. Otherwise stop the targets with the bounded per-service stop
 *     (`restart`'s first half: shutdown hooks, then a force-kill after the
 *     budget), remove their processes from the shared derived config, and
 *     ask process-compose to re-read it (the reload activation uses). The
 *     processes left in the file are unchanged, so process-compose keeps
 *     them running. Last, drop the targets' revision records from the shared
 *     state, keeping their ports reserved (`withoutServiceRecords`).
 */
async function downNamespaces(
  deps: SharedInstanceDeps,
  options: SharedNamespaceDownOptions,
): Promise<SharedNamespaceDownResult> {
  const { anchor, driver } = deps;
  const deadline = Date.now() + (deps.lifecycleWaitMs ?? LIFECYCLE_WAIT_MS);
  for (;;) {
    const attempt = await lockOf(deps)(anchor, () =>
      sharedNamespaceDownAttempt(deps, driver, anchor, options, deadline),
    );
    if (attempt.done !== undefined) return attempt.done;
    // Wait OUTSIDE the shared lock: an `up` queued on it behind this teardown
    // holds its worktree lock until it is through, so waiting while holding
    // the shared lock would deadlock until the deadline.
    await waitForLocksToClear(anchor, attempt.waitFor, attempt.targets, deadline);
  }
}

/** How long `down --shared -n` waits for in-flight lifecycle commands (#239). */
const LIFECYCLE_WAIT_MS = 15_000;
const LIFECYCLE_POLL_MS = 200;

/**
 * Poll until none of `ids` is an in-flight command that blocks a teardown of
 * `targets` (its lock is released, or its shared-step marker now names none
 * of them: an `up` got past its shared step), or `deadline`. Read-only: no
 * lock is held here, so stale markers are left for the locked retry.
 */
async function waitForLocksToClear(
  anchor: string,
  ids: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const blocking = new Set(
      inProgressDependants(inFlightWorktrees(anchor), targets).map((d) => d.instance),
    );
    if (!ids.some((id) => blocking.has(id))) return;
    await new Promise((r) => setTimeout(r, Math.min(LIFECYCLE_POLL_MS, deadline - Date.now())));
  }
}

/**
 * One locked attempt of `down --shared -n` (#239). When the only thing in
 * the way is a lifecycle command in flight, it asks the caller to wait for
 * those locks outside the shared lock and try again (`waitFor`), until
 * `deadline`; after it, the attempt fails `SHARED_IN_USE` with a plain retry.
 * A shared dependant fails at once: waiting cannot clear it.
 */
async function sharedNamespaceDownAttempt(
  deps: SharedInstanceDeps,
  driver: Driver,
  anchor: string,
  options: SharedNamespaceDownOptions,
  deadline: number,
): Promise<{
  done?: SharedNamespaceDownResult;
  waitFor: ReadonlyArray<string>;
  targets: ReadonlyArray<string>;
}> {
  let targets: ReadonlyArray<string> = [];
  const done = await (async (): Promise<SharedNamespaceDownResult | string[]> => {
    const seen = await inspectSharedDown(deps, anchor, options, { readOnly: false });
    targets = seen.plan.targets;
    const result = {
      shared: true as const,
      namespaces: [...options.namespaces],
      services: [...seen.plan.targets],
      inactiveNamespaces: seen.plan.inactiveNamespaces,
      dependants: [] as SharedDependant[],
      forceKilled: [] as ForceKilled[],
      removed: [] as string[],
    };
    const { instance } = seen;
    if (instance === undefined || (seen.plan.targets.length === 0 && seen.leftovers.length === 0)) {
      return { ...result, stopped: false, instanceStopped: false };
    }
    const removed = [...seen.plan.targets, ...seen.leftovers];
    const inFlight = seen.dependants.filter((d) => d.source === "lifecycle_in_progress");
    const sharedBlock = seen.dependants.some((d) => d.instance === SHARED_INSTANCE_ID);
    if (inFlight.length > 0 && !sharedBlock && Date.now() < deadline) {
      return inFlight.map((d) => d.instance);
    }
    assertSharedNotInUse(seen, options, anchor);
    const overridden = { dependants: [...seen.dependants], removed };
    if (seen.last) {
      const forceKilled = await stopWholeShared(driver, anchor, deps);
      return { ...result, ...overridden, stopped: true, instanceStopped: true, forceKilled };
    }
    const stop = await stopSharedTargets(deps, instance, anchor, seen);
    const { forceKilled } = stop;
    if (stop.instanceGone) {
      rmSync(sharedInstancePaths(anchor).configPath, { force: true });
      return { ...result, ...overridden, stopped: true, instanceStopped: true, forceKilled };
    }
    await removeSharedProcesses(driver, anchor, seen);
    return { ...result, ...overridden, stopped: stop.stopped, instanceStopped: false, forceKilled };
  })();
  return Array.isArray(done) ? { waitFor: done, targets } : { done, waitFor: [], targets };
}

/**
 * Preview `down --shared -n` (#239): the same reads as the real run, without
 * the shared lock, and with a stale socket file left in place. Nothing is
 * stopped, reloaded or written.
 */
async function previewDownNamespaces(
  deps: SharedInstanceDeps,
  options: SharedNamespaceDownOptions,
): Promise<SharedNamespaceDownPreview> {
  const seen = await inspectSharedDown(deps, deps.anchor, options, { readOnly: true });
  return {
    namespaces: [...options.namespaces],
    running: seen.instance !== undefined,
    services: seen.plan.targets,
    inactiveNamespaces: seen.plan.inactiveNamespaces,
    wouldStopInstance: seen.last,
    dependants: seen.dependants,
    blocked: blockingDependants(seen.dependants, options.force).length > 0,
  };
}

/** Read what a namespaced shared teardown acts on (#239). */
async function inspectSharedDown(
  deps: SharedInstanceDeps,
  anchor: string,
  options: SharedNamespaceDownOptions,
  opts: { readonly readOnly: boolean },
): Promise<SharedDownInspection> {
  const paths = sharedInstancePaths(anchor);
  const retry = sharedDownCommand(options.namespaces, options.force);
  const instance = await openSharedLiveInstance(
    anchor,
    liveSeams(deps),
    { command: "down", retry },
    opts,
  );
  if (instance === undefined) {
    const plan = planSharedDown(undefined, options.namespaces);
    return {
      instance,
      config: undefined,
      rows: [],
      plan,
      leftovers: [],
      dependants: [],
      last: false,
      retry,
    };
  }
  const config = readDerivedConfig(paths.configPath);
  // One bounded `process list`; one that never answers is `INSTANCE_UNRESPONSIVE`.
  const rows = await instance.rows(READ_TIMEOUT_MS, { unresponsive: true });
  const plan = planSharedDown(config, options.namespaces);
  const leftovers = rows.map((r) => r.name).filter((name) => !(name in (config?.processes ?? {})));
  const dependants =
    plan.targets.length === 0
      ? []
      : [
          ...plan.sharedDependants,
          ...(await findWorktreeDependants(deps, anchor, plan.targets, opts)),
        ];
  const last = plan.targets.length > 0 && removesLastRunning(rows, plan.remaining);
  return { instance, config, rows, plan, leftovers, dependants, last, retry };
}

/**
 * The booted isolated services of live worktree instances that `depends_on`
 * a target (#239). Every worktree instance whose socket is not definitively
 * stale is checked, the caller's own included. Its edges come from its
 * derived config (`x-devtrees.shared_depends_on`, the cross-tier edges the
 * deriver dropped), or, for an instance started before #239, from its
 * worktree's `devtrees.yaml`; when neither can be read, the instance itself
 * is a dependant (`source: unknown`).
 *
 * A worktree whose lifecycle lock is held by a live process is a dependant
 * too (`source: lifecycle_in_progress`): an `up` there may already be past
 * its shared step, waiting for shared health or spawning, with no socket
 * yet. Only when it uses a target, though: its shared-step marker names the
 * shared services it uses (selected, or depended on by an isolated service
 * it boots), and one that names none of the targets does
 * not block. One with no valid marker yet (an `up` not past its shared step,
 * or a `restart`) blocks, conservatively. The locks are read after the
 * discovery, so an `up` is seen either by its socket or by its lock. No lock
 * is taken; under the shared lock (`readOnly: false`) a stale marker is
 * removed. The caller waits for these outside the shared lock before it
 * refuses (`downNamespaces`).
 */
async function findWorktreeDependants(
  deps: SharedInstanceDeps,
  anchor: string,
  targets: ReadonlyArray<string>,
  opts: { readonly readOnly: boolean },
): Promise<SharedDependant[]> {
  const discover = deps.discover ?? discoverInstances;
  const probe = deps.probeSocket;
  const instances = await discover(anchor, {
    getServiceStatuses: (socketPath) =>
      readStatusesWithin(deps.driver, socketPath, READ_TIMEOUT_MS, { probe }),
    probeSocket: probe,
    probeRetryDelaysMs: deps.liveness.retryDelaysMs,
  });
  const live = instances.filter((i) => i.kind === "worktree" && i.status !== "stale");
  const found = worktreeDependants(
    live.map((i) => worktreeEdgesOf(deps, anchor, i)),
    targets,
  );
  const inFlight = inFlightWorktrees(anchor, { clearStale: !opts.readOnly });
  return [...found, ...inProgressDependants(inFlight, targets)];
}

/**
 * One live worktree instance's isolated → shared edges and booted services.
 * A service a pending hot-reload is applying (#191) is booted even though
 * process-compose does not list it: its old run is still alive, as `ls`
 * counts it (`bootedNamespaces`).
 */
function worktreeEdgesOf(
  deps: SharedInstanceDeps,
  anchor: string,
  info: InstanceInfo,
): WorktreeEdges {
  const configPath = instancePaths(anchor, info.id).configPath;
  const pending = readPendingReload(anchor, info.id)?.services ?? [];
  const booted =
    info.servicesRead === "ok"
      ? new Set([...info.services.map((s) => s.name), ...pending])
      : undefined;
  const recorded = recordedSharedEdges(readDerivedConfig(configPath));
  if (recorded !== undefined) {
    return { instance: info.id, edges: recorded, source: "derived_config", booted };
  }
  const root = readWorktreePath(configPath);
  let edges: WorktreeEdges["edges"];
  try {
    edges = root === "" ? undefined : stackSharedEdges((deps.readStack ?? loadStack)(root));
  } catch {
    edges = undefined;
  }
  return { instance: info.id, edges, source: "devtrees_yaml", booted };
}

/**
 * The dependants that block: shared ones and in-flight lifecycle commands
 * always, worktree ones unless `--force`. `--force` overrides a worktree
 * that uses a service, never one in the middle of an `up`, `down` or
 * `restart`: forcing under an `up` that is waiting for shared health would
 * fail it confusingly, and the command clears on its own.
 */
function blockingDependants(
  dependants: ReadonlyArray<SharedDependant>,
  force: boolean | undefined,
): SharedDependant[] {
  return dependants.filter(
    (d) =>
      d.instance === SHARED_INSTANCE_ID || d.source === "lifecycle_in_progress" || force !== true,
  );
}

/** `instance/service (depends on a, b)`, for prose. */
function describeDependant(d: SharedDependant): string {
  if (d.source === "lifecycle_in_progress") {
    const uses =
      d.depends_on.length === 0 ? "" : `; it uses ${d.depends_on.map((s) => `'${s}'`).join(", ")}`;
    return `worktree '${d.instance}' (an \`up\`, \`down\` or \`restart\` is in progress there${uses})`;
  }
  if (d.service === null) {
    return `worktree '${d.instance}' (its dependencies could not be read)`;
  }
  const who =
    d.instance === SHARED_INSTANCE_ID
      ? `shared service '${d.service}'`
      : `'${d.instance}/${d.service}'`;
  return `${who} (depends on ${d.depends_on.join(", ")})`;
}

/** Throw `SHARED_IN_USE` when something still depends on a target (#239). */
function assertSharedNotInUse(
  seen: SharedDownInspection,
  options: SharedNamespaceDownOptions,
  anchor: string,
): void {
  const blocking = blockingDependants(seen.dependants, options.force);
  if (blocking.length === 0) return;
  const shared = blocking.filter((d) => d.instance === SHARED_INSTANCE_ID);
  const inFlight = blocking.filter((d) => d.source === "lifecycle_in_progress");
  const { remedy, advice } =
    shared.length === 0 && inFlight.length > 0
      ? inFlightRemedy(inFlight, options, anchor)
      : sharedInUseRemedy(shared, seen.config, options);
  const targets = seen.plan.targets.map((t) => `'${t}'`).join(", ");
  const plural = options.namespaces.length === 1 ? "" : "s";
  throw new SharedInUseError(
    `devtrees down: cannot remove shared service(s) ${targets} ` +
      `(namespace${plural} ${options.namespaces.join(", ")}): ` +
      `still in use by ${blocking.map(describeDependant).join("; ")}. Nothing was stopped. ` +
      `Next: ${advice}`,
    {
      namespaces: [...options.namespaces],
      services: [...seen.plan.targets],
      dependants: blocking,
      forceable: shared.length === 0 && inFlight.length === 0,
      remedy,
    },
  );
}

/**
 * What to do about a `SHARED_IN_USE`: `remedy` is one runnable command, as
 * every `details.remedy` is (#238); `advice` is the prose around it. A shared
 * dependant: name its namespaces too (or tear the whole shared instance down,
 * for an always-on one). A worktree dependant: stop those worktrees, or
 * `--force`.
 */
function sharedInUseRemedy(
  shared: ReadonlyArray<SharedDependant>,
  config: DerivedConfig | undefined,
  options: SharedNamespaceDownOptions,
): { readonly remedy: string; readonly advice: string } {
  if (shared.length > 0) {
    const procs = shared.map((d) => config?.processes[d.service ?? ""]);
    if (procs.some((p) => p?.namespace === undefined)) {
      const remedy = "devtrees down --shared";
      return {
        remedy,
        advice:
          "an always-on shared service depends on them, so only the whole shared instance " +
          `can go: \`${remedy}\` (this stops it for every worktree). \`--force\` does not ` +
          "override this.",
      };
    }
    const more = procs.flatMap((p) => (p === undefined ? [] : serviceNamespaces(p)));
    const remedy = sharedDownCommand([...new Set([...options.namespaces, ...more])], options.force);
    return {
      remedy,
      advice:
        `name their namespaces too: \`${remedy}\`. \`--force\` does not override a shared ` +
        "dependant: removing the dependency would restart a running shared service.",
    };
  }
  const remedy = sharedDownCommand(options.namespaces, true);
  return {
    remedy,
    advice:
      "stop those worktrees first (`devtrees down` in each), or remove the services anyway " +
      `with \`${remedy}\` (those services keep running without them).`,
  };
}

/**
 * The remedy while a lifecycle command is still in flight after the wait
 * (#239): the plain retry, never `--force`, which would pull the services
 * from under that command. Names the lock files, in case one is stale.
 */
function inFlightRemedy(
  inFlight: ReadonlyArray<SharedDependant>,
  options: SharedNamespaceDownOptions,
  anchor: string,
): { readonly remedy: string; readonly advice: string } {
  const remedy = sharedDownCommand(options.namespaces, false);
  const locks = inFlight.map((d) => join(stateDir(anchor), `${d.instance}.lock`)).join(", ");
  return {
    remedy,
    advice:
      "an `up`, `down` or `restart` is still running in those worktrees after devtrees " +
      `waited for it: retry \`${remedy}\` once it has finished. If no devtrees command is ` +
      `running there, its lock is stale: remove ${locks} and retry.`,
  };
}

/** The last running shared services: stop the whole shared instance, as `down --shared` does. */
async function stopWholeShared(
  driver: StopDriver,
  anchor: string,
  deps: SharedInstanceDeps,
): Promise<ReadonlyArray<ForceKilled>> {
  const paths = sharedInstancePaths(anchor);
  const stopped = await stopInstance(driver, paths, SHARED_INSTANCE_ID, "down", deps.stop);
  rmSync(paths.configPath, { force: true });
  return stopped.forceKilled;
}

/**
 * Stop the running targets with the bounded per-service stop (#239), then
 * run the shutdown hooks process-compose skips for a daemon whose launch
 * had exited (#155), from the anchor. A refused or unfinished stop fails
 * `SHARED_REMOVAL_FAILED` with nothing removed, so a retry finds them again.
 * `instanceGone` when process-compose exited during the stop (nothing else
 * was running after all): the shared instance is down.
 */
async function stopSharedTargets(
  deps: SharedInstanceDeps,
  instance: LiveInstance,
  anchor: string,
  seen: SharedDownInspection,
): Promise<{
  readonly forceKilled: ReadonlyArray<ForceKilled>;
  readonly instanceGone: boolean;
  /** Some target was running, and was stopped. */
  readonly stopped: boolean;
}> {
  const { configPath } = sharedInstancePaths(anchor);
  const targets = seen.plan.targets;
  const { running } = partitionRunning(seen.rows, targets);
  if (running.length === 0) return { forceKilled: [], instanceGone: false, stopped: false };
  const stopping = instance.stop(running, {
    rows: seen.rows,
    config: seen.config,
    seams: deps.stop,
  });
  const outcome = await stopping.catch((err: unknown) => {
    if ((err as { code?: unknown }).code === "INSTANCE_NOT_FOUND") return undefined;
    if (!(err instanceof StopRefusedError)) throw err;
    throw removalFailed(targets, "stop_refused", configPath, err.reason, seen.retry);
  });
  if (outcome === undefined) return { forceKilled: [], instanceGone: true, stopped: true };
  if (outcome.unsettled.length > 0) {
    const names = outcome.unsettled.map((u) => `${u.service} (pid ${u.pid ?? "unknown"})`);
    throw removalFailed(
      targets,
      "stop_incomplete",
      configPath,
      `still running: ${names.join(", ")}`,
      seen.retry,
    );
  }
  const warn = deps.warn;
  warnSurvivors(outcome.survivors, warn);
  await reapSkippedSharedHooks(deps, anchor, seen, warn);
  return { forceKilled: outcome.forceKilled, instanceGone: false, stopped: true };
}

/** Run the targets' daemon shutdown hooks process-compose skipped (#155); a failure only warns. */
async function reapSkippedSharedHooks(
  deps: SharedInstanceDeps,
  anchor: string,
  seen: SharedDownInspection,
  warn: (message: string) => void,
): Promise<void> {
  if (seen.config === undefined) return;
  const targets = { ...seen.config, processes: pick(seen.config.processes, seen.plan.targets) };
  const skipped = daemonHooksSkipped(targets, seen.rows);
  if (skipped === undefined) return;
  const outcome = await (deps.reap ?? reapShutdownHooks)(skipped, { cwd: anchor });
  for (const f of outcome.failures) {
    warn(`devtrees down: shutdown hook of shared service '${f.process}' failed (${f.reason}).`);
  }
}

/**
 * Remove the stopped targets (and any leftovers of a timed-out removal) from
 * the shared instance (#239): rewrite its derived config without them and
 * reload it, the mechanism activation uses (ADR-0010). Then drop their
 * revision records. A refused reload restores the previous config and keeps
 * the records (the services stay listed, stopped; a retry removes them). A
 * timed-out one keeps the new config and drops the records, because
 * process-compose may still apply it; a retry re-sends the reload while the
 * instance still lists a process the config no longer holds.
 */
async function removeSharedProcesses(
  driver: Driver,
  anchor: string,
  seen: SharedDownInspection,
): Promise<void> {
  const paths = sharedInstancePaths(anchor);
  const targets = seen.plan.targets;
  if (seen.config === undefined) return;
  const previousYaml = readFileSync(paths.configPath, "utf8");
  const next = withoutProcesses(seen.config, targets);
  writeFileSync(paths.configPath, stringifyYaml(next), "utf8");
  const reload = await driver.reloadConfig(
    { configPath: paths.configPath, socketPath: paths.socketPath },
    { timeoutMs: reloadTimeoutMs(next) },
  );
  const retry = seen.retry;
  if (!reload.ok && reload.reason !== "timeout") {
    writeFileSync(paths.configPath, previousYaml, "utf8");
    throw removalFailed(targets, reload.reason, paths.configPath, reload.message, retry);
  }
  const state = readSharedState(anchor);
  if (state !== undefined) writeSharedState(anchor, withoutServiceRecords(state, targets));
  if (!reload.ok) throw removalFailed(targets, "timeout", paths.configPath, reload.message, retry);
}

/** The `SHARED_REMOVAL_FAILED` a namespaced shared teardown raises (#239). */
function removalFailed(
  services: ReadonlyArray<string>,
  reason: SharedRemovalFailedError["details"]["reason"],
  configPath: string,
  cause: string | undefined,
  retry: string,
): SharedRemovalFailedError {
  const outcome: Record<typeof reason, string> = {
    stop_refused: "process-compose refused to stop them; nothing was removed",
    stop_incomplete: "they did not stop within the budget; nothing was removed",
    not_supported: "process-compose refused the config reload; they are stopped but still listed",
    error: "process-compose refused the config reload; they are stopped but still listed",
    timeout:
      "the config reload did not finish within its budget; process-compose may still apply it",
  };
  // One runnable command, as every `details.remedy` is (#238); the fallback is prose.
  const remedy = retry;
  const advice =
    reason === "stop_refused" || reason === "stop_incomplete"
      ? `retry \`${retry}\`; if it fails again, \`devtrees down --shared\` (this stops the ` +
        "shared instance for every worktree)"
      : `retry \`${retry}\``;
  return new SharedRemovalFailedError(
    `devtrees down: removing shared service(s) ${services.map((s) => `'${s}'`).join(", ")} ` +
      `failed: ${outcome[reason]}${cause !== undefined ? ` (${cause})` : ""}. The other shared ` +
      `services are untouched. Next: ${advice}.`,
    { services: [...services], reason, config_path: configPath, remedy },
  );
}

// --- shared ports: `ls` and `prune --shared-ports` (#238, ADR-0011) --------

/** What `prune --shared-ports` did (or, with `--dry-run`, would do) to the shared port map (#238). */
export interface PruneSharedPortsResult {
  /** Names removed from the map (with `--dry-run`: that would be), sorted. */
  readonly dropped: ReadonlyArray<string>;
  /** Names kept because some instance still holds them, sorted. */
  readonly kept: ReadonlyArray<string>;
  /**
   * The names among `dropped` recorded outside the current shared block,
   * dropped because nothing running holds them (sorted). A name inside the
   * block is dropped only when no derived config on disk holds it.
   */
  readonly outOfBlock: ReadonlyArray<string>;
  /** Nothing was written: a `--dry-run` preview. */
  readonly dryRun: boolean;
  /**
   * `--dry-run` only: the worktrees with a lifecycle command in flight that
   * would make the real run fail `LOCK_CONTENTION` now. Always empty on a
   * real run, which fails instead.
   */
  readonly blockedBy: ReadonlyArray<string>;
}

/** `prune --shared-ports`'s request. */
export interface PrunePortsRequest {
  /** Report what would be dropped: no lock, no write, no refusal (#244 follow-up). */
  readonly dryRun?: boolean | undefined;
  /**
   * The current shared block (the registry's shared base and this worktree's
   * `block_size`), read once the pass has checked the in-flight commands and
   * read the map. `undefined`: no name counts as outside it.
   */
  readonly sharedBlock: () => SharedBlock | undefined;
}

/**
 * Drop from the shared port map every name no instance holds (#238,
 * ADR-0011): `prune --shared-ports`, under the shared lifecycle lock, or
 * (dry run) without it.
 */
async function prunePorts(
  deps: SharedInstanceDeps,
  request: PrunePortsRequest,
): Promise<PruneSharedPortsResult> {
  if (request.dryRun === true) return await pruneSharedPortsPass(deps, request.sharedBlock, true);
  return await lockOf(deps)(deps.anchor, () =>
    pruneSharedPortsPass(deps, request.sharedBlock, false),
  );
}

/**
 * The shared port map as `ls` reports it (#238): every recorded name, plus any
 * port a running shared instance binds that is not recorded yet (one started
 * before #238), each `active` when the running shared instance binds it and
 * `recorded` otherwise. `ls` reads no stack, so it never reports `predicted`.
 */
function portMap(anchor: string, running: boolean): Record<string, SharedPortEntry> {
  const recorded = readSharedPortMap(anchor) ?? {};
  const active = running ? (readSharedState(anchor)?.ports ?? {}) : {};
  return sharedPortOrigins({ ...active, ...recorded }, recorded, active);
}

/** One pass of `prune --shared-ports`: under the shared lock, or (dry run) without it. */
async function pruneSharedPortsPass(
  deps: SharedInstanceDeps,
  sharedBlock: () => SharedBlock | undefined,
  dryRun: boolean,
): Promise<PruneSharedPortsResult> {
  const { anchor } = deps;
  const inFlight = inFlightWorktrees(anchor, { clearStale: !dryRun });
  const marked = inFlight.filter((w) => w.marker?.ports !== undefined);
  if (!dryRun) assertNoWorktreeLifecycleLocks(anchor, new Set(marked.map((w) => w.id)));
  const blockedBy = dryRun
    ? inFlight
        .filter((w) => w.marker?.ports === undefined)
        .map((w) => w.id)
        .sort()
    : [];
  const read = readSharedPortMapFile(anchor, deps.warn);
  // An unreadable map is never rewritten here: that would drop the names
  // other branches recorded.
  if (read.map === undefined) return { dropped: [], kept: [], outOfBlock: [], dryRun, blockedBy };
  const recorded = read.map;
  const injecting = marked.flatMap((w) => w.marker?.ports ?? []);
  const block = sharedBlock();
  const names = Object.keys(recorded).sort();
  const outside = new Set(
    names.filter((name) => block !== undefined && !inSharedBlock(block, recorded[name] ?? 0)),
  );
  const keepers = await prunePortKeepers(deps, anchor, injecting, outside.size > 0);
  const keep = (name: string): boolean =>
    outside.has(name) ? keepers.running.has(name) : keepers.held.has(name);
  const kept = names.filter(keep);
  const dropped = names.filter((name) => !keep(name));
  if (!dryRun && (dropped.length > 0 || read.invalid.length > 0)) {
    writeSharedPortMap(anchor, pick(recorded, kept));
  }
  const outOfBlock = dropped.filter((name) => outside.has(name));
  return { dropped, kept, outOfBlock, dryRun, blockedBy };
}

/**
 * Who holds a shared port name for `prune --shared-ports`: `held` (anything
 * on disk, for a name inside the block) and `running` (only what runs, for
 * one outside it; read only when some name is outside). Both count the ports
 * in-flight `up`s past their shared step inject (`injecting`).
 */
async function prunePortKeepers(
  deps: SharedInstanceDeps,
  anchor: string,
  injecting: ReadonlyArray<string>,
  needRunning: boolean,
): Promise<{ readonly held: ReadonlySet<string>; readonly running: ReadonlySet<string> }> {
  const held = new Set([...heldSharedPortNames(anchor), ...injecting]);
  const running = needRunning
    ? new Set([...(await runningSharedPortNames(deps, anchor)), ...injecting])
    : new Set<string>();
  return { held, running };
}

/**
 * Every shared port name something running holds: a running shared service
 * binds it (the shared state's `ports`, while the shared instance is live),
 * or a live instance's derived config (the shared one's or a worktree's)
 * carries it in a process's env. An instance whose liveness is `unknown`
 * counts as live.
 */
async function runningSharedPortNames(
  deps: SharedInstanceDeps,
  anchor: string,
): Promise<Set<string>> {
  const discover = deps.discover ?? discoverInstances;
  const instances = await discover(anchor, {
    probeSocket: deps.probeSocket,
    probeRetryDelaysMs: deps.liveness.retryDelaysMs,
  });
  const live = instances.filter((info) => info.status !== "stale");
  const bound = live.some((info) => info.kind === "shared")
    ? Object.keys(readSharedState(anchor)?.ports ?? {})
    : [];
  const env = live.flatMap((info) => envNamesOf(instancePaths(anchor, info.id).configPath));
  return new Set([...bound, ...env]);
}

/** Every env name a derived config on disk, or the shared state's bound ports, holds. */
function heldSharedPortNames(anchor: string): Set<string> {
  const held = new Set(Object.keys(readSharedState(anchor)?.ports ?? {}));
  const dir = stateDir(anchor);
  if (!existsSync(dir)) return held;
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".yaml")) for (const name of envNamesOf(join(dir, entry))) held.add(name);
  }
  return held;
}

/** The `KEY=NUMBER` env names any process of the derived config at `path` carries. */
function envNamesOf(path: string): string[] {
  const processes = readDerivedConfig(path)?.processes;
  return Object.values(liveSharedPortsOf(undefined, processes).processEnv).flatMap((env) =>
    Object.keys(env),
  );
}

/** The entries of `record` whose key is in `keys`. */
function pick<V>(record: Readonly<Record<string, V>>, keys: Iterable<string>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Every named port the given services declare. */
function portNamesOf(services: ReadonlyArray<ResolvedService>): string[] {
  return services.flatMap((s) => s.ports);
}

/**
 * Thrown when a shared service this `up` selects diverges from the revision
 * the running shared instance runs (issue #83) — typically a branch that
 * edited a shared service. Injecting this worktree's recomputed numbers would
 * not match the ports the shared instance actually bound, so `up`/`env` fail
 * loudly with the `SHARED_DRIFT` envelope instead of silently injecting wrong
 * connection info. Remediation mirrors the worktree-level `CONFIG_DRIFT` UX:
 * `devtrees down --shared && devtrees up` restarts shared from this
 * worktree's config and re-persists the new map.
 *
 * Scoped to the selection since #236 (ADR-0010): a shared service the `up`
 * does not select never trips it, however far it has drifted.
 * `details.services` names each drifted service with both revisions;
 * `details.port_conflicts` each named port a not-yet-running selected service
 * declares that a running shared service already owns. `running_hash` /
 * `local_hash` keep their pre-#236 meaning, the whole-subset hash
 * (`sharedStackHash`) of the shared instance's always-on services and of this
 * worktree's: for a stack with no namespaced shared service, exactly what
 * they always were. Per-service revisions are only in `services[]`.
 */
class SharedDriftError extends Error {
  readonly code = "SHARED_DRIFT" as const;
  readonly details: {
    readonly worktree_id: string;
    readonly running_hash: string;
    readonly local_hash: string;
    readonly services: ReadonlyArray<{
      readonly service: string;
      readonly running_hash: string;
      readonly local_hash: string;
    }>;
    readonly port_conflicts: ReadonlyArray<{
      readonly service: string;
      readonly port: string;
      readonly owner: string;
    }>;
    readonly remedy: string;
  };
  constructor(message: string, details: SharedDriftError["details"]) {
    super(message);
    this.name = "SharedDriftError";
    this.details = details;
  }
}

/**
 * Thrown when a shared named port cannot be resolved without handing one port
 * to two names or moving a recorded port (#238, ADR-0011): the shared port map
 * records a number another name holds, a running shared service binds a name
 * at a number other than the recorded one, or this `up` would start a shared
 * service whose port a running shared process was given a different number
 * for. Nothing was started, added or recorded. `details` carries
 * `{conflicts[], map_path, remedy}`; each conflict is `{reason, port_name,
 * port, recorded_port?, holder?, process?}`.
 */
class SharedPortConflictError extends Error {
  readonly code = "SHARED_PORT_CONFLICT" as const;
  readonly details: {
    readonly conflicts: ReadonlyArray<Record<string, string | number>>;
    readonly map_path: string;
    readonly remedy: string;
  };
  constructor(message: string, details: SharedPortConflictError["details"]) {
    super(message);
    this.name = "SharedPortConflictError";
    this.details = details;
  }
}

/**
 * Thrown when adding a selected namespaced shared service to the running
 * shared instance fails (#236, ADR-0010): process-compose refused the config
 * reload, could not be reached, or did not finish within its budget. The
 * services the instance already ran are untouched — the reload only adds
 * processes. On a refusal the shared derived config is restored; on a timeout
 * it is kept, because process-compose may still apply it. `details` carries
 * `{services, reason, config_path, remedy}`.
 */
class SharedActivationFailedError extends Error {
  readonly code = "SHARED_ACTIVATION_FAILED" as const;
  readonly details: {
    readonly services: ReadonlyArray<string>;
    readonly reason: "not_supported" | "error" | "timeout";
    readonly config_path: string;
    readonly remedy: string;
  };
  constructor(message: string, details: SharedActivationFailedError["details"]) {
    super(message);
    this.name = "SharedActivationFailedError";
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
 * `down --shared -n` (#239) refused: a live worktree instance has a booted
 * isolated service that `depends_on` a shared service it would remove
 * (overridable with `--force`), or a shared service it would keep does
 * (never overridable: removing the dependency would edit a running shared
 * service's definition, which restarts it). Nothing was stopped.
 */
class SharedInUseError extends Error {
  readonly code = "SHARED_IN_USE" as const;
  constructor(
    message: string,
    readonly details: {
      readonly namespaces: ReadonlyArray<string>;
      readonly services: ReadonlyArray<string>;
      readonly dependants: ReadonlyArray<SharedDependant>;
      /** False when a shared dependant blocks: `--force` would not help. */
      readonly forceable: boolean;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "SharedInUseError";
  }
}

/**
 * `down --shared -n` (#239) could not finish removing the shared services:
 * process-compose refused to stop them or they did not stop
 * (`stop_refused`, `stop_incomplete`: nothing was removed), or it refused or
 * timed out on the config reload that removes them (`not_supported`,
 * `error`, `timeout`). The other shared services are untouched either way.
 */
class SharedRemovalFailedError extends Error {
  readonly code = "SHARED_REMOVAL_FAILED" as const;
  constructor(
    message: string,
    readonly details: {
      readonly services: ReadonlyArray<string>;
      readonly reason: "stop_refused" | "stop_incomplete" | "not_supported" | "error" | "timeout";
      readonly config_path: string;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "SharedRemovalFailedError";
  }
}
