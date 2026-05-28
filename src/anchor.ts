/**
 * Anchor resolver.
 *
 * Maps a working directory to the fixed locations devtrees reasons about:
 * the **anchor** (the git common dir — `<main>/.git` normally, the bare dir for
 * bare-repo layouts), the **worktree root**, a stable **worktree id** slugified
 * from the worktree path (not the branch), and whether the repo is bare. See
 * CONTEXT.md and ADR-0001.
 *
 * Git is injected as a `GitProbe` so the pure resolution logic — path joining,
 * slugification — is unit-testable without spawning git.
 */

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

/** Slugify a path's final segment into a stable, filesystem-safe worktree id. */
function slugifyWorktreeId(worktreeRoot: string): string {
  const base =
    worktreeRoot
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
    worktreeId: slugifyWorktreeId(worktreeRoot),
    isBare,
  };
}
