/**
 * Dead versus done (ADR-0008).
 *
 * One classification of a service's runtime row, shared by every caller that
 * has to tell a crashed process from a finished one-shot: the health wait's
 * fail-fast, the dead-shared-service check on a running instance, and the
 * restart of dead isolated services (#178).
 *
 *   - `Completed` with exit code 0 is a legitimately finished one-shot (a
 *     migration, a seed step): **done**, which counts as healthy.
 *   - `Completed` with a non-zero or signal exit — a killed process reports
 *     `-1` — is **dead**, as are `Failed` and `Error`. Health is no help here:
 *     a killed *unprobed* service reports health `unknown`, so only the exit
 *     code tells it apart from a finished one-shot.
 *   - Anything else (`Running`, `Pending`, `Restarting`, …) is **active**:
 *     still running or still on its way, so a wait keeps polling.
 *
 * Every other module asks this one for a verdict on a status row instead of
 * reading the status string itself (#251). Where a caller's rule differs
 * from the shared one, it has its own verdict here, named for what it means,
 * so each difference is visible in one place rather than buried in a caller.
 *
 * Pure: no I/O.
 */

import type { ServiceStatus } from "./driver.js";

export type ServiceVerdict = "dead" | "done" | "active";

/** A dead service, as reported in error messages and `details`. */
export interface DeadService {
  readonly name: string;
  readonly status: string;
  /** process-compose's `exit_code`, when it reported one. */
  readonly exitCode?: number;
}

const DEAD_STATES = new Set(["failed", "error"]);

/**
 * Classify one runtime row. A `Completed` row without an exit code (an older
 * process-compose shape) is taken as done — there is no evidence it crashed,
 * and treating it as dead would fail every finished one-shot on those builds.
 */
export function classifyService(row: Pick<ServiceStatus, "status" | "exitCode">): ServiceVerdict {
  const status = row.status.toLowerCase();
  if (DEAD_STATES.has(status)) return "dead";
  if (status === "completed") {
    return row.exitCode === undefined || row.exitCode === 0 ? "done" : "dead";
  }
  return "active";
}

/** Is the row dead (ADR-0008)? */
export function isDead(row: Pick<ServiceStatus, "status" | "exitCode">): boolean {
  return classifyService(row) === "dead";
}

/**
 * Is the row neither dead nor done? Unlike `isRunning`, this also counts an
 * idle service (`Disabled`, `Skipped`), which holds no process. It is the
 * rule `restart` reads a service's state by today, so restarting an idle
 * service takes the stop-then-start path (a known bug, #263).
 */
export function isActiveOrIdle(row: Pick<ServiceStatus, "status" | "exitCode">): boolean {
  return classifyService(row) === "active";
}

/**
 * Statuses that are neither dead nor done, yet hold no process: a disabled
 * process, and one skipped because a dependency failed.
 */
const IDLE_STATES = new Set(["disabled", "skipped"]);

/**
 * Is the service running, or on its way up or down (`Running`, `Pending`,
 * `Restarting`, `Terminating`, …)? This is what keeps process-compose from
 * exiting ("Project completed"), and what `restart`'s stop waits out (#223).
 * A stopped service (`Completed`, exit -1), a done one-shot, a dead service
 * and an idle one (`Disabled`, `Skipped`) are not running.
 */
export function isRunning(row: Pick<ServiceStatus, "status" | "exitCode">): boolean {
  return classifyService(row) === "active" && !IDLE_STATES.has(row.status.toLowerCase());
}

/** Is the service `Pending`: waiting on its dependencies, never started? */
export function isPending(row: Pick<ServiceStatus, "status">): boolean {
  return row.status.toLowerCase() === "pending";
}

/**
 * Does process-compose report the service exactly `Running`? Case-sensitive,
 * and narrower than `isRunning`: a service starting, restarting or stopping
 * is not `Running`. A bounded stop whose request process-compose refused
 * treats the refusal as real only for such a service.
 */
export function reportsRunning(row: Pick<ServiceStatus, "status">): boolean {
  return row.status === "Running";
}

/**
 * Did this daemon's launch fail, as a `process list` read before a stop
 * shows it (#155)? `Error` (it could not start), or `Completed` with a
 * non-zero exit code. An unknown exit code is not a failure: running a
 * `shutdown.command` twice is the worse mistake. Case-sensitive, and
 * narrower than `isDead`: `Failed` does not count.
 */
