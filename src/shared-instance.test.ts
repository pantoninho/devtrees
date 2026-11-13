/**
 * The shared instance module (#257, #258) at its interface: `ensure`,
 * `preview`, `ports`, `down`, `portMap`, `prunePorts`, `endpoint` and
 * `services` against a temp anchor and the in-memory process-compose. The
 * namespaced teardown (`downNamespaces`) is in
 * src/shared-instance.teardown.test.ts. The real-binary behaviour is in the
 * smoke suite (src/real-pc.smoke.test.ts).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorktreeId } from "./anchor.js";
import { runUp, type CommandDeps } from "./commands.js";
import { createInMemoryProcessCompose, type PcRequest } from "./in-memory-driver.js";
import { classifyError } from "./output.js";
import { runDir, sharedInstancePaths } from "./paths.js";
import { sharedStepMarkerFile, withLifecycleLock } from "./registry.js";
import { selectSharedServices } from "./selection.js";
import {
  openSharedInstance,
  type EnsureRequest,
  type SharedInstance,
  type SharedInstanceDeps,
  type SharedRequest,
} from "./shared-instance.js";
import { readSharedPortMap, writeSharedPortMap } from "./shared-ports.js";
import { readSharedState, writeSharedState } from "./shared-state.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function svc(
  name: string,
  tier: "isolated" | "shared",
  extra: Partial<ResolvedService> = {},
): ResolvedService {
  return {
    name,
    tier,
    command: `sleep 300 # ${name}`,
    ports: [],
    environment: [],
    dependsOn: [],
    ...extra,
  };
}

/** Always-on `pg`, `cache` in namespace `cache`, and an isolated `web` that uses pg. */
const pg = svc("pg", "shared", { ports: ["PG_PORT"] });
const cache = svc("cache", "shared", { ports: ["CACHE_PORT"], namespace: "cache" });
const web = svc("web", "isolated", { ports: ["WEB_PORT"], dependsOn: [{ name: "pg" }] });
const stack: ResolvedStack = { services: [pg, cache, web] };

const BLOCK = { base: 30000, size: 10 };

/** Positional shared numbers for `stack`: its shared ports in declaration order. */
function positional(of: ResolvedStack) {
  const names = of.services.filter((s) => s.tier === "shared").flatMap((s) => s.ports);
  return (name: string) => {
    const i = names.indexOf(name);
    return i === -1 ? undefined : BLOCK.base + i;
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dt-si-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const anchor = join(root, ".git");
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
  const log: string[] = [];
  const warnings: string[] = [];
  const pc = createInMemoryProcessCompose({
    firstPid: 11,
    onRequest: (r: PcRequest) => {
      if (r.op !== "list") log.push(`${r.op}${r.services ? ` ${r.services.join(" ")}` : ""}`);
    },
  });
  const deps: SharedInstanceDeps = {
    anchor,
    driver: pc.driver,
    sharedLock: async (_anchor, fn) => {
      log.push("lock");
      try {
        return await fn();
      } finally {
        log.push("unlock");
      }
    },
    liveness: { probe: (path) => pc.probeSocket(path), retryDelaysMs: [] },
    probeSocket: (path) => pc.probeSocket(path),
    warn: (message) => warnings.push(message),
    waitTimeoutMs: 2_000,
    previewReadTimeoutMs: 2_000,
    stop: {
      readProcessTable: async () => [],
      isAlive: () => false,
      kill: () => {},
      pollMs: 1,
      treeGraceMs: 1,
      graceMs: 1,
    },
  };
  const shared = openSharedInstance(deps);
  const sock = sharedInstancePaths(anchor).socketPath;
  const row = (name: string) => pc.rows(sock).find((r) => r.name === name);
  /** The shared side of an `up` of `of` selecting `namespaces`. */
  const request = (namespaces: string[], of: ResolvedStack = stack): SharedRequest => ({
    stack: of,
    worktreeId: "login-3f9c2a1b",
    selected: selectSharedServices(of, namespaces),
    namespaces,
    seed: { positional: positional(of), block: BLOCK },
  });
  const ensure = (namespaces: string[], of: ResolvedStack = stack) =>
    shared.ensure({ ...request(namespaces, of), waitNow: true });
  return { anchor, pc, log, warnings, shared, sock, row, request, ensure };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return classifyError(err as Error);
  }
  throw new Error("expected a failure");
}

