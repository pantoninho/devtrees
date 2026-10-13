/**
 * `runRestart` orchestration (ADR-0009, #222): every check before anything
 * is touched, one service at a time in `depends_on` order under the
 * lifecycle lock, a health wait before each dependent, and the refusals.
 * Every collaborator is a stub; the real-binary behaviour is in the smoke
 * suite (scenarios 85-89).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { stringify as stringifyYaml } from "yaml";
import { deriveWorktreeId } from "./anchor.js";
import type { ProcessRow } from "./bounded-down.js";
import { runRestart, type CommandDeps } from "./commands.js";
import type { ServiceStatus, SpawnedProcess } from "./driver.js";
import type { WaitForHealth } from "./health.js";
import type { InstanceStatus } from "./instances.js";
import { classifyError } from "./output.js";
import { instancePaths, runDir, sharedInstancePaths } from "./paths.js";
import { writePendingReload } from "./reload-pending.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function svc(name: string, tier: "isolated" | "shared" = "isolated"): ResolvedService {
  return { name, tier, command: "sleep 300", ports: [], dependsOn: [], environment: [] };
}

/** `devtrees.yaml`: `db` is shared. */
const stack: ResolvedStack = {
  services: [svc("db", "shared"), svc("mobile"), svc("api"), svc("worker")],
};

const proc = (extra: Record<string, unknown> = {}) => ({
  command: "sleep 300",
  working_dir: "/wt",
  environment: [],
  ...extra,
});

/** The running instance's derived config: #160's shape, Metro depending on the backend. */
const derived = {
  processes: {
    mobile: proc({ depends_on: { api: { condition: "process_healthy" } }, namespace: "ios" }),
    api: proc(),
    worker: proc(),
  },
};

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

/** A process-compose client that exits with `code` (and `stderr`) a moment later. */
function child(code: number, stderr = ""): SpawnedProcess {
  const emitter = new EventEmitter() as EventEmitter & SpawnedProcess;
  Object.assign(emitter, { stderr: Readable.from(stderr === "" ? [] : [stderr]) });
  setTimeout(() => emitter.emit("exit", code), 2);
  return emitter;
}

/**
 * A live worktree instance. `process stop` flips a service to `Completed`,
 * `process start` back to `Running` with a new pid. Records every
 * process-compose call, the lock's hold windows, and the health waits.
 */
function instance(
  opts: {
    rows?: ServiceStatus[];
    refuse?: string;
    live?: boolean;
    health?: WaitForHealth | null;
    stack?: () => ResolvedStack;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "dt-pr222-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const anchor = join(root, ".git");
  const top = join(root, "wt", "login");
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
  const id = deriveWorktreeId(top);
  const { socketPath, configPath } = instancePaths(anchor, id);
  writeFileSync(configPath, stringifyYaml(derived));
  if (opts.live !== false) {
    mkdirSync(runDir(anchor), { recursive: true });
    writeFileSync(socketPath, "");
  }
  const state = new Map(
    (opts.rows ?? [running("api", 11), running("mobile", 12), running("worker", 13)]).map((r) => [
      r.name,
      r,
    ]),
  );
  let nextPid = 100;
  const log: string[] = [];
  const waits: Array<Parameters<WaitForHealth>[0]> = [];
  const deps: CommandDeps = {
    cwd: top,
    git: (args) => {
      if (args[1] === "--git-common-dir") return anchor;
      if (args[1] === "--show-toplevel") return top;
      return "false";
    },
    readStack: opts.stack ?? (() => stack),
    probeSocket: async () => "running",
    probeRetryDelaysMs: [],
    getServiceStatuses: async () => [...state.values()],
    withLifecycleLock: async (_anchor, instanceId, fn) => {
      log.push(`lock ${instanceId}`);
      try {
        return await fn();
      } finally {
        log.push("unlock");
      }
    },
    ...(opts.health === null
      ? {}
      : {
          waitForHealth:
            opts.health ??
            (async (args) => {
              log.push(`wait ${args.serviceNames.join(" ")}`);
              waits.push(args);
            }),
        }),
    stop: { readProcessTable: async () => [], pollMs: 1, treeGraceMs: 1 },
    warn: () => {},
    driver: {
      exists: async () => true,
      spawner: (_bin, args) => {
        const [, verb, name = ""] = args;
        log.push(`process ${verb} ${name}`);
        if (opts.refuse === `${verb} ${name}`) {
          return child(1, `FTL failed to ${verb} process ${name}`);
        }
        const row = state.get(name);
        if (row !== undefined && verb === "stop") {
          state.set(name, { ...row, status: "Completed", exitCode: -1, running: false });
        }
        if (row !== undefined && verb === "start") state.set(name, running(name, nextPid++));
        return child(0);
      },
    },
  };
  return { deps, log, waits, id, socketPath, anchor, root, state };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return classifyError(err as Error);
  }
  throw new Error("expected runRestart to fail");
}

