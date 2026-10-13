/**
 * Bounded per-service stop for `devtrees stop <service...>` (ADR-0009, #223).
 *
 * Reuses `down`'s machinery from src/bounded-down.ts (#190, #208, #219): the
 * pre-stop snapshot with start-time identity, the grace period, the
 * process-group SIGKILL of what is still the same process, and the
 * process-group sweep. Only the named services' processes are signalled.
 */

import {
  DOWN_GRACE_MS,
  killProcesses,
  pollUntilAsync,
  readSupervisedTable,
  serviceGroups,
  snapshotOf,
  stillRunning,
  sweepSeams,
  sweepServiceGroups,
  type ForceKilled,
  type ServiceProcess,
  type StopSeams,
} from "./bounded-down.js";
import type { ServiceStatus } from "./driver.js";
import { isRunning } from "./service-state.js";
import { instanceExitedError } from "./stop-services.js";

/** The slice of the driver `boundedStopServices` uses. */
export interface ServiceStopDriver {
  stopProcesses(
    socketPath: string,
    services: ReadonlyArray<string>,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  getServiceStatuses(socketPath: string): Promise<ServiceStatus[]>;
}

/** What `boundedStopServices` stops. */
export interface ServiceStopTarget {
  readonly socketPath: string;
  /** The services to stop: each one process-compose still reports active. */
  readonly services: ReadonlyArray<string>;
  /** The `process list` read the services were picked from. */
  readonly statuses: ReadonlyArray<ServiceStatus>;
  /** How long process-compose gets to stop them before the escalation. */
  readonly timeoutMs: number;
  /** As `StopTarget.unsignalled`: services whose group process-compose does not signal. */
  readonly unsignalled?: ReadonlySet<string>;
  /** The worktree id, for the error raised when process-compose exits. */
  readonly instance: string;
  /** The command stopping them, for its errors. Default `stop`; `restart` (#222). */
  readonly command?: "stop" | "restart";
  /**
   * Has process-compose exited (its control socket no longer answers)? Asked
   * whenever a `process list` read fails. Default: never.
   */
  readonly instanceGone?: () => Promise<boolean>;
}

/** What `boundedStopServices` resolves with. */
export interface ServiceStopResult {
  readonly forceKilled: ReadonlyArray<ForceKilled>;
  /** Group members still alive after the SIGKILL sweep. */
  readonly survivors: ReadonlyArray<ServiceProcess>;
  /**
   * Services process-compose still reports active (`Terminating`, say)
   * after the escalation: devtrees could not verify their process to kill it.
   */
  readonly unsettled: ReadonlyArray<{ readonly service: string; readonly pid: number | null }>;
}

/**
 * Raised when process-compose refused a `process stop` for a service it
 * still reports running. Nothing was escalated.
 */
export class StopRefusedError extends Error {
  constructor(
    services: ReadonlyArray<string>,
    /** process-compose's own complaint (`restart` reports it as is, #222). */
    readonly reason: string,
  ) {
    super(`devtrees stop: process-compose refused to stop ${services.join(", ")}: ${reason}`);
    this.name = "StopRefusedError";
  }
}

/**
 * Stop some services of a running instance and wait until they have exited,
 * bounded, with `down`'s escalation (ADR-0009, #223):
 *
 *  1. Snapshot the services' processes and their process groups, as
 *     `boundedDown` does before its stop.
 *  2. `process stop` them. It returns at once; devtrees then polls
 *     `process list` until none of them is active, for `timeoutMs`.
 *  3. On expiry (a `shutdown.command` that exits without stopping its
 *     process leaves it `Terminating` forever, and a SIGTERM-ignoring one
 *     with no `shutdown.timeout_seconds` is never escalated), SIGKILL the
 *     snapshot processes still alive and still the same process, with their
 *     groups, then give process-compose the grace period to see them exit.
 *  4. Sweep the services' process groups (#155), as `down` does.
 *
 * Only these services' processes are ever signalled. A process that left
 * its group (`setsid`) is never signalled: the caller's port check reports
 * it. Throws `StopRefusedError` when process-compose refused the request
 * for a service it still runs, and `INSTANCE_NOT_FOUND` (`instanceExitedError`) as soon as a failed
 * `process list` read turns out to be process-compose gone. A service whose
 * state could not be read at the end is reported `unsettled`, never as
 * stopped.
 */
export async function boundedStopServices(
  target: ServiceStopTarget,
  driver: ServiceStopDriver,
  seams: StopSeams = {},
): Promise<ServiceStopResult> {
  const { readTable, kill, pollMs } = sweepSeams(seams);
  const names = new Set(target.services);
  const picked = target.statuses.filter((s) => names.has(s.name));
  const { table, supervisorPid } = await readSupervisedTable(readTable, target.socketPath, {
    delayMs: pollMs,
  });
  const { snapshot, tree } = snapshotOf(picked, table, supervisorPid);

  let rows: ReadonlyArray<ServiceStatus> | undefined;
  const settled = async (): Promise<boolean> => {
    rows = await driver.getServiceStatuses(target.socketPath).catch(() => undefined);
    if (rows === undefined && (await target.instanceGone?.())) {
      throw instanceExitedError(target.instance, target.services, target.command);
    }
    return rows !== undefined && activeAmong(rows, target.services).length === 0;
  };
  const request = await driver.stopProcesses(target.socketPath, target.services);
  if (!request.ok && !(await settled())) {
    const running = (rows ?? []).filter((r) => names.has(r.name) && r.status === "Running");
    if (running.length > 0) throw new StopRefusedError(target.services, request.message);
  }

  let killed: ForceKilled[] = [];
  if (!(await pollUntilAsync(settled, target.timeoutMs, pollMs))) {
    killed = killProcesses(stillRunning(snapshot, await readTable()), kill);
    await pollUntilAsync(settled, seams.graceMs ?? DOWN_GRACE_MS, pollMs);
  }
  const already = new Set(killed.map((k) => k.pid));
  const groups = { led: serviceGroups(snapshot), unsignalled: target.unsignalled ?? new Set() };
  const swept = await sweepServiceGroups(
    tree.filter((p) => !already.has(p.pid)),
    groups,
    seams,
  );
  // An unreadable final state is not a clean stop: report every target.
  const unsettled = rows === undefined ? picked : activeAmong(rows, target.services);
  return {
    forceKilled: [...killed, ...swept.killed.filter((k) => !already.has(k.pid))],
    survivors: swept.survivors,
    unsettled: unsettled.map((r) => ({ service: r.name, pid: r.pid ?? null })),
  };
}

/** The rows of `names` process-compose still reports active (running or stopping). */
function activeAmong(
  rows: ReadonlyArray<ServiceStatus>,
  names: ReadonlyArray<string>,
): ServiceStatus[] {
  const wanted = new Set(names);
  return rows.filter((r) => wanted.has(r.name) && isRunning(r));
}
