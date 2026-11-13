/**
 * The live instance handle (#259): a process-compose instance at its control
 * socket, opened only once its liveness is known. A worktree instance and the
 * shared instance are the same thing to every command that reads or acts on
 * one, so the sequence each of them used to rebuild by hand lives here once:
 *
 *  1. resolve the instance's paths (ADR-0007);
 *  2. probe the control socket (#80): a listener is live, a definitive
 *     "nothing listening" is not (the orphaned file is unlinked unless the
 *     caller is read-only), and an answer that stays unknown fails
 *     `INSTANCE_UNRESPONSIVE` with the socket kept (#186);
 *  3. read the on-disk derived config;
 *  4. read the status rows within a time budget (#205, #226);
 *  5. refuse while a hot-reload is still pending (#191, #222);
 *  6. work out which selected services were never booted (ADR-0008, #170).
 *
 * The handle then offers what the commands do to a live instance: start the
 * dead services in `depends_on` order (ADR-0008, #178, #240) and the bounded
 * per-service stop and restart (ADR-0009). It owns no lock: a caller that
 * acts holds the instance's lifecycle lock around `open` and the action.
 *
 * Its two adapters, `openWorktreeInstance` and `openSharedLiveInstance`,
 * differ only in the instance's id and paths, and in how a refused start is
 * reported: `SERVICE_START_FAILED` for a worktree's own services,
 * `SHARED_SERVICE_DEAD` for shared services other worktrees use. A shared
 * instance has no pending-reload marker, so its guard never refuses.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { StopSeams } from "./bounded-down.js";
import { boundedRestart, type RestartOutcome } from "./bounded-restart.js";
import { boundedStopServices } from "./bounded-stop.js";
import type { DerivedConfig } from "./deriver.js";
import { unsignalledServices } from "./down-survivors.js";
import type { Driver, InstanceRef, ServiceStatus } from "./driver.js";
import {
  isGone,
  readStatusesWithin,
  sharedServiceDeadError,
  startInOrder,
  type RestartedService,
} from "./health.js";
import type { InstanceStatus } from "./instances.js";
import {
  instanceUnresponsiveError,
  socketIsLive,
  unresponsiveRemedy,
  type LivenessContext,
  type LivenessProbe,
} from "./liveness.js";
import { SHARED_INSTANCE_ID, instancePaths, sharedInstancePaths } from "./paths.js";
import { readPendingReload, stuckFromMarker, type StuckReload } from "./reload-pending.js";
import {
  assertNamedTargetsBooted,
  formatUpCommand,
  provenNamespaces,
  selectRunningUp,
  serviceNamespaces,
  type DroppedNamespaceEdge,
  type DerivedProcesses,
  type NamedRequest,
  type NamedSelection,
  type NamedServiceCommand,
} from "./selection.js";
import { dependencyOrder, findDeadServices } from "./service-state.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";
import { stopTimeoutMs } from "./stop-services.js";

/** The I/O a live instance handle needs: the Driver and the socket probes. */
export interface LiveInstanceSeams {
  readonly driver: Driver;
  /** The liveness probe `open` runs, with its retry backoff for `unknown` (#80, #186). */
  readonly liveness: LivenessProbe;
  /** The control-socket probe a failed status read is followed by (#205). */
  readonly probeSocket: (socketPath: string) => Promise<InstanceStatus>;
}

/** Who opens the instance, for the `INSTANCE_UNRESPONSIVE` envelope (#186). */
export type OpenContext = Omit<LivenessContext, "instance">;

/** How `open` treats a stale socket file. */
export interface OpenOptions {
  /**
   * A read-only caller (`up --dry-run`, a remedy): a stale socket file is
   * left in place. Default: unlinked, so the next start finds no orphan.
   */
  readonly readOnly?: boolean;
}

/** A status read's tuning. */
export interface RowsOptions {
  /** Told once when reads start failing and are retried (stderr). */
  readonly notify?: (message: string) => void;
  /**
   * Probe a failed read with the handle's `probeSocket` (default). `false`
   * keeps the health module's own default probe (`probeSocket` from
   * src/instances.ts), which `up`'s dead-service restart has always used.
   */
  readonly probe?: boolean;
  /**
   * A read that never answers within the budget is `INSTANCE_UNRESPONSIVE`
   * (nothing was touched, so it is not a health wait). Default: the
   * `HEALTH_TIMEOUT` of the bounded read.
   */
  readonly unresponsive?: boolean;
}

