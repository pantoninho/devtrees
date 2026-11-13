/**
 * The Driver contract: one suite, run against both adapters of the `Driver`
 * interface (src/driver.ts).
 *
 *  - the real driver (`createDriver`), shelling out to the `.mjs` stub
 *    process-compose (test/stub-process-compose.mjs);
 *  - the in-memory process-compose (src/in-memory-driver.ts).
 *
 * Each case drives an instance through the Driver alone and asserts on what
 * the Driver reports back, so a test that injects the in-memory adapter can
 * trust it to behave like the binary on these operations. Behaviour only one
 * of them models (pids, refusals, exiting once nothing runs) is tested in
 * src/in-memory-driver.test.ts.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { createDriver, type Driver, type InstanceRef, type ServiceStatus } from "./driver.js";
import { createInMemoryProcessCompose } from "./in-memory-driver.js";

const STUB = fileURLToPath(new URL("../test/stub-process-compose.mjs", import.meta.url));
/** Unix socket paths are capped near 104 bytes on macOS: keep them short. */
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

interface Adapter {
  readonly name: string;
  /** A driver, and how to make a process log a line on it. */
  make(): {
    readonly driver: Driver;
    readonly log: (inst: InstanceRef, service: string, lines: ReadonlyArray<string>) => void;
  };
}

