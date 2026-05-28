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

/** Read the persisted snapshot for this anchor; empty object if none exists yet. */
export function readRegistry(anchor: string): RegistrySnapshot {
  const file = registryFile(anchor);
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as RegistrySnapshot;
}

/** Synchronously sleep for `ms` milliseconds — used by the lock retry loop. */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // Atomics.wait on a shared int is the only portable, non-busy sync sleep.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  while (Date.now() < end) {
    Atomics.wait(view, 0, 0, Math.max(1, end - Date.now()));
  }
}

/** Try to acquire the lock; throws RegistryLockedError if it stays held past the retries. */
function acquireLock(anchor: string, options: LockOptions): void {
  mkdirSync(devtreesDir(anchor), { recursive: true });
  const path = lockFile(anchor);
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delay = options.retryDelayMs ?? DEFAULT_DELAY_MS;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // `wx` fails if the file already exists — atomic across POSIX processes.
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === retries) throw new RegistryLockedError(path);
      sleepSync(delay);
    }
  }
}

function releaseLock(anchor: string): void {
  try {
    unlinkSync(lockFile(anchor));
  } catch (err) {
    // Already gone is fine; anything else is a real problem.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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
 */
export function withRegistryLock(
  anchor: string,
  mutate: (snapshot: RegistrySnapshot) => RegistrySnapshot,
  options: LockOptions = {},
): RegistrySnapshot {
  acquireLock(anchor, options);
  try {
    const before = readRegistry(anchor);
    const after = mutate(before);
    if (after !== before) writeSnapshot(anchor, after);
    return after;
  } finally {
    releaseLock(anchor);
  }
}
