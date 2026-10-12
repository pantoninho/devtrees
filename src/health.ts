/**
 * Health waits (driver-backed pollers).
 *
 * The default implementations of the orchestration layer's two health gates:
 * the shared-tier wait that stands in for the cross-tier `depends_on` edge
 * process-compose cannot express (ADR-0003), and the worktree-instance wait
 * that keeps `up` from returning 0 before the stack can serve traffic
 * (PRD #26, ADR-0005).
 *
 * Both poll the driver's async `getServiceStatuses` — the documented shell-out
 * boundary — so they honor whatever binary/prefix args the instance was
 * spawned with (issue #87). They never shell out themselves, and never block
 * the event loop.
 */

import { READ_TIMEOUT_MS, type ServiceStatus } from "./driver.js";
import {
  classifyService,
  deadServicesDetails,
  describeDeadServices,
  findDeadServices,
  type DeadService,
} from "./service-state.js";

/**
 * The slice of the driver the pollers need: one async read of an instance's
 * per-service runtime state over its UDS. Structural, so tests can hand in a
 * canned source and `createDriver(...)` satisfies it as-is.
 */
export interface ServiceStatusSource {
  /**
   * `opts.timeoutMs` bounds this one read: a read still pending then is
   * killed and rejects. Waits pass what is left of their budget (capped by
   * the driver), so a wedged instance cannot outlive the wait.
   */
  getServiceStatuses(
    socketPath: string,
    opts?: { readonly timeoutMs?: number },
  ): Promise<ServiceStatus[]>;
}

/**
 * Wait until every shared service is healthy enough that an isolated service
 * depending on it can be started. Called between starting the shared instance
 * and starting the worktree instance whenever the worktree has cross-tier
 * `depends_on` edges (ADR-0003). The default polls the driver over the shared
 * instance's UDS; tests stub it.
 */
export type WaitForSharedHealth = (args: {
  readonly anchor: string;
  readonly socketPath: string;
  readonly sharedServiceNames: ReadonlyArray<string>;
  /**
   * The subset of `sharedServiceNames` that declares a readiness probe in the
   * resolved stack. These gate on `health === "ready"` instead of process
   * state (issue #108) — see `poll`.
   */
  readonly probedServiceNames: ReadonlyArray<string>;
}) => Promise<void>;

/**
 * Wait until every named service in an instance is healthy. Called after the
 * worktree instance starts so `up` only returns 0 when the stack can actually
 * serve traffic (PRD #26, ADR-0005). On timeout, implementations must throw a
 * `HealthTimeoutError` — left running, not torn down, so the agent can inspect
 * the failure with `devtrees logs <service>` afterwards.
 */
export type WaitForHealth = (args: {
  readonly socketPath: string;
  readonly serviceNames: ReadonlyArray<string>;
  /**
   * The subset of `serviceNames` that declares a readiness probe in the
   * resolved stack. These gate on `health === "ready"` instead of process
   * state (issue #108) — see `poll`.
   */
  readonly probedServiceNames: ReadonlyArray<string>;
  readonly timeoutMs: number;
  /**
   * The command that brings the stack back, named when a waited-on service
   * is dead (ADR-0008) — e.g. `devtrees down && devtrees up -n app`. Default:
   * `devtrees down && devtrees up`.
   */
  readonly remedy?: string;
  /**
   * Services this `up` just restarted (issue #178). Their pre-restart dead
   * row may still be what a poll reads, so it does not count towards the
   * fail-fast — see `createRestartTracker`.
   */
  readonly restarted?: ReadonlyArray<RestartedService>;
}) => Promise<void>;

/** A service `up` restarted, and the pid of the run that died (when known). */
export interface RestartedService {
  readonly name: string;
  readonly stalePid?: number;
}

/**
 * Throw on health-wait timeout; carries the `HEALTH_TIMEOUT` error code so the
 * CLI's error classifier (`classifyError` in output.ts) routes it to the
 * documented `--json` envelope without pattern-matching on the message. The
 * classifier reads `code` by duck-typing, so the class stays module-private —
 * callers branch on `err.code`/`err.name`, never on the class identity.
 */