describe("shared instance: ensure (#257)", () => {
  it("lazy-starts the shared instance with the selected services only, under the shared lock", async () => {
    const { anchor, pc, log, sock, ensure } = setup();
    const outcome = await ensure(["default"]);
    expect(outcome).toMatchObject({ started: true, activated: [], restarted: [] });
    expect(outcome.selected.map((s) => s.name)).toEqual(["pg"]);
    expect(outcome.portFor("PG_PORT")).toBe(30000);
    // The spawn happens inside the lock; nothing touches the instance outside it.
    expect(log).toEqual(["lock", "up", "unlock"]);
    expect(pc.rows(sock).map((r) => r.name)).toEqual(["pg"]);
    // The instance is the source of truth for what it runs (#83, #236), and
    // the stable map records every shared port the stack declares (#238).
    const state = readSharedState(anchor);
    expect(state?.ports).toEqual({ PG_PORT: 30000 });
    expect(Object.keys(state?.services ?? {})).toEqual(["pg"]);
    expect(readSharedPortMap(anchor)).toEqual({ PG_PORT: 30000, CACHE_PORT: 30001 });
  });

  it("is idempotent: a second ensure finds it running and changes nothing", async () => {
    const { log, row, ensure } = setup();
    await ensure(["default"]);
    const pid = row("pg")?.pid;
    log.length = 0;
    const outcome = await ensure(["default"]);
    expect(outcome).toMatchObject({ started: false, activated: [], restarted: [] });
    expect(outcome.portFor("PG_PORT")).toBe(30000);
    expect(log).toEqual(["lock", "unlock"]);
    expect(row("pg")?.pid).toBe(pid);
  });

  it("adds a selected namespaced shared service by a reload that leaves the running ones untouched", async () => {
    const { anchor, log, row, ensure } = setup();
    await ensure(["default"]);
    const pid = row("pg")?.pid;
    log.length = 0;
    const outcome = await ensure(["cache"]);
    expect(outcome).toMatchObject({ started: false, activated: ["cache"], restarted: [] });
    expect(outcome.portFor("CACHE_PORT")).toBe(30001);
    expect(log).toEqual(["lock", "reload", "unlock"]);
    expect(row("pg")?.pid).toBe(pid);
    expect(row("cache")).toMatchObject({ status: "Running", running: true });
    const state = readSharedState(anchor);
    expect(state?.ports).toEqual({ PG_PORT: 30000, CACHE_PORT: 30001 });
    expect(Object.keys(state?.services ?? {})).toEqual(["pg", "cache"]);
  });

  it("revives a re-added service the instance still lists, stopped (#239)", async () => {
    // A `down --shared -n cache` stopped cache and forgot it, but its
    // removing reload never landed: the instance still lists it, stopped.
    const { anchor, pc, sock, log, row, ensure } = setup();
    await ensure(["cache"]);
    await pc.driver.stopProcesses(sock, ["cache"]);
    const state = readSharedState(anchor);
    writeSharedState(anchor, {
      hash: state?.hash ?? "",
      ports: { PG_PORT: 30000 },
      services: { pg: state?.services?.["pg"] ?? { hash: "", ports: [] } },
    });
    log.length = 0;
    const outcome = await ensure(["cache"]);
    expect(outcome).toMatchObject({ activated: ["cache"], restarted: ["cache"] });
    expect(log).toEqual(["lock", "reload", "start cache", "unlock"]);
    expect(row("cache")).toMatchObject({ status: "Running", running: true });
  });

  it("restarts a dead selected shared service, after the drift check, under the shared lock (#240)", async () => {
    // cache keeps the instance up: process-compose exits once nothing runs.
    const { pc, sock, log, row, ensure } = setup();
    await ensure(["cache"]);
    const pid = row("pg")?.pid;
    pc.exit(sock, "pg", 1);
    log.length = 0;
    const outcome = await ensure(["cache"]);
    expect(outcome).toMatchObject({ started: false, activated: [], restarted: ["pg"] });
    expect(log).toEqual(["lock", "start pg", "unlock"]);
    expect(row("pg")).toMatchObject({ status: "Running", running: true });
    expect(row("pg")?.pid).not.toBe(pid);
  });

  it("refuses a drifted selected service with SHARED_DRIFT before restarting or recording anything", async () => {
    const { anchor, pc, sock, log, row, ensure } = setup();
    await ensure(["cache"]);
    pc.exit(sock, "pg", 1);
    const map = readFileSync(join(anchor, "devtrees", "shared-ports.json"), "utf8");
    const edited: ResolvedStack = {
      services: [
        { ...pg, command: "postgres -c fsync=off" },
        cache,
        web,
        svc("redis", "shared", { ports: ["REDIS_PORT"] }),
      ],
    };
    log.length = 0;
    const err = await failure(ensure(["default"], edited));
    expect(err.code).toBe("SHARED_DRIFT");
    expect(err.details).toMatchObject({ services: [{ service: "pg" }] });
    // Nothing was started, and the new REDIS_PORT was not recorded.
    expect(log).toEqual(["lock", "unlock"]);
    expect(row("pg")).toMatchObject({ running: false });
    expect(readFileSync(join(anchor, "devtrees", "shared-ports.json"), "utf8")).toBe(map);
  });

  it("does not check an unselected shared service for drift (#236)", async () => {
    const { ensure } = setup();
    await ensure(["default"]);
    const edited: ResolvedStack = {
      services: [pg, { ...cache, command: "redis-server --port 0" }, web],
    };
    await expect(ensure(["default"], edited)).resolves.toMatchObject({ started: false });
  });

  it("keeps every recorded shared port across a branch that lays the shared services out differently (ADR-0011)", async () => {
    const { anchor, ensure } = setup();
    await ensure(["default"]);
    // Another branch declares a new namespaced shared service first: its
    // positional numbers all move, the recorded ones must not.
    const redis = svc("redis", "shared", { ports: ["REDIS_PORT"], namespace: "r" });
    const branch: ResolvedStack = { services: [redis, pg, cache, web] };
    const outcome = await ensure(["r"], branch);
    expect(outcome.activated).toEqual(["redis"]);
    expect(outcome.portFor("PG_PORT")).toBe(30000);
    expect(outcome.portFor("CACHE_PORT")).toBe(30001);
    expect(outcome.portFor("REDIS_PORT")).toBe(30002);
    expect(readSharedPortMap(anchor)).toEqual({
      PG_PORT: 30000,
      CACHE_PORT: 30001,
      REDIS_PORT: 30002,
    });
  });

  it("writes the shared-step marker under the shared lock, naming the selected services and the shared ports", async () => {
    const { anchor, log, shared, request } = setup();
    const marker = sharedStepMarkerFile(anchor, "login-3f9c2a1b");
    let seen: unknown;
    await withLifecycleLock(anchor, "login-3f9c2a1b", async () => {
      await shared.ensure({ ...request(["default"]), waitNow: true, booted: ["web"] });
      seen = JSON.parse(readFileSync(marker, "utf8"));
    });
    expect(seen).toMatchObject({ services: ["pg"], ports: ["PG_PORT", "CACHE_PORT"] });
    expect(log[0]).toBe("lock");
  });

  it("with no shared tier: starts nothing, takes no lock, injects the positional numbers", async () => {
    const { log, pc, sock, shared } = setup();
    const isolated: ResolvedStack = { services: [svc("web", "isolated")] };
    const outcome = await shared.ensure({
      stack: isolated,
      worktreeId: "login-3f9c2a1b",
      selected: [],
      namespaces: ["default"],
      seed: { positional: () => 31234, block: undefined },
      waitNow: true,
    });
    expect(outcome).toMatchObject({ started: false, selected: [] });
    expect(outcome.portFor("ANY")).toBe(31234);
    expect(log).toEqual([]);
    expect(pc.isUp(sock)).toBe(false);
  });

  it("fails SHARED_START_FAILED when the lazy-started instance exits at once (#262)", async () => {
    const { pc, sock, shared, request } = setup();
    // Every shared service it starts dies at once, so process-compose exits.
    const pending = shared.ensure({ ...request(["default"]), waitNow: false });
    const outcome = await pending;
    pc.exit(sock, "pg", 1);
    const err = await failure(outcome.ready());
    expect(err.code).toBe("SHARED_START_FAILED");
  });
});

