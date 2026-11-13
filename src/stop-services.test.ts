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
  assertNotSkipped,
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

describe("assertNotSkipped (#263)", () => {
  /** `web` on `api`; `app` on `web`; `docs` on nothing. */
  const deps: Record<string, string[]> = { web: ["api"], app: ["web"], docs: [] };
  const dependsOn = (s: string) => deps[s] ?? [];

  it("refuses a Skipped service whose dependency is still dead, naming the dependency", () => {
    const rows = [row("api", "Completed", 3, false), row("web", "Skipped", 1, false)];
    const err = thrown(() => assertNotSkipped(rows, ["web"], dependsOn, "login"));
    expect(err.code).toBe("SERVICE_SKIPPED");
    const remedy =
      "Restart api first, and web after it: `devtrees restart api web`. If api fails " +
      "again, fix it first (`devtrees logs api`).";
    expect(err.message).toBe(
      "devtrees restart: web was skipped because a dependency failed, and api (Completed, " +
        "exit 3) is still failed in 'login', so a start would leave it skipped. Nothing was " +
        `touched. ${remedy}`,
    );
    expect(err.details).toEqual({
      services: ["web"],
      failed_dependencies: [{ name: "api", status: "Completed", exit_code: 3 }],
      remedy,
    });
  });

  it("follows a Skipped dependency to the dead one at the root, and restarts the chain", () => {
    const rows = [
      row("api", "Error", 1, false),
      row("web", "Skipped", 1, false),
      row("app", "Skipped", 1, false),
    ];
    const err = thrown(() => assertNotSkipped(rows, ["app"], dependsOn, "login"));
    expect(err.code).toBe("SERVICE_SKIPPED");
    expect(err.details).toMatchObject({
      services: ["app"],
      failed_dependencies: [{ name: "api", status: "Error", exit_code: 1 }],
    });
    expect(String(err.details?.remedy)).toContain("`devtrees restart api web app`");
  });

  it("names a Skipped dependency as the root when nothing above it is dead", () => {
    const rows = [row("api", "Running"), row("web", "Skipped", 1, false), row("app", "Skipped")];
    const err = thrown(() => assertNotSkipped(rows, ["app"], dependsOn, "login"));
    expect(err.details).toMatchObject({
      services: ["app"],
      failed_dependencies: [{ name: "web", status: "Skipped", exit_code: 1 }],
    });
  });

  it("refuses the whole request when any named service is blocked", () => {
    const rows = [
      row("api", "Completed", -1, false),
      row("web", "Skipped", 1, false),
      row("docs", "Running"),
    ];
    const err = thrown(() => assertNotSkipped(rows, ["docs", "web"], dependsOn, "login"));
    expect(err.code).toBe("SERVICE_SKIPPED");
    expect(err.details).toMatchObject({ services: ["web"] });
    expect(String(err.details?.remedy)).toContain("`devtrees restart api docs web`");
  });

  it("lets a Skipped service through once its dependency recovered, or is restarted before it", () => {
    const skipped = row("web", "Skipped", 1, false);
    // The dependency is running again (or a finished one-shot): a plain start works.
    for (const api of [row("api", "Running"), row("api", "Completed", 0, false)]) {
      expect(() => assertNotSkipped([api, skipped], ["web"], dependsOn, "login")).not.toThrow();
    }
    // The dependency is restarted earlier in the same request, and waited on.
    const dead = row("api", "Completed", 3, false);
    expect(() => assertNotSkipped([dead, skipped], ["api", "web"], dependsOn, "login")).not.toThrow();
    // A Disabled service, and a Skipped one with no dependency row, are never refused.
    const disabled = row("web", "Disabled", 0, false);
    expect(() => assertNotSkipped([dead, disabled], ["web"], dependsOn, "login")).not.toThrow();
    expect(() => assertNotSkipped([skipped], ["web"], dependsOn, "login")).not.toThrow();
  });

  it("survives a depends_on cycle", () => {
    const cyclic = (s: string) => (s === "a" ? ["b"] : s === "b" ? ["a"] : []);
    const rows = [row("a", "Skipped", 1, false), row("b", "Skipped", 1, false)];
    const err = thrown(() => assertNotSkipped(rows, ["a"], cyclic, "login"));
    expect(err.code).toBe("SERVICE_SKIPPED");
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
