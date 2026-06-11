import { describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredHash, writeStoredHash, deleteStoredHash } from "./hashes.js";
import { RegistryLockedError } from "./registry.js";

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

  it("releases hashes.lock and leaves no temp files after a write", () => {
    const anchor = tmpAnchor();
    try {
      writeStoredHash(anchor, "login", "x");
      deleteStoredHash(anchor, "login");
      const entries = readdirSync(join(anchor, "devtrees"));
      expect(entries).not.toContain("hashes.lock");
      expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("refuses to write while hashes.lock is held by a live process", () => {
    const anchor = tmpAnchor();
    try {
      mkdirSync(join(anchor, "devtrees"), { recursive: true });
      writeFileSync(join(anchor, "devtrees", "hashes.lock"), `${process.pid}\n`, { flag: "wx" });
      expect(() => writeStoredHash(anchor, "login", "x", { retries: 0 })).toThrow(
        RegistryLockedError,
      );
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("steals hashes.lock when its recorded holder pid is dead", () => {
    const anchor = tmpAnchor();
    try {
      mkdirSync(join(anchor, "devtrees"), { recursive: true });
      const dead = spawnSync(process.execPath, ["-e", ""]);
      if (dead.pid === undefined) throw new Error("could not spawn throwaway process");
      writeFileSync(join(anchor, "devtrees", "hashes.lock"), `${dead.pid}\n`, { flag: "wx" });

      writeStoredHash(anchor, "login", "x", { retries: 0 });
      expect(readStoredHash(anchor, "login")).toBe("x");
      expect(existsSync(join(anchor, "devtrees", "hashes.lock"))).toBe(false);
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
