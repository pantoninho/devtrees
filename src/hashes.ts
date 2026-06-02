/**
 * Stored-hash store — companion to the allocation registry, used for drift
 * detection in `runUp` (issue #31).
 *
 * Persists `<worktreeId> -> stack-hash` at `<anchor>/devtrees/hashes.json`,
 * separate from `registry.json` so the port allocator stays a pure
 * `id -> base` map. A second `up` reads back the hash to decide noop /
 * reload / `CONFIG_DRIFT`. Like the rest of the anchor state, it lives
 * inside the git common dir so it survives no-`.gitignore`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type HashMap = Readonly<Record<string, string>>;

function hashesFile(anchor: string): string {
  return join(anchor, "devtrees", "hashes.json");
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
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  writeFileSync(hashesFile(anchor), `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

/** Read the recorded hash for `worktreeId`, or `undefined` if none. */
export function readStoredHash(anchor: string, worktreeId: string): string | undefined {
  return readAll(anchor)[worktreeId];
}

/** Persist (or overwrite) the hash for `worktreeId`. */
export function writeStoredHash(anchor: string, worktreeId: string, hash: string): void {
  writeAll(anchor, { ...readAll(anchor), [worktreeId]: hash });
}

/** Remove the recorded hash for `worktreeId`. No-op when absent. */
export function deleteStoredHash(anchor: string, worktreeId: string): void {
  const all = readAll(anchor);
  if (all[worktreeId] === undefined) return;
  const { [worktreeId]: _drop, ...rest } = all;
  void _drop;
  writeAll(anchor, rest);
}
