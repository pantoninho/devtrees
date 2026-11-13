/**
 * `runRestart` orchestration (ADR-0009, #222): every check before anything
 * is touched, one service at a time in `depends_on` order under the
 * lifecycle lock, a health wait before each dependent, and the refusals.
 * process-compose is the in-memory adapter (src/in-memory-driver.ts): the
 * tests make things happen to its processes and assert on its state. The
 * other collaborators are stubs; the real-binary behaviour is in the smoke
 * suite (scenarios 85-89).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { deriveWorktreeId } from "./anchor.js";
import type { ProcessRow } from "./bounded-down.js";
import { bareRestartRemedy, runRestart, type CommandDeps } from "./commands.js";
import type { WaitForHealth } from "./health.js";
import { createInMemoryProcessCompose, type PcRequest } from "./in-memory-driver.js";
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
const derived: Record<string, unknown> = {
  mobile: proc({ depends_on: { api: { condition: "process_healthy" } }, namespace: "ios" }),
  api: proc(),
  worker: proc(),
};

/**
 * A worktree whose instance runs on the in-memory process-compose, booted
 * from `processes` (default: `derived`) with `namespaces` (default: both of
 * its namespaces). `project` is what the server booted with when it differs
 * from the derived config on disk (a hot-reload still pending). `live: false`
 * boots nothing.
 *
 * The log records the lock's hold windows, the health waits, and every
 * process stop and start process-compose was asked for.
 */
