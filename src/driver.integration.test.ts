/**
 * Driver integration tests against the stub process-compose binary.
 *
 * Covers the issue-#31 `reloadConfig` happy-path and the "not supported"
 * branch end-to-end: the driver spawns `node test/stub-process-compose.mjs`
 * (via the same prefix-args hook the rest of the e2e uses), waits for
 * the child's exit, and classifies the outcome from the exit code.
 *
 * Kept separate from the pure `driver.test.ts` argv/parse unit tests so the
 * file's scope is "do real subprocess invocations work" rather than "does
 * argv construction round-trip."
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDriver } from "./driver.js";

const STUB = fileURLToPath(new URL("../test/stub-process-compose.mjs", import.meta.url));
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** Lay out a running instance at <root>/devtrees/{run,login.yaml} as `up` would. */
function makeRunningInstance(): { configPath: string; socketPath: string } {
  const root = mkdtempSync(join(SHORT_TMP, "dt-reload-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const devtreesDir = join(root, "devtrees");
  const runDir = join(devtreesDir, "run");
  mkdirSync(runDir, { recursive: true });
  const configPath = join(devtreesDir, "login.yaml");
  const socketPath = join(runDir, "login.sock");
  writeFileSync(configPath, 'processes:\n  web:\n    command: "sleep 30"\n', "utf8");
  // Pretend the instance is running by laying down the socket marker file +
  // the .config sibling the stub maintains. The stub's `project update`
  // requires both to be present.
  writeFileSync(socketPath, "");
  writeFileSync(`${socketPath}.config`, "processes: {}\n");
  return { configPath, socketPath };
}

describe("driver.reloadConfig — integration against stub process-compose", () => {
  it("happy path: stub accepts `project update` and the driver returns ok:true", async () => {
    const inst = makeRunningInstance();
    const driver = createDriver({
      binary: process.execPath,
      prefixArgs: [STUB],
    });
    const result = await driver.reloadConfig(inst);
    expect(result).toEqual({ ok: true });
    // Side-effect: the stub mirrors the new config alongside the socket.
    expect(existsSync(`${inst.socketPath}.config`)).toBe(true);
  });

  it("not-supported branch: stub exits non-zero, driver returns ok:false with reason:not_supported", async () => {
    const inst = makeRunningInstance();
    const driver = createDriver({
      binary: process.execPath,
      prefixArgs: [STUB],
    });
    // Run with STUB_RELOAD_UNSUPPORTED=1 in the child's env to mimic an older
    // process-compose missing the `project update` subcommand.
    const prevEnv = process.env.STUB_RELOAD_UNSUPPORTED;
    process.env.STUB_RELOAD_UNSUPPORTED = "1";
    try {
      const result = await driver.reloadConfig(inst);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.reason).toBe("not_supported");
      // Diagnostic message is preserved verbatim from the child's stderr —
      // useful for surfacing in the CONFIG_DRIFT error envelope's details.
      expect(result.message).toMatch(/not supported/i);
    } finally {
      if (prevEnv === undefined) delete process.env.STUB_RELOAD_UNSUPPORTED;
      else process.env.STUB_RELOAD_UNSUPPORTED = prevEnv;
    }
  });
});