/** The rows the pending-reload guard decides from. */
export interface PendingReloadCheck {
  /** One read of the project; `undefined` when it failed (only old PIDs are evidence then). */
  readonly rows: ServiceStatus[] | undefined;
  /** The derived processes the instance runs now (its on-disk config). */
  readonly previous: DerivedProcesses | undefined;
  /** The isolated services, for the reboot remedy. */
  readonly isolated: ReadonlyArray<Pick<ResolvedService, "name" | "namespace">>;
  /** The namespaces the command asked for (`-n`). */
  readonly requested: ReadonlyArray<string>;
  /** Is an old run's pid alive? */
  readonly isAlive: (pid: number) => boolean;
  /** Who is refusing (#222). Default `up`. */
  readonly command?: "up" | NamedServiceCommand;
  /** What the remedy says to rerun once the reload is done. Default `devtrees up`. */
  readonly retry?: string;
}

/** What `up` does to a running instance, decided from one read (ADR-0008). */
export interface RunningPlan {
  readonly namespaces: ReadonlyArray<string>;
  readonly services: ReadonlyArray<ResolvedService>;
  readonly droppedNamespaceEdges: ReadonlyArray<DroppedNamespaceEdge>;
  /** The dead selected isolated services, in `depends_on` order. */
  readonly dead: string[];
  readonly shared: ReadonlyArray<ResolvedService>;
}

/** A request to start the dead services among `names`. */
export interface RestartDeadRequest {
  /** The rows that decide which are dead (and the pid each one's run had). */
  readonly rows: ReadonlyArray<ServiceStatus>;
  readonly names: ReadonlyArray<string>;
  /** The declared services, for the `depends_on` order (`process start` ignores it). */
  readonly order: ReadonlyArray<Pick<ResolvedService, "name" | "dependsOn">>;
  /** The remedy a refusal names, for the refused services. */
  readonly remedyFor?: ((services: ReadonlyArray<string>) => string) | undefined;
}

/** A bounded per-service stop or restart's view of the instance. */
export interface BoundedRequest {
  /** The rows read under the caller's lock. */
  readonly rows: ReadonlyArray<ServiceStatus>;
  /** The instance's derived config: the shutdown budgets and hooks. */
  readonly config: DerivedConfig | undefined;
  readonly seams?: StopSeams | undefined;
}

/** A process-compose instance whose control socket answered (#259). */
export interface LiveInstance {
  /** The worktree id, or `SHARED_INSTANCE_ID`. */
  readonly id: string;
  readonly socketPath: string;
  readonly configPath: string;
  /** The control socket and derived config, as the Driver takes them. */
  readonly ref: InstanceRef;
  /** The on-disk derived config's `processes`; `undefined` when unreadable. */
  processes(): DerivedProcesses | undefined;
  /**
   * The status rows, retried within `budgetMs` (#205, #226). A process-compose
   * gone meanwhile is `INSTANCE_NOT_FOUND`; one that never answers is
   * `HEALTH_TIMEOUT`, or `INSTANCE_UNRESPONSIVE` with `unresponsive`.
   */
  rows(budgetMs: number, options?: RowsOptions): Promise<ServiceStatus[]>;
  /** One status read; `undefined` when it failed. No timeout: the Driver's own. */
  tryRows(timeoutMs?: number): Promise<ServiceStatus[] | undefined>;
  /**
   * Refuse while a hot-reload is still pending (#191, #222): throws
   * `CONFIG_DRIFT` `reload_pending`. `true` when a successful read shows the
   * reload converged (the real `up` then clears the marker).
   */
  assertNoPendingReload(check: PendingReloadCheck): boolean;
  /**
   * The booted selection a running-instance `up` targets (ADR-0008): a
   * requested namespace that was never booted is `NAMESPACE_NOT_RUNNING`.
   */
  planUp(
    stack: ResolvedStack,
    rows: ReadonlyArray<ServiceStatus>,
    requested: ReadonlyArray<string> | undefined,
  ): RunningPlan;
  /** A per-service verb's targets must be booted (`NAMESPACE_NOT_RUNNING`, #224). */
  assertNamedBooted(
    request: Pick<NamedRequest, "worktreeId" | "command" | "declared">,
    selection: NamedSelection,
    rows: ReadonlyArray<ServiceStatus>,
  ): void;
  /**
   * Start the dead services among `names` in `depends_on` order (ADR-0008).
   * Every one is attempted; a refusal fails with the adapter's error. Returns
   * the ones started, each with the pid of the run that died.
   */
  restartDead(request: RestartDeadRequest): Promise<RestartedService[]>;
  /** Restart one service in place with the bounded restart (ADR-0009). */
  restart(service: string, request: BoundedRequest): Promise<RestartOutcome>;
  /** Stop services with the bounded per-service stop (#190, #239). */
  stop(
    services: ReadonlyArray<string>,
    request: BoundedRequest,
  ): ReturnType<typeof boundedStopServices>;
  /** Did process-compose exit? A probe; a probe that fails is not "gone". */
  gone(): Promise<boolean>;
}

