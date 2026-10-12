/**
 * Bounded `process-compose down` with surgical escalation (issue #190).
 *
 * process-compose v1.122.0 never escalates to SIGKILL when a
 * `shutdown.command` exits 0 without stopping its process, or when a process
 * ignores SIGTERM and declares no `shutdown.timeout_seconds`. Its `down` then
 * waits forever, and so did `devtrees down` and prune's orphan stop.
 *
 * `boundedDown` stops an instance in three steps:
 *  1. Snapshot each service's pid (`process list`) and its process-table row
 *     (`ps`) before asking process-compose to stop.
 *  2. Run `process-compose down` within a budget (`downTimeoutMs`).
 *  3. On expiry, SIGKILL only the snapshot processes that are still alive
 *     and still the same process (same parent, process group and command
 *     line, so a reused pid is never hit). process-compose then sees them
 *     exit and finishes its own shutdown. If it still has not exited after a
 *     short grace period, fail with `DOWN_TIMEOUT`.
 *
 * devtrees never kills the process-compose supervisor itself, nor a
 * `shutdown.command` it is running: killing the supervisor would skip the
 * remaining shutdown hooks (container cleanup and the like). `DOWN_TIMEOUT`
 * leaves the socket and derived config in place and tells the operator how
 * to finish by hand.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { DownOutcome, InstanceRef, ServiceStatus } from "./driver.js";

/** One row of the process table, as `ps -o pid=,ppid=,pgid=,command=` prints it. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

/** A service process recorded before the stop, with the identity checked before a kill. */
export interface ServiceProcess extends ProcessRow {
  readonly service: string;
}

/** A service process devtrees had to SIGKILL. */
export interface ForceKilled {
  readonly service: string;
  readonly pid: number;
}

/** Parse `ps -A -ww -o pid=,ppid=,pgid=,command=` output. Malformed lines are skipped. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      command: (m[4] ?? "").trimEnd(),
    });
  }
  return rows;
}

/** Cap on one `ps` read. A failed or slow read yields an empty table, never a throw. */
const PS_TIMEOUT_MS = 5_000;

/** Read the whole process table. Best-effort: any failure is an empty table. */
function readProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err === null ? parseProcessTable(stdout) : []),
    );
  });
}

/**
 * The pid of the process-compose server bound to `socketPath`: the process
 * whose argv is an `up` with `-u <socketPath>` (how devtrees starts every
 * instance). `undefined` when none, or more than one, matches.
 *
 * The socket path is matched against the raw command line, not a
 * whitespace split, because a path may contain spaces (the legacy
 * `<anchor>/devtrees/run` dir, a `DEVTREES_RUNTIME_DIR` override).
 */
export function findSupervisorPid(
  table: ReadonlyArray<ProcessRow>,
  socketPath: string,
): number | undefined {
  const matches = table.filter(
    (row) => row.command.split(/\s+/).includes("up") && namesSocket(row.command, socketPath),
  );
  return matches.length === 1 ? matches[0]?.pid : undefined;
}

/** Does `command` pass `socketPath` as its `-u`/`--unix-socket` value? */
function namesSocket(command: string, socketPath: string): boolean {
  for (const flag of [" -u ", " --unix-socket "]) {
    const needle = `${flag}${socketPath}`;
    let at = command.indexOf(needle);
    while (at !== -1) {
      const after = command[at + needle.length];
      if (after === undefined || after === " ") return true;
      at = command.indexOf(needle, at + 1);
    }
  }
  return false;
}

/**
 * Pair each service's pid with its process-table row. Only direct children
 * of the supervisor are kept: process-compose spawns every service itself,
 * so a pid with another parent is a dead row's stale pid that something else
 * has since reused.
 */
export function snapshotServiceProcesses(
  statuses: ReadonlyArray<ServiceStatus>,
  table: ReadonlyArray<ProcessRow>,
  supervisorPid: number | undefined,
): ServiceProcess[] {
  if (supervisorPid === undefined) return [];
  const byPid = new Map(table.map((row) => [row.pid, row]));
  return statuses.flatMap((status) => {
    const row = status.pid === undefined ? undefined : byPid.get(status.pid);
    if (row === undefined || row.ppid !== supervisorPid) return [];
    return [{ service: status.name, ...row }];
  });
}

