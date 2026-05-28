import { describe, expect, it } from "vite-plus/test";
import { allocateBlock, type AllocatorOptions } from "./allocator.js";

const OPTS: AllocatorOptions = { portBase: 20000, blockSize: 32 };

describe("port allocator", () => {
  it("places a block deterministically by hashing the worktree id", () => {
    const a = allocateBlock("login", {}, OPTS, () => true);
    const b = allocateBlock("login", {}, OPTS, () => true);
    expect(a.base).toBe(b.base);
    expect(a.base).toBeGreaterThanOrEqual(20000);
    expect((a.base - 20000) % 32).toBe(0);
  });

  it("gives different worktrees different blocks", () => {
    const a = allocateBlock("login", {}, OPTS, () => true);
    const b = allocateBlock("billing", {}, OPTS, () => true);
    expect(a.base).not.toBe(b.base);
  });

  it("reuses a previously persisted block for the same worktree (stable across restarts)", () => {
    const snapshot = { login: 20512 };
    const block = allocateBlock("login", snapshot, OPTS, () => {
      throw new Error("must not probe when a block is already registered");
    });
    expect(block.base).toBe(20512);
  });

  it("probes past a block that collides with another worktree's registered block", () => {
    // Force a hash collision by registering whatever 'login' would naturally pick.
    const natural = allocateBlock("login", {}, OPTS, () => true).base;
    const snapshot = { other: natural };
    const block = allocateBlock("login", snapshot, OPTS, () => true);
    expect(block.base).toBe(natural + 32);
  });

  it("probes past an in-use port reported by the injected probe", () => {
    const natural = allocateBlock("login", {}, OPTS, () => true).base;
    const isFree = (port: number) => port < natural || port >= natural + 32;
    const block = allocateBlock("login", {}, OPTS, isFree);
    expect(block.base).toBe(natural + 32);
  });

  it("keeps every allocated port within the valid TCP range", () => {
    for (const id of ["login", "billing", "feature-x", "a", "zzz", "main", "release-2026"]) {
      const block = allocateBlock(id, {}, OPTS, () => true);
      expect(block.base).toBeGreaterThanOrEqual(20000);
      expect(block.portFor(OPTS.blockSize - 1)).toBeLessThanOrEqual(65535);
    }
  });

  it("maps named ports to fixed offsets within the block", () => {
    const block = allocateBlock("login", {}, OPTS, () => true);
    expect(block.portFor(0)).toBe(block.base);
    expect(block.portFor(1)).toBe(block.base + 1);
  });
});
