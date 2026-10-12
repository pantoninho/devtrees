/**
 * Bounded `down` with surgical escalation (issue #190): the snapshot, the
 * pid-reuse protection, the targeted SIGKILL and the `DOWN_TIMEOUT` verdict.
 * Every effect (process list, `ps`, kill, liveness) is a seam, so no real
 * process is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  boundedDown,
  DownTimeoutError,
  findSupervisorPid,
  parseProcessTable,
  pendingRunsToKill,
  snapshotServiceProcesses,
  unverifiedRuns,
  stillRunning,
  type ProcessRow,
  type StopDriver,
  type StopTarget,
} from "./bounded-down.js";
import type { DownOutcome, ServiceStatus } from "./driver.js";
import type { OldRun } from "./reload-pending.js";

const SOCK = "/tmp/devtrees-501/abc/login-1234.sock";
const PC: ProcessRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  command: `process-compose up -f /a/login.yaml -U -u ${SOCK} -t=false -n default`,
};
const WEB: ProcessRow = { pid: 201, ppid: 100, pgid: 201, command: "bash -c tail -f hold" };
const API: ProcessRow = { pid: 202, ppid: 100, pgid: 202, command: "sleep 300" };
const HOOK: ProcessRow = { pid: 203, ppid: 100, pgid: 203, command: "bash -c echo bye" };

function status(name: string, pid?: number): ServiceStatus {
  return { name, status: "Running", health: "unknown", ...(pid !== undefined ? { pid } : {}) };
}

describe("parseProcessTable", () => {
  it("reads pid, ppid, pgid and the full command line", () => {
    const rows = parseProcessTable(
      [
        "  100     1   100 process-compose up -f a.yaml",
        "201 100 201 bash -c tail -f hold  ",
        "",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { pid: 100, ppid: 1, pgid: 100, command: "process-compose up -f a.yaml" },
      { pid: 201, ppid: 100, pgid: 201, command: "bash -c tail -f hold" },
    ]);
  });

  it("skips malformed lines", () => {
    expect(parseProcessTable("garbage\n  12 x 3 cmd\n")).toEqual([]);
  });
});

describe("findSupervisorPid", () => {
  it("finds the process-compose `up` bound to the socket", () => {
    expect(findSupervisorPid([WEB, PC, API], SOCK)).toBe(100);
  });

  it("ignores clients on the same socket and servers on other sockets", () => {
    const client = { ...PC, pid: 300, command: `process-compose down -U -u ${SOCK}` };
    const other = { ...PC, pid: 301, command: `process-compose up -U -u ${SOCK}.other` };
    expect(findSupervisorPid([client, other], SOCK)).toBeUndefined();
  });

  it("matches a socket path containing spaces, at the end of argv or mid-argv", () => {
    const spaced = "/Users/me/My Repo/.git/devtrees/run/login-1234.sock";
    const atEnd = { ...PC, command: `process-compose up -f /a b.yaml -U -u ${spaced}` };
    const mid = {
      ...PC,
      pid: 102,
      command: `process-compose up -U --unix-socket ${spaced} -t=false`,
    };
    expect(findSupervisorPid([atEnd], spaced)).toBe(100);
    expect(findSupervisorPid([mid], spaced)).toBe(102);
    // A path that merely starts with the socket path is another socket.
    const longer = { ...PC, command: `process-compose up -U -u ${spaced}.bak` };
    expect(findSupervisorPid([longer], spaced)).toBeUndefined();
  });

  it("refuses to guess between two matches", () => {
    expect(findSupervisorPid([PC, { ...PC, pid: 101 }], SOCK)).toBeUndefined();
  });
});

describe("snapshotServiceProcesses", () => {
  it("pairs each service pid with its row, keeping only children of the supervisor", () => {
    // `old` is a dead row whose stale pid was reused by an unrelated process.
    const reused: ProcessRow = { pid: 999, ppid: 55, pgid: 999, command: "vim notes" };
    const snap = snapshotServiceProcesses(
      [status("web", 201), status("api", 202), status("old", 999), status("nopid")],
      [PC, WEB, API, reused],
      100,
    );
    expect(snap).toEqual([
      { service: "web", ...WEB },
      { service: "api", ...API },
    ]);
  });

  it("is empty when the supervisor is unknown: no parentage, no kill", () => {
    expect(snapshotServiceProcesses([status("web", 201)], [WEB], undefined)).toEqual([]);
  });
});

describe("stillRunning (pid-reuse protection)", () => {
  const snapshot = [{ service: "web", ...WEB }];

  it("keeps a process that is still the same process", () => {
    expect(stillRunning(snapshot, [PC, WEB])).toEqual(snapshot);
  });

  it("drops a process that has exited", () => {
    expect(stillRunning(snapshot, [PC])).toEqual([]);
  });

  it("drops a reused pid: another command, parent or group", () => {
    expect(stillRunning(snapshot, [{ ...WEB, command: "vim notes" }])).toEqual([]);
    expect(stillRunning(snapshot, [{ ...WEB, ppid: 1 }])).toEqual([]);
    expect(stillRunning(snapshot, [{ ...WEB, pgid: 7 }])).toEqual([]);
  });
});

/** The old `web` run a timed-out reload left behind: process-compose no longer lists it. */
const OLD: ProcessRow = { pid: 301, ppid: 100, pgid: 301, command: "bash -c tail -f hold-a" };
const OLD_RUN: OldRun = {
  name: "web",
  pid: 301,
  identity: { ppid: 100, pgid: 301, command: OLD.command },
};

