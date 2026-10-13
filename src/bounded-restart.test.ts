/**
 * `boundedRestart` (#222): one running service restarted in place as
 * `stop`'s bounded stop, then a start. Every effect (process-compose calls,
 * `ps`, kill, liveness) is a seam, so no real process is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ProcessRow } from "./bounded-down.js";
import { boundedRestart, type RestartDriver, type RestartTarget } from "./bounded-restart.js";
import type { ServiceStatus, StartResult } from "./driver.js";

const SOCK = "/tmp/devtrees-501/abc/login-1234.sock";
const T0 = "Tue Oct 13 14:06:00 2026";
const PC: ProcessRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  command: `process-compose up -f /a/login.yaml -U -u ${SOCK} -t=false -n default`,
};
/** `mobile`'s run before the restart: a wrapper leading its group, and Metro. */
const MOBILE: ProcessRow = { pid: 201, ppid: 100, pgid: 201, command: "sh -c metro", started: T0 };
const METRO: ProcessRow = { pid: 501, ppid: 201, pgid: 201, command: "node metro", started: T0 };

const running = (name: string, pid: number): ServiceStatus => ({
  name,
  status: "Running",
  health: "unknown",
  pid,
  running: true,
});
const stopped = (name: string, pid: number): ServiceStatus => ({
  name,
  status: "Completed",
  health: "unknown",
  exitCode: -1,
  pid,
  running: false,
});

/**
 * A scripted instance. Once stopped, `mobile`'s old run (`MOBILE`, and
 * `METRO` unless `metroLingers`) exits on its own after `drainReads`
 * `process list` reads, or never with `ignoresStop` (until SIGKILLed).
 * process-compose lists `mobile` `Terminating` while the old leader lives,
 * `Completed` after, and `Running` with a new pid once started. While it
 * reads `Terminating`, a start is refused as "already running".
 */