const touched = (log: ReadonlyArray<string>) => log.filter((l) => l.startsWith("process"));

describe("runRestart (#222)", () => {
  it("stops then starts each service in depends_on order, one lock window each, waiting for health before its dependent", async () => {
    const { deps, log, waits, id, socketPath } = instance();
    const result = await runRestart(deps, ["mobile", "api"]);
    expect(log).toEqual([
      `lock ${id}`,
      "process stop api",
      "process start api",
      "unlock",
      "wait api",
      `lock ${id}`,
      "process stop mobile",
      "process start mobile",
      "unlock",
      "wait mobile",
    ]);
    expect(result).toMatchObject({ worktreeId: id, restarted: ["api", "mobile"], forceKilled: [] });
    expect(waits[0]).toMatchObject({
      socketPath,
      serviceNames: ["api"],
      restarted: [{ name: "api", stalePid: 11 }],
      command: "restart",
      remedy: "devtrees down && devtrees up -n default -n ios",
    });
  });

  it("a Pending service is refused with SERVICE_PENDING, as stop refuses it: nothing touched", async () => {
    // mobile waits on api (process_healthy): it has not started, so its stop
    // would leave it Terminating with no process for good.
    const pendingMobile: ServiceStatus = { name: "mobile", status: "Pending", health: "unknown" };
    const { deps, log, id } = instance({
      rows: [running("api", 11), pendingMobile, running("worker", 13)],
    });
    const err = await failure(runRestart(deps, ["worker", "mobile"]));
    expect(err).toEqual({
      code: "SERVICE_PENDING",
      message:
        `devtrees restart: mobile is still waiting on its dependencies in '${id}' and has not ` +
        "started, so there is nothing to restart. Nothing was touched. Wait until it starts " +
        "(once api is ready), or restart what it waits on: `devtrees restart api`.",
      details: {
        services: ["mobile"],
        waiting_on: ["api"],
        remedy:
          "Wait until it starts (once api is ready), or restart what it waits on: " +
          "`devtrees restart api`.",
      },
    });
    expect(touched(log)).toEqual([]);
  });

  it("re-checks the last running process before each later service: a one-shot may have finished", async () => {
    // worker is kept alive by `seed`, a one-shot, until mobile's step is done;
    // then seed finishes and mobile dies, leaving worker the last one.
    const seed = running("seed", 14);
    const dead: ServiceStatus = { ...stopped("mobile", 12), exitCode: 1 };
    const { deps, log, id, state } = instance({
      rows: [
        { name: "api", status: "Completed", health: "unknown", exitCode: 0, running: false },
        stopped("mobile", 12),
        running("worker", 13),
        seed,
      ],
      health: async () => {
        state.set("seed", { ...seed, status: "Completed", exitCode: 0, running: false });
        state.set("mobile", dead);
      },
    });
    const err = await failure(runRestart(deps, ["mobile", "worker"]));
    expect(err).toMatchObject({
      code: "LAST_SERVICES_RUNNING",
      message:
        `devtrees restart: worker is the last running process(es) of '${id}'. process-compose ` +
        "exits once nothing runs, which would take the whole instance down, so devtrees did " +
        "not restart worker (it had restarted mobile before). Run `devtrees down && " +
        "devtrees up -n default -n ios` to restart the instance.",
      details: { services: ["worker"] },
    });
    expect(touched(log)).toEqual(["process start mobile"]);
  });

  it("a refused start re-probes the instance: gone means process-compose exited, not a refusal", async () => {
    const { deps, id } = instance({ refuse: "start worker" });
    let gone = false;
    const err = await failure(
      runRestart(
        {
          ...deps,
          probeSocket: async (): Promise<InstanceStatus> => (gone ? "stale" : "running"),
          driver: {
            ...deps.driver,
            spawner: (bin, args, options) => {
              if (args[1] === "start") gone = true;
              return deps.driver!.spawner!(bin, args, options);
            },
          },
        },
        ["worker"],
      ),
    );
    expect(err).toMatchObject({
      code: "INSTANCE_NOT_FOUND",
      message: expect.stringMatching(
        new RegExp(
          `^devtrees restart: process-compose exited while worker was stopping, so '${id}'`,
        ),
      ),
    });
  });

  it("a refused start with the instance still up is SERVICE_START_FAILED", async () => {
    const { deps } = instance({ refuse: "start worker" });
    const err = await failure(runRestart(deps, ["worker"]));
    expect(err.code).toBe("SERVICE_START_FAILED");
    expect(err.message).toContain(
      "FTL failed to start process worker. The services after it were not touched",
    );
  });

  it("process-compose exiting during a later service's stop names what was already restarted", async () => {
    const { deps, id, state } = instance();
    let exited = false;
    let started = 0;
    const err = await failure(
      runRestart(
        {
          ...deps,
          probeSocket: async (): Promise<InstanceStatus> => (exited ? "stale" : "running"),
          getServiceStatuses: async () => {
            if (exited) throw new Error("dial unix: no such file");
            return [...state.values()];
          },
          driver: {
            ...deps.driver,
            spawner: (bin, args, options) => {
              if (args[1] === "start") started++;
              // mobile's stop, after api restarted: process-compose exits.
              if (args[1] === "stop" && started > 0) exited = true;
              return deps.driver!.spawner!(bin, args, options);
            },
          },
        },
        ["mobile", "api"],
      ),
    );
    expect(err).toEqual({
      code: "INSTANCE_NOT_FOUND",
      message:
        `devtrees restart: process-compose exited while mobile was stopping, so '${id}' is no ` +
        "longer running: no other process was left running (process-compose exits once nothing " +
        "runs). devtrees had already restarted api. Run `devtrees up` to start the instance again.",
      details: { worktree_id: id, services: ["mobile"] },
    });
  });

  it("reports the restarted services' rows, in restart order and only those", async () => {
    const { deps } = instance({ health: null });
    const result = await runRestart(deps, ["worker", "api"]);
    expect(result.restarted).toEqual(["worker", "api"]);
    expect(result.services.map((s) => [s.name, s.status])).toEqual([
      ["worker", "Running"],
      ["api", "Running"],
    ]);
  });

  it("the instance's last running process is refused with LAST_SERVICES_RUNNING, before anything is touched", async () => {
    // worker is a finished one-shot: it does not keep the instance alive.
    const done: ServiceStatus = {
      name: "worker",
      status: "Completed",
      health: "unknown",
      exitCode: 0,
    };
    const { deps, log, id } = instance({ rows: [running("api", 11), done] });
    const err = await failure(runRestart(deps, ["api"]));
    expect(err).toEqual({
      code: "LAST_SERVICES_RUNNING",
      message:
        `devtrees restart: api is the last running process(es) of '${id}'. process-compose ` +
        "exits once nothing runs, which would take the whole instance down, so nothing was " +
        "restarted. Run `devtrees down && devtrees up` to restart the instance.",
      details: { worktree_id: id, services: ["api"], remedy: "devtrees down && devtrees up" },
    });
    expect(touched(log)).toEqual([]);
  });

  it("only a process running now keeps the instance alive: not one in its restart backoff, not a Pending dependent", async () => {
    const backoff = { ...running("worker", 13), status: "Running", running: false };
    const pending: ServiceStatus = { name: "mobile", status: "Pending", health: "unknown" };
    const { deps, log } = instance({ rows: [running("api", 11), backoff, pending] });
    const err = await failure(runRestart(deps, ["api", "worker"]));
    expect(err.code).toBe("LAST_SERVICES_RUNNING");
    expect(err.details).toMatchObject({ services: ["api"] });
    expect(touched(log)).toEqual([]);
  });

  it("several named services that keep each other alive restart one at a time", async () => {
    const { deps, log } = instance({ rows: [running("api", 11), running("worker", 13)] });
    await runRestart(deps, ["api", "worker"]);
    expect(touched(log)).toEqual([
      "process stop api",
      "process start api",
      "process stop worker",
      "process start worker",
    ]);
  });

  it("process-compose exiting during a stop (a one-shot finished meanwhile) is INSTANCE_NOT_FOUND, not a refusal", async () => {
    const { deps, id } = instance();
    let exited = false;
    const err = await failure(
      runRestart(
        {
          ...deps,
          probeSocket: async (): Promise<InstanceStatus> => (exited ? "stale" : "running"),
          getServiceStatuses: async () => {
            if (exited) throw new Error("dial unix: no such file");
            return [running("api", 11), running("mobile", 12), running("worker", 13)];
          },
          driver: {
            ...deps.driver,
            spawner: (_bin, args) => {
              if (args[1] === "stop") exited = true;
              return exited && args[1] === "start" ? child(1, "dial unix: no such file") : child(0);
            },
          },
        },
        ["worker"],
      ),
    );
    expect(err).toEqual({
      code: "INSTANCE_NOT_FOUND",
      message:
        `devtrees restart: process-compose exited while worker was stopping, so '${id}' is no ` +
        "longer running: no other process was left running (process-compose exits once nothing " +
        "runs). Run `devtrees up` to start the instance again.",
      details: { worktree_id: id, services: ["worker"] },
    });
  });

  it("a down between two steps names what was already restarted", async () => {
    const { deps, id } = instance();
    let downed = false;
    const err = await failure(
      runRestart(
        {
          ...deps,
          probeSocket: async (): Promise<InstanceStatus> => (downed ? "stale" : "running"),
          waitForHealth: async () => {
            downed = true;
          },
        },
        ["mobile", "api"],
      ),
    );
    expect(err).toEqual({
      code: "INSTANCE_NOT_FOUND",
      message:
        `devtrees restart: '${id}' stopped between two of this \`restart\`'s steps (most ` +
        "likely a concurrent `devtrees down`). devtrees had already restarted api. Run " +
        "`devtrees up` to start it again.",
      details: { worktree_id: id },
    });
  });

  it("one --wait-timeout budget is shared by every service's health wait", async () => {
    const budgets: number[] = [];
    const { deps } = instance({
      health: async (args) => {
        budgets.push(args.timeoutMs);
        await new Promise((r) => setTimeout(r, 60));
      },
    });
    await runRestart({ ...deps, waitTimeoutMs: 1_000 }, ["mobile", "api"]);
    expect(budgets[0]).toBeLessThanOrEqual(1_000);
    expect(budgets[1]).toBeLessThanOrEqual(1_000 - 60);
  });

  it("no running instance fails INSTANCE_NOT_FOUND, naming restart", async () => {
    const { deps, log, id } = instance({ live: false });
    const err = await failure(runRestart(deps, ["mobile"]));
    expect(err.code).toBe("INSTANCE_NOT_FOUND");
    expect(err.message).toBe(
      `devtrees restart: no worktree instance is running for '${id}'. Nothing was touched. ` +
        "Run `devtrees up` to bring it up first.",
    );
    expect(touched(log)).toEqual([]);
  });

  it("a shared service fails SHARED_SERVICE_REFUSED, before an unknown name", async () => {
    const { deps, log } = instance();
    const err = await failure(runRestart(deps, ["nope", "db", "db"]));
    expect(err.code).toBe("SHARED_SERVICE_REFUSED");
    expect(err.message).toContain("devtrees restart: 'db' is a shared service");
    expect(err.details).toEqual({
      services: ["db"],
      remedy: "devtrees down --shared && devtrees up",
    });
    expect(touched(log)).toEqual([]);
  });

  it("a broken devtrees.yaml still refuses a service the shared instance runs", async () => {
    const { deps, anchor } = instance({
      stack: () => {
        throw new Error("devtrees.yaml: bad");
      },
    });
    writeFileSync(
      sharedInstancePaths(anchor).configPath,
      stringifyYaml({ processes: { db: proc() } }),
    );
    expect((await failure(runRestart(deps, ["db"]))).code).toBe("SHARED_SERVICE_REFUSED");
  });

  it("an unknown name fails SERVICE_NOT_FOUND, valid_services from the running instance's derived config", async () => {
    const { deps, log } = instance();
    const err = await failure(runRestart(deps, ["mobile", "nope"]));
    expect(err).toEqual({
      code: "SERVICE_NOT_FOUND",
      message:
        "devtrees restart: unknown service 'nope' in this worktree's instance. Valid services: mobile, api, worker.",
      details: { service: "nope", valid_services: ["mobile", "api", "worker"] },
    });
    expect(touched(log)).toEqual([]);
  });

  it("a service whose namespace was not booted fails NAMESPACE_NOT_RUNNING, booting it in the remedy", async () => {
    const { deps, log, id } = instance({ rows: [running("api", 11), running("worker", 13)] });
    const err = await failure(runRestart(deps, ["api", "mobile"]));
    expect(err.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err.message).toContain("devtrees restart: namespace 'ios' is not running");
    expect(err.details).toEqual({
      worktree_id: id,
      namespaces: ["ios"],
      services: ["mobile"],
      remedy: "devtrees down && devtrees up -n default -n ios",
    });
    expect(touched(log)).toEqual([]);
  });

  it("a pending hot-reload refuses as up does: CONFIG_DRIFT reload_pending, nothing touched", async () => {
    // The pending update dropped worker from the project and waits on its old run.
    const { deps, log, anchor, id } = instance({
      rows: [running("api", 11), running("mobile", 12)],
    });
    writePendingReload(anchor, id, { services: ["worker"], oldRuns: [{ name: "worker", pid: 9 }] });
    const err = await failure(runRestart({ ...deps, isProcessAlive: () => true }, ["mobile"]));
    expect(err.code).toBe("CONFIG_DRIFT");
    expect(err.message).toMatch(/^devtrees restart: a previous hot-reload/);
    expect(err.message).toContain("so nothing was restarted and the instance is unchanged");
    expect(err.message).toContain("then run `devtrees restart mobile` again");
    expect(err.message).not.toContain("Reloading again");
    expect(err.details).toEqual({ reason: "reload_pending", services: ["worker"], pids: [9] });
    expect(touched(log)).toEqual([]);
  });

  it("a process-compose that never answers fails INSTANCE_UNRESPONSIVE, not HEALTH_TIMEOUT", async () => {
    const { deps, log } = instance();
    const err = await failure(
      runRestart(
        {
          ...deps,
          waitTimeoutMs: 30,
          getServiceStatuses: () => Promise.reject(new Error("process list hung")),
        },
        ["mobile"],
      ),
    );
    expect(err.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(touched(log)).toEqual([]);
  });

  it("a refused stop fails SERVICE_START_FAILED, naming what was restarted; the rest is untouched", async () => {
    const { deps, log, id } = instance({ refuse: "stop mobile" });
    const err = await failure(runRestart(deps, ["mobile", "api", "worker"]));
    expect(err.code).toBe("SERVICE_START_FAILED");
    expect(err.message).toContain("api was restarted before it");
    expect(err.details).toEqual({
      worktree_id: id,
      services: [{ name: "mobile", message: "FTL failed to stop process mobile" }],
      remedy: "devtrees restart mobile worker",
    });
    expect(touched(log)).toEqual(["process stop api", "process start api", "process stop mobile"]);
  });

  it("warns on stderr about an old-run process SIGKILL could not stop, and reports what it signalled", async () => {
    const { deps, socketPath } = instance();
    const pc: ProcessRow = {
      pid: 1,
      ppid: 0,
      pgid: 1,
      command: `process-compose up -U -u ${socketPath}`,
    };
    const api: ProcessRow = { pid: 11, ppid: 1, pgid: 11, command: "sleep 300" };
    const warnings: string[] = [];
    const result = await runRestart(
      {
        ...deps,
        warn: (m) => warnings.push(m),
        stop: {
          readProcessTable: async () => [pc, api],
          kill: () => {},
          isAlive: () => true,
          pollMs: 1,
          treeGraceMs: 1,
        },
      },
      ["api"],
    );
    expect(result.forceKilled).toEqual([{ service: "api", pid: 11 }]);
    expect(warnings).toEqual([
      "devtrees restart: WARNING — api's old process (pid 11, sleep 300) survived SIGKILL and may still hold its port.",
    ]);
  });

  it("a restarted service that never becomes healthy fails HEALTH_TIMEOUT", async () => {
    const health: WaitForHealth = async () => {
      throw Object.assign(new Error("service(s) not running: mobile"), { code: "HEALTH_TIMEOUT" });
    };
    const { deps } = instance({ health });
    expect((await failure(runRestart(deps, ["mobile"]))).code).toBe("HEALTH_TIMEOUT");
  });

  it("an instance stopped during the health wait fails INSTANCE_NOT_FOUND naming restart", async () => {
    const { deps } = instance({ health: null });
    let gone = false;
    const err = await failure(
      runRestart(
        {
          ...deps,
          probeSocket: async (): Promise<InstanceStatus> => (gone ? "stale" : "running"),
          getServiceStatuses: async () => {
            if (gone) throw new Error("connect ENOENT");
            return [running("api", 11), running("mobile", 12), stopped("worker", 13)];
          },
          driver: {
            ...deps.driver,
            spawner: (_bin, args) => {
              // The instance is downed right after the start, during the health wait.
              if (args[1] === "start") gone = true;
              return child(0);
            },
          },
        },
        ["worker"],
      ),
    );
    expect(err.code).toBe("INSTANCE_NOT_FOUND");
    expect(err.message).toContain("while `restart` was waiting");
  });
});

describe("runRestart -n <namespace> (#224)", () => {
  it("expands to the namespace's isolated services, unions with names, and skips and reports shared ones", async () => {
    // The shared `db` declares no namespace, so it is in `default`.
    const { deps, log, id } = instance();
    const result = await runRestart(deps, ["mobile", "api"], ["default"]);
    expect(touched(log)).toEqual([
      "process stop api",
      "process start api",
      "process stop mobile",
      "process start mobile",
      "process stop worker",
      "process start worker",
    ]);
    expect(result).toMatchObject({
      worktreeId: id,
      restarted: ["api", "mobile", "worker"],
      skippedShared: ["db"],
    });
  });

  it("a namespace alone restarts only its services; shared skipped is empty when there are none", async () => {
    const { deps, log } = instance();
    const result = await runRestart(deps, [], ["ios"]);
    expect(touched(log)).toEqual(["process stop mobile", "process start mobile"]);
    expect(result).toMatchObject({ restarted: ["mobile"], skippedShared: [] });
  });

  it("a namespace the instance did not boot fails NAMESPACE_NOT_RUNNING, touching nothing", async () => {
    const { deps, log, id } = instance({ rows: [running("api", 11), running("worker", 13)] });
    const err = await failure(runRestart(deps, ["worker"], ["ios"]));
    expect(err).toMatchObject({
      code: "NAMESPACE_NOT_RUNNING",
      details: {
        worktree_id: id,
        namespaces: ["ios"],
        services: ["mobile"],
        remedy: "devtrees down && devtrees up -n default -n ios",
      },
    });
    expect(touched(log)).toEqual([]);
  });

  it("a namespace with no isolated service fails NO_SERVICES_SELECTED, touching nothing", async () => {
    const { deps, log, id } = instance();
    const err = await failure(runRestart(deps, ["worker"], ["ios", "nope"]));
    expect(err).toMatchObject({
      code: "NO_SERVICES_SELECTED",
      details: { worktree_id: id, selected_namespaces: ["nope"], namespaces: ["default", "ios"] },
    });
    expect(err.message).toContain("devtrees restart: no services selected");
    expect(touched(log)).toEqual([]);
  });

  it("naming a shared service explicitly is still refused alongside -n", async () => {
    const { deps, log } = instance();
    const err = await failure(runRestart(deps, ["db"], ["default"]));
    expect(err.code).toBe("SHARED_SERVICE_REFUSED");
    expect(touched(log)).toEqual([]);
  });
});
