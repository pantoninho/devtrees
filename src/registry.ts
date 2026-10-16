/**
 * Allocation registry store (adapter).
 *
 * Persists each worktree's port-block base under `<anchor>/devtrees/registry.json`
 * (CONTEXT.md "Allocation registry") and serializes concurrent `up`s with a
 * lockfile so two worktrees brought up simultaneously cannot race the read –
 * modify – write and double-allocate (PRD US-32). The lock is a `mkdir`-backed
 * file created with `wx` (atomic on POSIX), polled with a small bounded retry
 * loop, and always released — even when the callback throws.
 *
 * Scope is per-repo: the registry lives inside the git common dir, never on disk
 * outside the anchor (ADR-0001, CONTEXT.md "Anchor state"). There is no
 * machine-global state; cross-repo collisions are mitigated by the configurable
 * `port_base` per repo, not coordinated through this module.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RegistrySnapshot } from "./allocator.js";

/**
 * Mirrors `SHARED_INSTANCE_ID` in src/paths.ts (not imported: the
 * registry.test.ts / registry.integration.test.ts child-process workers load
 * this module under raw node, whose type stripping cannot resolve a local
 * `./paths.js` specifier from TS source — type-only imports are fine, runtime
 * ones are not).
 */
const SHARED_INSTANCE_ID = "shared";

/**
 * Raised when a devtrees lock (allocation registry or an instance's lifecycle
 * lock) is already held and retries are exhausted. Carries the documented
 * `LOCK_CONTENTION` code (issue #84) so the CLI's `classifyError`
 * (src/output.ts) maps it into the `--json` error envelope — an agent seeing
 * it knows the failure is "retry later", not "fix something".
 *
 * Internal, like the other tagged error classes (`HealthTimeoutError`,
 * `SharedDriftError`, ... in src/commands.ts): callers match on `.code`
 * (or message text), never on the constructor.
 */
class LockContentionError extends Error {
  readonly code = "LOCK_CONTENTION" as const;
  constructor(lockPath: string) {
    super(
      `another devtrees process is holding the lock at ${lockPath}. ` +
        `Locks held by dead processes are reclaimed automatically, so the holder is ` +
        `still alive — wait for it to finish (or, if it is stuck, kill it) and retry.`,
    );
    this.name = "LockContentionError";
  }
}

/** Tunables for the lock acquire loop, exposed so tests can disable the wait. */
export interface LockOptions {
  /** How many times to retry acquiring the lock before giving up. Default 50. */
  readonly retries?: number;
  /** Delay between retries, in ms. Default 20 (≈1s total at the default retry count). */
  readonly retryDelayMs?: number;
}

const DEFAULT_RETRIES = 50;
const DEFAULT_DELAY_MS = 20;

function devtreesDir(anchor: string): string {
  return join(anchor, "devtrees");
}

function registryFile(anchor: string): string {
  return join(devtreesDir(anchor), "registry.json");
}

function lockFile(anchor: string): string {
  return join(devtreesDir(anchor), "registry.lock");
}

/**
 * Path of an instance's lifecycle lock, sibling of registry.lock. Keyed by
 * instance id (a worktree id, or the reserved `shared`), so locks for distinct
 * instances never contend — the shared instance's lock stays at the
 * pre-#91 `shared.lock` path because its instance id IS `shared`.
 */
function lifecycleLockFile(anchor: string, instanceId: string): string {
  return join(devtreesDir(anchor), `${instanceId}.lock`);
}

/** Lock files in the anchor state dir that are not a worktree's lifecycle lock. */
const NON_WORKTREE_LOCKS = new Set([`${SHARED_INSTANCE_ID}.lock`, "registry.lock", "hashes.lock"]);

/**
 * The worktree ids whose lifecycle lock is held now by a live process: an
 * `up`, `down` or `restart` in flight in that worktree. Read-only: takes no
 * lock and steals nothing. A lock whose content is not a pid counts as held,
 * as `stealIfStale` never steals one either; one left by a dead process does
 * not. The shared, registry and hashes locks are not a worktree's and are
 * skipped. Shared by `prune --shared-ports` (#238) and `down --shared -n`
 * (#239), both of which run it under the shared lock.
 */
export function heldWorktreeLocks(anchor: string): string[] {
  const dir = devtreesDir(anchor);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (!entry.endsWith(".lock") || NON_WORKTREE_LOCKS.has(entry)) return [];
    let content: string;
    try {
      content = readFileSync(join(dir, entry), "utf8");
    } catch {
      return []; // released between the listing and the read
    }
    const pid = Number.parseInt(content.trim(), 10);
    const held = !Number.isInteger(pid) || pid <= 0 || isPidAlive(pid);
    return held ? [entry.slice(0, -".lock".length)] : [];
  });
}