class HealthTimeoutError extends Error {
  readonly code = "HEALTH_TIMEOUT" as const;
  constructor(
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HealthTimeoutError";
  }
}

/**
 * One successful read of an instance's per-service state, retrying failed
 * reads (a busy or briefly unreachable socket). `timeoutMs` bounds the whole
 * call: each read gets at most what is left of the budget (and never more
 * than the driver's read cap), so a `process list` that never returns is
 * killed at the deadline instead of waited on. Total time stays within
 * `timeoutMs` plus one poll delay. `up` on a running instance needs this read
 * to know what was booted (ADR-0008), and must never report success without
 * it. When the deadline passes after a failed read it throws `HEALTH_TIMEOUT`,
 * leaving the instance running like any other wait failure. The first failed
 * read is reported once through `tuning.notify`.
 */
export async function readStatusesWithin(
  source: ServiceStatusSource,
  socketPath: string,
  timeoutMs: number,
  tuning: Pick<PollerTuning, "pollMs" | "notify"> = {},
): Promise<ServiceStatus[]> {
  const pollMs = tuning.pollMs ?? HEALTH_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const notifyFailure = createFailureNotifier(tuning.notify, timeoutMs);
  let lastError: unknown;
  do {
    try {
      return await source.getServiceStatuses(socketPath, { timeoutMs: readBudget(deadline) });
    } catch (err) {
      lastError = err;
      notifyFailure(err);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  const reason = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new HealthTimeoutError(
    `could not read the running instance's service state within ${timeoutMs}ms${reason}. ` +
      `The worktree instance is still running — inspect it with \`devtrees ls --json\`, ` +
      `or restart it with \`devtrees down\` and \`devtrees up\`.`,
  );
}

/** One read's budget: what is left until `deadline`, capped at the driver's read cap. */
function readBudget(deadline: number): number {
  return Math.max(1, Math.min(READ_TIMEOUT_MS, deadline - Date.now()));
}

/**
 * A once-only notice that status reads are failing and being retried, so a
 * wait that can run for the whole `--wait-timeout` is not silent. Goes to the
 * caller's `notify` (stderr, like every other `up` warning); a no-op without one.
 */
function createFailureNotifier(
  notify: ((message: string) => void) | undefined,
  timeoutMs: number,
): (err: unknown) => void {
  let told = false;
  return (err) => {
    if (told || notify === undefined) return;
    told = true;
    const why = err instanceof Error ? ` (${err.message})` : "";
    notify(
      `devtrees: reading the instance's service status failed${why}; ` +
        `retrying for up to ${Math.round(timeoutMs / 1000)}s...`,
    );
  };
}

/**
 * "Healthy enough" for a service WITHOUT a readiness probe = the process is
 * up: `Running`, or `Completed` for one-shot jobs (`Ready` is kept for
 * forward-compatibility with status vocabularies that fold readiness into the
 * status string). Anything else (`Pending`, `Restarting`, `Failed`) means we
 * keep waiting.
 *
 * Services WITH a readiness probe never gate on this set. Empirically
 * process-compose keeps their `status` at `Running` while the probe verdict
 * arrives in the separate `is_ready` field (the driver normalises it into
 * `ServiceStatus.health`), so a status-only gate would pass the instant the
 * process spawns — before the first probe can fire (issue #108). Probed
 * services are healthy only when `health === "ready"`.
 */
const HEALTHY_STATES = new Set(["running", "ready", "completed"]);

const SHARED_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 200;

/** Test seams for the poll cadence and (shared wait only) the deadline. */
export interface PollerTuning {
  /** Delay between polls. Default: 200ms. */
  readonly pollMs?: number;
  /** Shared-wait deadline. Default: 30s. The worktree wait takes its deadline per call. */
  readonly timeoutMs?: number;
  /** Told once when status reads start failing and being retried. Default: silent. */
  readonly notify?: (message: string) => void;
}

/** One poll's verdict over the named services. */
interface PollVerdict {
  readonly healthy: boolean;
  /** Named services that are dead (`classifyService`), in `serviceNames` order. */
  readonly dead: ReadonlyArray<DeadService>;
  /** Named services not yet healthy (dead ones included), in `serviceNames` order. */
  readonly pending: ReadonlyArray<string>;
  /** The rows the poll read; empty when the read failed. */
  readonly rows: ReadonlyArray<ServiceStatus>;
  /** Why the read failed, when it did. */
  readonly readError?: unknown;
}

/**
 * One poll: read the instance's per-service state through the driver and
 * report whether every named service is healthy, and which are dead. Probed
 * services (those in `probedServiceNames`) require `health === "ready"`; the
 * rest gate on process state (`HEALTHY_STATES`). A failed read (socket not
 * reachable yet — the instance is still starting, or wedged and the read timed
 * out) is "not ready, keep polling", never an error; the verdict carries the
 * cause in `readError`.
 *
 * A dead service is never healthy, whatever its status string: a crashed
 * `Completed` (non-zero exit) would otherwise pass the status gate the same
 * way a finished one-shot does (ADR-0008).
 */
async function poll(
  source: ServiceStatusSource,
  socketPath: string,
  serviceNames: ReadonlyArray<string>,
  probedServiceNames: ReadonlyArray<string>,
  deadline: number,
): Promise<PollVerdict> {
  let statuses: ServiceStatus[];
  try {
    statuses = await source.getServiceStatuses(socketPath, { timeoutMs: readBudget(deadline) });
  } catch (readError) {
    return { healthy: false, dead: [], pending: serviceNames, rows: [], readError };
  }
  const dead = findDeadServices(statuses, serviceNames);
  const deadNames = new Set(dead.map((d) => d.name));
  const probed = new Set(probedServiceNames);
  const rows = new Map(statuses.map((s) => [s.name, s]));
  const pending = serviceNames.filter((name) => {
    const row = rows.get(name);
    if (row === undefined || deadNames.has(name)) return true;
    if (probed.has(name)) return row.health !== "ready";
    return !HEALTHY_STATES.has(row.status.toLowerCase());
  });
  return { healthy: pending.length === 0, dead, pending, rows: statuses };
}

/**
 * Fail-fast guard for services `up` just restarted (issue #178). Right after
 * `process start`, a poll could still read the run that died (`Completed`,
 * exit `-1`), and two such reads would fail-fast a service that is in fact
 * starting. So a restarted service's dead row is **stale**, and ignored by
 * the fail-fast, until either:
 *
 *   - the service has been read alive (any non-dead verdict) since the
 *     restart, so a later dead row is the restarted run dying; or
 *   - the dead row carries a pid other than the one that died before the
 *     restart, so it is the restarted run's own exit (a process that dies
 *     too fast to ever be read running).
 *
 * Without a pid on either side only the first applies. A stale row is still
 * not healthy, and is reported as dead if the deadline passes.
 *
 * Returns a filter from one poll's verdict to the dead services that count.
 */
function createRestartTracker(
  restarted: ReadonlyArray<RestartedService>,
): (verdict: PollVerdict) => ReadonlyArray<DeadService> {
  const awaiting = new Map(restarted.map((r) => [r.name, r.stalePid]));
  return (verdict) => {
    const rows = new Map(verdict.rows.map((r) => [r.name, r]));
    for (const name of awaiting.keys()) {
      const row = rows.get(name);
      if (row !== undefined && classifyService(row) !== "dead") awaiting.delete(name);
    }
    return verdict.dead.filter((d) => {
      if (!awaiting.has(d.name)) return true;
      const stalePid = awaiting.get(d.name);
      const pid = rows.get(d.name)?.pid;
      return stalePid !== undefined && pid !== undefined && pid !== stalePid;
    });
  };
}

/** Same names in the same order — a dead set that held still across two polls. */
function sameDead(a: ReadonlyArray<DeadService>, b: ReadonlyArray<DeadService>): boolean {
  return a.length === b.length && a.every((d, i) => d.name === b[i]?.name);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Default shared-health wait: polls the driver over the shared instance's UDS
 * until every shared service reports a healthy state or the timeout expires.
 * A zero-service wait returns immediately.
 */
export function createWaitForSharedHealth(
  source: ServiceStatusSource,
  tuning: PollerTuning = {},
): WaitForSharedHealth {
  const pollMs = tuning.pollMs ?? HEALTH_POLL_MS;
  const timeoutMs = tuning.timeoutMs ?? SHARED_HEALTH_TIMEOUT_MS;
  return async ({ socketPath, sharedServiceNames, probedServiceNames }) => {
    if (sharedServiceNames.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    const notifyFailure = createFailureNotifier(tuning.notify, timeoutMs);
    let lastDead: ReadonlyArray<DeadService> = [];
    while (Date.now() < deadline) {
      const verdict = await poll(
        source,
        socketPath,
        sharedServiceNames,
        probedServiceNames,
        deadline,
      );
      if (verdict.healthy) return;
      if (verdict.readError !== undefined) notifyFailure(verdict.readError);
      // Same two-consecutive-reads rule as the worktree wait: a shared service
      // that died (e.g. right after this `up` lazy-started it) will not come
      // back by waiting, and it is reported, never restarted (ADR-0008).
      if (verdict.dead.length > 0 && sameDead(verdict.dead, lastDead)) {
        throw sharedServiceDeadError(verdict.dead);
      }
      lastDead = verdict.dead;
      await sleep(pollMs);
    }
    if (lastDead.length > 0) throw sharedServiceDeadError(lastDead);
    throw new Error(
      `timed out waiting for shared services to be healthy [${sharedServiceNames.join(", ")}] ` +
        `after ${timeoutMs}ms. Check the shared instance's logs (\`devtrees attach --shared\`).`,
    );
  };
}

/**
 * Default worktree health-wait: same poll loop as the shared variant — only
 * the service set, deadline source, and timeout error differ. On timeout,
 * throws `HealthTimeoutError` so the CLI maps it to the documented
 * `HEALTH_TIMEOUT` envelope without pattern-matching on the message
 * (ADR-0005). A zero-service wait returns immediately so a stack with no
 * isolated services does not synthesize a timeout out of thin air.
 *
 * Fails fast on a dead service (ADR-0008): a crashed process is not going to
 * become healthy by waiting, so once the same services read dead on two
 * consecutive polls the wait throws `HEALTH_TIMEOUT` straight away, naming
 * them and `remedy`. Two reads, not one, so the instant between a crash and
 * process-compose flipping a restartable process to `Restarting` is never
 * mistaken for a final state. Nothing is restarted here: `up` restarts dead
 * services before the wait (issue #178) and names them in `restarted`, whose
 * stale pre-restart rows do not count (`createRestartTracker`).
 */
export function createWaitForHealth(
  source: ServiceStatusSource,
  tuning: PollerTuning = {},
): WaitForHealth {
  const pollMs = tuning.pollMs ?? HEALTH_POLL_MS;
  return async (args) => {
    const { socketPath, serviceNames, probedServiceNames, timeoutMs } = args;
    if (serviceNames.length === 0) return;
    const countable = createRestartTracker(args.restarted ?? []);
    const dying = deadServicesErrorFor(args);
    const deadline = Date.now() + timeoutMs;
    const notifyFailure = createFailureNotifier(tuning.notify, timeoutMs);
    let lastDead: ReadonlyArray<DeadService> = [];
    let last: PollVerdict | undefined;
    while (Date.now() < deadline) {
      last = await poll(source, socketPath, serviceNames, probedServiceNames, deadline);
      if (last.healthy) return;
      if (last.readError !== undefined) notifyFailure(last.readError);
      const dead = countable(last);
      if (dead.length > 0 && sameDead(dead, lastDead)) throw dying(dead);
      lastDead = dead;
      await sleep(pollMs);
    }
    throw deadlineError(last, serviceNames, timeoutMs, dying);
  };
}

/** Build the dead-service `HEALTH_TIMEOUT` for one wait's remedy and restarts. */
function deadServicesErrorFor(args: {
  readonly remedy?: string;
  readonly restarted?: ReadonlyArray<RestartedService>;
}): (dead: ReadonlyArray<DeadService>) => HealthTimeoutError {
  const fix = args.remedy ?? "devtrees down && devtrees up";
  const restartedNames = new Set((args.restarted ?? []).map((r) => r.name));
  return (dead) => deadServicesError(dead, fix, restartedNames);
}

/**
 * The `HEALTH_TIMEOUT` once the wait window has run out. A service the last
 * poll read dead is reported as dead, stale pre-restart row or not; otherwise
 * it names the services that never became healthy.
 */
function deadlineError(
  last: PollVerdict | undefined,
  serviceNames: ReadonlyArray<string>,
  timeoutMs: number,
  dying: (dead: ReadonlyArray<DeadService>) => HealthTimeoutError,
): HealthTimeoutError {
  if (last !== undefined && last.dead.length > 0) return dying(last.dead);
  const pending = last?.pending ?? serviceNames;
  return new HealthTimeoutError(
    `timed out waiting for services to be healthy [${pending.join(", ")}] ` +
      `after ${timeoutMs}ms. The worktree instance is still running — ` +
      `inspect it with \`devtrees logs <service>\` or \`devtrees ls --json\`.`,
  );
}

/**
 * Thrown when a shared service is dead (ADR-0008): by the dead-shared check
 * `up` runs whenever it finds the shared instance already running, and by
 * the shared-health wait when a service dies after this `up` started it.
 * Shared services are reported, never restarted: the shared instance serves
 * every worktree, so a worktree's `up` must not bounce it. A code of its own,
 * not `HEALTH_TIMEOUT`, because the remedy tears down a different instance
 * (`devtrees down --shared`) — the same reason `WORKTREE_START_FAILED` was
 * split from `SHARED_START_FAILED` (ADR-0005): agents branch on `error.code`,
 * not on prose. Module-private like `HealthTimeoutError`; build it with
 * `sharedServiceDeadError`.
 */
class SharedServiceDeadError extends Error {
  readonly code = "SHARED_SERVICE_DEAD" as const;
  constructor(
    message: string,
    readonly details: {
      readonly dead_services: ReadonlyArray<{ name: string; status: string; exit_code?: number }>;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "SharedServiceDeadError";
  }
}

/** The `SHARED_SERVICE_DEAD` error for the given dead shared services. */
export function sharedServiceDeadError(dead: ReadonlyArray<DeadService>): Error {
  const remedy = "devtrees down --shared && devtrees up";
  return new SharedServiceDeadError(
    `devtrees up: shared service(s) not running: ${describeDeadServices(dead)}. devtrees ` +
      `does not restart shared services from a worktree's \`up\` — every worktree uses ` +
      `them. Run \`${remedy}\` to bring the shared instance back.`,
    { dead_services: deadServicesDetails(dead), remedy },
  );
}

/**
 * The `HEALTH_TIMEOUT` a dead service produces: names each dead service with
 * its status and exit code, which of them this `up` already restarted, and
 * the `down` + `up` that restarts the whole stack. The instance is left
 * running (ADR-0005) so its logs stay readable.
 */
function deadServicesError(
  dead: ReadonlyArray<DeadService>,
  remedy: string,
  restarted: ReadonlySet<string>,
): HealthTimeoutError {
  const again = dead.filter((d) => restarted.has(d.name)).map((d) => d.name);
  const againNote =
    again.length > 0 ? ` This \`up\` restarted ${again.join(", ")}, and it died again.` : "";
  return new HealthTimeoutError(
    `service(s) not running: ${describeDeadServices(dead)}.${againNote} Read why with ` +
      `\`devtrees logs <service>\`. Re-running \`devtrees up\` restarts dead services; ` +
      `\`${remedy}\` restarts the whole stack. The worktree instance is still running.`,
    { dead_services: deadServicesDetails(dead), remedy },
  );
}
