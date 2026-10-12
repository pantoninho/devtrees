/**
 * Pending-reload detection (issue #191).
 *
 * A hot-reload of a changed service whose old process never stops (a
 * `shutdown.command` that exits 0 without stopping it, a SIGTERM-ignorer with
 * no timeout) blocks inside process-compose. `up` gives up at its budget and
 * reports `CONFIG_DRIFT` / `timeout`, but process-compose keeps applying the
 * update: it has already dropped the changed service from the project while
 * the old process is still running. Its `UpdateProject` is not serialised, so
 * a second reload in that window adds the service back and starts a new copy;
 * when the old process finally exits, the first update starts another one,
 * and the copy the retry started is orphaned (untracked, survives `down`,
 * collides on ports).
 *
 * `up` therefore refuses to reload while a previous reload is still pending.
 * The signal is a marker, read under the worktree's lifecycle lock. When a
 * reload times out, `up` persists which changed services must reappear and
 * the PIDs of their old runs, taken from a `process list` snapshot made just
 * before the reload. An entry is pending while its service is absent from the
 * project, or while its old PID is alive and the project does not show the
 * service back under a different PID (process-compose re-adds it only once the
 * old process has exited, so a new PID there means a reused PID is not ours).
 * Once a read shows nothing pending, the marker is cleared. `down` and a fresh
 * start clear it too: the instance it describes is gone.
 *
 * The marker also lets `down` finish (#206). process-compose no longer lists
 * the old runs, yet its `down` waits on them, so the bounded `down` kills
 * them along with its own snapshot once its budget runs out. To make that
 * safe against pid reuse, the marker records each old run's parent, process
 * group and command line, read from `ps` when the reload times out
 * (`identifyOldRuns`).
 *
 * There is deliberately no stateless fallback (reading the project's shape
 * against the on-disk config): the restored on-disk config is stale after a
 * timed-out rename or removal, and an empty project is legitimate after
 * `up -n <ns>` on a namespace with no services (#176), so every version of
 * it refused healthy instances. Only builds without the marker could need it,
 * and none was released.
 *
 * Pure apart from the marker file I/O. The process list is read by the
 * caller and handed in, as is the liveness check.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRow } from "./bounded-down.js";
import type { ServiceStatus } from "./driver.js";
import { stateDir } from "./paths.js";
import { writeAtomic } from "./registry.js";
import { namespaceSelected, serviceNamespaces } from "./selection.js";
import type { Namespace } from "./stack.js";

/**
 * The old run's process-table identity when the reload timed out (#206):
 * its parent (this instance's process-compose), process group and command
 * line. `down` kills the run only while all three still match, so a reused
 * pid is never hit.
 */
