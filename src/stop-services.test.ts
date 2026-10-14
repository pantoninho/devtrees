/**
 * The pure half of `restart`'s stop (ADR-0009, #222, #223): the
 * running/not-running split, the pending and last-running refusals, and the
 * budget.
 */
import { describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DerivedConfig } from "./deriver.js";
import type { ServiceStatus } from "./driver.js";
import { stateDir } from "./paths.js";
import {
  assertNotLastRunning,
  assertNotPending,
  clearLegacyStopMarker,
  partitionRunning,
  stopTimeoutMs,
} from "./stop-services.js";

describe("clearLegacyStopMarker", () => {
  it("removes a 0.2.0 stop-incomplete marker, and is a no-op when absent", () => {
    const anchor = mkdtempSync(join(tmpdir(), "rmstop-legacy-"));
    try {
      mkdirSync(stateDir(anchor), { recursive: true });
      const marker = join(stateDir(anchor), "login.stop-incomplete.json");
      writeFileSync(marker, '{"services":["web"]}\n');
      clearLegacyStopMarker(anchor, "login");
      expect(existsSync(marker)).toBe(false);
      expect(() => clearLegacyStopMarker(anchor, "login")).not.toThrow();
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });
});

/** `assertNotLastRunning`'s restart context: the remedy and what was already restarted. */
const R = { remedy: "devtrees down && devtrees up -n app", done: [] };

type Coded = Error & { code?: string; details?: Record<string, unknown> };

function row(name: string, status: string, exitCode?: number, running?: boolean): ServiceStatus {
  return {
    name,
    status,
    health: "unknown",
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(running !== undefined ? { running } : {}),
  };
}

function thrown(fn: () => unknown): Coded {
  try {
    fn();
  } catch (err) {
    return err as Coded;
  }
  throw new Error("expected a throw");
}

describe("partitionRunning / assertNotPending (B3)", () => {
  it("splits a Pending service out: it has not started, so it is neither stopped nor stoppable", () => {
    const rows = [row("web", "Running"), row("app", "Pending", 0, false)];
    expect(partitionRunning(rows, ["web", "app"])).toEqual({
      running: ["web"],
      pending: ["app"],
      notRunning: [],
    });
  });

  it("refuses Pending services with SERVICE_PENDING naming what they wait on", () => {
    const err = thrown(() =>
      assertNotPending(["app", "ios"], (s) => (s === "app" ? ["api"] : ["api", "db"]), "login"),
    );
    expect(err.code).toBe("SERVICE_PENDING");
    expect(err.details).toEqual({
      services: ["app", "ios"],
      waiting_on: ["api", "db"],
      remedy:
        "Wait until they start (once api, db are ready), or restart what they wait on: " +
        "`devtrees restart api db`.",
    });
    expect(() => assertNotPending([], () => [], "login")).not.toThrow();
  });
});

describe("partitionRunning", () => {
  it("acts on running and stopping services; skips stopped, done, dead and unbooted ones", () => {
    const rows = [
      row("web", "Running"),
      row("hook", "Terminating"),
      row("gone", "Completed", -1),
      row("seed", "Completed", 0),
      row("bad", "Error"),
    ];
    expect(partitionRunning(rows, ["web", "hook", "gone", "seed", "bad", "unbooted"])).toEqual({
      running: ["web", "hook"],
      pending: [],
      notRunning: ["gone", "seed", "bad", "unbooted"],
    });
  });
});

describe("assertNotLastRunning", () => {
  it("allows a stop that leaves another process running", () => {
    expect(() =>
      assertNotLastRunning([row("web", "Running"), row("api", "Running")], ["web"], "login", R),
    ).not.toThrow();
  });

  it("refuses with LAST_SERVICES_RUNNING when only done, stopped or idle services would remain", () => {
    const rows = [
      row("web", "Running"),
      row("seed", "Completed", 0),
      row("api", "Completed", -1),
      row("off", "Disabled"),
      row("skip", "Skipped"),
    ];
    const err = thrown(() => assertNotLastRunning(rows, ["web"], "login", R));
    expect(err.code).toBe("LAST_SERVICES_RUNNING");
    expect(err.details).toEqual({
      worktree_id: "login",
      services: ["web"],
      remedy: "devtrees down && devtrees up -n app",
    });
  });

  it("does not count a Pending dependent: it may wait on the very service being stopped (B1)", () => {
    // `app` depends on `api` being healthy; process-compose reports it
    // `Pending`, `is_running: false`. Stopping `api` means `app` never starts.
    const rows = [row("api", "Running", 0, true), row("app", "Pending", 0, false)];
    const err = thrown(() => assertNotLastRunning(rows, ["api"], "login", R));
    expect(err.code).toBe("LAST_SERVICES_RUNNING");
    // Without `is_running`, the status alone still excludes Pending and Terminating.
    for (const other of [row("app", "Pending"), row("hook", "Terminating")]) {
      expect(
        thrown(() => assertNotLastRunning([row("api", "Running"), other], ["api"], "x", R)).code,
      ).toBe("LAST_SERVICES_RUNNING");
    }
  });

  it("trusts is_running over the status: a Running row that is not running does not count", () => {
    const rows = [row("web", "Running", 0, true), row("api", "Restarting", 0, false)];
    expect(thrown(() => assertNotLastRunning(rows, ["web"], "login", R)).code).toBe(
      "LAST_SERVICES_RUNNING",
    );
    const alive = [row("web", "Running", 0, true), row("api", "Running", 0, true)];
    expect(() => assertNotLastRunning(alive, ["web"], "login", R)).not.toThrow();
  });

  it("never refuses when nothing is being stopped", () => {
    expect(() => assertNotLastRunning([row("web", "Completed", -1)], [], "login", R)).not.toThrow();
  });
});

describe("stopTimeoutMs", () => {
  it("adds only the named services' shutdown.timeout_seconds to the base", () => {
    const config = {
      version: "0.5",
      processes: {
        web: { command: "x", shutdown: { timeout_seconds: 2 } },
        api: { command: "y", shutdown: { timeout_seconds: 100 } },
      },
    } as unknown as DerivedConfig;
    expect(stopTimeoutMs(config, ["web"], 1_000)).toBe(3_000);
    expect(stopTimeoutMs(config, ["web", "api"], 1_000)).toBe(103_000);
    expect(stopTimeoutMs(undefined, ["web"], 1_000)).toBe(1_000);
  });
});