describe("shared instance: preview (#257)", () => {
  it("previews the dead services the real up would restart, read-only: no lock, no start, no write", async () => {
    const { anchor, pc, sock, log, row, shared, request } = setup();
    await shared.ensure({ ...request(["cache"]), waitNow: true });
    pc.exit(sock, "pg", 1);
    const map = readFileSync(join(anchor, "devtrees", "shared-ports.json"), "utf8");
    log.length = 0;
    const preview = await shared.preview(request(["default"]));
    expect(preview.wouldRestart).toEqual(["pg"]);
    expect(preview.portFor("PG_PORT")).toBe(30000);
    // What a lazy start of this selection would spawn.
    expect(Object.keys(preview.derived?.config.processes ?? {})).toEqual(["pg"]);
    expect(log).toEqual([]);
    expect(row("pg")).toMatchObject({ running: false });
    expect(readFileSync(join(anchor, "devtrees", "shared-ports.json"), "utf8")).toBe(map);
  });

  it("with no shared instance yet: predicts the positional numbers and records none", async () => {
    const { anchor, shared, request } = setup();
    const preview = await shared.preview(request(["cache"]));
    expect(preview.wouldRestart).toEqual([]);
    expect(preview.portFor("CACHE_PORT")).toBe(30001);
    expect(Object.keys(preview.derived?.config.processes ?? {})).toEqual(["pg", "cache"]);
    expect(existsSync(join(anchor, "devtrees", "shared-ports.json"))).toBe(false);
  });
});

