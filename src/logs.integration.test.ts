/**
 * Integration: `streamLogs` against a stub process-compose.
 *
 * The driver's spawning + line-buffering path is unit-tested with a fake
 * SpawnedProcess; this test wires the real `spawn` to the test stub at
 * `test/stub-process-compose.mjs` so we cover argv construction, stdio piping,
 * and end-of-stream semantics through a real child process. The stub reads the
 * canned log lines from `${socketPath}.${service}.log`.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDriver, type LogEvent } from "./driver.js";

const STUB = fileURLToPath(new URL("../test/stub-process-compose.mjs", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dt-logs-int-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stubDriver() {
  return createDriver({
    binary: process.execPath,
    prefixArgs: [STUB],
    exists: () => Promise.resolve(true),
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function collect(it: AsyncIterable<LogEvent>): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("streamLogs — integration against stub process-compose", () => {
  it("emits a LogEvent for every line the stub writes on stdout", async () => {
    const dir = tmpDir();
    const socket = join(dir, "login.sock");
    writeFileSync(`${socket}.web.log`, ["alpha", "beta", "gamma"].join("\n"));

    const events = await collect(stubDriver().streamLogs(socket, { service: "web" }));
    expect(events.map((e) => e.line)).toEqual(["alpha", "beta", "gamma"]);
    for (const ev of events) {
      expect(ev.service).toBe("web");
      expect(ev.stream).toBe("stdout");
      // ts must be a parseable ISO string.
      expect(Number.isNaN(Date.parse(ev.ts))).toBe(false);
    }
  });

  it("forwards --tail=N (`-n N`) so the stub trims to the last N lines", async () => {
    const dir = tmpDir();
    const socket = join(dir, "login.sock");
    writeFileSync(`${socket}.web.log`, ["1", "2", "3", "4", "5"].join("\n"));

    const events = await collect(stubDriver().streamLogs(socket, { service: "web", tail: 2 }));
    expect(events.map((e) => e.line)).toEqual(["4", "5"]);
  });

  it("an abort kills a following child while it waits for a line (#282)", async () => {
    const dir = tmpDir();
    const socket = join(dir, "login.sock");
    writeFileSync(`${socket}.web.log`, "alpha\n");
    const pidFile = `${socket}.web.log.follower-pid`;

    const controller = new AbortController();
    const seen: string[] = [];
    const drained = (async () => {
      const events = stubDriver().streamLogs(socket, {
        service: "web",
        follow: true,
        signal: controller.signal,
      });
      for await (const ev of events) seen.push(ev.line);
    })();
    await vi.waitFor(() => {
      expect(seen).toEqual(["alpha"]);
      expect(existsSync(pidFile)).toBe(true);
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(pid)).toBe(true);

    controller.abort();
    await drained;
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  });

  it("returns an empty stream when the stub has no log fixture for the service", async () => {
    const dir = tmpDir();
    const socket = join(dir, "login.sock");
    // No `${socket}.unknown.log` fixture — stub exits cleanly with no output.
    const events = await collect(stubDriver().streamLogs(socket, { service: "unknown" }));
    expect(events).toEqual([]);
  });
});
