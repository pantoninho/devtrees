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
import { deriveWorktreeId } from "./anchor.js";
import { findDeadReservations, findOrphans, parseWorktreeIds } from "./prune.js";
import type { InstanceInfo } from "./instances.js";
import { SHARED_INSTANCE_ID, SHARED_REGISTRY_KEY } from "./paths.js";

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
    services: [],
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

  it("reclaims a worktree directory literally named `shared` once it is removed (issue #82)", () => {
    // The path-hash suffix keeps its id off the reserved `shared` stem, so it
    // is a plain worktree instance: live while git lists it, orphan after.
    const id = deriveWorktreeId("/repo/wt/shared");
    expect(id).not.toBe(SHARED_INSTANCE_ID);
    const inst = instance(id);
    expect(findOrphans([inst], new Set([id]))).toEqual([]);
    expect(findOrphans([inst], new Set())).toEqual([inst]);
  });
});

describe("findDeadReservations", () => {
  // The socket-independent complement to findOrphans (issue #142): registry
  // keys for worktrees that are gone but left no socket to be discovered.
  const none = new Set<string>();

  it("flags a registry key whose worktree is no longer live", () => {
    expect(findDeadReservations(["login", "billing"], new Set(["login"]), none)).toEqual([
      "billing",
    ]);
  });

  it("returns nothing when every registry key is a live worktree", () => {
    expect(findDeadReservations(["login", "billing"], new Set(["login", "billing"]), none)).toEqual(
      [],
    );
  });

  it("never flags the reserved shared key, even when it has no live worktree", () => {
    // __shared__ is intentionally retained across teardown (#51) and is not a
    // worktree, so it must survive prune regardless of liveness.
    expect(findDeadReservations([SHARED_REGISTRY_KEY, "login"], new Set(["login"]), none)).toEqual(
      [],
    );
    expect(findDeadReservations([SHARED_REGISTRY_KEY], none, none)).toEqual([]);
  });

  it("skips ids already discovered via socket so a double-keyed orphan is reported once", () => {
    // An orphan removed while still running is both socket-discovered AND a
    // dead registry key; the registry pass must not re-report it.
    const discovered = new Set(["removed"]);
    expect(findDeadReservations(["removed", "stale-only"], none, discovered)).toEqual([
      "stale-only",
    ]);
  });
});

describe("parseWorktreeIds", () => {
  it("returns an empty set when given an empty porcelain block", () => {
    expect(parseWorktreeIds("")).toEqual(new Set());
  });

  it("parses each `worktree <path>` line into the id devtrees uses", () => {
    // `git worktree list --porcelain` separates entries by blank lines; each
    // entry's first line is `worktree <abs path>`. devtrees keys instances by
    // the same `deriveWorktreeId` the anchor resolver applies (see `anchor.ts`).
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
    expect(parseWorktreeIds(porcelain)).toEqual(
      new Set([
        deriveWorktreeId("/repo/main"),
        deriveWorktreeId("/repo/login"),
        deriveWorktreeId("/repo/billing"),
      ]),
    );
  });

  it("derives ids from worktree paths the same way the anchor resolver does", () => {
    // A path with capitals and punctuation collapses to the same id shape
    // `resolveAnchor` produces, so a worktree at `/repo/Feature_Branch.2`
    // matches the instance id it was registered under at `up` time.
    const porcelain = ["worktree /repo/Feature_Branch.2", "HEAD x", ""].join("\n");
    expect(parseWorktreeIds(porcelain)).toEqual(
      new Set([deriveWorktreeId("/repo/Feature_Branch.2")]),
    );
  });

  it("keeps same-basename worktrees at different paths as distinct live ids", () => {
    // The collision the path-hash suffix exists to prevent (issue #82): two
    // worktrees both named `login` must not collapse into one registry entry.
    const porcelain = ["worktree /repo/login", "", "worktree /elsewhere/login", ""].join("\n");
    expect(parseWorktreeIds(porcelain).size).toBe(2);
  });

  it("ignores `worktree` lines whose path is empty or whitespace", () => {
    // Defensive — shouldn't happen in practice but we don't want a bad entry
    // to become a phantom live id that masks an orphan.
    const porcelain = ["worktree   ", "", "worktree /repo/login", "HEAD x", ""].join("\n");
    expect(parseWorktreeIds(porcelain)).toEqual(new Set([deriveWorktreeId("/repo/login")]));
  });
});
