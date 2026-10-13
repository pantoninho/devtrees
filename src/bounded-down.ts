/**
 * Bounded `process-compose down` with surgical escalation (issue #190).
 *
 * process-compose v1.122.0 never escalates to SIGKILL when a
 * `shutdown.command` exits 0 without stopping its process, or when a process
 * ignores SIGTERM and declares no `shutdown.timeout_seconds`. Its `down` then
 * waits forever, and so did `devtrees down` and prune's orphan stop.
 *
 * `boundedDown` stops an instance in four steps:
 *  0. If a hot-reload is still pending (#206), let it finish first
 *     (`finishPendingReload`). SIGKILL the stuck old runs it is waiting on:
 *     process-compose no longer lists them, so only the pending-reload
 *     marker knows them, and they are held to the same identity checks as
 *     step 3 (see `pendingRunsToKill`). Old runs it still lists are queued
 *     updates and are left to process-compose. Then wait until the update
 *     has started every new copy. If it does not finish in time, fail with
 *     `DOWN_TIMEOUT` before stopping anything: a new copy started after
 *     `process-compose down` fixed its shutdown order would outlive it as an
 *     orphan. For the same reason no pending old run is killed once the stop
 *     has begun.
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
import { stuckFromMarker, type OldRun, type PendingReload } from "./reload-pending.js";

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
export function readProcessTable(): Promise<ProcessRow[]> {
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

/**
 * The old runs of a pending hot-reload (#206) that are stuck: process-compose
 * dropped them from `process list` and is waiting for them to exit. Runs it
 * still lists (`listed`, a `process list` read) are not stuck, only queued:
 * process-compose stops them itself, `shutdown.command` included, when it
 * reaches their update. A run qualifies only when it is alive in `table` as
 * a direct child of this instance's process-compose (`supervisorPid`) and
 * its recorded identity (parent, process group and command line) still
 * matches, as `stillRunning` requires of the snapshot. A run without an
 * identity (`identity: null`, or a hand-edited or older marker) is never
 * killed: on the pid alone it could be anything, including a running
 * `shutdown.command`.
 */
export function pendingRunsToKill(
  runs: ReadonlyArray<OldRun>,
  listed: ReadonlyArray<{ readonly pid?: number }>,
  table: ReadonlyArray<ProcessRow>,
  supervisorPid: number | undefined,
): ServiceProcess[] {
  if (supervisorPid === undefined) return [];
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const listedPids = new Set(listed.map((row) => row.pid));
  const picked = new Set<number>();
  return runs.flatMap((run) => {
    const now = byPid.get(run.pid);
    if (now === undefined || now.ppid !== supervisorPid) return [];
    if (listedPids.has(run.pid) || picked.has(run.pid)) return [];
    if (!sameIdentity(run, now)) return [];
    picked.add(run.pid);
    return [{ service: run.name, ...now }];
  });
}

/**
 * Does `now` still pass for `run`'s recorded identity? The marker is read
 * unvalidated, so anything but a well-formed identity that matches field
 * for field (none, `null`, a hand-edited value) fails safe: no kill.
 */
