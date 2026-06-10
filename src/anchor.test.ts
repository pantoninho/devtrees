import { describe, expect, it } from "vite-plus/test";
import { deriveWorktreeId, resolveAnchor, type GitProbe } from "./anchor.js";

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
  it("resolves anchor, worktree root and the derived worktree id in a normal repo", () => {
    const git = probe({
      commonDir: "/home/me/proj/.git",
      topLevel: "/home/me/proj-worktrees/login",
    });
    const anchor = resolveAnchor("/home/me/proj-worktrees/login/src", git);
    expect(anchor).toEqual({
      anchor: "/home/me/proj/.git",
      worktreeRoot: "/home/me/proj-worktrees/login",
      worktreeId: deriveWorktreeId("/home/me/proj-worktrees/login"),
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
    expect(anchor.worktreeId).toBe(deriveWorktreeId("/home/me/proj.git/worktrees/feature-x"));
  });

  it("resolves the git-common-dir to an absolute path", () => {
    const git = probe({ commonDir: ".git", topLevel: "/home/me/proj" });
    expect(resolveAnchor("/home/me/proj", git).anchor).toBe("/home/me/proj/.git");
  });
});

describe("deriveWorktreeId", () => {
  it("keeps the human-readable slug of the basename as the id's prefix", () => {
    expect(deriveWorktreeId("/repo/wt/login")).toMatch(/^login-[0-9a-f]{8}$/);
  });

  it("slugifies awkward characters in the basename", () => {
    expect(deriveWorktreeId("/r/wt/Feature Branch #2")).toMatch(/^feature-branch-2-[0-9a-f]{8}$/);
  });

  it("is stable across invocations for the same path", () => {
    expect(deriveWorktreeId("/repo/wt/login")).toBe(deriveWorktreeId("/repo/wt/login"));
  });

  it("ignores trailing path separators", () => {
    expect(deriveWorktreeId("/repo/wt/login/")).toBe(deriveWorktreeId("/repo/wt/login"));
  });

  it("gives two worktrees with the same basename at different paths distinct ids", () => {
    const a = deriveWorktreeId("/home/me/proj-worktrees/login");
    const b = deriveWorktreeId("/tmp/elsewhere/login");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^login-/);
    expect(b).toMatch(/^login-/);
  });

  it("keeps `feature.x` and `feature-x` siblings from aliasing each other", () => {
    // Both basenames slug to `feature-x`; the path hash must disambiguate.
    expect(deriveWorktreeId("/repo/wt/feature.x")).not.toBe(deriveWorktreeId("/repo/wt/feature-x"));
  });

  it("never produces the reserved `shared` stem, even for a worktree named `shared`", () => {
    const id = deriveWorktreeId("/repo/wt/shared");
    expect(id).not.toBe("shared");
    expect(id).toMatch(/^shared-[0-9a-f]{8}$/);
  });

  it("falls back to a non-empty id when the basename slugs to nothing", () => {
    const id = deriveWorktreeId("/repo/wt/---");
    expect(id).toMatch(/^wt-[0-9a-f]{8}$/);
  });
});