export function launchFailed(row: Pick<ServiceStatus, "status" | "exitCode">): boolean {
  if (row.status === "Error") return true;
  return row.status === "Completed" && row.exitCode !== undefined && row.exitCode !== 0;
}

/**
 * "Healthy enough" for a service WITHOUT a readiness probe = the process is
 * up: `Running`, `Launched` for an `is_daemon` service whose launch command
 * returned (#262: the wait after a lazy start reads it), or `Completed` for
 * one-shot jobs (`Ready` is kept for forward-compatibility with status
 * vocabularies that fold readiness into the status string). Anything else
 * (`Pending`, `Restarting`, `Failed`) means the wait keeps polling.
 */
const HEALTHY_STATES = new Set(["running", "launched", "ready", "completed"]);

/**
 * Does the health wait count this row as healthy? A probed service (one with
 * a readiness probe) only when `health` is `ready`: process-compose keeps its
 * status at `Running` while the probe verdict arrives in the separate
 * `is_ready` field, so a status-only gate would pass the instant the process
 * spawns, before the first probe can fire (#108). Any other service on its
 * process state (`HEALTHY_STATES`). This alone never rules out a dead row (a
 * crashed `Completed` passes it): the wait checks `isDead` first (ADR-0008).
 */
export function isHealthyForWait(
  row: Pick<ServiceStatus, "status" | "health">,
  probed: boolean,
): boolean {
  if (probed) return row.health === "ready";
  return HEALTHY_STATES.has(row.status.toLowerCase());
}

/**
 * Will this service keep process-compose from exiting once others stop
 * (#223)? Conservative: only a process that is running now counts. Whenever
 * process-compose reports `is_running` it decides, so a `Pending` service
 * (its dependency may be the one being stopped, and then it never starts), a
 * `Restarting` one in its backoff and a `Terminating` one do not count.
 * Without `is_running`, the status decides, with `Pending` and
 * `Terminating` excluded for the same reasons.
 */
export function keepsInstanceAlive(
  row: Pick<ServiceStatus, "status" | "exitCode" | "running">,
): boolean {
  if (row.running !== undefined) return row.running;
  const status = row.status.toLowerCase();
  return isRunning(row) && status !== "pending" && status !== "terminating";
}

/**
 * The rows among `names` that are dead, in `names` order. A name with no row
 * is not dead — absence is a selection question (`NAMESPACE_NOT_RUNNING`) or
 * a still-starting instance, never a crash.
 */
export function findDeadServices(
  rows: ReadonlyArray<ServiceStatus>,
  names: ReadonlyArray<string>,
): DeadService[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const dead: DeadService[] = [];
  for (const name of names) {
    const row = byName.get(name);
    if (row === undefined || classifyService(row) !== "dead") continue;
    dead.push(
      row.exitCode === undefined
        ? { name, status: row.status }
        : { name, status: row.status, exitCode: row.exitCode },
    );
  }
  return dead;
}

/** `toy (Completed, exit -1), api (Error)` — the human list of dead services. */
export function describeDeadServices(dead: ReadonlyArray<DeadService>): string {
  return dead
    .map((d) =>
      d.exitCode === undefined
        ? `${d.name} (${d.status})`
        : `${d.name} (${d.status}, exit ${d.exitCode})`,
    )
    .join(", ");
}

/** The `details` shape for dead services in an error envelope. */
export function deadServicesDetails(
  dead: ReadonlyArray<DeadService>,
): Array<{ name: string; status: string; exit_code?: number }> {
  return dead.map((d) =>
    d.exitCode === undefined
      ? { name: d.name, status: d.status }
      : { name: d.name, status: d.status, exit_code: d.exitCode },
  );
}

/**
 * `names` reordered so each service comes after the services among `names`
 * it `depends_on` (issue #178): `process-compose process start` ignores
 * `depends_on`, so `up` starts dead services in dependency order itself.
 * Dependencies outside `names` are ignored (they are not being started), and
 * otherwise the order of `names` is kept. A cycle cannot be ordered; its
 * members keep their relative order.
 */
export function dependencyOrder(
  services: ReadonlyArray<{
    readonly name: string;
    readonly dependsOn: ReadonlyArray<{ readonly name: string }>;
  }>,
  names: ReadonlyArray<string>,
): string[] {
  const wanted = new Set(names);
  const deps = new Map(services.map((s) => [s.name, s.dependsOn.map((d) => d.name)]));
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (ordered.includes(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) if (wanted.has(dep)) visit(dep);
    visiting.delete(name);
    ordered.push(name);
  };
  for (const name of names) visit(name);
  return ordered;
}
