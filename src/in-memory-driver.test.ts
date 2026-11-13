/**
 * The in-memory process-compose's own behaviour, beyond the Driver contract
 * both adapters share (src/driver.contract.test.ts): what the `.mjs` stub
 * does not model, checked against what process-compose v1.122.0 does
 * (ADR-0009, #174, #178, #223, #239).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { InstanceRef } from "./driver.js";
import { createInMemoryProcessCompose, type PcRequest } from "./in-memory-driver.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const proc = (extra: Record<string, unknown> = {}) => ({ command: "sleep 30", ...extra });

function instance(processes: Record<string, unknown>): InstanceRef {
  const root = mkdtempSync(join(tmpdir(), "dt-inmem-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const inst = { configPath: join(root, "wt.yaml"), socketPath: join(root, "run", "wt.sock") };
  writeFileSync(inst.configPath, stringifyYaml({ processes }));
  return inst;
}

async function booted(processes: Record<string, unknown>, namespaces: string[] = []) {
  const requests: PcRequest[] = [];
  const pc = createInMemoryProcessCompose({ firstPid: 11, onRequest: (r) => requests.push(r) });
  const inst = instance(processes);
  await pc.driver.up(inst, namespaces);
  return { pc, inst, sock: inst.socketPath, requests };
}

describe("in-memory process-compose", () => {
  it("hands each run a new pid: after a stop and a start, the process runs with a new pid", async () => {
    const { pc, sock } = await booted({ api: proc(), worker: proc() });
    expect(pc.pidOf(sock, "api")).toBe(11);
    expect(pc.pidOf(sock, "worker")).toBe(12);
    await pc.driver.stopProcesses(sock, ["api"]);
    expect(pc.rows(sock).find((r) => r.name === "api")).toMatchObject({ pid: 11, running: false });
    await pc.driver.startProcess(sock, "api");
    expect(pc.rows(sock).find((r) => r.name === "api")).toMatchObject({
      status: "Running",
      pid: 13,
      running: true,
    });
  });

  it("refuses to start a running process as already running, and an unknown one", async () => {
    const { pc, sock } = await booted({ api: proc(), worker: proc() });
    expect(await pc.driver.startProcess(sock, "api")).toEqual({ ok: true, alreadyRunning: true });
    expect(await pc.driver.startProcess(sock, "nope")).toEqual({
      ok: false,
      message: 'FTL failed to start process nope error="no such process: nope"',
    });
    expect(pc.pidOf(sock, "api")).toBe(11);
  });

  it("refuses to stop a process that is not running, touching nothing", async () => {
    const { pc, sock } = await booted({ api: proc(), worker: proc(), web: proc() });
    pc.exit(sock, "worker", 0);
    expect(await pc.driver.stopProcesses(sock, ["api", "worker"])).toEqual({
      ok: false,
      message: "Failed to stop process worker",
    });
    expect(pc.rows(sock).find((r) => r.name === "api")?.running).toBe(true);
  });

  it("exits once nothing runs: stopping the last running process takes the instance and its socket", async () => {
    const { pc, sock } = await booted({ api: proc(), seed: proc() });
    pc.exit(sock, "seed", 0);
    expect(pc.isUp(sock)).toBe(true);
    await pc.driver.stopProcesses(sock, ["api"]);
    expect(pc.isUp(sock)).toBe(false);
    expect(existsSync(sock)).toBe(false);
    expect(await pc.probeSocket(sock)).toBe("stale");
    await expect(pc.driver.getServiceStatuses(sock)).rejects.toThrow();
  });

  it("a Skipped or Disabled process holds no run, refuses a stop, and starts on a start (#263)", async () => {
    const { pc, sock } = await booted({ api: proc(), web: proc(), docs: proc() });
    pc.idle(sock, "web", "Skipped");
    pc.idle(sock, "docs", "Disabled");
    expect(pc.rows(sock).filter((r) => r.name !== "api")).toEqual([
      {
        name: "web",
        status: "Skipped",
        health: "unknown",
        exitCode: 1,
        namespaces: ["default"],
        running: false,
      },
      {
        name: "docs",
        status: "Disabled",
        health: "unknown",
        exitCode: 0,
        namespaces: ["default"],
        running: false,
      },
    ]);
    expect(await pc.driver.stopProcesses(sock, ["web"])).toEqual({
      ok: false,
      message: "Failed to stop process web",
    });
    expect(await pc.driver.startProcess(sock, "web")).toEqual({ ok: true, alreadyRunning: false });
    expect(await pc.driver.startProcess(sock, "docs")).toEqual({ ok: true, alreadyRunning: false });
    expect(pc.rows(sock).map((r) => r.status)).toEqual(["Running", "Running", "Running"]);
  });

  it("a Pending process or one in its restart backoff keeps the instance up", async () => {
    const { pc, sock } = await booted({ api: proc(), mobile: proc(), worker: proc() });
    pc.hold(sock, "mobile");
    pc.backoff(sock, "worker");
    await pc.driver.stopProcesses(sock, ["api"]);
    expect(pc.isUp(sock)).toBe(true);
    expect(pc.rows(sock)).toEqual([
      {
        name: "api",
        status: "Completed",
        health: "unknown",
        exitCode: -1,
        namespaces: ["default"],
        pid: 11,
        running: false,
      },
      {
        name: "mobile",
        status: "Pending",
        health: "unknown",
        exitCode: 0,
        namespaces: ["default"],
        running: false,
      },
      {
        name: "worker",
        status: "Restarting",
        health: "unknown",
        exitCode: 0,
        namespaces: ["default"],
        pid: 13,
        running: false,
      },
    ]);
  });

  it("a dead probed process keeps its stale Ready, which reads not_ready (#174)", async () => {
    const probe = { exec: { command: "true" } };
    const { pc, sock } = await booted({ api: proc({ readiness_probe: probe }), worker: proc() });
    expect(pc.rows(sock).find((r) => r.name === "api")?.health).toBe("ready");
    pc.setReady(sock, "api", false);
    expect(pc.rows(sock).find((r) => r.name === "api")?.health).toBe("not_ready");
    pc.setReady(sock, "api", true);
    pc.exit(sock, "api", -1);
    expect(pc.rows(sock).find((r) => r.name === "api")).toMatchObject({
      status: "Completed",
      exitCode: -1,
      health: "not_ready",
    });
  });

  it("the reload restarts a changed process with a new pid, and leaves a stopped unchanged one stopped (#239)", async () => {
    const { pc, inst, sock } = await booted({ api: proc(), worker: proc(), web: proc() });
    await pc.driver.stopProcesses(sock, ["worker"]);
    writeFileSync(
      inst.configPath,
      stringifyYaml({
        processes: { api: proc({ command: "sleep 31" }), worker: proc(), web: proc() },
      }),
    );
    expect(await pc.driver.reloadConfig(inst)).toEqual({ ok: true });
    expect(pc.rows(sock).map((r) => [r.name, r.status, r.pid])).toEqual([
      ["api", "Running", 14],
      ["worker", "Completed", 12],
      ["web", "Running", 13],
    ]);
  });

  it("the reload starts only added processes in the booted namespaces", async () => {
    const { pc, inst, sock } = await booted({ api: proc() }, ["default"]);
    writeFileSync(
      inst.configPath,
      stringifyYaml({ processes: { api: proc(), sim: proc({ namespace: "ios" }), web: proc() } }),
    );
    await pc.driver.reloadConfig(inst);
    expect(pc.rows(sock).map((r) => r.name)).toEqual(["api", "web"]);
  });

  it("a crashed server leaves its socket file behind; the probe reads it stale", async () => {
    const { pc, inst, sock } = await booted({ api: proc() });
    expect(await pc.probeSocket(sock)).toBe("running");
    pc.crash(sock);
    expect(existsSync(sock)).toBe(true);
    expect(await pc.probeSocket(sock)).toBe("stale");
    await expect(pc.driver.down(inst)).rejects.toThrow("process-compose down exited with code 1");
    expect((await pc.driver.startProcess(sock, "api")).ok).toBe(false);
  });

  it("a frozen server accepts connections but answers nothing", async () => {
    const { pc, inst, sock } = await booted({ api: proc() });
    pc.freeze(sock);
    expect(await pc.probeSocket(sock)).toBe("running");
    await expect(pc.driver.getServiceStatuses(sock)).rejects.toThrow(/did not answer/);
    expect(await pc.driver.startProcess(sock, "api")).toMatchObject({ ok: false, timedOut: true });
    expect(await pc.driver.down(inst)).toEqual({ stopped: false, reason: "timeout" });
    expect(await pc.driver.reloadConfig(inst)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("refuse makes process-compose refuse a start or stop with its log line", async () => {
    const { pc, sock } = await booted({ api: proc(), worker: proc() });
    pc.refuse("stop", "api");
    pc.refuse("start", "worker", "custom complaint");
    expect(await pc.driver.stopProcesses(sock, ["api"])).toEqual({
      ok: false,
      message: "FTL failed to stop process api",
    });
    await pc.driver.stopProcesses(sock, ["worker"]);
    expect(await pc.driver.startProcess(sock, "worker")).toEqual({
      ok: false,
      message: "custom complaint",
    });
  });

  it("records every request, in order", async () => {
    const { pc, inst, sock, requests } = await booted({ api: proc(), worker: proc() }, ["default"]);
    await pc.driver.stopProcesses(sock, ["api"]);
    await pc.driver.startProcess(sock, "api");
    await pc.driver.down(inst);
    expect(requests).toEqual([
      { op: "up", socketPath: sock, namespaces: ["default"] },
      { op: "stop", socketPath: sock, services: ["api"] },
      { op: "start", socketPath: sock, services: ["api"] },
      { op: "down", socketPath: sock },
    ]);
    expect(pc.requests).toEqual(requests);
  });

  it("a second up on a live socket is ignored: the running server keeps it", async () => {
    const { pc, inst, sock } = await booted({ api: proc() });
    await pc.driver.up(inst);
    expect(pc.pidOf(sock, "api")).toBe(11);
  });

  it("follows a process's log until the instance goes down", async () => {
    const { pc, inst, sock } = await booted({ api: proc() });
    pc.log(sock, "api", "one");
    const lines: string[] = [];
    const done = (async () => {
      for await (const e of pc.driver.streamLogs(sock, { service: "api", follow: true })) {
        lines.push(e.line);
        if (lines.length === 2) await pc.driver.down(inst);
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    pc.log(sock, "api", "two");
    await done;
    expect(lines).toEqual(["one", "two"]);
  });

  it("fails the version check for a process-compose older than v1.122.0", async () => {
    const pc = createInMemoryProcessCompose({ version: "v1.110.0" });
    await expect(pc.driver.assertSupportedVersion()).rejects.toMatchObject({
      code: "PROCESS_COMPOSE_TOO_OLD",
      details: { installed_version: "1.110.0", minimum_version: "1.122.0" },
    });
  });
});
