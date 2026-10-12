import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceStatus } from "./driver.js";
import {
  clearPendingReload,
  isProcessAlive,
  planPendingReload,
  readPendingReload,
  stuckFromMarker,
  stuckFromProject,
  writePendingReload,
} from "./reload-pending.js";

const row = (name: string, pid?: number): ServiceStatus => ({
  name,
  status: "Running",
  health: "unknown",
  ...(pid !== undefined ? { pid } : {}),
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

describe("stuckFromProject", () => {
  const noMarker = { emptyIsPending: false };

  it("flags a service absent from a namespace another present service proves booted", () => {
    const declared = { web: {}, api: {} };
    expect(stuckFromProject(declared, [row("api")], noMarker)).toEqual({
      services: ["web"],
      pids: [],
    });
  });

  it("an empty project is pending only when a marker says a reload timed out", () => {
    // `up -n <ns>` on a namespace with no services boots an empty project (#176).
    expect(stuckFromProject({ web: {} }, [], noMarker)).toBeUndefined();
    expect(stuckFromProject({ web: {} }, [], { emptyIsPending: true })).toEqual({
      services: ["web"],
      pids: [],
    });
  });

  it("ignores namespaces nothing proves booted, list-valued ones included", () => {
    const declared = {
      db: { namespace: ["one", "two"] },
      web: { namespace: "one" },
      worker: { namespace: "two" },
    };
    expect(stuckFromProject(declared, [row("db"), row("worker")], noMarker)).toBeUndefined();
    expect(stuckFromProject(declared, [row("db")], noMarker)).toBeUndefined();
  });

  it("a single-entry list proves its namespace like a string does", () => {
    const declared = { a: { namespace: ["one"] }, b: { namespace: "one" } };
    expect(stuckFromProject(declared, [row("a")], noMarker)).toEqual({
      services: ["b"],
      pids: [],
    });
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
