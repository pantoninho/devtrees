/**
 * Shared tmp-repo factory used by the e2e and real-pc.smoke suites.
 *
 * Lives outside `src/` because it is test-only scaffolding, not production
 * code. Pulled out of `src/e2e.test.ts` (where it lived inline) so the new
 * `src/real-pc.smoke.test.ts` doesn't clone the same logic — fallow flagged
 * the duplication as a regression (issue #60).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Unix domain socket paths are capped (~104 bytes on macOS, ~108 on Linux).
 * The control socket lives at `<git-common-dir>/devtrees/run/<id>.sock`, so
 * the temp repo must be rooted shallowly enough that the socket path fits.
 * The OS tmpdir (e.g. macOS `/var/folders/.../T`) is already deep enough to
 * overflow, so we use a short, fixed base dir instead.
 */
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

/** Run `git` in `cwd`. Trims the output so callers don't have to. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export interface TmpRepo {
  readonly root: string;
  readonly main: string;
  readonly worktrees: Record<string, string>;
}

/**
 * Build a fresh temp repo with `main/` initialised and committed, plus N linked
 * worktrees. Returns `{ root, main, worktrees }`. The caller is responsible for
 * registering an `rm` cleanup against `root`.
 */
export function makeRepo(prefix: string, worktreeNames: ReadonlyArray<string>): TmpRepo {
  const root = mkdtempSync(join(SHORT_TMP, prefix));
  const main = join(root, "main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q");
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "README.md"), "x");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const worktrees: Record<string, string> = {};
  for (const name of worktreeNames) {
    const path = join(root, name);
    git(main, "worktree", "add", "-q", path, "-b", name);
    worktrees[name] = path;
  }
  return { root, main, worktrees };
}
