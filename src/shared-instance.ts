/**
 * The shared instance (ADR-0001): the one process-compose instance, anchored
 * at the git common dir, that runs every shared service some `up` selected
 * (ADR-0010). This module owns its `up` path (#257): the shared lifecycle
 * lock, the anchor state that path reads and writes (the shared state, the
 * shared port map and the shared-step markers) and the shared control socket.
 * `up`, `up --dry-run` and `env` reach the shared instance only through the
 * `SharedInstance` it opens.
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
 *  - the read-only previews (`up --dry-run`, `env`) take no lock, start
 *    nothing and write nothing.
 *
 * The shared teardown (`down --shared`, `down --shared -n`) and
 * `prune --shared-ports` are not here yet (#258).
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import {
  DEVTREES_METADATA_KEY,
  deriveSharedConfig,
  type DerivedConfig,
  type DerivedShared,
} from "./deriver.js";
import { reloadTimeoutMs, type Driver, type ServiceStatus } from "./driver.js";
import { sharedExtendedFields, sharedStackHash } from "./hash.js";
import {
  createWaitForSharedHealth,
  createWaitForSharedReady,
  probedNames,
  sharedServiceDeadError,
  startInOrder,
  type RestartedService,
  type WaitForSharedHealth,
  type WaitForSharedReady,
} from "./health.js";
import { readDerivedConfig, type InstanceStatus } from "./instances.js";
import {
  SOCKET_WAIT_TIMEOUT_MS,
  pollForSocket,
  socketIsLive,
  type LivenessProbe,
} from "./liveness.js";
import { formatSharedFieldChangeWarning } from "./output.js";
import {
  SHARED_INSTANCE_ID,
  assertSocketPathFits,
  ensureLogsDir,
  ensureRunDir,
  logsDir,
  sharedInstancePaths,
} from "./paths.js";
import { writeSharedStepMarker } from "./registry.js";
import { isAlwaysOnShared, selectSharedServices, sharedServicesOf } from "./selection.js";
import { dependencyOrder, findDeadServices } from "./service-state.js";
import { namespacedRecoveryRemedy, sharedStepServices } from "./shared-down.js";
import {
  UNKNOWN_REVISION,
  planSharedSelection,
  sharedRecords,
  withServiceRecords,
  type SharedPlan,
} from "./shared-drift.js";
import {
  blockingPortConflicts,
  liveSharedPortsOf,
  planSharedPorts,
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
import type { ResolvedService, ResolvedStack } from "./stack.js";

/** What the shared instance module needs from its caller: the anchor and the I/O seams. */
export interface SharedInstanceDeps {
  /** The anchor (the git common dir) the shared instance is rooted at. */
  readonly anchor: string;
  readonly driver: Driver;
  /** The shared lifecycle lock every change to the shared instance runs under. */
  readonly sharedLock: WithSharedLock;
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

/** The shared instance, as `up`, `up --dry-run` and `env` see it. */
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
}

