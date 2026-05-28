/**
 * `prune` — unit tests.
 *
 * Pure reconciliation logic: given the instances devtrees thinks exist
 * (from socket discovery) and the worktree ids git reports as live, decide
 * which instances are orphans. Devtrees does not manage git worktrees
 * (CONTEXT.md "Devtrees"), so `git worktree list` is the source of truth
 * (issue #9 acceptance).
 *
 * The shared instance is never an orphan — it is anchored at the git common
 * dir, not at any particular worktree, and its lifecycle is decoupled from
 * the worktrees that connect to it (CONTEXT.md "Shared instance").
 */

import { describe, expect, it } from "vite-plus/test";
import { findOrphans, parseWorktreeIds } from "./prune.js";
import type { InstanceInfo } from "./instances.js";
import { SHARED_INSTANCE_ID } from "./paths.js";

/** Compact builder for a discovered instance — keeps the test bodies declarative. */
function instance(
  id: string,
  kind: "worktree" | "shared" = "worktree",
  status: "running" | "stale" = "running",
): InstanceInfo {
  return {
    id,
    kind,
    status,
    socketPath: `/anchor/devtrees/run/${id}.sock`,
    ports: {},
    blockBase: undefined,
  };
}

describe("findOrphans", () => {
  it("returns an empty list when every worktree instance still has a live worktree", () => {
    const instances = [instance("login"), instance("billing")];
    const liveIds = new Set(["login", "billing"]);
    expect(findOrphans(instances, liveIds)).toEqual([]);
  });

  it("flags a worktree instance whose id is not in the live set as an orphan", () => {
    const instances = [instance("login"), instance("billing")];
    const liveIds = new Set(["login"]);
    const orphans = findOrphans(instances, liveIds);
    expect(orphans.map((o) => o.id)).toEqual(["billing"]);
  });

  it("never flags the shared instance as an orphan, even when liveIds is empty", () => {
    // The shared instance is anchored at the git common dir, not at any
    // worktree (CONTEXT.md "Anchor"): it must survive a prune even if every
    // worktree has been removed.
    const instances = [instance(SHARED_INSTANCE_ID, "shared")];
    const liveIds = new Set<string>();
    expect(findOrphans(instances, liveIds)).toEqual([]);
  });

  it("flags stale worktree instances whose worktrees are gone (the typical orphan)", () => {
    // The motivating case: an instance whose process-compose has already
    // crashed (status=stale) AND whose worktree was removed with
    // `git worktree remove`. Prune must clean both halves up.
    const stale = instance("removed", "worktree", "stale");
    const orphans = findOrphans([stale], new Set());
    expect(orphans).toEqual([stale]);
  });

  it("flags running worktree instances whose worktrees are gone (worktree removed mid-run)", () => {
    // Acceptance: after a worktree is removed with `git worktree remove`
    // while its stack runs, prune stops the orphaned instance.
    const running = instance("removed", "worktree", "running");
    const orphans = findOrphans([running], new Set());
    expect(orphans).toEqual([running]);
  });
});

describe("parseWorktreeIds", () => {
  it("returns an empty set when given an empty porcelain block", () => {
    expect(parseWorktreeIds("")).toEqual(new Set());
  });

  it("parses each `worktree <path>` line into the slug id devtrees uses", () => {
    // `git worktree list --porcelain` separates entries by blank lines; each
    // entry's first line is `worktree <abs path>`. devtrees keys instances by
    // the slug of that path's basename (see `anchor.ts`).
    const porcelain = [
      "worktree /repo/main",
      "HEAD deadbeef",
      "branch refs/heads/main",
      "",
      "worktree /repo/login",
      "HEAD cafef00d",
      "branch refs/heads/login",
      "",
      "worktree /repo/billing",
      "HEAD f00dface",
      "branch refs/heads/billing",
      "",
    ].join("\n");
    expect(parseWorktreeIds(porcelain)).toEqual(new Set(["main", "login", "billing"]));
  });

  it("slugifies worktree paths the same way the anchor resolver does", () => {
    // A path with capitals and punctuation collapses to the same slug shape
    // `resolveAnchor` produces, so a worktree at `/repo/Feature_Branch.2`
    // matches its instance id `feature-branch-2`.
    const porcelain = ["worktree /repo/Feature_Branch.2", "HEAD x", ""].join("\n");
    expect(parseWorktreeIds(porcelain)).toEqual(new Set(["feature-branch-2"]));
  });

  it("ignores `worktree` lines whose path is empty or whitespace", () => {
    // Defensive — shouldn't happen in practice but we don't want a bad entry
    // to become a phantom live id that masks an orphan.
    const porcelain = ["worktree   ", "", "worktree /repo/login", "HEAD x", ""].join("\n");
    expect(parseWorktreeIds(porcelain)).toEqual(new Set(["login"]));
  });
});