/**
 * What a worktree's in-flight lifecycle command declared about the shared
 * services it uses (#244 follow-up): the **shared-step marker**,
 * `<anchor>/devtrees/<worktree id>.shared-step.json`.
 *
 * An `up` writes it under the shared lifecycle lock, in its shared step,
 * naming the shared services it selected and the shared named ports it
 * injects. A worktree `down`, which never uses a shared service, writes one
 * that names none (and no ports). A `down --shared -n` then waits only for
 * an in-flight worktree whose marker names one of its targets, or that has
 * no valid marker yet (an `up` not past its shared step); `prune
 * --shared-ports` treats the marker's ports as held instead of refusing.
 *
 * The marker belongs to ONE hold of the worktree's lifecycle lock: it records
 * the holder's pid and the lock file's inode, and is valid only while that
 * same lock file is held by that same live pid. It is removed before the lock
 * is released, and a leftover one (a crash) is ignored and removed by the
 * next holder of that lock, or by a teardown or prune that finds it stale.
 */
export interface SharedStepMarker {
  readonly version: 1;
  readonly pid: number;
  /** Inode of the lifecycle lock file this marker belongs to. */
  readonly lock_ino: number;
  /** The shared services the command uses (selected, for an `up`). */
  readonly services: ReadonlyArray<string>;
  /** The shared named ports it injects; absent when it does not say (prune keeps refusing). */
  readonly ports?: ReadonlyArray<string>;
}

/** Path of a worktree's shared-step marker. */
export function sharedStepMarkerFile(anchor: string, worktreeId: string): string {
  return join(devtreesDir(anchor), `${worktreeId}.shared-step.json`);
}

/** The pid recorded in a lock file and its inode, or `undefined` when it is gone or not a pid. */
function lockHolder(path: string): { readonly pid: number; readonly ino: number } | undefined {
  try {
    const ino = statSync(path).ino;
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? { pid, ino } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write this process's shared-step marker for `worktreeId`. A no-op unless
 * this process holds that worktree's lifecycle lock (a lock file carrying
 * its pid): a marker is only ever about the current hold.
 */
export function writeSharedStepMarker(
  anchor: string,
  worktreeId: string,
  claim: { readonly services: ReadonlyArray<string>; readonly ports?: ReadonlyArray<string> },
): void {
  if (worktreeId === SHARED_INSTANCE_ID) return;
  const holder = lockHolder(lifecycleLockFile(anchor, worktreeId));
  if (holder === undefined || holder.pid !== process.pid) return;
  const marker: SharedStepMarker = {
    version: 1,
    pid: holder.pid,
    lock_ino: holder.ino,
    services: [...claim.services],
    ...(claim.ports !== undefined ? { ports: [...claim.ports] } : {}),
  };
  writeAtomic(sharedStepMarkerFile(anchor, worktreeId), `${JSON.stringify(marker)}\n`);
}

function clearSharedStepMarker(anchor: string, worktreeId: string): void {
  releaseLockAt(sharedStepMarkerFile(anchor, worktreeId));
}

function readMarkerFile(path: string): SharedStepMarker | undefined {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<SharedStepMarker> | null;
    const strings = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string");
    if (
      doc?.version !== 1 ||
      typeof doc.pid !== "number" ||
      typeof doc.lock_ino !== "number" ||
      !strings(doc.services) ||
      (doc.ports !== undefined && !strings(doc.ports))
    ) {
      return undefined;
    }
    return doc as SharedStepMarker;
  } catch {
    return undefined;
  }
}

/** One worktree with a lifecycle command in flight, and its valid marker if it wrote one. */
export interface InFlightWorktree {
  readonly id: string;
  readonly marker: SharedStepMarker | undefined;
}

/**
 * The worktrees with a lifecycle command in flight (`heldWorktreeLocks`),
 * each with its shared-step marker when that marker belongs to the current
 * hold of its lock (same pid, same lock file). A marker that does not is
 * stale; with `clearStale`, it is removed, and so is every marker of a
 * worktree whose lock is not held at all. Only callers holding the shared
 * lock pass `clearStale`: a marker is written under that lock, so none can
 * appear while they decide.
 */
export function inFlightWorktrees(
  anchor: string,
  opts: { readonly clearStale?: boolean } = {},
): InFlightWorktree[] {
  const held = heldWorktreeLocks(anchor);
  const out = held.map((id): InFlightWorktree => {
    const path = sharedStepMarkerFile(anchor, id);
    const marker = existsSync(path) ? readMarkerFile(path) : undefined;
    const holder = lockHolder(lifecycleLockFile(anchor, id));
    const valid =
      marker !== undefined &&
      holder !== undefined &&
      holder.pid === marker.pid &&
      holder.ino === marker.lock_ino;
    return { id, marker: valid ? marker : undefined };
  });
  if (opts.clearStale === true) {
    const live = new Set(out.filter((w) => w.marker !== undefined).map((w) => w.id));
    const dir = devtreesDir(anchor);
    const suffix = ".shared-step.json";
    for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
      if (entry.endsWith(suffix) && !live.has(entry.slice(0, -suffix.length))) {
        releaseLockAt(join(dir, entry));
      }
    }
  }
  return out;
}