function sameIdentity(run: OldRun, now: ProcessRow): boolean {
  const id = run.identity;
  if (id === null || id === undefined || typeof id !== "object") return false;
  return id.ppid === now.ppid && id.pgid === now.pgid && id.command === now.command;
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

/** The `details` a `DOWN_TIMEOUT` carries. */
export interface DownTimeoutDetails {
  readonly instance: string;
  readonly socket_path: string;
  readonly timeout_ms: number;
  readonly process_compose_pid: number | null;
  readonly stuck_services: ReadonlyArray<ForceKilled>;
  readonly force_killed: ReadonlyArray<ForceKilled>;
  /**
   * Set when a timed-out hot-reload was still applying these services, so
   * the stop was never begun (#206). `stuck_services` then lists the old
   * runs it is still waiting on.
   */
  readonly pending_reload?: ReadonlyArray<string>;
  readonly remedy: string;
}

/**
 * Raised when `process-compose down` did not finish within its budget and
 * the process-compose server was still running after devtrees force-killed
 * the stuck service processes (issue #190), or when a pending hot-reload did
 * not finish in time and the stop was never begun (#206). Nothing on disk is
 * removed, so the instance stays visible to `ls` and a retried `down` can
 * finish.
 */
export class DownTimeoutError extends Error {
  readonly code = "DOWN_TIMEOUT" as const;
  constructor(
    command: string,
    readonly details: DownTimeoutDetails,
  ) {
    super(downTimeoutMessage(command, details));
    this.name = "DownTimeoutError";
  }
}

function downTimeoutMessage(command: string, details: DownTimeoutDetails): string {
  const who = details.instance === "shared" ? "the shared" : `the '${details.instance}'`;
  const secs = `${Math.round(details.timeout_ms / 1000)}s`;
  const killed =
    details.force_killed.length === 0
      ? ""
      : ` devtrees force-killed ${describeProcesses(details.force_killed)}.`;
  if (details.pending_reload !== undefined) {
    const waiting =
      details.stuck_services.length === 0
        ? ""
        : ` It is still waiting on ${describeProcesses(details.stuck_services)}.`;
    return (
      `devtrees ${command}: a timed-out hot-reload of ${who} instance was still applying ` +
      `${details.pending_reload.join(", ")} after ${secs}, so devtrees did not stop it: ` +
      "process-compose would start the new copy after its shutdown began, and that copy " +
      `would outlive it.${waiting}${killed} The instance is still running. ${details.remedy}`
    );
  }
  const pc =
    details.process_compose_pid === null
      ? "its process-compose"
      : `its process-compose (pid ${details.process_compose_pid})`;
  const stuck =
    details.stuck_services.length === 0
      ? "No service process devtrees recorded was still running: process-compose may be waiting on a shutdown.command that does not exit, or on a process it no longer lists."
      : `Stuck: ${describeProcesses(details.stuck_services)}.`;
  return (
    `devtrees ${command}: ${who} instance did not stop within ${secs} and ${pc} has not ` +
    `exited. ${stuck}${killed} The socket and derived config were kept. ${details.remedy}`
  );
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
  /**
   * How long to wait for a pending reload to finish before the stop (#206).
   * When it runs out, the stop is not started. Default: the `down` budget,
   * and at least 5s.
   */
  readonly settleMs?: number;
}

/** Default grace for process-compose to exit once its stuck services are killed. */
const DOWN_GRACE_MS = 10_000;
const DOWN_POLL_MS = 100;
/** Floor of the wait for a pending reload to finish before the stop. */
const PENDING_SETTLE_MS = 5_000;

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
  /**
   * The instance's pending-reload marker (#206): the old runs a timed-out
   * hot-reload is still waiting on, and the services it brings back.
   * Default: none.
   */
  readonly pendingReload?: PendingReload;
}

/**
 * Stop an instance within its budget, force-killing only the service
 * processes that kept it from stopping. A pending reload's stuck old runs
 * (`target.pendingReload`) are killed before the stop, never during it.
 * Resolves with what was force-killed (empty on a clean stop with nothing
 * pending). Throws `DownTimeoutError` when process-compose is still running
 * after the escalation, or when the pending reload never finished so the
 * stop was not started; rejects as `driver.down` does when
 * `process-compose down` itself fails.
 */
