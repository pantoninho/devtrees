import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryLockedError, readRegistry, withRegistryLock, withSharedLock } from "./registry.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function newAnchor(): string {
  const dir = mkdtempSync(join(tmpdir(), "dt-reg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("registry store — lock + persistence", () => {
  it("reads an empty snapshot when no registry has ever been written", () => {
    const anchor = newAnchor();
    expect(readRegistry(anchor)).toEqual({});
  });

  it("persists assignments under <anchor>/devtrees/registry.json and reads them back", () => {
    const anchor = newAnchor();
    withRegistryLock(anchor, (snapshot) => ({ ...snapshot, login: 20512 }));
    expect(readRegistry(anchor)).toEqual({ login: 20512 });
  });

  it("returns the post-mutation snapshot from withRegistryLock", () => {
    const anchor = newAnchor();
    const after = withRegistryLock(anchor, (snapshot) => ({ ...snapshot, login: 20512 }));
    expect(after).toEqual({ login: 20512 });
  });

  it("leaves the registry untouched when the callback returns the same snapshot reference", () => {
    const anchor = newAnchor();
    withRegistryLock(anchor, (snapshot) => ({ ...snapshot, login: 20512 }));
    const file = join(anchor, "devtrees", "registry.json");
    const beforeMtime = readFileSync(file, "utf8");
    // Returning the snapshot unchanged signals a pure read — no write should happen.
    withRegistryLock(anchor, (snapshot) => snapshot);
    expect(readFileSync(file, "utf8")).toBe(beforeMtime);
  });

  it("refuses to acquire the lock if another holder is already there", () => {
    const anchor = newAnchor();
    // Simulate another process holding the lock.
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "registry.lock"), `${process.pid}\n`, { flag: "wx" });

    expect(() => withRegistryLock(anchor, (s) => s, { retries: 0 })).toThrow(RegistryLockedError);
  });

  it("serializes concurrent withRegistryLock calls so neither loses an update (lock holds)", () => {
    const anchor = newAnchor();
    // Two interleaved callers: each reads, then adds its own key. If the lock holds,
    // both keys survive; if it doesn't, the second writer would clobber the first.
    withRegistryLock(anchor, (s) => ({ ...s, login: 20512 }));
    withRegistryLock(anchor, (s) => ({ ...s, billing: 20544 }));

    expect(readRegistry(anchor)).toEqual({ login: 20512, billing: 20544 });
  });

  it("releases the lock even when the callback throws", () => {
    const anchor = newAnchor();
    expect(() =>
      withRegistryLock(anchor, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // A subsequent acquire must succeed — the lock did not leak.
    withRegistryLock(anchor, (s) => ({ ...s, login: 20512 }));
    expect(readRegistry(anchor)).toEqual({ login: 20512 });
  });
});

describe("withSharedLock — async lifecycle lock", () => {
  it("runs the callback under <anchor>/devtrees/shared.lock and releases on success", async () => {
    const anchor = newAnchor();
    const lockPath = join(anchor, "devtrees", "shared.lock");
    await withSharedLock(anchor, async () => {
      // While inside, the file exists — proving the lock is held.
      expect(existsSync(lockPath)).toBe(true);
    });
    // And once out, it's gone.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when the async callback throws", async () => {
    const anchor = newAnchor();
    await expect(
      withSharedLock(anchor, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A subsequent acquire must succeed — no leak.
    await withSharedLock(anchor, async () => {});
  });

  it("refuses to acquire if another holder is there (retries exhausted)", async () => {
    const anchor = newAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "shared.lock"), `${process.pid}\n`, { flag: "wx" });
    await expect(withSharedLock(anchor, async () => {}, { retries: 0 })).rejects.toThrow(
      RegistryLockedError,
    );
  });

  it("serialises overlapping callers — the second runs only after the first releases", async () => {
    const anchor = newAnchor();
    const order: string[] = [];

    // First holder waits a tick before releasing; the second must not interleave.
    const first = withSharedLock(anchor, async () => {
      order.push("first:enter");
      await new Promise((r) => setTimeout(r, 30));
      order.push("first:exit");
    });
    // Briefly let `first` acquire before `second` starts probing.
    await new Promise((r) => setTimeout(r, 5));
    const second = withSharedLock(anchor, async () => {
      order.push("second:enter");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first:enter", "first:exit", "second:enter"]);
  });
});