/**
 * Read the persisted snapshot for this anchor; empty object if none exists yet.
 *
 * Parse-tolerant: a corrupt or non-object file (e.g. left behind by a crash
 * that predates the atomic-rename writes) degrades to the empty snapshot
 * instead of throwing on every subsequent command. The next locked write
 * replaces the corrupt file with valid JSON, so the store self-heals.
 */
export function readRegistry(anchor: string): RegistrySnapshot {
  const file = registryFile(anchor);
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as RegistrySnapshot;
  } catch {
    return {};
  }
}

/** Outcome of one `wx`-create attempt. */
type AttemptResult = "acquired" | "contended";

/**
 * One `wx`-create attempt: `acquired` on success, `contended` on EEXIST, rethrow
 * on any other errno.
 */
function tryWxCreate(path: string): AttemptResult {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
    return "acquired";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return "contended";
  }
}

/** True when `pid` names a live process (EPERM counts as alive — it exists). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Steal `path` if its recorded holder pid is dead (e.g. the holder was
 * SIGKILLed before its `finally` release ran). Returns true when the lock was
 * removed (or vanished concurrently) and a re-acquire attempt is worthwhile.
 * Unparseable content is never stolen — we cannot prove the holder is gone.
 *
 * Racy by design: between reading the pid and unlinking, the dead holder's
 * lock could be released-and-reacquired by a live process, in which case we
 * would steal a live lock. The window is a few syscalls wide and only opens
 * after a real crash left a stale lock behind; the alternative (bricking
 * every subsequent `up` until a human deletes the file) is strictly worse.
 */
function stealIfStale(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    // Lock vanished between the failed create and this read — retry at once.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  const pid = Number.parseInt(content.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (isPidAlive(pid)) return false;
  releaseLockAt(path); // tolerates a concurrent stealer winning the unlink
  return true;
}

/**
 * One full acquire attempt: a `wx`-create, then — on contention — a steal of
 * a dead holder's lock followed by an immediate re-create. Shared by the
 * async and sync acquire loops so the attempt semantics cannot drift apart.
 */
function tryAcquireOnce(path: string): boolean {
  if (tryWxCreate(path) === "acquired") return true;
  return stealIfStale(path) && tryWxCreate(path) === "acquired";
}

/**
 * Acquire a lockfile by `wx`-creating it; throws LockContentionError on timeout.
 * Uses `setTimeout` between retries so other tasks (including the current
 * holder's `finally` release) can run. On contention, a lock whose recorded
 * holder pid is dead is stolen immediately instead of being waited out.
 */
async function acquireLockAtAsync(path: string, options: LockOptions): Promise<void> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delay = options.retryDelayMs ?? DEFAULT_DELAY_MS;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (tryAcquireOnce(path)) return;
    if (attempt === retries) throw new LockContentionError(path);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

function releaseLockAt(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    // Already gone is fine; anything else is a real problem.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function releaseLock(anchor: string): void {
  releaseLockAt(lockFile(anchor));
}

/**
 * Persist the snapshot via temp-file + atomic rename. `env` and instance
 * discovery read the registry lock-free, so an in-place truncate-write would
 * expose a window where a reader sees an empty or half-written file — and a
 * crash inside that window would leave permanently corrupt JSON. `rename(2)`
 * within the same directory is atomic on POSIX: readers see either the old
 * complete file or the new complete file, never anything in between.
 */
