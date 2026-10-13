/**
 * Bounded per-service stop (`devtrees stop`, #223): one `process stop`
 * request, the wait for the exit, the SIGKILL of what is still the same
 * process after the budget, and the refusal handling. Every effect is a
 * seam, so no real process is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ProcessRow, StopSeams } from "./bounded-down.js";
import { boundedStopServices, StopRefusedError, type ServiceStopDriver } from "./bounded-stop.js";
import type { ServiceStatus } from "./driver.js";

const SOCK = "/tmp/devtrees-501/abc/login-1234.sock";
const PC: ProcessRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  command: `process-compose up -f /a/login.yaml -U -u ${SOCK} -t=false -n default`,
};
const WEB: ProcessRow = { pid: 201, ppid: 100, pgid: 201, command: "bash -c tail -f hold" };
const API: ProcessRow = { pid: 202, ppid: 100, pgid: 202, command: "sleep 300" };

function status(name: string, pid?: number): ServiceStatus {
  return { name, status: "Running", health: "unknown", ...(pid !== undefined ? { pid } : {}) };
}

describe("boundedStopServices (#223)", () => {
  /**
   * A world where `web` (201) and `api` (202) run under process-compose
   * (100). `process stop` marks each named service `Completed` (exit -1)
   * and removes its process, unless it is `stuck` (a `shutdown.command`
   * that exits without stopping it: process-compose shows it `Terminating`
   * until devtrees kills it).
   */
  function stopWorld(opts: { stuck?: ReadonlyArray<string>; refuse?: string } = {}) {
    const rows = new Map<string, ServiceStatus>([
      ["web", status("web", 201)],
      ["api", status("api", 202)],
    ]);
    let table: ProcessRow[] = [PC, WEB, API];
    const stopCalls: string[][] = [];
    const kills: Array<[number, NodeJS.Signals]> = [];
    const pidOf = new Map([
      ["web", 201],
      ["api", 202],
    ]);
    const exit = (name: string) => {
      const pid = pidOf.get(name);
      table = table.filter((r) => r.pid !== pid);
      rows.set(name, { ...rows.get(name)!, status: "Completed", exitCode: -1 });
    };
    const driver: ServiceStopDriver = {
      stopProcesses: async (_sock, names) => {
        stopCalls.push([...names]);
        if (opts.refuse !== undefined) return { ok: false, message: opts.refuse };
        for (const name of names) {
          if (opts.stuck?.includes(name))
            rows.set(name, { ...rows.get(name)!, status: "Terminating" });
          else exit(name);
        }
        return { ok: true };
      },
      getServiceStatuses: async () => [...rows.values()],
    };
    const seams: StopSeams = {
      readProcessTable: async () => table,
      kill: (target, signal) => {
        kills.push([target, signal]);
        const name = [...pidOf].find(([, pid]) => pid === Math.abs(target))?.[0];
        if (name !== undefined) exit(name);
      },
      isAlive: (pid) => table.some((r) => r.pid === pid),
      pollMs: 1,
      graceMs: 50,
      treeGraceMs: 20,
    };
    return { driver, seams, stopCalls, kills, rows, exit };
  }

  const target = (services: string[], world: { rows: Map<string, ServiceStatus> }) => ({
    socketPath: SOCK,
    services,
    statuses: [...world.rows.values()],
    timeoutMs: 30,
  });

  it("stops only the named services in one request and kills nothing when they exit", async () => {
    const w = stopWorld();
    const result = await boundedStopServices(target(["web"], w), w.driver, w.seams);
    expect(w.stopCalls).toEqual([["web"]]);
    expect(result).toEqual({ forceKilled: [], survivors: [], unsettled: [] });
    expect(w.kills).toEqual([]);
    expect(w.rows.get("api")?.status).toBe("Running");
  });

  it("SIGKILLs the group of a service still Terminating after the budget, and reports it", async () => {
    const w = stopWorld({ stuck: ["web"] });
    const result = await boundedStopServices(target(["web"], w), w.driver, w.seams);
    expect(w.kills).toEqual([[-201, "SIGKILL"]]);
    expect(result.forceKilled).toEqual([{ service: "web", pid: 201 }]);
    expect(result.unsettled).toEqual([]);
    // api was never signalled.
    expect(w.kills.some(([t]) => Math.abs(t) === 202)).toBe(false);
  });

  it("reports a service process-compose still shows active when nothing verifiable was left to kill", async () => {
    const w = stopWorld({ stuck: ["web"] });
    // `ps` shows nothing: devtrees cannot verify web's process, so it kills none.
    const seams = { ...w.seams, readProcessTable: async () => [] };
    const result = await boundedStopServices(target(["web"], w), w.driver, seams);
    expect(w.kills).toEqual([]);
    expect(result.unsettled).toEqual([{ service: "web", pid: 201 }]);
  });

  it("throws StopRefusedError when process-compose refuses a service it still runs", async () => {
    const w = stopWorld({ refuse: "Failed to stop: 'web'" });
    await expect(boundedStopServices(target(["web"], w), w.driver, w.seams)).rejects.toThrow(
      StopRefusedError,
    );
    expect(w.kills).toEqual([]);
  });

  it("accepts a refusal for a service that stopped meanwhile (idempotent)", async () => {
    const w = stopWorld({ refuse: "Failed to stop: 'web'" });
    w.exit("web");
    const result = await boundedStopServices(target(["web"], w), w.driver, w.seams);
    expect(result).toEqual({ forceKilled: [], survivors: [], unsettled: [] });
  });
});