/** How an adapter reports what differs between the two tiers. */
interface Adapter {
  readonly id: string;
  readonly anchor: string;
  readonly paths: { readonly socketPath: string; readonly configPath: string };
  readonly startRefused: (
    dead: ReturnType<typeof findDeadServices>,
    failed: ReadonlyArray<{ readonly name: string; readonly message: string }>,
    remedyFor: RestartDeadRequest["remedyFor"],
  ) => Error;
  readonly pendingReload: boolean;
}

/**
 * Open this worktree's instance (#259): `undefined` when its socket is absent
 * or stale, `INSTANCE_UNRESPONSIVE` when its liveness stays unknown.
 */
export async function openWorktreeInstance(
  anchor: string,
  worktreeId: string,
  seams: LiveInstanceSeams,
  context: OpenContext,
  options: OpenOptions = {},
): Promise<LiveInstance | undefined> {
  const adapter: Adapter = {
    id: worktreeId,
    anchor,
    paths: instancePaths(anchor, worktreeId),
    startRefused: (_dead, failed, remedyFor) =>
      serviceStartFailedError(
        worktreeId,
        failed,
        remedyFor?.(failed.map((f) => f.name)) ?? "devtrees down && devtrees up",
      ),
    pendingReload: true,
  };
  return await open(adapter, seams, context, options);
}

/**
 * Open the shared instance (#259): `undefined` when its socket is absent or
 * stale, `INSTANCE_UNRESPONSIVE` when its liveness stays unknown.
 */
export async function openSharedLiveInstance(
  anchor: string,
  seams: LiveInstanceSeams,
  context: OpenContext,
  options: OpenOptions = {},
): Promise<LiveInstance | undefined> {
  const adapter: Adapter = {
    id: SHARED_INSTANCE_ID,
    anchor,
    paths: sharedInstancePaths(anchor),
    startRefused: (dead, failed, remedyFor) => {
      const refused = dead.filter((d) => failed.some((f) => f.name === d.name));
      return sharedServiceDeadError(refused, {
        reason: "start_refused",
        startFailures: failed,
        remedy: remedyFor?.(refused.map((d) => d.name)),
      });
    },
    pendingReload: false,
  };
  return await open(adapter, seams, context, options);
}

async function open(
  adapter: Adapter,
  seams: LiveInstanceSeams,
  context: OpenContext,
  options: OpenOptions,
): Promise<LiveInstance | undefined> {
  const { socketPath, configPath } = adapter.paths;
  const liveness: LivenessContext = { ...context, instance: adapter.id };
  const live = await socketIsLive(socketPath, seams.liveness, liveness, options);
  if (!live) return undefined;
  const ref = { configPath, socketPath };
  const { driver } = seams;
  return {
    id: adapter.id,
    socketPath,
    configPath,
    ref,
    processes: () =>
      derivedProcesses(existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined),
    rows: (budgetMs, rowsOptions = {}) =>
      readRows(seams, liveness, socketPath, budgetMs, rowsOptions),
    tryRows: (timeoutMs) =>
      (timeoutMs === undefined
        ? driver.getServiceStatuses(socketPath)
        : driver.getServiceStatuses(socketPath, { timeoutMs })
      ).catch(() => undefined),
    assertNoPendingReload: (check) =>
      adapter.pendingReload ? assertNoPendingReload(adapter.anchor, adapter.id, check) : false,
    planUp: (stack, rows, requested) => planRunningInstance(stack, adapter.id, rows, requested),
    assertNamedBooted: (request, selection, rows) =>
      assertNamedTargetsBooted(request, selection, rows),
    restartDead: (request) => restartDead(adapter, driver, request),
    restart: (service, request) =>
      boundedRestart(
        {
          socketPath,
          service,
          statuses: request.rows,
          timeoutMs: stopTimeoutMs(request.config, [service], request.seams?.baseTimeoutMs),
          unsignalled: unsignalledServices(request.config),
          instance: adapter.id,
          instanceGone: () => isGone(seams.probeSocket, socketPath),
        },
        {
          stopProcesses: (socket, services) => driver.stopProcesses(socket, services),
          startProcess: (socket, name) => driver.startProcess(socket, name),
          getServiceStatuses: (socket) => driver.getServiceStatuses(socket),
        },
        request.seams,
      ),
    stop: (services, request) =>
      boundedStopServices(
        {
          socketPath,
          services,
          statuses: request.rows,
          timeoutMs: stopTimeoutMs(request.config, services, request.seams?.baseTimeoutMs),
          unsignalled: unsignalledServices(request.config),
          instance: adapter.id,
          instanceGone: () => isGone(seams.probeSocket, socketPath),
        },
        {
          stopProcesses: (socket, names) => driver.stopProcesses(socket, names),
          getServiceStatuses: (socket) => driver.getServiceStatuses(socket),
        },
        request.seams,
      ),
    gone: () => isGone(seams.probeSocket, socketPath),
  };
}