const adapters: ReadonlyArray<Adapter> = [
  {
    name: "the real driver over the .mjs stub",
    make: () => ({
      driver: createDriver({
        binary: process.execPath,
        prefixArgs: [STUB],
        exists: async () => true,
      }),
      // The stub serves `process logs <service>` from this fixture file.
      log: (inst, service, lines) =>
        writeFileSync(`${inst.socketPath}.${service}.log`, lines.map((l) => `${l}\n`).join("")),
    }),
  },
  {
    name: "the in-memory process-compose",
    make: () => {
      const pc = createInMemoryProcessCompose();
      return {
        driver: pc.driver,
        log: (inst, service, lines) => {
          for (const line of lines) pc.log(inst.socketPath, service, line);
        },
      };
    },
  },
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const proc = (extra: Record<string, unknown> = {}) => ({ command: "sleep 30", ...extra });

/** A derived config on disk, and the socket an instance of it would serve. */
function instance(processes: Record<string, unknown>): InstanceRef {
  const root = mkdtempSync(join(SHORT_TMP, "dt-contract-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const inst = { configPath: join(root, "wt.yaml"), socketPath: join(root, "wt.sock") };
  writeFileSync(inst.configPath, stringifyYaml({ processes }));
  return inst;
}

/** Wait until the instance answers a status read: `up` returns before the server binds. */
async function answering(driver: Driver, inst: InstanceRef): Promise<ServiceStatus[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await driver.getServiceStatuses(inst.socketPath);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** Boot an instance and register its `down` for cleanup. */
async function boot(driver: Driver, inst: InstanceRef, namespaces: ReadonlyArray<string> = []) {
  await driver.up(inst, namespaces);
  cleanups.push(async () => {
    await driver.down(inst).catch(() => {});
  });
  return await answering(driver, inst);
}

/** The adapter-neutral view of a row: what both adapters report the same way. */
const view = (rows: ReadonlyArray<ServiceStatus>) =>
  rows
    .map((r) => ({
      name: r.name,
      status: r.status,
      health: r.health,
      running: r.running,
      namespaces: r.namespaces,
      ...(r.exitCode !== undefined && r.exitCode !== 0 ? { exitCode: r.exitCode } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

const runningRow = (name: string, namespaces: string[], health = "unknown") => ({
  name,
  status: "Running",
  health,
  running: true,
  namespaces,
});

describe.each(adapters)("Driver contract: $name", (adapter) => {
  it("up boots the processes of the selected namespaces, Running, with their namespaces", async () => {
    const { driver } = adapter.make();
    const inst = instance({
      api: proc(),
      web: proc({ namespace: "app" }),
      sim: proc({ namespace: "ios" }),
      both: proc({ namespace: ["app", "ios"] }),
    });
    const rows = await boot(driver, inst, ["default", "app"]);
    expect(view(rows)).toEqual([
      runningRow("api", ["default"]),
      runningRow("both", ["app", "ios"]),
      runningRow("web", ["app"]),
    ]);
  });

  it("up with no namespace selection boots every namespace", async () => {
    const { driver } = adapter.make();
    const inst = instance({ api: proc(), sim: proc({ namespace: "ios" }) });
    const rows = await boot(driver, inst);
    expect(rows.map((r) => r.name).sort()).toEqual(["api", "sim"]);
  });

  it("a probed process reports ready; an unprobed one unknown", async () => {
    const { driver } = adapter.make();
    const probe = { exec: { command: "true" }, period_seconds: 1 };
    const inst = instance({ api: proc({ readiness_probe: probe }), worker: proc() });
    const rows = await boot(driver, inst);
    expect(view(rows)).toEqual([
      runningRow("api", ["default"], "ready"),
      runningRow("worker", ["default"]),
    ]);
  });

  it("process stop leaves the named process Completed with exit -1, not running; the rest untouched", async () => {
    const { driver } = adapter.make();
    const inst = instance({ api: proc(), worker: proc() });
    await boot(driver, inst);
    expect(await driver.stopProcesses(inst.socketPath, ["worker"])).toEqual({ ok: true });
    expect(view(await driver.getServiceStatuses(inst.socketPath))).toEqual([
      runningRow("api", ["default"]),
      {
        name: "worker",
        status: "Completed",
        health: "unknown",
        running: false,
        namespaces: ["default"],
        exitCode: -1,
      },
    ]);
  });

  it("process start brings a stopped process back to Running", async () => {
    const { driver } = adapter.make();
    const inst = instance({ api: proc(), worker: proc() });
    await boot(driver, inst);
    await driver.stopProcesses(inst.socketPath, ["worker"]);
    expect(await driver.startProcess(inst.socketPath, "worker")).toEqual({
      ok: true,
      alreadyRunning: false,
    });
    expect(view(await driver.getServiceStatuses(inst.socketPath))).toEqual([
      runningRow("api", ["default"]),
      runningRow("worker", ["default"]),
    ]);
  });

  it("the config reload starts added processes and drops removed ones", async () => {
    const { driver } = adapter.make();
    const inst = instance({ api: proc(), worker: proc() });
    await boot(driver, inst);
    writeFileSync(inst.configPath, stringifyYaml({ processes: { api: proc(), web: proc() } }));
    expect(await driver.reloadConfig(inst)).toEqual({ ok: true });
    expect(view(await driver.getServiceStatuses(inst.socketPath))).toEqual([
      runningRow("api", ["default"]),
      runningRow("web", ["default"]),
    ]);
  });

  it("down stops the instance: its socket is gone and status reads fail", async () => {
    const { driver } = adapter.make();
    const inst = instance({ api: proc() });
    await boot(driver, inst);
    expect(existsSync(inst.socketPath)).toBe(true);
    expect(await driver.down(inst)).toEqual({ stopped: true });
    expect(existsSync(inst.socketPath)).toBe(false);
    await expect(driver.getServiceStatuses(inst.socketPath)).rejects.toThrow();
  });

  it("with no instance: status reads and attach fail, and a reload is reason:error", async () => {
    const { driver } = adapter.make();
    const inst = instance({ api: proc() });
    await expect(driver.getServiceStatuses(inst.socketPath)).rejects.toThrow();
    await expect(driver.attach(inst)).rejects.toThrow();
    expect(await driver.reloadConfig(inst)).toMatchObject({ ok: false, reason: "error" });
  });

  it("attach to a running instance returns once the TUI exits", async () => {
    const { driver } = adapter.make();
    const inst = instance({ api: proc() });
    await boot(driver, inst);
    await expect(driver.attach(inst)).resolves.toBeUndefined();
  });

  it("streams a process's log lines, honouring tail", async () => {
    const { driver, log } = adapter.make();
    const inst = instance({ api: proc() });
    await boot(driver, inst);
    log(inst, "api", ["one", "two", "three"]);
    const lines: string[] = [];
    for await (const event of driver.streamLogs(inst.socketPath, { service: "api", tail: 2 })) {
      expect(event).toMatchObject({ service: "api", stream: "stdout" });
      lines.push(event.line);
    }
    expect(lines).toEqual(["two", "three"]);
  });

  it("the supported process-compose version passes the version check", async () => {
    const { driver } = adapter.make();
    await expect(driver.assertSupportedVersion()).resolves.toBeUndefined();
  });
});