describe("shared instance: ports (#257)", () => {
  it("reports each shared port's origin without recording any", async () => {
    const { anchor, shared, request } = setup();
    await shared.ensure({ ...request(["default"]), waitNow: true });
    const { seed, stack: of, worktreeId } = request([]);
    const ports = await shared.ports({ stack: of, worktreeId, seed });
    expect(ports?.ports).toEqual({ PG_PORT: 30000, CACHE_PORT: 30001 });
    expect(ports?.origins).toMatchObject({
      PG_PORT: { port: 30000, origin: "active" },
      CACHE_PORT: { port: 30001, origin: "recorded" },
    });
    expect(readSharedPortMap(anchor)).toEqual({ PG_PORT: 30000, CACHE_PORT: 30001 });
  });

  it("fails SHARED_DRIFT when an always-on shared service drifted, as up would", async () => {
    const { shared, request } = setup();
    await shared.ensure({ ...request(["default"]), waitNow: true });
    const edited: ResolvedStack = {
      services: [{ ...pg, command: "postgres -c fsync=off" }, cache],
    };
    const { seed, worktreeId } = request([], edited);
    const err = await failure(shared.ports({ stack: edited, worktreeId, seed }));
    expect(err.code).toBe("SHARED_DRIFT");
  });
});

describe("shared instance: down, `down --shared` (#258)", () => {
  it("stops the whole shared instance under the shared lock and drops its config, keeping the port map", async () => {
    const { anchor, pc, log, sock, shared, ensure } = setup();
    await ensure(["cache"]);
    log.length = 0;
    expect(await shared.down()).toEqual({ stopped: true, forceKilled: [] });
    expect(log).toEqual(["lock", "down", "unlock"]);
    expect(pc.isUp(sock)).toBe(false);
    expect(existsSync(sharedInstancePaths(anchor).configPath)).toBe(false);
    // The port map is a repo-wide reservation: it survives the teardown (ADR-0011).
    expect(readSharedPortMap(anchor)).toEqual({ PG_PORT: 30000, CACHE_PORT: 30001 });
  });

  it("is a no-op when the shared instance is not running", async () => {
    const { log, shared } = setup();
    expect(await shared.down()).toEqual({ stopped: false, forceKilled: [] });
    expect(log).toEqual(["lock", "unlock"]);
  });

  it("unlinks the socket a crashed instance left behind, and stops nothing (#80)", async () => {
    const { log, pc, sock, shared, ensure } = setup();
    await ensure(["default"]);
    pc.crash(sock);
    log.length = 0;
    expect(await shared.down()).toEqual({ stopped: false, forceKilled: [] });
    expect(existsSync(sock)).toBe(false);
    expect(log).toEqual(["lock", "unlock"]);
  });
});

