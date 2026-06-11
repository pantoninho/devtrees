/**
 * Integration: real cross-process locking and persistence.
 *
 * Forks N child workers that each acquire the registry lock, read the snapshot,
 * append their own unique key, and write it back. Without the lock the read-
 * modify-write would race and at least one writer would clobber another's
 * update; with the lock every appended key must survive. Persistence is
 * asserted by re-reading the on-disk JSON after all workers exit.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegistry } from "./registry.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function makeAnchor(): string {
  const dir = mkdtempSync(join(tmpdir(), "dt-reg-int-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Source of the worker — appended to a temp file at runtime so it can `import`
// the compiled `registry.js`. We keep it inline so the test is self-contained.
const WORKER_SOURCE = `
import { withRegistryLock } from ${JSON.stringify(
  fileURLToPath(new URL("./registry.ts", import.meta.url)),
)};

const [, , anchor, key, baseStr] = process.argv;
const base = Number(baseStr);

await withRegistryLock(anchor, (snapshot) => {
  // Sleep a few ms while holding the lock so a non-locking implementation would
  // be guaranteed to interleave with a sibling.
  const end = Date.now() + 30;
  while (Date.now() < end) {
    // busy-wait — keeps the lock held, exercises real contention
  }
  return { ...snapshot, [key]: base };
});
`;

function runWorker(workerPath: string, anchor: string, key: string, base: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, anchor, key, String(base)], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker '${key}' exited ${code}`));
    });
  });
}

// Worker for the atomic-write test: rewrites the full WIDE-key snapshot many
// times in a row so a concurrent lock-free reader gets plenty of chances to
// catch a truncated/partial file if writes are not atomic.
const REWRITER_SOURCE = `
import { withRegistryLock } from ${JSON.stringify(
  fileURLToPath(new URL("./registry.ts", import.meta.url)),
)};

const [, , anchor, widthStr, iterationsStr] = process.argv;
const width = Number(widthStr);
const iterations = Number(iterationsStr);

for (let i = 0; i < iterations; i++) {
  await withRegistryLock(anchor, () => {
    const next = {};
    for (let k = 0; k < width; k++) next["key-" + String(k).padStart(5, "0")] = 20000 + i;
    return next;
  });
}
`;

describe("registry store — integration", () => {
  it("a lock-free reader never observes a truncated/partial registry while a writer rewrites it", async () => {
    const anchor = makeAnchor();
    const WIDTH = 4000;
    const ITERATIONS = 150;

    // Seed a full-width snapshot so the reader has a complete file from t=0.
    const workerPath = join(anchor, "rewriter.mjs");
    execFileSync(process.execPath, [
      "-e",
      `import('node:fs').then(({writeFileSync}) => writeFileSync(${JSON.stringify(workerPath)}, ${JSON.stringify(REWRITER_SOURCE)}))`,
    ]);
    const seed = spawn(process.execPath, [workerPath, anchor, String(WIDTH), "1"], {
      stdio: "inherit",
    });
    await new Promise<void>((resolve, reject) => {
      seed.on("error", reject);
      seed.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`seed exited ${code}`)),
      );
    });

    // Writer child rewrites the whole snapshot ITERATIONS times while we read
    // lock-free in a tight loop. Truncate-in-place writes would let us observe
    // an empty file (0 keys) or partial JSON (parse throw); atomic rename must
    // always yield a complete snapshot of WIDTH keys.
    let writerDone = false;
    const writer = new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [workerPath, anchor, String(WIDTH), String(ITERATIONS)],
        { stdio: "inherit" },
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        writerDone = true;
        if (code === 0) resolve();
        else reject(new Error(`writer exited ${code}`));
      });
    });
    // If the reader assertion below throws, the writer rejection (killed by
    // the cleanup rmSync) must not surface as an unhandled rejection.
    writer.catch(() => {});

    let reads = 0;
    while (!writerDone) {
      const snapshot = readRegistry(anchor);
      expect(Object.keys(snapshot)).toHaveLength(WIDTH);
      reads++;
      // Yield so the child's exit event can be observed.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await writer;
    expect(reads).toBeGreaterThan(0);
  }, 30000);

  it("serializes N concurrent worker processes; every appended key survives", async () => {
    const anchor = makeAnchor();

    // Write the worker script next to the temp anchor so the path is short.
    const workerPath = join(anchor, "worker.mjs");
    execFileSync(process.execPath, [
      "-e",
      `import('node:fs').then(({writeFileSync}) => writeFileSync(${JSON.stringify(workerPath)}, ${JSON.stringify(WORKER_SOURCE)}))`,
    ]);

    const workers = [
      { key: "alpha", base: 20000 },
      { key: "bravo", base: 20032 },
      { key: "charlie", base: 20064 },
      { key: "delta", base: 20096 },
      { key: "echo", base: 20128 },
    ];

    await Promise.all(workers.map((w) => runWorker(workerPath, anchor, w.key, w.base)));

    const snapshot = readRegistry(anchor);
    // Every worker's key+base must be present — proof that no write clobbered another.
    for (const w of workers) {
      expect(snapshot[w.key]).toBe(w.base);
    }
    expect(Object.keys(snapshot)).toHaveLength(workers.length);
  }, 15000);
});
