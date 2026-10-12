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

  it("takes only the PIDs as evidence when the read failed", () => {
    expect(stuckFromMarker(marker, undefined, () => false)).toBeUndefined();
    expect(stuckFromMarker(marker, undefined, () => true)?.pids).toEqual([1]);
  });
});

describe("stuckFromProject", () => {
  it("flags a service absent from a namespace another present service proves booted", () => {
    const declared = { web: {}, api: {} };
    expect(stuckFromProject(declared, [row("api")])).toEqual({ services: ["web"], pids: [] });
  });

  it("flags an empty project", () => {
    expect(stuckFromProject({ web: {} }, [])).toEqual({ services: ["web"], pids: [] });
  });

  it("ignores namespaces nothing proves booted, list-valued ones included", () => {
    const declared = {
      db: { namespace: ["one", "two"] },
      web: { namespace: "one" },
      worker: { namespace: "two" },
    };
    expect(stuckFromProject(declared, [row("db"), row("worker")])).toBeUndefined();
    expect(stuckFromProject(declared, [row("db")])).toBeUndefined();
  });

  it("a single-entry list proves its namespace like a string does", () => {
    const declared = { a: { namespace: ["one"] }, b: { namespace: "one" } };
    expect(stuckFromProject(declared, [row("a")])).toEqual({ services: ["b"], pids: [] });
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