/** Open the shared instance anchored at `deps.anchor`. */
export function openSharedInstance(deps: SharedInstanceDeps): SharedInstance {
  return {
    ensure: (request) => prepareShared(deps, request),
    preview: (request) => previewShared(deps, request),
    ports: (request) => readPorts(deps, request),
  };
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
    deps.sharedLock,
    {
      driver: deps.driver,
      probe: deps.liveness,
      socketTimeoutMs: deps.socketTimeoutMs,
      warn: deps.warn,
      readSharedRows: () =>
        deps.driver
          .getServiceStatuses(sharedInstancePaths(anchor).socketPath)
          .catch(() => undefined),
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
  const { socketPath } = sharedInstancePaths(anchor);
  if (!(await sharedSocketLive(deps))) return [];
  const state = readRecordedSharedState(anchor, stack);
  if (state === undefined) return [];
  const plan = planSharedSelection(selected, state.services);
  if (plan.drifted.length > 0 || plan.portConflicts.length > 0) return [];
  const rows = await deps.driver
    .getServiceStatuses(socketPath, { timeoutMs: deps.previewReadTimeoutMs })
    .catch(() => undefined);
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
  return await socketIsLive(
    sharedInstancePaths(deps.anchor).socketPath,
    deps.liveness,
    { command: "up", instance: SHARED_INSTANCE_ID },
    { readOnly: true },
  ).catch(() => false);
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
  readonly probe: LivenessProbe;
  /** Socket-bind wait window for the lazy start (issue #92). Default: 3s. */
  readonly socketTimeoutMs?: number;
  /** Sink for the shared-field-change warnings (#185). */
  readonly warn: (message: string) => void;
  /**
   * One `process list` read of the running shared instance; `undefined` when
   * it cannot be read. Lets a retried `up` see a service a timed-out add
   * recorded but process-compose never started (#236).
   */
  readonly readSharedRows: () => Promise<ServiceStatus[] | undefined>;
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
    const paths = sharedInstancePaths(anchor);
    // Unknown liveness (#186) fails INSTANCE_UNRESPONSIVE rather than
    // lazy-starting a second shared instance onto the same ports.
    const live = await socketIsLive(paths.socketPath, deps.probe, {
      command: "up",
      instance: SHARED_INSTANCE_ID,
    });
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
    if (live) return await reconcileLiveShared({ ...step, worktreeId });
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
  step: SharedStep & { readonly worktreeId: string },
): Promise<EnsuredShared> {
  const { anchor, stack, selected, portPlan, deps } = step;
  const ports = portPlan.ports;
  const state = readRecordedSharedState(anchor, stack);
  // Legacy fallback: a pre-#83 shared instance left no persisted state. Its
  // ports come from the stable map, seeded from its derived config (#238), as
  // long as nothing has to be added: what that instance runs cannot be known.
  if (state === undefined) {
    assertSharedPortsClean({ command: "up", ...step, binding: [], warn: deps.warn });
    const legacy = await legacySharedInstance(selected, anchor, deps);
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
  const rows = await readSelectedSharedRows(selected, plan, state, deps);
  const toAdd = servicesToAdd(selected, plan, state, rows);
  // Port conflicts after drift and before anything changes (#238): an added
  // service binds its recorded ports, which must not be another name's or
  // differ from what a running shared process was given for them. Only then
  // is the map recorded, so a refused `up` records nothing.
  assertSharedPortsClean({ command: "up", ...step, binding: toAdd, warn: deps.warn });
  recordSharedPorts(anchor, portPlan);
  // Restart before adding: a service being added may `depends_on` a dead one.
  const restarted = await restartDeadShared({
    stack,
    rows: rows ?? [],
    names: selectedNames.filter((name) => !toAdd.some((s) => s.name === name)),
    socketPath: sharedInstancePaths(anchor).socketPath,
    driver: deps.driver,
    remedyFor: deps.remedyFor,
  });
  if (toAdd.length === 0) {
    return { started: false, activated: [], restarted, ports, fieldChanges };
  }
  // Read before the add: a process the instance already lists is one a
  // removal (`down --shared -n`, #239) stopped but whose reload never landed.
  const before = rows ?? (await deps.readSharedRows());
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
  step: SharedStep,
  added: ReadonlyArray<ResolvedService>,
  before: ReadonlyArray<ServiceStatus>,
): Promise<RestartedService[]> {
  const listed = new Set(before.map((r) => r.name));
  return await restartDeadShared({
    stack: step.stack,
    rows: before,
    names: added.map((s) => s.name).filter((name) => listed.has(name)),
    socketPath: sharedInstancePaths(step.anchor).socketPath,
    driver: step.deps.driver,
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
  deps: EnsureSharedDeps,
): Promise<ServiceStatus[] | undefined> {
  const missing = new Set(plan.missing.map((s) => s.name));
  const recorded = selected.some((s) => !missing.has(s.name) && state.services[s.name]);
  return recorded ? await deps.readSharedRows() : undefined;
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
 * Restart the dead services among `names` — the selected shared services the
 * running shared instance already runs — over its control socket (#240,
 * ADR-0008). Called under the shared lifecycle lock, after the drift check,
 * with rows read under that lock, so two worktrees racing start each dead
 * service once: the second reads the first's restart as running.
 *
 * Dead versus done is `classifyService`'s: a crash, a kill or a non-zero
 * exit is dead; an exit-0 one-shot is done and never rerun, and a service
 * process-compose is already `Restarting` is left to it. Started in
 * `depends_on` order, since `process start` ignores it. A running shared
 * service is never stopped, restarted or reloaded: other worktrees use it.
 *
 * A start process-compose refuses fails `SHARED_SERVICE_DEAD` with
 * `reason: "start_refused"` (the services it did start keep running); one it
 * answers with "already running" was started by someone else and is not
 * reported. Returns the services started, each with the pid of the run that
 * died, for the health wait (`createWaitForSharedReady`).
 */
async function restartDeadShared(args: {
  readonly stack: ResolvedStack;
  readonly rows: ReadonlyArray<ServiceStatus>;
  readonly names: ReadonlyArray<string>;
  readonly socketPath: string;
  readonly driver: Driver;
  readonly remedyFor?: ((services: ReadonlyArray<string>) => string) | undefined;
}): Promise<RestartedService[]> {
  const dead = findDeadServices(args.rows, args.names);
  if (dead.length === 0) return [];
  const { restarted, failed } = await startInOrder({
    ...args,
    names: dependencyOrder(
      args.stack.services,
      dead.map((d) => d.name),
    ),
  });
  if (failed.length > 0) {
    const refused = dead.filter((d) => failed.some((f) => f.name === d.name));
    throw sharedServiceDeadError(refused, {
      reason: "start_refused",
      startFailures: failed,
      remedy: args.remedyFor?.(refused.map((d) => d.name)),
    });
  }
  return restarted;
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
  deps: EnsureSharedDeps,
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
  const rows = selected.length > 0 ? await deps.readSharedRows() : undefined;
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

/**
 * The entries of `record` whose key is in `keys`. Exported for the shared
 * teardown and `prune --shared-ports`, which still live in the commands
 * module until part 2 (#258).
 */
export function pick<V>(
  record: Readonly<Record<string, V>>,
  keys: Iterable<string>,
): Record<string, V> {
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
