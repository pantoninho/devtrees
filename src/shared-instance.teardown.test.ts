/**
 * The shared instance module's namespaced teardown (#239, ADR-0012; moved
 * into the module by #258), at its interface: `downNamespaces` (`down
 * --shared -n`) stops and removes only the named namespaces' shared
 * services, under the shared lock, refuses while something depends on them,
 * and turns into a full shared teardown when nothing else would be left
 * running; `previewDownNamespaces` is its dry run. process-compose is the
 * in-memory adapter (src/in-memory-driver.ts); the other collaborators are
 * stubs. The real-binary behaviour is in the smoke suite (scenarios 124-126).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { deriveWorktreeId } from "./anchor.js";
import { DEVTREES_METADATA_KEY } from "./deriver.js";
import { createInMemoryProcessCompose } from "./in-memory-driver.js";
import type { InstanceInfo } from "./instances.js";
import { classifyError } from "./output.js";
import { instancePaths, runDir, sharedInstancePaths } from "./paths.js";
import { sharedStepMarkerFile, withLifecycleLock, writeSharedStepMarker } from "./registry.js";
import { writePendingReload } from "./reload-pending.js";
import {
  openSharedInstance,
  type SharedInstanceDeps,
  type SharedNamespaceDownOptions,
} from "./shared-instance.js";
import { readSharedState, writeSharedState } from "./shared-state.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

/** `down --shared -n` through the shared instance the deps open. */
const downNamespaces = (deps: SharedInstanceDeps, options: SharedNamespaceDownOptions) =>
  openSharedInstance(deps).downNamespaces(options);

/** `down --shared -n --dry-run` through the shared instance the deps open. */
const previewDownNamespaces = (deps: SharedInstanceDeps, options: SharedNamespaceDownOptions) =>
  openSharedInstance(deps).previewDownNamespaces(options);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const proc = (extra: Record<string, unknown> = {}) => ({
  command: "sleep 300",
  working_dir: "/anchor",
  environment: [],
  ...extra,
});

/** The shared instance: always-on `pg`, `sa` in `a`, `sb` in `b`. */
const sharedProcesses = {
  pg: proc(),
  sa: proc({ namespace: "a" }),
  sb: proc({ namespace: "b" }),
};

function svc(name: string, tier: "isolated" | "shared", deps: string[] = []): ResolvedService {
  return {
    name,
    tier,
    command: "sleep 300",
    ports: [],
    environment: [],
    dependsOn: deps.map((d) => ({ name: d })),
  };
}

interface Opts {
  /** The shared config on disk. Default: `sharedProcesses`. */
  readonly processes?: Record<string, ReturnType<typeof proc>>;
  /**
   * What the running server booted with, when it differs from `processes`
   * (a reload that timed out left the old processes listed). Default: `processes`.
   */
  readonly booted?: Record<string, ReturnType<typeof proc>>;
  /** Processes that exited on their own before the command, with their exit codes. */
  readonly exited?: Record<string, number>;
  /** process-compose rejects the config it re-reads on a reload. */
  readonly rejectReload?: boolean;
  /** process-compose refuses `process stop sa` with this complaint. */
  readonly refuseStop?: string;
  readonly worktrees?: ReadonlyArray<{
    readonly id: string;
    readonly booted?: string[];
    readonly sharedDependsOn?: Record<string, string[]>;
    readonly root?: string;
  }>;
  readonly stack?: ResolvedStack;
  readonly live?: boolean;
}

/**
 * A live shared instance, running on the in-memory process-compose
 * (src/in-memory-driver.ts) booted from its derived config. Records the
 * shared lock window and every process stop, reload and down
 * process-compose received.
 */
