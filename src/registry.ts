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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistrySnapshot } from "./allocator.js";

/** Raised when the registry lock is already held and retries are exhausted. */
export class RegistryLockedError extends Error {
  constructor(lockPath: string) {
    super(
      `another devtrees process is holding the allocation registry lock at ${lockPath}. ` +
        `If no devtrees command is running, the lock is stale — remove it and retry.`,
    );
    this.name = "RegistryLockedError";
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

/** Path of the shared-instance lifecycle lock, sibling of registry.lock. */
function sharedLockFile(anchor: string): string {
  return join(devtreesDir(anchor), "shared.lock");
}

/** Read the persisted snapshot for this anchor; empty object if none exists yet. */
export function readRegistry(anchor: string): RegistrySnapshot {
  const file = registryFile(anchor);
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as RegistrySnapshot;
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

/**
 * Acquire a lockfile by `wx`-creating it; throws RegistryLockedError on timeout.
 * Uses `setTimeout` between retries so other tasks (including the current
 * holder's `finally` release) can run.
 */
async function acquireLockAtAsync(path: string, options: LockOptions): Promise<void> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delay = options.retryDelayMs ?? DEFAULT_DELAY_MS;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (tryWxCreate(path) === "acquired") return;
    if (attempt === retries) throw new RegistryLockedError(path);
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

function writeSnapshot(anchor: string, snapshot: RegistrySnapshot): void {
  writeFileSync(registryFile(anchor), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
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

/**
 * Serialize shared-instance lifecycle operations (lazy start, teardown) across
 * processes. Held over an async callback so the driver's binary probe + spawn
 * can both run inside the critical section — two simultaneous `devtrees up`s
 * therefore see a consistent "is it already running?" answer and at most one
 * goes on to start the shared instance (PRD US-32 extended to shared).
 *
 * This is a separate lockfile from the allocation registry's: the registry
 * lock is held for short, sync read-modify-writes, while the lifecycle lock
 * may briefly cover spawning a child process.
 */
export async function withSharedLock<T>(
  anchor: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  mkdirSync(devtreesDir(anchor), { recursive: true });
  const path = sharedLockFile(anchor);
  await acquireLockAtAsync(path, options);
  try {
    return await fn();
  } finally {
    releaseLockAt(path);
  }
}