describe("shared instance: portMap, `ls`'s shared ports (#258)", () => {
  it("lists every recorded port, active only while the running shared instance binds it", async () => {
    const { shared, ensure } = setup();
    expect(shared.portMap(false)).toEqual({});
    await ensure(["default"]);
    expect(shared.portMap(true)).toEqual({
      PG_PORT: { port: 30000, origin: "active" },
      CACHE_PORT: { port: 30001, origin: "recorded" },
    });
    expect(shared.portMap(false)).toEqual({
      PG_PORT: { port: 30000, origin: "recorded" },
      CACHE_PORT: { port: 30001, origin: "recorded" },
    });
  });
});

describe("shared instance: prunePorts, `prune --shared-ports` (#258)", () => {
  /** A running shared instance whose map also records a name nothing holds. */
  async function withStaleName() {
    const fx = setup();
    await fx.ensure(["default"]);
    writeSharedPortMap(fx.anchor, { ...readSharedPortMap(fx.anchor), OLD_PORT: 30005 });
    fx.log.length = 0;
    return fx;
  }

  it("drops a recorded name nothing holds, under the shared lock, and keeps the held ones", async () => {
    const { anchor, log, shared } = await withStaleName();
    const result = await shared.prunePorts({ sharedBlock: () => BLOCK });
    expect(result).toEqual({
      dropped: ["OLD_PORT"],
      kept: ["CACHE_PORT", "PG_PORT"],
      outOfBlock: [],
      dryRun: false,
      blockedBy: [],
    });
    expect(log).toEqual(["lock", "unlock"]);
    expect(readSharedPortMap(anchor)).toEqual({ PG_PORT: 30000, CACHE_PORT: 30001 });
  });

  it("the dry run reports the same without the lock or a write", async () => {
    const { anchor, log, shared } = await withStaleName();
    const result = await shared.prunePorts({ dryRun: true, sharedBlock: () => BLOCK });
    expect(result).toMatchObject({ dropped: ["OLD_PORT"], dryRun: true, blockedBy: [] });
    expect(log).toEqual([]);
    expect(readSharedPortMap(anchor)).toMatchObject({ OLD_PORT: 30005 });
  });

  it("refuses LOCK_CONTENTION while a worktree's lifecycle command is in flight; the dry run names it", async () => {
    const { anchor, shared } = await withStaleName();
    const id = "billing-0a1b2c3d";
    const [err, preview] = await withLifecycleLock(anchor, id, async () => [
      await failure(shared.prunePorts({ sharedBlock: () => BLOCK })),
      await shared.prunePorts({ dryRun: true, sharedBlock: () => BLOCK }),
    ]);
    expect(err).toMatchObject({ code: "LOCK_CONTENTION" });
    expect(preview).toMatchObject({ dropped: ["OLD_PORT"], blockedBy: [id] });
    expect(readSharedPortMap(anchor)).toMatchObject({ OLD_PORT: 30005 });
  });
});