/**
 * The snapshot processes that are still alive AND still the same process:
 * same pid, parent, process group and command line. A pid reused since the
 * snapshot fails at least one of these, so it is never killed.
 */
export function stillRunning(
  snapshot: ReadonlyArray<ServiceProcess>,
  table: ReadonlyArray<ProcessRow>,
): ServiceProcess[] {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  return snapshot.filter((proc) => {
    const now = byPid.get(proc.pid);
    return (
      now !== undefined &&
      now.ppid === proc.ppid &&
      now.pgid === proc.pgid &&
      now.command === proc.command
    );
  });
}

/** True when `pid` names a live process (EPERM counts: it exists). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Raised when `process-compose down` did not finish within its budget and
 * the process-compose server was still running after devtrees force-killed
 * the stuck service processes (issue #190). Nothing on disk is removed, so
 * the instance stays visible to `ls` and a retried `down` can finish.
 */
export class DownTimeoutError extends Error {
  readonly code = "DOWN_TIMEOUT" as const;
  constructor(
    command: string,
    readonly details: {
      readonly instance: string;
      readonly socket_path: string;
      readonly timeout_ms: number;
      readonly process_compose_pid: number | null;
      readonly stuck_services: ReadonlyArray<ForceKilled>;
      readonly force_killed: ReadonlyArray<ForceKilled>;
      readonly remedy: string;
    },
  ) {
    const who = details.instance === "shared" ? "the shared" : `the '${details.instance}'`;
    const pc =
      details.process_compose_pid === null
        ? "its process-compose"
        : `its process-compose (pid ${details.process_compose_pid})`;
    const stuck =
      details.stuck_services.length === 0
        ? "No service process devtrees recorded was still running: process-compose may be waiting on a shutdown.command, or on a process it no longer lists (such as a service's old process after a CONFIG_DRIFT timeout)."
        : `Stuck: ${describeProcesses(details.stuck_services)}.`;
    const killed =
      details.force_killed.length === 0
        ? ""
        : ` devtrees force-killed ${describeProcesses(details.force_killed)}.`;
    super(
      `devtrees ${command}: ${who} instance did not stop within ` +
        `${Math.round(details.timeout_ms / 1000)}s and ${pc} has not exited. ${stuck}${killed} ` +
        `The socket and derived config were kept. ${details.remedy}`,
    );
    this.name = "DownTimeoutError";
  }
}

/** `web (pid 123), worker (pid 456)`. */
function describeProcesses(procs: ReadonlyArray<ForceKilled>): string {
  return procs.map((p) => `${p.service} (pid ${p.pid})`).join(", ");
}

/** The slice of the driver `boundedDown` uses. */
export interface StopDriver {
  down(inst: InstanceRef, opts: { readonly timeoutMs?: number }): Promise<DownOutcome>;
  getServiceStatuses(socketPath: string): Promise<ServiceStatus[]>;
}

/**
 * Seams for `boundedDown`, all optional. Production uses the real `ps`,
 * `process.kill` and the default budgets; tests inject them.
 */
export interface StopSeams {
  /** Read the process table. Default: `readProcessTable` (`ps`). */
  readonly readProcessTable?: () => Promise<ProcessRow[]>;
  /** Send a signal. Default: `process.kill`. A negative target is a process group. */
  readonly kill?: (target: number, signal: NodeJS.Signals) => void;
  /** Is a pid alive? Default: `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean;
  /** Does a path exist? Default: `existsSync`. */
  readonly exists?: (path: string) => boolean;
  /** Base of the `down` budget, before `shutdown.timeout_seconds` are added. Default: 30s. */
  readonly baseTimeoutMs?: number;
  /** How long to wait for process-compose to exit after the escalation. Default: 10s. */
  readonly graceMs?: number;
  /** Poll interval while waiting for process-compose to exit. Default: 100ms. */
  readonly pollMs?: number;
}

/** Default grace for process-compose to exit once its stuck services are killed. */
const DOWN_GRACE_MS = 10_000;
const DOWN_POLL_MS = 100;

/** What `boundedDown` is stopping and how to describe it in a `DOWN_TIMEOUT`. */
export interface StopTarget {
  readonly inst: InstanceRef;
  /** Worktree id, or `shared`. */
  readonly instance: string;
  /** The command name for messages (`down`, `prune`). */
  readonly command: string;
  /** The full `down` budget, from `downTimeoutMs`. */
  readonly timeoutMs: number;
  /** The `details.remedy` a `DOWN_TIMEOUT` carries, given the supervisor pid if known. */
  readonly remedy: (processComposePid: number | undefined) => string;
}

