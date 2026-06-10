/**
 * Anchor resolver.
 *
 * Maps a working directory to the fixed locations devtrees reasons about:
 * the **anchor** (the git common dir — `<main>/.git` normally, the bare dir for
 * bare-repo layouts), the **worktree root**, a stable **worktree id** derived
 * from the worktree path (not the branch), and whether the repo is bare. See
 * CONTEXT.md and ADR-0001.
 *
 * Git is injected as a `GitProbe` so the pure resolution logic — path joining,
 * id derivation — is unit-testable without spawning git.
 */

import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

/** Run `git rev-parse <args...>` from the working dir and return trimmed stdout. */
export type GitProbe = (args: ReadonlyArray<string>) => string;

export interface Anchor {
  /** The git common dir, absolute: `<main>/.git` normally, the bare dir if bare. */
  readonly anchor: string;
  /** Absolute path of this worktree's top level. */
  readonly worktreeRoot: string;
  /** Stable slug derived from the worktree path, used to key allocation & sockets. */
  readonly worktreeId: string;
  readonly isBare: boolean;
}

/** Hex chars of the path hash appended to the slug. 8 is plenty per repo. */
const PATH_HASH_LENGTH = 8;

/**
 * Derive a stable, filesystem-safe, collision-proof worktree id from the
 * absolute worktree path: a human-readable slug of the path's basename,
 * suffixed with a short hash of the full path (issue #82).
 *
 * The hash suffix is what makes the id collision-proof:
 * - two worktrees with the same basename at different paths get distinct ids;
 * - basenames that slug identically (`feature.x` vs `feature-x`) no longer
 *   alias each other;
 * - a worktree id always carries a `-<hash>` suffix, so it can never equal the
 *   reserved `shared` stem (`SHARED_INSTANCE_ID` in `paths.ts`) and alias the
 *   shared instance's socket/config paths.
 *
 * Exported so `prune` can derive ids from `git worktree list --porcelain`
 * paths the same way an instance's id was derived at `up` time — they must
 * match exactly or prune would false-positive every worktree as an orphan.
 */
export function deriveWorktreeId(worktreeRoot: string): string {
  const normalized = worktreeRoot.replace(/[/\\]+$/, "");
  const base = normalized.split(/[/\\]/).pop() ?? "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, PATH_HASH_LENGTH);
  return `${slug === "" ? "wt" : slug}-${hash}`;
}

export function resolveAnchor(cwd: string, git: GitProbe): Anchor {
  const commonDir = git(["rev-parse", "--git-common-dir"]);
  const worktreeRoot = git(["rev-parse", "--show-toplevel"]);
  const isBare = git(["rev-parse", "--is-bare-repository"]) === "true";

  // `--git-common-dir` is reported relative to cwd when the repo is local.
  const anchor = isAbsolute(commonDir) ? commonDir : resolve(join(cwd, commonDir));

  return {
    anchor,
    worktreeRoot,
    worktreeId: deriveWorktreeId(worktreeRoot),
    isBare,
  };
}