describe("pendingRunsToKill (#206)", () => {
  it("keeps an old run that is still the same child of the supervisor", () => {
    expect(pendingRunsToKill([OLD_RUN], [], [PC, OLD], 100)).toEqual([{ service: "web", ...OLD }]);
  });

  it("drops a reused pid: another command, process group or parent", () => {
    for (const now of [
      { ...OLD, command: "vim notes" },
      { ...OLD, pgid: 999 },
      { ...OLD, ppid: 1 },
    ]) {
      expect(pendingRunsToKill([OLD_RUN], [], [PC, now], 100)).toEqual([]);
    }
  });

  it("drops a run that has exited, or any run when the supervisor is unknown", () => {
    expect(pendingRunsToKill([OLD_RUN], [], [PC], 100)).toEqual([]);
    expect(pendingRunsToKill([OLD_RUN], [], [PC, OLD], undefined)).toEqual([]);
  });

  it("never kills a run without a verified identity: null, missing (older marker) or malformed", () => {
    // On the pid alone it could be anything, even a running shutdown.command.
    for (const identity of [null, undefined, "x", { ppid: 100 }]) {
      const run = { name: "web", pid: 301, identity } as unknown as OldRun;
      expect(pendingRunsToKill([run], [], [PC, OLD], 100)).toEqual([]);
    }
  });

  it("unverifiedRuns names the unverified runs whose pid is still alive, for the remedy", () => {
    const legacy: OldRun = { name: "web", pid: 301 };
    const gone: OldRun = { name: "api", pid: 999, identity: null };
    expect(unverifiedRuns([legacy, gone, OLD_RUN], [PC, OLD])).toEqual([
      { service: "web", pid: 301 },
    ]);
  });

  it("leaves a pid the snapshot already covers to it, and lists each pid once", () => {
    const listed = [{ service: "web", ...OLD }];
    expect(pendingRunsToKill([OLD_RUN], listed, [PC, OLD], 100)).toEqual([]);
    expect(pendingRunsToKill([OLD_RUN, OLD_RUN], [], [PC, OLD], 100)).toHaveLength(1);
  });
});

/** A scripted world: the process table over time, the down outcome, and the kills. */
function world(opts: {
  readonly statuses?: ServiceStatus[] | Error;
  readonly tables: ProcessRow[][];
  readonly outcome: DownOutcome;
  /** pid → alive, evaluated when polled. */
  readonly alive?: (pid: number) => boolean;
  readonly killThrows?: boolean;
}) {
  const kills: Array<[number, string]> = [];
  const downs: Array<number | undefined> = [];
  let tableReads = 0;
  const driver: StopDriver = {
    getServiceStatuses: async () => {
      if (opts.statuses instanceof Error) throw opts.statuses;
      return opts.statuses ?? [];
    },
    down: async (_inst, o) => {
      downs.push(o.timeoutMs);
      return opts.outcome;
    },
  };
  const seams = {
    readProcessTable: async () => opts.tables[Math.min(tableReads++, opts.tables.length - 1)] ?? [],
    kill: (target: number, signal: NodeJS.Signals) => {
      if (opts.killThrows) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      kills.push([target, signal]);
    },
    isAlive: opts.alive ?? (() => false),
    exists: () => false,
    graceMs: 50,
    pollMs: 5,
  };
  return { driver, seams, kills, downs, tableReads: () => tableReads };
}

const target: StopTarget = {
  inst: { configPath: "/a/login.yaml", socketPath: SOCK },
  instance: "login-1234",
  command: "down",
  timeoutMs: 31_000,
  remedy: (pid) => `kill ${pid ?? "<pid>"}`,
};

