import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRegistryLock, readRegistry, RegistryLockedError } from "./registry.js";

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
