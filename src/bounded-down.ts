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
 *     (`finishPendingReload`): wait until the update has started every new
 *     copy. An old run that process-compose no longer lists is being stopped
 *     by its update; once it has stayed so past a grace period it is stuck,
 *     and is SIGKILLed. Only the pending-reload marker knows these runs, and
 *     they are held to the same identity checks as step 3 (see
 *     `pendingRunsToKill`). Old runs it still lists are queued updates and
 *     are left to process-compose. If process-compose exits meanwhile, there
 *     is nothing left to stop. If the update does not finish in time, fail
 *     with `DOWN_TIMEOUT` before stopping anything: a new copy started after
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
 *  4. Once process-compose has stopped, sweep each service's process tree
 *     (#155). process-compose signals a service's process group and calls
 *     the service stopped as soon as its direct child exits, so a grandchild
 *     that ignores SIGTERM (`exec pnpm exec keyshelf run ... -- uv run ...
 *     uvicorn --reload`) outlived it, holding its port. The snapshot also
 *     records every descendant and process-group member of each service
 *     process; any still alive and still the same process get a grace
 *     period (`treeGraceMs`), then SIGKILL. Those it cannot kill are
 *     returned as `survivors`. A pending reload's old runs are children of
 *     process-compose, not of a snapshot service, so the sweep never
 *     touches them (#208).
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
   * When it runs out, the stop is not started. It is extended to cover a
   * stuck old run's grace period, and again after each kill. Default: the
   * `down` budget, and at least 5s.
   */
  readonly settleMs?: number;
  /**
   * How long a pending reload's old run may stay unlisted (its update is
   * stopping it) before devtrees SIGKILLs it (#206). Default: the `down`
   * budget, the patience the stop's own escalation gives any process.
   */
  readonly stuckGraceMs?: number;
  /**
   * How long a service's leftover descendants get to exit after
   * process-compose has stopped, before devtrees SIGKILLs them (#155).
   * Default: 5s.
   */
  readonly treeGraceMs?: number;
}

/** Default grace for process-compose to exit once its stuck services are killed. */
const DOWN_GRACE_MS = 10_000;
const DOWN_POLL_MS = 100;
/** Floor of the wait for a pending reload to finish before the stop. */
const PENDING_SETTLE_MS = 5_000;
/** Default grace for a service's leftover descendants once process-compose has stopped (#155). */
const TREE_GRACE_MS = 5_000;
/** How long a SIGKILLed descendant gets to disappear before it counts as a survivor. */
const TREE_REAP_MS = 1_000;

/** What `boundedDown` is stopping and how to describe it in a `DOWN_TIMEOUT`. */
export interface StopTarget {
  readonly inst: InstanceRef;
  /** Worktree id, or `shared`. */
  readonly instance: string;
  /** The command name for messages (`down`, `prune`). */
  readonly command: string;
  /** The full `down` budget, from `downTimeoutMs`. */
  readonly timeoutMs: number;
  /**
   * The `details.remedy` a `DOWN_TIMEOUT` carries, given the supervisor pid
   * if known. `pending` is set when a pending reload kept the stop from
   * starting (#206): `oldRuns` are the old processes the operator should
   * kill before retrying (stopping process-compose by hand does not help, as
   * its own shutdown waits on them too).
   */
  readonly remedy: (
    processComposePid: number | undefined,
    pending?: { readonly oldRuns: ReadonlyArray<ForceKilled> },
  ) => string;
  /**
   * The instance's pending-reload marker (#206): the old runs a timed-out
   * hot-reload is still waiting on, and the services it brings back.
   * Default: none.
   */
  readonly pendingReload?: PendingReload;
}

/** What `boundedDown` resolves with. */
export interface StopResult {
  readonly forceKilled: ReadonlyArray<ForceKilled>;
  /**
   * process-compose exited on its own while a pending reload was settling
   * (#206), so no `process-compose down` was run. Its control socket may be
   * left behind: the caller cleans up as it does for a dead supervisor.
   */
  readonly supervisorExited?: true;
  /**
   * The `process list` read before the stop, when one succeeded. The caller
   * uses it to tell which services were booted and which had already exited
   * (#155).
   */
  readonly statuses?: ReadonlyArray<ServiceStatus>;
  /**
   * Service processes or their descendants still alive after the stop and
   * the SIGKILL sweep (#155). Present only when non-empty.
   */
  readonly survivors?: ReadonlyArray<ServiceProcess>;
}

/**
 * Stop an instance within its budget, force-killing only the service
 * processes that kept it from stopping. A pending reload's stuck old runs
 * (`target.pendingReload`) are killed before the stop, never during it.
 * Resolves with what was force-killed (empty on a clean stop with nothing
 * pending), and `supervisorExited` when process-compose exited before the
 * stop was needed. Throws `DownTimeoutError` when process-compose is still running
 * after the escalation, or when the pending reload never finished so the
 * stop was not started; rejects as `driver.down` does when
 * `process-compose down` itself fails.
 */
export async function boundedDown(
  target: StopTarget,
  driver: StopDriver,
  seams: StopSeams = {},
): Promise<StopResult> {
  const readTable = seams.readProcessTable ?? readProcessTable;
  const kill = seams.kill ?? process.kill.bind(process);
  const pending = await finishPendingReload(target, driver, seams);
  if (pending.supervisorExited) return { forceKilled: pending.killed, supervisorExited: true };
  const { snapshot, supervisorPid, statuses, tree } = await snapshotInstance(
    target.inst.socketPath,
    driver,
    readTable,
    pending.view,
  );
  // Step 4 (#155), once process-compose has stopped.
  const stopped = async (killed: ForceKilled[]): Promise<StopResult> => {
    const already = new Set(killed.map((k) => k.pid));
    const rest = tree.filter((p) => !already.has(p.pid));
    const swept = await sweepServiceTrees(rest, serviceGroups(snapshot), seams);
    return {
      forceKilled: [...killed, ...swept.killed.filter((k) => !already.has(k.pid))],
      ...(statuses !== undefined ? { statuses } : {}),
      ...(swept.survivors.length > 0 ? { survivors: swept.survivors } : {}),
    };
  };

  const outcome = await driver.down(target.inst, { timeoutMs: target.timeoutMs });
  if (outcome.stopped) return stopped(pending.killed);

  const table = await readTable();
  const pcPid = supervisorPid ?? findSupervisorPid(table, target.inst.socketPath);
  // Only the snapshot: a pending reload's old run is never killed once the
  // stop has begun (see `finishPendingReload`).
  const stuck = stillRunning(snapshot, table);
  const forceKilled = [...pending.killed, ...killProcesses(stuck, kill)];
  const exited = await waitForExit(target.inst.socketPath, pcPid, seams);
  if (exited) return stopped(forceKilled);
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
 * update drops the service from `process list`, stops the old run, waits for
 * it to exit, then starts the new copy, without checking whether a shutdown
 * has begun meanwhile. So a new copy that starts after `process-compose down`
 * fixed its shutdown order is never stopped and outlives process-compose as
 * a PPID-1 orphan. devtrees therefore never kills a pending old run once the
 * stop has begun, and never begins the stop while an update is in flight.
 *
 * It polls until the update has finished (`stuckFromMarker`: each old run
 * has exited or been replaced, and each service the update brings back is
 * listed again). On every poll:
 *
 *  - If process-compose has exited (it runs without `--keep-project`, so it
 *    exits once nothing runs, e.g. when the new copy fails to start), stop
 *    waiting: nothing is left to orphan, and the caller cleans up as for a
 *    dead supervisor (`supervisorExited`).
 *  - An old run process-compose no longer lists, that is still alive and
 *    whose identity still matches, is being stopped by its update. It is
 *    SIGKILLed only once it has been in that state for the grace period
 *    (`stuckGraceMs`, default the `down` budget: the patience the stop's own
 *    escalation gives any process), counted from when devtrees first saw it
 *    so, or from the marker's `unlistedAt` when `up` already saw it so. A
 *    slow graceful stop finishes within it; a stuck one (#188) is killed
 *    after it. Updates run in turn, so every poll re-checks: the next
 *    service's old run may be stuck too.
 *  - An old run process-compose still lists is queued behind another
 *    update and is left alone: process-compose stops it itself,
 *    `shutdown.command` included, when it gets to it.
 *
 * The wait lasts `settleMs`, extended to cover each stuck run's grace period
 * plus another `settleMs` for its update to start the new copy. It stays
 * bounded: each old run extends it at most twice (once while in grace, once
 * when killed). If the update has not finished by then (an old run devtrees
 * could not verify, an unreadable `process list`, a slow update), throw
 * `DOWN_TIMEOUT` without starting the stop, naming what is still pending.
 *
 * The first `ps` read is retried while it comes back empty or without the
 * supervisor. When nothing had to be waited on, the reads are handed back
 * for the snapshot to reuse.
 */
async function finishPendingReload(
  target: StopTarget,
  driver: StopDriver,
  seams: StopSeams,
): Promise<{ killed: ForceKilled[]; view?: InstanceView; supervisorExited?: true }> {
  const pending = target.pendingReload;
  if (!hasPendingWork(pending)) return { killed: [] };
  const settle = new PendingSettle(target, pending, driver, seams);
  const statuses = await settle.readStatuses();
  const { table, supervisorPid } = await readSupervisedTable(
    settle.readTable,
    target.inst.socketPath,
    { delayMs: seams.pollMs },
  );
  if (settle.done(statuses)) return { killed: [], view: { statuses, table, supervisorPid } };
  return settle.run(statuses, table, supervisorPid);
}

/** One step-0 wait: its seams, budgets and what it has seen and killed so far. */
class PendingSettle {
  readonly isAlive: (pid: number) => boolean;
  readonly readTable: () => Promise<ProcessRow[]>;
  private readonly exists: (path: string) => boolean;
  private readonly kill: (target: number, signal: NodeJS.Signals) => void;
  private readonly pollMs: number;
  private readonly graceMs: number;
  private readonly settleMs: number;
  private readonly startedAt = Date.now();
  private deadline: number;
  private everListed = false;
  private readonly killed: ForceKilled[] = [];
  /** pid → when its grace period started (unlisted, alive and verified). */
  private readonly stopping = new Map<number, number>();

  constructor(
    private readonly target: StopTarget,
    private readonly pending: PendingReload,
    private readonly driver: StopDriver,
    seams: StopSeams,
  ) {
    this.isAlive = seams.isAlive ?? isPidAlive;
    this.readTable = seams.readProcessTable ?? readProcessTable;
    this.exists = seams.exists ?? existsSync;
    this.kill = seams.kill ?? process.kill.bind(process);
    this.pollMs = seams.pollMs ?? DOWN_POLL_MS;
    this.graceMs = seams.stuckGraceMs ?? target.timeoutMs;
    this.settleMs = seams.settleMs ?? Math.max(PENDING_SETTLE_MS, target.timeoutMs);
    this.deadline = this.startedAt + this.settleMs;
  }

  /** A `process list` read; `undefined` when it fails. */
  async readStatuses(): Promise<ServiceStatus[] | undefined> {
    const rows = await this.driver
      .getServiceStatuses(this.target.inst.socketPath)
      .catch(() => undefined);
    this.everListed ||= rows !== undefined;
    return rows;
  }

  /** Has the update finished, as `rows` shows it? */
  done(rows: ServiceStatus[] | undefined): rows is ServiceStatus[] {
    return rows !== undefined && stuckFromMarker(this.pending, rows, this.isAlive) === undefined;
  }

  /** Poll until the update finishes, process-compose exits, or the deadline passes. */
  async run(
    first: ServiceStatus[] | undefined,
    firstTable: ReadonlyArray<ProcessRow>,
    knownPid: number | undefined,
  ): Promise<{ killed: ForceKilled[]; supervisorExited?: true }> {
    let statuses = first;
    let table = firstTable;
    let supervisorPid = knownPid;
    for (;;) {
      if (this.done(statuses)) return { killed: this.killed };
      if (this.supervisorGone(supervisorPid)) {
        return { killed: this.killed, supervisorExited: true };
      }
      const now = Date.now();
      this.killDue(stuckRuns(this.pending, statuses, table, supervisorPid), now);
      if (now >= this.deadline) break;
      await new Promise((r) => setTimeout(r, this.pollMs));
      statuses = await this.readStatuses();
      // Never decide on an older `ps` read: a run it shows alive may have
      // exited since, and its pid been reused.
      table = needsTable(this.pending, statuses, this.isAlive) ? await this.readTable() : [];
      supervisorPid ??= findSupervisorPid(table, this.target.inst.socketPath);
    }
    throw pendingTimeout(this.target, {
      waitedMs: this.deadline - this.startedAt,
      killed: this.killed,
      rows: statuses,
      everListed: this.everListed,
      table,
      supervisorPid,
      isAlive: this.isAlive,
    });
  }

  /** Has process-compose exited? By its pid when known, else by its control socket. */
  private supervisorGone(supervisorPid: number | undefined): boolean {
    return supervisorPid === undefined
      ? !this.exists(this.target.inst.socketPath)
      : !this.isAlive(supervisorPid);
  }

  /**
   * SIGKILL each stuck run whose grace period has passed, and stretch the
   * deadline to cover the grace periods still running and each new copy's
   * start after a kill.
   */
  private killDue(runs: ReadonlyArray<ServiceProcess>, now: number): void {
    for (const proc of runs) {
      if (this.killed.some((k) => k.pid === proc.pid)) continue;
      const since = this.stopping.get(proc.pid) ?? stoppingSince(this.pending, proc.pid, now);
      this.stopping.set(proc.pid, since);
      if (now - since < this.graceMs) {
        this.deadline = Math.max(this.deadline, since + this.graceMs + this.settleMs);
        continue;
      }
      this.killed.push(...killProcesses([proc], this.kill));
      this.deadline = Math.max(this.deadline, now + this.settleMs);
    }
  }
}

/**
 * When a stuck old run's grace period started: the marker's `unlistedAt`
 * when `up` already saw it being stopped (only a plausible past time), else
 * `now`.
 */
function stoppingSince(pending: PendingReload, pid: number, now: number): number {
  const at = pending.oldRuns.find((run) => run.pid === pid)?.unlistedAt;
  return typeof at === "number" && Number.isFinite(at) && at <= now ? at : now;
}

/**
 * Is a `ps` read worth taking? Only when `process list` was read and an old
 * run it does not list is still alive: a run that may be stuck.
 */
function needsTable(
  pending: PendingReload,
  statuses: ReadonlyArray<ServiceStatus> | undefined,
  isAlive: (pid: number) => boolean,
): boolean {
  if (statuses === undefined) return false;
  const listed = new Set(statuses.map((s) => s.pid));
  return pending.oldRuns.some((run) => !listed.has(run.pid) && isAlive(run.pid));
}

/**
 * The pending old runs their update is stopping: unlisted, alive and
 * verified (`pendingRunsToKill`). Without a `process list` read
 * (`statuses`), devtrees cannot tell a stuck run from a queued one, so it
 * picks none.
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

/** What a pending reload's `DOWN_TIMEOUT` is built from. */
interface PendingTimeoutState {
  readonly waitedMs: number;
  readonly killed: ReadonlyArray<ForceKilled>;
  readonly rows: ServiceStatus[] | undefined;
  readonly everListed: boolean;
  readonly table: ReadonlyArray<ProcessRow>;
  readonly supervisorPid: number | undefined;
  readonly isAlive: (pid: number) => boolean;
}

/**
 * The `DOWN_TIMEOUT` for a pending reload that did not finish: the stop was
 * never begun. It names the old runs still alive, and hands the remedy those
 * not merely queued (all of them when `process list` could not be read).
 */
function pendingTimeout(target: StopTarget, at: PendingTimeoutState): DownTimeoutError {
  const pending = target.pendingReload ?? { services: [], oldRuns: [] };
  const stuck = stuckFromMarker(pending, at.rows, at.isAlive);
  const pids = new Set(stuck?.pids);
  const alive = pending.oldRuns.filter((run) => pids.has(run.pid));
  const listed = new Set(at.rows?.map((r) => r.pid));
  // Without a list, any live old run may be the stuck one.
  const unlisted = at.rows === undefined ? alive : alive.filter((run) => !listed.has(run.pid));
  return new DownTimeoutError(target.command, {
    instance: target.instance,
    socket_path: target.inst.socketPath,
    timeout_ms: at.waitedMs,
    process_compose_pid: at.supervisorPid ?? null,
    stuck_services: alive.map(processOf),
    force_killed: at.killed,
    pending_reload: stuck?.services ?? [...pending.services],
    remedy:
      pendingLead(unlisted, at) +
      target.remedy(at.supervisorPid, { oldRuns: unlisted.map(processOf) }),
  });
}

/**
 * The remedy's lead-in: that `process list` could never be read, or which
 * runs devtrees could not verify. Unverified means only a missing or
 * non-matching identity: a verified run is never called that.
 */
function pendingLead(unlisted: ReadonlyArray<OldRun>, at: PendingTimeoutState): string {
  if (!at.everListed) {
    return (
      "devtrees could not read process-compose's process list during the whole wait, so " +
      "it could not tell a stuck old process from a queued one, and killed none. "
    );
  }
  const verified = new Set(
    pendingRunsToKill(unlisted, [], at.table, at.supervisorPid).map((p) => p.pid),
  );
  const unverified = unlisted.filter((run) => !verified.has(run.pid)).map(processOf);
  if (unverified.length === 0) return "";
  return (
    `devtrees could not verify ${describeProcesses(unverified)} as the service's old process ` +
    "(no recorded identity, or its parent, process group or command line no longer " +
    "match), so it did not kill it: check it with `ps`. "
  );
}

function processOf(run: OldRun): ForceKilled {
  return { service: run.name, pid: run.pid };
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
): Promise<Snapshot> {
  if (view !== undefined) return snapshotOf(view.statuses, view.table, view.supervisorPid);
  let statuses: ServiceStatus[];
  try {
    statuses = await driver.getServiceStatuses(socketPath);
  } catch {
    return { snapshot: [], tree: [], supervisorPid: undefined };
  }
  // No pid to protect: skip the process-table read on the common path.
  if (!statuses.some((s) => s.pid !== undefined)) {
    return { snapshot: [], tree: [], supervisorPid: undefined, statuses };
  }
  const table = await readTable();
  return snapshotOf(statuses, table, findSupervisorPid(table, socketPath));
}

/** What the pre-stop snapshot recorded. */
interface Snapshot {
  /** The service processes: direct children of process-compose. */
  readonly snapshot: ServiceProcess[];
  /** The service processes plus every descendant and process-group member (#155). */
  readonly tree: ServiceProcess[];
  readonly supervisorPid: number | undefined;
  /** The `process list` read, when it succeeded. */
  readonly statuses?: ReadonlyArray<ServiceStatus>;
}

function snapshotOf(
  statuses: ReadonlyArray<ServiceStatus>,
  table: ReadonlyArray<ProcessRow>,
  supervisorPid: number | undefined,
): Snapshot {
  const snapshot = snapshotServiceProcesses(statuses, table, supervisorPid);
  return { snapshot, tree: serviceTrees(snapshot, table), supervisorPid, statuses };
}

/**
 * Each service process together with its descendants and the other members
 * of its process group, labelled with the service (#155). process-compose
 * starts every service as the leader of a new process group, so a member of
 * that group is the service's even after its parent died and it was
 * reparented to PID 1. A descendant that moved to a group of its own is
 * still found through its parent.
 */
export function serviceTrees(
  services: ReadonlyArray<ServiceProcess>,
  table: ReadonlyArray<ProcessRow>,
): ServiceProcess[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const byPid = new Map<number, ServiceProcess>();
  for (const svc of services) {
    const members = [svc, ...descendants(svc, children), ...groupMembers(svc, table)];
    for (const row of members)
      if (!byPid.has(row.pid)) byPid.set(row.pid, { ...row, service: svc.service });
  }
  return [...byPid.values()];
}

/** Every process below `root` in the process tree, breadth first. */
function descendants(root: ProcessRow, children: ReadonlyMap<number, ProcessRow[]>): ProcessRow[] {
  const found: ProcessRow[] = [];
  const seen = new Set([root.pid]);
  const queue = [root];
  for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
    const next = (children.get(row.pid) ?? []).filter((child) => !seen.has(child.pid));
    for (const child of next) seen.add(child.pid);
    found.push(...next);
    queue.push(...next);
  }
  return found;
}

/** The other members of the process group `svc` leads (none when it leads none). */
function groupMembers(svc: ProcessRow, table: ReadonlyArray<ProcessRow>): ProcessRow[] {
  return svc.pgid === svc.pid ? table.filter((row) => row.pgid === svc.pgid) : [];
}

/**
 * The recorded tree processes that are still alive and still the same
 * process: same pid, process group and command line. Unlike `stillRunning`,
 * the parent may have changed: a descendant whose parent exited is
 * reparented, and that is exactly the leftover the sweep is for.
 */
export function treeSurvivors(
  tree: ReadonlyArray<ServiceProcess>,
  table: ReadonlyArray<ProcessRow>,
): ServiceProcess[] {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  return tree.filter((proc) => {
    const now = byPid.get(proc.pid);
    return now !== undefined && now.pgid === proc.pgid && now.command === proc.command;
  });
}

/** The process groups the services lead: process-compose signalled these on the stop. */
function serviceGroups(services: ReadonlyArray<ServiceProcess>): Set<number> {
  return new Set(services.filter((p) => p.pgid === p.pid).map((p) => p.pgid));
}

/**
 * Step 4 (#155): once process-compose has stopped, give each service's
 * leftover descendants `treeGraceMs` to exit, then SIGKILL them.
 * process-compose already sent SIGTERM to each service's process group;
 * a leftover outside that group never got it, so it is sent one first.
 * A group that still has a verified member is killed as a group, so a
 * process that forks a replacement (a reloader respawning its worker)
 * cannot slip through. What is still alive afterwards is a survivor.
 */
async function sweepServiceTrees(
  tree: ReadonlyArray<ServiceProcess>,
  groups: ReadonlySet<number>,
  seams: StopSeams,
): Promise<{ killed: ForceKilled[]; survivors: ServiceProcess[] }> {
  const none = { killed: [], survivors: [] };
  if (tree.length === 0) return none;
  const { readTable, kill, isAlive, pollMs, graceMs } = sweepSeams(seams);
  const gone = (procs: ReadonlyArray<ServiceProcess>) => () => procs.every((p) => !isAlive(p.pid));
  const left = treeSurvivors(tree, await readTable());
  for (const proc of left) if (!groups.has(proc.pgid)) signal(kill, proc.pid, "SIGTERM");
  if (await pollUntil(gone(left), graceMs, pollMs)) return none;
  // Re-verify on a fresh read: never kill a pid reused during the grace.
  const stuck = treeSurvivors(left, await readTable());
  const killed = killTreeLeftovers(stuck, groups, kill);
  await pollUntil(gone(stuck), TREE_REAP_MS, pollMs);
  return { killed, survivors: treeSurvivors(stuck, await readTable()) };
}

/** The tree sweep's seams, defaulted. */
function sweepSeams(seams: StopSeams) {
  return {
    readTable: seams.readProcessTable ?? readProcessTable,
    kill: seams.kill ?? process.kill.bind(process),
    isAlive: seams.isAlive ?? isPidAlive,
    pollMs: seams.pollMs ?? DOWN_POLL_MS,
    graceMs: seams.treeGraceMs ?? TREE_GRACE_MS,
  } as const;
}

/**
 * SIGKILL each leftover: by its service's process group when it is in one
 * (one signal per group), else by pid. Reports those a signal reached.
 */
function killTreeLeftovers(
  stuck: ReadonlyArray<ServiceProcess>,
  groups: ReadonlySet<number>,
  kill: (target: number, signal: NodeJS.Signals) => void,
): ForceKilled[] {
  const sent = new Map<number, boolean>();
  return stuck.flatMap((proc) => {
    const target = groups.has(proc.pgid) ? -proc.pgid : proc.pid;
    if (!sent.has(target)) sent.set(target, signal(kill, target, "SIGKILL"));
    return sent.get(target) === true ? [{ service: proc.service, pid: proc.pid }] : [];
  });
}

/** Send a signal; false when the target is already gone. */
function signal(
  kill: (target: number, signal: NodeJS.Signals) => void,
  target: number,
  sig: NodeJS.Signals,
): boolean {
  try {
    kill(target, sig);
    return true;
  } catch {
    // Exited on its own between the read and the signal.
    return false;
  }
}

/** Poll `done` every `pollMs` for up to `ms`; true once it holds. */
async function pollUntil(done: () => boolean, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
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
  return pollUntil(gone, seams.graceMs ?? DOWN_GRACE_MS, seams.pollMs ?? DOWN_POLL_MS);
}
