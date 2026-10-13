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
  readSupervisedTable,
  snapshotServiceProcesses,
  stillRunning,
  type ProcessRow,
  type StopDriver,
  type StopTarget,
} from "./bounded-down.js";
import type { DownOutcome, ServiceStatus } from "./driver.js";
import type { OldRun, PendingReload } from "./reload-pending.js";

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

  it("never kills a run process-compose still lists (its update is only queued)", () => {
    // It is not stuck: process-compose stops it, shutdown.command included.
    expect(pendingRunsToKill([OLD_RUN], [status("web", 301)], [PC, OLD], 100)).toEqual([]);
    expect(pendingRunsToKill([OLD_RUN], [{ pid: 301 }], [PC, OLD], 100)).toEqual([]);
  });

  it("lists each pid once", () => {
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
  /** The new `api` copy, started once process-compose has stopped API itself. */
  const API_NEW: ProcessRow = { pid: 402, ppid: 100, pgid: 402, command: "sleep 301" };
  /** `api`'s old run: changed too, but its update is still queued, so it is still listed. */
  const API_RUN: OldRun = {
    name: "api",
    pid: 202,
    identity: { ppid: 100, pgid: 202, command: API.command },
  };
  const PENDING = { services: ["web"], oldRuns: [OLD_RUN] };
  const BOTH = { services: ["web", "api"], oldRuns: [OLD_RUN, API_RUN] };

  /**
   * process-compose applying a reload's updates one at a time. `web`'s
   * update is blocked on its old run (OLD: alive, unlisted). Once OLD dies,
   * `web` is listed again as NEW `lag` `process list` polls later. With
   * `apiQueued`, `api`'s update comes next: API stays listed for `lag` more
   * polls, then process-compose stops it itself (`graceful 202`), drops it
   * from the list, and lists API_NEW `lag` polls later (`apiLag`, when
   * given). `oldSurvives` keeps OLD alive (a kill that does not take);
   * `psFails` empties that many `ps` reads.
   */
  function pendingWorld(
    opts: {
      outcome?: DownOutcome;
      pcExits?: boolean;
      oldSurvives?: boolean;
      lag?: number;
      apiQueued?: boolean;
      apiLag?: number;
      psFails?: number;
    } = {},
  ) {
    const events: string[] = [];
    const alive = new Set([100, 202, 301]);
    const lag = opts.lag ?? 0;
    let webIn = -1;
    let apiQueuedFor = 0;
    let apiIn = -1;
    let downCalled = false;
    let psFails = opts.psFails ?? 0;
    let tableReads = 0;
    const advanceWeb = (): void => {
      if (!alive.has(301) && webIn === -1) webIn = lag;
      else if (webIn > 0) webIn--;
      if (webIn === 0 && !alive.has(401)) {
        alive.add(401);
        events.push("web listed as 401");
      }
    };
    const advanceApi = (): void => {
      if (apiQueuedFor < lag) {
        apiQueuedFor++;
        return;
      }
      if (apiIn === -1) {
        apiIn = opts.apiLag ?? lag;
        alive.delete(202);
        events.push("graceful 202");
      } else if (apiIn > 0) apiIn--;
      if (apiIn === 0 && !alive.has(402)) {
        alive.add(402);
        events.push("api listed as 402");
      }
    };
    const advance = (): void => {
      advanceWeb();
      if (opts.apiQueued && alive.has(401)) advanceApi();
    };
    const driver: StopDriver = {
      getServiceStatuses: async () => {
        advance();
        const web = alive.has(401) ? [status("web", 401)] : [];
        const api = alive.has(402)
          ? [status("api", 402)]
          : alive.has(202)
            ? [status("api", 202)]
            : [];
        return [...web, ...api];
      },
      down: async () => {
        events.push("down");
        downCalled = true;
        return opts.outcome ?? { stopped: true };
      },
    };
    const rows = [PC, API, OLD, NEW, API_NEW];
    const seams = {
      readProcessTable: async () => {
        tableReads++;
        if (psFails > 0) {
          psFails--;
          return [];
        }
        return rows.filter((row) => alive.has(row.pid));
      },
      kill: (target: number) => {
        events.push(`kill ${target}`);
        if (target === -301 && !opts.oldSurvives) alive.delete(301);
        if (target === -202) alive.delete(202);
      },
      isAlive: (pid: number) => (pid === 100 ? !(downCalled && opts.pcExits) : alive.has(pid)),
      exists: () => false,
      graceMs: 30,
      pollMs: 2,
      settleMs: 200,
    };
    return { driver, seams, events, tableReads: () => tableReads };
  }

  /** Run `boundedDown` and return the `DOWN_TIMEOUT` it throws. */
  async function downTimeout(
    pending: PendingReload,
    w: ReturnType<typeof pendingWorld>,
  ): Promise<DownTimeoutError> {
    const err: unknown = await boundedDown({ ...target, pendingReload: pending }, w.driver, w.seams)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownTimeoutError);
    return err as DownTimeoutError;
  }

  it("kills the stuck old run before the stop, by process group, and reports it", async () => {
    const w = pendingWorld();
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(result).toEqual({ forceKilled: [{ service: "web", pid: 301 }] });
    expect(w.events).toEqual(["kill -301", "web listed as 401", "down"]);
  });

  it("starts the stop only once the update lists the new copy, however long that takes", async () => {
    const w = pendingWorld({ lag: 5 });
    await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(w.events).toEqual(["kill -301", "web listed as 401", "down"]);
  });

  it("leaves a queued service's listed old run to process-compose, and waits for its update", async () => {
    // `api` changed too, but process-compose has not reached its update: its
    // old run is listed and healthy, and must get its shutdown.command.
    const w = pendingWorld({ apiQueued: true, lag: 3 });
    const result = await boundedDown({ ...target, pendingReload: BOTH }, w.driver, w.seams);
    expect(result).toEqual({ forceKilled: [{ service: "web", pid: 301 }] });
    expect(w.events).not.toContain("kill -202");
    expect(w.events).toEqual([
      "kill -301",
      "web listed as 401",
      "graceful 202",
      "api listed as 402",
      "down",
    ]);
  });

  it("waits on a service whose old run it did not kill, even with nothing to kill", async () => {
    // web's stuck run already exited on its own; api's update is still queued.
    const w = pendingWorld({ apiQueued: true, lag: 3 });
    w.seams.kill(-301);
    w.events.length = 0;
    await boundedDown({ ...target, pendingReload: BOTH }, w.driver, w.seams);
    expect(w.events).toEqual(["web listed as 401", "graceful 202", "api listed as 402", "down"]);
  });

  it("does not start the stop when the update does not finish within settleMs", async () => {
    const w = pendingWorld({ oldSurvives: true });
    const err = await downTimeout(PENDING, w);
    expect(w.events).toEqual(["kill -301"]);
    expect(err.details.pending_reload).toEqual(["web"]);
    expect(err.details.stuck_services).toEqual([{ service: "web", pid: 301 }]);
    expect(err.details.force_killed).toEqual([{ service: "web", pid: 301 }]);
    expect(err.details.timeout_ms).toBe(200);
    expect(err.message).toMatch(/still applying web after 0s, so devtrees did not stop it/);
    expect(err.message).toContain("kill 100");
  });

  it("does not start the stop while a queued update is still running at the deadline", async () => {
    const w = pendingWorld({ apiQueued: true, apiLag: 1_000_000 });
    const err = await downTimeout(BOTH, w);
    expect(w.events).toEqual(["kill -301", "web listed as 401", "graceful 202"]);
    expect(err.details.pending_reload).toEqual(["api"]);
    expect(err.details.stuck_services).toEqual([]);
  });

  it("retries an empty ps read before deciding what to kill", async () => {
    const w = pendingWorld({ psFails: 2 });
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(result.forceKilled).toEqual([{ service: "web", pid: 301 }]);
    expect(w.events).toEqual(["kill -301", "web listed as 401", "down"]);
  });

  it("when ps keeps failing, kills nothing, never starts the stop, and names the old run", async () => {
    const w = pendingWorld({ psFails: 1_000_000 });
    const err = await downTimeout(PENDING, w);
    expect(w.events).toEqual([]);
    expect(err.details.force_killed).toEqual([]);
    expect(err.details.stuck_services).toEqual([{ service: "web", pid: 301 }]);
    expect(err.details.remedy).toMatch(
      /could not verify web \(pid 301\) as the service.s old process/,
    );
  });

  it("never kills an old run it cannot verify, and names it instead", async () => {
    const w = pendingWorld();
    const legacy = { services: ["web"], oldRuns: [{ name: "web", pid: 301 }] };
    const err = await downTimeout(legacy, w);
    expect(w.events).toEqual([]);
    expect(err.details.remedy).toMatch(/could not verify web \(pid 301\)/);
    expect(err.message).toContain("web (pid 301)");
  });

  it("never kills a pending old run once the stop has begun", async () => {
    // Even one that shows up stuck again at the escalation: killing it then
    // lets the update start a new copy after the shutdown order was fixed.
    const w = pendingWorld({ outcome: { stopped: false, reason: "timeout" }, pcExits: true });
    let downSeen = false;
    const driver: StopDriver = {
      ...w.driver,
      down: async (inst, o) => {
        downSeen = true;
        return w.driver.down(inst, o);
      },
    };
    const seams = {
      ...w.seams,
      readProcessTable: async () => (downSeen ? [PC, API, NEW, OLD] : w.seams.readProcessTable()),
    };
    const result = await boundedDown({ ...target, pendingReload: PENDING }, driver, seams);
    expect(w.events.filter((e) => e === "kill -301")).toHaveLength(1);
    expect(w.events.indexOf("kill -301")).toBeLessThan(w.events.indexOf("down"));
    expect(result.forceKilled).toContainEqual({ service: "web", pid: 401 });
  });

  it("the stop's own escalation then covers the new copies", async () => {
    const w = pendingWorld({ outcome: { stopped: false, reason: "timeout" }, pcExits: true });
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(result.forceKilled).toEqual([
      { service: "web", pid: 301 },
      { service: "web", pid: 401 },
      { service: "api", pid: 202 },
    ]);
  });

  it("never kills a pending old pid once it is reused", async () => {
    const w = pendingWorld();
    const reused = {
      ...w.seams,
      readProcessTable: async () => [PC, API, NEW, { ...OLD, command: "vim notes" }],
      isAlive: (pid: number) => pid === 100 || pid === 202 || pid === 401,
    };
    const relisted: StopDriver = {
      ...w.driver,
      getServiceStatuses: async () => [status("web", 401), status("api", 202)],
    };
    const result = await boundedDown({ ...target, pendingReload: PENDING }, relisted, reused);
    expect(result).toEqual({ forceKilled: [] });
    expect(w.events).toEqual(["down"]);
  });

  it("does not wait for a service the reload removed to come back", async () => {
    const w = pendingWorld({ lag: 1_000_000 });
    const removed = { services: [], oldRuns: [OLD_RUN] };
    const result = await boundedDown({ ...target, pendingReload: removed }, w.driver, w.seams);
    expect(result.forceKilled).toEqual([{ service: "web", pid: 301 }]);
    expect(w.events).toEqual(["kill -301", "down"]);
  });

  it("with nothing pending, shares one ps read between step 0 and the snapshot", async () => {
    const w = pendingWorld();
    w.seams.kill(-301);
    await w.driver.getServiceStatuses(SOCK); // the update lists web again
    w.events.length = 0;
    const result = await boundedDown({ ...target, pendingReload: PENDING }, w.driver, w.seams);
    expect(result).toEqual({ forceKilled: [] });
    expect(w.events).toEqual(["down"]);
    expect(w.tableReads()).toBe(1);
  });
});

describe("readSupervisedTable", () => {
  it("retries a read that is empty or lacks the supervisor, up to its attempts", async () => {
    const reads = [[], [API], [PC, API]];
    let i = 0;
    const read = async () => reads[i++] ?? [];
    expect(await readSupervisedTable(read, SOCK, { delayMs: 0 })).toEqual({
      table: [PC, API],
      supervisorPid: 100,
    });
    expect(i).toBe(3);
  });

  it("returns the last read once the attempts run out", async () => {
    let i = 0;
    const read = async () => {
      i++;
      return [];
    };
    expect(await readSupervisedTable(read, SOCK, { attempts: 2, delayMs: 0 })).toEqual({
      table: [],
      supervisorPid: undefined,
    });
    expect(i).toBe(2);
  });
});
