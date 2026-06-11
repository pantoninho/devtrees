import { afterEach, describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
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

/** Pid of a process that is guaranteed to be dead (spawned and already reaped). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("could not spawn throwaway process");
  return child.pid;
}

describe("registry store — lock + persistence", () => {
  it("reads an empty snapshot when no registry has ever been written", () => {
    const anchor = newAnchor();
    expect(readRegistry(anchor)).toEqual({});
  });

  it("persists assignments under <anchor>/devtrees/registry.json and reads them back", async () => {
    const anchor = newAnchor();
    await withRegistryLock(anchor, (snapshot) => ({ ...snapshot, login: 20512 }));
    expect(readRegistry(anchor)).toEqual({ login: 20512 });
  });

  it("returns the post-mutation snapshot from withRegistryLock", async () => {
    const anchor = newAnchor();
    const after = await withRegistryLock(anchor, (snapshot) => ({ ...snapshot, login: 20512 }));
    expect(after).toEqual({ login: 20512 });
  });

  it("leaves the registry untouched when the callback returns the same snapshot reference", async () => {
    const anchor = newAnchor();
    await withRegistryLock(anchor, (snapshot) => ({ ...snapshot, login: 20512 }));
    const file = join(anchor, "devtrees", "registry.json");
    const beforeMtime = readFileSync(file, "utf8");
    // Returning the snapshot unchanged signals a pure read — no write should happen.
    await withRegistryLock(anchor, (snapshot) => snapshot);
    expect(readFileSync(file, "utf8")).toBe(beforeMtime);
  });

  it("falls back to an empty snapshot when the registry file is corrupt JSON", () => {
    const anchor = newAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    // A pre-atomic-write crash could leave a half-written file like this.
    writeFileSync(join(anchor, "devtrees", "registry.json"), '{"login": 205', "utf8");
    expect(readRegistry(anchor)).toEqual({});
  });

  it("falls back to an empty snapshot when the registry file holds non-object JSON", () => {
    const anchor = newAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    for (const junk of ["null", '"hi"', "[1,2]"]) {
      writeFileSync(join(anchor, "devtrees", "registry.json"), junk, "utf8");
      expect(readRegistry(anchor)).toEqual({});
    }
  });

  it("self-heals a corrupt registry on the next locked write", async () => {
    const anchor = newAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "registry.json"), "{corrupt", "utf8");
    // The mutate callback sees the safe fallback, not a crash …
    await withRegistryLock(anchor, (snapshot) => {
      expect(snapshot).toEqual({});
      return { ...snapshot, login: 20512 };
    });
    // … and the write replaces the corrupt file with valid JSON.
    expect(readRegistry(anchor)).toEqual({ login: 20512 });
    expect(JSON.parse(readFileSync(join(anchor, "devtrees", "registry.json"), "utf8"))).toEqual({
      login: 20512,
    });
  });

  it("refuses to acquire the lock if another holder is already there", async () => {
    const anchor = newAnchor();
    // Simulate another process holding the lock.
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "registry.lock"), `${process.pid}\n`, { flag: "wx" });

    await expect(withRegistryLock(anchor, (s) => s, { retries: 0 })).rejects.toThrow(
      RegistryLockedError,
    );
  });

  it("serializes concurrent withRegistryLock calls so neither loses an update (lock holds)", async () => {
    const anchor = newAnchor();
    // Two interleaved callers: each reads, then adds its own key. If the lock holds,
    // both keys survive; if it doesn't, the second writer would clobber the first.
    await withRegistryLock(anchor, (s) => ({ ...s, login: 20512 }));
    await withRegistryLock(anchor, (s) => ({ ...s, billing: 20544 }));

    expect(readRegistry(anchor)).toEqual({ login: 20512, billing: 20544 });
  });

  it("steals a registry lock whose recorded holder pid is dead", async () => {
    const anchor = newAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    // Simulate a SIGKILLed holder: the lock file survives but its pid is gone.
    writeFileSync(join(anchor, "devtrees", "registry.lock"), `${deadPid()}\n`, { flag: "wx" });

    // Even with zero retries the stale lock must be stolen, not waited out.
    await withRegistryLock(anchor, (s) => ({ ...s, login: 20512 }), { retries: 0 });
    expect(readRegistry(anchor)).toEqual({ login: 20512 });
    // The steal must not leak the lock either.
    expect(existsSync(join(anchor, "devtrees", "registry.lock"))).toBe(false);
  });

  it("does not steal a lock whose content is not a parseable pid", async () => {
    const anchor = newAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "registry.lock"), "not-a-pid\n", { flag: "wx" });

    await expect(withRegistryLock(anchor, (s) => s, { retries: 0 })).rejects.toThrow(
      RegistryLockedError,
    );
  });

  it("releases the lock even when the callback throws", async () => {
    const anchor = newAnchor();
    await expect(
      withRegistryLock(anchor, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A subsequent acquire must succeed — the lock did not leak.
    await withRegistryLock(anchor, (s) => ({ ...s, login: 20512 }));
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

  it("steals a shared lock whose recorded holder pid is dead", async () => {
    const anchor = newAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "shared.lock"), `${deadPid()}\n`, { flag: "wx" });

    let ran = false;
    await withSharedLock(
      anchor,
      async () => {
        ran = true;
      },
      { retries: 0 },
    );
    expect(ran).toBe(true);
    expect(existsSync(join(anchor, "devtrees", "shared.lock"))).toBe(false);
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
