import { describe, expect, it } from "vite-plus/test";
import { resolveAnchor, type GitProbe } from "./anchor.js";

/** Build a fake git probe from canned `git rev-parse` answers. */
function probe(answers: { commonDir: string; topLevel: string; isBare?: string }): GitProbe {
  return (args) => {
    if (args.includes("--git-common-dir")) return answers.commonDir;
    if (args.includes("--show-toplevel")) return answers.topLevel;
    if (args.includes("--is-bare-repository")) return answers.isBare ?? "false";
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

describe("anchor resolver", () => {
  it("resolves anchor, worktree root and a slugified id in a normal repo", () => {
    const git = probe({
      commonDir: "/home/me/proj/.git",
      topLevel: "/home/me/proj-worktrees/login",
    });
    const anchor = resolveAnchor("/home/me/proj-worktrees/login/src", git);
    expect(anchor).toEqual({
      anchor: "/home/me/proj/.git",
      worktreeRoot: "/home/me/proj-worktrees/login",
      worktreeId: "login",
      isBare: false,
    });
  });

  it("anchors at the bare dir in a bare-repo worktree layout", () => {
    const git = probe({
      commonDir: "/home/me/proj.git",
      topLevel: "/home/me/proj.git/worktrees/feature-x",
      isBare: "true",
    });
    const anchor = resolveAnchor("/home/me/proj.git/worktrees/feature-x", git);
    expect(anchor.anchor).toBe("/home/me/proj.git");
    expect(anchor.isBare).toBe(true);
    expect(anchor.worktreeId).toBe("feature-x");
  });

  it("derives a stable id from the path, slugifying awkward characters", () => {
    const git = probe({
      commonDir: "/r/.git",
      topLevel: "/r/wt/Feature Branch #2",
    });
    expect(resolveAnchor("/r/wt/Feature Branch #2", git).worktreeId).toBe("feature-branch-2");
  });

  it("resolves the git-common-dir to an absolute path", () => {
    const git = probe({ commonDir: ".git", topLevel: "/home/me/proj" });
    expect(resolveAnchor("/home/me/proj", git).anchor).toBe("/home/me/proj/.git");
  });
});
