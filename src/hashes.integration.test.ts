/**
 * Integration: real cross-process locking for the stored-hash store.
 *
 * Forks N child workers that each write a batch of distinct hash entries via
 * `writeStoredHash`. The store is a whole-file read-modify-write: without a
 * lock, two concurrent `up`s in different worktrees interleave their
 * read/write pairs and drop each other's entries (causing spurious drift /
 * reload on the next `up`). With the lock, every written entry must survive.
 * Patterned on `registry.integration.test.ts`.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStoredHash } from "./hashes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function makeAnchor(): string {
  const dir = mkdtempSync(join(tmpdir(), "dt-hashes-int-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Source of the worker — written to a temp file at runtime so it can `import`
// the real `hashes.ts`. Each worker writes BATCH distinct keys in a loop,
// giving an unlocked read-modify-write plenty of chances to clobber siblings.
//
// The child runs plain `node` (type stripping, no vite resolver), so the
// NodeNext-style `./registry.js` specifier inside `hashes.ts` would not
// resolve; a sync resolve hook retries failed `.js` specifiers as `.ts`.
const WORKER_SOURCE = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context);
      throw err;
    }
  },
});

const { writeStoredHash } = await import(${JSON.stringify(
  fileURLToPath(new URL("./hashes.ts", import.meta.url)),
)});

const [, , anchor, prefix, batchStr] = process.argv;
const batch = Number(batchStr);

for (let i = 0; i < batch; i++) {
  writeStoredHash(anchor, prefix + "-" + i, "hash-" + prefix + "-" + i);
}
`;

function runWorker(
  workerPath: string,
  anchor: string,
  prefix: string,
  batch: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, anchor, prefix, String(batch)], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker '${prefix}' exited ${code}`));
    });
  });
}

describe("stored hashes — integration", () => {
  it("concurrent hash writes from N worker processes all persist", async () => {
    const anchor = makeAnchor();
    const BATCH = 50;

    const workerPath = join(anchor, "worker.mjs");
    execFileSync(process.execPath, [
      "-e",
      `import('node:fs').then(({writeFileSync}) => writeFileSync(${JSON.stringify(workerPath)}, ${JSON.stringify(WORKER_SOURCE)}))`,
    ]);

    const prefixes = ["alpha", "bravo", "charlie", "delta", "echo"];
    await Promise.all(prefixes.map((p) => runWorker(workerPath, anchor, p, BATCH)));

    // Every entry written by every worker must survive — proof that no
    // read-modify-write clobbered a sibling's update.
    for (const prefix of prefixes) {
      for (let i = 0; i < BATCH; i++) {
        expect(readStoredHash(anchor, `${prefix}-${i}`)).toBe(`hash-${prefix}-${i}`);
      }
    }
  }, 20000);
});