function world(
  opts: {
    readonly drainReads?: number;
    readonly ignoresStop?: boolean;
    readonly metroLingers?: boolean;
    readonly stop?: { readonly ok: true } | { readonly ok: false; readonly message: string };
    readonly start?: StartResult;
    /** The restart policy brings a new run up on its own once the old one is gone. */
    readonly policyRestarts?: boolean;
    /** process-compose exits once the stop is requested. */
    readonly exitsOnStop?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const signals: Array<[number, string]> = [];
  const alive = new Set([MOBILE.pid, METRO.pid]);
  let stopRequested = false;
  let reads = 0;
  let mobile: ServiceStatus = running("mobile", 201);
  const drains = !opts.ignoresStop;
  const exiting = new Set(opts.metroLingers ? [MOBILE.pid] : [MOBILE.pid, METRO.pid]);
  const afterExit = () => (opts.policyRestarts ? running("mobile", 303) : stopped("mobile", 201));
  /** One `process list` read: the old run drains, then process-compose sees it gone. */
  const listed = (): ServiceStatus => {
    const drained = stopRequested && drains && ++reads > (opts.drainReads ?? 0);
    if (drained) for (const pid of exiting) alive.delete(pid);
    if (mobile.pid !== 201 || !stopRequested) return mobile;
    if (alive.has(MOBILE.pid)) return { ...mobile, status: "Terminating" };
    mobile = afterExit();
    return mobile;
  };
  const driver: RestartDriver = {
    stopProcesses: async (_s, names) => {
      calls.push(`stop ${names.join(" ")}`);
      const result = opts.stop ?? { ok: true };
      if (result.ok) stopRequested = true;
      return result;
    },
    startProcess: async (_s, name) => {
      const state = listed();
      calls.push(`start ${name} (old run alive: ${alive.has(MOBILE.pid)}, ${state.status})`);
      if (opts.start !== undefined) return opts.start;
      if (state.status !== "Completed") return { ok: true, alreadyRunning: true };
      mobile = running("mobile", 302);
      return { ok: true, alreadyRunning: false };
    },
    getServiceStatuses: async () => {
      if (opts.exitsOnStop === true && stopRequested) throw new Error("dial unix: no such file");
      return [listed(), running("api", 202)];
    },
  };
  const seams = {
    readProcessTable: async () => [PC, ...[MOBILE, METRO].filter((r) => alive.has(r.pid))],
    kill: (target: number, sig: NodeJS.Signals) => {
      signals.push([target, sig]);
      if (sig === "SIGKILL") alive.clear();
    },
    isAlive: (pid: number) => alive.has(pid),
    pollMs: 1,
    graceMs: 20,
    treeGraceMs: 20,
  };
  const target: RestartTarget = {
    socketPath: SOCK,
    service: "mobile",
    statuses: [running("mobile", 201), running("api", 202)],
    timeoutMs: 50,
    instance: "login-1234",
    instanceGone: async () => opts.exitsOnStop === true,
  };
  return { driver, seams, calls, signals, target };
}

const STARTED = "start mobile (old run alive: false, Completed)";

describe("boundedRestart (#222)", () => {
  it("stops, waits for a draining old run to exit by itself, then starts: never two runs at once", async () => {
    const w = world({ drainReads: 3 });
    const result = await boundedRestart(w.target, w.driver, w.seams);
    expect(result).toEqual({ ok: true, forceKilled: [], survivors: [] });
    expect(w.calls).toEqual(["stop mobile", STARTED]);
    expect(w.signals).toEqual([]);
  });

  it("SIGKILLs an old run that outlives the stop's budget, then starts", async () => {
    const w = world({ ignoresStop: true });
    const result = await boundedRestart(w.target, w.driver, w.seams);
    expect(w.signals).toEqual([[-201, "SIGKILL"]]);
    expect(result).toMatchObject({ ok: true, forceKilled: [{ service: "mobile", pid: 201 }] });
    expect(w.calls.at(-1)).toBe(STARTED);
  });

  it("an unsignalled group (a shutdown.command, parent_only): SIGTERM first for what outlives the leader", async () => {
    const w = world({ metroLingers: true });
    const result = await boundedRestart(
      { ...w.target, unsignalled: new Set(["mobile"]) },
      w.driver,
      w.seams,
    );
    expect(w.signals[0]).toEqual([501, "SIGTERM"]);
    expect(result).toMatchObject({ ok: true, forceKilled: [{ service: "mobile", pid: 501 }] });
  });

  it("a refused stop of a service still running touches nothing", async () => {
    const w = world({ stop: { ok: false, message: "nope" } });
    expect(await boundedRestart(w.target, w.driver, w.seams)).toEqual({
      ok: false,
      message: "nope",
    });
    expect(w.calls).toEqual(["stop mobile"]);
    expect(w.signals).toEqual([]);
  });

  it("process-compose exiting during the stop is INSTANCE_NOT_FOUND, never a start", async () => {
    const w = world({ exitsOnStop: true });
    await expect(boundedRestart(w.target, w.driver, w.seams)).rejects.toMatchObject({
      code: "INSTANCE_NOT_FOUND",
      message: expect.stringMatching(/^devtrees restart: process-compose exited while mobile/),
    });
    expect(w.calls).toEqual(["stop mobile"]);
  });

  it("an old run still listed active after the escalation is a failure: nothing was started", async () => {
    const w = world({ ignoresStop: true });
    const seams = { ...w.seams, kill: () => {} };
    expect(await boundedRestart(w.target, w.driver, seams)).toEqual({
      ok: false,
      message:
        "process-compose still lists the old run of 'mobile' (pid 201) as still active after " +
        "the stop, so nothing was started",
    });
    expect(w.calls).toEqual(["stop mobile"]);
  });

  it("'already running' with the old run listed again is a failure: nothing was started", async () => {
    const w = world();
    let afterStart = false;
    const driver: RestartDriver = {
      ...w.driver,
      startProcess: async () => {
        afterStart = true;
        return { ok: true, alreadyRunning: true };
      },
      getServiceStatuses: async (socket) =>
        afterStart ? [running("mobile", 201)] : w.driver.getServiceStatuses(socket),
    };
    expect(await boundedRestart(w.target, driver, w.seams)).toEqual({
      ok: false,
      message:
        "process-compose still lists the old run of 'mobile' (pid 201) as Running after the " +
        "stop, so nothing was started",
    });
  });

  it("a new run its restart policy brought up during the stop is the restart: no second start", async () => {
    const w = world({ policyRestarts: true });
    expect((await boundedRestart(w.target, w.driver, w.seams)).ok).toBe(true);
    expect(w.calls).toEqual(["stop mobile"]);
  });

  it("a new run from the restart policy after a force-kill still reports what was force-killed", async () => {
    const w = world({ policyRestarts: true, ignoresStop: true });
    const result = await boundedRestart(w.target, w.driver, w.seams);
    expect(result).toMatchObject({ ok: true, forceKilled: [{ service: "mobile", pid: 201 }] });
    expect(w.calls).toEqual(["stop mobile"]);
  });

  it("'already running' with a new run listed is a success", async () => {
    const w = world();
    let afterStart = false;
    const driver: RestartDriver = {
      ...w.driver,
      startProcess: async () => {
        afterStart = true;
        return { ok: true, alreadyRunning: true };
      },
      getServiceStatuses: async (socket) =>
        afterStart ? [running("mobile", 304)] : w.driver.getServiceStatuses(socket),
    };
    expect((await boundedRestart(w.target, driver, w.seams)).ok).toBe(true);
  });

  it("a stopped service is simply started: no stop, no process-table read", async () => {
    const w = world();
    let tableReads = 0;
    const seams = {
      ...w.seams,
      readProcessTable: async () => {
        tableReads++;
        return [];
      },
    };
    const result = await boundedRestart(
      { ...w.target, statuses: [stopped("mobile", 201), running("api", 202)] },
      w.driver,
      seams,
    );
    expect(result.ok).toBe(true);
    expect(w.calls).toEqual(["start mobile (old run alive: true, Running)"]);
    expect(tableReads).toBe(0);
  });

  it("a start whose client timed out counts when the service now reads running", async () => {
    const w = world();
    const driver: RestartDriver = {
      ...w.driver,
      startProcess: async (socket, name) => {
        await w.driver.startProcess(socket, name);
        return { ok: false, message: "slow", timedOut: true };
      },
    };
    expect((await boundedRestart(w.target, driver, w.seams)).ok).toBe(true);
  });

  it("a start whose client timed out, with nothing running after, is a failure", async () => {
    const w = world({ start: { ok: false, message: "slow", timedOut: true } });
    expect(await boundedRestart(w.target, w.driver, w.seams)).toMatchObject({ ok: false });
  });

  it("a refused start is a failure", async () => {
    const w = world({ start: { ok: false, message: "refused" } });
    expect(await boundedRestart(w.target, w.driver, w.seams)).toEqual({
      ok: false,
      message: "refused",
    });
  });
});