export interface OldRunIdentity {
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

/** One old run a pending reload is waiting on. */
export interface OldRun {
  readonly name: string;
  readonly pid: number;
  /**
   * Set by `identifyOldRuns` when the marker is written (#206). `null`: the
   * run could not be identified as a child of the instance's process-compose
   * then (already gone, or `ps` failed), so `down` never kills it. Absent: a
   * marker from a build before #206, see `pendingRunsToKill`.
   */
  readonly identity?: OldRunIdentity | null;
}

/** What a timed-out reload leaves behind (persisted, see the module doc). */
export interface PendingReload {
  /** Changed services the pending update must bring back into the project. */
  readonly services: ReadonlyArray<string>;
  /** The changed services' runs from before the reload, which must exit. */
  readonly oldRuns: ReadonlyArray<OldRun>;
}

/** The verdict when a reload is still pending: who is stuck, and on what. */
export interface StuckReload {
  readonly services: ReadonlyArray<string>;
  /**
   * Old PIDs still alive. Empty when the old process has exited but the
   * update has not brought the service back yet.
   */
  readonly pids: ReadonlyArray<number>;
}

/** A derived config's `processes` map, as read back from disk (unvalidated). */
type DerivedProcesses = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** A derived process entry's `namespace`, when it is a well-formed one. */
function namespaceOf(entry: Readonly<Record<string, unknown>> | undefined): {
  readonly namespace?: Namespace;
} {
  const ns = entry?.namespace;
  if (typeof ns === "string") return { namespace: ns };
  if (Array.isArray(ns) && ns.every((n) => typeof n === "string")) return { namespace: ns };
  return {};
}

/**
 * The namespaces `rows` proves booted against the derived config `declared`:
 * those a present service declares as its only namespace.
 */
export function provenNamespaces(
  declared: DerivedProcesses,
  rows: ReadonlyArray<ServiceStatus>,
): string[] {
  const present = new Set(rows.map((r) => r.name));
  const proven = Object.keys(declared).flatMap((name) => {
    const ns = serviceNamespaces(namespaceOf(declared[name]));
    return present.has(name) && ns.length === 1 ? ns : [];
  });
  return [...new Set(proven)].sort();
}

function markerFile(anchor: string, worktreeId: string): string {
  return join(stateDir(anchor), `${worktreeId}.reload-pending.json`);
}

/** Read the marker, or `undefined` when there is none (or it is unreadable). */
export function readPendingReload(anchor: string, worktreeId: string): PendingReload | undefined {
  const file = markerFile(anchor, worktreeId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PendingReload> | null;
    return {
      services: Array.isArray(parsed?.services) ? parsed.services : [],
      oldRuns: Array.isArray(parsed?.oldRuns) ? parsed.oldRuns : [],
    };
  } catch {
    // A torn or hand-edited marker records nothing to wait on: the next
    // successful read clears it.
    return { services: [], oldRuns: [] };
  }
}

export function writePendingReload(
  anchor: string,
  worktreeId: string,
  marker: PendingReload,
): void {
  writeAtomic(markerFile(anchor, worktreeId), `${JSON.stringify(marker, null, 2)}\n`);
}

/** Remove the marker. No-op when absent. */
export function clearPendingReload(anchor: string, worktreeId: string): void {
  rmSync(markerFile(anchor, worktreeId), { force: true });
}

/**
 * The marker for a reload from `before` to `after` that timed out. `rows` is
 * the `process list` snapshot taken before the reload, or `undefined` if that
 * read failed. A changed service is one whose process entry differs or is
 * gone in `after`. Only their snapshot PIDs are waited on. A service is
 * expected back only if the snapshot shows it (an unselected one never
 * appears), `after` still declares it, and it stays in a booted namespace:
 * its namespaces are unchanged, or one of them is proven booted by the
 * snapshot. A service moved into an unbooted namespace never reappears.
 * Without a snapshot the marker records nothing to wait on (guessing would
 * risk waiting forever on an unselected service), so it guards nothing.
 */
export function planPendingReload(
  before: DerivedProcesses | undefined,
  after: DerivedProcesses,
  rows: ReadonlyArray<ServiceStatus> | undefined,
): PendingReload {
  if (before === undefined || rows === undefined) return { services: [], oldRuns: [] };
  const changed = new Set(
    Object.keys(before).filter(
      (name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]),
    ),
  );
  const snapshot = rows.filter((r) => changed.has(r.name));
  const booted = provenNamespaces(before, rows);
  const staysBooted = (name: string): boolean => {
    const next = namespaceOf(after[name]);
    const sameNamespaces =
      JSON.stringify(serviceNamespaces(namespaceOf(before[name]))) ===
      JSON.stringify(serviceNamespaces(next));
    return sameNamespaces || namespaceSelected(next, booted);
  };
  return {
    services: snapshot
      .map((r) => r.name)
      .filter((name) => after[name] !== undefined && staysBooted(name)),
    oldRuns: snapshot.flatMap((r) => (r.pid !== undefined ? [{ name: r.name, pid: r.pid }] : [])),
  };
}

/**
 * Record each old run's process-table identity (#206), from a `ps` read
 * taken when the reload timed out. The old run is still running then (it is
 * what the reload is waiting on), as a direct child of the instance's
 * process-compose (`supervisorPid`). A run that is not such a child in
 * `table` (it exited, or the read failed) gets `identity: null`: `down`
 * must never kill it on the pid alone.
 */
export function identifyOldRuns(
  marker: PendingReload,
  table: ReadonlyArray<ProcessRow>,
  supervisorPid: number | undefined,
): PendingReload {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  return {
    ...marker,
    oldRuns: marker.oldRuns.map((run) => {
      const row = byPid.get(run.pid);
      const child = supervisorPid !== undefined && row !== undefined && row.ppid === supervisorPid;
      return {
        name: run.name,
        pid: run.pid,
        identity: child ? { ppid: row.ppid, pgid: row.pgid, command: row.command } : null,
      };
    }),
  };
}

/**
 * Is the reload `marker` records still pending? `rows` is a fresh `process
 * list` read (`undefined` if it failed: then only the PIDs are evidence).
 * Returns the stuck services, or `undefined` once it has converged.
 */
export function stuckFromMarker(
  marker: PendingReload,
  rows: ReadonlyArray<ServiceStatus> | undefined,
  isAlive: (pid: number) => boolean,
): StuckReload | undefined {
  // A row back under a different PID means the old run exited (process-compose
  // re-adds the service only then): a live PID with that number is a reuse.
  const current = new Map(rows?.map((r) => [r.name, r.pid]));
  const replaced = (r: OldRun): boolean => {
    const pid = current.get(r.name);
    return pid !== undefined && pid !== r.pid;
  };
  const alive = marker.oldRuns.filter((r) => !replaced(r) && isAlive(r.pid));
  const present = new Set(rows?.map((r) => r.name));
  const absent = rows === undefined ? [] : marker.services.filter((name) => !present.has(name));
  const services = [...new Set([...alive.map((r) => r.name), ...absent])];
  if (services.length === 0) return undefined;
  return { services, pids: alive.map((r) => r.pid) };
}

/** Default liveness check: signal 0 (EPERM means alive, owned by someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