async function sharedInstance(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "dt-pr239-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const anchor = join(root, ".git");
  const top = join(root, "wt", "login");
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  mkdirSync(runDir(anchor), { recursive: true });
  cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
  const paths = sharedInstancePaths(anchor);
  const processes = opts.processes ?? sharedProcesses;
  const writeConfig = (procs: Record<string, unknown>) =>
    writeFileSync(
      paths.configPath,
      stringifyYaml({
        processes: procs,
        [DEVTREES_METADATA_KEY]: {
          ports_by_service: Object.fromEntries(
            Object.keys(procs).map((n) => [n, { [`${n.toUpperCase()}_PORT`]: 1 }]),
          ),
        },
      }),
    );
  const log: string[] = [];
  const pc = createInMemoryProcessCompose({
    firstPid: 10,
    onRequest: (r) => {
      if (r.op === "start" || r.op === "stop") {
        log.push(`process ${r.op} ${(r.services ?? []).join(" ")}`);
      } else if (r.op === "reload" || r.op === "down") {
        log.push(r.op);
      }
      // process-compose re-reads a config it cannot parse: it answers HTTP 400.
      if (r.op === "reload" && opts.rejectReload === true) {
        writeFileSync(paths.configPath, "processes: [unparseable\n");
      }
    },
  });
  if (opts.refuseStop !== undefined) pc.refuse("stop", "sa", opts.refuseStop);
  if (opts.live !== false) {
    writeConfig(opts.booted ?? processes);
    await pc.driver.up(paths);
    for (const [name, code] of Object.entries(opts.exited ?? {})) {
      pc.exit(paths.socketPath, name, code);
    }
    log.length = 0;
  }
  writeConfig(processes);
  writeSharedState(anchor, {
    hash: "whole",
    ports: Object.fromEntries(Object.keys(processes).map((n, i) => [`${n.toUpperCase()}_PORT`, i])),
    extended: Object.fromEntries(Object.keys(processes).map((n) => [n, {}])),
    services: Object.fromEntries(
      Object.keys(processes).map((n) => [
        n,
        { hash: `h-${n}`, ports: [`${n.toUpperCase()}_PORT`] },
      ]),
    ),
  });
  const worktrees: InstanceInfo[] = (opts.worktrees ?? []).map((w) => {
    const wp = instancePaths(anchor, w.id);
    writeFileSync(
      wp.configPath,
      stringifyYaml({
        processes: { worker: proc({ working_dir: w.root ?? top }), web: proc() },
        [DEVTREES_METADATA_KEY]: {
          ports_by_service: {},
          ...(w.sharedDependsOn !== undefined ? { shared_depends_on: w.sharedDependsOn } : {}),
        },
      }),
    );
    return {
      id: w.id,
      kind: "worktree",
      status: "running",
      socketPath: wp.socketPath,
      ports: {},
      blockBase: undefined,
      services: (w.booted ?? ["worker", "web"]).map((name) => ({
        name,
        status: "Running",
        health: "unknown",
        ports: {},
        namespaces: ["default"],
        tier: "isolated",
        state: "active",
      })),
      namespaces: ["default"],
      servicesRead: "ok",
    };
  });
  const deps: SharedInstanceDeps = {
    anchor,
    readStack: () => opts.stack ?? { services: [] },
    driver: pc.driver,
    liveness: { probe: (socketPath) => pc.probeSocket(socketPath), retryDelaysMs: [] },
    probeSocket: (socketPath) => pc.probeSocket(socketPath),
    waitTimeoutMs: 2_000,
    previewReadTimeoutMs: 2_000,
    discover: async () => [
      ...worktrees,
      {
        id: "shared",
        kind: "shared",
        status: "running",
        socketPath: paths.socketPath,
        ports: {},
        blockBase: undefined,
        services: [],
        namespaces: [],
        servicesRead: "ok",
      },
    ],
    lifecycleWaitMs: 50,
    sharedLock: async (_anchor, fn) => {
      log.push("lock");
      try {
        return await fn();
      } finally {
        log.push("unlock");
      }
    },
    stop: {
      readProcessTable: async () => [],
      isAlive: () => false,
      kill: () => {},
      pollMs: 1,
      treeGraceMs: 1,
      graceMs: 1,
    },
    warn: () => {},
    reap: async () => ({ ranCount: 0, failures: [] }),
  };
  function configProcesses(): Record<string, unknown> {
    if (!existsSync(paths.configPath)) return {};
    const doc = parseYaml(readFileSync(paths.configPath, "utf8")) as { processes?: object };
    return (doc.processes ?? {}) as Record<string, unknown>;
  }
  /** The shared instance's rows as process-compose lists them now. */
  const rows = () => pc.rows(paths.socketPath);
  return { deps, log, pc, rows, anchor, paths, configProcesses, top };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return classifyError(err as Error);
  }
  throw new Error("expected it to fail");
}

