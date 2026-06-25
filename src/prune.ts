/**
 * Prune — reconciliation against `git worktree list`.
 *
 * Devtrees doesn't manage git worktrees (CONTEXT.md "Devtrees"). When a
 * developer runs `git worktree remove` while a stack is still up, devtrees
 * doesn't notice on its own — the instance keeps running and its anchor
 * state (control socket, derived config, registry entry) stays around.
 * `devtrees prune` is how that orphaned state is reclaimed.
 *
 * Reconciliation rule (issue #9): an instance is an **orphan** iff
 * - it is of kind `worktree`, AND
 * - its id is not in the slug set derived from `git worktree list`.
 *
 * The shared instance (kind `shared`) is never an orphan: it is anchored at
 * the git common dir, not at any single worktree, and its lifecycle is
 * decoupled from per-worktree `down` (CONTEXT.md "Shared instance",
 * ADR-0001). Tear it down explicitly with `devtrees down --shared`.
 *
 * Pure-modulo-the-parse: `findOrphans` is set arithmetic; `parseWorktreeIds`
 * turns `git worktree list --porcelain` output into the same slug shape the
 * anchor resolver produces. The orchestration that does the actual stop +
 * cleanup lives in `commands.ts` (`runPrune`).
 */

import { deriveWorktreeId } from "./anchor.js";
import type { InstanceInfo } from "./instances.js";
import { SHARED_REGISTRY_KEY } from "./paths.js";

/**
 * Filter the discovered instance list down to the orphans: worktree-kind
 * instances whose ids are not in the set of currently-live worktree slugs.
 * Pure — no I/O, no side effects, deterministic order (input order preserved).
 */
export function findOrphans(
  instances: ReadonlyArray<InstanceInfo>,
  liveWorktreeIds: ReadonlySet<string>,
): InstanceInfo[] {
  return instances.filter((inst) => inst.kind === "worktree" && !liveWorktreeIds.has(inst.id));
}

/**
 * Find the registry keys that name a dead reservation: a worktree that no
 * longer exists, leaking its allocation-registry entry (and derived config)
 * with no live control socket to be discovered (issue #142).
 *
 * This is the socket-independent complement to `findOrphans`: the registry is
 * keyed by the same ids `parseWorktreeIds` produces, so any key that is not a
 * live worktree id is a leak — *except* the reserved shared key, which is
 * intentionally retained across teardown (#51) and is not a worktree. Ids in
 * `alreadyDiscovered` (the socket-keyed orphans) are skipped so a double-keyed
 * orphan is reclaimed and reported exactly once. Pure — no I/O, deterministic
 * order (registry key order preserved).
 */
export function findDeadReservations(
  registryKeys: Iterable<string>,
  liveWorktreeIds: ReadonlySet<string>,
  alreadyDiscovered: ReadonlySet<string>,
): string[] {
  const dead: string[] = [];
  for (const id of registryKeys) {
    if (id === SHARED_REGISTRY_KEY) continue;
    if (liveWorktreeIds.has(id)) continue;
    if (alreadyDiscovered.has(id)) continue;
    dead.push(id);
  }
  return dead;
}

/**
 * Parse `git worktree list --porcelain` into the set of ids devtrees uses to
 * key instances. Each entry's first line is `worktree <abs path>`; we run the
 * path through the same `deriveWorktreeId` `resolveAnchor` does, so a worktree
 * at `/repo/login` lands as `login-<hash>` — the same id its instance was
 * registered under at `up` time.
 */
export function parseWorktreeIds(porcelain: string): Set<string> {
  const ids = new Set<string>();
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (path === "") continue;
    ids.add(deriveWorktreeId(path));
  }
  return ids;
}
