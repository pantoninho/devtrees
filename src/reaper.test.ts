/**
 * `reapShutdownHooks` unit tests (issue #148).
 *
 * The reaper runs each derived process's `shutdown.command` itself — socket-free,
 * from a working directory that exists — so a worktree's out-of-band resources
 * are reclaimed even though `git worktree remove` deleted the `working_dir`
 * process-compose would otherwise launch the hook from.
 *
 * These exercise the pure orchestration: which commands run, with what cwd / env
 * / timeout, and how launch failure / non-zero exit / timeout map onto the
 * returned outcome. The actual shell-out is driven through an injected runner so
 * no real subprocess is spawned.
 */

import { describe, expect, it } from "vite-plus/test";
import type { DerivedConfig } from "./deriver.js";
import { reapShutdownHooks, type HookRun } from "./reaper.js";

/** Minimal derived config with the given processes. */
function config(processes: DerivedConfig["processes"]): DerivedConfig {
  return { processes, "x-devtrees": { ports_by_service: {} } };
}

/** A process entry with a shutdown.command. */
function proc(
  command: string,
  shutdown?: Record<string, unknown>,
  environment: string[] = [],
): DerivedConfig["processes"][string] {
  return {
    command,
    working_dir: "/gone/worktree",
    environment,
    ...(shutdown !== undefined ? { shutdown } : {}),
  };
}

describe("reapShutdownHooks — runs each process's shutdown.command from a valid cwd", () => {
  it("runs the shutdown.command verbatim from the provided (existing) cwd, never the working_dir", async () => {
    const runs: HookRun[] = [];
    const result = await reapShutdownHooks(
      config({
        db: proc("node server.js", { command: "docker compose down -v" }),
      }),
      {
        cwd: "/exists/anchor",
        run: async (run) => {
          runs.push(run);
          return { ok: true };
        },
      },
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.command).toBe("docker compose down -v");
    // cwd is the existing dir, NOT the (deleted) working_dir.
    expect(runs[0]?.cwd).toBe("/exists/anchor");
    expect(result.ranCount).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("passes the process's embedded environment lines through to the hook env", async () => {
    const runs: HookRun[] = [];
    await reapShutdownHooks(
      config({
        db: proc("node server.js", { command: "reap.sh" }, [
          "DEVTREES_WORKTREE_ID=login-abc",
          "DB_PORT=20001",
        ]),
      }),
      { cwd: "/anchor", run: async (run) => (runs.push(run), { ok: true }) },
    );

    expect(runs[0]?.env.DEVTREES_WORKTREE_ID).toBe("login-abc");
    expect(runs[0]?.env.DB_PORT).toBe("20001");
  });

  it("honors shutdown.timeout_seconds, converting to milliseconds", async () => {
    const runs: HookRun[] = [];
    await reapShutdownHooks(
      config({
        db: proc("node server.js", { command: "reap.sh", timeout_seconds: 7 }),
      }),
      { cwd: "/anchor", run: async (run) => (runs.push(run), { ok: true }) },
    );

    expect(runs[0]?.timeoutMs).toBe(7000);
  });

  it("skips processes with no shutdown block and processes with no shutdown.command", async () => {
    const runs: HookRun[] = [];
    const result = await reapShutdownHooks(
      config({
        web: proc("node web.js"),
        noCmd: proc("node x.js", { timeout_seconds: 5 }),
        db: proc("node db.js", { command: "reap.sh" }),
      }),
      { cwd: "/anchor", run: async (run) => (runs.push(run), { ok: true }) },
    );

    expect(runs.map((r) => r.command)).toEqual(["reap.sh"]);
    expect(result.ranCount).toBe(1);
  });

  it("runs every hook even when one fails, and collects each failure (process name + reason)", async () => {
    const result = await reapShutdownHooks(
      config({
        a: proc("x", { command: "a-reap" }),
        b: proc("x", { command: "b-reap" }),
        c: proc("x", { command: "c-reap" }),
      }),
      {
        cwd: "/anchor",
        run: async (run) => {
          if (run.process === "b") return { ok: false, reason: "exit", message: "exit code 1" };
          return { ok: true };
        },
      },
    );

    expect(result.ranCount).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.process).toBe("b");
    expect(result.failures[0]?.reason).toBe("exit");
  });

  it("returns an empty outcome for a config with no shutdown hooks at all", async () => {
    const result = await reapShutdownHooks(config({ web: proc("node web.js") }), {
      cwd: "/anchor",
      run: async () => ({ ok: true }),
    });
    expect(result.ranCount).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
