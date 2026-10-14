/**
 * Restart one service in place (`devtrees restart`, ADR-0009, #222):
 * a bounded stop, then a start.
 *
 * process-compose v1.122.0's `process restart` cannot be trusted with a
 * running service: it starts the new run after at most
 * `shutdown.timeout_seconds` (about 1s without one) whether or not the old
 * run has exited. A dev server that drains for a few seconds on SIGTERM
 * still holds its port, so the new run fails to bind (or a port-hopping
 * server comes up on the wrong port); a `shutdown.command` that leaves the
 * process running, or a SIGTERM-ignoring child, outlives it for good.
 *
 * So a running service is restarted as **stop, wait for exit, start**:
 *
 *  1. `boundedStopServices` (src/bounded-stop.ts): the
 *     snapshot, `process stop`, the wait until process-compose no longer
 *     reads it active, `down`'s escalation and process-group sweep. What it
 *     had to signal is reported as `forceKilled`. A service still read
 *     active afterwards fails: starting it would start nothing (a start
 *     while it reads `Terminating` is refused as "already running").
 *  2. `process start`. A client timeout is not a refusal: the start counts
 *     when the service now reads active. An "already running" answer counts
 *     only when the run process-compose lists is a new one (its restart
 *     policy got there first), never the old run.
 *
 * The caller never hands this the instance's last running process:
 * process-compose exits once nothing runs, so its stop would end the
 * instance (`LAST_SERVICES_RUNNING`, ADR-0009).
 *
 * A service that is not running (stopped, crashed, a finished one-shot) has
 * no old run: it is simply started.
 */

import type { ForceKilled, ServiceProcess, StopSeams } from "./bounded-down.js";
import {
  boundedStopServices,
  StopRefusedError,
  type ServiceStopDriver,
  type ServiceStopTarget,
} from "./bounded-stop.js";
import type { ServiceStatus, StartResult } from "./driver.js";
import { classifyService } from "./service-state.js";

/** The slice of the driver `boundedRestart` uses. */
export interface RestartDriver extends ServiceStopDriver {
  startProcess(socketPath: string, service: string): Promise<StartResult>;
}

/** The service `boundedRestart` restarts, and how `boundedStopServices` stops it. */
export interface RestartTarget extends Pick<
  ServiceStopTarget,
  "socketPath" | "statuses" | "timeoutMs" | "unsignalled" | "instance" | "instanceGone"
> {
  readonly service: string;
}

/** What `boundedRestart` resolves with. */
export type RestartOutcome =
  | {
      readonly ok: true;
      /** Old-run processes devtrees signalled because they did not exit on their own. */
      readonly forceKilled: ReadonlyArray<ForceKilled>;
      /** Old-run processes still alive after SIGKILL. */
      readonly survivors: ReadonlyArray<ServiceProcess>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Restart one service of a running instance in place (#222); see the module
 * comment. Resolves `ok: false` when process-compose refuses the stop or the
 * start, or still lists the old run after the stop. Throws
 * `INSTANCE_NOT_FOUND` when process-compose exits during the stop.
 */
export async function boundedRestart(
  target: RestartTarget,
  driver: RestartDriver,
  seams: StopSeams = {},
): Promise<RestartOutcome> {
  const before = target.statuses.find((r) => r.name === target.service);
  if (before === undefined || classifyService(before) !== "active") {
    const started = await startChecked(target, driver);
    return started.ok ? { ok: true, forceKilled: [], survivors: [] } : started;
  }
  let stopped: Awaited<ReturnType<typeof boundedStopServices>>;
  try {
    stopped = await boundedStopServices({ ...target, services: [target.service] }, driver, seams);
  } catch (err) {
    if (err instanceof StopRefusedError) return { ok: false, message: err.reason };
    throw err;
  }
  if (stopped.unsettled.length > 0) {
    // Its restart policy may have brought a new run up already: that is the restart.
    const now = await listed(target, driver);
    const fresh = now !== undefined && now.pid !== before.pid && classifyService(now) === "active";
    if (!fresh) return { ok: false, message: oldRunListed(target.service, before, "still active") };
    return { ok: true, forceKilled: stopped.forceKilled, survivors: stopped.survivors };
  }
  const started = await startAfterStop(target, before, driver);
  if (!started.ok) return started;
  return { ok: true, forceKilled: stopped.forceKilled, survivors: stopped.survivors };
}

async function listed(
  target: RestartTarget,
  driver: RestartDriver,
): Promise<ServiceStatus | undefined> {
  const rows = await driver.getServiceStatuses(target.socketPath).catch(() => []);
  return rows.find((r) => r.name === target.service);
}

/**
 * `process start`, where a client timeout is not a refusal: the start may
 * have gone through, so it counts as one when the service now reads active.
 */
async function startChecked(target: RestartTarget, driver: RestartDriver): Promise<StartResult> {
  const started = await driver.startProcess(target.socketPath, target.service);
  if (started.ok || started.timedOut !== true) return started;
  const row = await listed(target, driver);
  return row !== undefined && classifyService(row) === "active"
    ? { ok: true, alreadyRunning: false }
    : started;
}

/**
 * The start after the stop. "Already running" is a success only when the run
 * process-compose lists is a new one: if it is still the old run, nothing was
 * started.
 */
async function startAfterStop(
  target: RestartTarget,
  before: ServiceStatus,
  driver: RestartDriver,
): Promise<StartResult> {
  const started = await startChecked(target, driver);
  if (!started.ok || !started.alreadyRunning) return started;
  const now = await listed(target, driver);
  if (now !== undefined && now.pid !== before.pid) return started;
  return { ok: false, message: oldRunListed(target.service, before, now?.status ?? "running") };
}

function oldRunListed(service: string, before: ServiceStatus, status: string): string {
  const pid = before.pid === undefined ? "" : ` (pid ${before.pid})`;
  return (
    `process-compose still lists the old run of '${service}'${pid} as ${status} after the ` +
    "stop, so nothing was started"
  );
}
