import { describe, expect, it } from "vite-plus/test";
import { allocateBlock, type AllocatorOptions } from "./allocator.js";

const OPTS: AllocatorOptions = { portBase: 20000, blockSize: 32 };

describe("port allocator", () => {
  it("places a block deterministically by hashing the worktree id", async () => {
    const a = await allocateBlock("login", {}, OPTS, () => true);
    const b = await allocateBlock("login", {}, OPTS, () => true);
    expect(a.base).toBe(b.base);
    expect(a.base).toBeGreaterThanOrEqual(20000);
    expect((a.base - 20000) % 32).toBe(0);
  });

  it("gives different worktrees different blocks", async () => {
    const a = await allocateBlock("login", {}, OPTS, () => true);
    const b = await allocateBlock("billing", {}, OPTS, () => true);
    expect(a.base).not.toBe(b.base);
  });

  it("reuses a previously persisted block for the same worktree (stable across restarts)", async () => {
    const snapshot = { login: 20512 };
    const block = await allocateBlock("login", snapshot, OPTS, () => {
      throw new Error("must not probe when a block is already registered");
    });
    expect(block.base).toBe(20512);
  });

  it("probes past a block that collides with another worktree's registered block", async () => {
    // Force a hash collision by registering whatever 'login' would naturally pick.
    const natural = (await allocateBlock("login", {}, OPTS, () => true)).base;
    const snapshot = { other: natural };
    const block = await allocateBlock("login", snapshot, OPTS, () => true);
    expect(block.base).toBe(natural + 32);
  });

  it("probes past an in-use port reported by the injected probe", async () => {
    const natural = (await allocateBlock("login", {}, OPTS, () => true)).base;
    const isFree = (port: number) => port < natural || port >= natural + 32;
    const block = await allocateBlock("login", {}, OPTS, isFree);
    expect(block.base).toBe(natural + 32);
  });

  it("keeps every allocated port within the valid TCP range", async () => {
    for (const id of ["login", "billing", "feature-x", "a", "zzz", "main", "release-2026"]) {
      const block = await allocateBlock(id, {}, OPTS, () => true);
      expect(block.base).toBeGreaterThanOrEqual(20000);
      expect(block.portFor(OPTS.blockSize - 1)).toBeLessThanOrEqual(65535);
    }
  });

  it("maps named ports to fixed offsets within the block", async () => {
    const block = await allocateBlock("login", {}, OPTS, () => true);
    expect(block.portFor(0)).toBe(block.base);
    expect(block.portFor(1)).toBe(block.base + 1);
  });

  it("awaits an async isFree probe — a Promise<false> means 'taken', not truthy", async () => {
    // Probes that return a Promise (the new default impl is async) must be
    // awaited; treating the Promise as a truthy synchronous result would mark
    // every port as free and skip the walk-forward.
    const isFree = async (_port: number): Promise<boolean> => false;
    await expect(allocateBlock("login", {}, OPTS, isFree)).rejects.toThrow(/no free port block/);
  });
});