describe("boundedDown", () => {
  it("a clean stop kills nothing and passes the budget to driver.down", async () => {
    const w = world({
      statuses: [status("web", 201)],
      tables: [[PC, WEB]],
      outcome: { stopped: true },
    });
    expect(await boundedDown(target, w.driver, w.seams)).toEqual({ forceKilled: [] });
    expect(w.downs).toEqual([31_000]);
    expect(w.kills).toEqual([]);
  });

  it("skips the process-table read when no service reports a pid", async () => {
    const w = world({ statuses: [status("web")], tables: [[PC]], outcome: { stopped: true } });
    await boundedDown(target, w.driver, w.seams);
    expect(w.tableReads()).toBe(0);
  });

  it("on timeout SIGKILLs only the snapshot services still alive, by process group", async () => {
    // `api` stopped in time; `web` is stuck. The shutdown hook (203) and the
    // supervisor (100) are never touched.
    const w = world({
      statuses: [status("web", 201), status("api", 202)],
      tables: [
        [PC, WEB, API],
        [PC, WEB, HOOK],
      ],
      outcome: { stopped: false, reason: "timeout" },
    });
    const result = await boundedDown(target, w.driver, w.seams);
    expect(result).toEqual({ forceKilled: [{ service: "web", pid: 201 }] });
    expect(w.kills).toEqual([[-201, "SIGKILL"]]);
  });

  it("kills a process that does not lead its own group by pid only", async () => {
    const web = { ...WEB, pgid: 100 };
    const w = world({
      statuses: [status("web", 201)],
      tables: [[PC, web]],
      outcome: { stopped: false, reason: "timeout" },
    });
    await boundedDown(target, w.driver, w.seams);
    expect(w.kills).toEqual([[201, "SIGKILL"]]);
  });

  it("never kills a pid reused since the snapshot", async () => {
    const w = world({
      statuses: [status("web", 201)],
      tables: [
        [PC, WEB],
        [PC, { ...WEB, command: "vim notes" }],
      ],
      outcome: { stopped: false, reason: "timeout" },
    });
    expect(await boundedDown(target, w.driver, w.seams)).toEqual({ forceKilled: [] });
    expect(w.kills).toEqual([]);
  });

  it("leaves a process that exited between the read and the kill out of force_killed", async () => {
    const w = world({
      statuses: [status("web", 201)],
      tables: [[PC, WEB]],
      outcome: { stopped: false, reason: "timeout" },
      killThrows: true,
    });
    expect(await boundedDown(target, w.driver, w.seams)).toEqual({ forceKilled: [] });
  });

  it("throws DOWN_TIMEOUT naming the stuck services and the process-compose pid when it never exits", async () => {
    const w = world({
      statuses: [status("web", 201)],
      tables: [[PC, WEB]],
      outcome: { stopped: false, reason: "timeout" },
      alive: (pid) => pid === 100,
    });
    const err = await boundedDown(target, w.driver, w.seams).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DownTimeoutError);
    const timeout = err as DownTimeoutError;
    expect(timeout.code).toBe("DOWN_TIMEOUT");
    expect(timeout.details).toEqual({
      instance: "login-1234",
      socket_path: SOCK,
      timeout_ms: 31_000,
      process_compose_pid: 100,
      stuck_services: [{ service: "web", pid: 201 }],
      force_killed: [{ service: "web", pid: 201 }],
      remedy: "kill 100",
    });
    expect(timeout.message).toMatch(/did not stop within 31s/);
    expect(timeout.message).toMatch(/process-compose \(pid 100\) has not exited/);
    expect(timeout.message).toMatch(/web \(pid 201\)/);
    expect(timeout.message).toMatch(/socket and derived config were kept/);
    // Only the service was killed: never the supervisor itself.
    expect(w.kills).toEqual([[-201, "SIGKILL"]]);
  });

  it("with no snapshot (wedged process list) and a live supervisor, fails DOWN_TIMEOUT without killing", async () => {
    const w = world({
      statuses: new Error("process list did not answer within 5s"),
      tables: [[PC, WEB]],
      outcome: { stopped: false, reason: "timeout" },
      alive: (pid) => pid === 100,
    });
    const err = (await boundedDown(target, w.driver, w.seams).catch((e: unknown) => e)) as
      | DownTimeoutError
      | undefined;
    expect(err?.code).toBe("DOWN_TIMEOUT");
    expect(err?.details.process_compose_pid).toBe(100);
    expect(err?.details.stuck_services).toEqual([]);
    expect(err?.message).toMatch(/No service process devtrees recorded was still running/);
    expect(w.kills).toEqual([]);
  });

  it("without a known supervisor pid, waits for the control socket to go away", async () => {
    let polls = 0;
    const w = world({ tables: [[]], outcome: { stopped: false, reason: "timeout" } });
    const result = await boundedDown(target, w.driver, {
      ...w.seams,
      exists: () => ++polls < 3,
    });
    expect(result).toEqual({ forceKilled: [] });
    expect(polls).toBe(3);
  });

  it("propagates a failing process-compose down unchanged", async () => {
    const w = world({ tables: [[]], outcome: { stopped: true } });
    const driver: StopDriver = {
      ...w.driver,
      down: () => Promise.reject(new Error("process-compose down exited with code 1")),
    };
    await expect(boundedDown(target, driver, w.seams)).rejects.toThrow(/exited with code 1/);
  });
});