function writeSnapshot(anchor: string, snapshot: RegistrySnapshot): void {
  writeAtomic(registryFile(anchor), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Write `content` to `file` atomically (same-directory temp file + rename). */
export function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

/**
 * Run `mutate` against an atomic snapshot of the registry. The lock is held for
 * the duration of the callback, so concurrent callers see a serialized
 * read-modify-write. If `mutate` returns the same reference it was given the
 * snapshot is treated as untouched and no write happens; any other returned
 * object is persisted before the lock is released. The lock is always released,
 * including on a thrown callback.
 *
 * `mutate` may be async — `allocateBlock` awaits the injectable port-free probe
 * (which binds a real TCP listener by default), so the read-modify-write under
 * the lock has natural async gaps. Acquire is async to avoid the sync
 * `Atomics.wait` busy loop blocking the event loop while a concurrent in-process
 * caller is holding the lock through a probe.
 */
export async function withRegistryLock(
  anchor: string,
  mutate: (snapshot: RegistrySnapshot) => RegistrySnapshot | Promise<RegistrySnapshot>,
  options: LockOptions = {},
): Promise<RegistrySnapshot> {
  mkdirSync(devtreesDir(anchor), { recursive: true });
  await acquireLockAtAsync(lockFile(anchor), options);
  try {
    const before = readRegistry(anchor);
    const after = await mutate(before);
    if (after !== before) writeSnapshot(anchor, after);
    return after;
  } finally {
    releaseLock(anchor);
  }
}

/** Block the calling thread for `ms` without spinning (no event loop needed). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Synchronous counterpart of the lock acquire, for callers whose critical
 * section never awaits (the hashes store's read-modify-write). Safe to block
 * the event loop here: a sync-only critical section can never be mid-hold in
 * this process while we wait (single thread), so the only possible holder is
 * another process, which releases independently. Same stale-steal behavior as
 * the async path.
 */
function acquireLockSync(path: string, options: LockOptions): void {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delay = options.retryDelayMs ?? DEFAULT_DELAY_MS;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (tryAcquireOnce(path)) return;
    if (attempt === retries) throw new LockContentionError(path);
    sleepSync(delay);
  }
}

/**
 * Run a synchronous critical section under `path` as a lockfile. The callback
 * MUST NOT await — see `acquireLockSync`. Exported for the hashes store, whose
 * whole-file read-modify-write otherwise races concurrent `up`s in different
 * worktrees (issue #85).
 */
export function withFileLockSync<T>(path: string, fn: () => T, options: LockOptions = {}): T {
  acquireLockSync(path, options);
  try {
    return fn();
  } finally {
    releaseLockAt(path);
  }
}

/**
 * Serialize lifecycle operations (start, teardown) for ONE instance across
 * processes (issue #91). Held over an async callback so the whole
 * liveness-check → config-write → spawn → socket-wait window can run inside
 * the critical section — two simultaneous `devtrees up`s targeting the same
 * instance therefore see a consistent "is it already running?" answer and at
 * most one goes on to spawn; the loser observes the winner's live socket and
 * takes the idempotency path.
 *
 * Locks are per-instance (`<anchor>/devtrees/<instanceId>.lock`): concurrent
 * `up`s in *different* worktrees never contend here. This is a separate
 * lockfile from the allocation registry's: the registry lock is held for
 * short read-modify-writes, while a lifecycle lock may cover spawning a
 * child process and waiting for its control socket.
 */
export async function withLifecycleLock<T>(
  anchor: string,
  instanceId: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  mkdirSync(devtreesDir(anchor), { recursive: true });
  const path = lifecycleLockFile(anchor, instanceId);
  await acquireLockAtAsync(path, options);
  const worktree = instanceId !== SHARED_INSTANCE_ID;
  try {
    // A shared-step marker left by a crashed earlier holder describes a hold
    // that is over; this one starts with none.
    if (worktree) clearSharedStepMarker(anchor, instanceId);
    return await fn();
  } finally {
    // Marker first, then the lock: a reader that still sees the lock held
    // sees at worst no marker (the conservative case), never a marker that
    // outlived its hold.
    try {
      if (worktree) clearSharedStepMarker(anchor, instanceId);
    } finally {
      releaseLockAt(path);
    }
  }
}

/**
 * The shared instance's lifecycle lock — `withLifecycleLock` under the
 * reserved `shared` instance id. Kept as a named export because the shared
 * instance has a fixed identity at the anchor (src/paths.ts) and several
 * call sites (lazy start, `down --shared`) want that spelled out.
 */
export async function withSharedLock<T>(
  anchor: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  return withLifecycleLock(anchor, SHARED_INSTANCE_ID, fn, options);
}

/**
 * Fail `LOCK_CONTENTION` when any worktree instance's lifecycle lock is held
 * by a live process: an `up` or `down` is in flight there (#238). Called by
 * `prune --shared-ports` while it holds the shared lock: an `up` records its
 * shared ports under the shared lock but writes its worktree config after
 * releasing it, under its own lifecycle lock, so a name it just recorded is
 * only provably in use once that lock is gone. A lock left by a dead process
 * does not count. The shared, registry and hashes locks are skipped
 * (`heldWorktreeLocks`). A worktree in `except` does not count either: the
 * caller already knows what its command holds (its shared-step marker).
 */
export function assertNoWorktreeLifecycleLocks(
  anchor: string,
  except: ReadonlySet<string> = new Set(),
): void {
  const held = heldWorktreeLocks(anchor).find((id) => !except.has(id));
  if (held !== undefined) throw new LockContentionError(lifecycleLockFile(anchor, held));
}
