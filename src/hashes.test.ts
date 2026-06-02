import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredHash, writeStoredHash, deleteStoredHash } from "./hashes.js";

function tmpAnchor(): string {
  return mkdtempSync(join(tmpdir(), "dt-hashes-"));
}

describe("stored hashes (per-worktree, anchor-local)", () => {
  it("returns undefined when no hash has been recorded for the worktree", () => {
    const anchor = tmpAnchor();
    try {
      expect(readStoredHash(anchor, "login")).toBeUndefined();
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("round-trips a written hash through readStoredHash", () => {
    const anchor = tmpAnchor();
    try {
      writeStoredHash(anchor, "login", "deadbeef");
      expect(readStoredHash(anchor, "login")).toBe("deadbeef");
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("overwrites the stored hash for the same worktree id", () => {
    const anchor = tmpAnchor();
    try {
      writeStoredHash(anchor, "login", "old");
      writeStoredHash(anchor, "login", "new");
      expect(readStoredHash(anchor, "login")).toBe("new");
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("keeps hashes for sibling worktrees independent", () => {
    const anchor = tmpAnchor();
    try {
      writeStoredHash(anchor, "login", "aaa");
      writeStoredHash(anchor, "billing", "bbb");
      expect(readStoredHash(anchor, "login")).toBe("aaa");
      expect(readStoredHash(anchor, "billing")).toBe("bbb");
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("persists hashes inside the anchor's devtrees/ dir, never outside it", () => {
    const anchor = tmpAnchor();
    try {
      writeStoredHash(anchor, "login", "x");
      expect(existsSync(join(anchor, "devtrees", "hashes.json"))).toBe(true);
      // The file is JSON and contains the slug.
      const parsed = JSON.parse(readFileSync(join(anchor, "devtrees", "hashes.json"), "utf8"));
      expect(parsed).toEqual({ login: "x" });
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("deleteStoredHash removes one worktree's entry without touching siblings", () => {
    const anchor = tmpAnchor();
    try {
      writeStoredHash(anchor, "login", "a");
      writeStoredHash(anchor, "billing", "b");
      deleteStoredHash(anchor, "login");
      expect(readStoredHash(anchor, "login")).toBeUndefined();
      expect(readStoredHash(anchor, "billing")).toBe("b");
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });
});