async function instance(
  opts: {
    processes?: Record<string, unknown>;
    project?: Record<string, unknown>;
    namespaces?: string[];
    live?: boolean;
    health?: WaitForHealth | null;
    stack?: () => ResolvedStack;
    /** Runs as each request reaches process-compose, before it is answered. */
    onRequest?: (request: PcRequest) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "dt-pr222-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const anchor = join(root, ".git");
  const top = join(root, "wt", "login");
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
  const id = deriveWorktreeId(top);
  const inst = instancePaths(anchor, id);
  const { socketPath } = inst;
  const log: string[] = [];
  const waits: Array<Parameters<WaitForHealth>[0]> = [];
  const pc = createInMemoryProcessCompose({
    firstPid: 11,
    onRequest: (r) => {
      if (r.op === "start" || r.op === "stop") {
        log.push(`process ${r.op} ${(r.services ?? []).join(" ")}`);
      }
      opts.onRequest?.(r);
    },
  });
  const processes = opts.processes ?? derived;
  writeFileSync(inst.configPath, stringifyYaml({ processes: opts.project ?? processes }));
  if (opts.live !== false) await pc.driver.up(inst, opts.namespaces ?? ["default", "ios"]);
  writeFileSync(inst.configPath, stringifyYaml({ processes }));
  const deps: CommandDeps = {
    cwd: top,
    git: (args) => {
      if (args[1] === "--git-common-dir") return anchor;
      if (args[1] === "--show-toplevel") return top;
      return "false";
    },
    readStack: opts.stack ?? (() => stack),
    processCompose: pc.driver,
    probeSocket: (path) => pc.probeSocket(path),
    probeRetryDelaysMs: [],
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
  };
  /** The service's row as process-compose lists it now. */
  const row = (name: string) => pc.rows(socketPath).find((r) => r.name === name);
  return { deps, log, waits, id, inst, socketPath, anchor, pc, row };
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
    const { deps, log, waits, id, socketPath, pc, row } = await instance();
    const apiPid = pc.pidOf(socketPath, "api");
    const mobilePid = pc.pidOf(socketPath, "mobile");
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
      restarted: [{ name: "api", stalePid: apiPid }],
      command: "restart",
      remedy: "devtrees down && devtrees up -n default -n ios",
    });
    // After the restart, each runs again with a new pid; worker was not touched.
    expect(row("api")).toMatchObject({ status: "Running", running: true });
    expect(row("api")?.pid).not.toBe(apiPid);
    expect(row("mobile")).toMatchObject({ status: "Running", running: true });
    expect(row("mobile")?.pid).not.toBe(mobilePid);
    expect(row("worker")?.pid).toBe(13);
  });

  it("a Pending service is refused with SERVICE_PENDING: nothing touched", async () => {
    // mobile waits on api (process_healthy): it has not started, so its stop
    // would leave it Terminating with no process for good.
    const { deps, log, id, pc, socketPath } = await instance();
    pc.hold(socketPath, "mobile");
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

  it("a Skipped service whose dependency is still dead is refused with SERVICE_SKIPPED: nothing touched (#263)", async () => {
    // mobile was skipped because api (its process_healthy dependency) died;
    // api has not recovered, so a start would leave mobile Skipped.
    const { deps, log, id, pc, socketPath, row } = await instance();
    pc.exit(socketPath, "api", 3);
    pc.idle(socketPath, "mobile", "Skipped");
    const err = await failure(runRestart(deps, ["worker", "mobile"]));
    const remedy =
      "Restart api first, and mobile after it: `devtrees restart api worker mobile`. If api " +
      "fails again, fix it first (`devtrees logs api`).";
    expect(err).toEqual({
      code: "SERVICE_SKIPPED",
      message:
        "devtrees restart: mobile was skipped because a dependency failed, and api " +
        `(Completed, exit 3) is still failed in '${id}', so a start would leave it skipped. ` +
        `Nothing was touched. ${remedy}`,
      details: {
        services: ["mobile"],
        failed_dependencies: [{ name: "api", status: "Completed", exit_code: 3 }],
        remedy,
      },
    });
    expect(touched(log)).toEqual([]);
    expect(row("mobile")).toMatchObject({ status: "Skipped", running: false });
  });

  it("a Skipped service is restarted together with its dead dependency: api first, then mobile (#263)", async () => {
    const { deps, log, id, pc, socketPath, row } = await instance();
    pc.exit(socketPath, "api", 3);
    pc.idle(socketPath, "mobile", "Skipped");
    const result = await runRestart(deps, ["mobile", "api"]);
    expect(result).toMatchObject({ restarted: ["api", "mobile"] });
    expect(log).toEqual([
      `lock ${id}`,
      "process start api",
      "unlock",
      "wait api",
      `lock ${id}`,
      "process start mobile",
      "unlock",
      "wait mobile",
    ]);
    expect(row("mobile")).toMatchObject({ status: "Running", running: true });
  });

  it.each(["Skipped", "Disabled"] as const)(
    "a %s service with no failed dependency is simply started: no stop (#263)",
    async (state) => {
      const { deps, log, id, pc, socketPath, row } = await instance();
      pc.idle(socketPath, "mobile", state);
      const result = await runRestart(deps, ["mobile"]);
      expect(result).toMatchObject({ restarted: ["mobile"] });
      expect(log).toEqual([`lock ${id}`, "process start mobile", "unlock", "wait mobile"]);
      expect(row("mobile")).toMatchObject({ status: "Running", running: true });
    },
  );

  it("an idle service never counts as the last running process (#263)", async () => {
    // api is the only running process; restarting the idle mobile stops nothing.
    const { deps, log, pc, socketPath } = await instance();
    pc.exit(socketPath, "worker", 0);
    pc.idle(socketPath, "mobile", "Disabled");
    await runRestart(deps, ["mobile"]);
    expect(touched(log)).toEqual(["process start mobile"]);
  });

  it("re-checks the last running process before each later service: a one-shot may have finished", async () => {
    // worker is kept alive by `seed`, a one-shot, until mobile's step is done;
    // then seed finishes and mobile dies, leaving worker the last one.
    let socket = "";
    let pcRef: ReturnType<typeof createInMemoryProcessCompose> | undefined;
    const { deps, log, id, pc, socketPath } = await instance({
      processes: { ...derived, seed: proc() },
      health: async () => {
        pcRef?.exit(socket, "seed", 0);
        pcRef?.exit(socket, "mobile", 1);
      },
    });
    socket = socketPath;
    pcRef = pc;
    pc.exit(socketPath, "api", 0);
    pc.exit(socketPath, "mobile", -1);
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
    let crash = () => {};
    const { deps, id, pc, socketPath } = await instance({
      // process-compose exits as the start reaches it, so the start fails.
      onRequest: (r) => {
        if (r.op === "start") crash();
      },
    });
    crash = () => pc.crash(socketPath);
    const err = await failure(runRestart(deps, ["worker"]));
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
    const { deps, pc } = await instance();
    pc.refuse("start", "worker");
    const err = await failure(runRestart(deps, ["worker"]));
    expect(err.code).toBe("SERVICE_START_FAILED");
    expect(err.message).toContain(
      "FTL failed to start process worker. The services after it were not touched",
    );
  });

  it("process-compose exiting during a later service's stop names what was already restarted", async () => {
    let finishOthers = () => {};
    let started = 0;
    const { deps, id, pc, socketPath } = await instance({
      onRequest: (r) => {
        if (r.op === "start") started++;
        // mobile's stop, after api restarted: everything else finishes
        // meanwhile, so the stop leaves nothing running and process-compose exits.
        if (r.op === "stop" && started > 0) finishOthers();
      },
    });
    finishOthers = () => {
      pc.exit(socketPath, "api", 0);
      pc.exit(socketPath, "worker", 0);
    };
    const err = await failure(runRestart(deps, ["mobile", "api"]));
    expect(err).toEqual({
      code: "INSTANCE_NOT_FOUND",
      message:
        `devtrees restart: process-compose exited while mobile was stopping, so '${id}' is no ` +
        "longer running: no other process was left running (process-compose exits once nothing " +
        "runs). devtrees had already restarted api. Run `devtrees up` to start the instance again.",
      details: { worktree_id: id, services: ["mobile"] },
    });
    expect(pc.isUp(socketPath)).toBe(false);
  });

  it("reports the restarted services' rows, in restart order and only those", async () => {
    const { deps } = await instance({ health: null });
    const result = await runRestart(deps, ["worker", "api"]);
    expect(result.restarted).toEqual(["worker", "api"]);
    expect(result.services.map((s) => [s.name, s.status])).toEqual([
      ["worker", "Running"],
      ["api", "Running"],
    ]);
  });

  it("the instance's last running process is refused with LAST_SERVICES_RUNNING, before anything is touched", async () => {
    // worker is a finished one-shot: it does not keep the instance alive.
    const { deps, log, id, pc, socketPath, row } = await instance({ namespaces: ["default"] });
    pc.exit(socketPath, "worker", 0);
    const apiPid = pc.pidOf(socketPath, "api");
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
    expect(row("api")).toMatchObject({ status: "Running", pid: apiPid });
  });

  it("only a process running now keeps the instance alive: not one in its restart backoff, not a Pending dependent", async () => {
    const { deps, log, pc, socketPath } = await instance();
    pc.backoff(socketPath, "worker");
    pc.hold(socketPath, "mobile");
    const err = await failure(runRestart(deps, ["api", "worker"]));
    expect(err.code).toBe("LAST_SERVICES_RUNNING");
    expect(err.details).toMatchObject({ services: ["api"] });
    expect(touched(log)).toEqual([]);
  });

  it("several named services that keep each other alive restart one at a time", async () => {
    const { deps, log } = await instance({ namespaces: ["default"] });
    await runRestart(deps, ["api", "worker"]);
    expect(touched(log)).toEqual([
      "process stop api",
      "process start api",
      "process stop worker",
      "process start worker",
    ]);
  });

  it("process-compose exiting during a stop (a one-shot finished meanwhile) is INSTANCE_NOT_FOUND, not a refusal", async () => {
    let finishOthers = () => {};
    const { deps, id, pc, socketPath } = await instance({
      onRequest: (r) => {
        if (r.op === "stop") finishOthers();
      },
    });
    finishOthers = () => {
      pc.exit(socketPath, "api", 0);
      pc.exit(socketPath, "mobile", 0);
    };
    const err = await failure(runRestart(deps, ["worker"]));
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
    let down = async () => {};
    const { deps, id, pc, inst } = await instance({ health: async () => down() });
    down = async () => {
      await pc.driver.down(inst);
    };
    const err = await failure(runRestart(deps, ["mobile", "api"]));
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
    const { deps } = await instance({
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
    const { deps, log, id } = await instance({ live: false });
    const err = await failure(runRestart(deps, ["mobile"]));
    expect(err.code).toBe("INSTANCE_NOT_FOUND");
    expect(err.message).toBe(
      `devtrees restart: no worktree instance is running for '${id}'. Nothing was touched. ` +
        "Run `devtrees up` to bring it up first.",
    );
    expect(touched(log)).toEqual([]);
  });

  it("a shared service fails SHARED_SERVICE_REFUSED, before an unknown name", async () => {
    const { deps, log } = await instance();
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
    const { deps, anchor } = await instance({
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
    const { deps, log } = await instance();
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
    const { deps, log, id } = await instance({ namespaces: ["default"] });
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
    const { deps, log, anchor, id } = await instance({
      project: { mobile: derived.mobile, api: derived.api },
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
    const { deps, log, pc, socketPath } = await instance();
    pc.freeze(socketPath);
    const err = await failure(runRestart({ ...deps, waitTimeoutMs: 30 }, ["mobile"]));
    expect(err.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(touched(log)).toEqual([]);
  });

  it("a refused stop fails SERVICE_START_FAILED, naming what was restarted; the rest is untouched", async () => {
    const { deps, log, id, pc, socketPath, row } = await instance();
    pc.refuse("stop", "mobile");
    const mobilePid = pc.pidOf(socketPath, "mobile");
    const err = await failure(runRestart(deps, ["mobile", "api", "worker"]));
    expect(err.code).toBe("SERVICE_START_FAILED");
    expect(err.message).toContain("api was restarted before it");
    expect(err.details).toEqual({
      worktree_id: id,
      services: [{ name: "mobile", message: "FTL failed to stop process mobile" }],
      remedy: "devtrees restart mobile worker",
    });
    expect(touched(log)).toEqual(["process stop api", "process start api", "process stop mobile"]);
    expect(row("mobile")).toMatchObject({ status: "Running", pid: mobilePid });
    expect(row("worker")?.pid).toBe(13);
  });

  it("warns on stderr about an old-run process SIGKILL could not stop, and reports what it signalled", async () => {
    const { deps, socketPath, pc } = await instance();
    const apiPid = pc.pidOf(socketPath, "api") ?? 0;
    const supervisor: ProcessRow = {
      pid: 1,
      ppid: 0,
      pgid: 1,
      command: `process-compose up -U -u ${socketPath}`,
    };
    const api: ProcessRow = { pid: apiPid, ppid: 1, pgid: apiPid, command: "sleep 300" };
    const warnings: string[] = [];
    const result = await runRestart(
      {
        ...deps,
        warn: (m) => warnings.push(m),
        stop: {
          readProcessTable: async () => [supervisor, api],
          kill: () => {},
          isAlive: () => true,
          pollMs: 1,
          treeGraceMs: 1,
        },
      },
      ["api"],
    );
    expect(result.forceKilled).toEqual([{ service: "api", pid: apiPid }]);
    expect(warnings).toEqual([
      `devtrees restart: WARNING — api's old process (pid ${apiPid}, sleep 300) survived SIGKILL and may still hold its port.`,
    ]);
  });

  it("a restarted service that never becomes healthy fails HEALTH_TIMEOUT", async () => {
    const health: WaitForHealth = async () => {
      throw Object.assign(new Error("service(s) not running: mobile"), { code: "HEALTH_TIMEOUT" });
    };
    const { deps } = await instance({ health });
    expect((await failure(runRestart(deps, ["mobile"]))).code).toBe("HEALTH_TIMEOUT");
  });

  it("an instance stopped during the health wait fails INSTANCE_NOT_FOUND naming restart", async () => {
    let started = false;
    let down = () => {};
    const { deps, pc, inst, socketPath } = await instance({
      health: null,
      // The instance is downed right after the start, as the health wait reads it.
      onRequest: (r) => {
        if (r.op === "start") started = true;
        else if (r.op === "list" && started) down();
      },
    });
    down = () => void pc.driver.down(inst);
    await pc.driver.stopProcesses(socketPath, ["worker"]);
    const err = await failure(runRestart(deps, ["worker"]));
    expect(err.code).toBe("INSTANCE_NOT_FOUND");
    expect(err.message).toContain("while `restart` was waiting");
  });
});

describe("runRestart -n <namespace> (#224)", () => {
  it("expands to the namespace's isolated services, unions with names, and skips and reports shared ones", async () => {
    // The shared `db` declares no namespace, so it is in `default`.
    const { deps, log, id } = await instance();
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
    const { deps, log } = await instance();
    const result = await runRestart(deps, [], ["ios"]);
    expect(touched(log)).toEqual(["process stop mobile", "process start mobile"]);
    expect(result).toMatchObject({ restarted: ["mobile"], skippedShared: [] });
  });

  it("a namespace the instance did not boot fails NAMESPACE_NOT_RUNNING, touching nothing", async () => {
    const { deps, log, id } = await instance({ namespaces: ["default"] });
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
    const { deps, log, id } = await instance();
    const err = await failure(runRestart(deps, ["worker"], ["ios", "nope"]));
    expect(err).toMatchObject({
      code: "NO_SERVICES_SELECTED",
      details: { worktree_id: id, selected_namespaces: ["nope"], namespaces: ["default", "ios"] },
    });
    expect(err.message).toContain("devtrees restart: no services selected");
    expect(touched(log)).toEqual([]);
  });

  it("a pending hot-reload refuses with CONFIG_DRIFT reload_pending, its retry spelling the -n flags", async () => {
    // worker's new copy is not in the project yet: the reload is still pending.
    const { deps, log, anchor, id } = await instance({
      project: { mobile: derived.mobile, api: derived.api },
    });
    writePendingReload(anchor, id, { services: ["worker"], oldRuns: [{ name: "worker", pid: 9 }] });
    const err = await failure(
      runRestart({ ...deps, isProcessAlive: () => true }, ["api"], ["ios", "ios"]),
    );
    expect(err.code).toBe("CONFIG_DRIFT");
    expect(err.message).toContain("then run `devtrees restart api -n ios` again");
    expect(err.details).toEqual({ reason: "reload_pending", services: ["worker"], pids: [9] });
    expect(touched(log)).toEqual([]);
  });

  it("an unresponsive instance's retry spells the -n flags", async () => {
    const { deps, log, pc, socketPath } = await instance();
    pc.freeze(socketPath);
    const err = await failure(runRestart({ ...deps, waitTimeoutMs: 30 }, [], ["ios", "default"]));
    expect(err.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err.message).toContain("devtrees restart -n ios -n default");
    expect(touched(log)).toEqual([]);
  });

  it("a Pending service in the expansion is refused with SERVICE_PENDING, touching nothing", async () => {
    const { deps, log, pc, socketPath } = await instance();
    pc.hold(socketPath, "mobile");
    const err = await failure(runRestart(deps, ["worker"], ["ios"]));
    expect(err).toMatchObject({
      code: "SERVICE_PENDING",
      details: { services: ["mobile"], waiting_on: ["api"] },
    });
    expect(touched(log)).toEqual([]);
  });

  it("naming a shared service explicitly is still refused alongside -n", async () => {
    const { deps, log } = await instance();
    const err = await failure(runRestart(deps, ["db"], ["default"]));
    expect(err.code).toBe("SHARED_SERVICE_REFUSED");
    expect(touched(log)).toEqual([]);
  });
});

describe("bareRestartRemedy (#225)", () => {
  // A bare `restart` is refused (INVALID_ARGS, ADR-0009): this is the remedy it prints.
  const read = (remedy: string) => ({ remedy, namespacesRead: true });
  const unread = (remedy: string) => ({ remedy, namespacesRead: false });

  it("a multi-service instance: the down + up that boots the namespaces running now, touching nothing", async () => {
    const { deps, log } = await instance();
    expect(await bareRestartRemedy(deps)).toEqual(
      read("devtrees down && devtrees up -n default -n ios"),
    );
    expect(log).toEqual([]);
  });

  it("a one-service instance keeps its one namespace", async () => {
    const { deps, log } = await instance({
      processes: { web: proc({ namespace: "app" }) },
      namespaces: ["app"],
    });
    expect(await bareRestartRemedy(deps)).toEqual(read("devtrees down && devtrees up -n app"));
    expect(log).toEqual([]);
  });

  it("only booted namespaces count: an unbooted one stays out of the remedy", async () => {
    // mobile (ios) is not in the project: the instance booted `-n default` only.
    const { deps } = await instance({ namespaces: ["default"] });
    expect(await bareRestartRemedy(deps)).toEqual(read("devtrees down && devtrees up"));
  });

  it("no running instance: every namespace the derived config declares, and a stale socket file is left in place", async () => {
    const { deps, socketPath, pc } = await instance();
    // process-compose was killed: its socket file stays behind.
    pc.crash(socketPath);
    expect(await bareRestartRemedy(deps)).toEqual(
      unread("devtrees down && devtrees up -n default -n ios"),
    );
    expect(existsSync(socketPath)).toBe(true);
  });

  it("a stack whose services all declare a namespace, with no instance: every one, never a bare `up` that selects nothing", async () => {
    const { deps, inst } = await instance({ live: false });
    rmSync(inst.configPath);
    const namespaced: CommandDeps = {
      ...deps,
      readStack: () => ({
        services: [
          svc("db", "shared"),
          { ...svc("web"), namespace: "app" },
          { ...svc("sim"), namespace: "ios" },
        ],
      }),
    };
    expect(await bareRestartRemedy(namespaced)).toEqual(
      unread("devtrees down && devtrees up -n app -n ios"),
    );
  });

  it("a frozen instance booted `-n app -n default`: its status read times out, and the remedy keeps app", async () => {
    const { deps, pc, socketPath } = await instance({
      processes: { web: proc({ namespace: "app" }), api: proc() },
      namespaces: ["app", "default"],
    });
    pc.freeze(socketPath);
    expect(await bareRestartRemedy(deps)).toEqual(
      unread("devtrees down && devtrees up -n app -n default"),
    );
  }, 20_000);

  it("an instance gone between the probe and the status read falls back the same way", async () => {
    const { deps, pc } = await instance();
    const gone: CommandDeps = {
      ...deps,
      // process-compose dies right after it answers the probe.
      probeSocket: async (path): Promise<InstanceStatus> => {
        const status = await pc.probeSocket(path);
        pc.crash(path);
        return status;
      },
    };
    expect(await bareRestartRemedy(gone)).toEqual(
      unread("devtrees down && devtrees up -n default -n ios"),
    );
  });
});
