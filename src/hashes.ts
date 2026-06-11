/**
 * Stored-hash store — companion to the allocation registry, used for drift
 * detection in `runUp` (issue #31).
 *
 * Persists `<worktreeId> -> stack-hash` at `<anchor>/devtrees/hashes.json`,
 * separate from `registry.json` so the port allocator stays a pure
 * `id -> base` map. A second `up` reads back the hash to decide noop /
 * reload / `CONFIG_DRIFT`. Like the rest of the anchor state, it lives
 * inside the git common dir so it survives no-`.gitignore`.
 *
 * Crash-safety (issue #85): mutations are whole-file read-modify-writes, so
 * they run under their own `hashes.lock` (sync acquire — the critical section
 * never awaits) and persist via temp-file + atomic rename. Two concurrent
 * `up`s in different worktrees therefore cannot drop each other's entries,
 * and a lock-free reader never observes a truncated file.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync, writeAtomic, type LockOptions } from "./registry.js";

type HashMap = Readonly<Record<string, string>>;

function hashesFile(anchor: string): string {
  return join(anchor, "devtrees", "hashes.json");
}

function lockFile(anchor: string): string {
  return join(anchor, "devtrees", "hashes.lock");
}

function readAll(anchor: string): HashMap {
  const file = hashesFile(anchor);
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as HashMap;
  } catch {
    return {};
  }
}

function writeAll(anchor: string, map: HashMap): void {
  writeAtomic(hashesFile(anchor), `${JSON.stringify(map, null, 2)}\n`);
}

/**
 * Serialize a read-modify-write of the hash map under `hashes.lock`. Follows
 * `withRegistryLock`'s convention: returning the same reference signals a
 * pure read and skips the write.
 */
function mutateAll(anchor: string, mutate: (all: HashMap) => HashMap, options: LockOptions): void {
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  withFileLockSync(
    lockFile(anchor),
    () => {
      const before = readAll(anchor);
      const after = mutate(before);
      if (after !== before) writeAll(anchor, after);
    },
    options,
  );
}

/** Read the recorded hash for `worktreeId`, or `undefined` if none. */
export function readStoredHash(anchor: string, worktreeId: string): string | undefined {
  return readAll(anchor)[worktreeId];
}

/** Persist (or overwrite) the hash for `worktreeId`. */
export function writeStoredHash(
  anchor: string,
  worktreeId: string,
  hash: string,
  options: LockOptions = {},
): void {
  mutateAll(anchor, (all) => ({ ...all, [worktreeId]: hash }), options);
}

/** Remove the recorded hash for `worktreeId`. No-op when absent. */
export function deleteStoredHash(
  anchor: string,
  worktreeId: string,
  options: LockOptions = {},
): void {
  mutateAll(
    anchor,
    (all) => {
      if (all[worktreeId] === undefined) return all; // absent — pure read, no write
      const { [worktreeId]: _drop, ...rest } = all;
      void _drop;
      return rest;
    },
    options,
  );
}
