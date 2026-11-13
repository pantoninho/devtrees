import { describe, expect, it } from "vite-plus/test";
import { DEVTREES_METADATA_KEY, type DerivedConfig, type DerivedProcess } from "./deriver.js";
import { daemonHooksSkipped } from "./down-survivors.js";
import type { ServiceStatus } from "./driver.js";

const proc = (extra: Partial<DerivedProcess> = {}): DerivedProcess => ({
  command: "true",
  working_dir: "/w",
  environment: [],
  ...extra,
});

const hook = { command: "supabase stop" };

const config = (processes: Record<string, DerivedProcess>): DerivedConfig => ({
  processes,
  [DEVTREES_METADATA_KEY]: { ports_by_service: {} },
});

const row = (name: string, status: string, exitCode?: number): ServiceStatus =>
  exitCode === undefined
    ? { name, status, health: "unknown" }
    : { name, status, health: "unknown", exitCode };

/** The daemons whose hooks `down` runs itself, for one status row. */
const skippedFor = (status: string, exitCode?: number): string[] => {
  const cfg = config({ db: proc({ is_daemon: true, shutdown: hook }) });
  return Object.keys(daemonHooksSkipped(cfg, [row("db", status, exitCode)])?.processes ?? {});
};

describe("daemonHooksSkipped — a daemon whose launch failed (#155)", () => {
  it.each([
    ["Error", undefined, ["db"]],
    ["Error", 0, ["db"]],
    ["Completed", 1, ["db"]],
    ["Completed", -1, ["db"]],
    // An unknown exit code is not a failure: running a hook twice is worse.
    ["Completed", undefined, []],
    // Stopped earlier (`process stop`, the TUI): its hook already ran.
    ["Completed", 0, []],
    // Only `Error` and `Completed` count, case-sensitively: `Failed` and the
    // lower-case spellings are not a failed launch here.
    ["Failed", undefined, []],
    ["Failed", 1, []],
    ["error", undefined, []],
    ["completed", 1, []],
    ["Running", undefined, []],
    ["Launched", undefined, []],
    ["Launching", undefined, []],
    ["Pending", undefined, []],
    ["Terminating", 1, []],
    ["Skipped", undefined, []],
    ["Disabled", undefined, []],
  ] as const)("%s (exit %s) -> %j", (status, exitCode, expected) => {
    expect(skippedFor(status, exitCode)).toEqual(expected);
  });

  it("keeps only daemons with a shutdown hook, and keeps the rest of the config", () => {
    const cfg = config({
      db: proc({ is_daemon: true, shutdown: hook }),
      api: proc({ shutdown: hook }),
      cache: proc({ is_daemon: true }),
      ok: proc({ is_daemon: true, shutdown: hook }),
    });
    const skipped = daemonHooksSkipped(cfg, [
      row("db", "Error"),
      row("api", "Error"),
      row("cache", "Error"),
      row("ok", "Running"),
    ]);
    expect(skipped).toEqual({ ...cfg, processes: { db: cfg.processes.db } });
  });

  it("is undefined when no daemon's launch failed", () => {
    const cfg = config({ db: proc({ is_daemon: true, shutdown: hook }) });
    expect(daemonHooksSkipped(cfg, [row("db", "Running")])).toBeUndefined();
    expect(daemonHooksSkipped(cfg, [])).toBeUndefined();
  });
});
