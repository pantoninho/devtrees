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

/**
 * Statuses that are neither dead nor done, yet hold no process: a disabled
 * process, and one skipped because a dependency failed.
 */
const IDLE_STATES = new Set(["disabled", "skipped"]);

/**
 * Is the service running, or on its way up or down (`Running`, `Pending`,
 * `Restarting`, `Terminating`, …)? This is what keeps process-compose from
 * exiting ("Project completed"), and what `devtrees stop` waits out (#223).
 * A stopped service (`Completed`, exit -1), a done one-shot, a dead service
 * and an idle one (`Disabled`, `Skipped`) are not running.
 */
export function isRunning(row: Pick<ServiceStatus, "status" | "exitCode">): boolean {
  return classifyService(row) === "active" && !IDLE_STATES.has(row.status.toLowerCase());
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