describe("SharedInstance.downNamespaces: down --shared -n (#239)", () => {
  it("stops and removes only the named namespace's shared services, under the shared lock", async () => {
    const s = await sharedInstance();
    const result = await downNamespaces(s.deps, { namespaces: ["a"] });
    expect(result).toMatchObject({
      shared: true,
      stopped: true,
      namespaces: ["a"],
      services: ["sa"],
      inactiveNamespaces: [],
      instanceStopped: false,
      dependants: [],
    });
    expect(s.log).toEqual(["lock", "process stop sa", "reload", "unlock"]);
    expect(Object.keys(s.configProcesses())).toEqual(["pg", "sb"]);
    expect(s.rows().map((r) => r.name)).toEqual(["pg", "sb"]);
    expect(s.rows().find((r) => r.name === "sb")?.status).toBe("Running");
    expect(existsSync(s.paths.socketPath)).toBe(true);
  });

  it("drops the removed services' revision records and bound ports", async () => {
    const s = await sharedInstance();
    await downNamespaces(s.deps, { namespaces: ["a"] });
    const after = readSharedState(s.anchor);
    expect(Object.keys(after?.services ?? {})).toEqual(["pg", "sb"]);
    expect(Object.keys(after?.extended ?? {})).toEqual(["pg", "sb"]);
    expect(Object.keys(after?.ports ?? {})).toEqual(["PG_PORT", "SB_PORT"]);
    expect(after?.hash).toBe("whole");
  });

  it("is a no-op, listing the namespace as inactive, when no shared service of it runs", async () => {
    const s = await sharedInstance();
    const result = await downNamespaces(s.deps, { namespaces: ["nope"] });
    expect(result).toMatchObject({ stopped: false, services: [], inactiveNamespaces: ["nope"] });
    expect(s.log).toEqual(["lock", "unlock"]);
  });

  it("names an inactive namespace beside an active one, and stops the active one", async () => {
    const s = await sharedInstance();
    const result = await downNamespaces(s.deps, { namespaces: ["b", "nope"] });
    expect(result).toMatchObject({ stopped: true, services: ["sb"], inactiveNamespaces: ["nope"] });
  });

  it("is a no-op when the shared instance is not running", async () => {
    const s = await sharedInstance({ live: false });
    const result = await downNamespaces(s.deps, { namespaces: ["a"] });
    expect(result).toMatchObject({ stopped: false, services: [], inactiveNamespaces: ["a"] });
    expect(s.log).toEqual(["lock", "unlock"]);
  });

  it("refuses SHARED_IN_USE while a live worktree's booted service depends on a target, touching nothing", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "login-1", sharedDependsOn: { worker: ["sa", "pg"] } }],
    });
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details).toMatchObject({
      namespaces: ["a"],
      services: ["sa"],
      dependants: [
        { instance: "login-1", service: "worker", depends_on: ["sa"], source: "derived_config" },
      ],
      forceable: true,
    });
    expect(err.details?.remedy).toBe("devtrees down --shared -n a --force");
    expect(err.message).toContain("stop those worktrees first");
    expect(s.log).toEqual(["lock", "unlock"]);
    expect(Object.keys(s.configProcesses())).toEqual(["pg", "sa", "sb"]);
  });

  it("a dependant in a namespace the worktree did not boot does not block", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "login-1", booted: ["web"], sharedDependsOn: { worker: ["sa"] } }],
    });
    const result = await downNamespaces(s.deps, { namespaces: ["a"] });
    expect(result.stopped).toBe(true);
  });

  it("counts a service a pending hot-reload is applying as booted, though process-compose does not list it", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "login-1", booted: ["web"], sharedDependsOn: { worker: ["sa"] } }],
    });
    writePendingReload(s.anchor, "login-1", {
      services: ["worker"],
      oldRuns: [{ name: "worker", pid: process.pid }],
    });
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details?.dependants).toEqual([
      { instance: "login-1", service: "worker", depends_on: ["sa"], source: "derived_config" },
    ]);
  });

  it("a lifecycle command still in flight after the wait refuses with a plain retry, never --force", async () => {
    const s = await sharedInstance();
    const id = deriveWorktreeId("/x/billing");
    writeFileSync(join(s.anchor, "devtrees", `${id}.lock`), `${process.pid}\n`);
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details).toMatchObject({
      dependants: [
        { instance: id, service: null, depends_on: [], source: "lifecycle_in_progress" },
      ],
      forceable: false,
      remedy: "devtrees down --shared -n a",
    });
    expect(err.message).toContain("in progress there");
    expect(err.message).toContain(`${id}.lock`);
    expect(s.log.filter((l) => l.startsWith("process"))).toEqual([]);
    // --force does not override an in-flight command, and its retry drops --force.
    const forced = await failure(downNamespaces(s.deps, { namespaces: ["a"], force: true }));
    expect(forced.code).toBe("SHARED_IN_USE");
    expect(forced.details?.remedy).toBe("devtrees down --shared -n a");
  });

  it("waits for an in-flight command OUTSIDE the shared lock, then goes ahead once it is gone", async () => {
    const s = await sharedInstance();
    const lock = join(s.anchor, "devtrees", `${deriveWorktreeId("/x/billing")}.lock`);
    writeFileSync(lock, `${process.pid}\n`);
    setTimeout(() => rmSync(lock, { force: true }), 150);
    const result = await downNamespaces(
      { ...s.deps, lifecycleWaitMs: 5000 },
      { namespaces: ["a"] },
    );
    expect(result).toMatchObject({ stopped: true, services: ["sa"], dependants: [] });
    // The first attempt released the shared lock before waiting; the second did the work.
    expect(s.log.slice(0, 3)).toEqual(["lock", "unlock", "lock"]);
    expect(s.log).toContain("process stop sa");
  });

  describe("scoped to the targets by the shared-step marker (#244 follow-up)", () => {
    const id = "billing-0a1b2c3d";

    it("does not wait for an in-flight `up` whose marker names no target", async () => {
      const s = await sharedInstance();
      const result = await withLifecycleLock(s.anchor, id, async () => {
        writeSharedStepMarker(s.anchor, id, { services: ["pg", "sb"], ports: [] });
        return await downNamespaces({ ...s.deps, lifecycleWaitMs: 5000 }, { namespaces: ["a"] });
      });
      expect(result).toMatchObject({ stopped: true, services: ["sa"], dependants: [] });
      // One attempt: no release-and-wait.
      expect(s.log).toEqual(["lock", "process stop sa", "reload", "unlock"]);
    });

    it("does not wait for a worktree `down` (its marker names no shared service)", async () => {
      const s = await sharedInstance();
      const result = await withLifecycleLock(s.anchor, id, async () => {
        writeSharedStepMarker(s.anchor, id, { services: [] });
        return await downNamespaces(s.deps, { namespaces: ["a"] });
      });
      expect(result).toMatchObject({ stopped: true, services: ["sa"] });
    });

    it("waits for an in-flight `up` whose marker names a target, and lists the targets it uses", async () => {
      const s = await sharedInstance();
      const err = await withLifecycleLock(s.anchor, id, async () => {
        writeSharedStepMarker(s.anchor, id, { services: ["pg", "sa"], ports: [] });
        return await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
      });
      expect(err.code).toBe("SHARED_IN_USE");
      expect(err.details).toMatchObject({
        dependants: [
          { instance: id, service: null, depends_on: ["sa"], source: "lifecycle_in_progress" },
        ],
        forceable: false,
        remedy: "devtrees down --shared -n a",
      });
      expect(err.message).toContain("it uses 'sa'");
      expect(s.log.filter((l) => l.startsWith("process"))).toEqual([]);
    });

    it("goes ahead once an `up` without a marker gets past its shared step, without waiting for its lock", async () => {
      const s = await sharedInstance();
      const lock = join(s.anchor, "devtrees", `${id}.lock`);
      writeFileSync(lock, `${process.pid}\n`);
      cleanups.push(() => rmSync(lock, { force: true }));
      // The `up` reaches its shared step (no target selected) while the
      // teardown waits outside the shared lock; its lock stays held.
      setTimeout(() => writeSharedStepMarker(s.anchor, id, { services: ["sb"], ports: [] }), 150);
      const result = await downNamespaces(
        { ...s.deps, lifecycleWaitMs: 20_000 },
        { namespaces: ["a"] },
      );
      expect(result).toMatchObject({ stopped: true, services: ["sa"], dependants: [] });
      expect(s.log.slice(0, 3)).toEqual(["lock", "unlock", "lock"]);
      expect(existsSync(lock)).toBe(true);
    });

    it("treats a marker that is not the current hold's as none (conservative), and removes it", async () => {
      const s = await sharedInstance();
      writeFileSync(join(s.anchor, "devtrees", `${id}.lock`), `${process.pid}\n`);
      const marker = sharedStepMarkerFile(s.anchor, id);
      // Left by a crashed holder whose lock this live process has since taken.
      writeFileSync(
        marker,
        JSON.stringify({ version: 1, pid: process.pid + 1, lock_ino: 1, services: [], ports: [] }),
      );
      const orphan = sharedStepMarkerFile(s.anchor, "gone-0a1b2c3d");
      writeFileSync(orphan, JSON.stringify({ version: 1, pid: 1, lock_ino: 1, services: [] }));
      const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
      expect(err.details?.dependants).toEqual([
        { instance: id, service: null, depends_on: [], source: "lifecycle_in_progress" },
      ]);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(orphan)).toBe(false);
    });

    it("the dry run applies the same scoping, and removes nothing", async () => {
      const s = await sharedInstance();
      const orphan = sharedStepMarkerFile(s.anchor, "gone-0a1b2c3d");
      writeFileSync(orphan, JSON.stringify({ version: 1, pid: 1, lock_ino: 1, services: [] }));
      const preview = await withLifecycleLock(s.anchor, id, async () => {
        writeSharedStepMarker(s.anchor, id, { services: ["sb"], ports: [] });
        return await previewDownNamespaces(s.deps, { namespaces: ["a"] });
      });
      expect(preview).toMatchObject({ blocked: false, dependants: [] });
      expect(existsSync(orphan)).toBe(true);
    });
  });

  it("a shared dependant fails at once, without waiting for an in-flight command", async () => {
    const s = await sharedInstance({
      processes: {
        pg: proc(),
        sa: proc({ namespace: "a" }),
        sb: proc({ namespace: "b", depends_on: { sa: { condition: "process_started" } } }),
      },
    });
    writeFileSync(
      join(s.anchor, "devtrees", `${deriveWorktreeId("/x/billing")}.lock`),
      `${process.pid}\n`,
    );
    const started = Date.now();
    const err = await failure(
      downNamespaces({ ...s.deps, lifecycleWaitMs: 5000 }, { namespaces: ["a"] }),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details?.remedy).toBe("devtrees down --shared -n a -n b");
    expect(s.log).toEqual(["lock", "unlock"]);
  });

  it("ignores a lifecycle lock whose holder is dead, and the registry, shared and hashes locks", async () => {
    const s = await sharedInstance();
    const dir = join(s.anchor, "devtrees");
    writeFileSync(join(dir, `${deriveWorktreeId("/x/gone")}.lock`), `${2 ** 22 + 12345}\n`);
    for (const name of ["registry.lock", "shared.lock", "hashes.lock"]) {
      writeFileSync(join(dir, name), `${process.pid}\n`);
    }
    const result = await downNamespaces(s.deps, { namespaces: ["a"] });
    expect(result).toMatchObject({ stopped: true, services: ["sa"], dependants: [] });
  });

  it("lists both a worktree's edges and its in-flight command, and remedies with a retry, not --force", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "login-1aaaaaaa", sharedDependsOn: { worker: ["sa"] } }],
    });
    writeFileSync(join(s.anchor, "devtrees", "login-1aaaaaaa.lock"), `${process.pid}\n`);
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.details?.dependants).toEqual([
      {
        instance: "login-1aaaaaaa",
        service: "worker",
        depends_on: ["sa"],
        source: "derived_config",
      },
      {
        instance: "login-1aaaaaaa",
        service: null,
        depends_on: [],
        source: "lifecycle_in_progress",
      },
    ]);
    expect(err.details?.remedy).toBe("devtrees down --shared -n a");
  });

  it("remedies a real worktree dependant alone with --force", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "w", sharedDependsOn: { worker: ["sa"] } }],
    });
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.details).toMatchObject({
      forceable: true,
      remedy: "devtrees down --shared -n a --force",
    });
  });

  it("removing only already-stopped services reports stopped: false, and lists them as removed", async () => {
    const s = await sharedInstance({ exited: { sa: -1 } });
    const result = await downNamespaces(s.deps, { namespaces: ["a"] });
    expect(result).toMatchObject({ stopped: false, services: ["sa"], removed: ["sa"] });
    expect(s.rows().map((r) => r.name)).toEqual(["pg", "sb"]);
    expect(s.log).toEqual(["lock", "reload", "unlock"]);
  });

  it("re-sends the removal for a leftover a timed-out reload left listed, and reports it removed", async () => {
    // The config on disk no longer holds sa, but the server still lists it, stopped.
    const s = await sharedInstance({
      processes: { pg: proc(), sb: proc({ namespace: "b" }) },
      booted: sharedProcesses,
      exited: { sa: -1 },
    });
    expect(s.rows().map((r) => r.name)).toEqual(["pg", "sa", "sb"]);
    const result = await downNamespaces(s.deps, { namespaces: ["a"] });
    expect(result).toMatchObject({ stopped: false, services: [], removed: ["sa"] });
    expect(s.rows().map((r) => r.name)).toEqual(["pg", "sb"]);
  });

  it("--force removes the services anyway and reports the dependants it overrode", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "login-1", sharedDependsOn: { worker: ["sa"] } }],
    });
    const result = await downNamespaces(s.deps, { namespaces: ["a"], force: true });
    expect(result).toMatchObject({
      stopped: true,
      services: ["sa"],
      dependants: [{ instance: "login-1", service: "worker", depends_on: ["sa"] }],
    });
    expect(Object.keys(s.configProcesses())).toEqual(["pg", "sb"]);
  });

  it("reads a pre-#239 worktree's edges from its devtrees.yaml", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "login-1" }],
      stack: { services: [svc("sa", "shared"), svc("worker", "isolated", ["sa"])] },
    });
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details?.dependants).toEqual([
      { instance: "login-1", service: "worker", depends_on: ["sa"], source: "devtrees_yaml" },
    ]);
  });

  it("counts a worktree whose dependencies cannot be read as a dependant", async () => {
    const s = await sharedInstance({ worktrees: [{ id: "login-1" }] });
    const deps: SharedInstanceDeps = {
      ...s.deps,
      readStack: () => {
        throw new Error("devtrees.yaml is gone");
      },
    };
    const err = await failure(downNamespaces(deps, { namespaces: ["a"] }));
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details?.dependants).toEqual([
      { instance: "login-1", service: null, depends_on: [], source: "unknown" },
    ]);
  });

  it("refuses a shared dependant even with --force, naming its namespace in the remedy", async () => {
    const s = await sharedInstance({
      processes: {
        pg: proc(),
        sa: proc({ namespace: "a" }),
        sb: proc({ namespace: "b", depends_on: { sa: { condition: "process_started" } } }),
      },
    });
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"], force: true }));
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details).toMatchObject({
      dependants: [{ instance: "shared", service: "sb", depends_on: ["sa"] }],
      forceable: false,
    });
    expect(err.details?.remedy).toBe("devtrees down --shared -n a -n b --force");
    expect(s.log).toEqual(["lock", "unlock"]);
  });

  it("stops the whole shared instance when nothing else would be left running", async () => {
    const s = await sharedInstance({ exited: { pg: 0 } });
    const result = await downNamespaces(s.deps, { namespaces: ["a", "b"] });
    expect(result).toMatchObject({ stopped: true, services: ["sa", "sb"], instanceStopped: true });
    expect(s.log).toContain("down");
    expect(s.pc.isUp(s.paths.socketPath)).toBe(false);
    expect(s.log).not.toContain("reload");
    expect(existsSync(s.paths.socketPath)).toBe(false);
    expect(existsSync(s.paths.configPath)).toBe(false);
  });

  it("a refused reload fails SHARED_REMOVAL_FAILED, restores the config and keeps the records", async () => {
    const s = await sharedInstance({ rejectReload: true });
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.code).toBe("SHARED_REMOVAL_FAILED");
    expect(err.details).toMatchObject({
      services: ["sa"],
      reason: "error",
      remedy: "devtrees down --shared -n a",
    });
    expect(Object.keys(s.configProcesses())).toEqual(["pg", "sa", "sb"]);
    expect(Object.keys(readSharedState(s.anchor)?.services ?? {})).toEqual(["pg", "sa", "sb"]);
    // The reload was refused: sa (already stopped) is still listed, the rest run.
    expect(s.rows().map((r) => [r.name, r.status])).toEqual([
      ["pg", "Running"],
      ["sa", "Completed"],
      ["sb", "Running"],
    ]);
  });

  it("a refused stop fails SHARED_REMOVAL_FAILED with nothing removed", async () => {
    const s = await sharedInstance({ refuseStop: "FTL failed to stop process sa" });
    const err = await failure(downNamespaces(s.deps, { namespaces: ["a"] }));
    expect(err.code).toBe("SHARED_REMOVAL_FAILED");
    expect(err.details).toMatchObject({ reason: "stop_refused", services: ["sa"] });
    expect(s.log).not.toContain("reload");
    expect(Object.keys(s.configProcesses())).toEqual(["pg", "sa", "sb"]);
    expect(s.rows().find((r) => r.name === "sa")?.status).toBe("Running");
  });
});