describe("shared instance: endpoint and services (#258)", () => {
  it("names the control socket and config only while the socket file is there, and the services its config runs", async () => {
    const { anchor, shared, ensure } = setup();
    expect(shared.endpoint()).toBeUndefined();
    expect(shared.services()).toEqual([]);
    await ensure(["cache"]);
    const { socketPath, configPath } = sharedInstancePaths(anchor);
    expect(shared.endpoint()).toEqual({ socketPath, configPath });
    expect(shared.services().map((s) => [s.name, s.namespace])).toEqual([
      ["pg", undefined],
      ["cache", "cache"],
    ]);
  });
});

describe("worktree up with a substituted shared instance (#257)", () => {
  /** A worktree `up` whose shared side is `sharedInstance`, on the in-memory process-compose. */
  function worktreeUp(sharedInstance: SharedInstance) {
    const root = mkdtempSync(join(tmpdir(), "dt-si-up-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const anchor = join(root, ".git");
    const top = join(root, "wt", "login");
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    mkdirSync(top, { recursive: true });
    cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
    const pc = createInMemoryProcessCompose({ firstPid: 11 });
    const deps: CommandDeps = {
      cwd: top,
      git: (args) => (args[1] === "--git-common-dir" ? anchor : top),
      readStack: () => stack,
      processCompose: pc.driver,
      probeSocket: (path) => pc.probeSocket(path),
      probeRetryDelaysMs: [],
      isPortFree: () => true,
      portHolder: () => ({ free: true }),
      waitForHealth: async () => {},
      attach: false,
      warn: () => {},
      sharedInstance,
    };
    return { deps, pc, anchor, id: deriveWorktreeId(top) };
  }

  it("injects the shared ports the shared instance hands out and never touches the shared socket", async () => {
    const requests: EnsureRequest[] = [];
    const waited: string[] = [];
    const fake: SharedInstance = {
      ensure: async (request) => {
        requests.push(request);
        return {
          started: true,
          activated: [],
          restarted: [],
          ready: async () => {},
          awaitDependencies: async () => {
            waited.push("dependencies");
          },
          fieldChanges: [],
          portFor: (name) => (name === "PG_PORT" ? 41000 : undefined),
          selected: request.selected,
        };
      },
      preview: () => Promise.reject(new Error("not previewed")),
      ports: () => Promise.reject(new Error("not read")),
      down: () => Promise.reject(new Error("not torn down")),
      downNamespaces: () => Promise.reject(new Error("not torn down")),
      previewDownNamespaces: () => Promise.reject(new Error("not previewed")),
      portMap: () => {
        throw new Error("not listed");
      },
      prunePorts: () => Promise.reject(new Error("not pruned")),
      endpoint: () => undefined,
      services: () => [],
    };
    const { deps, pc, anchor, id } = worktreeUp(fake);
    const result = await runUp(deps);
    expect(result).toMatchObject({ worktreeId: id, sharedStarted: true });
    expect(result.env["PG_PORT"]).toBe("41000");
    // The fresh `up` hands the module its selection's shared closure and waits now.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ worktreeId: id, namespaces: ["default"], waitNow: true });
    expect(requests[0]?.selected.map((s) => s.name)).toEqual(["pg"]);
    expect(requests[0]?.booted).toEqual(["web"]);
    // web -> pg is a dropped cross-tier edge: the module's health gate ran.
    expect(waited).toEqual(["dependencies"]);
    const shared = sharedInstancePaths(anchor).socketPath;
    expect(pc.requests.filter((r) => r.socketPath === shared)).toEqual([]);
  });
});