describe("boundedDown with a pending reload (#206)", () => {
  /** The new `web` copy process-compose starts once the old run is gone. */
  const NEW: ProcessRow = { pid: 401, ppid: 100, pgid: 401, command: "bash -c tail -f hold-b" };
  const PENDING = { services: ["web"], oldRuns: [OLD_RUN] };

  /**
   * A live instance whose pending update finishes once the old run dies:
   * from then on `web` is listed again as NEW. `oldSurvives` keeps the old
   * run alive and unlisted (a kill that does not take).
   */
  function pendingWorld(opts: { outcome: DownOutcome; pcExits?: boolean; oldSurvives?: boolean }) {
    const events: string[] = [];
    let oldAlive = true;
    const driver: StopDriver = {
      getServiceStatuses: async () =>
        oldAlive ? [status("api", 202)] : [status("web", 401), status("api", 202)],
      down: async () => {
        events.push("down");
        return opts.outcome;
      },
    };
    const seams = {
      readProcessTable: async () => [PC, API, ...(oldAlive ? [OLD] : [NEW])],
      kill: (target: number) => {
        events.push(`kill ${target}`);
        if (target === -301 && !opts.oldSurvives) oldAlive = false;
      },
      isAlive: (pid: number) => (pid === 301 ? oldAlive : pid === 100 && !opts.pcExits),
      exists: () => false,
      graceMs: 30,
      pollMs: 2,
      settleMs: 50,
    };
    return { driver, seams, events };
  }

  it("kills the old run before the stop, waits for the new copy, and reports it", async () => {
    const w = pendingWorld({ outcome: { stopped: true } });
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(result).toEqual({ forceKilled: [{ service: "web", pid: 301 }] });
    // Before `process-compose down`, by process group.
    expect(w.events).toEqual(["kill -301", "down"]);
  });

  it("the stop's own escalation then covers the new copy", async () => {
    const w = pendingWorld({ outcome: { stopped: false, reason: "timeout" }, pcExits: true });
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(result.forceKilled).toEqual([
      { service: "web", pid: 301 },
      { service: "web", pid: 401 },
      { service: "api", pid: 202 },
    ]);
  });

  it("never kills a pending old pid once it is reused", async () => {
    const w = pendingWorld({ outcome: { stopped: true } });
    const reused = {
      ...w.seams,
      readProcessTable: async () => [PC, { ...OLD, command: "vim notes" }],
    };
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, reused);
    expect(result).toEqual({ forceKilled: [] });
    expect(w.events).toEqual(["down"]);
  });

  it("gives up waiting after settleMs and stops anyway", async () => {
    const w = pendingWorld({ outcome: { stopped: true }, oldSurvives: true });
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(result).toEqual({ forceKilled: [{ service: "web", pid: 301 }] });
    expect(w.events).toEqual(["kill -301", "down"]);
  });

  it("does not wait on a service the reload removed", async () => {
    const w = pendingWorld({ outcome: { stopped: true } });
    const removed = { services: [], oldRuns: [OLD_RUN] };
    const slow = { ...w.seams, settleMs: 60_000 };
    const result = await boundedDown({ ...target, pendingReload: removed }, w.driver, slow);
    expect(result.forceKilled).toEqual([{ service: "web", pid: 301 }]);
  });

  it("names an unverified old run in the DOWN_TIMEOUT remedy instead of killing it", async () => {
    const w = pendingWorld({ outcome: { stopped: false, reason: "timeout" } });
    const legacy = { services: ["web"], oldRuns: [{ name: "web", pid: 301 }] };
    const err = (await boundedDown({ ...target, pendingReload: legacy }, w.driver, w.seams).catch(
      (e: unknown) => e,
    )) as DownTimeoutError;
    expect(err.code).toBe("DOWN_TIMEOUT");
    expect(err.details.force_killed).toEqual([{ service: "api", pid: 202 }]);
    expect(err.details.remedy).toMatch(/waiting on web \(pid 301\)/);
    expect(err.message).toContain("web (pid 301)");
    expect(w.events).not.toContain("kill -301");
  });
});