describe("SharedInstance.previewDownNamespaces: down --shared -n --dry-run (#239)", () => {
  it("previews what would stop and what blocks it, with no lock, stop or reload", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: deriveWorktreeId("/x/login"), sharedDependsOn: { worker: ["sa"] } }],
    });
    const preview = await previewDownNamespaces(s.deps, { namespaces: ["a", "nope"] });
    expect(preview).toMatchObject({
      namespaces: ["a", "nope"],
      running: true,
      services: ["sa"],
      inactiveNamespaces: ["nope"],
      wouldStopInstance: false,
      blocked: true,
    });
    expect(preview.dependants).toHaveLength(1);
    expect(s.log).toEqual([]);
    expect(Object.keys(s.configProcesses())).toEqual(["pg", "sa", "sb"]);
  });

  it("with --force a worktree dependant no longer blocks", async () => {
    const s = await sharedInstance({
      worktrees: [{ id: "w", sharedDependsOn: { worker: ["sa"] } }],
    });
    const preview = await previewDownNamespaces(s.deps, { namespaces: ["a"], force: true });
    expect(preview.blocked).toBe(false);
    expect(preview.dependants).toHaveLength(1);
  });

  it("leaves a stale shared socket file in place and reports nothing running", async () => {
    // A socket file with no server behind it: the probe reads it stale.
    const s = await sharedInstance({ live: false });
    writeFileSync(s.paths.socketPath, "");
    const preview = await previewDownNamespaces(s.deps, { namespaces: ["a"] });
    expect(preview).toMatchObject({ running: false, services: [], wouldStopInstance: false });
    expect(existsSync(s.paths.socketPath)).toBe(true);
  });
});