export async function boundedDown(
  target: StopTarget,
  driver: StopDriver,
  seams: StopSeams = {},
): Promise<{ readonly forceKilled: ReadonlyArray<ForceKilled> }> {
  const readTable = seams.readProcessTable ?? readProcessTable;
  const kill = seams.kill ?? process.kill.bind(process);
  const pending = await finishPendingReload(target, driver, seams);
  const { snapshot, supervisorPid } = await snapshotInstance(
    target.inst.socketPath,
    driver,
    readTable,
    pending.view,
  );

  const outcome = await driver.down(target.inst, { timeoutMs: target.timeoutMs });
  if (outcome.stopped) return { forceKilled: pending.killed };

  const table = await readTable();
  const pcPid = supervisorPid ?? findSupervisorPid(table, target.inst.socketPath);
  // Only the snapshot: a pending reload's old run is never killed once the
  // stop has begun (see `finishPendingReload`).
  const stuck = stillRunning(snapshot, table);
  const forceKilled = [...pending.killed, ...killProcesses(stuck, kill)];
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

/** What a `process list` read and a `ps` read showed together. */
interface InstanceView {
  readonly statuses: ReadonlyArray<ServiceStatus>;
  readonly table: ReadonlyArray<ProcessRow>;
  readonly supervisorPid: number | undefined;
}

/** How many times a `ps` read is tried before devtrees gives up on it. */
const PS_ATTEMPTS = 3;

/**
 * Read the process table and find this instance's process-compose in it,
 * retrying (up to `attempts` reads, `delayMs` apart) while the read comes
 * back empty or without the supervisor: a `ps` that failed or hit its cap
 * under load. The last read is returned either way.
 */
export async function readSupervisedTable(
  readTable: () => Promise<ProcessRow[]>,
  socketPath: string,
  opts: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<{ table: ProcessRow[]; supervisorPid: number | undefined }> {
  const attempts = opts.attempts ?? PS_ATTEMPTS;
  for (let i = 1; ; i++) {
    const table = await readTable();
    const supervisorPid = findSupervisorPid(table, socketPath);
    if (supervisorPid !== undefined || i >= attempts) return { table, supervisorPid };
    await new Promise((r) => setTimeout(r, opts.delayMs ?? DOWN_POLL_MS));
  }
}

/**
 * Step 0 (#206): let a pending hot-reload finish before the stop begins.
 *
 * process-compose applies a reload's updates one service at a time. Each
 * update stops the old run, waits for it to exit, then starts the new copy,
 * without checking whether a shutdown has begun meanwhile. So a new copy
 * that starts after `process-compose down` fixed its shutdown order is never
 * stopped and outlives process-compose as a PPID-1 orphan. devtrees
 * therefore never kills a pending old run once the stop has begun, and never
 * begins the stop while an update is still in flight:
 *
 *  - Kill only the stuck old runs: those process-compose no longer lists
 *    (it is waiting on them) and whose identity still matches. A changed
 *    service whose update is still queued keeps its old run listed; that run
 *    is left alone, so process-compose stops it with its `shutdown.command`
 *    when it gets to it.
 *  - Wait until the update has finished (`stuckFromMarker`): each old run
 *    has exited or been replaced, and each service the update brings back is
 *    listed again.
 *  - If that does not happen within `settleMs` (an old run devtrees could not
 *    verify, an unreadable `process list`, a slow update), throw
 *    `DOWN_TIMEOUT` without starting the stop, naming what is still pending.
 *
 * The `ps` read is retried while it comes back empty or without the
 * supervisor, so one failed read does not leave a stuck run unkilled. When
 * nothing had to be killed or waited on, the reads are handed back for the
 * snapshot to reuse.
 */
async function finishPendingReload(
  target: StopTarget,
  driver: StopDriver,
  seams: StopSeams,
): Promise<{ killed: ForceKilled[]; view?: InstanceView }> {
  const pending = target.pendingReload;
  if (!hasPendingWork(pending)) return { killed: [] };
  const isAlive = seams.isAlive ?? isPidAlive;
  const readStatuses = (): Promise<ServiceStatus[] | undefined> =>
    driver.getServiceStatuses(target.inst.socketPath).catch(() => undefined);
  const statuses = await readStatuses();
  const { table, supervisorPid } = await readSupervisedTable(
    seams.readProcessTable ?? readProcessTable,
    target.inst.socketPath,
    { delayMs: seams.pollMs },
  );
  const killed = killProcesses(
    stuckRuns(pending, statuses, table, supervisorPid),
    seams.kill ?? process.kill.bind(process),
  );
  const done = (rows: ServiceStatus[] | undefined): rows is ServiceStatus[] =>
    rows !== undefined && stuckFromMarker(pending, rows, isAlive) === undefined;
  if (killed.length === 0 && done(statuses)) {
    return { killed, view: { statuses, table, supervisorPid } };
  }
  const settleMs = seams.settleMs ?? Math.max(PENDING_SETTLE_MS, target.timeoutMs);
  const rows = await pollUntil(statuses, readStatuses, done, settleMs, seams.pollMs);
  if (!done(rows)) {
    throw pendingTimeout(target, { settleMs, killed, rows, supervisorPid, isAlive });
  }
  return { killed };
}

/**
 * The pending old runs to kill before the stop. Without a `process list`
 * read (`statuses`), devtrees cannot tell a stuck run from a queued one, so
 * it kills none.
 */
function stuckRuns(
  pending: PendingReload,
  statuses: ReadonlyArray<ServiceStatus> | undefined,
  table: ReadonlyArray<ProcessRow>,
  supervisorPid: number | undefined,
): ServiceProcess[] {
  if (statuses === undefined) return [];
  return pendingRunsToKill(pending.oldRuns, statuses, table, supervisorPid);
}

/** Does the marker record anything to kill or wait on? */
function hasPendingWork(pending: PendingReload | undefined): pending is PendingReload {
  return pending !== undefined && (pending.oldRuns.length > 0 || pending.services.length > 0);
}

/**
 * Re-read with `read` every `pollMs` until `done` holds of the last read or
 * `budgetMs` has passed. Resolves with the last read either way.
 */
async function pollUntil<T>(
  first: T,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  budgetMs: number,
  pollMs: number = DOWN_POLL_MS,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let value = first;
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    value = await read();
  }
  return value;
}

/** The `DOWN_TIMEOUT` for a pending reload that did not finish: the stop was never begun. */
function pendingTimeout(
  target: StopTarget,
  at: {
    readonly settleMs: number;
    readonly killed: ReadonlyArray<ForceKilled>;
    readonly rows: ServiceStatus[] | undefined;
    readonly supervisorPid: number | undefined;
    readonly isAlive: (pid: number) => boolean;
  },
): DownTimeoutError {
  const pending = target.pendingReload ?? { services: [], oldRuns: [] };
  const stuck = stuckFromMarker(pending, at.rows ?? [], at.isAlive);
  const pids = new Set(stuck?.pids ?? []);
  const waitingOn = pending.oldRuns
    .filter((run) => pids.has(run.pid))
    .map((run) => ({ service: run.name, pid: run.pid }));
  const killedPids = new Set(at.killed.map((k) => k.pid));
  const unverified = waitingOn.filter((run) => !killedPids.has(run.pid));
  const services = stuck?.services ?? [...pending.services];
  return new DownTimeoutError(target.command, {
    instance: target.instance,
    socket_path: target.inst.socketPath,
    timeout_ms: at.settleMs,
    process_compose_pid: at.supervisorPid ?? null,
    stuck_services: waitingOn,
    force_killed: at.killed,
    pending_reload: services,
    remedy: unverifiedRemedy(unverified) + target.remedy(at.supervisorPid),
  });
}

/** The remedy's lead-in naming pending old runs devtrees did not kill. */
function unverifiedRemedy(runs: ReadonlyArray<ForceKilled>): string {
  if (runs.length === 0) return "";
  return (
    `devtrees could not verify ${describeProcesses(runs)} as the service's old process, ` +
    "so it did not kill it: check it with `ps` and kill it if it is (safe now, as no stop " +
    "is running). "
  );
}

/**
 * Record each service's process before the stop. Best-effort: a wedged
 * instance whose `process list` fails, or a host without `ps`, yields an
 * empty snapshot, and the stop then simply has nothing to escalate on.
 * `view` is step 0's reads, reused when nothing has changed since.
 */
async function snapshotInstance(
  socketPath: string,
  driver: StopDriver,
  readTable: () => Promise<ProcessRow[]>,
  view?: InstanceView,
): Promise<{ snapshot: ServiceProcess[]; supervisorPid: number | undefined }> {
  if (view !== undefined) {
    const { statuses, table, supervisorPid } = view;
    return { snapshot: snapshotServiceProcesses(statuses, table, supervisorPid), supervisorPid };
  }
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
