import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceStatus } from "./driver.js";
import {
  clearPendingReload,
  identifyOldRuns,
  isProcessAlive,
  planPendingReload,
  readPendingReload,
  stuckFromMarker,
  writePendingReload,
} from "./reload-pending.js";

const row = (name: string, pid?: number): ServiceStatus => ({
  name,
  status: "Running",
  health: "unknown",
  ...(pid !== undefined ? { pid } : {}),
});

describe("identifyOldRuns (#206)", () => {
  const PC = { pid: 9, ppid: 1, pgid: 9, command: "process-compose up -u /s.sock" };
  const marker = {
    services: ["web"],
    oldRuns: [
      { name: "web", pid: 100 },
      { name: "api", pid: 200 },
      { name: "gone", pid: 300 },
    ],
  };

  it("records each old run's parent, group and command line when it is a child of the supervisor", () => {
    const table = [
      PC,
      { pid: 100, ppid: 9, pgid: 100, command: "bash -c node a.js" },
      // Not a child of this instance's process-compose: never identified.
      { pid: 200, ppid: 1, pgid: 200, command: "vim" },
    ];
    expect(identifyOldRuns(marker, table, 9)).toEqual({
      services: ["web"],
      oldRuns: [
        { name: "web", pid: 100, identity: { ppid: 9, pgid: 100, command: "bash -c node a.js" } },
        { name: "api", pid: 200, identity: null },
        { name: "gone", pid: 300, identity: null },
      ],
    });
  });

  it("identifies nothing when the supervisor is unknown or `ps` failed", () => {
    const table = [PC, { pid: 100, ppid: 9, pgid: 100, command: "x" }];
    const nulls = identifyOldRuns(marker, table, undefined).oldRuns.map((r) => r.identity);
    expect(nulls).toEqual([null, null, null]);
    expect(identifyOldRuns(marker, [], 9).oldRuns.map((r) => r.identity)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("round-trips through the marker file", () => {
    const anchor = mkdtempSync(join(tmpdir(), "dt-pr206-"));
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    try {
      const identified = identifyOldRuns(
        marker,
        [PC, { pid: 100, ppid: 9, pgid: 100, command: "x" }],
        9,
      );
      writePendingReload(anchor, "wt", identified);
      expect(readPendingReload(anchor, "wt")).toEqual(identified);
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });
});

describe("planPendingReload", () => {
  const before = {
    web: { command: "a" },
    api: { command: "api" },
    gone: { command: "g" },
    off: { command: "o", namespace: "other" },
  };
  const after = { web: { command: "b" }, api: { command: "api" }, off: { command: "o2" } };

  it("waits on the changed services the snapshot shows, and expects back the ones still declared", () => {
    const rows = [row("web", 1), row("api", 2), row("gone", 3)];
    expect(planPendingReload(before, after, rows)).toEqual({
      services: ["web"],
      oldRuns: [
        { name: "web", pid: 1 },
        { name: "gone", pid: 3 },
      ],
    });
  });

  it("does not expect back a service the reload moves into an unbooted namespace", () => {
    const moved = { ...after, web: { command: "b", namespace: "later" } };
    expect(planPendingReload(before, moved, [row("web", 1), row("api", 2)])).toEqual({
      services: [],
      oldRuns: [{ name: "web", pid: 1 }],
    });
  });

  it("expects back a service moved into a namespace the snapshot proves booted", () => {
    const b = { web: { command: "a" }, api: { command: "api", namespace: "two" } };
    const a = { web: { command: "b", namespace: "two" }, api: b.api };
    expect(planPendingReload(b, a, [row("web", 1), row("api", 2)]).services).toEqual(["web"]);
  });

  it("records nothing specific without a snapshot or a previous config", () => {
    expect(planPendingReload(before, after, undefined)).toEqual({ services: [], oldRuns: [] });
    expect(planPendingReload(undefined, after, [row("web", 1)])).toEqual({
      services: [],
      oldRuns: [],
    });
  });
});

describe("stuckFromMarker", () => {
  const marker = { services: ["web"], oldRuns: [{ name: "web", pid: 1 }] };

  it("is pending while the old PID lives, then while the service is absent", () => {
    expect(stuckFromMarker(marker, [row("api")], () => true)).toEqual({
      services: ["web"],
      pids: [1],
    });
    expect(stuckFromMarker(marker, [row("api")], () => false)).toEqual({
      services: ["web"],
      pids: [],
    });
  });

  it("has converged once the old PID is gone and the service is back", () => {
    expect(stuckFromMarker(marker, [row("web", 2)], () => false)).toBeUndefined();
  });

  it("a live old PID does not hold it once the service is back under a different PID (PID reuse)", () => {
    expect(stuckFromMarker(marker, [row("web", 2)], () => true)).toBeUndefined();
    // Back under the SAME pid is still the old run.
    expect(stuckFromMarker(marker, [row("web", 1)], () => true)?.pids).toEqual([1]);
  });

  it("takes only the PIDs as evidence when the read failed", () => {
    expect(stuckFromMarker(marker, undefined, () => false)).toBeUndefined();
    expect(stuckFromMarker(marker, undefined, () => true)?.pids).toEqual([1]);
  });
});

describe("marker file", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  });
  const anchor = (): string => {
    const root = mkdtempSync(join(tmpdir(), "dt-reload-pending-"));
    roots.push(root);
    mkdirSync(join(root, "devtrees"), { recursive: true });
    return root;
  };

  it("round-trips, and clears idempotently", () => {
    const a = anchor();
    expect(readPendingReload(a, "wt")).toBeUndefined();
    const marker = { services: ["web"], oldRuns: [{ name: "web", pid: 7 }] };
    writePendingReload(a, "wt", marker);
    expect(readPendingReload(a, "wt")).toEqual(marker);
    clearPendingReload(a, "wt");
    clearPendingReload(a, "wt");
    expect(readPendingReload(a, "wt")).toBeUndefined();
  });

  it("an unreadable marker still means a reload timed out here", () => {
    const a = anchor();
    writeFileSync(join(a, "devtrees", "wt.reload-pending.json"), "{not json");
    expect(readPendingReload(a, "wt")).toEqual({ services: [], oldRuns: [] });
  });
});

describe("isProcessAlive", () => {
  it("is true for this process and false for a PID that cannot exist", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});