/** The bounded status read; see `LiveInstance.rows`. */
async function readRows(
  seams: LiveInstanceSeams,
  liveness: LivenessContext,
  socketPath: string,
  budgetMs: number,
  options: RowsOptions,
): Promise<ServiceStatus[]> {
  try {
    return await readStatusesWithin(seams.driver, socketPath, budgetMs, {
      ...(options.notify !== undefined ? { notify: options.notify } : {}),
      ...(options.probe === false ? {} : { probe: seams.probeSocket }),
    });
  } catch (err) {
    if (options.unresponsive !== true || (err as { code?: unknown }).code !== "HEALTH_TIMEOUT") {
      throw err;
    }
    throw instanceUnresponsiveError(liveness.command, {
      instance: liveness.instance,
      socket_path: socketPath,
      attempts: 1,
      remedy: unresponsiveRemedy(socketPath, liveness),
    });
  }
}

/** Start the dead services among `names`; see `LiveInstance.restartDead`. */
async function restartDead(
  adapter: Adapter,
  driver: Driver,
  request: RestartDeadRequest,
): Promise<RestartedService[]> {
  const dead = findDeadServices(request.rows, request.names);
  if (dead.length === 0) return [];
  const { restarted, failed } = await startInOrder({
    rows: request.rows,
    names: dependencyOrder(
      request.order,
      dead.map((d) => d.name),
    ),
    socketPath: adapter.paths.socketPath,
    driver,
  });
  if (failed.length > 0) throw adapter.startRefused(dead, failed, request.remedyFor);
  return restarted;
}

/**
 * What `up` does to a running instance, decided from one `process list` read
 * (ADR-0008). Pure: the real `up` and `up --dry-run` (#210) both decide
 * through it, so the preview cannot drift from the command it previews.
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
): RunningPlan {
  const selection = selectRunningUp(stack, worktreeId, rows, requested);
  const names = selection.isolated.map((s) => s.name);
  const dead = findDeadServices(rows, names).map((d) => d.name);
  return {
    namespaces: selection.namespaces,
    services: selection.isolated,
    droppedNamespaceEdges: selection.droppedNamespaceEdges,
    dead: dependencyOrder(stack.services, dead),
    shared: selection.shared,
  };
}

/** The `processes` map of a derived config's YAML, or `undefined` if unreadable. */
export function derivedProcesses(yaml: string | undefined): DerivedProcesses | undefined {
  if (yaml === undefined) return undefined;
  try {
    const processes = (parseYaml(yaml) as { processes?: unknown } | null)?.processes;
    return processes !== null && typeof processes === "object"
      ? (processes as DerivedProcesses)
      : undefined;
  } catch {
    return undefined;
  }
}

// --- pending reload (#191) ---------------------------------------------------

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

export class ConfigDriftError extends Error {
  readonly code = "CONFIG_DRIFT";
  readonly details: ConfigDriftDetails;
  constructor(message: string, details: ConfigDriftDetails) {
    super(message);
    this.name = "ConfigDriftError";
    this.details = details;
  }
}

/**
 * Refuse to reload while a previous reload is still pending (#191; see
 * src/reload-pending.ts). The marker is checked whenever there is one.
 * Pure apart from reading the marker, so `up --dry-run` can raise the same
 * refusal (#210): returns `true` when a successful read shows the reload
 * converged, and the caller (the real `up` only) then clears the marker; a
 * failed read leaves it in place, with only the old PIDs as evidence.
 */
function assertNoPendingReload(
  anchor: string,
  worktreeId: string,
  check: PendingReloadCheck,
): boolean {
  const marker = readPendingReload(anchor, worktreeId);
  if (marker === undefined) return false;
  const stuck = stuckFromMarker(marker, check.rows, check.isAlive);
  if (stuck !== undefined) {
    throw reloadPendingError(
      worktreeId,
      stuck,
      pendingRemedyUp({ ...check, stuck }),
      check.command,
      check.retry,
    );
  }
  return check.rows !== undefined;
}

/**
 * The `down` + `up` that reboots the instance with the namespaces it runs:
 * the ones this `up` asked for, those the project proves booted (a narrower
 * `-n` must not drop the rest), and the stuck services' own when they have
 * exactly one (they were running before the reload).
 */
function pendingRemedyUp(args: PendingReloadCheck & { readonly stuck: StuckReload }): string {
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

// --- refused starts (#178) ---------------------------------------------------

/**
 * Thrown when `up` asks process-compose to restart a dead selected service
 * on a running instance and the start request itself fails (ADR-0008, issue
 * #178): process-compose refused or errored. Distinct from `HEALTH_TIMEOUT`,
 * which is a service that started but never became healthy. Nothing is
 * stopped; the instance keeps running and `details.remedy` is the `down` +
 * `up` that restarts the whole stack.
 */
export class ServiceStartFailedError extends Error {
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