/**
 * Stop an instance within its budget, force-killing only the service
 * processes that kept it from stopping. Resolves with what was force-killed
 * (empty on a clean stop). Throws `DownTimeoutError` when process-compose is
 * still running after the escalation; rejects as `driver.down` does when
 * `process-compose down` itself fails.
 */
export async function boundedDown(
  target: StopTarget,
  driver: StopDriver,
  seams: StopSeams = {},
): Promise<{ readonly forceKilled: ReadonlyArray<ForceKilled> }> {
  const readTable = seams.readProcessTable ?? readProcessTable;
  const { snapshot, supervisorPid } = await snapshotInstance(
    target.inst.socketPath,
    driver,
    readTable,
  );

  const outcome = await driver.down(target.inst, { timeoutMs: target.timeoutMs });
  if (outcome.stopped) return { forceKilled: [] };

  const table = await readTable();
  const pcPid = supervisorPid ?? findSupervisorPid(table, target.inst.socketPath);
  const stuck = stillRunning(snapshot, table);
  const forceKilled = killProcesses(stuck, seams.kill ?? process.kill.bind(process));
  const exited = await waitForExit(target.inst.socketPath, pcPid, seams);
  if (exited) return { forceKilled };
  throw new DownTimeoutError(target.command, {
    instance: target.instance,
    socket_path: target.inst.socketPath,
    timeout_ms: target.timeoutMs,
    process_compose_pid: pcPid ?? null,
    stuck_services: stuck.map(({ service, pid }) => ({ service, pid })),
    force_killed: forceKilled,
    remedy: target.remedy(pcPid),
  });
}

/**
 * Record each service's process before the stop. Best-effort: a wedged
 * instance whose `process list` fails, or a host without `ps`, yields an
 * empty snapshot, and the stop then simply has nothing to escalate on.
 */
async function snapshotInstance(
  socketPath: string,
  driver: StopDriver,
  readTable: () => Promise<ProcessRow[]>,
): Promise<{ snapshot: ServiceProcess[]; supervisorPid: number | undefined }> {
  let statuses: ServiceStatus[];
  try {
    statuses = await driver.getServiceStatuses(socketPath);
  } catch {
    return { snapshot: [], supervisorPid: undefined };
  }
  // No pid to protect: skip the process-table read on the common path.
  if (!statuses.some((s) => s.pid !== undefined)) {
    return { snapshot: [], supervisorPid: undefined };
  }
  const table = await readTable();
  const supervisorPid = findSupervisorPid(table, socketPath);
  return { snapshot: snapshotServiceProcesses(statuses, table, supervisorPid), supervisorPid };
}

/**
 * SIGKILL each process. A process that leads its own group (process-compose
 * starts every service in a new one) is killed with its group, so the
 * service's children go with it instead of being reparented to PID 1. A
 * process that is already gone is left out of the result.
 */
function killProcesses(
  procs: ReadonlyArray<ServiceProcess>,
  kill: (target: number, signal: NodeJS.Signals) => void,
): ForceKilled[] {
  const killed: ForceKilled[] = [];
  for (const proc of procs) {
    try {
      kill(proc.pgid === proc.pid ? -proc.pid : proc.pid, "SIGKILL");
      killed.push({ service: proc.service, pid: proc.pid });
    } catch {
      // Exited on its own between the read and the kill.
    }
  }
  return killed;
}

/**
 * Wait up to the grace period for process-compose to exit: its pid is gone
 * when known, else its control socket is gone.
 */
async function waitForExit(
  socketPath: string,
  supervisorPid: number | undefined,
  seams: StopSeams,
): Promise<boolean> {
  const isAlive = seams.isAlive ?? isPidAlive;
  const exists = seams.exists ?? existsSync;
  const gone = (): boolean =>
    supervisorPid === undefined ? !exists(socketPath) : !isAlive(supervisorPid);
  const deadline = Date.now() + (seams.graceMs ?? DOWN_GRACE_MS);
  const poll = seams.pollMs ?? DOWN_POLL_MS;
  while (!gone()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, poll));
  }
  return true;
}
