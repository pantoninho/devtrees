/**
 * `runUp` orchestration tests.
 *
 * Exercise the wired-up behaviour — per-service multi-port mapping, per-repo
 * allocator config, lock-guarded allocation, and the unmanaged-port warning —
 * through the public `runUp` interface, with every side-effecting collaborator
 * (git, registry lock, port probe, process-compose driver) injected as a stub.
 * Asserts on the returned `UpResult.env` and on emitted warnings; no on-disk
 * state and no real `process-compose` are involved.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { SpawnOptions } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  filterLogEventsSince,
  findUnmanagedPortBinds,
  runAttach,
  runDown,
  runEnv,
  runLogs,
  runUp,
  runUpDryRun,
  type CommandDeps,
  type WithLifecycleLock,
  type WithSharedLock,
} from "./commands.js";
import { withLifecycleLock } from "./registry.js";
import { deriveWorktreeId } from "./anchor.js";
import { deriveSharedConfig, deriveWorktreeConfig, type DerivedConfig } from "./deriver.js";
import type { RegistrySnapshot } from "./allocator.js";
import type {
  ControlRequest,
  ControlRequester,
  LogEvent,
  ServiceStatus,
  SpawnedProcess,
} from "./driver.js";
import type { InstanceStatus } from "./instances.js";
import { classifyError } from "./output.js";
import {
  SHARED_REGISTRY_KEY,
  SOCKET_PATH_MAX_BYTES,
  instancePaths,
  runDir,
  sharedInstancePaths,
} from "./paths.js";
import { sharedServiceHash, sharedStackHash, stackHash } from "./hash.js";
import { readSharedState } from "./shared-state.js";
import { readPendingReload, writePendingReload, type PendingReload } from "./reload-pending.js";
import type { ResolvedService, ResolvedStack, ServiceDependency } from "./stack.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** Compact builder for a normalized service — keeps the test bodies declarative. */
function service(
  name: string,
  command: string,
  ports: string[] = [],
  tier: "isolated" | "shared" = "isolated",
) {
  return {
    name,
    tier,
    command,
    ports,
    dependsOn: [] as ServiceDependency[],
    environment: [] as string[],
  };
}
const isolated = (name: string, command: string, ports: string[] = []) =>
  service(name, command, ports, "isolated");
const shared = (name: string, command: string, ports: string[] = []) =>
  service(name, command, ports, "shared");

function tmpAnchor(): { anchor: string; worktreeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "dt-cmd-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const anchor = join(root, ".git");
  // The anchor state dir used to appear as a side effect of creating the run
  // dir under it; since #156 the run dir lives elsewhere, so tests that stage
  // a derived config by hand need it created here. The run dir itself is
  // outside the temp root, so it gets its own cleanup.
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
  return { anchor, worktreeRoot: join(root, "wt") };
}

/** A no-op shared lifecycle lock — wraps the callback without any contention. */
const passThroughSharedLock: WithSharedLock = (_anchor, fn) => fn();

/** Track every `process-compose up` invocation so tests can assert on shared starts. */
interface UpInvocation {
  configPath: string;
  socketPath: string;
}

interface StubSpawn {
  invocations: UpInvocation[];
  /**
   * When true, the next stub-spawn marks the socket file as existing so a
   * subsequent `existsSync(socketPath)` in `ensureSharedStarted` sees the
   * shared instance as running.
   */
  touchSocket: boolean;
}

/**
 * SpawnedProcess that pretends to be a real `process-compose` child: fires
 * `exit(0)` on the next tick so `driver.down`/`attach` (which await an exit
 * event) resolve cleanly, and ignores `error` listeners.
 */
function spawnedOk(): SpawnedProcess {
  const exitHandlers: Array<(code: number | null) => void> = [];
  queueMicrotask(() => {
    for (const h of exitHandlers) h(0);
  });
  return {
    on(event: "error" | "exit", cb: (arg: never) => void): void {
      if (event === "exit") exitHandlers.push(cb as (code: number | null) => void);
    },
    unref: () => {},
  };
}

/**
 * A stub for process-compose's REST API (the hot-reload goes over it, #194):
 * answers every request with `status`, recording each one in `seen`.
 */
function reloadAnswering(status: number, seen: ControlRequest[] = []): ControlRequester {
  return (request) => {
    seen.push(request);
    return Promise.resolve({ status, body: status === 200 ? "{}" : "" });
  };
}

/**
 * A `process-compose process start` child that refuses: writes `stderr` the
 * way the real binary logs a refusal, then exits 1 (issue #178).
 */
function refusedStart(stderr: string): SpawnedProcess {
  const exitHandlers: Array<(code: number | null) => void> = [];
  setTimeout(() => {
    for (const h of exitHandlers) h(1);
  }, 5);
  return {
    on(event: "error" | "exit", cb: (arg: never) => void): void {
      if (event === "exit") exitHandlers.push(cb as (code: number | null) => void);
    },
    stderr: Readable.from([stderr]),
  };
}

/** Find the shared-instance up-spawn in a tracker, asserting it happened. */
function findSharedSpawn(track: StubSpawn): UpInvocation {
  const spawn = track.invocations.find((i) => i.socketPath.endsWith("/shared.sock"));
  if (spawn === undefined) throw new Error("expected a shared.sock spawn");
  return spawn;
}

/** Allocate a temp anchor + worktree-root + registry ref for a multi-worktree test. */
function multiWorktreeFixture(prefix: string): {
  sharedAnchor: string;
  wtRoot: string;
  registryRef: { snapshot: RegistrySnapshot };
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    sharedAnchor: join(root, ".git"),
    wtRoot: join(root, "wt"),
    registryRef: { snapshot: {} as RegistrySnapshot },
  };
}

function makeStubSpawner(track: StubSpawn) {
  return (_binary: string, args: ReadonlyArray<string>, _options: unknown): SpawnedProcess => {
    const ai = args.indexOf("-f");
    const si = args.indexOf("-u");
    if (ai >= 0 && si >= 0 && args[0] === "up") {
      const configPath = args[ai + 1] ?? "";
      const socketPath = args[si + 1] ?? "";
      track.invocations.push({ configPath, socketPath });
      if (track.touchSocket) {
        // Mimic process-compose creating the control socket as a liveness marker.
        writeFileSync(socketPath, "");
      }
    }
    return spawnedOk();
  };
}

/**
 * The id `resolveAnchor` derives for a worktree at `<root>/<basename>` — the
 * slug plus the path-hash suffix (issue #82). Tests that fake git's
 * `--show-toplevel` with such a path use this to predict the resulting id.
 */
function idFor(root: string, basename: string): string {
  return deriveWorktreeId(join(root, basename));
}

/**
 * `CommandDeps` plus the worktree id the stubbed git probe will resolve to,
 * so tests can assert on ids/paths without re-deriving them by hand.
 */
type StubbedDeps = CommandDeps & { readonly expectedWorktreeId: string };

/** Build a `CommandDeps` whose every collaborator is a deterministic stub. */
function stubDeps(opts: {
  stack: ResolvedStack;
  worktreeId?: string;
  initialRegistry?: RegistrySnapshot;
  isPortFree?: (port: number) => boolean | Promise<boolean>;
  warn?: (m: string) => void;
  /**
   * Tracker for `process-compose up` invocations + a flag to make the stub
   * spawner touch the socket file (so the shared lazy-start sees it as running).
   */
  track?: StubSpawn;
  anchorOverride?: string;
  worktreeRootOverride?: string;
  registryRef?: { snapshot: RegistrySnapshot };
  /**
   * Liveness verdict for an existing socket file (#80). Default: "running" —
   * mirrors the pre-#80 "file present ⇒ live" fiction the older tests fake
   * instances with (a plain file would probe stale against a real UDS connect).
   */
  probeSocket?: (socketPath: string) => Promise<InstanceStatus>;
}): StubbedDeps {
  const tmp = tmpAnchor();
  const anchor = opts.anchorOverride ?? tmp.anchor;
  const worktreeRoot = opts.worktreeRootOverride ?? tmp.worktreeRoot;
  const worktreeId = opts.worktreeId ?? "login";
  const expectedWorktreeId = idFor(worktreeRoot, worktreeId);
  const snapshotRef =
    opts.registryRef ??
    ({ snapshot: opts.initialRegistry ?? {} } as { snapshot: RegistrySnapshot });

  // Fake git: tell the anchor resolver everything it needs without spawning git.
  const git = (args: ReadonlyArray<string>): string => {
    const flag = args[1];
    if (flag === "--git-common-dir") return anchor;
    if (flag === "--show-toplevel") return join(worktreeRoot, worktreeId);
    if (flag === "--is-bare-repository") return "false";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };

  const track = opts.track ?? { invocations: [], touchSocket: false };

  return {
    expectedWorktreeId,
    cwd: join(worktreeRoot, worktreeId),
    git,
    readStack: () => opts.stack,
    withRegistryLock: async (_anchor, mutate) => {
      const after = await mutate(snapshotRef.snapshot);
      snapshotRef.snapshot = after;
      return after;
    },
    readRegistry: () => snapshotRef.snapshot,
    withSharedLock: passThroughSharedLock,
    isPortFree: opts.isPortFree ?? (() => true),
    // Default port-holder stub mirrors isPortFree's "everything free" default:
    // the real default (`defaultPortHolder`) does a real TCP bind, which
    // races against concurrent test workers binding the same port range.
    // Tests that exercise stale-port-block detection override this.
    portHolder: async () => ({ free: true as const }),
    // Nothing listens, as the holder stub says (#155): `down`'s survivor
    // check finds no listener, and a test that arms a holder arms this too.
    portAccepts: async () => false,
    portSettleMs: 0,
    warn: opts.warn,
    attach: false,
    // Tests that don't care about the worktree health-wait (#28) get a no-op
    // stub — the default polls a real `process-compose` over the UDS, which
    // would hang the unit test. Tests that *do* care override this field.
    waitForHealth: () => Promise.resolve(),
    // Default verdict "running" preserves the pre-#80 semantics existing
    // tests fake liveness with (touching a plain file at the socket path).
    probeSocket: opts.probeSocket ?? (async () => "running" as const),
    // The stub spawner with touchSocket: false never binds a socket, so the
    // real post-spawn socket poll (#91) would burn its full timeout in most
    // tests. Tests that care about the socket-wait override this field.
    waitForSocketFile: () => Promise.resolve(),
    // The version probe (#173) would run through the stub spawner, which
    // prints nothing; the check itself is covered in its own describe block.
    assertProcessComposeVersion: () => Promise.resolve(),
    // Driver that records every spawn but doesn't actually run anything; a
    // hot-reload (#194) is accepted without touching any socket.
    driver: {
      exists: () => Promise.resolve(true),
      spawner: makeStubSpawner(track),
      controlRequest: reloadAnswering(200),
    },
  };
}

describe("runUp — port injection", () => {
  it("maps multiple named ports on one service to consecutive offsets within its block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js", ["WEB_PORT", "METRICS_PORT", "DEBUG_PORT"])],
    };
    const result = await runUp(stubDeps({ stack }));

    const web = Number(result.env.WEB_PORT);
    expect(web).toBeGreaterThanOrEqual(20000);
    expect(Number(result.env.METRICS_PORT)).toBe(web + 1);
    expect(Number(result.env.DEBUG_PORT)).toBe(web + 2);
  });

  it("gives each service its own non-overlapping sub-range when several declare ports", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node web.js", ["WEB_PORT", "METRICS_PORT"]),
        isolated("worker", "node worker.js", ["WORKER_PORT"]),
      ],
    };
    const result = await runUp(stubDeps({ stack }));
    const web = Number(result.env.WEB_PORT);
    const metrics = Number(result.env.METRICS_PORT);
    const worker = Number(result.env.WORKER_PORT);

    // Distinct numbers, all derived from one contiguous block.
    expect(new Set([web, metrics, worker]).size).toBe(3);
    // Worker comes after both web ports — third offset.
    expect(worker).toBe(web + 2);
  });

  it("rejects a stack that needs more ports than block_size allows", async () => {
    const stack: ResolvedStack = {
      allocator: { blockSize: 2 },
      services: [isolated("web", "node x.js", ["A_PORT", "B_PORT", "C_PORT"])],
    };
    await expect(runUp(stubDeps({ stack }))).rejects.toThrow(/block_size is 2/);
  });
});

describe("runUp — minimum process-compose version (#173)", () => {
  it("fails before allocating or spawning when the version probe rejects", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node server.js", ["WEB_PORT"])] };
    const track: StubSpawn = { invocations: [], touchSocket: false };
    let probed = 0;
    const deps = {
      ...stubDeps({ stack, track }),
      assertProcessComposeVersion: async () => {
        probed += 1;
        throw Object.assign(new Error("too old"), { code: "PROCESS_COMPOSE_TOO_OLD" });
      },
    };
    await expect(runUp(deps)).rejects.toMatchObject({ code: "PROCESS_COMPOSE_TOO_OLD" });
    expect(probed).toBe(1);
    expect(track.invocations).toEqual([]);
  });
});

describe("runUp — per-repo allocator config", () => {
  it("honours port_base from devtrees.yaml so two repos can keep their ranges apart", async () => {
    const stack: ResolvedStack = {
      allocator: { portBase: 40000, blockSize: 8 },
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUp(stubDeps({ stack }));
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(40000);
    // First block starts at port_base; offset 0 maps to the block base.
    expect((Number(result.env.WEB_PORT) - 40000) % 8).toBe(0);
  });

  it("falls back to deps-level defaults when devtrees.yaml omits the allocator section", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUp(stubDeps({ stack }));
    const port = Number(result.env.WEB_PORT);
    expect(port).toBeGreaterThanOrEqual(20000);
    expect((port - 20000) % 32).toBe(0);
  });
});

describe("runUp — lock-guarded persistence", () => {
  const singleWebStack: ResolvedStack = {
    services: [isolated("web", "node x.js", ["WEB_PORT"])],
  };

  it("persists a freshly-allocated block under the lock so subsequent ups reuse it", async () => {
    const deps = stubDeps({ stack: singleWebStack });

    const first = await runUp(deps);
    const second = await runUp(deps);

    expect(second.env.WEB_PORT).toBe(first.env.WEB_PORT);
  });

  it("respects an already-registered block from the snapshot (stable across restarts)", async () => {
    // The registry is keyed by the derived worktree id, so seed it under the
    // same id the stubbed git probe will resolve to.
    const result = await runUp(
      stubDeps({
        stack: singleWebStack,
        worktreeRootOverride: "/wt",
        initialRegistry: { [idFor("/wt", "login")]: 30000 },
      }),
    );
    expect(result.env.WEB_PORT).toBe("30000");
  });
});

describe("runUp — double allocation prevention", () => {
  it("two worktrees sharing one registry get distinct, non-overlapping blocks", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };

    // Both worktrees share the same registry and lock so the second `up` sees
    // the first's allocation and probes past it — exactly the contract under
    // concurrent `up`s once the lock has serialised them.
    let snapshot: RegistrySnapshot = {};
    const lock = async (
      _a: string,
      m: (s: RegistrySnapshot) => RegistrySnapshot | Promise<RegistrySnapshot>,
    ) => {
      const after = await m(snapshot);
      snapshot = after;
      return after;
    };

    const loginDeps = { ...stubDeps({ stack, worktreeId: "login" }), withRegistryLock: lock };
    const billingDeps = { ...stubDeps({ stack, worktreeId: "billing" }), withRegistryLock: lock };

    const login = await runUp(loginDeps);
    const billing = await runUp(billingDeps);

    const loginPort = Number(login.env.WEB_PORT);
    const billingPort = Number(billing.env.WEB_PORT);
    expect(loginPort).not.toBe(billingPort);
    // Blocks are 32-wide by default; the two must be at least one full block apart.
    expect(Math.abs(loginPort - billingPort)).toBeGreaterThanOrEqual(32);
  });
});

describe("runUp — unmanaged port warning", () => {
  it("warns when an isolated service's command appears to bind a port outside its block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js --port 3000", ["WEB_PORT"])],
    };
    const warnings: string[] = [];
    await runUp(stubDeps({ stack, warn: (m) => warnings.push(m) }));

    expect(warnings.some((w) => /3000/.test(w) && /web/.test(w))).toBe(true);
  });

  it("stays silent when every port literal in the command is inside the allocated block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js --port $WEB_PORT", ["WEB_PORT"])],
    };
    const warnings: string[] = [];
    await runUp(stubDeps({ stack, warn: (m) => warnings.push(m) }));

    expect(warnings).toEqual([]);
  });
});

describe("runUp — shared tier lazy start", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
    ],
  };

  it("starts the shared instance exactly once when called for the first time", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const result = await runUp(stubDeps({ stack: mixedStack, track }));

    // Two `up` spawns: one for shared, one for the worktree instance.
    expect(track.invocations).toHaveLength(2);
    const sharedSpawn = track.invocations.find((i) => i.socketPath.endsWith("/shared.sock"));
    expect(sharedSpawn).toBeDefined();
    expect(result.sharedStarted).toBe(true);
  });

  it("registers the shared block under SHARED_REGISTRY_KEY", async () => {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    await runUp(
      stubDeps({
        stack: mixedStack,
        track: { invocations: [], touchSocket: true },
        registryRef,
      }),
    );
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBeGreaterThanOrEqual(20000);
  });

  it("injects the shared service's named port into the worktree env identically", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const result = await runUp(stubDeps({ stack: mixedStack, track }));
    expect(result.env.DB_PORT).toBeDefined();
    expect(Number(result.env.DB_PORT)).toBeGreaterThanOrEqual(20000);
  });

  it("a second worktree reuses the running shared instance rather than starting another", async () => {
    // Two worktrees, same anchor and same registry — the second `up` must see
    // the shared socket from the first and skip lazy-start (acceptance).
    const { sharedAnchor, wtRoot, registryRef } = multiWorktreeFixture("dt-shared-");

    const trackA: StubSpawn = { invocations: [], touchSocket: true };
    const trackB: StubSpawn = { invocations: [], touchSocket: true };

    const a = await runUp(
      stubDeps({
        stack: mixedStack,
        worktreeId: "login",
        anchorOverride: sharedAnchor,
        worktreeRootOverride: wtRoot,
        registryRef,
        track: trackA,
      }),
    );
    const b = await runUp(
      stubDeps({
        stack: mixedStack,
        worktreeId: "billing",
        anchorOverride: sharedAnchor,
        worktreeRootOverride: wtRoot,
        registryRef,
        track: trackB,
      }),
    );

    // First call started shared; second saw it already running.
    expect(a.sharedStarted).toBe(true);
    expect(b.sharedStarted).toBe(false);

    // And only the worktree instance is spawned the second time, not shared.
    const bShared = trackB.invocations.find((i) => i.socketPath.endsWith("/shared.sock"));
    expect(bShared).toBeUndefined();

    // Same DB_PORT in both worktrees (repo-wide injection).
    expect(a.env.DB_PORT).toBe(b.env.DB_PORT);
    // Distinct WEB_PORTs (per-worktree blocks).
    expect(a.env.WEB_PORT).not.toBe(b.env.WEB_PORT);
  });

  it("writes a derived shared config to <anchor>/devtrees/shared.yaml", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack: mixedStack, track });
    await runUp(deps);
    // The anchor is whatever the stubbed git returned, recoverable from the spawn.
    const sharedSpawn = findSharedSpawn(track);
    expect(existsSync(sharedSpawn.configPath)).toBe(true);
    const config = parseYaml(readFileSync(sharedSpawn.configPath, "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(Object.keys(config.processes)).toEqual(["postgres"]);
  });

  it("does not start a shared instance when the stack declares no shared services", async () => {
    const onlyIsolated: ResolvedStack = {
      services: [isolated("web", "node server.js", ["WEB_PORT"])],
    };
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const result = await runUp(stubDeps({ stack: onlyIsolated, track }));
    expect(result.sharedStarted).toBe(false);
    const sharedSpawn = track.invocations.find((i) => i.socketPath.endsWith("/shared.sock"));
    expect(sharedSpawn).toBeUndefined();
  });

  it("two simultaneous ups see the lock-guarded ensureSharedStarted serialize them", async () => {
    // The shared lifecycle lock serialises the check-and-start, so even if both
    // worktrees race their ups, only one ends up spawning the shared instance.
    const { sharedAnchor, wtRoot, registryRef } = multiWorktreeFixture("dt-race-");

    // Use a real serialising lock so the test exercises the gate, not a mock.
    let held = false;
    const realSharedLock: WithSharedLock = async (_a, fn) => {
      while (held) await new Promise((r) => setTimeout(r, 1));
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    };

    const trackA: StubSpawn = { invocations: [], touchSocket: true };
    const trackB: StubSpawn = { invocations: [], touchSocket: true };

    const depsA: CommandDeps = {
      ...stubDeps({
        stack: mixedStack,
        worktreeId: "login",
        anchorOverride: sharedAnchor,
        worktreeRootOverride: wtRoot,
        registryRef,
        track: trackA,
      }),
      withSharedLock: realSharedLock,
    };
    const depsB: CommandDeps = {
      ...stubDeps({
        stack: mixedStack,
        worktreeId: "billing",
        anchorOverride: sharedAnchor,
        worktreeRootOverride: wtRoot,
        registryRef,
        track: trackB,
      }),
      withSharedLock: realSharedLock,
    };

    const [a, b] = await Promise.all([runUp(depsA), runUp(depsB)]);
    const totalSharedStarts = Number(a.sharedStarted) + Number(b.sharedStarted);
    expect(totalSharedStarts).toBe(1);
    const sharedSpawnA = trackA.invocations.find((i) => i.socketPath.endsWith("/shared.sock"));
    const sharedSpawnB = trackB.invocations.find((i) => i.socketPath.endsWith("/shared.sock"));
    // Exactly one of the two spawned the shared instance.
    expect(Number(Boolean(sharedSpawnA)) + Number(Boolean(sharedSpawnB))).toBe(1);
  });
});

/**
 * Issue #92 — a shared instance that dies before binding its control socket
 * must surface as a failure envelope from `up`, not `shared_started: true`.
 * The socket-wait used to return silently on deadline, so a process that
 * crashed instantly after spawn looked like a successful lazy-start.
 */
describe("runUp — shared instance dies before binding its socket (#92)", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres", ["DB_PORT"]),
    ],
  };

  it("throws SHARED_START_FAILED when the shared socket never appears", async () => {
    // touchSocket: false — the spawn returns but no socket is ever bound,
    // exactly what an instantly-dying shared instance looks like from here.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: mixedStack, track }),
      sharedSocketTimeoutMs: 50,
    };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("SHARED_START_FAILED");
    expect(err.message).toMatch(/shared/i);
    // The worktree instance was never spawned — only the doomed shared up.
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    expect(worktreeSpawn).toBeUndefined();
  });

  it("names the shared instance's real config in the remediation, not a placeholder", async () => {
    // The message used to print a literal `process-compose -f <shared config>`,
    // which is advice nobody can copy-paste. It must be the file the lazy-start
    // just wrote and spawned against — the same one `details.config_path`
    // publishes, mirroring the worktree envelope's shape (#157 follow-up).
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: mixedStack, track }),
      sharedSocketTimeoutMs: 50,
    };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject");

    expect(err.code).toBe("SHARED_START_FAILED");
    const configPath = String((err.details ?? {})["config_path"]);
    // The path the driver was actually spawned with, not a reconstruction.
    const sharedSpawn = track.invocations.find((i) => i.socketPath.endsWith("/shared.sock"));
    expect(configPath).toBe(sharedSpawn?.configPath);
    expect(existsSync(configPath)).toBe(true);
    expect(err.message).toContain(`process-compose -f ${configPath}`);
    expect(err.message).not.toContain("<shared config>");
  });

  it("does not persist shared state when the start failed", async () => {
    // The persisted name→port map is the running instance's identity (#83);
    // a failed start must not record one, or the next `up` would inject
    // numbers nothing ever bound.
    const { sharedAnchor, wtRoot, registryRef } = multiWorktreeFixture("dt-sockfail-");
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({
        stack: mixedStack,
        anchorOverride: sharedAnchor,
        worktreeRootOverride: wtRoot,
        registryRef,
        track,
      }),
      sharedSocketTimeoutMs: 50,
    };
    await expect(runUp(deps)).rejects.toThrow(/shared/i);
    expect(readSharedState(sharedAnchor)).toBeUndefined();
  });
});

/**
 * The worktree instance's post-spawn socket wait (#91) shares its shape with
 * the shared instance's (#92) but not its identity. It used to throw
 * `SharedStartFailedError` verbatim, so a worktree instance that died before
 * binding was reported as a *shared* start failure — even for a stack with no
 * shared tier at all, which sent issue #154's reporter looking for an
 * instance that was never started. These tests pin the attribution in both
 * directions: worktree failure → `WORKTREE_START_FAILED`, shared failure →
 * `SHARED_START_FAILED` (issue #157).
 */
describe("runUp — worktree instance dies before binding its socket (#157)", () => {
  const allIsolated: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      isolated("api", "node api.js", ["API_PORT"]),
    ],
  };

  /**
   * `stubDeps` no-ops the socket wait so ordinary tests don't pay its
   * timeout; these tests want the real one, so drop the override and shorten
   * the deadline instead.
   */
  function withRealSocketWait(base: CommandDeps): CommandDeps {
    const { waitForSocketFile: _stubbed, ...rest } = base;
    return { ...rest, worktreeSocketTimeoutMs: 50 };
  }

  it("attributes the failure to the worktree instance on a stack with no shared tier", async () => {
    // Exactly the reproduction from #157: two isolated services, no shared
    // service anywhere, stub spawner that never binds. Before the fix this
    // failed with SHARED_START_FAILED and a details.socket_path pointing at
    // the worktree's own socket.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const base = stubDeps({ stack: allIsolated, track });
    const err = await runUp(withRealSocketWait(base)).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject");

    expect(err.code).toBe("WORKTREE_START_FAILED");
    // The message must not send the reader after a shared instance that this
    // stack never declares.
    expect(err.message).not.toMatch(/shared/i);
    expect(err.message).toContain(base.expectedWorktreeId);

    // Details point at THIS instance: its own socket, its own derived config.
    const details = err.details ?? {};
    expect(details["worktree_id"]).toBe(base.expectedWorktreeId);
    expect(String(details["socket_path"])).toContain(`${base.expectedWorktreeId}.sock`);
    expect(String(details["socket_path"])).not.toContain("shared.sock");
    // The remediation names the worktree's config, not the shared one — the
    // file an agent (or human) actually runs `process-compose -f` against.
    const configPath = String(details["config_path"]);
    expect(configPath).toContain(base.expectedWorktreeId);
    expect(err.message).toContain(configPath);
    expect(details["timeout_ms"]).toBe(50);
  });

  it("still attributes a shared-instance socket failure to the shared instance", async () => {
    // The other half of the contract: nothing about #157 may change the #92
    // envelope, which something already branches on. Same stub, mixed stack,
    // shared spawn is the one that never binds.
    const mixedStack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...withRealSocketWait(stubDeps({ stack: mixedStack, track })),
      sharedSocketTimeoutMs: 50,
    };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject");

    expect(err.code).toBe("SHARED_START_FAILED");
    expect(err.message).toMatch(/shared instance/i);
    expect(String((err.details ?? {})["socket_path"])).toContain("shared.sock");
    // Both envelopes now carry a real `config_path`; the discriminator is
    // which instance's config it is, so pin that rather than its presence.
    expect(String((err.details ?? {})["config_path"])).toContain("shared");
  });

  it("blames the worktree when the shared instance came up fine and only the worktree died", async () => {
    // The discriminating case: both instances are spawned, the shared one
    // binds, the worktree one doesn't. One code covering both would report
    // this as a shared failure against a demonstrably healthy shared
    // instance — the exact misdirection #154 chased.
    const mixedStack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const base = stubDeps({ stack: mixedStack, track });
    const inner = base.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    const deps: CommandDeps = {
      ...withRealSocketWait(base),
      sharedSocketTimeoutMs: 50,
      driver: {
        ...base.driver,
        spawner: (binary, args, options) => {
          // Bind only the shared socket, so the shared lazy-start succeeds
          // and the worktree wait is the one that lapses.
          const socketPath = args[args.indexOf("-u") + 1] ?? "";
          if (args[0] === "up" && socketPath.endsWith("shared.sock")) {
            writeFileSync(socketPath, "");
          }
          return inner(binary, args, options);
        },
      },
    };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject");

    expect(err.code).toBe("WORKTREE_START_FAILED");
    expect(String((err.details ?? {})["socket_path"])).not.toContain("shared.sock");
    // Both spawns happened — the shared one is not the failure.
    expect(track.invocations.some((i) => i.socketPath.endsWith("shared.sock"))).toBe(true);
    expect(track.invocations.some((i) => !i.socketPath.endsWith("shared.sock"))).toBe(true);
  });
});

describe("runUp — cross-tier wiring (ADR-0003)", () => {
  /** isolated `web` depends on shared `postgres` — the canonical cross-tier edge. */
  const crossTierStack: ResolvedStack = {
    services: [
      {
        name: "web",
        tier: "isolated",
        command: "node server.js",
        ports: ["WEB_PORT"],
        dependsOn: [{ name: "postgres" }],
        environment: [],
      },
      {
        name: "postgres",
        tier: "shared",
        command: "postgres -D ./pgdata",
        ports: ["DB_PORT"],
        dependsOn: [],
        environment: [],
      },
    ],
  };

  it("warns once for each dropped cross-tier depends_on edge", async () => {
    // The dropped edges must be visible in output (ADR-0003 "Consequences") —
    // otherwise the behavior is invisible from the source devtrees.yaml.
    const warnings: string[] = [];
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps: CommandDeps = {
      ...stubDeps({ stack: crossTierStack, track, warn: (m) => warnings.push(m) }),
      waitForSharedHealth: () => Promise.resolve(),
    };
    await runUp(deps);

    const droppedWarning = warnings.find(
      (w) => /web/.test(w) && /postgres/.test(w) && /depends_on/i.test(w),
    );
    expect(droppedWarning).toBeDefined();
  });

  it("waits for shared services to be healthy before starting the worktree instance", async () => {
    // The shared-health wait happens between the shared up-spawn and the worktree
    // up-spawn — that's the orchestration layer's stand-in for the dropped
    // cross-tier depends_on edge (ADR-0003).
    const order: string[] = [];
    let waitResolved = false;
    const track: StubSpawn = { invocations: [], touchSocket: true };

    const waitForSharedHealth = (): Promise<void> =>
      new Promise<void>((resolve) => {
        order.push("wait:start");
        setTimeout(() => {
          waitResolved = true;
          order.push("wait:resolve");
          resolve();
        }, 5);
      });

    const baseDeps = stubDeps({ stack: crossTierStack, track });
    // Wrap the stub spawner so we can record the order of up-spawns relative
    // to the wait.
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");
    const deps: CommandDeps = {
      ...baseDeps,
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "up") {
            const si = args.indexOf("-u");
            const sock = args[si + 1] ?? "";
            order.push(sock.endsWith("/shared.sock") ? "up:shared" : "up:worktree");
          }
          return inner(binary, args, options);
        },
      },
      waitForSharedHealth,
    };

    await runUp(deps);
    // The wait must have run, and the worktree up must not have spawned before it resolved.
    expect(waitResolved).toBe(true);
    expect(order).toEqual(["up:shared", "wait:start", "wait:resolve", "up:worktree"]);
  });

  it("skips the shared-health wait when no isolated service depends on a shared one", async () => {
    // Shared services exist but no cross-tier edge: no dropped edges, no need to gate.
    const independent: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    let called = false;
    const waitForSharedHealth = (): Promise<void> => {
      called = true;
      return Promise.resolve();
    };
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps: CommandDeps = {
      ...stubDeps({ stack: independent, track }),
      waitForSharedHealth,
    };
    await runUp(deps);
    expect(called).toBe(false);
  });

  it("logs a 'waiting for shared' message when the wait runs", async () => {
    const warnings: string[] = [];
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps: CommandDeps = {
      ...stubDeps({ stack: crossTierStack, track, warn: (m) => warnings.push(m) }),
      waitForSharedHealth: () => Promise.resolve(),
    };
    await runUp(deps);
    expect(warnings.some((w) => /waiting.*shared/i.test(w))).toBe(true);
  });

  it("emits same-tier depends_on into the derived worktree config (process-compose still gates it)", async () => {
    // isolated → isolated edges must reach process-compose — they're within
    // the worktree instance, so process-compose can enforce them as usual.
    const sameTier: ResolvedStack = {
      services: [
        {
          name: "api",
          tier: "isolated",
          command: "node api.js",
          ports: ["API_PORT"],
          dependsOn: [],
          environment: [],
        },
        {
          name: "web",
          tier: "isolated",
          command: "node web.js",
          ports: ["WEB_PORT"],
          dependsOn: [{ name: "api" }],
          environment: [],
        },
      ],
    };
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack: sameTier, track });
    await runUp(deps);
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    if (worktreeSpawn === undefined) throw new Error("expected a worktree spawn");
    const config = parseYaml(readFileSync(worktreeSpawn.configPath, "utf8")) as {
      processes: Record<string, { depends_on?: Record<string, { condition: string }> }>;
    };
    expect(config.processes.web?.depends_on).toEqual({ api: { condition: "process_started" } });
  });

  it("does not emit cross-tier depends_on edges in the derived worktree config", async () => {
    // The whole point of the deriver's edge-dropping: process-compose would
    // raise an "unknown process 'postgres'" error otherwise.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps: CommandDeps = {
      ...stubDeps({ stack: crossTierStack, track }),
      waitForSharedHealth: () => Promise.resolve(),
    };
    await runUp(deps);
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    if (worktreeSpawn === undefined) throw new Error("expected a worktree spawn");
    const config = parseYaml(readFileSync(worktreeSpawn.configPath, "utf8")) as {
      processes: Record<string, { depends_on?: Record<string, { condition: string }> }>;
    };
    // No depends_on at all on `web` — `postgres` is the only declared dep and
    // it's cross-tier (dropped); the field is omitted entirely.
    expect("depends_on" in (config.processes.web ?? {})).toBe(false);
  });
});

describe("runUp — wait-for-healthy (worktree instance, #28)", () => {
  /** Two isolated services so the wait must reason about more than one process. */
  const twoIsolated: ResolvedStack = {
    services: [
      isolated("web", "node web.js", ["WEB_PORT"]),
      isolated("worker", "node worker.js", ["WORKER_PORT"]),
    ],
  };

  it("waits for the worktree instance's services to be healthy after starting it", async () => {
    // The wait must happen between `driver.up` of the worktree and any subsequent
    // attach — that is the gate that turns "up returned" into "the stack is
    // serving traffic" (PRD #26, ADR-0005).
    const order: string[] = [];
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    const deps: CommandDeps = {
      ...baseDeps,
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "up") order.push("up:worktree");
          if (args[0] === "attach") order.push("attach");
          return inner(binary, args, options);
        },
      },
      waitForHealth: async ({ serviceNames }) => {
        order.push(`wait:${[...serviceNames].sort().join(",")}`);
      },
    };

    await runUp(deps);
    expect(order).toContain("wait:web,worker");
    // The wait must run after the worktree up-spawn (otherwise it polls a
    // socket that doesn't exist yet).
    expect(order.indexOf("up:worktree")).toBeLessThan(order.indexOf("wait:web,worker"));
  });

  it("passes the worktree's own socket path to the wait — not the shared one", async () => {
    const seen: string[] = [];
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const base = stubDeps({ stack: twoIsolated, track });
    const deps: CommandDeps = {
      ...base,
      waitForHealth: async ({ socketPath }) => {
        seen.push(socketPath);
      },
    };
    await runUp(deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endsWith(`/${base.expectedWorktreeId}.sock`)).toBe(true);
  });

  it("threads the probed-service subset from the resolved stack to the wait (#108)", async () => {
    // The orchestration layer knows which services declare a readiness probe;
    // the wait needs that set to gate them on health:ready instead of Running.
    const probedStack: ResolvedStack = {
      services: [
        { ...isolated("web", "node server.js", ["WEB_PORT"]), readinessProbe: { exec: {} } },
        isolated("worker", "node worker.js"),
      ],
    };
    let observed: { serviceNames: string[]; probedServiceNames: string[] } | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: probedStack, track }),
      waitForHealth: async ({ serviceNames, probedServiceNames }) => {
        observed = {
          serviceNames: [...serviceNames].sort(),
          probedServiceNames: [...probedServiceNames],
        };
      },
    };
    await runUp(deps);
    expect(observed).toEqual({ serviceNames: ["web", "worker"], probedServiceNames: ["web"] });
  });

  it("threads the probed shared subset to the shared-health wait (#108)", async () => {
    const probedCrossTier: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: ["WEB_PORT"],
          dependsOn: [{ name: "postgres" }],
          environment: [],
        },
        {
          ...shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
          readinessProbe: { exec: {} },
        },
        shared("cache", "redis-server"),
      ],
    };
    let observed: { sharedServiceNames: string[]; probedServiceNames: string[] } | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps: CommandDeps = {
      ...stubDeps({ stack: probedCrossTier, track }),
      waitForSharedHealth: async ({ sharedServiceNames, probedServiceNames }) => {
        observed = {
          sharedServiceNames: [...sharedServiceNames].sort(),
          probedServiceNames: [...probedServiceNames],
        };
      },
    };
    await runUp(deps);
    expect(observed).toEqual({
      sharedServiceNames: ["cache", "postgres"],
      probedServiceNames: ["postgres"],
    });
  });

  it("threads the timeout from deps to the wait", async () => {
    let observed: number | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: twoIsolated, track }),
      waitTimeoutMs: 7777,
      waitForHealth: async ({ timeoutMs }) => {
        observed = timeoutMs;
      },
    };
    await runUp(deps);
    expect(observed).toBe(7777);
  });

  it("defaults the wait timeout to 120s when deps don't override it", async () => {
    let observed: number | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: twoIsolated, track }),
      waitForHealth: async ({ timeoutMs }) => {
        observed = timeoutMs;
      },
    };
    await runUp(deps);
    expect(observed).toBe(120_000);
  });

  it("on health timeout (headless): throws HEALTH_TIMEOUT and does NOT attach the TUI", async () => {
    // The silent health-wait — and so HEALTH_TIMEOUT — only runs on the headless
    // (`--no-attach` / `--json`) path; the attach path lets the human watch the
    // TUI instead of waiting (#132). ADR-0005: timeout exits non-zero, leaves the
    // stack running, agent can then call `devtrees logs <service>` to inspect, so
    // the worktree's `process-compose down` must NOT be invoked from this path.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    const sawAttach = { called: false };
    const sawDown = { called: false };
    const deps: CommandDeps = {
      ...baseDeps,
      attach: false, // headless: the path the silent health-wait gates
      waitForHealth: async () => {
        const err = new Error(
          "timed out waiting for services to be healthy [web, worker] after 120000ms",
        ) as Error & { code: string };
        err.code = "HEALTH_TIMEOUT";
        throw err;
      },
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") sawAttach.called = true;
          if (args[0] === "down") sawDown.called = true;
          return inner(binary, args, options);
        },
      },
    };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("HEALTH_TIMEOUT");
    expect(sawAttach.called).toBe(false);
    expect(sawDown.called).toBe(false);
  });

  it("does not attach when deps.attach is false even if the wait succeeds", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    let attachCalled = false;
    const deps: CommandDeps = {
      ...baseDeps,
      attach: false,
      waitForHealth: async () => {},
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") attachCalled = true;
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    expect(attachCalled).toBe(false);
  });

  it("auto-detect: attaches when isTTY()===true and deps.attach is unset", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    let attached = false;
    const deps: CommandDeps = {
      ...baseDeps,
      attach: undefined,
      isTTY: () => true,
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") attached = true;
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    expect(attached).toBe(true);
  });

  it("auto-detect: skips attach when isTTY()===false (non-interactive caller)", async () => {
    // The whole point of #28: an agent / CI step calling `devtrees up` must
    // not be hijacked into a TUI. With no explicit override and a non-TTY
    // environment, the TUI stays off and `up` returns after the health-wait.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    let attached = false;
    const deps: CommandDeps = {
      ...baseDeps,
      attach: undefined,
      isTTY: () => false,
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") attached = true;
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    expect(attached).toBe(false);
  });

  it("explicit deps.attach=true overrides isTTY()===false", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    let attached = false;
    const deps: CommandDeps = {
      ...baseDeps,
      attach: true,
      isTTY: () => false,
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") attached = true;
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    expect(attached).toBe(true);
  });

  it("explicit deps.attach=false overrides isTTY()===true", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    let attached = false;
    const deps: CommandDeps = {
      ...baseDeps,
      attach: false,
      isTTY: () => true,
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") attached = true;
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    expect(attached).toBe(false);
  });

  it("attach mode (#132): attaches the live TUI and skips the silent health-wait", async () => {
    // Option 1: the server is already started detached and `process-compose
    // attach` renders services going starting -> ready, so in attach mode we
    // attach the TUI immediately — the human watching it is the progress AND the
    // health signal. The silent `waitForHealth` gate (and HEALTH_TIMEOUT) is for
    // the headless paths only, so it must NOT run here.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    let waited = false;
    let attached = false;
    const deps: CommandDeps = {
      ...baseDeps,
      attach: true,
      waitForHealth: async () => {
        waited = true;
      },
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") attached = true;
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    expect(attached).toBe(true);
    expect(waited).toBe(false);
  });
});

/**
 * `runUp` — issue #128: namespace selection. `-n/--namespace` narrows what
 * process-compose starts AND what the #108 health-wait expects, so `up -n
 * default` neither spawns nor waits on a probed service in an excluded
 * namespace.
 */
describe("runUp — namespace selection (#128)", () => {
  /**
   * A `default`-namespace web (no `namespace:` key → implicit default) plus a
   * `local-backend` api whose readiness probe would HEALTH_TIMEOUT if it were
   * left in the expected set after `-n default` excludes it.
   */
  const mixedNamespaces: ResolvedStack = {
    services: [
      isolated("web", "node web.js", ["WEB_PORT"]),
      {
        ...isolated("api", "node api.js", ["API_PORT"]),
        namespace: "local-backend",
        readinessProbe: { exec: {} },
      },
    ],
  };

  /** #179: list-valued `db`; `api` (two) needs `db`, `web` (one) needs `api`. */
  const listNamespaces: ResolvedStack = {
    services: [
      { ...isolated("db", "postgres"), namespace: ["one", "two"] },
      { ...isolated("api", "node api.js"), namespace: "two", dependsOn: [{ name: "db" }] },
      { ...isolated("web", "node web.js"), namespace: "one", dependsOn: [{ name: "api" }] },
    ],
  };

  it("#200: up warns once per braced injected variable and returns it for the envelope", async () => {
    const warnings: string[] = [];
    const stack: ResolvedStack = {
      services: [isolated("web", "serve ${WEB_PORT} $WEB_PORT", ["WEB_PORT"])],
    };
    const deps: CommandDeps = {
      ...stubDeps({ stack, track: { invocations: [], touchSocket: false } }),
      warn: (m) => warnings.push(m),
      waitForHealth: async () => {},
    };
    const result = await runUp(deps);
    expect(result.bracedEnvVars).toEqual([{ service: "web", variable: "WEB_PORT" }]);
    expect(warnings.filter((w) => w.includes("'${WEB_PORT}'"))).toHaveLength(1);
  });

  it("#179: -n two selects the list-valued db and api, and health-waits on exactly them", async () => {
    let waited: string[] | undefined;
    const warnings: string[] = [];
    const deps: CommandDeps = {
      ...stubDeps({ stack: listNamespaces, track: { invocations: [], touchSocket: false } }),
      namespaces: ["two"],
      warn: (m) => warnings.push(m),
      waitForHealth: async ({ serviceNames }) => {
        waited = [...serviceNames];
      },
    };
    const result = await runUp(deps);
    expect(waited).toEqual(["db", "api"]);
    expect(result.droppedNamespaceEdges).toEqual([]);
    expect(warnings.filter((w) => /cross-namespace/.test(w))).toEqual([]);
  });

  it("#179: warns once per depends_on edge whose target no selected namespace covers", async () => {
    const warnings: string[] = [];
    const deps: CommandDeps = {
      ...stubDeps({ stack: listNamespaces, track: { invocations: [], touchSocket: false } }),
      namespaces: ["one"],
      warn: (m) => warnings.push(m),
      waitForHealth: async () => {},
    };
    const result = await runUp(deps);
    expect(result.droppedNamespaceEdges).toEqual([
      { from: "web", to: "api", toNamespaces: ["two"] },
    ]);
    const lines = warnings.filter((w) => /cross-namespace/.test(w));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("'web' -> 'api'");
    expect(lines[0]).toContain("[two]");
  });

  it("forwards each requested namespace verbatim to the worktree up-spawn", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: mixedNamespaces, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");
    let upArgs: ReadonlyArray<string> | undefined;
    const deps: CommandDeps = {
      ...baseDeps,
      namespaces: ["default"],
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "up") upArgs = args;
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    if (upArgs === undefined) throw new Error("expected an up-spawn");
    expect(upArgs.join(" ")).toContain("-n default");
    expect(upArgs.filter((a) => a === "-n")).toHaveLength(1);
  });

  it("narrows the health-wait's expected set to the selected namespaces", async () => {
    // The crux of #128: `up -n default` must NOT wait on the excluded
    // local-backend api (a probed service) — otherwise it HEALTH_TIMEOUTs on a
    // service it never asked process-compose to start.
    let observed: { serviceNames: string[]; probedServiceNames: string[] } | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: mixedNamespaces, track }),
      namespaces: ["default"],
      waitForHealth: async ({ serviceNames, probedServiceNames }) => {
        observed = {
          serviceNames: [...serviceNames].sort(),
          probedServiceNames: [...probedServiceNames].sort(),
        };
      },
    };
    await runUp(deps);
    expect(observed).toEqual({ serviceNames: ["web"], probedServiceNames: [] });
  });

  it("still waits on probed services WITHIN the selected namespace (no #108 regression)", async () => {
    // Selecting local-backend keeps the probed api in the expected set.
    let observed: { serviceNames: string[]; probedServiceNames: string[] } | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: mixedNamespaces, track }),
      namespaces: ["local-backend"],
      waitForHealth: async ({ serviceNames, probedServiceNames }) => {
        observed = {
          serviceNames: [...serviceNames].sort(),
          probedServiceNames: [...probedServiceNames].sort(),
        };
      },
    };
    await runUp(deps);
    expect(observed).toEqual({ serviceNames: ["api"], probedServiceNames: ["api"] });
  });

  /** Capture the worktree up-spawn's argv alongside the stub spawner. */
  function capturingUpArgs(base: ReturnType<typeof stubDeps>) {
    const inner = base.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");
    const captured: { args?: ReadonlyArray<string> } = {};
    const driver = {
      ...base.driver,
      spawner: ((binary, args, options) => {
        if (args[0] === "up") captured.args = args;
        return inner(binary, args, options);
      }) as typeof inner,
    };
    return { captured, driver };
  }

  it("a bare fresh up selects only `default`: spawns with `-n default` and waits only on default services (#176)", async () => {
    let observed: string[] | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: mixedNamespaces, track });
    const { captured, driver } = capturingUpArgs(baseDeps);
    const deps: CommandDeps = {
      ...baseDeps,
      driver,
      waitForHealth: async ({ serviceNames }) => {
        observed = [...serviceNames].sort();
      },
    };
    await runUp(deps);
    // Namespaces are opt-in (ADR-0008): the excluded local-backend api is
    // neither started nor waited on.
    expect(observed).toEqual(["web"]);
    const args = captured.args ?? [];
    expect(args.filter((a) => a === "-n")).toHaveLength(1);
    expect(args.join(" ")).toContain("-n default");
  });

  it("`-n <ns>` stays exact: it never adds `default` on top (#176)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: mixedNamespaces, track });
    const { captured, driver } = capturingUpArgs(baseDeps);
    await runUp({
      ...baseDeps,
      driver,
      namespaces: ["local-backend"],
      waitForHealth: async () => {},
    });
    const args = captured.args ?? [];
    expect(args.filter((a) => a === "-n")).toHaveLength(1);
    expect(args.join(" ")).toContain("-n local-backend");
    expect(args).not.toContain("default");
  });

  /** Every isolated service in a named namespace — nothing in `default`. */
  const allNamespaced: ResolvedStack = {
    services: [
      { ...isolated("web", "node web.js", ["WEB_PORT"]), namespace: "app" },
      { ...isolated("api", "node api.js", ["API_PORT"]), namespace: "local-backend" },
      { ...isolated("worker", "node worker.js", []), namespace: "app" },
    ],
  };

  it("a bare fresh up with no `default` services fails NO_SERVICES_SELECTED before any spawn (#176)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps = stubDeps({ stack: allNamespaced, track });
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
    expect(err?.details).toEqual({
      worktree_id: deps.expectedWorktreeId,
      selected_namespaces: ["default"],
      namespaces: ["app", "local-backend"],
    });
    expect(err?.message).toContain("Available namespaces: app, local-backend");
    expect(err?.message).toContain("devtrees up -n app");
    expect(track.invocations).toEqual([]);
  });

  it("`-n` naming a namespace with services still starts on the all-namespaced stack (#176)", async () => {
    let observed: string[] | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    await runUp({
      ...stubDeps({ stack: allNamespaced, track }),
      namespaces: ["app"],
      waitForHealth: async ({ serviceNames }) => {
        observed = [...serviceNames].sort();
      },
    });
    expect(observed).toEqual(["web", "worker"]);
  });

  it("`-n` naming only a namespace with NO services fails NO_SERVICES_SELECTED before any state is written (#203)", async () => {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps = stubDeps({ stack: allNamespaced, track, registryRef });
    const err = await runUp({ ...deps, namespaces: ["nope"] }).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
    expect(err?.details).toEqual({
      worktree_id: deps.expectedWorktreeId,
      selected_namespaces: ["nope"],
      namespaces: ["app", "local-backend"],
    });
    expect(err?.message).toContain("-n nope");
    expect(err?.message).toContain("Available namespaces: app, local-backend");
    expect(err?.message).toContain("devtrees up -n app");
    expect(track.invocations).toEqual([]);
    expect(registryRef.snapshot).toEqual({});
  });

  it("`-n app -n nope` still starts: only an overall empty selection is an error (#203)", async () => {
    let observed: string[] | undefined;
    const track: StubSpawn = { invocations: [], touchSocket: false };
    await runUp({
      ...stubDeps({ stack: allNamespaced, track }),
      namespaces: ["app", "nope"],
      waitForHealth: async ({ serviceNames }) => {
        observed = [...serviceNames].sort();
      },
    });
    expect(observed).toEqual(["web", "worker"]);
  });

  it("a bare up on a RUNNING instance is not a fresh start: no NO_SERVICES_SELECTED, no spawn (#177's scope)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const baseDeps = stubDeps({ stack: allNamespaced, track });
    await runUp({ ...baseDeps, namespaces: ["app"], waitForHealth: async () => {} });
    const spawnsAfterBoot = track.invocations.length;
    // Bare re-up against the live instance takes the reconcile path unchanged.
    const result = await runUp({ ...baseDeps, probeSocket: async () => "running" as const });
    expect(result.worktreeId).toBe(baseDeps.expectedWorktreeId);
    expect(track.invocations).toHaveLength(spawnsAfterBoot);
  });
});

/**
 * `runUp` — issue #30 state envelope: on success, the result must carry the
 * allocated port block plus the per-service runtime rows so the CLI can
 * publish `up --json` in one document without a follow-up `ls --json` /
 * `env --json` round-trip. Composition seam: services come from the driver
 * (issue #29 `getServiceStatuses`), zipped with the named-port allocations
 * already in hand from the deriver.
 */
describe("runUp — state envelope on success (#30)", () => {
  const twoIsolated: ResolvedStack = {
    services: [
      isolated("web", "node web.js", ["WEB_PORT"]),
      isolated("worker", "node worker.js", ["WORKER_PORT"]),
    ],
  };

  it("returns the allocated block_base on the up result", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const result = await runUp(stubDeps({ stack: twoIsolated, track }));
    // block_base is the bottom of this worktree's allocated block: the
    // first named port (offset 0 within the block) lines up with it, and
    // every other port falls inside [blockBase, blockBase + blockSize).
    // The exact number depends on the allocator's hash of the worktree id;
    // assert the contract, not the hash.
    expect(result.blockBase).toBe(Number(result.env.WEB_PORT));
    expect(Number(result.env.WORKER_PORT)).toBeGreaterThanOrEqual(result.blockBase);
    expect(Number(result.env.WORKER_PORT)).toBeLessThan(result.blockBase + 32);
  });

  it("populates services[] from the injected getServiceStatuses, zipped with named-port allocations", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const seen: string[] = [];
    const deps: CommandDeps = {
      ...baseDeps,
      getServiceStatuses: async (socketPath) => {
        seen.push(socketPath);
        return [
          { name: "web", status: "Running", health: "ready" },
          { name: "worker", status: "Running", health: "not_ready" },
        ];
      },
    };
    const result = await runUp(deps);
    // Called once, against the worktree's own socket.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endsWith(`/${baseDeps.expectedWorktreeId}.sock`)).toBe(true);
    expect(result.services).toEqual([
      {
        name: "web",
        status: "Running",
        health: "ready",
        ports: { WEB_PORT: Number(result.env.WEB_PORT) },
      },
      {
        name: "worker",
        status: "Running",
        health: "not_ready",
        ports: { WORKER_PORT: Number(result.env.WORKER_PORT) },
      },
    ]);
  });

  it("services[] is the empty array (not undefined) when getServiceStatuses returns nothing", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: twoIsolated, track }),
      getServiceStatuses: async () => [],
    };
    const result = await runUp(deps);
    expect(result.services).toEqual([]);
  });

  it("a getServiceStatuses failure does not abort `up` — services[] degrades to []", async () => {
    // Same containment rule `ls --json` uses (issue #29): a flaky driver call
    // must not turn an otherwise-healthy worktree into a failed `up`. The
    // stack is running; the envelope just gets the partial answer.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: twoIsolated, track }),
      getServiceStatuses: async () => {
        throw new Error("simulated process-compose hiccup");
      },
    };
    const result = await runUp(deps);
    expect(result.services).toEqual([]);
    // The rest of the envelope is still well-formed.
    expect(result.blockBase).toBe(Number(result.env.WEB_PORT));
    expect(result.env.WEB_PORT).toBeDefined();
  });

  it("calls getServiceStatuses after the health-wait, never before", async () => {
    // Order matters: `getServiceStatuses` polls the running stack — calling
    // it before the wait would return process-compose's transient "starting"
    // state instead of the healthy snapshot the agent is contracting for.
    const order: string[] = [];
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps: CommandDeps = {
      ...stubDeps({ stack: twoIsolated, track }),
      waitForHealth: async () => {
        order.push("wait");
      },
      getServiceStatuses: async () => {
        order.push("statuses");
        return [];
      },
    };
    await runUp(deps);
    expect(order).toEqual(["wait", "statuses"]);
  });

  it("does not call getServiceStatuses when the health-wait threw HEALTH_TIMEOUT", async () => {
    // The stack is left running (ADR-0005), but the agent reads the
    // `HEALTH_TIMEOUT` error envelope, not the success envelope — so the
    // success-only `services[]` fetch must be skipped.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    let called = false;
    const deps: CommandDeps = {
      ...stubDeps({ stack: twoIsolated, track }),
      waitForHealth: async () => {
        const err = new Error("timed out") as Error & { code: string };
        err.code = "HEALTH_TIMEOUT";
        throw err;
      },
      getServiceStatuses: async () => {
        called = true;
        return [];
      },
    };
    await expect(runUp(deps)).rejects.toThrow(/timed out/);
    expect(called).toBe(false);
  });
});

describe("runDown — shared lifecycle is decoupled from worktree lifecycle", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres", ["DB_PORT"]),
    ],
  };

  it("plain runDown stops the worktree instance only — shared socket survives", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack: mixedStack, track });
    await runUp(deps);
    const sharedSpawn = findSharedSpawn(track);

    // shared.sock was created by the stub spawner; runDown without --shared must leave it.
    expect(existsSync(sharedSpawn.socketPath)).toBe(true);
    await runDown(deps);
    expect(existsSync(sharedSpawn.socketPath)).toBe(true);
  });

  it("runDown(--shared) tears down the shared instance but preserves its registry entry (#51)", async () => {
    // The shared block must stay pinned across a `down --shared` + `up` cycle
    // so agents that record `DB_PORT` once can reuse it. Liveness in `ls --json`
    // is driven by socket presence, not registry presence (instances.ts), so
    // dropping the entry was tidy theatre at the cost of port stability.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = stubDeps({ stack: mixedStack, track, registryRef });
    await runUp(deps);

    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBeDefined();
    const priorSharedBase = registryRef.snapshot[SHARED_REGISTRY_KEY];
    const sharedSpawn = findSharedSpawn(track);
    expect(existsSync(sharedSpawn.socketPath)).toBe(true);

    // Simulate the real driver: down() removes the socket. The stub driver in
    // commands' spawner just records — we drop the socket here to mimic it.
    const downDeps: CommandDeps = {
      ...deps,
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_b, args, _o): SpawnedProcess => {
          const si = args.indexOf("-u");
          if (args[0] === "down" && si >= 0) {
            const socketPath = args[si + 1];
            if (socketPath) rmSync(socketPath, { force: true });
          }
          return spawnedOk();
        },
      },
    };

    await runDown(downDeps, { shared: true });
    expect(existsSync(sharedSpawn.socketPath)).toBe(false);
    // The shared registry entry survives — liveness flows from the socket
    // (which *is* gone), and the next `up` reuses the same block.
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBe(priorSharedBase);
  });

  it("runDown(--shared) + runUp reuses the same shared block and lazy-starts it again (#51)", async () => {
    // Stable allocator probe: `() => true` (the default in stubDeps) makes the
    // FNV-1a slot deterministic, so the post-`down` `up` must land on the same
    // block as the pre-`down` `up` *because the registry entry survived* —
    // without the registry entry, even a probe that always passes still hashes
    // from `__shared__` fresh, but the assertion that matters is the *whole
    // workflow* round-trips identically.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = stubDeps({ stack: mixedStack, track, registryRef });
    const firstUp = await runUp(deps);
    const firstSharedBase = registryRef.snapshot[SHARED_REGISTRY_KEY];
    expect(firstSharedBase).toBeDefined();

    // Mimic the real driver: down() removes the socket so the next `up` will
    // observe socket absence and lazy-start.
    const downDeps: CommandDeps = {
      ...deps,
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_b, args, _o): SpawnedProcess => {
          const si = args.indexOf("-u");
          if (args[0] === "down" && si >= 0) {
            const socketPath = args[si + 1];
            if (socketPath) rmSync(socketPath, { force: true });
          }
          return spawnedOk();
        },
      },
    };
    // Tear the worktree down too so the second `up` takes the full lazy-start
    // path (the idempotency branch in `runUp` short-circuits before it would
    // re-check the shared socket).
    await runDown(downDeps);
    await runDown(downDeps, { shared: true });

    // The shared registry entry survived the teardown.
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBe(firstSharedBase);

    // Re-`up`: shared lazy-starts again (socket was removed) on the same block.
    expect(existsSync(findSharedSpawn(track).socketPath)).toBe(false);
    const secondUp = await runUp(deps);
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBe(firstSharedBase);
    expect(secondUp.env.DB_PORT).toBe(firstUp.env.DB_PORT);
    expect(secondUp.sharedStarted).toBe(true);
    // Socket re-appeared: lazy-start ran.
    expect(existsSync(findSharedSpawn(track).socketPath)).toBe(true);
  });

  it("runDown(--shared) is a tidy no-op when the shared instance is not running", async () => {
    const deps = stubDeps({ stack: mixedStack });
    // No prior `up` — the socket doesn't exist.
    await runDown(deps, { shared: true });
    // Nothing thrown; registry still has no shared entry.
  });

  it("up → down --shared → up lazy-restarts shared even though the worktree socket is still present (#56)", async () => {
    // Issue #56: the idempotency branch in `runUp` short-circuits before ever
    // checking the shared socket. If a prior `down --shared` killed the shared
    // tier but the worktree's own instance is still up, the next `up` must
    // still recover shared (and the envelope must report `shared_started:
    // true` so an agent can tell shared was just brought back).
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = stubDeps({ stack: mixedStack, track, registryRef });
    const first = await runUp(deps);
    expect(first.sharedStarted).toBe(true);
    const sharedSpawn = findSharedSpawn(track);
    expect(existsSync(sharedSpawn.socketPath)).toBe(true);

    // Mimic the real driver: down() removes the socket so the next `up`
    // observes shared as gone. Note we DO NOT call `runDown` for the worktree
    // — its socket stays present so the second `up` hits the idempotency
    // branch.
    const downDeps: CommandDeps = {
      ...deps,
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_b, args, _o): SpawnedProcess => {
          const si = args.indexOf("-u");
          if (args[0] === "down" && si >= 0) {
            const socketPath = args[si + 1];
            if (socketPath) rmSync(socketPath, { force: true });
          }
          return spawnedOk();
        },
      },
    };
    await runDown(downDeps, { shared: true });
    expect(existsSync(sharedSpawn.socketPath)).toBe(false);

    // Second `up` from the same (still-running) worktree must lazy-restart
    // shared — the idempotency branch can no longer skip the shared check.
    const second = await runUp(deps);
    expect(second.sharedStarted).toBe(true);
    expect(existsSync(findSharedSpawn(track).socketPath)).toBe(true);
    // Shared block stayed the same (registry entry survived the down).
    expect(second.env.DB_PORT).toBe(first.env.DB_PORT);
  });
});

/**
 * Issue #48 — `devtrees down --json` is operation-output only. `runDown`
 * returns an identity-only `DownResult`: exactly one of `{shared: true}` or
 * `{shared: false, worktreeId: "<id>"}` (discriminated union). Pre- and
 * post-teardown state belongs to `ls --json`, not this envelope.
 */
/**
 * The worktree `down` runs under the per-worktree lifecycle lock (#178), so
 * an `up` restarting dead services cannot `process start` on a supervisor
 * that is shutting down.
 */
describe("runDown — worktree teardown holds the lifecycle lock (#178)", () => {
  const stack: ResolvedStack = { services: [isolated("web", "node server.js", ["WEB_PORT"])] };

  it("probes and stops the instance inside the worktree's lifecycle lock", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack, track });
    await runUp(deps);
    const events: string[] = [];
    const spawner = deps.driver?.spawner;
    if (spawner === undefined) throw new Error("expected spawner");
    const result = await runDown({
      ...deps,
      withLifecycleLock: async (_a, instanceId, fn) => {
        events.push(`lock ${instanceId}`);
        const out = await fn();
        events.push("unlock");
        return out;
      },
      driver: {
        ...deps.driver,
        spawner: (b, args, o) => {
          events.push(args[0] ?? "");
          return spawner(b, args, o);
        },
      },
    });
    expect(result.stopped).toBe(true);
    // The pre-stop snapshot (`process list`, #190) also runs under the lock.
    expect(events).toEqual([`lock ${deps.expectedWorktreeId}`, "process", "down", "unlock"]);
  });

  it("a lock held by a concurrent up fails LOCK_CONTENTION and stops nothing", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack, track });
    await runUp(deps);
    const anchor = (deps.git!(["rev-parse", "--git-common-dir"]) as string).trim();
    const downs: string[][] = [];
    const spawner = deps.driver?.spawner;
    if (spawner === undefined) throw new Error("expected spawner");
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let acquired: () => void = () => {};
    const isHeld = new Promise<void>((r) => (acquired = r));
    const holder = withLifecycleLock(anchor, deps.expectedWorktreeId, async () => {
      acquired();
      await held;
    });
    await isHeld;
    const err = await runDown({
      ...deps,
      withLifecycleLock: (a, i, fn) =>
        withLifecycleLock(a, i, fn, { retries: 3, retryDelayMs: 10 }),
      driver: {
        ...deps.driver,
        spawner: (b, args, o) => {
          if (args[0] === "down") downs.push([...args]);
          return spawner(b, args, o);
        },
      },
    }).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    release();
    await holder;
    expect(err?.code).toBe("LOCK_CONTENTION");
    expect(downs).toEqual([]);
  });
});

describe("runDown — operation-output result (#48)", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres", ["DB_PORT"]),
    ],
  };

  it("worktree teardown returns {shared: false, worktreeId}", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack: mixedStack, track });
    await runUp(deps);
    const result = await runDown(deps);
    expect(result.shared).toBe(false);
    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
  });

  it("shared teardown returns {shared: true} and no worktreeId", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const baseDeps = stubDeps({ stack: mixedStack, track, registryRef });
    await runUp(baseDeps);

    const downDeps: CommandDeps = {
      ...baseDeps,
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_b, args, _o): SpawnedProcess => {
          const si = args.indexOf("-u");
          if (args[0] === "down" && si >= 0) {
            const socketPath = args[si + 1];
            if (socketPath) rmSync(socketPath, { force: true });
          }
          return spawnedOk();
        },
      },
    };

    const result = await runDown(downDeps, { shared: true });
    expect(result.shared).toBe(true);
    expect(result.worktreeId).toBeUndefined();
  });

  it("runDown(--shared) on an already-stopped shared instance is a tidy no-op that still returns {shared: true}", async () => {
    const deps = stubDeps({ stack: mixedStack });
    const result = await runDown(deps, { shared: true });
    expect(result.shared).toBe(true);
    expect(result.worktreeId).toBeUndefined();
  });

  it("still calls driver.down so the lifecycle contract (#1 plain runDown stops the worktree instance) holds", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack: mixedStack, track });
    await runUp(deps);
    track.invocations.length = 0;

    const downCalls: ReadonlyArray<string>[] = [];
    const observed: CommandDeps = {
      ...deps,
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_b, args, _o): SpawnedProcess => {
          if (args[0] === "down") downCalls.push(args);
          return spawnedOk();
        },
      },
    };
    await runDown(observed);
    expect(downCalls).toHaveLength(1);
  });
});

/**
 * Issue #92 — worktree `down` with nothing running is an idempotent no-op,
 * matching the `--shared` branch: no unconditional driver call (which used to
 * surface "process-compose down exited with code N" as UNKNOWN), exit 0, and
 * a `stopped: false` field in the result so the CLI can render the notice.
 */
describe("runDown — idempotent no-op when nothing is running (#92)", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres", ["DB_PORT"]),
    ],
  };

  /** Wrap deps with a spawner that records `down` invocations. */
  function recordingDownDeps(deps: CommandDeps): {
    deps: CommandDeps;
    downCalls: ReadonlyArray<string>[];
  } {
    const downCalls: ReadonlyArray<string>[] = [];
    return {
      downCalls,
      deps: {
        ...deps,
        driver: {
          exists: () => Promise.resolve(true),
          spawner: (_b, args, _o): SpawnedProcess => {
            if (args[0] === "down") downCalls.push(args);
            return spawnedOk();
          },
        },
      },
    };
  }

  it("worktree down with no instance running skips the driver and returns stopped: false", async () => {
    // No prior `up` — the worktree's control socket does not exist.
    const { deps, downCalls } = recordingDownDeps(stubDeps({ stack: mixedStack }));
    const result = await runDown(deps);
    expect(downCalls).toHaveLength(0);
    expect(result.shared).toBe(false);
    expect(result.stopped).toBe(false);
  });

  it("worktree down against a live instance calls the driver and returns stopped: true", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const baseDeps = stubDeps({ stack: mixedStack, track });
    await runUp(baseDeps);
    const { deps, downCalls } = recordingDownDeps(baseDeps);
    const result = await runDown(deps);
    expect(downCalls).toHaveLength(1);
    expect(result.stopped).toBe(true);
    expect(result.worktreeId).toBe(baseDeps.expectedWorktreeId);
  });

  it("worktree down against a stale socket file (dead listener) is a no-op that unlinks the orphan", async () => {
    // Mimic a SIGKILLed instance: the socket *file* survives in anchor state
    // but no listener answers (#80). `down` must not shell out against the
    // dead UDS — that's the raw "exited with code N" UNKNOWN the issue fixes.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const baseDeps = stubDeps({
      stack: mixedStack,
      track,
      probeSocket: async () => "stale" as const,
    });
    await runUp({ ...baseDeps, probeSocket: async () => "running" as const });
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    if (worktreeSpawn === undefined) throw new Error("expected a worktree spawn");
    expect(existsSync(worktreeSpawn.socketPath)).toBe(true);

    const { deps, downCalls } = recordingDownDeps(baseDeps);
    const result = await runDown(deps);
    expect(downCalls).toHaveLength(0);
    expect(result.stopped).toBe(false);
    // The probe gate unlinked the orphaned socket file on the way through.
    expect(existsSync(worktreeSpawn.socketPath)).toBe(false);
  });

  it("shared down reports stopped: true when it actually tore the instance down", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const baseDeps = stubDeps({ stack: mixedStack, track });
    await runUp(baseDeps);
    const { deps, downCalls } = recordingDownDeps(baseDeps);
    const result = await runDown(deps, { shared: true });
    expect(downCalls).toHaveLength(1);
    expect(result.shared).toBe(true);
    expect(result.stopped).toBe(true);
  });

  it("shared down no-op reports stopped: false", async () => {
    const { deps, downCalls } = recordingDownDeps(stubDeps({ stack: mixedStack }));
    const result = await runDown(deps, { shared: true });
    expect(downCalls).toHaveLength(0);
    expect(result.shared).toBe(true);
    expect(result.stopped).toBe(false);
  });
});

describe("runDown — dead-supervisor reap of out-of-band resources (#148)", () => {
  const hookStack: ResolvedStack = {
    services: [
      {
        ...isolated("web", "node server.js", ["WEB_PORT"]),
        shutdown: { command: "reap-stack.sh", timeout_seconds: 8 },
      },
    ],
  };

  /** Pre-stage the worktree instance's derived config + socket file on disk. */
  function stageWorktreeInstance(deps: StubbedDeps): {
    anchor: string;
    socketPath: string;
    configPath: string;
    goneWorktree: string;
  } {
    const anchor = (deps.git!(["rev-parse", "--git-common-dir"]) as string).trim();
    const paths = instancePaths(anchor, deps.expectedWorktreeId);
    mkdirSync(paths.runDir, { recursive: true });
    // The run dir no longer lives inside the state dir (#156), so the anchor
    // state the derived config goes in has to be created explicitly.
    mkdirSync(paths.stateDir, { recursive: true });
    const goneWorktree = join(anchor, "..", "wt", "login");
    writeFileSync(paths.socketPath, "");
    writeFileSync(
      paths.configPath,
      stringifyYaml({
        processes: {
          web: {
            command: "node server.js",
            working_dir: goneWorktree,
            environment: ["DEVTREES_WORKTREE_ID=login", "WEB_PORT=20000"],
            shutdown: { command: "reap-stack.sh", timeout_seconds: 8 },
          },
        },
        "x-devtrees": { ports_by_service: {} },
      }),
    );
    return { anchor, socketPath: paths.socketPath, configPath: paths.configPath, goneWorktree };
  }

  it("runs the shutdown hook directly from the anchor when the supervisor socket is stale (SIGKILLed)", async () => {
    const deps = stubDeps({ stack: hookStack, probeSocket: async () => "stale" as const });
    const staged = stageWorktreeInstance(deps);
    const reapCalls: Array<{ cwd: string; config: DerivedConfig }> = [];

    const result = await runDown({
      ...deps,
      reap: async (config, rdeps) => {
        reapCalls.push({ cwd: rdeps.cwd, config });
        return { ranCount: 1, failures: [] };
      },
    });

    // The dead supervisor never fired the hook; devtrees runs it directly,
    // from the anchor — never the worktree path it pinned working_dir to.
    expect(reapCalls).toHaveLength(1);
    expect(reapCalls[0]?.cwd).toBe(staged.anchor);
    expect(reapCalls[0]?.cwd).not.toBe(staged.goneWorktree);
    expect(reapCalls[0]?.config.processes.web?.shutdown).toEqual({
      command: "reap-stack.sh",
      timeout_seconds: 8,
    });
    // The stale socket file is reclaimed; result is the worktree teardown.
    expect(result.shared).toBe(false);
    expect(result.stopped).toBe(false);
  });

  it("does NOT run the direct reap when the supervisor is live (graceful down fires the hook) — no regression on acceptance 4", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const baseDeps = stubDeps({
      stack: hookStack,
      track,
      probeSocket: async () => "running" as const,
    });
    stageWorktreeInstance(baseDeps);
    const reapCalls: unknown[] = [];

    const result = await runDown({
      ...baseDeps,
      driver: { exists: () => Promise.resolve(true), spawner: () => spawnedOk() },
      reap: async (config, rdeps) => {
        reapCalls.push({ config, cwd: rdeps.cwd });
        return { ranCount: 0, failures: [] };
      },
    });

    // Live supervisor: the graceful `process-compose down` fires the hook from
    // the (present) worktree, so devtrees must NOT also run it directly.
    expect(reapCalls).toHaveLength(0);
    expect(result.stopped).toBe(true);
  });

  it("reflects a failed dead-supervisor reap in DownResult.warning (acceptance 5)", async () => {
    const deps = stubDeps({ stack: hookStack, probeSocket: async () => "stale" as const });
    stageWorktreeInstance(deps);

    const result = await runDown({
      ...deps,
      reap: async () => ({
        ranCount: 1,
        failures: [
          { process: "web", command: "reap-stack.sh", reason: "timeout", message: "timed out" },
        ],
      }),
    });

    expect(result.shared).toBe(false);
    if (result.shared === false) {
      expect(result.warning?.orphanId).toBe(deps.expectedWorktreeId);
      expect(result.warning?.failures[0]?.reason).toBe("timeout");
    }
  });
});

describe("runUpDryRun — namespace selection preview (#176)", () => {
  const mixed: ResolvedStack = {
    services: [
      isolated("web", "node web.js", ["WEB_PORT"]),
      { ...isolated("api", "node api.js", ["API_PORT"]), namespace: "local-backend" },
    ],
  };

  it("a bare dry run previews the `default`-only selection", async () => {
    const result = await runUpDryRun(stubDeps({ stack: mixed }));
    expect(result.namespaces).toEqual(["default"]);
    expect(result.selectedServices).toEqual(["web"]);
    // The derived config still carries every service; `-n` filters at launch.
    expect(Object.keys(result.config.processes).sort()).toEqual(["api", "web"]);
  });

  it("`-n` is previewed verbatim and exactly", async () => {
    const result = await runUpDryRun({
      ...stubDeps({ stack: mixed }),
      namespaces: ["local-backend"],
    });
    expect(result.namespaces).toEqual(["local-backend"]);
    expect(result.selectedServices).toEqual(["api"]);
  });

  it("a bare dry run of an all-namespaced stack fails NO_SERVICES_SELECTED without touching the registry", async () => {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = stubDeps({
      stack: { services: [{ ...isolated("api", "node api.js", ["API_PORT"]), namespace: "app" }] },
      registryRef,
    });
    await expect(runUpDryRun(deps)).rejects.toMatchObject({
      code: "NO_SERVICES_SELECTED",
      details: { namespaces: ["app"] },
    });
    expect(registryRef.snapshot).toEqual({});
  });

  it("`-n` naming only a namespace with no services fails NO_SERVICES_SELECTED in a dry run, registry untouched (#203)", async () => {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = stubDeps({
      stack: { services: [{ ...isolated("api", "node api.js", ["API_PORT"]), namespace: "app" }] },
      registryRef,
    });
    await expect(runUpDryRun({ ...deps, namespaces: ["nope"] })).rejects.toMatchObject({
      code: "NO_SERVICES_SELECTED",
      details: { selected_namespaces: ["nope"], namespaces: ["app"] },
    });
    expect(registryRef.snapshot).toEqual({});
  });
});

/**
 * `up --dry-run` on a running instance previews the running-instance path
 * (#210): the selection read back from process-compose, the reload and the
 * restarts the real `up` would make, and the errors it would raise — with
 * read-only probes only. Before #210 it always previewed a fresh start, so a
 * bare dry run of a stack with no `default` services failed
 * NO_SERVICES_SELECTED where the real bare `up` succeeded.
 */
describe("runUpDryRun — a running instance (#210)", () => {
  const running = (name: string, pid?: number): ServiceStatus => ({
    name,
    status: "Running",
    health: "unknown",
    ...(pid !== undefined ? { pid } : {}),
  });
  const killed = (name: string): ServiceStatus => ({
    name,
    status: "Completed",
    health: "unknown",
    exitCode: -1,
  });
  const noDefault: ResolvedStack = {
    services: [
      { ...isolated("api", "sleep 300", ["API_PORT"]), namespace: "local-backend" },
      { ...isolated("worker", "sleep 300"), namespace: "jobs" },
    ],
  };

  /**
   * A live worktree instance (socket file present, probe `running`) whose
   * project is `rows`, with every side-effecting seam recording its use.
   */
  function live(stack: ResolvedStack, rows: ServiceStatus[], extra: Partial<CommandDeps> = {}) {
    const tmp = tmpAnchor();
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const base = stubDeps({
      stack,
      track,
      registryRef,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
    });
    const id = base.expectedWorktreeId;
    const paths = instancePaths(tmp.anchor, id);
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(paths.socketPath, "");
    const effects = {
      spawned: [] as string[][],
      controlRequests: 0,
      lifecycleLock: 0,
      hashWrites: 0,
      reads: 0,
    };
    const inner = base.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");
    const deps: StubbedDeps = {
      ...base,
      readStoredHash: () => stackHash(stack),
      writeStoredHash: () => {
        effects.hashWrites++;
      },
      withLifecycleLock: async (_a, _i, fn) => {
        effects.lifecycleLock++;
        return fn();
      },
      getServiceStatuses: async () => {
        effects.reads++;
        return rows;
      },
      driver: {
        ...base.driver,
        spawner: (binary, args, options) => {
          effects.spawned.push([...args]);
          return inner(binary, args, options);
        },
        controlRequest: () => {
          effects.controlRequests++;
          return Promise.resolve({ status: 200, body: "{}" });
        },
      },
      ...extra,
    };
    return { deps, effects, paths, id, anchor: tmp.anchor, registryRef };
  }

  async function dryFailure(deps: CommandDeps) {
    return runUpDryRun(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
  }

  it("a bare dry run targets the booted namespaces, as the real bare up does (no default services)", async () => {
    const { deps, effects } = live(noDefault, [running("api")]);
    const dry = await runUpDryRun(deps);
    expect(dry.instance).toBe("running");
    expect(dry.namespaces).toEqual(["local-backend"]);
    expect(dry.selectedServices).toEqual(["api"]);
    expect(dry.wouldReload).toBe(false);
    expect(dry.wouldRestart).toEqual([]);

    // The real bare `up` on the same instance checks exactly those services.
    const waited: string[][] = [];
    await runUp({
      ...deps,
      waitForHealth: async ({ serviceNames }) => {
        waited.push([...serviceNames]);
      },
    });
    expect(waited).toEqual([dry.selectedServices]);
    expect(effects.spawned.filter((a) => a[0] !== "process")).toEqual([]);
  });

  it("-n naming a namespace the instance was not booted with fails NAMESPACE_NOT_RUNNING, registry untouched", async () => {
    const { deps, id, registryRef } = live(noDefault, [running("api")]);
    const err = await dryFailure({ ...deps, namespaces: ["local-backend", "jobs"] });
    expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err?.details).toEqual({
      worktree_id: id,
      namespaces: ["jobs"],
      services: ["worker"],
      remedy: "devtrees down && devtrees up -n local-backend -n jobs",
    });
    expect(registryRef.snapshot).toEqual({});
  });

  it("-n naming only a namespace with no services still fails NO_SERVICES_SELECTED (#203)", async () => {
    const { deps } = live(noDefault, [running("api")]);
    const err = await dryFailure({ ...deps, namespaces: ["nope"] });
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
  });

  it("names the dead selected services the real up would restart, and starts none", async () => {
    const stack: ResolvedStack = {
      services: [
        { ...isolated("web", "sleep 300"), dependsOn: [{ name: "db" }] },
        isolated("db", "sleep 300"),
        isolated("ok", "sleep 300"),
      ],
    };
    const { deps, effects } = live(stack, [killed("web"), killed("db"), running("ok")]);
    const dry = await runUpDryRun(deps);
    // `depends_on` order, as the real restart uses.
    expect(dry.wouldRestart).toEqual(["db", "web"]);
    expect(effects.spawned).toEqual([]);
    expect(effects.lifecycleLock).toBe(0);
  });

  it("reports a drifted stack as a reload without reloading, writing the config or the hash", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node b.js", ["WEB_PORT"])] };
    const { deps, effects, paths } = live(stack, [running("web")], {
      readStoredHash: () => "older-hash",
    });
    writeFileSync(paths.configPath, "processes: {}\n");
    const dry = await runUpDryRun(deps);
    expect(dry.instance).toBe("running");
    expect(dry.wouldReload).toBe(true);
    expect(effects.controlRequests).toBe(0);
    expect(effects.hashWrites).toBe(0);
    expect(readFileSync(paths.configPath, "utf8")).toBe("processes: {}\n");
  });

  it("a pending reload fails CONFIG_DRIFT reload_pending like the real up; the marker is kept", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node b.js"), isolated("api", "node api.js")],
    };
    const { deps, anchor, id } = live(stack, [running("api", 200)], {
      isProcessAlive: (pid) => pid === 100,
    });
    const marker: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] };
    writePendingReload(anchor, id, marker);
    const err = await dryFailure(deps);
    expect(err?.code).toBe("CONFIG_DRIFT");
    expect(err?.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [100] });
    expect(readPendingReload(anchor, id)).toEqual(marker);
  });

  it("a converged pending reload passes, but only the real up clears its marker", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node b.js")] };
    const { deps, anchor, id } = live(stack, [running("web", 101)], {
      isProcessAlive: () => false,
    });
    const marker: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] };
    writePendingReload(anchor, id, marker);
    const dry = await runUpDryRun(deps);
    expect(dry.instance).toBe("running");
    expect(readPendingReload(anchor, id)).toEqual(marker);
  });

  it("a stale socket file previews a fresh start and is left in place", async () => {
    const { deps, paths, effects } = live(noDefault, [], {
      probeSocket: async () => "stale" as const,
    });
    const dry = await runUpDryRun({ ...deps, namespaces: ["jobs"] });
    expect(dry.instance).toBe("fresh");
    expect(dry.selectedServices).toEqual(["worker"]);
    expect(existsSync(paths.socketPath)).toBe(true);
    expect(effects.reads).toBe(0);
  });

  it("a socket whose liveness stays unknown fails INSTANCE_UNRESPONSIVE and is kept", async () => {
    const { deps, paths } = live(noDefault, [], {
      probeSocket: async () => "unknown" as const,
      probeRetryDelaysMs: [],
    });
    const err = await dryFailure(deps);
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(existsSync(paths.socketPath)).toBe(true);
  });

  it("with no instance running, a bare dry run of a stack with no default services still fails NO_SERVICES_SELECTED", async () => {
    const { deps, paths } = live(noDefault, []);
    rmSync(paths.socketPath);
    const err = await dryFailure(deps);
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
  });

  /**
   * The real `up` hot-reloads a drifted stack before it reads the selection
   * back, so the preview must decide against the project the reload leaves.
   * `before` is the config the instance runs (on disk); `rows` the project.
   */
  describe("a drifted stack is previewed after its reload", () => {
    const lb = (name: string) => ({ ...isolated(name, `run ${name}`), namespace: "local-backend" });
    const jobs = (name: string) => ({ ...isolated(name, `run ${name}`), namespace: "jobs" });
    const before: ResolvedStack = { services: [lb("api"), lb("db"), jobs("worker")] };

    /** A live instance booted with `-n local-backend` from `before`, now drifted to `after`. */
    function drifted(after: ResolvedStack, projectAfterReload: string[]) {
      let rows = [running("api"), running("db")];
      const fixture = live(after, rows, {
        readStoredHash: () => stackHash(before),
        getServiceStatuses: async () => rows,
      });
      const processes = Object.fromEntries(
        before.services.map((s) => [s.name, { command: s.command, namespace: s.namespace }]),
      );
      writeFileSync(fixture.paths.configPath, stringifyYaml({ processes }));
      // What process-compose does on `project update` (verified on v1.122.0).
      const reloaded: CommandDeps = {
        ...fixture.deps,
        driver: {
          ...fixture.deps.driver,
          controlRequest: () => {
            rows = projectAfterReload.map((n) => running(n));
            return Promise.resolve({ status: 200, body: "{}" });
          },
        },
      };
      return { dry: fixture.deps, real: reloaded };
    }

    async function realChecks(deps: CommandDeps): Promise<string[] | string> {
      const waited: string[][] = [];
      return runUp({
        ...deps,
        waitForHealth: async ({ serviceNames }) => {
          waited.push([...serviceNames]);
        },
      }).then(
        () => waited.flat(),
        (e: { code?: string }) => e.code ?? "error",
      );
    }

    it("a new service in a booted namespace: neither NAMESPACE_NOT_RUNNING nor an empty bare selection", async () => {
      const after: ResolvedStack = {
        services: [lb("api"), lb("db"), lb("cache"), jobs("worker")],
      };
      const scoped = drifted(after, ["api", "cache", "db"]);
      const dryScoped = await runUpDryRun({ ...scoped.dry, namespaces: ["local-backend"] });
      expect(dryScoped.wouldReload).toBe(true);
      expect(dryScoped.selectedServices).toEqual(["api", "db", "cache"]);
      expect(await realChecks({ ...scoped.real, namespaces: ["local-backend"] })).toEqual(
        dryScoped.selectedServices,
      );

      const bare = drifted(after, ["api", "cache", "db"]);
      const dryBare = await runUpDryRun(bare.dry);
      expect(dryBare.namespaces).toEqual(["local-backend"]);
      expect(dryBare.selectedServices).toEqual(["api", "db", "cache"]);
      expect(await realChecks(bare.real)).toEqual(dryBare.selectedServices);
    });

    it("a service removed from a booted namespace", async () => {
      const after: ResolvedStack = { services: [lb("api"), jobs("worker")] };
      const { dry, real } = drifted(after, ["api"]);
      const preview = await runUpDryRun(dry);
      expect(preview.namespaces).toEqual(["local-backend"]);
      expect(preview.selectedServices).toEqual(["api"]);
      expect(await realChecks(real)).toEqual(preview.selectedServices);
    });

    it("a service moved to an unbooted namespace leaves the project", async () => {
      const after: ResolvedStack = { services: [jobs("api"), lb("db"), jobs("worker")] };
      const bare = drifted(after, ["db"]);
      const preview = await runUpDryRun(bare.dry);
      expect(preview.namespaces).toEqual(["local-backend"]);
      expect(preview.selectedServices).toEqual(["db"]);
      expect(await realChecks(bare.real)).toEqual(preview.selectedServices);

      const scoped = drifted(after, ["db"]);
      const err = await dryFailure({ ...scoped.dry, namespaces: ["jobs"] });
      expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
      expect(err?.details?.["services"]).toEqual(["api", "worker"]);
      expect(await realChecks({ ...scoped.real, namespaces: ["jobs"] })).toBe(
        "NAMESPACE_NOT_RUNNING",
      );
    });

    it("a dead service the reload edits is started by the reload, so it is not in would_restart", async () => {
      const stack: ResolvedStack = {
        services: [isolated("edited", "run a"), isolated("kept", "run k"), isolated("ok", "run o")],
      };
      const { deps, paths } = live(stack, [killed("edited"), killed("kept"), running("ok")]);
      // The config the instance runs: exactly what `stack` derives to.
      const current = await runUpDryRun(deps);
      writeFileSync(paths.configPath, stringifyYaml(current.config));
      const edited: ResolvedStack = {
        services: [isolated("edited", "run b"), isolated("kept", "run k"), isolated("ok", "run o")],
      };
      const preview = await runUpDryRun({
        ...deps,
        readStack: () => edited,
        readStoredHash: () => stackHash(stack),
      });
      expect(preview.wouldReload).toBe(true);
      expect(preview.wouldRestart).toEqual(["kept"]);
    });
  });

  it("the real up keeps the pending-reload marker when its read fails (#191)", async () => {
    // A failed read is no evidence the reload converged.
    const stack: ResolvedStack = { services: [isolated("web", "node b.js")] };
    let reads = 0;
    const { deps, anchor, id } = live(stack, [], {
      isProcessAlive: () => false,
      waitForHealth: async () => {},
      getServiceStatuses: async () => {
        reads++;
        if (reads === 1) throw new Error("process list failed");
        return [running("web", 101)];
      },
    });
    const marker: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] };
    writePendingReload(anchor, id, marker);
    await runUp(deps);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(readPendingReload(anchor, id)).toEqual(marker);
  });

  it("caps its process list read at 5s by default, and at --wait-timeout when given", async () => {
    const failing = () => Promise.reject(new Error("process list hung"));
    const { deps } = live(noDefault, [], { getServiceStatuses: failing });
    vi.useFakeTimers();
    try {
      const outcome = runUpDryRun(deps).then(
        () => "ok",
        (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
      );
      await vi.advanceTimersByTimeAsync(5_500);
      const settled = await Promise.race([outcome, Promise.resolve("still pending")]);
      expect(settled).toMatch(/^HEALTH_TIMEOUT: .*within 5000ms/);
    } finally {
      vi.useRealTimers();
    }
    const err = await dryFailure({ ...deps, waitTimeoutMs: 50 });
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("within 50ms");
  });
});

describe("runUpDryRun — derive the config(s) with no side effects (#124)", () => {
  it("returns the worktree config + env matching the deriver, without writing files or spawning", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js", ["WEB_PORT", "METRICS_PORT"])],
    };
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps = stubDeps({ stack, track });

    const result = await runUpDryRun(deps);

    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
    // The env carries the allocated worktree ports a sibling reads (#125).
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(20000);
    expect(Number(result.env.METRICS_PORT)).toBe(Number(result.env.WEB_PORT) + 1);
    expect(result.env.DEVTREES_WORKTREE_ID).toBe(deps.expectedWorktreeId);

    // The derived config is byte-identical to deriveWorktreeConfig for the same allocation.
    const expected = deriveWorktreeConfig(stack, {
      worktreeId: deps.expectedWorktreeId,
      worktreeRoot: result.worktreeRoot,
      portFor: (name) => (result.env[name] !== undefined ? Number(result.env[name]) : undefined),
    });
    expect(result.config).toEqual(expected.config);

    // No spawn, no config file on disk.
    expect(track.invocations).toEqual([]);
    const paths = instancePaths(
      result.worktreeRoot.replace(/\/wt\/login$/, "/.git"),
      deps.expectedWorktreeId,
    );
    expect(existsSync(paths.configPath)).toBe(false);
  });

  it("derives both the worktree and shared config(s) + injects shared ports into env", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
      ],
    };
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const result = await runUpDryRun(stubDeps({ stack, track }));

    expect(result.sharedConfig).toBeDefined();
    expect(result.sharedEnv).toBeDefined();
    // The shared port is injected into the worktree env as connection info.
    expect(result.env.DB_PORT).toBeDefined();
    expect(result.env.DB_PORT).toBe(result.sharedEnv?.DB_PORT);

    const expectedShared = deriveSharedConfig(stack, {
      workingDir: result.anchor,
      portFor: (name) =>
        result.sharedEnv?.[name] !== undefined ? Number(result.sharedEnv[name]) : undefined,
    });
    expect(result.sharedConfig).toEqual(expectedShared.config);

    // Dry run never lazy-starts the shared instance.
    expect(track.invocations).toEqual([]);
  });

  it("omits the shared config when the stack declares no shared services", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUpDryRun(stubDeps({ stack }));
    expect(result.sharedConfig).toBeUndefined();
    expect(result.sharedEnv).toBeUndefined();
  });

  /**
   * Issue #168: the deriver hands back every cross-tier edge it stripped, and
   * the dry run used to throw that list away — so the preview lost an authored
   * `depends_on` with no explanation. The real `up` warns; the preview must
   * carry the same information.
   */
  it("reports the cross-tier depends_on edges the derivation dropped", async () => {
    const web = { ...isolated("web", "node x.js", ["WEB_PORT"]), dependsOn: [{ name: "db" }] };
    const stack: ResolvedStack = {
      services: [web, shared("db", "postgres", ["DB_PORT"])],
    };
    const result = await runUpDryRun(stubDeps({ stack }));

    expect(result.droppedEdges).toEqual([
      { from: "web", to: "db", fromTier: "isolated", toTier: "shared" },
    ]);
    // The edge really is gone from the previewed config — that is the whole
    // reason the preview has to say so.
    expect(result.config.processes.web?.depends_on).toBeUndefined();
  });

  it("#200: reports ${NAME} of an injected variable in a command, escaped and bare forms excluded", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "serve ${WEB_PORT} $WEB_PORT $${WEB_PORT}", ["WEB_PORT"]),
        isolated("api", "serve ${DEVTREES_WORKTREE_ID} ${HOME}"),
      ],
    };
    const result = await runUpDryRun(stubDeps({ stack }));
    expect(result.bracedEnvVars).toEqual([
      { service: "web", variable: "WEB_PORT" },
      { service: "api", variable: "DEVTREES_WORKTREE_ID" },
    ]);
    // The command is not rewritten (ADR-0002).
    expect(result.config.processes.web?.command).toBe("serve ${WEB_PORT} $WEB_PORT $${WEB_PORT}");
  });

  it("#179: reports depends_on edges the namespace selection would drop", async () => {
    const stack: ResolvedStack = {
      services: [
        { ...isolated("db", "postgres"), namespace: ["one", "three"] },
        { ...isolated("api", "node api.js"), namespace: "two", dependsOn: [{ name: "db" }] },
      ],
    };
    const result = await runUpDryRun({ ...stubDeps({ stack }), namespaces: ["two"] });
    expect(result.droppedNamespaceEdges).toEqual([
      { from: "api", to: "db", toNamespaces: ["one", "three"] },
    ]);
    const kept = await runUpDryRun({ ...stubDeps({ stack }), namespaces: ["two", "three"] });
    expect(kept.droppedNamespaceEdges).toEqual([]);
  });

  it("reports no dropped edges when every depends_on stays within a tier", async () => {
    const web = { ...isolated("web", "node x.js", ["WEB_PORT"]), dependsOn: [{ name: "api" }] };
    const stack: ResolvedStack = {
      services: [web, isolated("api", "node api.js", ["API_PORT"])],
    };
    const result = await runUpDryRun(stubDeps({ stack }));
    expect(result.droppedEdges).toEqual([]);
    expect(result.config.processes.web?.depends_on).toEqual({
      api: { condition: expect.any(String) },
    });
  });

  it("does not register an instance, write a hash, take the lifecycle lock, or wait for health", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    let lifecycleLockTaken = false;
    let sharedLockTaken = false;
    let hashWritten = false;
    let healthWaited = false;
    const deps: CommandDeps = {
      ...stubDeps({ stack }),
      withLifecycleLock: async (_a, _i, fn) => {
        lifecycleLockTaken = true;
        return fn();
      },
      withSharedLock: async (_a, fn) => {
        sharedLockTaken = true;
        return fn();
      },
      writeStoredHash: () => {
        hashWritten = true;
      },
      waitForHealth: async () => {
        healthWaited = true;
      },
      waitForSharedHealth: async () => {
        healthWaited = true;
      },
    };
    await runUpDryRun(deps);
    expect(lifecycleLockTaken).toBe(false);
    expect(sharedLockTaken).toBe(false);
    expect(hashWritten).toBe(false);
    expect(healthWaited).toBe(false);
  });

  it("allocation may take the registry lock briefly to pick a non-colliding block (documented)", async () => {
    // Port allocation is the ONE registry-lock touch dry-run is allowed (it
    // does not start or register an instance).
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    let registryLockTaken = false;
    const base = stubDeps({ stack });
    const deps: CommandDeps = {
      ...base,
      withRegistryLock: async (anchor, mutate) => {
        registryLockTaken = true;
        return base.withRegistryLock!(anchor, mutate);
      },
    };
    await runUpDryRun(deps);
    expect(registryLockTaken).toBe(true);
  });
});

describe("findUnmanagedPortBinds — heuristic", () => {
  const stack = (cmd: string): ResolvedStack => ({ services: [isolated("web", cmd)] });

  it("flags a `--port NNNN` literal outside the block", () => {
    expect(findUnmanagedPortBinds(stack("node x --port 3000"), 20000, 32)).toHaveLength(1);
  });

  it("flags a `:NNNN` host:port literal outside the block", () => {
    expect(findUnmanagedPortBinds(stack("redis-cli -h 127.0.0.1:6379"), 20000, 32)).toHaveLength(1);
  });

  it("ignores a literal that falls inside the block (caller already managed it)", () => {
    // 20000 is the block base — exactly inside [20000, 20031].
    expect(findUnmanagedPortBinds(stack("node x --port 20000"), 20000, 32)).toHaveLength(0);
  });

  it("ignores 3-digit numbers (too small to be a user port) and 6-digit numbers", () => {
    expect(findUnmanagedPortBinds(stack("node x --version 999 --build 100000"), 20000, 32)).toEqual(
      [],
    );
  });

  it("does not flag shared services (they live in another instance)", () => {
    const s: ResolvedStack = {
      services: [service("pg", "postgres -p 5432", [], "shared")],
    };
    expect(findUnmanagedPortBinds(s, 20000, 32)).toEqual([]);
  });
});

describe("runLs — instance enumeration", () => {
  it("resolves the anchor from cwd and returns the discovered instances", async () => {
    const tmp = tmpAnchor();
    // No instances written yet — discovery should return an empty list.
    const git: CommandDeps["git"] = (args) => {
      const flag = args[1];
      if (flag === "--git-common-dir") return tmp.anchor;
      if (flag === "--show-toplevel") return join(tmp.worktreeRoot, "login");
      if (flag === "--is-bare-repository") return "false";
      throw new Error("unexpected");
    };
    const { runLs } = await import("./commands.js");
    const result = await runLs({ cwd: join(tmp.worktreeRoot, "login"), git });
    expect(result.anchor).toBe(tmp.anchor);
    expect(result.instances).toEqual([]);
  });

  it("delegates enumeration to an injected discoverer for testability", async () => {
    const tmp = tmpAnchor();
    const git: CommandDeps["git"] = (args) => {
      const flag = args[1];
      if (flag === "--git-common-dir") return tmp.anchor;
      if (flag === "--show-toplevel") return join(tmp.worktreeRoot, "login");
      if (flag === "--is-bare-repository") return "false";
      throw new Error("unexpected");
    };
    const stub = [
      {
        id: "login",
        kind: "worktree" as const,
        status: "running" as const,
        socketPath: "/x/login.sock",
        ports: { WEB_PORT: 20512 },
        blockBase: 20512,
        services: [],
      },
    ];
    const { runLs } = await import("./commands.js");
    const result = await runLs({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      discover: async () => stub,
    });
    expect(result.instances).toEqual(stub);
  });

  it("never writes the allocation registry lock-file — `ls` is a pure read path", async () => {
    // The lock-free guarantee is on ADR-0001's critical path: concurrent
    // agents enumerating from sibling worktrees must not serialise through
    // the registry. Probe the on-disk lock-file: a no-write `ls` leaves it
    // untouched (mtime unchanged from a baseline written before the call).
    const tmp = tmpAnchor();
    mkdirSync(join(tmp.anchor, "devtrees"), { recursive: true });
    const lockPath = join(tmp.anchor, "devtrees", "registry.json.lock");
    // Seed a baseline lockfile so we can compare its mtime.
    writeFileSync(lockPath, "", "utf8");
    const before = statSync(lockPath).mtimeMs;
    const git: CommandDeps["git"] = (args) => {
      const flag = args[1];
      if (flag === "--git-common-dir") return tmp.anchor;
      if (flag === "--show-toplevel") return join(tmp.worktreeRoot, "login");
      if (flag === "--is-bare-repository") return "false";
      throw new Error("unexpected");
    };
    const { runLs } = await import("./commands.js");
    await runLs({ cwd: join(tmp.worktreeRoot, "login"), git });
    expect(statSync(lockPath).mtimeMs).toBe(before);
  });

  it("threads the driver's getServiceStatuses into the discoverer (issue #29 plumbing)", async () => {
    const tmp = tmpAnchor();
    const git: CommandDeps["git"] = (args) => {
      const flag = args[1];
      if (flag === "--git-common-dir") return tmp.anchor;
      if (flag === "--show-toplevel") return join(tmp.worktreeRoot, "login");
      if (flag === "--is-bare-repository") return "false";
      throw new Error("unexpected");
    };
    // Driver injection is the same one up/down use — exists+spawner. The
    // spawner here is never reached because runLs's getServiceStatuses goes
    // through the driver and the discoverer below sees the function only.
    let receivedFetch: unknown;
    const { runLs } = await import("./commands.js");
    await runLs({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      driver: { exists: () => Promise.resolve(true) },
      discover: async (_anchor, deps) => {
        receivedFetch = deps.getServiceStatuses;
        return [];
      },
    });
    // The discoverer must have been handed a callable — the wiring exists,
    // even when no instance ends up exercising it.
    expect(typeof receivedFetch).toBe("function");
  });

  it("bounds each instance's service read: a wedged instance fails within the budget, in parallel with the rest (#226)", async () => {
    const tmp = tmpAnchor();
    const git: CommandDeps["git"] = (args) => {
      const flag = args[1];
      if (flag === "--git-common-dir") return tmp.anchor;
      if (flag === "--show-toplevel") return join(tmp.worktreeRoot, "login");
      if (flag === "--is-bare-repository") return "false";
      throw new Error("unexpected");
    };
    const killed: string[] = [];
    // `process list` against `wedged.sock` never answers, like a SIGSTOPped
    // process-compose; against any other socket it answers at once.
    const spawner: NonNullable<CommandDeps["driver"]>["spawner"] = (_binary, args) => {
      const socket = String(args[args.indexOf("-u") + 1]);
      const emitter = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        kill: () => boolean;
      };
      emitter.kill = () => {
        killed.push(socket);
        return true;
      };
      if (socket.endsWith("wedged.sock")) {
        emitter.stdout = new Readable({ read() {} });
        return emitter as unknown as SpawnedProcess;
      }
      emitter.stdout = Readable.from([JSON.stringify([{ name: "web", status: "Running" }])]);
      emitter.stdout.on("end", () => queueMicrotask(() => emitter.emit("exit", 0)));
      return emitter as unknown as SpawnedProcess;
    };
    const reads: Array<{ socket: string; ms: number; ok: boolean }> = [];
    const { runLs } = await import("./commands.js");
    const started = Date.now();
    await runLs({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      driver: { exists: () => Promise.resolve(true), spawner },
      readTimeoutMs: 300,
      probeSocket: async () => "running",
      discover: async (_anchor, deps) => {
        await Promise.all(
          ["/x/wedged.sock", "/x/login.sock"].map(async (socket) => {
            const t0 = Date.now();
            const ok = await deps.getServiceStatuses!(socket).then(
              () => true,
              () => false,
            );
            reads.push({ socket, ms: Date.now() - t0, ok });
          }),
        );
        return [];
      },
    });
    const wedged = reads.find((r) => r.socket === "/x/wedged.sock");
    expect(reads.find((r) => r.socket === "/x/login.sock")?.ok).toBe(true);
    expect(wedged?.ok).toBe(false);
    // Retried within the budget, every hung client killed, never waited on past it.
    expect(wedged?.ms).toBeLessThan(2_000);
    expect(killed.length).toBeGreaterThan(0);
    expect(killed.every((s) => s === "/x/wedged.sock")).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/**
 * Tracker for `process-compose attach` invocations — the spawner records the
 * args so the test can assert which socket path was attached against.
 */
interface AttachInvocation {
  args: ReadonlyArray<string>;
}

function makeAttachSpawner(track: { invocations: AttachInvocation[] }) {
  return (_binary: string, args: ReadonlyArray<string>, _options: unknown): SpawnedProcess => {
    if (args[0] === "attach") {
      track.invocations.push({ args });
    }
    return spawnedOk();
  };
}

/**
 * Build a `CommandDeps` whose `driver` collaborates with the attach spawner;
 * unlike `stubDeps`, this skips the allocator/lock plumbing because `runAttach`
 * does not allocate ports or read the stack.
 */
function attachDeps(opts: {
  anchor: string;
  worktreeRoot: string;
  worktreeId: string;
  track: { invocations: AttachInvocation[] };
}): CommandDeps {
  const git = (args: ReadonlyArray<string>): string => {
    const flag = args[1];
    if (flag === "--git-common-dir") return opts.anchor;
    if (flag === "--show-toplevel") return join(opts.worktreeRoot, opts.worktreeId);
    if (flag === "--is-bare-repository") return "false";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  return {
    cwd: join(opts.worktreeRoot, opts.worktreeId),
    git,
    driver: {
      exists: () => Promise.resolve(true),
      spawner: makeAttachSpawner(opts.track),
    },
  };
}

describe("runAttach — attach to a running instance", () => {
  it("attaches the worktree instance by default — driver receives that socket", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const derivedId = idFor(tmp.worktreeRoot, worktreeId);
    const paths = {
      configPath: join(tmp.anchor, "devtrees", `${derivedId}.yaml`),
      socketPath: instancePaths(tmp.anchor, derivedId).socketPath,
    };
    // Mimic a running instance: the control socket file exists.
    mkdtempSync(join(tmpdir(), "dt-noop-")); // (no-op; keep symmetric with other tests)
    // Use the actual path layout — create the directory and socket file.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(paths.socketPath, "");

    const track = { invocations: [] as AttachInvocation[] };
    const deps = attachDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId,
      track,
    });

    await runAttach(deps, { shared: false });
    expect(track.invocations).toHaveLength(1);
    expect(track.invocations[0]?.args).toContain(paths.socketPath);
  });

  it("attaches the shared instance with { shared: true }", async () => {
    const tmp = tmpAnchor();
    const { mkdirSync } = await import("node:fs");
    const sharedSocket = sharedInstancePaths(tmp.anchor).socketPath;
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(sharedSocket, "");

    const track = { invocations: [] as AttachInvocation[] };
    const deps = attachDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      track,
    });

    await runAttach(deps, { shared: true });
    expect(track.invocations).toHaveLength(1);
    expect(track.invocations[0]?.args).toContain(sharedSocket);
  });

  it("throws a clear error when the worktree instance is not running", async () => {
    const tmp = tmpAnchor();
    const track = { invocations: [] as AttachInvocation[] };
    const deps = attachDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      track,
    });
    // No socket file exists.
    await expect(runAttach(deps, { shared: false })).rejects.toThrow(/no worktree instance.*login/);
    expect(track.invocations).toEqual([]);
  });

  it("throws a clear error when the shared instance is not running", async () => {
    const tmp = tmpAnchor();
    const track = { invocations: [] as AttachInvocation[] };
    const deps = attachDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      track,
    });
    await expect(runAttach(deps, { shared: true })).rejects.toThrow(
      /no shared instance is running/,
    );
    expect(track.invocations).toEqual([]);
  });
});

describe("runPrune — reconcile instances against git worktree list", () => {
  /**
   * Build a fake git probe that answers `--git-common-dir`/`--show-toplevel`
   * for the anchor resolver and supplies `git worktree list --porcelain`
   * output for the prune step.
   */
  function pruneGit(opts: {
    anchor: string;
    worktreeRoot: string;
    worktreeId: string;
    porcelain: string;
  }): CommandDeps["git"] {
    return (args) => {
      const [verb, ...rest] = args;
      if (verb === "rev-parse") {
        const flag = rest[0];
        if (flag === "--git-common-dir") return opts.anchor;
        if (flag === "--show-toplevel") return join(opts.worktreeRoot, opts.worktreeId);
        if (flag === "--is-bare-repository") return "false";
      }
      if (verb === "worktree" && rest[0] === "list" && rest[1] === "--porcelain") {
        return opts.porcelain;
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
  }

  function instance(
    id: string,
    overrides: {
      kind?: "worktree" | "shared";
      status?: "running" | "stale" | "unknown";
      socketPath?: string;
    } = {},
  ) {
    return {
      id,
      kind: overrides.kind ?? ("worktree" as const),
      status: overrides.status ?? ("stale" as const),
      socketPath: overrides.socketPath ?? `/anchor/devtrees/run/${id}.sock`,
      ports: {} as Readonly<Record<string, number>>,
      blockBase: undefined,
      services: [] as ReadonlyArray<never>,
    };
  }

  it("returns an empty pruned list when every worktree instance is still live", async () => {
    const tmp = tmpAnchor();
    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      porcelain: [
        `worktree ${join(tmp.worktreeRoot, "login")}`,
        "HEAD x",
        "",
        `worktree ${join(tmp.worktreeRoot, "billing")}`,
        "HEAD y",
        "",
      ].join("\n"),
    });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      discover: async () => [
        instance(idFor(tmp.worktreeRoot, "login")),
        instance(idFor(tmp.worktreeRoot, "billing")),
      ],
    });
    expect(result.pruned).toEqual([]);
  });

  it("never prunes the shared instance, even when no worktrees are reported live", async () => {
    // The shared instance is anchored at the git common dir, not at any
    // worktree. Removing every worktree must NOT take shared down — only an
    // explicit `devtrees down --shared` does that (ADR-0001).
    const tmp = tmpAnchor();
    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      porcelain: "",
    });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      discover: async () => [instance("shared", { kind: "shared" })],
    });
    expect(result.pruned).toEqual([]);
  });

  it("stops a running orphan via the driver and cleans up its anchor state", async () => {
    // The motivating case from CONTEXT.md's example dialogue: a worktree was
    // removed with `git worktree remove` while its stack was still running.
    // Prune stops the orphan and removes its socket, derived config, and
    // registry entry.
    const tmp = tmpAnchor();
    // Pre-stage the anchor state for the orphan instance.
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphanSocket = instancePaths(tmp.anchor, "removed").socketPath;
    const orphanConfig = join(tmp.anchor, "devtrees", "removed.yaml");
    writeFileSync(orphanSocket, "");
    writeFileSync(orphanConfig, "processes: {}\n");

    const downCalls: Array<{ configPath: string; socketPath: string }> = [];

    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      porcelain: [`worktree ${join(tmp.worktreeRoot, "login")}`, "HEAD x", ""].join("\n"),
    });

    const registryRef = { snapshot: { login: 20000, removed: 20032 } as RegistrySnapshot };

    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      discover: async () => [
        instance(idFor(tmp.worktreeRoot, "login"), {
          status: "running",
          socketPath: "/x/login.sock",
        }),
        instance("removed", {
          status: "running",
          socketPath: orphanSocket,
        }),
      ],
      withRegistryLock: async (_anchor, mutate) => {
        const after = await mutate(registryRef.snapshot);
        registryRef.snapshot = after;
        return after;
      },
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_binary, args) => {
          // The driver invokes `down -U -u <socket>`.
          const verb = args[0];
          const si = args.indexOf("-u");
          if (verb === "down" && si >= 0) {
            const socketPath = args[si + 1] ?? "";
            downCalls.push({ configPath: "", socketPath });
          }
          return spawnedOk();
        },
      },
    });

    // Acceptance: orphan is reported in the result.
    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
    // Acceptance: driver.down was called for the orphan only.
    expect(downCalls.map((c) => c.socketPath)).toEqual([orphanSocket]);
    // Acceptance: anchor state for the orphan is gone.
    expect(existsSync(orphanSocket)).toBe(false);
    expect(existsSync(orphanConfig)).toBe(false);
    // Acceptance: the live worktree's registry entry is untouched.
    expect(registryRef.snapshot.login).toBe(20000);
    // Acceptance: the orphan's registry entry is gone.
    expect("removed" in registryRef.snapshot).toBe(false);
  });

  it("an orphan whose liveness is unknown gets the graceful driver.down a running one does (#186)", async () => {
    // Its worktree is gone, so prune still reclaims it, but it may be a live
    // process-compose that was merely slow to answer: stopping it through the
    // driver is the only way it doesn't outlive the sweep.
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphanSocket = instancePaths(tmp.anchor, "removed").socketPath;
    writeFileSync(orphanSocket, "");
    const downSockets: string[] = [];
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git: pruneGit({
        anchor: tmp.anchor,
        worktreeRoot: tmp.worktreeRoot,
        worktreeId: "login",
        porcelain: [`worktree ${join(tmp.worktreeRoot, "login")}`, "HEAD x", ""].join("\n"),
      }),
      discover: async () => [instance("removed", { status: "unknown", socketPath: orphanSocket })],
      withRegistryLock: async (_anchor, mutate) => mutate({}),
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_binary, args) => {
          if (args[0] === "down") downSockets.push(args[args.indexOf("-u") + 1] ?? "");
          return spawnedOk();
        },
      },
    });
    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
    expect(downSockets).toEqual([orphanSocket]);
    expect(result.unreclaimed).toEqual([]);
    expect(existsSync(orphanSocket)).toBe(false);
  });

  it("an unknown orphan whose down fails is NOT reclaimed: socket, config and registry entry kept, reported unreclaimed (#186)", async () => {
    // Unlinking here would recreate #186's invisible orphan: a possibly-live
    // process-compose that no `ls`/`down`/`prune` could see any more.
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphanSocket = instancePaths(tmp.anchor, "removed").socketPath;
    const orphanConfig = instancePaths(tmp.anchor, "removed").configPath;
    writeFileSync(orphanSocket, "");
    writeFileSync(orphanConfig, "processes: {}\n");
    const liveId = idFor(tmp.worktreeRoot, "login");
    const registryRef = {
      snapshot: { [liveId]: 20000, removed: 20032 } as RegistrySnapshot,
    };
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git: pruneGit({
        anchor: tmp.anchor,
        worktreeRoot: tmp.worktreeRoot,
        worktreeId: "login",
        porcelain: [`worktree ${join(tmp.worktreeRoot, "login")}`, "HEAD x", ""].join("\n"),
      }),
      discover: async () => [instance("removed", { status: "unknown", socketPath: orphanSocket })],
      readRegistry: () => registryRef.snapshot,
      withRegistryLock: async (_anchor, mutate) => {
        registryRef.snapshot = await mutate(registryRef.snapshot);
        return registryRef.snapshot;
      },
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_binary, args) =>
          args[0] === "down" ? refusedStart("connection refused") : spawnedOk(),
      },
    });
    expect(result.pruned).toEqual([]);
    expect(result.unreclaimed).toEqual([
      expect.objectContaining({ id: "removed", kind: "worktree", socketPath: orphanSocket }),
    ]);
    expect(result.unreclaimed[0]?.message).not.toBe("");
    expect(existsSync(orphanSocket)).toBe(true);
    expect(existsSync(orphanConfig)).toBe(true);
    expect(registryRef.snapshot.removed).toBe(20032);
  });

  it("a running orphan whose down fails is still reclaimed (only `unknown` is held back)", async () => {
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphanSocket = instancePaths(tmp.anchor, "removed").socketPath;
    writeFileSync(orphanSocket, "");
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git: pruneGit({
        anchor: tmp.anchor,
        worktreeRoot: tmp.worktreeRoot,
        worktreeId: "login",
        porcelain: [`worktree ${join(tmp.worktreeRoot, "login")}`, "HEAD x", ""].join("\n"),
      }),
      discover: async () => [instance("removed", { status: "running", socketPath: orphanSocket })],
      withRegistryLock: async (_anchor, mutate) => mutate({}),
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_binary, args) => (args[0] === "down" ? refusedStart("boom") : spawnedOk()),
      },
    });
    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
    expect(result.unreclaimed).toEqual([]);
    expect(existsSync(orphanSocket)).toBe(false);
  });

  it("cleans up a stale orphan (socket file with no listener) without calling driver.down", async () => {
    // When the process-compose has already died, there is nothing to stop —
    // just leftover files to clear. The driver should not be invoked.
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphanSocket = instancePaths(tmp.anchor, "removed").socketPath;
    const orphanConfig = join(tmp.anchor, "devtrees", "removed.yaml");
    writeFileSync(orphanSocket, "");
    writeFileSync(orphanConfig, "processes: {}\n");

    const downCalls: string[] = [];
    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      porcelain: "",
    });
    const registryRef = { snapshot: { removed: 20000 } as RegistrySnapshot };

    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      discover: async () => [instance("removed", { status: "stale", socketPath: orphanSocket })],
      withRegistryLock: async (_anchor, mutate) => {
        const after = await mutate(registryRef.snapshot);
        registryRef.snapshot = after;
        return after;
      },
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_binary, args) => {
          downCalls.push(args[0] ?? "");
          return spawnedOk();
        },
      },
    });

    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
    // Acceptance: no driver.down for a stale instance — nothing is listening.
    expect(downCalls).toEqual([]);
    expect(existsSync(orphanSocket)).toBe(false);
    expect(existsSync(orphanConfig)).toBe(false);
    expect("removed" in registryRef.snapshot).toBe(false);
  });

  it("leaves an instance whose worktree still exists alone, even if status is stale", async () => {
    // A stale-status worktree instance whose worktree dir still exists is
    // not an orphan from prune's perspective — the developer may have just
    // crashed the stack and want to re-up. Reconciliation uses the worktree
    // list, not the socket liveness, as the source of truth (#9 acceptance).
    const tmp = tmpAnchor();
    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      porcelain: [`worktree ${join(tmp.worktreeRoot, "login")}`, "HEAD x", ""].join("\n"),
    });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      discover: async () => [instance(idFor(tmp.worktreeRoot, "login"), { status: "stale" })],
    });
    expect(result.pruned).toEqual([]);
  });

  it("continues pruning the rest when one orphan's driver.down fails", async () => {
    // A best-effort cleanup: if `process-compose down` errors (binary gone,
    // socket already half-dead), prune still removes anchor state and moves
    // on. The whole point of prune is to reclaim stale state.
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const a = instancePaths(tmp.anchor, "alpha").socketPath;
    const b = instancePaths(tmp.anchor, "beta").socketPath;
    writeFileSync(a, "");
    writeFileSync(b, "");
    writeFileSync(join(tmp.anchor, "devtrees", "alpha.yaml"), "");
    writeFileSync(join(tmp.anchor, "devtrees", "beta.yaml"), "");

    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "live",
      porcelain: [`worktree ${join(tmp.worktreeRoot, "live")}`, "HEAD x", ""].join("\n"),
    });
    const registryRef = { snapshot: { alpha: 20000, beta: 20032 } as RegistrySnapshot };
    let firstDown = true;
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "live"),
      git,
      discover: async () => [
        instance("alpha", { status: "running", socketPath: a }),
        instance("beta", { status: "running", socketPath: b }),
      ],
      withRegistryLock: async (_anchor, mutate) => {
        const after = await mutate(registryRef.snapshot);
        registryRef.snapshot = after;
        return after;
      },
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_binary, _args) => {
          if (firstDown) {
            firstDown = false;
            // Simulate process-compose down failing — emit exit(1).
            return {
              on(event: "error" | "exit", cb: (arg: never) => void): void {
                if (event === "exit") queueMicrotask(() => (cb as (c: number) => void)(1));
              },
              unref: () => {},
            };
          }
          return spawnedOk();
        },
      },
    });

    expect(result.pruned.map((p) => p.id).sort()).toEqual(["alpha", "beta"]);
    // Both orphans had their anchor state cleared regardless of down outcome.
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect("alpha" in registryRef.snapshot).toBe(false);
    expect("beta" in registryRef.snapshot).toBe(false);
  });

  it("reclaims a dead registry reservation with no socket (down-then-removed) and preserves __shared__ (issue #142)", async () => {
    // The tidy workflow: `devtrees down` then `git worktree remove`. No socket
    // survives, so socket discovery finds nothing — but the registry still
    // holds the dead reservation and the derived *.yaml is orphaned on disk.
    // Prune must reconcile the registry directly against the live worktree set.
    const tmp = tmpAnchor();
    mkdirSync(join(tmp.anchor, "devtrees"), { recursive: true });
    const deadId = idFor(tmp.worktreeRoot, "feature");
    const liveId = idFor(tmp.worktreeRoot, "main");
    // The orphaned derived config carries the worktree path under working_dir.
    const featurePath = join(tmp.worktreeRoot, "feature");
    const deadConfig = instancePaths(tmp.anchor, deadId).configPath;
    writeFileSync(deadConfig, stringifyYaml({ processes: { web: { working_dir: featurePath } } }));

    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "main",
      porcelain: [`worktree ${join(tmp.worktreeRoot, "main")}`, "HEAD x", ""].join("\n"),
    });

    const registryRef = {
      snapshot: {
        [liveId]: 22048,
        [deadId]: 42560,
        [SHARED_REGISTRY_KEY]: 30000,
      } as RegistrySnapshot,
    };

    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(tmp.worktreeRoot, "main"),
      git,
      // No socket survives: discovery finds nothing.
      discover: async () => [],
      readRegistry: () => registryRef.snapshot,
      withRegistryLock: async (_anchor, mutate) => {
        const after = await mutate(registryRef.snapshot);
        registryRef.snapshot = after;
        return after;
      },
    });

    // Acceptance: the dead reservation is reported in pruned[] with its path.
    expect(result.pruned.map((p) => p.id)).toEqual([deadId]);
    expect(result.pruned[0]?.worktreePath).toBe(featurePath);
    // Acceptance: the registry entry is gone.
    expect(deadId in registryRef.snapshot).toBe(false);
    // Acceptance: __shared__ is preserved.
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBe(30000);
    // Acceptance: the live worktree's reservation is untouched.
    expect(registryRef.snapshot[liveId]).toBe(22048);
    // Acceptance: the orphaned derived config is removed.
    expect(existsSync(deadConfig)).toBe(false);
    // Acceptance: __shared__ and the live worktree's reservation are preserved.
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBe(30000);
    expect(registryRef.snapshot[liveId]).toBe(22048);
  });

  /**
   * Issue #148 — `prune` must reap each orphan's out-of-band resources by
   * running the derived `shutdown.command` itself, from a cwd that exists
   * (the anchor), BEFORE deleting the derived config. process-compose can't
   * fire the hook once `git worktree remove` deleted the `working_dir`, so a
   * graceful `down` alone leaks the stack — regardless of supervisor liveness.
   */
  function reapFixture(status: "running" | "stale") {
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphanSocket = instancePaths(tmp.anchor, "removed").socketPath;
    const orphanConfig = join(tmp.anchor, "devtrees", "removed.yaml");
    const goneWorktree = join(tmp.worktreeRoot, "removed");
    writeFileSync(orphanSocket, "");
    // A derived config whose process declares a shutdown.command and an
    // embedded environment, pinned to a working_dir that no longer exists.
    writeFileSync(
      orphanConfig,
      stringifyYaml({
        processes: {
          db: {
            command: "node server.js",
            working_dir: goneWorktree,
            environment: ["DEVTREES_WORKTREE_ID=removed", "DB_PORT=20001"],
            shutdown: { command: "reap-stack.sh", timeout_seconds: 9 },
          },
        },
        "x-devtrees": { ports_by_service: {} },
      }),
    );
    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "live",
      porcelain: [`worktree ${join(tmp.worktreeRoot, "live")}`, "HEAD x", ""].join("\n"),
    });
    const registryRef = { snapshot: { removed: 20000 } as RegistrySnapshot };
    return { tmp, orphanSocket, orphanConfig, goneWorktree, git, registryRef, status };
  }

  for (const status of ["running", "stale"] as const) {
    it(`runs each orphan's shutdown.command from the anchor (not the deleted working_dir) — ${status} supervisor (#148)`, async () => {
      const fx = reapFixture(status);
      const reapCalls: Array<{ cwd: string; config: DerivedConfig }> = [];

      const { runPrune } = await import("./commands.js");
      await runPrune({
        cwd: join(fx.tmp.worktreeRoot, "live"),
        git: fx.git,
        discover: async () => [instance("removed", { status, socketPath: fx.orphanSocket })],
        withRegistryLock: async (_anchor, mutate) => {
          fx.registryRef.snapshot = await mutate(fx.registryRef.snapshot);
          return fx.registryRef.snapshot;
        },
        driver: { exists: () => Promise.resolve(true), spawner: () => spawnedOk() },
        reap: async (config, deps) => {
          reapCalls.push({ cwd: deps.cwd, config });
          return { ranCount: 1, failures: [] };
        },
      });

      // Acceptance #1/#2: the hook reap fired regardless of supervisor liveness.
      expect(reapCalls).toHaveLength(1);
      // Acceptance: from a cwd that exists — the anchor, never the gone worktree.
      expect(reapCalls[0]?.cwd).toBe(fx.tmp.anchor);
      expect(reapCalls[0]?.cwd).not.toBe(fx.goneWorktree);
      // The reaper saw the orphan's derived process + its shutdown.command.
      expect(reapCalls[0]?.config.processes.db?.shutdown).toEqual({
        command: "reap-stack.sh",
        timeout_seconds: 9,
      });
      // Acceptance #3: the config (whose hook removes the .project record) is
      // read before deletion, then removed afterwards.
      expect(existsSync(fx.orphanConfig)).toBe(false);
      expect(existsSync(fx.orphanSocket)).toBe(false);
    });
  }

  it("reflects a failed orphan reap in PruneResult.warnings — NOT a silent clean teardown (#148 acceptance 5)", async () => {
    const fx = reapFixture("running");

    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      cwd: join(fx.tmp.worktreeRoot, "live"),
      git: fx.git,
      discover: async () => [
        instance("removed", { status: "running", socketPath: fx.orphanSocket }),
      ],
      withRegistryLock: async (_anchor, mutate) => {
        fx.registryRef.snapshot = await mutate(fx.registryRef.snapshot);
        return fx.registryRef.snapshot;
      },
      driver: { exists: () => Promise.resolve(true), spawner: () => spawnedOk() },
      reap: async () => ({
        ranCount: 1,
        failures: [
          {
            process: "db",
            command: "reap-stack.sh",
            reason: "exit",
            message: "exited with code 1",
          },
        ],
      }),
    });

    // Acceptance #5: the failure is reflected in the structured result so the
    // CLI formatter can warn; the sweep does NOT report a clean teardown.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.orphanId).toBe("removed");
    expect(result.warnings[0]?.worktreePath).toBe(fx.goneWorktree);
    expect(result.warnings[0]?.failures[0]?.process).toBe("db");
    // The orphan is still reported pruned (state is reclaimed regardless).
    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
  });
});

/**
 * `runEnv` — pure read of the injected-value map (#32).
 *
 * Contract: returns the same map the config deriver would inject into the
 * worktree instance — this worktree's named ports + the shared services'
 * named ports + the worktree id — without spawning process-compose, without
 * acquiring the allocation-registry lock, and without persisting anything.
 * Calling `env` when the worktree instance is not running is valid.
 */
describe("runEnv — pure read of injected env", () => {
  it("returns the same env map the deriver would inject for this worktree", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT", "METRICS_PORT"]),
        shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
      ],
    };
    // Seed the registry so the answer is deterministic without an up.
    const loginId = idFor("/wt", "login");
    const initialRegistry: RegistrySnapshot = { [loginId]: 20000, [SHARED_REGISTRY_KEY]: 30000 };
    const result = await runEnv(stubDeps({ stack, worktreeRootOverride: "/wt", initialRegistry }));

    expect(result.env.DEVTREES_WORKTREE_ID).toBe(loginId);
    expect(result.env.WEB_PORT).toBe("20000");
    expect(result.env.METRICS_PORT).toBe("20001");
    expect(result.env.DB_PORT).toBe("30000");
  });

  it("matches deriveWorktreeConfig's env byte-for-byte for the same allocation", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    const loginId = idFor("/wt", "login");
    const initialRegistry: RegistrySnapshot = { [loginId]: 20096, [SHARED_REGISTRY_KEY]: 30016 };
    const result = await runEnv(stubDeps({ stack, worktreeRootOverride: "/wt", initialRegistry }));

    // The deriver's env is the source of truth; runEnv must reproduce it exactly.
    const expected = deriveWorktreeConfig(stack, {
      worktreeId: loginId,
      worktreeRoot: "ignored",
      portFor: (name) => (name === "WEB_PORT" ? 20096 : undefined),
      sharedPortFor: (name) => (name === "DB_PORT" ? 30016 : undefined),
    });
    expect(result.env).toEqual(expected.env);
  });

  it("does not spawn process-compose (pure read; no driver interaction)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node x.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    await runEnv(stubDeps({ stack, track }));
    expect(track.invocations).toEqual([]);
  });

  it("does not acquire the allocation-registry lock and does not persist anything", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const registryRef = {
      snapshot: { [idFor("/wt", "login")]: 20064 } as RegistrySnapshot,
    };
    let lockCalls = 0;
    const deps: CommandDeps = {
      ...stubDeps({ stack, worktreeRootOverride: "/wt", registryRef }),
      // Sentinel lock that records and rejects any acquire — runEnv must not call it.
      withRegistryLock: () => {
        lockCalls++;
        throw new Error("runEnv must not take the allocation-registry lock");
      },
    };
    const before = { ...registryRef.snapshot };
    const result = await runEnv(deps);
    expect(lockCalls).toBe(0);
    // Persistence is unchanged — the snapshot ref is identical.
    expect(registryRef.snapshot).toEqual(before);
    expect(result.env.WEB_PORT).toBe("20064");
  });

  it("works when the worktree instance is not running (no control socket on disk)", async () => {
    // A fresh anchor with no run/ dir means no instance has ever come up.
    // runEnv must still produce the would-be injected values.
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    // Empty registry — runEnv computes the would-be block without writing.
    // Pin the worktree root so both calls derive the identical worktree id.
    const result = await runEnv(
      stubDeps({ stack, worktreeRootOverride: "/wt", initialRegistry: {} }),
    );
    // The would-be allocation is deterministic; we don't pin the exact number
    // but it must be in the default block range and consistent across calls.
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(20000);
    expect(result.env.DEVTREES_WORKTREE_ID).toBe(idFor("/wt", "login"));

    const again = await runEnv(
      stubDeps({ stack, worktreeRootOverride: "/wt", initialRegistry: {} }),
    );
    expect(again.env.WEB_PORT).toBe(result.env.WEB_PORT);
  });

  it("omits shared ports when the stack declares no shared services", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const loginId = idFor("/wt", "login");
    const result = await runEnv(
      stubDeps({ stack, worktreeRootOverride: "/wt", initialRegistry: { [loginId]: 20000 } }),
    );
    expect(result.env.WEB_PORT).toBe("20000");
    expect(result.env.DEVTREES_WORKTREE_ID).toBe(loginId);
    expect(result.env).not.toHaveProperty("DB_PORT");
  });
});

/**
 * `runLogs` — stream a service's logs without locking (#33).
 *
 * Driver-level streaming is unit-tested in driver.test.ts; here we pin the
 * orchestration: anchor + socket selection, --shared dispatch, --all
 * enumeration from the derived config, missing-socket failure, and the
 * lock-free promise.
 */

interface LogsInvocation {
  args: ReadonlyArray<string>;
  socket: string;
  service: string;
}

/**
 * Stub spawner that records every `process logs` invocation and returns a
 * fake child that emits the canned lines for that service on stdout, then
 * exits 0. Tests assert on `invocations` and on the collected `LogEvent`s.
 */
function makeLogsSpawner(
  invocations: LogsInvocation[],
  linesPerService: Readonly<Record<string, ReadonlyArray<string>>>,
) {
  return (_binary: string, args: ReadonlyArray<string>, _options: unknown): SpawnedProcess => {
    const service = args[2] ?? "";
    const ui = args.indexOf("-u");
    const socket = ui >= 0 ? (args[ui + 1] ?? "") : "";
    invocations.push({ args, socket, service });

    const lines = linesPerService[service] ?? [];
    const stdout = Readable.from(lines.map((l) => `${l}\n`).join(""));
    const stderr = Readable.from("");
    const emitter = new EventEmitter();
    stdout.on("end", () => queueMicrotask(() => emitter.emit("exit", 0)));

    return {
      stdout,
      stderr,
      on(event: "error" | "exit", cb: (arg: never) => void): void {
        emitter.on(event, cb as (...args: unknown[]) => void);
      },
      kill: () => {
        stdout.destroy();
        return true;
      },
    };
  };
}

/** Build a CommandDeps for runLogs tests — no allocator/lock plumbing needed. */
function logsDeps(opts: {
  anchor: string;
  worktreeRoot: string;
  worktreeId: string;
  invocations: LogsInvocation[];
  linesPerService: Readonly<Record<string, ReadonlyArray<string>>>;
}): CommandDeps {
  const git = (args: ReadonlyArray<string>): string => {
    const flag = args[1];
    if (flag === "--git-common-dir") return opts.anchor;
    if (flag === "--show-toplevel") return join(opts.worktreeRoot, opts.worktreeId);
    if (flag === "--is-bare-repository") return "false";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  return {
    cwd: join(opts.worktreeRoot, opts.worktreeId),
    git,
    driver: {
      exists: () => Promise.resolve(true),
      spawner: makeLogsSpawner(opts.invocations, opts.linesPerService),
    },
  };
}

async function collectLogs(
  it: AsyncIterable<{
    service: string;
    line: string;
    ts: string;
    stream: string;
  }>,
): Promise<Array<{ service: string; line: string }>> {
  const out: Array<{ service: string; line: string }> = [];
  for await (const ev of it) out.push({ service: ev.service, line: ev.line });
  return out;
}

/** Write a minimal derived config to the anchor so --all enumeration works. */
function writeDerivedConfig(
  anchor: string,
  fileStem: string,
  services: ReadonlyArray<string>,
): string {
  const dir = join(anchor, "devtrees");
  mkdirSync(dir, { recursive: true });
  const processes: Record<string, { command: string }> = {};
  for (const s of services) processes[s] = { command: "sleep 1" };
  const path = join(dir, `${fileStem}.yaml`);
  writeFileSync(path, stringifyYaml({ processes }));
  return path;
}

/** Touch the control socket file so existence checks pass. */
function touchSocket(anchor: string, fileStem: string): string {
  const dir = runDir(anchor);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fileStem}.sock`);
  writeFileSync(path, "");
  return path;
}

describe("runLogs — stream service logs without locking", () => {
  it("streams the worktree instance's named service from its socket", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const stem = idFor(tmp.worktreeRoot, worktreeId);
    const socketPath = touchSocket(tmp.anchor, stem);
    writeDerivedConfig(tmp.anchor, stem, ["web", "worker"]);

    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId,
      invocations,
      linesPerService: { web: ["hello", "world"] },
    });

    const result = await runLogs(deps, { service: "web" });
    expect(result.services).toEqual(["web"]);
    const events = await collectLogs(result.events);
    expect(events).toEqual([
      { service: "web", line: "hello" },
      { service: "web", line: "world" },
    ]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.socket).toBe(socketPath);
    expect(invocations[0]?.service).toBe("web");
  });

  it("streams the shared instance with { shared: true } (different socket)", async () => {
    const tmp = tmpAnchor();
    const sharedSocket = touchSocket(tmp.anchor, "shared");
    writeDerivedConfig(tmp.anchor, "shared", ["postgres"]);

    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      invocations,
      linesPerService: { postgres: ["ready to accept connections"] },
    });

    const result = await runLogs(deps, { service: "postgres", shared: true });
    const events = await collectLogs(result.events);
    expect(events).toEqual([{ service: "postgres", line: "ready to accept connections" }]);
    expect(invocations[0]?.socket).toBe(sharedSocket);
  });

  it("throws a clear error when the worktree control socket is missing (→ INSTANCE_NOT_FOUND)", async () => {
    const tmp = tmpAnchor();
    // No socket file written.
    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      invocations,
      linesPerService: {},
    });
    await expect(runLogs(deps, { service: "web" })).rejects.toThrow(/no worktree instance.*login/);
    expect(invocations).toEqual([]);
  });

  it("throws when --shared is set and the shared socket is missing", async () => {
    const tmp = tmpAnchor();
    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      invocations,
      linesPerService: {},
    });
    await expect(runLogs(deps, { service: "postgres", shared: true })).rejects.toThrow(
      /no shared instance is running/,
    );
    expect(invocations).toEqual([]);
  });

  it("rejects an unknown service with SERVICE_NOT_FOUND before spawning anything (#109)", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const stem = idFor(tmp.worktreeRoot, worktreeId);
    touchSocket(tmp.anchor, stem);
    writeDerivedConfig(tmp.anchor, stem, ["web", "worker"]);

    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId,
      invocations,
      linesPerService: {},
    });

    const err = (await runLogs(deps, { service: "nosuchservice" }).then(
      () => undefined,
      (e: unknown) => e,
    )) as (Error & { code?: string; details?: Record<string, unknown> }) | undefined;
    expect(err).toBeInstanceOf(Error);
    expect(err?.code).toBe("SERVICE_NOT_FOUND");
    // The message names the unknown service and lists the valid ones.
    expect(err?.message).toContain("nosuchservice");
    expect(err?.message).toContain("web");
    expect(err?.message).toContain("worker");
    expect(err?.details).toEqual({
      service: "nosuchservice",
      valid_services: ["web", "worker"],
    });
    // Fail-fast: no `process logs` subprocess may have been spawned.
    expect(invocations).toEqual([]);
  });

  it("rejects an unknown service on the shared instance the same way (#109)", async () => {
    const tmp = tmpAnchor();
    touchSocket(tmp.anchor, "shared");
    writeDerivedConfig(tmp.anchor, "shared", ["postgres"]);

    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "login",
      invocations,
      linesPerService: {},
    });

    const err = (await runLogs(deps, { service: "web", shared: true }).then(
      () => undefined,
      (e: unknown) => e,
    )) as (Error & { code?: string; details?: Record<string, unknown> }) | undefined;
    expect(err).toBeInstanceOf(Error);
    expect(err?.code).toBe("SERVICE_NOT_FOUND");
    expect(err?.message).toContain("web");
    expect(err?.message).toContain("postgres");
    expect(err?.details).toEqual({ service: "web", valid_services: ["postgres"] });
    expect(invocations).toEqual([]);
  });

  it("with { all: true }, enumerates services from the derived config and interleaves them", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const stem = idFor(tmp.worktreeRoot, worktreeId);
    touchSocket(tmp.anchor, stem);
    writeDerivedConfig(tmp.anchor, stem, ["web", "worker"]);

    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId,
      invocations,
      linesPerService: { web: ["w1", "w2"], worker: ["k1"] },
    });

    const result = await runLogs(deps, { all: true });
    expect([...result.services].sort()).toEqual(["web", "worker"]);
    const events = await collectLogs(result.events);
    // Both services must appear; order is not guaranteed (real interleave).
    expect(events.map((e) => e.line).sort()).toEqual(["k1", "w1", "w2"]);
    // One subprocess per service.
    expect(invocations.map((i) => i.service).sort()).toEqual(["web", "worker"]);
  });

  it("forwards follow and tail to the driver's argv", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const stem = idFor(tmp.worktreeRoot, worktreeId);
    touchSocket(tmp.anchor, stem);
    writeDerivedConfig(tmp.anchor, stem, ["web"]);

    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId,
      invocations,
      linesPerService: { web: ["a"] },
    });
    const result = await runLogs(deps, { service: "web", follow: true, tail: 10 });
    // Drain so the spawn happens.
    await collectLogs(result.events);
    const args = invocations[0]?.args ?? [];
    expect(args).toContain("-f");
    const ni = args.indexOf("-n");
    expect(ni).toBeGreaterThan(-1);
    expect(args[ni + 1]).toBe("10");
  });

  it("does not take the allocation-registry lock (lock-free path)", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const stem = idFor(tmp.worktreeRoot, worktreeId);
    touchSocket(tmp.anchor, stem);
    writeDerivedConfig(tmp.anchor, stem, ["web"]);

    const invocations: LogsInvocation[] = [];
    let lockCalls = 0;
    const deps: CommandDeps = {
      ...logsDeps({
        anchor: tmp.anchor,
        worktreeRoot: tmp.worktreeRoot,
        worktreeId,
        invocations,
        linesPerService: { web: ["a"] },
      }),
      withRegistryLock: () => {
        lockCalls++;
        throw new Error("runLogs must not take the allocation-registry lock");
      },
    };
    const result = await runLogs(deps, { service: "web" });
    await collectLogs(result.events);
    expect(lockCalls).toBe(0);
  });
});

/**
 * `--since` — issue #88: client-side filtering on `LogEvent.ts`.
 *
 * The driver stamps each event when the line is read, so the cutoff
 * comparison itself is pinned on the pure generator with fabricated
 * timestamps; `runLogs` tests pin the wiring (fresh events survive a wide
 * window) and the validation contract (a malformed window rejects before any
 * subprocess is spawned).
 */
describe("filterLogEventsSince — drop events older than the cutoff (#88)", () => {
  function event(ts: string, line: string): LogEvent {
    return { ts, service: "web", stream: "stdout", line };
  }

  async function* fromArray(events: ReadonlyArray<LogEvent>): AsyncIterable<LogEvent> {
    for (const ev of events) yield ev;
  }

  async function lines(it: AsyncIterable<LogEvent>): Promise<string[]> {
    const out: string[] = [];
    for await (const ev of it) out.push(ev.line);
    return out;
  }

  it("drops events with ts strictly older than the cutoff and keeps the rest", async () => {
    const cutoff = Date.parse("2026-06-11T12:00:00.000Z");
    const events = [
      event("2026-06-11T11:59:59.999Z", "old"),
      event("2026-06-11T12:00:00.000Z", "at-cutoff"),
      event("2026-06-11T12:00:01.000Z", "fresh"),
    ];
    await expect(lines(filterLogEventsSince(fromArray(events), cutoff))).resolves.toEqual([
      "at-cutoff",
      "fresh",
    ]);
  });

  it("keeps events whose ts does not parse (never silently swallow lines)", async () => {
    const cutoff = Date.parse("2026-06-11T12:00:00.000Z");
    const events = [event("not-a-timestamp", "weird"), event("2026-06-11T12:00:01.000Z", "ok")];
    await expect(lines(filterLogEventsSince(fromArray(events), cutoff))).resolves.toEqual([
      "weird",
      "ok",
    ]);
  });

  it("preserves event order and passes everything through when all are fresh", async () => {
    const cutoff = Date.parse("2026-06-11T12:00:00.000Z");
    const events = [event("2026-06-11T12:00:01.000Z", "a"), event("2026-06-11T12:00:02.000Z", "b")];
    await expect(lines(filterLogEventsSince(fromArray(events), cutoff))).resolves.toEqual([
      "a",
      "b",
    ]);
  });
});

describe("runLogs — --since window (#88)", () => {
  it("streams fresh events unchanged when the window is wide (sinceMs wiring)", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const stem = idFor(tmp.worktreeRoot, worktreeId);
    touchSocket(tmp.anchor, stem);
    writeDerivedConfig(tmp.anchor, stem, ["web"]);

    const invocations: LogsInvocation[] = [];
    const deps = logsDeps({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId,
      invocations,
      linesPerService: { web: ["hello", "world"] },
    });

    // Events are stamped at read time (now), so a 1h window keeps them all.
    const result = await runLogs(deps, { service: "web", sinceMs: 3_600_000 });
    const events = await collectLogs(result.events);
    expect(events).toEqual([
      { service: "web", line: "hello" },
      { service: "web", line: "world" },
    ]);
  });

  it("rejects a non-finite or negative sinceMs before spawning anything", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const stem = idFor(tmp.worktreeRoot, worktreeId);
    touchSocket(tmp.anchor, stem);
    writeDerivedConfig(tmp.anchor, stem, ["web"]);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5_000]) {
      const invocations: LogsInvocation[] = [];
      const deps = logsDeps({
        anchor: tmp.anchor,
        worktreeRoot: tmp.worktreeRoot,
        worktreeId,
        invocations,
        linesPerService: { web: ["a"] },
      });
      await expect(runLogs(deps, { service: "web", sinceMs: bad })).rejects.toThrow(/since/);
      expect(invocations).toHaveLength(0);
    }
  });
});

/**
 * `runUp` — issue #31: idempotency + drift detection. A second `up` is a
 * defensive primitive: an agent that wants to ensure the stack is up can
 * call `up` regardless of whether it already is. The branch outcomes are:
 *
 *  - **Same config, already running** → noop. Re-emit the state envelope
 *    `up --json` would, but skip `driver.up` and skip any registry write.
 *  - **Drifted config, reload succeeds** → emit the new state envelope and
 *    update the stored hash.
 *  - **Drifted config, reload fails** → throw `CONFIG_DRIFT`; the instance
 *    keeps running unchanged so the agent can inspect it.
 */
describe("runUp — idempotency + drift detection (#31)", () => {
  const stackA: ResolvedStack = { services: [isolated("web", "node a.js", ["WEB_PORT"])] };
  const stackB: ResolvedStack = { services: [isolated("web", "node b.js", ["WEB_PORT"])] };

  function hashStore() {
    const store: Record<string, Record<string, string>> = {};
    return {
      read: (anchor: string, id: string): string | undefined => store[anchor]?.[id],
      write: (anchor: string, id: string, hash: string): void => {
        store[anchor] ??= {};
        store[anchor][id] = hash;
      },
      raw: store,
    };
  }

  /**
   * `stubDeps` whose instance reports `web` running. The drift path reads the
   * project before reloading (#191), and the stub spawner's empty `process
   * list` would look like a reload still pending.
   */
  function liveStubDeps(opts: Parameters<typeof stubDeps>[0]): StubbedDeps {
    return {
      ...stubDeps(opts),
      getServiceStatuses: async () => [
        { name: "web", status: "Running", health: "ready", pid: 4242 },
      ],
    };
  }

  it("writes the stack hash to the hash store after a successful first up", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const hashes = hashStore();
    const base = stubDeps({ stack: stackA, track });
    const deps: CommandDeps = {
      ...base,
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };
    await runUp(deps);
    // The anchor key in the store is whatever the deps reported; with one
    // worktree it is the only key.
    const anchorEntries = Object.values(hashes.raw);
    expect(anchorEntries).toHaveLength(1);
    const entry = anchorEntries[0];
    if (!entry) throw new Error("expected one anchor entry");
    expect(entry[base.expectedWorktreeId]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second up against a running instance with unchanged config is a noop: returns the envelope, no driver.up, no registry write", async () => {
    // The stub spawner pre-creates the socket on the first up, so `existsSync`
    // sees the instance as running for the second call.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();
    const registryRef = { snapshot: {} as RegistrySnapshot };
    let writeCalls = 0;
    const deps: CommandDeps = {
      ...stubDeps({ stack: stackA, track, registryRef }),
      readStoredHash: hashes.read,
      writeStoredHash: (anchor, id, h) => {
        writeCalls++;
        hashes.write(anchor, id, h);
      },
    };

    const first = await runUp(deps);
    const firstWriteCount = writeCalls;
    const firstUpInvocations = track.invocations.filter(
      (i) => !i.socketPath.endsWith("shared.sock"),
    ).length;

    const second = await runUp(deps);

    // Same envelope shape.
    expect(second.env).toEqual(first.env);
    expect(second.blockBase).toBe(first.blockBase);
    // No additional driver.up spawn.
    const secondUpInvocations = track.invocations.filter(
      (i) => !i.socketPath.endsWith("shared.sock"),
    ).length;
    expect(secondUpInvocations).toBe(firstUpInvocations);
    // No additional hash store write.
    expect(writeCalls).toBe(firstWriteCount);
  });

  it("noop path populates services[] from getServiceStatuses against the running instance", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();
    let firstCall = true;
    const deps: CommandDeps = {
      ...stubDeps({ stack: stackA, track }),
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
      getServiceStatuses: async () => {
        // First call (in initial up) returns ready; second call (noop) returns the same.
        return [
          {
            name: "web",
            status: "Running",
            health: firstCall ? "ready" : ((firstCall = false), "ready"),
          },
        ];
      },
    };
    await runUp(deps);
    firstCall = false;
    const second = await runUp(deps);
    expect(second.services).toEqual([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: second.blockBase } },
    ]);
  });

  it("on drift, calls driver.reloadConfig and on success returns the new envelope + updates the stored hash", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();

    // Seed the hash store with the OLD stack's hash so the second up sees drift.
    const baseDeps = liveStubDeps({ stack: stackA, track });
    const reloadCalls: ControlRequest[] = [];
    const controlRequest = reloadAnswering(200, reloadCalls);
    const firstDeps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const upInvocationsAfterFirst = track.invocations.length;

    // Now swap to a different stack — same worktree/anchor/registry deps —
    // so the second up sees drift relative to the stored hash.
    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => stackB };
    const result = await runUp(secondDeps);

    expect(reloadCalls).toHaveLength(1);
    // The reload asks the worktree's own instance to re-read its config
    // server-side, never via `project update` (#194).
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    expect(reloadCalls[0]).toMatchObject({
      socketPath: worktreeSpawn?.socketPath,
      method: "POST",
      path: "/project/configuration",
    });
    // Driver.up was NOT called a second time — reload, not restart.
    expect(track.invocations.length).toBe(upInvocationsAfterFirst);
    // Envelope is well-formed.
    expect(result.env.WEB_PORT).toBeDefined();
    // Stored hash was updated to the new stack's hash.
    const anchorStore = Object.values(hashes.raw)[0];
    if (!anchorStore) throw new Error("expected hash store entry");
    const { stackHash } = await import("./hash.js");
    expect(anchorStore[baseDeps.expectedWorktreeId]).toBe(stackHash(stackB));
  });

  it("a probe-only edit triggers the drift/reload path on the next up (#86)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();

    const baseDeps = liveStubDeps({ stack: stackA, track });
    const reloadCalls: ControlRequest[] = [];
    const controlRequest = reloadAnswering(200, reloadCalls);
    const firstDeps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const upInvocationsAfterFirst = track.invocations.length;

    // Same stack except a readiness_probe was added — previously a silent
    // no-op because the hash omitted passthrough blocks.
    const probed: ResolvedStack = {
      services: [
        {
          ...isolated("web", "node a.js", ["WEB_PORT"]),
          readinessProbe: { http_get: { path: "/health" } },
        },
      ],
    };
    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => probed };
    const result = await runUp(secondDeps);

    // Drift was detected: reload ran instead of the noop branch.
    expect(reloadCalls).toHaveLength(1);
    expect(track.invocations.length).toBe(upInvocationsAfterFirst);
    expect(result.env.WEB_PORT).toBeDefined();
    // Stored hash now reflects the probed stack.
    const anchorStore = Object.values(hashes.raw)[0];
    if (!anchorStore) throw new Error("expected hash store entry");
    const { stackHash } = await import("./hash.js");
    expect(anchorStore[baseDeps.expectedWorktreeId]).toBe(stackHash(probed));
  });

  it("a namespace-only edit triggers the drift/reload path on the next up (#175)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();
    const baseDeps = liveStubDeps({ stack: stackA, track });
    const reloadCalls: ControlRequest[] = [];
    const controlRequest = reloadAnswering(200, reloadCalls);
    const firstDeps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };
    await runUp(firstDeps);
    const upInvocationsAfterFirst = track.invocations.length;

    const moved: ResolvedStack = {
      services: [{ ...isolated("web", "node a.js", ["WEB_PORT"]), namespace: "backend" }],
    };
    await runUp({ ...firstDeps, readStack: () => moved });

    expect(reloadCalls).toHaveLength(1);
    expect(track.invocations.length).toBe(upInvocationsAfterFirst);
    const anchorStore = Object.values(hashes.raw)[0];
    if (!anchorStore) throw new Error("expected hash store entry");
    const { stackHash } = await import("./hash.js");
    expect(anchorStore[baseDeps.expectedWorktreeId]).toBe(stackHash(moved));
  });

  it("on drift, if driver.reloadConfig reports not_supported, throws an Error tagged code:CONFIG_DRIFT and does not update the stored hash", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();

    const baseDeps = liveStubDeps({ stack: stackA, track });
    // The reload route answers 404 → driver classifies as not_supported.
    const controlRequest = reloadAnswering(404);
    const firstDeps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const storedAfterFirst = Object.values(hashes.raw)[0]?.[baseDeps.expectedWorktreeId];
    if (storedAfterFirst === undefined) throw new Error("expected a stored hash after first up");

    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => stackB };
    const err = await runUp(secondDeps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("CONFIG_DRIFT");
    // A refused reload stays distinguishable from a timed-out one.
    expect((err as Error & { details?: unknown }).details).toEqual({ reason: "not_supported" });

    // Hash store unchanged — the stored hash still reflects stackA.
    expect(Object.values(hashes.raw)[0]?.[baseDeps.expectedWorktreeId]).toBe(storedAfterFirst);
  });

  it("on failed reload, the on-disk derived config is restored to match the running instance (#92)", async () => {
    // The drift path used to write the new config before attempting the
    // reload; on failure the on-disk config no longer matched the running
    // instance, so `ls` (which reads ports from the derived config) reported
    // ports that were never bound.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();

    const baseDeps = liveStubDeps({ stack: stackA, track });
    // process-compose refuses the reload → reloadConfig reports failure.
    const controlRequest = reloadAnswering(400);
    const firstDeps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    if (worktreeSpawn === undefined) throw new Error("expected a worktree spawn");
    const configBefore = readFileSync(worktreeSpawn.configPath, "utf8");

    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => stackB };
    await expect(runUp(secondDeps)).rejects.toThrow(/drift/i);

    // The on-disk derived config still describes what the instance is
    // actually running (stackA), byte-for-byte.
    expect(readFileSync(worktreeSpawn.configPath, "utf8")).toBe(configBefore);
    const parsed = parseYaml(readFileSync(worktreeSpawn.configPath, "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(parsed.processes.web?.command).toBe("node a.js");
  });

  it("on drift, a reload that never answers is bounded: CONFIG_DRIFT, request aborted, config restored, hash invalidated (#191)", async () => {
    // process-compose's config reload blocks until each changed process's old
    // incarnation exits. When it never exits (a shutdown.command that does not stop
    // it, or SIGTERM ignored with no shutdown.timeout_seconds), `up` used to hang.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();
    const baseDeps = liveStubDeps({ stack: stackA, track });
    const aborted: boolean[] = [];
    const controlRequest: ControlRequester = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(true);
          reject(new Error("aborted"));
        });
      });
    const firstDeps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest, reloadTimeoutMs: 50 },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    if (worktreeSpawn === undefined) throw new Error("expected a worktree spawn");
    const configBefore = readFileSync(worktreeSpawn.configPath, "utf8");
    const storedBefore = Object.values(hashes.raw)[0]?.[baseDeps.expectedWorktreeId];
    expect(storedBefore).toMatch(/^[0-9a-f]{64}$/);

    const err = await runUp({ ...firstDeps, readStack: () => stackB }).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("CONFIG_DRIFT");
    expect((err as Error & { details?: unknown }).details).toEqual({ reason: "timeout" });
    expect(err.message).toMatch(/did not finish within/);
    expect(err.message).toMatch(/refuses with `reload_pending`/);
    expect(err.message).toMatch(/shutdown\.command/);
    expect(aborted).toEqual([true]);
    expect(readFileSync(worktreeSpawn.configPath, "utf8")).toBe(configBefore);
    // Neither the old hash nor the new one: process-compose is still applying
    // the new config, so the next `up` must see drift once that converges.
    const storedAfter = Object.values(hashes.raw)[0]?.[baseDeps.expectedWorktreeId];
    expect(storedAfter).not.toBe(storedBefore);
    expect(storedAfter).not.toBe(stackHash(stackB));
  });

  it("on successful reload, the new derived config is on disk (#92)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();

    const baseDeps = liveStubDeps({ stack: stackA, track });
    const controlRequest = reloadAnswering(200);
    const firstDeps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const worktreeSpawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
    if (worktreeSpawn === undefined) throw new Error("expected a worktree spawn");

    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => stackB };
    await runUp(secondDeps);

    const parsed = parseYaml(readFileSync(worktreeSpawn.configPath, "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(parsed.processes.web?.command).toBe("node b.js");
  });

  it("noop path does NOT call driver.reloadConfig (no process-compose churn when the config matches)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const hashes = hashStore();
    const baseDeps = liveStubDeps({ stack: stackA, track });
    const reloadCalls: ControlRequest[] = [];
    const controlRequest = reloadAnswering(200, reloadCalls);
    const deps: CommandDeps = {
      ...baseDeps,
      driver: { ...baseDeps.driver, controlRequest },
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };
    await runUp(deps);
    await runUp(deps);
    expect(reloadCalls).toHaveLength(0);
  });
});

/**
 * A reload whose old process never stops leaves process-compose applying it
 * after `up` gave up; reloading again in that window starts an untracked
 * second copy (#191). `up` refuses with `CONFIG_DRIFT` / `reload_pending`
 * until the pending update has converged.
 */
describe("runUp — pending-reload guard (#191)", () => {
  const row = (name: string, pid: number): ServiceStatus => ({
    name,
    status: "Running",
    health: "ready",
    pid,
  });
  type Svc = ReturnType<typeof isolated> & { namespace?: string | string[] };
  const svc = (name: string, command: string, namespace?: string | string[]): Svc => ({
    ...isolated(name, command),
    ...(namespace !== undefined ? { namespace } : {}),
  });
  const stackA: ResolvedStack = {
    services: [svc("web", "node a.js"), svc("api", "node api.js")],
  };
  const stackB: ResolvedStack = {
    services: [svc("web", "node b.js"), svc("api", "node api.js")],
  };

  /**
   * A live instance whose project (`rows`), live PIDs and reload behaviour
   * the test drives. `reload: "hang"` never answers, like process-compose
   * waiting on an old process that will not stop.
   */
  function fixture(stack: ResolvedStack = stackA, rows: ServiceStatus[] = []) {
    const state = {
      stack,
      rows,
      alive: new Set(rows.flatMap((r) => (r.pid !== undefined ? [r.pid] : []))),
      reload: 200 as 200 | "hang",
      reloads: 0,
      /** What process-compose does once devtrees SIGKILLs `pid`. */
      onKill: undefined as ((pid: number) => void) | undefined,
      /** What process-compose does when a reload request arrives. */
      onReload: undefined as (() => void) | undefined,
    };
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const base = stubDeps({ stack, track });
    const controlRequest: ControlRequester = ({ signal }) => {
      state.reloads++;
      state.onReload?.();
      if (state.reload === 200) return Promise.resolve({ status: 200, body: "{}" });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const worktreeSpawn = () => {
      const spawn = track.invocations.find((i) => !i.socketPath.endsWith("/shared.sock"));
      if (spawn === undefined) throw new Error("expected a worktree spawn");
      return spawn;
    };
    // `ps`: the instance's process-compose (pid 9) and each live pid as its
    // child, so a timed-out reload can record the old runs' identity (#206).
    const readProcessTable = async () => [
      { pid: 9, ppid: 1, pgid: 9, command: `process-compose up -u ${worktreeSpawn().socketPath}` },
      ...[...state.alive].map((pid) => ({ pid, ppid: 9, pgid: pid, command: `cmd-${pid}` })),
    ];
    // `process list`, as the bounded `down` reads it through the driver.
    const spawner: NonNullable<CommandDeps["driver"]>["spawner"] = (binary, args, options) => {
      if (args[0] !== "process" || args[1] !== "list") {
        // `process-compose down` stops every service it lists (#155: the
        // tree sweep after it then has nothing left to kill).
        if (args[0] === "down") for (const r of state.rows) if (r.pid) state.alive.delete(r.pid);
        return base.driver?.spawner?.(binary, args, options) ?? spawnedOk();
      }
      const emitter = new EventEmitter() as EventEmitter & { stdout: Readable };
      const listed = state.rows.map((r) => ({ ...r, is_ready: "-", is_running: true }));
      emitter.stdout = Readable.from([JSON.stringify(listed)]);
      emitter.stdout.on("end", () => queueMicrotask(() => emitter.emit("exit", 0)));
      return emitter as unknown as SpawnedProcess;
    };
    const deps: CommandDeps = {
      ...base,
      readStack: () => state.stack,
      driver: { ...base.driver, spawner, controlRequest, reloadTimeoutMs: 50 },
      getServiceStatuses: async () => state.rows,
      isProcessAlive: (pid) => state.alive.has(pid),
      // Never the real `process.kill`: a SIGKILL drops the pid from the fake table.
      stop: {
        readProcessTable,
        kill: (target) => {
          state.alive.delete(Math.abs(target));
          state.onKill?.(Math.abs(target));
        },
        // process-compose (pid 9) stays up throughout.
        isAlive: (pid) => pid === 9 || state.alive.has(pid),
        settleMs: 20,
        pollMs: 2,
        stuckGraceMs: 0,
      },
    };
    const where = (): { anchor: string; id: string } => {
      const spawn = worktreeSpawn();
      return { anchor: dirname(dirname(spawn.configPath)), id: base.expectedWorktreeId };
    };
    const marker = (): PendingReload | undefined => {
      const { anchor, id } = where();
      return readPendingReload(anchor, id);
    };
    return { state, deps, marker, where };
  }

  async function upError(deps: CommandDeps): Promise<Error & { code?: string; details?: unknown }> {
    return runUp(deps).then(
      () => {
        throw new Error("expected runUp to reject");
      },
      (e: unknown) => e as Error & { code?: string; details?: unknown },
    );
  }

  it("timeout -> retry refused -> recovery succeeds: the marker is set, holds, then clears", async () => {
    const { state, deps, marker } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);

    state.stack = stackB;
    state.reload = "hang";
    const timedOut = await upError(deps);
    expect(timedOut.details).toEqual({ reason: "timeout" });
    expect(marker()).toEqual({
      services: ["web"],
      oldRuns: [{ name: "web", pid: 100, identity: { ppid: 9, pgid: 100, command: "cmd-100" } }],
    });

    // process-compose dropped `web` and is waiting for pid 100 to exit.
    state.rows = [row("api", 200)];
    const retry = await upError(deps);
    expect(retry.code).toBe("CONFIG_DRIFT");
    expect(retry.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [100] });
    expect(retry.message).toMatch(/kill 100/);
    expect(state.reloads).toBe(1);

    // The old process exited, but the pending update has not started the
    // new one yet: still pending, now without a PID to kill.
    state.alive.delete(100);
    const between = await upError(deps);
    expect(between.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [] });
    expect(state.reloads).toBe(1);

    // The pending update finished: `up` resyncs and the marker is gone.
    state.rows = [row("web", 101), row("api", 200)];
    state.alive.add(101);
    state.reload = 200;
    await runUp(deps);
    expect(state.reloads).toBe(2);
    expect(marker()).toBeUndefined();
  });

  it("reverting devtrees.yaml mid-reload: refused while pending, then the reverted config is re-applied", async () => {
    const { state, deps, marker, where } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    await upError(deps);
    // Reverting devtrees.yaml does not stop process-compose applying stackB.
    state.stack = stackA;
    state.rows = [row("api", 200)];
    const err = await upError(deps);
    expect(err.details).toMatchObject({ reason: "reload_pending", services: ["web"] });
    expect(marker()).toBeDefined();

    // The old process exits and process-compose finishes applying stackB.
    // devtrees.yaml, the derived config and (before #191's fix) the stored
    // hash all said stackA, so `up` used to see no drift and leave B running.
    state.alive.delete(100);
    state.rows = [row("web", 101), row("api", 200)];
    state.alive.add(101);
    state.reload = 200;
    await runUp(deps);
    expect(state.reloads).toBe(2);
    expect(marker()).toBeUndefined();
    const { anchor, id } = where();
    const onDisk = parseYaml(readFileSync(join(anchor, "devtrees", `${id}.yaml`), "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(onDisk.processes.web?.command).toBe("node a.js");
    // Converged: the next `up` is a noop.
    await runUp(deps);
    expect(state.reloads).toBe(2);
  });

  it("retries an empty ps read when it records the old runs' identity", async () => {
    const { state, deps, marker } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    let reads = 0;
    const read = deps.stop?.readProcessTable;
    const flaky = async () => (reads++ === 0 || read === undefined ? [] : read());
    await upError({ ...deps, stop: { ...deps.stop, readProcessTable: flaky } });
    expect(reads).toBe(2);
    expect(marker()?.oldRuns).toEqual([
      { name: "web", pid: 100, identity: { ppid: 9, pgid: 100, command: "cmd-100" } },
    ]);
  });

  it("records when an old run was already unlisted at the timeout, for down's grace period (#206)", async () => {
    const { state, deps, marker } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    // process-compose drops `web` as soon as its update begins.
    state.onReload = () => {
      state.rows = [row("api", 200)];
    };
    const before = Date.now();
    await upError(deps);
    const [web] = marker()?.oldRuns ?? [];
    expect(web?.unlistedAt).toBeGreaterThanOrEqual(before);
    expect(web?.unlistedAt).toBeLessThanOrEqual(Date.now());
  });

  it("down kills the stuck old run, waits for the new copy, stops, and clears the marker", async () => {
    const { state, deps, marker } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    await upError(deps);
    expect(marker()).toBeDefined();
    // process-compose dropped `web` and waits on pid 100. Once it dies, the
    // pending update lists `web` again as 101.
    state.rows = [row("api", 200)];
    state.onKill = (pid) => {
      if (pid !== 100) return;
      state.alive.add(101);
      state.rows = [row("web", 101), row("api", 200)];
    };
    const result = await runDown(deps);
    expect(result.forceKilled).toEqual([{ service: "web", pid: 100 }]);
    expect(marker()).toBeUndefined();
  });

  it("down does not stop the instance while the pending update never finishes, and keeps the marker", async () => {
    const { state, deps, marker } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    await upError(deps);
    state.rows = [row("api", 200)];
    const err = await runDown(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    expect(err?.code).toBe("DOWN_TIMEOUT");
    expect(err?.details).toMatchObject({ pending_reload: ["web"], stuck_services: [] });
    expect(marker()).toBeDefined();
  });

  it("a fresh start clears a marker left by an instance that is gone", async () => {
    const { deps, marker, where } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);
    const { anchor, id } = where();
    writePendingReload(anchor, id, { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] });
    // The instance died (stale socket): this `up` starts a new one.
    await runUp({ ...deps, probeSocket: async () => "stale" as const });
    expect(marker()).toBeUndefined();
  });

  it("no marker: a service absent from the project does not block a reload", async () => {
    // Without a marker there is nothing to wait on: the project's shape alone
    // is not evidence (a timed-out rename leaves a stale on-disk config).
    const { state, deps } = fixture(stackA, [row("web", 100), row("api", 200)]);
    await runUp(deps);
    state.rows = [row("api", 200)];
    state.stack = stackB;
    await runUp(deps);
    expect(state.reloads).toBe(1);
  });

  it("a timed-out rename converges: once the old pid exits, up succeeds and the next up is a noop", async () => {
    const before: ResolvedStack = {
      services: [svc("keeper", "node k.js"), svc("web", "node a.js")],
    };
    const { state, deps, marker } = fixture(before, [row("keeper", 50), row("web", 100)]);
    await runUp(deps);
    // Rename web -> web2; the old `web` never stops, so the reload times out.
    state.stack = { services: [svc("keeper", "node k.js"), svc("web2", "node a.js")] };
    state.reload = "hang";
    await upError(deps);
    expect(marker()).toEqual({
      services: [],
      oldRuns: [{ name: "web", pid: 100, identity: { ppid: 9, pgid: 100, command: "cmd-100" } }],
    });

    // Still pending while the old pid lives...
    state.rows = [row("keeper", 50)];
    const pending = await upError(deps);
    expect(pending.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [100] });

    // ...and converged once it exits: process-compose runs keeper + web2. The
    // restored on-disk config still names `web`; that must not read as stuck.
    state.alive.delete(100);
    state.rows = [row("keeper", 50), row("web2", 101)];
    state.alive.add(101);
    state.reload = 200;
    await runUp(deps);
    expect(state.reloads).toBe(2);
    expect(marker()).toBeUndefined();
    await runUp(deps);
    expect(state.reloads).toBe(2);
  });

  it("the no-PID remedy keeps every booted namespace, not just a narrower -n", async () => {
    const wide: ResolvedStack = {
      services: [svc("web", "node a.js", "one"), svc("worker", "node w.js", "two")],
    };
    const { state, deps } = fixture(wide, [row("web", 100), row("worker", 300)]);
    await runUp({ ...deps, namespaces: ["one", "two"] });
    state.stack = {
      services: [svc("web", "node b.js", "one"), svc("worker", "node w.js", "two")],
    };
    state.reload = "hang";
    await upError({ ...deps, namespaces: ["one"] });
    // The old `web` exited; process-compose has not started the new one yet.
    state.alive.delete(100);
    state.rows = [row("worker", 300)];
    const err = await upError({ ...deps, namespaces: ["one"] });
    expect(err.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [] });
    expect(err.message).toContain("`devtrees down && devtrees up -n one -n two`");
  });

  it("an empty-selection instance can no longer exist: `-n nope` is refused before any boot or reload (#203)", async () => {
    // process-compose exits after reloading an empty project, so `up -n nope`
    // never boots one (it used to, #176).
    const { state, deps } = fixture(stackA, []);
    await expect(upError({ ...deps, namespaces: ["nope"] })).resolves.toMatchObject({
      code: "NO_SERVICES_SELECTED",
    });
    expect(state.reloads).toBe(0);
  });

  it("an instance booted through a list-valued namespace reloads normally (#179)", async () => {
    const stack: ResolvedStack = {
      services: [
        svc("db", "node db.js", ["one", "two"]),
        svc("web", "node a.js", "one"),
        svc("worker", "node w.js", "two"),
      ],
    };
    // Booted `-n two`: `db` is present through `two`, `web` (only `one`) is
    // legitimately absent.
    const { state, deps } = fixture(stack, [row("db", 100), row("worker", 300)]);
    await runUp({ ...deps, namespaces: ["two"] });
    state.stack = {
      services: [
        svc("db", "node db.js", ["one", "two"]),
        svc("web", "node a.js", "one"),
        svc("worker", "node w2.js", "two"),
      ],
    };
    await runUp(deps);
    expect(state.reloads).toBe(1);
  });

  it("a namespace-narrowed up on a wider instance reloads normally", async () => {
    const wide: ResolvedStack = {
      services: [svc("web", "node a.js", "one"), svc("worker", "node w.js", "two")],
    };
    const { state, deps } = fixture(wide, [row("web", 100), row("worker", 300)]);
    await runUp({ ...deps, namespaces: ["one", "two"] });
    state.stack = {
      services: [svc("web", "node b.js", "one"), svc("worker", "node w.js", "two")],
    };
    await runUp({ ...deps, namespaces: ["one"] });
    expect(state.reloads).toBe(1);
  });
});

/**
 * `runUp` on an already-running instance verifies it (ADR-0008, issue #177)
 * instead of printing `is up.` because the socket answers: the selection is
 * read back from the project, an unbooted `-n` fails with
 * NAMESPACE_NOT_RUNNING (#170), a dead selected isolated service is
 * restarted and waited on (#162, #178), a dead shared service fails with
 * SHARED_SERVICE_DEAD, and nothing is ever stopped.
 */
describe("runUp — verifying a running instance (ADR-0008, #177)", () => {
  const running = (name: string): ServiceStatus => ({ name, status: "Running", health: "unknown" });
  const killed = (name: string): ServiceStatus => ({
    name,
    status: "Completed",
    health: "unknown",
    exitCode: -1,
  });

  /**
   * Fake a live worktree instance (and a live shared one when the stack has
   * shared services) whose stored hash matches, so `runUp` takes the
   * already-running path with no reload. `rows` is what process-compose
   * reports per socket. The real health wait runs (no `waitForHealth` stub).
   */
  function liveInstance(
    stack: ResolvedStack,
    rows: { worktree: ServiceStatus[]; shared?: ServiceStatus[] },
    extra: Partial<CommandDeps> = {},
  ) {
    const tmp = tmpAnchor();
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const spawned: string[][] = [];
    const base = stubDeps({
      stack,
      track,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
    });
    const inner = base.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");
    const wtSocket = instancePaths(tmp.anchor, base.expectedWorktreeId).socketPath;
    const sharedSocket = sharedInstancePaths(tmp.anchor).socketPath;
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(wtSocket, "");
    if (rows.shared !== undefined) writeFileSync(sharedSocket, "");
    const statusReads: string[] = [];
    const deps: CommandDeps = {
      ...base,
      waitForHealth: undefined,
      readStoredHash: () => stackHash(stack),
      writeStoredHash: () => {},
      getServiceStatuses: async (socketPath) => {
        statusReads.push(socketPath);
        if (socketPath === wtSocket) return rows.worktree;
        if (socketPath === sharedSocket) return rows.shared ?? [];
        throw new Error(`unexpected socket ${socketPath}`);
      },
      driver: {
        ...base.driver,
        spawner: (binary, args, options) => {
          spawned.push([...args]);
          return inner(binary, args, options);
        },
      },
      ...extra,
    };
    return {
      deps,
      spawned,
      statusReads,
      wtSocket,
      sharedSocket,
      id: base.expectedWorktreeId,
      anchor: tmp.anchor,
    };
  }

  async function failure(deps: CommandDeps) {
    return runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
  }

  const twoNamespaces: ResolvedStack = {
    services: [
      { ...isolated("a", "sleep 100000"), namespace: "one" },
      { ...isolated("b", "python3 -m http.server", ["B_PORT"]), namespace: "two" },
    ],
  };

  /** #179: `db` in [one, two], `api` (two) depends on `db`, `web` (one) depends on `api`. */
  const listNamespaces: ResolvedStack = {
    services: [
      { ...isolated("db", "sleep 100000"), namespace: ["one", "two"] },
      { ...isolated("api", "sleep 100000"), namespace: "two", dependsOn: [{ name: "db" }] },
      { ...isolated("web", "sleep 100000"), namespace: "one", dependsOn: [{ name: "api" }] },
    ],
  };

  it("#179: bare up after -n two targets `two` only — `one` is not running although db is present", async () => {
    const waited: string[][] = [];
    const warnings: string[] = [];
    const { deps } = liveInstance(
      listNamespaces,
      { worktree: [running("db"), running("api")] },
      {
        warn: (m) => warnings.push(m),
        waitForHealth: async ({ serviceNames }) => {
          waited.push([...serviceNames]);
        },
      },
    );
    const result = await runUp(deps);
    expect(waited).toEqual([["db", "api"]]);
    expect(result.droppedNamespaceEdges).toEqual([]);
    expect(warnings.filter((w) => /cross-namespace/.test(w))).toEqual([]);
  });

  it("#179: -n one on an instance booted with -n two names only the absent web", async () => {
    const { deps } = liveInstance(listNamespaces, { worktree: [running("db"), running("api")] });
    const err = await failure({ ...deps, namespaces: ["one"] });
    expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err?.details?.["services"]).toEqual(["web"]);
  });

  it("#179: warns about edges the effective (read-back) selection drops on a bare up", async () => {
    // Booted with -n one: web and db present, api absent. web -> api is dropped.
    const warnings: string[] = [];
    const { deps } = liveInstance(
      listNamespaces,
      { worktree: [running("db"), running("web")] },
      { warn: (m) => warnings.push(m), waitForHealth: async () => {} },
    );
    const result = await runUp(deps);
    expect(result.droppedNamespaceEdges).toEqual([
      { from: "web", to: "api", toNamespaces: ["two"] },
    ]);
    const line = warnings.find((w) => /cross-namespace/.test(w));
    expect(line).toContain("'web' -> 'api'");
  });

  it("#203: -n naming only a namespace with no services fails NO_SERVICES_SELECTED, not NAMESPACE_NOT_RUNNING", async () => {
    const { deps, spawned, id } = liveInstance(twoNamespaces, { worktree: [running("a")] });
    const err = await failure({ ...deps, namespaces: ["nope"] });
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
    expect(err?.details).toEqual({
      worktree_id: id,
      selected_namespaces: ["nope"],
      namespaces: ["one", "two"],
    });
    expect(spawned.filter((a) => a[0] !== "process")).toEqual([]);
  });

  it("#203: -n one -n nope on a running instance keeps today's behaviour for the real namespace", async () => {
    const waited: string[][] = [];
    const { deps } = liveInstance(
      twoNamespaces,
      { worktree: [running("a")] },
      {
        waitForHealth: async ({ serviceNames }) => {
          waited.push([...serviceNames]);
        },
      },
    );
    await runUp({ ...deps, namespaces: ["one", "nope"] });
    expect(waited).toEqual([["a"]]);
  });

  it("#170: -n naming a namespace the instance was not booted with fails with NAMESPACE_NOT_RUNNING", async () => {
    const { deps, spawned, id } = liveInstance(twoNamespaces, { worktree: [running("a")] });
    const err = await failure({ ...deps, namespaces: ["one", "two"] });
    expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err?.message).toContain("'two'");
    expect(err?.message).toContain("devtrees down && devtrees up -n one -n two");
    expect(err?.details).toEqual({
      worktree_id: id,
      namespaces: ["two"],
      services: ["b"],
      remedy: "devtrees down && devtrees up -n one -n two",
    });
    // Nothing was started, stopped or reloaded.
    expect(spawned.filter((a) => a[0] !== "process")).toEqual([]);
  });

  it("bare up on an instance booted with -n one targets `one` only", async () => {
    const waited: string[][] = [];
    const { deps } = liveInstance(
      twoNamespaces,
      { worktree: [running("a")] },
      {
        waitForHealth: async ({ serviceNames }) => {
          waited.push([...serviceNames]);
        },
      },
    );
    const result = await runUp(deps);
    expect(waited).toEqual([["a"]]);
    expect(result.services.map((s) => s.name)).toEqual(["a"]);
  });

  it("a narrower -n than what runs leaves the rest alone and does not fail", async () => {
    const waited: string[][] = [];
    const { deps, spawned } = liveInstance(
      twoNamespaces,
      { worktree: [running("a"), killed("b")] },
      {
        namespaces: ["one"],
        waitForHealth: async ({ serviceNames }) => {
          waited.push([...serviceNames]);
        },
      },
    );
    await expect(runUp(deps)).resolves.toBeDefined();
    // Only `one` is checked — `b` being dead in `two` is not this call's
    // business, so it is not restarted either (#178).
    expect(waited).toEqual([["a"]]);
    expect(spawned.filter((a) => a[0] !== "process")).toEqual([]);
    expect(spawned.filter((a) => a[1] === "start")).toEqual([]);
  });

  describe("restarting dead isolated services (#178)", () => {
    const toyStack: ResolvedStack = {
      services: [
        { ...isolated("toy", "python3 -m http.server", ["TOY_PORT"]), namespace: "test" },
        { ...isolated("keeper", "sleep 100000"), namespace: "test" },
      ],
    };
    const killedWithPid = (name: string, pid: number, exitCode = -1): ServiceStatus => ({
      ...killed(name),
      exitCode,
      pid,
    });
    const starts = (spawned: string[][]) =>
      spawned.filter((a) => a[0] === "process" && a[1] === "start");

    /**
     * Status reads that serve `before` until a `process start` has been
     * spawned, then each entry of `after` in turn (the last one repeats;
     * `before` again when `after` is empty).
     */
    function reads(
      spawned: string[][],
      before: ServiceStatus[],
      after: ServiceStatus[][],
    ): (socketPath: string) => Promise<ServiceStatus[]> {
      let i = 0;
      return async () => {
        if (starts(spawned).length === 0) return before;
        const rows = after[Math.min(i, after.length - 1)] ?? before;
        i += 1;
        return rows;
      };
    }

    it("#162: a killed service is started again over the control socket, then up succeeds", async () => {
      const { deps, spawned, wtSocket } = liveInstance(
        toyStack,
        { worktree: [] },
        { namespaces: ["test"], waitTimeoutMs: 10_000 },
      );
      const result = await runUp({
        ...deps,
        getServiceStatuses: reads(
          spawned,
          [killedWithPid("toy", 41), running("keeper")],
          [[running("toy"), running("keeper")]],
        ),
      });
      expect(starts(spawned)).toEqual([["process", "start", "toy", "-U", "-u", wtSocket]]);
      expect(result.restarted).toEqual(["toy"]);
      // Never stops anything: no `down`, no `up`, no reload.
      expect(spawned.filter((a) => a[0] !== "process")).toEqual([]);
    });

    it("the stale pre-restart row read right after `process start` does not fail-fast", async () => {
      // Same pid as before the restart: still the old corpse, not a new death.
      const stale = [killedWithPid("toy", 41), running("keeper")];
      const { deps, spawned } = liveInstance(
        toyStack,
        { worktree: [] },
        { namespaces: ["test"], waitTimeoutMs: 10_000 },
      );
      const result = await runUp({
        ...deps,
        getServiceStatuses: reads(spawned, stale, [
          stale,
          stale,
          stale,
          [running("toy"), running("keeper")],
        ]),
      });
      expect(result.restarted).toEqual(["toy"]);
    });

    it("a restarted service that dies again (new pid) fails fast with HEALTH_TIMEOUT naming it", async () => {
      const { deps, spawned } = liveInstance(
        toyStack,
        { worktree: [] },
        { namespaces: ["test"], waitTimeoutMs: 60_000 },
      );
      const started = Date.now();
      const err = await failure({
        ...deps,
        getServiceStatuses: reads(
          spawned,
          [killedWithPid("toy", 41), running("keeper")],
          [[killedWithPid("toy", 77, 1), running("keeper")]],
        ),
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(err?.code).toBe("HEALTH_TIMEOUT");
      expect(err?.message).toContain("toy (Completed, exit 1)");
      expect(err?.message).toContain("restarted toy, and it died again");
      expect(err?.message).toContain("devtrees down && devtrees up -n test");
      expect(err?.details).toMatchObject({
        dead_services: [{ name: "toy", status: "Completed", exit_code: 1 }],
      });
      expect(starts(spawned)).toHaveLength(1);
    });

    it("a restarted service that dies again after being read running fails fast too", async () => {
      const { deps, spawned } = liveInstance(
        toyStack,
        { worktree: [] },
        { namespaces: ["test"], waitTimeoutMs: 60_000 },
      );
      const started = Date.now();
      const err = await failure({
        ...deps,
        getServiceStatuses: reads(
          spawned,
          [killed("toy"), running("keeper")],
          [[{ name: "toy", status: "Running", health: "not_ready" }], [killed("toy")]],
        ),
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(err?.code).toBe("HEALTH_TIMEOUT");
      expect(err?.message).toContain("died again");
    });

    it("without pids, a restarted service never read alive is reported dead at the deadline, not before", async () => {
      const { deps, spawned } = liveInstance(
        toyStack,
        { worktree: [] },
        { namespaces: ["test"], waitTimeoutMs: 600 },
      );
      const started = Date.now();
      const err = await failure({
        ...deps,
        getServiceStatuses: reads(spawned, [killed("toy"), running("keeper")], []),
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(550);
      expect(err?.code).toBe("HEALTH_TIMEOUT");
      expect(err?.details).toMatchObject({ dead_services: [{ name: "toy", exit_code: -1 }] });
    });

    it("a restarted probed service that never becomes ready fails HEALTH_TIMEOUT naming only it", async () => {
      const stack: ResolvedStack = {
        services: [
          { ...isolated("toy", "x", ["TOY_PORT"]), readinessProbe: { exec: { command: "x" } } },
          isolated("keeper", "sleep 100000"),
        ],
      };
      const { deps, spawned } = liveInstance(stack, { worktree: [] }, { waitTimeoutMs: 400 });
      const err = await failure({
        ...deps,
        getServiceStatuses: reads(
          spawned,
          [killed("toy"), running("keeper")],
          [[{ name: "toy", status: "Running", health: "not_ready" }, running("keeper")]],
        ),
      });
      expect(err?.code).toBe("HEALTH_TIMEOUT");
      expect(err?.message).toContain("healthy [toy] after 400ms");
      expect(starts(spawned)).toHaveLength(1);
    });

    it("a failing one-shot (non-zero exit) is restarted; an exit-0 one-shot is not", async () => {
      const stack: ResolvedStack = {
        services: [isolated("seed", "x"), isolated("migrate", "true"), isolated("web", "y")],
      };
      const done: ServiceStatus = {
        name: "migrate",
        status: "Completed",
        health: "unknown",
        exitCode: 0,
      };
      const seedDone: ServiceStatus = { ...done, name: "seed" };
      const { deps, spawned } = liveInstance(stack, { worktree: [] });
      const result = await runUp({
        ...deps,
        getServiceStatuses: reads(
          spawned,
          [killedWithPid("seed", 5, 3), done, running("web")],
          [[seedDone, done, running("web")]],
        ),
      });
      expect(starts(spawned).map((a) => a[2])).toEqual(["seed"]);
      expect(result.restarted).toEqual(["seed"]);
    });

    it("a service process-compose is already Restarting is left to its restart policy", async () => {
      const { deps, spawned } = liveInstance(
        toyStack,
        {
          worktree: [
            { name: "toy", status: "Restarting", health: "unknown", exitCode: -1 },
            running("keeper"),
          ],
        },
        { namespaces: ["test"], waitForHealth: async () => {} },
      );
      const result = await runUp(deps);
      expect(starts(spawned)).toEqual([]);
      expect(result.restarted).toEqual([]);
    });

    it("a refused start fails with SERVICE_START_FAILED naming the service and the down + up remedy", async () => {
      const { deps, spawned, id } = liveInstance(
        toyStack,
        { worktree: [killed("toy"), running("keeper")] },
        { namespaces: ["test"] },
      );
      const recording = deps.driver?.spawner;
      if (recording === undefined) throw new Error("expected spawner");
      const err = await failure({
        ...deps,
        driver: {
          ...deps.driver,
          spawner: (binary, args, options) => {
            if (args[0] === "process" && args[1] === "start") {
              spawned.push([...args]);
              return refusedStart('FTL failed to start process toy error="no such process"');
            }
            return recording(binary, args, options);
          },
        },
      });
      expect(err?.code).toBe("SERVICE_START_FAILED");
      expect(err?.message).toContain("toy");
      expect(err?.message).toContain("devtrees down && devtrees up -n test");
      expect(err?.details).toEqual({
        worktree_id: id,
        services: [
          { name: "toy", message: 'FTL failed to start process toy error="no such process"' },
        ],
        remedy: "devtrees down && devtrees up -n test",
      });
      expect(spawned.filter((a) => a[0] !== "process")).toEqual([]);
    });

    it("process-compose refusing because the service is already running is not a failure", async () => {
      const { deps, spawned } = liveInstance(toyStack, { worktree: [] }, { namespaces: ["test"] });
      const recording = deps.driver?.spawner;
      if (recording === undefined) throw new Error("expected spawner");
      const result = await runUp({
        ...deps,
        getServiceStatuses: reads(
          spawned,
          [killed("toy"), running("keeper")],
          [[running("toy"), running("keeper")]],
        ),
        driver: {
          ...deps.driver,
          spawner: (binary, args, options) => {
            if (args[0] === "process" && args[1] === "start") {
              spawned.push([...args]);
              return refusedStart(
                "FTL failed to start process toy: process toy is already running",
              );
            }
            return recording(binary, args, options);
          },
        },
      });
      // Someone else started it: not reported as restarted by this `up`.
      expect(result.restarted).toEqual([]);
      expect(starts(spawned)).toHaveLength(1);
    });

    it("dead services are started in depends_on order, not declaration order", async () => {
      const stack: ResolvedStack = {
        services: [
          { ...isolated("web", "w"), dependsOn: [{ name: "api" }] },
          { ...isolated("api", "a"), dependsOn: [{ name: "db" }, { name: "keeper" }] },
          isolated("db", "d"),
          isolated("keeper", "k"),
        ],
      };
      const { deps, spawned } = liveInstance(stack, { worktree: [] });
      const result = await runUp({
        ...deps,
        getServiceStatuses: reads(
          spawned,
          [killed("web"), killed("api"), killed("db"), running("keeper")],
          [[running("web"), running("api"), running("db"), running("keeper")]],
        ),
      });
      expect(starts(spawned).map((a) => a[2])).toEqual(["db", "api", "web"]);
      expect(result.restarted).toEqual(["db", "api", "web"]);
    });

    it("a `down` holding the lifecycle lock: up starts nothing and fails LOCK_CONTENTION", async () => {
      const { deps, spawned, anchor, id } = liveInstance(
        toyStack,
        { worktree: [killed("toy"), running("keeper")] },
        {
          namespaces: ["test"],
          // Up's own spawn-window lock passes; the restart's lock is held by
          // the "down" below and only retried briefly.
          withLifecycleLock: (a, i, fn) =>
            withLifecycleLock(a, i, fn, { retries: 3, retryDelayMs: 10 }),
        },
      );
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      let down: Promise<void> | undefined;
      const err = await failure({
        ...deps,
        // The first read runs after up's spawn-window lock is released: a
        // `down` takes the lifecycle lock right then, before up's restart.
        getServiceStatuses: async () => {
          if (down === undefined) {
            let acquired: () => void = () => {};
            const isHeld = new Promise<void>((r) => (acquired = r));
            down = withLifecycleLock(anchor, id, async () => {
              acquired();
              await held;
            });
            await isHeld;
          }
          return [killed("toy"), running("keeper")];
        },
      });
      release();
      await down;
      expect(err?.code).toBe("LOCK_CONTENTION");
      expect(starts(spawned)).toEqual([]);
    });

    it("an instance that stopped between the read and the lock: nothing started, INSTANCE_NOT_FOUND", async () => {
      let probes = 0;
      const { deps, spawned, id } = liveInstance(
        toyStack,
        { worktree: [killed("toy"), running("keeper")] },
        {
          namespaces: ["test"],
          // Live for up's own spawn-window gate, gone by the restart's re-probe
          // (a concurrent `down` finished in between).
          probeSocket: async () => (++probes === 1 ? "running" : "stale"),
        },
      );
      const err = await failure(deps);
      expect(err?.code).toBe("INSTANCE_NOT_FOUND");
      expect(err?.message).toContain("Nothing was started");
      expect(err?.details).toEqual({ worktree_id: id });
      expect(starts(spawned)).toEqual([]);
    });

    it("an instance that stops answering before the restart: nothing started, INSTANCE_UNRESPONSIVE, socket kept (#186)", async () => {
      let probes = 0;
      const { deps, spawned, id, wtSocket } = liveInstance(
        toyStack,
        { worktree: [killed("toy"), running("keeper")] },
        {
          namespaces: ["test"],
          probeRetryDelaysMs: [0, 0],
          // Live for up's own gate, then every re-probe under the restart's
          // lock times out: not "gone", so not INSTANCE_NOT_FOUND either.
          probeSocket: async () => (++probes === 1 ? "running" : "unknown"),
        },
      );
      const err = await failure(deps);
      expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
      expect(err?.details).toMatchObject({ instance: id, socket_path: wtSocket, attempts: 3 });
      expect(starts(spawned)).toEqual([]);
      expect(existsSync(wtSocket)).toBe(true);
    });

    it("re-reads under the lock: a service no longer dead there is not started", async () => {
      let readsSoFar = 0;
      const { deps, spawned } = liveInstance(
        toyStack,
        { worktree: [] },
        {
          namespaces: ["test"],
          getServiceStatuses: async () =>
            ++readsSoFar === 1
              ? [killed("toy"), running("keeper")]
              : [running("toy"), running("keeper")],
        },
      );
      const result = await runUp(deps);
      expect(starts(spawned)).toEqual([]);
      expect(result.restarted).toEqual([]);
    });
  });

  it("a completed exit-0 one-shot does not fail up", async () => {
    const stack: ResolvedStack = {
      services: [isolated("migrate", "true"), isolated("web", "node a.js")],
    };
    const { deps } = liveInstance(stack, {
      worktree: [
        { name: "migrate", status: "Completed", health: "unknown", exitCode: 0 },
        running("web"),
      ],
    });
    await expect(runUp(deps)).resolves.toBeDefined();
  });

  it("a probed service that is still coming up is waited on with --wait-timeout", async () => {
    const stack: ResolvedStack = {
      services: [{ ...isolated("web", "node a.js"), readinessProbe: { exec: { command: "x" } } }],
    };
    const { deps } = liveInstance(
      stack,
      { worktree: [{ name: "web", status: "Running", health: "not_ready" }] },
      { waitTimeoutMs: 300 },
    );
    const err = await failure(deps);
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("after 300ms");
  });

  it("a dead shared service fails up with SHARED_SERVICE_DEAD and the down --shared remedy", async () => {
    const stack: ResolvedStack = {
      services: [shared("db", "postgres", ["DB_PORT"]), isolated("web", "node a.js")],
    };
    const { deps, spawned } = liveInstance(stack, {
      worktree: [running("web")],
      shared: [killed("db")],
    });
    const err = await failure(deps);
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.message).toContain("db (Completed, exit -1)");
    expect(err?.details).toEqual({
      dead_services: [{ name: "db", status: "Completed", exit_code: -1 }],
      remedy: "devtrees down --shared && devtrees up",
    });
    // Reported, never restarted (ADR-0008).
    expect(spawned.filter((a) => a[0] !== "process")).toEqual([]);
    expect(spawned.filter((a) => a[1] === "start")).toEqual([]);
  });

  it("a FRESH up against an already-running shared instance with a dead service fails SHARED_SERVICE_DEAD before spawning", async () => {
    // Same check, other path: after `down`, a fresh `up` used to start the
    // worktree over the dead shared service and report `is up`.
    const stack: ResolvedStack = {
      services: [
        shared("db", "postgres", ["DB_PORT"]),
        { ...isolated("web", "node a.js"), namespace: "test" },
      ],
    };
    const { deps, spawned, wtSocket } = liveInstance(
      stack,
      { worktree: [], shared: [killed("db")] },
      { namespaces: ["test"] },
    );
    rmSync(wtSocket, { force: true });
    const err = await failure(deps);
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.details).toMatchObject({ remedy: "devtrees down --shared && devtrees up" });
    // Nothing spawned: neither the worktree instance nor a shared restart.
    expect(spawned.filter((a) => a[0] !== "process")).toEqual([]);
  });

  it("a selection read that keeps failing is HEALTH_TIMEOUT, never a success over an unknown selection", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const { deps } = liveInstance(
      stack,
      { worktree: [] },
      {
        waitTimeoutMs: 300,
        getServiceStatuses: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    );
    await expect(runUp(deps)).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
  });

  it("#192: a status read that keeps failing prints one retry notice through warn", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const warnings: string[] = [];
    const { deps } = liveInstance(
      stack,
      { worktree: [] },
      {
        waitTimeoutMs: 300,
        warn: (m) => warnings.push(m),
        getServiceStatuses: async () => {
          throw new Error("process list did not answer within 5s");
        },
      },
    );
    await expect(runUp(deps)).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
    const notices = warnings.filter((w) => /service status failed/.test(w));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("did not answer within 5s");
  });

  it("#192: a status read that hangs is cut off at the wait budget, not waited on forever", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const { deps } = liveInstance(
      stack,
      { worktree: [] },
      {
        waitTimeoutMs: 150,
        getServiceStatuses: (_socket, opts) =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("wedged")), opts?.timeoutMs);
          }),
      },
    );
    const started = Date.now();
    await expect(runUp(deps)).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a healthy re-up reads the instance once: the selection read is the health poll and the envelope", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js", ["WEB_PORT"])] };
    const { deps, statusReads, wtSocket } = liveInstance(stack, { worktree: [running("web")] });
    const result = await runUp(deps);
    expect(statusReads.filter((p) => p === wtSocket)).toHaveLength(1);
    expect(result.services).toEqual([
      { name: "web", status: "Running", health: "unknown", ports: { WEB_PORT: result.blockBase } },
    ]);
  });

  it("a live shared tier does not fail up", async () => {
    const stack: ResolvedStack = {
      services: [shared("db", "postgres", ["DB_PORT"]), isolated("web", "node a.js")],
    };
    const { deps } = liveInstance(stack, { worktree: [running("web")], shared: [running("db")] });
    await expect(runUp(deps)).resolves.toBeDefined();
  });

  it("never attaches on the running path, even when a TTY is present", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const { deps, spawned } = liveInstance(stack, { worktree: [running("web")] }, { attach: true });
    await runUp(deps);
    expect(spawned.some((a) => a[0] === "attach")).toBe(false);
  });
});

/**
 * Pre-flight stale-port-block detection (#58). When the worktree's allocated
 * named ports are held by foreign processes at start time, `runUp` must abort
 * with `StalePortBlockError` (code `STALE_PORT_BLOCK`) BEFORE the spawn — so
 * the agent gets a discoverable failure instead of process-compose silently
 * losing EADDRINUSE and reporting "Completed". The check runs only when this
 * worktree's control socket is absent (first up); on the idempotent re-up
 * path, the listeners ARE our own, so the check is skipped entirely.
 */
describe("runUp — stale port block detection (#58)", () => {
  const stack: ResolvedStack = {
    services: [isolated("web", "node server.js", ["WEB_PORT", "METRICS_PORT"])],
  };

  it("aborts with code STALE_PORT_BLOCK when a declared named port is held by a foreign process at start time", async () => {
    const heldPorts = new Set<number>();
    // Stub holder: the first declared port is held by a "foreign" process.
    const portHolder = async (port: number) => {
      if (!heldPorts.has(port)) return { free: true as const };
      return { free: false as const, pid: 12345, command: "node stale.mjs" };
    };
    // First, run the deps once to learn the block base, then arm the holder.
    // Pin the worktree root so both stubDeps calls derive the same id.
    const loginId = idFor("/wt", "login");
    const probeDeps = stubDeps({ stack, worktreeRootOverride: "/wt" });
    const probeResult = await runUp(probeDeps);
    const blockBase = probeResult.blockBase;
    // Reset for a fresh first-up against a clean anchor (separate stubDeps()
    // call gives us a fresh tmp anchor with no socket present).
    heldPorts.add(blockBase); // WEB_PORT (offset 0)

    const deps: CommandDeps = {
      ...stubDeps({
        stack,
        worktreeRootOverride: "/wt",
        initialRegistry: { [loginId]: blockBase },
      }),
      portHolder,
      portAccepts: async () => true,
    };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: unknown },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("STALE_PORT_BLOCK");
    const details = err.details as {
      block_base: number;
      worktree_id: string;
      collisions: Array<{
        port_name: string;
        port: number;
        pid: number | null;
        command: string | null;
      }>;
    };
    expect(details.block_base).toBe(blockBase);
    expect(details.worktree_id).toBe(loginId);
    expect(details.collisions).toHaveLength(1);
    expect(details.collisions[0]).toEqual({
      port_name: "WEB_PORT",
      port: blockBase,
      pid: 12345,
      command: "node stale.mjs",
      accepts_connections: true,
      port_forwarder: false,
    });
    // The human message lists the collision too (#155), not just `details`.
    expect(err.message).toContain(`WEB_PORT ${blockBase}: pid 12345 (node stale.mjs)`);
  });

  it("collects every collision (not just the first) so the agent can kill all orphans in one pass", async () => {
    const portHolder = async (port: number) => ({
      free: false as const,
      pid: port, // pid = port for easy assertion
      command: `proc@${port}`,
    });
    const deps: CommandDeps = { ...stubDeps({ stack }), portHolder, portAccepts: async () => true };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { details?: unknown },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    const details = err.details as { collisions: Array<{ port_name: string }> };
    const names = details.collisions.map((c) => c.port_name).sort();
    expect(names).toEqual(["METRICS_PORT", "WEB_PORT"]);
  });

  it("reports collision even when the holder probe can't identify the pid/command (lsof missing / degraded)", async () => {
    const portHolder = async () => ({ free: false as const, pid: null, command: null }) as const;
    const deps: CommandDeps = { ...stubDeps({ stack }), portHolder, portAccepts: async () => true };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: unknown },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("STALE_PORT_BLOCK");
    const details = err.details as {
      collisions: Array<{ pid: number | null; command: string | null }>;
    };
    expect(details.collisions[0]?.pid).toBeNull();
    expect(details.collisions[0]?.command).toBeNull();
  });

  it("skips the check on the idempotent re-up path — the listeners on those ports ARE our own", async () => {
    // touchSocket: true makes the first up create the socket, so a second up
    // takes the idempotent branch. If the pre-flight ran on that branch it
    // would trip on our own listener and break re-runs.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    let holderCalls = 0;
    const portHolder = async () => {
      holderCalls++;
      return { free: false as const, pid: 999, command: "node should-not-trip" };
    };
    // First up uses a non-tripping holder to get us into the running state.
    const base = stubDeps({ stack, track });
    const deps: CommandDeps = {
      ...base,
      portHolder: async () => ({ free: true as const }),
    };
    await runUp(deps);
    // Second up: socket present → idempotent path. Swap in the tripping
    // holder; if the check ran, this call would reject.
    const drifted: CommandDeps = { ...deps, portHolder };
    const result = await runUp(drifted);
    expect(result.worktreeId).toBe(base.expectedWorktreeId);
    expect(holderCalls).toBe(0);
  });

  it("clean start (no holder reports a collision) does not throw — the happy path is unchanged", async () => {
    const base = stubDeps({ stack });
    const deps: CommandDeps = {
      ...base,
      portHolder: async () => ({ free: true as const }),
    };
    const result = await runUp(deps);
    expect(result.worktreeId).toBe(base.expectedWorktreeId);
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(20000);
  });

  it("only probes declared named ports — not the full 32-port allocation block (PRD §port block)", async () => {
    const probed: number[] = [];
    const portHolder = async (port: number) => {
      probed.push(port);
      return { free: true as const };
    };
    const deps: CommandDeps = { ...stubDeps({ stack }), portHolder, portAccepts: async () => true };
    const result = await runUp(deps);
    // The stack declares 2 named ports; the block holds 32. The check must
    // touch only the two.
    expect(probed).toHaveLength(2);
    expect(probed.sort((a, b) => a - b)).toEqual([result.blockBase, result.blockBase + 1]);
  });
});

/**
 * Crash recovery via control-socket liveness probing (#80). Socket files live
 * in anchor state, which survives `kill -9` and reboots — so the write paths
 * must probe the UDS for an actual listener instead of trusting file
 * existence. A stale socket is unlinked and `up` falls through to the
 * fresh-start path, including the #58 pre-flight it used to skip.
 */
describe("runUp — crash recovery: stale control socket (#80)", () => {
  const stack: ResolvedStack = { services: [isolated("web", "node server.js", ["WEB_PORT"])] };

  /**
   * Pre-create an orphaned socket file the way a SIGKILLed instance leaves
   * one — at the path-hash-suffixed id (#82) the resolver will derive for
   * `<worktreeRoot>/login`.
   */
  function orphanSocket(anchor: string, worktreeRoot: string): string {
    const paths = instancePaths(anchor, idFor(worktreeRoot, "login"));
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.socketPath, "");
    return paths.socketPath;
  }

  it("starts a fresh instance when the socket file exists but nothing listens (post-SIGKILL)", async () => {
    const tmp = tmpAnchor();
    const socketPath = orphanSocket(tmp.anchor, tmp.worktreeRoot);
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({
      stack,
      track,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket: async () => "stale",
    });

    const result = await runUp(deps);

    // Not a silent no-op: the driver was spawned against this worktree's socket.
    const worktreeSpawns = track.invocations.filter((i) => i.socketPath === socketPath);
    expect(worktreeSpawns).toHaveLength(1);
    // Normal started envelope, exactly as a first up would return.
    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(20000);
  });

  it("unlinks the stale socket file when detected", async () => {
    const tmp = tmpAnchor();
    const socketPath = orphanSocket(tmp.anchor, tmp.worktreeRoot);
    // touchSocket: false — nothing recreates the file, so its absence after
    // `runUp` proves the stale file was unlinked, not merely overwritten.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps = stubDeps({
      stack,
      track,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket: async () => "stale",
    });

    await runUp(deps);

    expect(existsSync(socketPath)).toBe(false);
  });

  it("a stale socket does not disable the STALE_PORT_BLOCK pre-flight (#58)", async () => {
    const tmp = tmpAnchor();
    orphanSocket(tmp.anchor, tmp.worktreeRoot);
    const deps: CommandDeps = {
      ...stubDeps({
        stack,
        anchorOverride: tmp.anchor,
        worktreeRootOverride: tmp.worktreeRoot,
        probeSocket: async () => "stale",
      }),
      // An orphaned process still squats this worktree's block.
      portHolder: async () => ({ free: false as const, pid: 4242, command: "node orphan.mjs" }),
      portAccepts: async () => true,
    };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("STALE_PORT_BLOCK");
  });

  it("a live socket (probe says running) still takes the idempotent no-op path", async () => {
    const tmp = tmpAnchor();
    const socketPath = orphanSocket(tmp.anchor, tmp.worktreeRoot);
    const probed: string[] = [];
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const deps = stubDeps({
      stack,
      track,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket: async (p) => {
        probed.push(p);
        return "running";
      },
    });

    const result = await runUp(deps);

    // No fresh spawn, socket left in place, envelope still emitted.
    expect(track.invocations).toHaveLength(0);
    expect(existsSync(socketPath)).toBe(true);
    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
    expect(probed).toContain(socketPath);
  });
});

/**
 * Shared-instance crash recovery (#80). The shared instance's socket file is
 * anchor state too: after a SIGKILL the lazy-start used to see the file,
 * conclude "already running", and the shared instance could never be
 * restarted without hand-deleting the socket.
 */
describe("runUp — crash recovery: stale shared socket (#80)", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
    ],
  };

  /** Pre-create an orphaned shared socket the way a SIGKILLed instance leaves one. */
  function orphanSharedSocket(anchor: string): string {
    const paths = sharedInstancePaths(anchor);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.socketPath, "");
    return paths.socketPath;
  }

  it("restarts the shared instance when its socket file exists but nothing listens", async () => {
    const tmp = tmpAnchor();
    const sharedSocket = orphanSharedSocket(tmp.anchor);
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({
      stack: mixedStack,
      track,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      // The shared socket is dead; the worktree's own socket doesn't exist yet.
      probeSocket: async () => "stale",
    });

    const result = await runUp(deps);

    // The lazy-start actually restarted shared — and reports having done so.
    const sharedSpawn = findSharedSpawn(track);
    expect(sharedSpawn.socketPath).toBe(sharedSocket);
    expect(result.sharedStarted).toBe(true);
  });

  it("a live shared socket is left alone — lazy start stays idempotent", async () => {
    const tmp = tmpAnchor();
    const sharedSocket = orphanSharedSocket(tmp.anchor);
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({
      stack: mixedStack,
      track,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket: async () => "running",
    });

    const result = await runUp(deps);

    expect(track.invocations.some((i) => i.socketPath === sharedSocket)).toBe(false);
    expect(result.sharedStarted).toBe(false);
    expect(existsSync(sharedSocket)).toBe(true);
  });
});

/**
 * `down --shared` against a crashed shared instance (#80). The old check
 * (`existsSync` → driver.down) signalled a dead socket, which fails; the
 * stale file must instead be cleaned up and the call must stay an idempotent
 * no-op.
 */
describe("runDown — crash recovery: stale shared socket (#80)", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
    ],
  };

  it("cleans up the stale socket file and no-ops instead of signalling a dead instance", async () => {
    const tmp = tmpAnchor();
    const sharedPaths = sharedInstancePaths(tmp.anchor);
    mkdirSync(sharedPaths.runDir, { recursive: true });
    writeFileSync(sharedPaths.socketPath, "");

    const downSpawns: string[] = [];
    const base = stubDeps({
      stack: mixedStack,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket: async () => "stale",
    });
    const innerSpawner = base.driver?.spawner;
    if (innerSpawner === undefined) throw new Error("expected stub spawner");
    const spawner = (binary: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
      if (args[0] === "down") downSpawns.push(args.join(" "));
      return innerSpawner(binary, args, options);
    };
    const deps: CommandDeps = { ...base, driver: { ...base.driver, spawner } };

    const result = await runDown(deps, { shared: true });

    // Idempotent no-op result, no `process-compose down` against the dead UDS.
    expect(result).toEqual({ shared: true, stopped: false, forceKilled: [] });
    expect(downSpawns).toHaveLength(0);
    // The orphaned socket file was unlinked, so the next up lazy-starts fresh.
    expect(existsSync(sharedPaths.socketPath)).toBe(false);
  });

  it("still signals a live shared instance through the driver", async () => {
    const tmp = tmpAnchor();
    const sharedPaths = sharedInstancePaths(tmp.anchor);
    mkdirSync(sharedPaths.runDir, { recursive: true });
    writeFileSync(sharedPaths.socketPath, "");

    const downSpawns: string[] = [];
    const base = stubDeps({
      stack: mixedStack,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket: async () => "running",
    });
    const innerSpawner = base.driver?.spawner;
    if (innerSpawner === undefined) throw new Error("expected stub spawner");
    const spawner = (binary: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
      if (args[0] === "down") downSpawns.push(args.join(" "));
      return innerSpawner(binary, args, options);
    };
    const deps: CommandDeps = { ...base, driver: { ...base.driver, spawner } };

    const result = await runDown(deps, { shared: true });

    expect(result).toEqual({ shared: true, stopped: true, forceKilled: [] });
    expect(downSpawns).toHaveLength(1);
  });
});

/**
 * Shared instance as source of truth for shared ports (#83).
 *
 * The running shared instance persists its name→port map (and a hash of the
 * shared subset it was derived from) in anchor state at start. Worktrees
 * inject shared connection info from that map instead of recomputing
 * positional offsets against their own devtrees.yaml — so branch divergence
 * (reordering, added services) can never silently inject port numbers the
 * shared instance did not bind. A semantically-diverged shared subset fails
 * with `SHARED_DRIFT` instead.
 */
/**
 * A probe that cannot tell live from dead (#186). A timeout on a loaded
 * machine used to read as "stale", so the gate unlinked a LIVE instance's
 * socket: `ls` lost it, `down` said "nothing running", and process-compose
 * plus its services were orphaned on their ports. Now only a definitive
 * answer unlinks; `unknown` is retried and then fails INSTANCE_UNRESPONSIVE
 * with the socket kept.
 */
describe("liveness unknown — retry, then fail without touching the socket (#186)", () => {
  const isolatedStack: ResolvedStack = {
    services: [isolated("web", "node server.js", ["WEB_PORT"])],
  };
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
    ],
  };

  /**
   * A worktree instance whose socket file is on disk (unchanged config, `web`
   * running, so a live verdict takes the quiet already-running path), with
   * every spawn and reap recorded.
   */
  function staged(
    probeSocket: (socketPath: string) => Promise<InstanceStatus>,
    stack: ResolvedStack = isolatedStack,
  ) {
    const tmp = tmpAnchor();
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const base = stubDeps({
      stack,
      track,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket,
    });
    const wtSocket = instancePaths(tmp.anchor, base.expectedWorktreeId).socketPath;
    const sharedSocket = sharedInstancePaths(tmp.anchor).socketPath;
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(wtSocket, "");
    const spawned: string[][] = [];
    const reaped: string[] = [];
    const inner = base.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");
    const deps: CommandDeps = {
      ...base,
      probeRetryDelaysMs: [0, 0, 0],
      readStoredHash: () => stackHash(stack),
      writeStoredHash: () => {},
      getServiceStatuses: async () => [{ name: "web", status: "Running", health: "unknown" }],
      reap: async () => {
        reaped.push("reap");
        return { ranCount: 0, failures: [] };
      },
      driver: {
        ...base.driver,
        spawner: (binary, args, options) => {
          spawned.push([...args]);
          return inner(binary, args, options);
        },
      },
    };
    return { deps, track, spawned, reaped, wtSocket, sharedSocket, id: base.expectedWorktreeId };
  }

  async function rejection(p: Promise<unknown>) {
    return p.then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
  }

  it("up: an unknown worktree socket is re-probed, then fails INSTANCE_UNRESPONSIVE without a fresh start", async () => {
    const probed: string[] = [];
    const fx = staged(async (p) => {
      probed.push(p);
      return "unknown";
    });
    const err = await rejection(runUp(fx.deps));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.details).toMatchObject({ instance: fx.id, socket_path: fx.wtSocket, attempts: 4 });
    expect(String(err?.details?.remedy)).toContain("devtrees up");
    // One probe plus one per backoff step, all against the worktree socket.
    expect(probed).toEqual([fx.wtSocket, fx.wtSocket, fx.wtSocket, fx.wtSocket]);
    // No fresh start beside a possibly-live instance (it would collide on ports).
    expect(fx.track.invocations).toEqual([]);
    expect(existsSync(fx.wtSocket)).toBe(true);
  });

  it("up: a probe that answers on a retry takes the already-running path", async () => {
    let probes = 0;
    const fx = staged(async () => (++probes < 3 ? "unknown" : "running"));
    const result = await runUp(fx.deps);
    expect(result.worktreeId).toBe(fx.id);
    expect(probes).toBe(3);
    expect(fx.track.invocations).toEqual([]);
    expect(existsSync(fx.wtSocket)).toBe(true);
  });

  it("up: a definitive stale after an unknown still unlinks and starts fresh", async () => {
    let probes = 0;
    const fx = staged(async () => (++probes === 1 ? "unknown" : "stale"));
    await runUp(fx.deps);
    expect(fx.track.invocations.map((i) => i.socketPath)).toEqual([fx.wtSocket]);
  });

  it("up: an unknown shared socket fails INSTANCE_UNRESPONSIVE instead of lazy-starting a second shared instance", async () => {
    const fx = staged(async () => "unknown", mixedStack);
    rmSync(fx.wtSocket);
    writeFileSync(fx.sharedSocket, "");
    const err = await rejection(runUp(fx.deps));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.details).toMatchObject({ instance: "shared", socket_path: fx.sharedSocket });
    expect(fx.track.invocations.some((i) => i.socketPath === fx.sharedSocket)).toBe(false);
    expect(existsSync(fx.sharedSocket)).toBe(true);
  });

  it("down: an unknown socket fails INSTANCE_UNRESPONSIVE — never 'nothing running', never the dead-supervisor reap", async () => {
    const fx = staged(async () => "unknown");
    const err = await rejection(runDown(fx.deps));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.message).toContain("socket was kept");
    expect(String(err?.details?.remedy)).toContain("devtrees down");
    expect(fx.spawned.filter((a) => a[0] === "down")).toEqual([]);
    expect(fx.reaped).toEqual([]);
    expect(existsSync(fx.wtSocket)).toBe(true);
  });

  it("down: a probe that answers on a retry stops the instance through the driver", async () => {
    let probes = 0;
    const fx = staged(async () => (++probes === 1 ? "unknown" : "running"));
    const result = await runDown(fx.deps);
    expect(result.stopped).toBe(true);
    expect(fx.spawned.filter((a) => a[0] === "down")).toHaveLength(1);
  });

  it("down --shared: an unknown shared socket fails INSTANCE_UNRESPONSIVE and keeps the socket", async () => {
    const fx = staged(async () => "unknown", mixedStack);
    writeFileSync(fx.sharedSocket, "");
    const err = await rejection(runDown(fx.deps, { shared: true }));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.details).toMatchObject({ instance: "shared" });
    expect(String(err?.details?.remedy)).toContain("devtrees down --shared");
    expect(fx.spawned.filter((a) => a[0] === "down")).toEqual([]);
    expect(existsSync(fx.sharedSocket)).toBe(true);
  });

  it("the envelope classifies as INSTANCE_UNRESPONSIVE with its details", async () => {
    const fx = staged(async () => "unknown");
    const err = await rejection(runDown(fx.deps));
    if (err === undefined) throw new Error("expected runDown to reject");
    const payload = classifyError(err);
    expect(payload.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(payload.details).toMatchObject({ socket_path: fx.wtSocket, attempts: 4 });
  });
});

describe("runUp / runEnv — shared port map persistence & drift (#83)", () => {
  // The shared subset as worktree A's branch declares it.
  const stackA: ResolvedStack = {
    services: [
      shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
      shared("redis", "redis-server", ["CACHE_PORT"]),
      isolated("web", "node server.js", ["WEB_PORT"]),
    ],
  };
  // Worktree B's branch lists the same services in a different order —
  // positional offsets would swap DB_PORT and CACHE_PORT.
  const stackBReordered: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("redis", "redis-server", ["CACHE_PORT"]),
      shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
    ],
  };
  // Worktree B's branch edits a shared service — a semantic divergence.
  const stackBDivergent: ResolvedStack = {
    services: [
      shared("postgres", "postgres -D ./pgdata -c fsync=off", ["DB_PORT"]),
      shared("redis", "redis-server", ["CACHE_PORT"]),
      isolated("web", "node server.js", ["WEB_PORT"]),
    ],
  };

  /** deps for one worktree against a common anchor/registry fixture. */
  function worktreeDeps(
    fixture: { sharedAnchor: string; wtRoot: string; registryRef: { snapshot: RegistrySnapshot } },
    stack: ResolvedStack,
    worktreeId: string,
    track?: StubSpawn,
  ): CommandDeps {
    return stubDeps({
      stack,
      worktreeId,
      anchorOverride: fixture.sharedAnchor,
      worktreeRootOverride: fixture.wtRoot,
      registryRef: fixture.registryRef,
      track: track ?? { invocations: [], touchSocket: true },
    });
  }

  /** Spawner that mimics the real driver's `down` removing the control socket. */
  function socketRemovingDownDeps(deps: CommandDeps): CommandDeps {
    return {
      ...deps,
      driver: {
        exists: () => Promise.resolve(true),
        spawner: (_b, args, _o): SpawnedProcess => {
          const si = args.indexOf("-u");
          if (args[0] === "down" && si >= 0) {
            const socketPath = args[si + 1];
            if (socketPath) rmSync(socketPath, { force: true });
          }
          return spawnedOk();
        },
      },
    };
  }

  it("persists the shared name→port map + subset hash in anchor state when shared starts", async () => {
    const fixture = multiWorktreeFixture("dt-map-");
    const result = await runUp(worktreeDeps(fixture, stackA, "login"));

    const state = readSharedState(fixture.sharedAnchor);
    expect(state).toBeDefined();
    expect(state?.hash).toBe(sharedStackHash(stackA));
    expect(state?.ports).toEqual({
      DB_PORT: Number(result.env.DB_PORT),
      CACHE_PORT: Number(result.env.CACHE_PORT),
    });
  });

  it("injects the running instance's ports into a worktree whose branch reorders services", async () => {
    // A starts shared from its ordering; B's branch reverses the list. With
    // positional offsets B would swap DB_PORT/CACHE_PORT — the persisted map
    // must win so both worktrees see identical shared connection info.
    const fixture = multiWorktreeFixture("dt-reorder-");
    const a = await runUp(worktreeDeps(fixture, stackA, "login"));
    const b = await runUp(worktreeDeps(fixture, stackBReordered, "billing"));

    expect(b.sharedStarted).toBe(false);
    expect(b.env.DB_PORT).toBe(a.env.DB_PORT);
    expect(b.env.CACHE_PORT).toBe(a.env.CACHE_PORT);
  });

  it("does not flag drift when the shared subsets are identical (no false positives)", async () => {
    const fixture = multiWorktreeFixture("dt-same-");
    const a = await runUp(worktreeDeps(fixture, stackA, "login"));
    // Structurally-equal but distinct stack object — same branch, fresh parse.
    const sameStack: ResolvedStack = JSON.parse(JSON.stringify(stackA)) as ResolvedStack;
    const b = await runUp(worktreeDeps(fixture, sameStack, "billing"));
    expect(b.env.DB_PORT).toBe(a.env.DB_PORT);
    expect(b.env.CACHE_PORT).toBe(a.env.CACHE_PORT);
  });

  it("fails with SHARED_DRIFT when a worktree's shared subset diverges from the running instance", async () => {
    const fixture = multiWorktreeFixture("dt-drift-");
    await runUp(worktreeDeps(fixture, stackA, "login"));

    const err = await runUp(worktreeDeps(fixture, stackBDivergent, "billing")).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject with shared drift");
    expect(err.code).toBe("SHARED_DRIFT");
    // The remediation is explicit: bring shared down and up again.
    expect(err.message).toMatch(/down --shared/);
    // #236: the drifted service is named, with both revisions.
    expect(err.message).toMatch(/'postgres' \(running [0-9a-f]{12}, this worktree [0-9a-f]{12}\)/);
    const details = (err as Error & { details?: Record<string, unknown> }).details;
    expect(details?.services).toEqual([
      {
        service: "postgres",
        running_hash: sharedServiceHash(stackA.services[0] as ResolvedService),
        local_hash: sharedServiceHash(stackBDivergent.services[0] as ResolvedService),
      },
    ]);
    // #111: the message must not embed its own `devtrees:` prefix — the
    // output formatter is the single seam that owns it, so an embedded one
    // renders the doubled `devtrees: devtrees:` on stderr.
    expect(err.message).not.toMatch(/devtrees:/);
  });

  it("drift does not spawn the divergent worktree's instance (no partial up)", async () => {
    const fixture = multiWorktreeFixture("dt-drift-spawn-");
    await runUp(worktreeDeps(fixture, stackA, "login"));

    const trackB: StubSpawn = { invocations: [], touchSocket: true };
    await expect(
      runUp(worktreeDeps(fixture, stackBDivergent, "billing", trackB)),
    ).rejects.toThrow();
    expect(trackB.invocations).toEqual([]);
  });

  it("down --shared followed by up from the divergent worktree succeeds and re-persists the new map", async () => {
    const fixture = multiWorktreeFixture("dt-repersist-");
    await runUp(worktreeDeps(fixture, stackA, "login"));

    const bDeps = worktreeDeps(fixture, stackBDivergent, "billing");
    await expect(runUp(bDeps)).rejects.toThrow(/down --shared/);

    await runDown(socketRemovingDownDeps(bDeps), { shared: true });

    const b = await runUp(bDeps);
    expect(b.sharedStarted).toBe(true);

    const state = readSharedState(fixture.sharedAnchor);
    expect(state?.hash).toBe(sharedStackHash(stackBDivergent));
    expect(state?.ports).toEqual({
      DB_PORT: Number(b.env.DB_PORT),
      CACHE_PORT: Number(b.env.CACHE_PORT),
    });
    expect(state?.services?.postgres?.hash).toBe(
      sharedServiceHash(stackBDivergent.services[0] as ResolvedService),
    );
  });

  describe("shared-only field edits (#185)", () => {
    const withShutdown = (cmd: string): ResolvedStack => ({
      services: [
        { ...shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]), shutdown: { command: cmd } },
        isolated("web", "node server.js", ["WEB_PORT"]),
      ],
    });

    it("an edit to a shared service's shutdown warns, does not reload, and does not drift", async () => {
      const fixture = multiWorktreeFixture("dt-shared-field-");
      const before = withShutdown("pg_ctl stop");
      const after = withShutdown("pg_ctl stop -m fast");
      expect(stackHash(after)).toBe(stackHash(before));

      await runUp(worktreeDeps(fixture, before, "login"));
      const track: StubSpawn = { invocations: [], touchSocket: true };
      const warnings: string[] = [];
      const result = await runUp({
        ...worktreeDeps(fixture, after, "login", track),
        warn: (m) => warnings.push(m),
      });

      expect(result.sharedFieldChanges).toEqual([{ service: "postgres", field: "shutdown" }]);
      const line = warnings.find((w) => w.includes("shared service 'postgres'"));
      expect(line).toMatch(/'shutdown'/);
      expect(line).toMatch(/devtrees down --shared && devtrees up/);
      // No worktree hot-reload: nothing was spawned for the unchanged instance.
      expect(track.invocations).toEqual([]);
    });

    it("an unchanged stack reports no shared field changes", async () => {
      const fixture = multiWorktreeFixture("dt-shared-field-same-");
      const stack = withShutdown("pg_ctl stop");
      await runUp(worktreeDeps(fixture, stack, "login"));
      const warnings: string[] = [];
      const result = await runUp({
        ...worktreeDeps(fixture, stack, "billing"),
        warn: (m) => warnings.push(m),
      });
      expect(result.sharedFieldChanges).toEqual([]);
      expect(warnings.filter((w) => w.includes("shared service"))).toEqual([]);
    });

    it("an older shared-state.json without the record loads and does not warn", async () => {
      const fixture = multiWorktreeFixture("dt-shared-field-old-");
      const before = withShutdown("pg_ctl stop");
      await runUp(worktreeDeps(fixture, before, "login"));
      // Rewrite the state as a pre-#185 devtrees would have: no `extended`.
      const state = readSharedState(fixture.sharedAnchor);
      if (state === undefined) throw new Error("expected shared state");
      writeFileSync(
        join(fixture.sharedAnchor, "devtrees", "shared-state.json"),
        JSON.stringify({ hash: state.hash, ports: state.ports }),
        "utf8",
      );
      const result = await runUp({
        ...worktreeDeps(fixture, withShutdown("pg_ctl stop -m fast"), "billing"),
      });
      expect(result.sharedFieldChanges).toEqual([]);
    });
  });

  it("falls back to positional offsets when shared is running but no state was persisted (pre-#83 instance)", async () => {
    const fixture = multiWorktreeFixture("dt-legacy-");
    // Simulate a shared instance started by an older devtrees: socket on
    // disk, no shared-state.json.
    const dir = runDir(fixture.sharedAnchor);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shared.sock"), "");

    const result = await runUp(worktreeDeps(fixture, stackA, "login"));
    expect(result.sharedStarted).toBe(false);
    expect(result.env.DB_PORT).toBeDefined();
    expect(result.env.CACHE_PORT).toBeDefined();
  });

  it("runEnv reads the persisted map so a reordered branch sees what shared actually bound", async () => {
    const fixture = multiWorktreeFixture("dt-env-map-");
    const a = await runUp(worktreeDeps(fixture, stackA, "login"));

    const env = await runEnv(worktreeDeps(fixture, stackBReordered, "billing"));
    expect(env.env.DB_PORT).toBe(a.env.DB_PORT);
    expect(env.env.CACHE_PORT).toBe(a.env.CACHE_PORT);
  });

  it("runEnv fails with SHARED_DRIFT for a divergent worktree instead of reporting wrong ports", async () => {
    const fixture = multiWorktreeFixture("dt-env-drift-");
    await runUp(worktreeDeps(fixture, stackA, "login"));

    const err = await runEnv(worktreeDeps(fixture, stackBDivergent, "billing")).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runEnv to reject with shared drift");
    expect(err.code).toBe("SHARED_DRIFT");
  });

  it("runEnv computes positional would-be ports when the shared instance is not running", async () => {
    // No shared socket: a future `up` would lazy-start shared from this
    // worktree's own stack, so env predicts the positional computation.
    const fixture = multiWorktreeFixture("dt-env-down-");
    const env = await runEnv(worktreeDeps(fixture, stackA, "login"));
    expect(Number(env.env.DB_PORT)).toBeGreaterThanOrEqual(20000);
    expect(Number(env.env.CACHE_PORT)).toBe(Number(env.env.DB_PORT) + 1);
  });
});

/**
 * `runUp` — issue #91: per-worktree lifecycle lock. Two concurrent `up`s in
 * the same worktree (human + agent) both passing the liveness gate would each
 * write the derived config and spawn process-compose against the same socket
 * and port block — the loser's exit-time cleanup then unlinks the winner's
 * socket. The lock generalizes the shared-instance start gate: held across
 * the liveness-check → config-write → spawn → socket-wait window, so the
 * loser observes the winner's live instance and takes the idempotency path.
 */
describe("runUp — control socket path length guard (issue #156)", () => {
  const oneIsolatedService: ResolvedStack = {
    services: [isolated("web", "node server.js", ["WEB_PORT"])],
  };

  /** Run `fn` with DEVTREES_RUNTIME_DIR pointed at `dir`, then restore it. */
  async function withRuntimeDir(dir: string, fn: () => Promise<void>): Promise<void> {
    const previous = process.env["DEVTREES_RUNTIME_DIR"];
    process.env["DEVTREES_RUNTIME_DIR"] = dir;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env["DEVTREES_RUNTIME_DIR"];
      else process.env["DEVTREES_RUNTIME_DIR"] = previous;
    }
  }

  it("fails with SOCKET_PATH_TOO_LONG instead of spawning a doomed process-compose", async () => {
    // Before #156 an over-long socket path made process-compose exit without
    // binding and without saying why; `up` then reported an unrelated
    // socket-wait timeout, which is what issue #154 misdiagnosed. The guard
    // has to fire before the spawn and name the real cause.
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack: oneIsolatedService, track });

    await withRuntimeDir(`/tmp/${"d".repeat(120)}`, async () => {
      await expect(runUp(deps)).rejects.toThrow(/unix-socket limit/);
    });

    // Nothing was spawned: the failure is a pre-flight, not a dead instance.
    expect(track.invocations).toHaveLength(0);
  });

  it("tags the failure with the SOCKET_PATH_TOO_LONG code and an actionable envelope", async () => {
    const deps = stubDeps({ stack: oneIsolatedService });

    await withRuntimeDir(`/tmp/${"d".repeat(120)}`, async () => {
      const err = (await runUp(deps).catch((e: unknown) => e)) as Error & {
        code?: string;
        details?: { max_bytes?: number; runtime_dir_env?: string };
      };
      expect(err.code).toBe("SOCKET_PATH_TOO_LONG");
      expect(err.details?.max_bytes).toBe(SOCKET_PATH_MAX_BYTES);
      expect(err.details?.runtime_dir_env).toBe("DEVTREES_RUNTIME_DIR");
    });
  });

  it("starts normally once the runtime dir is short enough", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const deps = stubDeps({ stack: oneIsolatedService, track });

    const result = await runUp(deps);

    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
    expect(Buffer.byteLength(result.socketPath)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);
    expect(track.invocations).toHaveLength(1);
  });
});

describe("runUp — per-worktree lifecycle lock (issue #91)", () => {
  const oneIsolated: ResolvedStack = {
    services: [isolated("web", "node server.js", ["WEB_PORT"])],
  };

  /** A pass-through lock that records its acquire/release into `events`. */
  function makeSpyLock(events: string[]): WithLifecycleLock {
    return async (_anchor, instanceId, fn) => {
      events.push(`acquire:${instanceId}`);
      try {
        return await fn();
      } finally {
        events.push(`release:${instanceId}`);
      }
    };
  }

  it("holds the worktree's lock across spawn and socket-wait, releasing only after both", async () => {
    const events: string[] = [];
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const base = stubDeps({ stack: oneIsolated, track });
    const inner = base.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    const deps: CommandDeps = {
      ...base,
      withLifecycleLock: makeSpyLock(events),
      waitForSocketFile: async () => {
        events.push("socket-wait");
      },
      driver: {
        ...base.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "up") events.push("spawn");
          return inner(binary, args, options);
        },
      },
    };

    await runUp(deps);

    const id = base.expectedWorktreeId;
    // The full check→spawn→socket-ready window runs inside one hold: spawn
    // AND the socket-observable wait both precede the release. A lock
    // released right after `driver.up` returned would let a concurrent up's
    // liveness gate run before the socket exists — and double-spawn.
    expect(events).toEqual([`acquire:${id}`, "spawn", "socket-wait", `release:${id}`]);
  });

  it("runs the already-up liveness gate + reconciliation inside the lock window", async () => {
    const events: string[] = [];
    const tmp = tmpAnchor();
    const base = stubDeps({
      stack: oneIsolated,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
      probeSocket: async () => {
        events.push("probe");
        return "running" as const;
      },
    });
    // Fake an already-live instance: socket file present + probe says running.
    const socketPath = instancePaths(tmp.anchor, base.expectedWorktreeId).socketPath;
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(socketPath, "");

    const currentHashStore: Record<string, string> = {};
    const deps: CommandDeps = {
      ...base,
      withLifecycleLock: makeSpyLock(events),
      readStoredHash: (_a, id) => currentHashStore[id],
      writeStoredHash: (_a, id, h) => {
        events.push("hash-write");
        currentHashStore[id] = h;
      },
      getServiceStatuses: async () => [],
    };

    await runUp(deps);

    const id = base.expectedWorktreeId;
    // Liveness probe inside the hold; reconcile (here: drift-path hash write,
    // since no hash was stored) also inside; no spawn anywhere.
    expect(events).toEqual([`acquire:${id}`, "probe", "hash-write", `release:${id}`]);
  });

  it("two concurrent ups in the same worktree spawn exactly one instance; the loser reports already-up", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const base = stubDeps({ stack: oneIsolated, track });
    const store: Record<string, string> = {};
    // No `withLifecycleLock` injection: the REAL per-worktree lockfile under
    // the temp anchor is the mechanism under test here.
    const deps: CommandDeps = {
      ...base,
      readStoredHash: (_a, id) => store[id],
      writeStoredHash: (_a, id, h) => {
        store[id] = h;
      },
      getServiceStatuses: async () => [],
    };

    const [a, b] = await Promise.all([runUp(deps), runUp(deps)]);

    const worktreeSpawns = track.invocations.filter((i) => !i.socketPath.endsWith("/shared.sock"));
    expect(worktreeSpawns).toHaveLength(1);
    // The loser reconciled against the winner's live instance: same envelope.
    expect(b.env).toEqual(a.env);
    expect(b.blockBase).toBe(a.blockBase);
    expect(a.worktreeId).toBe(b.worktreeId);
  });

  it("releases the lock when the spawn throws, so a follow-up up is not bricked", async () => {
    const tmp = tmpAnchor();
    const base = stubDeps({
      stack: oneIsolated,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
    });
    const deps: CommandDeps = {
      ...base,
      driver: {
        exists: () => Promise.resolve(true),
        spawner: () => {
          throw new Error("spawn failed");
        },
      },
    };

    await expect(runUp(deps)).rejects.toThrow("spawn failed");

    // The real default lifecycle lock was used; a leaked lockfile here would
    // brick every subsequent `up` in this worktree until hand-deleted.
    const lockPath = join(tmp.anchor, "devtrees", `${base.expectedWorktreeId}.lock`);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("surfaces LOCK_CONTENTION when the lock is held by a live process beyond the wait budget", async () => {
    const tmp = tmpAnchor();
    const base = stubDeps({
      stack: oneIsolated,
      anchorOverride: tmp.anchor,
      worktreeRootOverride: tmp.worktreeRoot,
    });
    // A live holder (our own pid — never stolen) already owns this worktree's lock.
    mkdirSync(join(tmp.anchor, "devtrees"), { recursive: true });
    writeFileSync(
      join(tmp.anchor, "devtrees", `${base.expectedWorktreeId}.lock`),
      `${process.pid}\n`,
      { flag: "wx" },
    );
    const deps: CommandDeps = {
      ...base,
      // Zero retries: exercise the budget-exhausted path without the default wait.
      withLifecycleLock: (anchor, id, fn) => withLifecycleLock(anchor, id, fn, { retries: 0 }),
    };

    await expect(runUp(deps)).rejects.toMatchObject({ code: "LOCK_CONTENTION" });
  });
});

/**
 * Issue #190: `down` (worktree and `--shared`) and prune's orphan stop are
 * bounded. process-compose never escalates on a `shutdown.command` that does
 * not stop its process, so its `down` would block forever. On expiry devtrees
 * SIGKILLs only the snapshot service processes still alive, reports them as
 * `forceKilled`, and fails `DOWN_TIMEOUT` (state kept) if process-compose
 * still does not exit.
 */
describe("bounded down — force-kill and DOWN_TIMEOUT (#190)", () => {
  const PC_PID = 100;
  const WEB_PID = 201;

  /** A `process-compose down` client that never returns until killed. */
  function hangingDown(): SpawnedProcess {
    const emitter = new EventEmitter();
    (emitter as unknown as SpawnedProcess).kill = () => {
      queueMicrotask(() => emitter.emit("exit", null));
      return true;
    };
    return emitter as unknown as SpawnedProcess;
  }

  /** A `process list -o json` child reporting `web` running as WEB_PID. */
  function listing(): SpawnedProcess {
    const emitter = new EventEmitter() as EventEmitter & { stdout: Readable };
    const rows = [
      { name: "web", status: "Running", is_ready: "-", pid: WEB_PID, is_running: true },
    ];
    emitter.stdout = Readable.from([JSON.stringify(rows)]);
    emitter.stdout.on("end", () => queueMicrotask(() => emitter.emit("exit", 0)));
    return emitter as unknown as SpawnedProcess;
  }

  /** A driver whose `down` hangs on a stuck `web`. */
  function stuckDriver(): CommandDeps["driver"] {
    return {
      exists: () => Promise.resolve(true),
      spawner: (_binary, args) => {
        if (args[0] === "down") return hangingDown();
        if (args[0] === "process") return listing();
        return spawnedOk();
      },
    };
  }

  /**
   * Stop seams over a fake process table: process-compose (PC_PID) bound to
   * `socketPath`, `web` its child, plus `extra` children (alive until
   * killed). `pcExits` decides whether process-compose exits once `web` is
   * killed; `pcExitsOnKill` makes it exit once that pid is killed instead.
   */
  function stopSeams(
    socketPath: string,
    opts: {
      pcExits: boolean;
      pcExitsOnKill?: number;
      extra?: ReadonlyArray<{ pid: number; ppid: number; pgid: number; command: string }>;
    },
  ) {
    const kills: Array<[number, string]> = [];
    const killed = new Set<number>();
    const pcGone = (): boolean =>
      (opts.pcExits && killed.has(WEB_PID)) ||
      (opts.pcExitsOnKill !== undefined && killed.has(opts.pcExitsOnKill));
    const seams: NonNullable<CommandDeps["stop"]> = {
      readProcessTable: async () => [
        {
          pid: PC_PID,
          ppid: 1,
          pgid: PC_PID,
          command: `process-compose up -f x.yaml -U -u ${socketPath} -t=false`,
        },
        { pid: WEB_PID, ppid: PC_PID, pgid: WEB_PID, command: "bash -c tail -f hold" },
        ...(opts.extra ?? []).filter((row) => !killed.has(row.pid)),
      ],
      kill: (target, signal) => {
        kills.push([target, signal]);
        killed.add(Math.abs(target));
      },
      isAlive: (pid) =>
        pid === PC_PID
          ? !pcGone()
          : (opts.extra ?? []).some((row) => row.pid === pid) && !killed.has(pid),
      exists: () => true,
      baseTimeoutMs: 20,
      graceMs: 30,
      pollMs: 5,
    };
    return { seams, kills };
  }

  const isolatedStack: ResolvedStack = {
    services: [isolated("web", "tail -f hold", ["WEB_PORT"])],
  };
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "tail -f hold", ["WEB_PORT"]),
      shared("postgres", "postgres", ["DB_PORT"]),
    ],
  };

  function anchorOf(deps: StubbedDeps): string {
    return (deps.git!(["rev-parse", "--git-common-dir"]) as string).trim();
  }

  type Failure = Error & { code?: string; details?: Record<string, unknown> };

  const PENDING: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 99 }] };

  it("worktree down force-kills only the stuck service and reports it", async () => {
    const deps = stubDeps({ stack: isolatedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    const { seams, kills } = stopSeams(paths.socketPath, { pcExits: true });
    // A successful bounded stop clears any pending reload (#191).
    writePendingReload(anchorOf(deps), deps.expectedWorktreeId, PENDING);
    const result = await runDown({ ...deps, driver: stuckDriver(), stop: seams });
    expect(result).toMatchObject({ shared: false, stopped: true });
    expect(result.forceKilled).toEqual([{ service: "web", pid: WEB_PID }]);
    // The service's process group, never process-compose itself.
    expect(kills).toEqual([[-WEB_PID, "SIGKILL"]]);
    expect(readPendingReload(anchorOf(deps), deps.expectedWorktreeId)).toBeUndefined();
  });

  it("worktree down force-kills a pending reload's unlisted old run before stopping, then clears the marker (#206)", async () => {
    const deps = stubDeps({ stack: isolatedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    // process-compose no longer lists the old `api` run; only the marker knows it.
    const old = { pid: 77, ppid: PC_PID, pgid: 77, command: "bash -c sleep 300" };
    const { seams, kills } = stopSeams(paths.socketPath, { pcExits: true, extra: [old] });
    writePendingReload(anchorOf(deps), deps.expectedWorktreeId, {
      services: [],
      oldRuns: [
        { name: "api", pid: 77, identity: { ppid: PC_PID, pgid: 77, command: old.command } },
      ],
    });
    const result = await runDown({ ...deps, driver: stuckDriver(), stop: seams });
    expect(result.forceKilled).toEqual([
      { service: "api", pid: 77 },
      { service: "web", pid: WEB_PID },
    ]);
    // The old run first, before `process-compose down`; then the escalation.
    expect(kills).toEqual([
      [-77, "SIGKILL"],
      [-WEB_PID, "SIGKILL"],
    ]);
    expect(readPendingReload(anchorOf(deps), deps.expectedWorktreeId)).toBeUndefined();
  });

  it("worktree down succeeds when process-compose exits on its own while the pending reload settles (#206)", async () => {
    // The update's new copy failed to start and nothing else ran:
    // process-compose (no --keep-project) exits once the old run is killed.
    const deps = stubDeps({ stack: isolatedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    const old = { pid: 77, ppid: PC_PID, pgid: 77, command: "bash -c sleep 300" };
    const { seams, kills } = stopSeams(paths.socketPath, {
      pcExits: false,
      pcExitsOnKill: 77,
      extra: [old],
    });
    writePendingReload(anchorOf(deps), deps.expectedWorktreeId, {
      services: ["api"],
      oldRuns: [
        { name: "api", pid: 77, identity: { ppid: PC_PID, pgid: 77, command: old.command } },
      ],
    });
    const downs: string[][] = [];
    const base = stuckDriver();
    const driver: CommandDeps["driver"] = {
      ...base,
      spawner: (binary, args, options) => {
        if (args[0] === "down") downs.push([...args]);
        return base!.spawner!(binary, args, options);
      },
    };
    const reaps: unknown[] = [];
    const result = await runDown({
      ...deps,
      driver,
      stop: seams,
      reap: async (config) => {
        reaps.push(config);
        return { ranCount: 0, failures: [] };
      },
    });
    expect(result).toMatchObject({ shared: false, stopped: true });
    expect(result.forceKilled).toEqual([{ service: "api", pid: 77 }]);
    expect(kills).toEqual([[-77, "SIGKILL"]]);
    // No `process-compose down` against a supervisor that is gone; the
    // stale socket is removed, the marker cleared, and the hooks reaped.
    expect(downs).toEqual([]);
    expect(existsSync(paths.socketPath)).toBe(false);
    expect(readPendingReload(anchorOf(deps), deps.expectedWorktreeId)).toBeUndefined();
    expect(reaps).toHaveLength(1);
  });

  it("a pending-reload DOWN_TIMEOUT's remedy leads with killing the old run, not process-compose (#206)", async () => {
    const deps = stubDeps({ stack: isolatedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    const old = { pid: 77, ppid: PC_PID, pgid: 77, command: "bash -c sleep 300" };
    const { seams, kills } = stopSeams(paths.socketPath, { pcExits: false, extra: [old] });
    // No recorded identity: devtrees never kills it, the operator must.
    writePendingReload(anchorOf(deps), deps.expectedWorktreeId, {
      services: ["api"],
      oldRuns: [{ name: "api", pid: 77, identity: null }],
    });
    const err = (await runDown({
      ...deps,
      driver: stuckDriver(),
      stop: { ...seams, settleMs: 20 },
    }).catch((e: unknown) => e)) as Failure;
    expect(err.code).toBe("DOWN_TIMEOUT");
    expect(kills).toEqual([]);
    const remedy = String(err.details?.remedy);
    expect(remedy).toMatch(/could not verify api \(pid 77\)/);
    expect(remedy).toContain("Kill the old process first (`kill 77`");
    expect(remedy).toContain("then retry `devtrees down`");
    expect(remedy).not.toContain(`kill ${PC_PID}`);
    expect(remedy).not.toContain("stop process-compose by hand");
  });

  it("worktree down fails DOWN_TIMEOUT and keeps the socket and config when process-compose never exits", async () => {
    const deps = stubDeps({ stack: isolatedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    const { seams, kills } = stopSeams(paths.socketPath, { pcExits: false });
    // A pending reload (#191) must survive a DOWN_TIMEOUT: the instance is still up.
    writePendingReload(anchorOf(deps), deps.expectedWorktreeId, PENDING);
    const err = (await runDown({ ...deps, driver: stuckDriver(), stop: seams }).catch(
      (e: unknown) => e,
    )) as Failure;
    expect(err.code).toBe("DOWN_TIMEOUT");
    expect(err.details).toMatchObject({
      instance: deps.expectedWorktreeId,
      socket_path: paths.socketPath,
      process_compose_pid: PC_PID,
      stuck_services: [{ service: "web", pid: WEB_PID }],
      force_killed: [{ service: "web", pid: WEB_PID }],
    });
    expect(String(err.details?.remedy)).toContain(`kill ${PC_PID}`);
    expect(String(err.details?.remedy)).toContain("`devtrees down`");
    expect(classifyError(err).code).toBe("DOWN_TIMEOUT");
    expect(kills).toEqual([[-WEB_PID, "SIGKILL"]]);
    expect(existsSync(paths.socketPath)).toBe(true);
    expect(existsSync(paths.configPath)).toBe(true);
    expect(readPendingReload(anchorOf(deps), deps.expectedWorktreeId)).toEqual(PENDING);
  });

  it("the down budget is the base plus the derived config's shutdown.timeout_seconds", async () => {
    const deps = stubDeps({ stack: isolatedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    writeFileSync(
      paths.configPath,
      stringifyYaml({ processes: { web: { command: "x", shutdown: { timeout_seconds: 1 } } } }),
    );
    const { seams } = stopSeams(paths.socketPath, { pcExits: false });
    const err = (await runDown({ ...deps, driver: stuckDriver(), stop: seams }).catch(
      (e: unknown) => e,
    )) as Failure;
    expect(err.details?.timeout_ms).toBe(1020);
  });

  it("down --shared reports force-killed services", async () => {
    const deps = stubDeps({ stack: mixedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = sharedInstancePaths(anchorOf(deps));
    const { seams } = stopSeams(paths.socketPath, { pcExits: true });
    const result = await runDown({ ...deps, driver: stuckDriver(), stop: seams }, { shared: true });
    expect(result).toEqual({
      shared: true,
      stopped: true,
      forceKilled: [{ service: "web", pid: WEB_PID }],
    });
    expect(existsSync(paths.configPath)).toBe(false);
  });

  it("down --shared fails DOWN_TIMEOUT and keeps the shared config", async () => {
    const deps = stubDeps({ stack: mixedStack, track: { invocations: [], touchSocket: true } });
    await runUp(deps);
    const paths = sharedInstancePaths(anchorOf(deps));
    const { seams } = stopSeams(paths.socketPath, { pcExits: false });
    const err = (await runDown(
      { ...deps, driver: stuckDriver(), stop: seams },
      { shared: true },
    ).catch((e: unknown) => e)) as Failure;
    expect(err.code).toBe("DOWN_TIMEOUT");
    expect(err.details?.instance).toBe("shared");
    expect(String(err.details?.remedy)).toContain("`devtrees down --shared`");
    expect(existsSync(paths.configPath)).toBe(true);
    expect(existsSync(paths.socketPath)).toBe(true);
  });

  /** Prune inputs with only `login` live, so `removed` is an orphan. */
  function pruneInputs(tmp: { anchor: string; worktreeRoot: string }, socketPath: string) {
    return {
      cwd: join(tmp.worktreeRoot, "login"),
      git: (args: ReadonlyArray<string>): string => {
        if (args[1] === "--git-common-dir") return tmp.anchor;
        if (args[1] === "--show-toplevel") return join(tmp.worktreeRoot, "login");
        if (args[1] === "--is-bare-repository") return "false";
        if (args[0] === "worktree") return `worktree ${join(tmp.worktreeRoot, "login")}\nHEAD x\n`;
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      },
      discover: async () => [
        {
          id: "removed",
          kind: "worktree" as const,
          status: "running" as const,
          socketPath,
          ports: {},
          blockBase: undefined,
          services: [],
        },
      ],
      driver: stuckDriver(),
    };
  }

  it("prune reports a force-killed orphan stop on its pruned row", async () => {
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphan = instancePaths(tmp.anchor, "removed");
    writeFileSync(orphan.socketPath, "");
    const { seams } = stopSeams(orphan.socketPath, { pcExits: true });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      ...pruneInputs(tmp, orphan.socketPath),
      readRegistry: () => ({}),
      withRegistryLock: async (_anchor, mutate) => mutate({}),
      stop: seams,
    });
    expect(result.pruned).toEqual([
      expect.objectContaining({ id: "removed", forceKilled: [{ service: "web", pid: WEB_PID }] }),
    ]);
    expect(result.unreclaimed).toEqual([]);
  });

  it("prune forwards an orphan's pending-reload marker to its stop (#206)", async () => {
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphan = instancePaths(tmp.anchor, "removed");
    writeFileSync(orphan.socketPath, "");
    const old = { pid: 77, ppid: PC_PID, pgid: 77, command: "bash -c sleep 300" };
    const { seams, kills } = stopSeams(orphan.socketPath, { pcExits: true, extra: [old] });
    writePendingReload(tmp.anchor, "removed", {
      services: [],
      oldRuns: [
        { name: "api", pid: 77, identity: { ppid: PC_PID, pgid: 77, command: old.command } },
      ],
    });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      ...pruneInputs(tmp, orphan.socketPath),
      readRegistry: () => ({}),
      withRegistryLock: async (_anchor, mutate) => mutate({}),
      stop: seams,
    });
    expect(kills[0]).toEqual([-77, "SIGKILL"]);
    expect(result.pruned).toEqual([
      expect.objectContaining({
        id: "removed",
        forceKilled: [
          { service: "api", pid: 77 },
          { service: "web", pid: WEB_PID },
        ],
      }),
    ]);
    expect(readPendingReload(tmp.anchor, "removed")).toBeUndefined();
  });

  it("prune reclaims, in one pass, an orphan whose process-compose exits while its pending reload settles (#206)", async () => {
    // The orphan's worktree is gone, so the update's new copy cannot start
    // and process-compose exits once the old run is killed.
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphan = instancePaths(tmp.anchor, "removed");
    writeFileSync(orphan.socketPath, "");
    writeFileSync(orphan.configPath, "processes: {}\n");
    const old = { pid: 77, ppid: PC_PID, pgid: 77, command: "bash -c sleep 300" };
    const { seams } = stopSeams(orphan.socketPath, {
      pcExits: false,
      pcExitsOnKill: 77,
      extra: [old],
    });
    writePendingReload(tmp.anchor, "removed", {
      services: ["api"],
      oldRuns: [
        { name: "api", pid: 77, identity: { ppid: PC_PID, pgid: 77, command: old.command } },
      ],
    });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      ...pruneInputs(tmp, orphan.socketPath),
      readRegistry: () => ({}),
      withRegistryLock: async (_anchor, mutate) => mutate({}),
      stop: seams,
    });
    expect(result.unreclaimed).toEqual([]);
    expect(result.pruned).toEqual([
      expect.objectContaining({ id: "removed", forceKilled: [{ service: "api", pid: 77 }] }),
    ]);
    expect(existsSync(orphan.socketPath)).toBe(false);
    expect(existsSync(orphan.configPath)).toBe(false);
    expect(readPendingReload(tmp.anchor, "removed")).toBeUndefined();
  });

  it("prune keeps a running orphan whose bounded down timed out, and reports it unreclaimed", async () => {
    // Unlike an ordinary failed `down`, a DOWN_TIMEOUT proves process-compose
    // is still running: unlinking its socket would hide a live supervisor.
    const tmp = tmpAnchor();
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphan = instancePaths(tmp.anchor, "removed");
    writeFileSync(orphan.socketPath, "");
    writeFileSync(orphan.configPath, "processes: {}\n");
    const registryRef = { snapshot: { removed: 20032 } as RegistrySnapshot };
    const { seams } = stopSeams(orphan.socketPath, { pcExits: false });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      ...pruneInputs(tmp, orphan.socketPath),
      readRegistry: () => registryRef.snapshot,
      withRegistryLock: async (_anchor, mutate) => {
        registryRef.snapshot = await mutate(registryRef.snapshot);
        return registryRef.snapshot;
      },
      stop: seams,
    });
    expect(result.pruned).toEqual([]);
    expect(result.unreclaimed).toEqual([
      expect.objectContaining({ id: "removed", socketPath: orphan.socketPath }),
    ]);
    expect(result.unreclaimed[0]?.message).toMatch(/did not stop within/);
    expect(result.unreclaimed[0]?.message).toContain("`devtrees prune`");
    expect(result.unreclaimed[0]?.forceKilled).toEqual([{ service: "web", pid: WEB_PID }]);
    expect(existsSync(orphan.socketPath)).toBe(true);
    expect(existsSync(orphan.configPath)).toBe(true);
    expect(registryRef.snapshot.removed).toBe(20032);
  });
});

// Issue #155: `down` reported "worktree instance stopped" and exited 0 while a
// daemon's containers (its shutdown hook skipped by process-compose) and a
// SIGTERM-ignoring grandchild kept their ports.
describe("runDown after process-compose stops (#155)", () => {
  const stack: ResolvedStack = {
    services: [
      {
        ...isolated("db", "start-db.sh", ["DB_PORT"]),
        isDaemon: true,
        shutdown: { command: "stop-db.sh" },
      },
      {
        ...isolated("cache", "start-cache.sh", ["CACHE_PORT"]),
        isDaemon: true,
        shutdown: { command: "stop-cache.sh" },
      },
      isolated("web", "node web.js", ["WEB_PORT"]),
    ],
  };

  /** `stack`, with a hook on `web` too (a service that is not a daemon). */
  const hooked: ResolvedStack = {
    services: stack.services.map((svc) =>
      svc.name === "web" ? { ...svc, shutdown: { command: "stop-web.sh" } } : svc,
    ),
  };

  /** A live instance whose `process list` reads `rows`. */
  async function liveInstance(
    rows: ReadonlyArray<{ name: string; status: string; exit_code?: number }>,
    declared: ResolvedStack = stack,
  ) {
    const deps = stubDeps({ stack: declared, track: { invocations: [], touchSocket: true } });
    const up = await runUp(deps);
    const base = deps.driver;
    const spawner: NonNullable<CommandDeps["driver"]>["spawner"] = (binary, args, options) => {
      if (args[0] !== "process" || args[1] !== "list") {
        return base?.spawner?.(binary, args, options) ?? spawnedOk();
      }
      const emitter = new EventEmitter() as EventEmitter & { stdout: Readable };
      const listed = rows.map((r) => ({ ...r, is_ready: "-", is_running: false }));
      emitter.stdout = Readable.from([JSON.stringify(listed)]);
      emitter.stdout.on("end", () => queueMicrotask(() => emitter.emit("exit", 0)));
      return emitter as unknown as SpawnedProcess;
    };
    const reaped: string[][] = [];
    const reap: CommandDeps["reap"] = async (config) => {
      reaped.push(Object.keys(config.processes));
      return { ranCount: Object.keys(config.processes).length, failures: [] };
    };
    const port = (name: string): number => Number(up.env[name]);
    return { deps: { ...deps, driver: { ...base, spawner }, reap }, reaped, port };
  }

  it("runs the shutdown hook of a daemon whose launch had failed, and only that one", async () => {
    const { deps, reaped } = await liveInstance([
      { name: "db", status: "Completed", exit_code: 1 },
      { name: "cache", status: "Launched" },
      { name: "web", status: "Running" },
    ]);
    const result = await runDown(deps);
    expect(result).toMatchObject({ shared: false, stopped: true });
    // process-compose ran cache's hook itself; db's it skipped.
    expect(reaped).toEqual([["db"]]);
  });

  it("runs the hook of a daemon in Error (it could not start)", async () => {
    const { deps, reaped } = await liveInstance([
      { name: "db", status: "Error" },
      { name: "web", status: "Running" },
    ]);
    await runDown(deps);
    expect(reaped).toEqual([["db"]]);
  });

  it("never re-runs the hook of a daemon stopped earlier (Completed, exit 0: its hook already ran)", async () => {
    const { deps, reaped } = await liveInstance([
      { name: "db", status: "Completed", exit_code: 0 },
      { name: "cache", status: "Completed" },
      { name: "web", status: "Running" },
    ]);
    await runDown(deps);
    expect(reaped).toEqual([]);
  });

  it("never runs a hook for a failed service that is not a daemon", async () => {
    // `web` has a hook and failed: only the is_daemon filter keeps it out.
    const { deps, reaped } = await liveInstance(
      [{ name: "web", status: "Completed", exit_code: 1 }],
      hooked,
    );
    await runDown(deps);
    expect(reaped).toEqual([]);
  });

  it("runs no hook when every daemon was still launched", async () => {
    const { deps, reaped } = await liveInstance([
      { name: "db", status: "Launched" },
      { name: "web", status: "Running" },
    ]);
    await runDown(deps);
    expect(reaped).toEqual([]);
  });

  it("fails DOWN_INCOMPLETE naming a booted service's port that still accepts connections", async () => {
    const { deps, port } = await liveInstance([
      { name: "db", status: "Completed" },
      { name: "web", status: "Running" },
    ]);
    const dbPort = port("DB_PORT");
    const err = (await runDown({
      ...deps,
      portAccepts: async (p) => p === dbPort,
      identifyPortHolder: () => ({ pid: 4242, command: "OrbStack Helper" }),
    }).catch((e: unknown) => e)) as Error & { code?: string; details?: Record<string, unknown> };
    expect(err.code).toBe("DOWN_INCOMPLETE");
    expect(err.details?.survivors).toEqual([
      {
        service: "db",
        pid: 4242,
        command: "OrbStack Helper",
        port_name: "DB_PORT",
        port: dbPort,
        port_forwarder: true,
      },
    ]);
    expect(err.message).toContain(`db DB_PORT ${dbPort}: pid 4242 (OrbStack Helper)`);
    // A shared port forwarder is never offered up for killing.
    expect(err.message).toContain(`docker ps --filter publish=${dbPort}`);
    expect(err.message).toContain("never this process");
    expect(err.message).not.toMatch(/kill 4242/);
  });

  it("a second down re-checks the ports and fails again while the listener survives, then converges", async () => {
    const { deps, port } = await liveInstance([
      { name: "db", status: "Completed", exit_code: 1 },
      { name: "web", status: "Running" },
    ]);
    const dbPort = port("DB_PORT");
    let listening = true;
    const seams = {
      ...deps,
      portAccepts: async (p: number) => listening && p === dbPort,
      identifyPortHolder: () => ({ pid: 4242, command: "python3" }),
    };
    const first = (await runDown(seams).catch((e: unknown) => e)) as { code?: string };
    expect(first.code).toBe("DOWN_INCOMPLETE");
    // process-compose is gone now: the next `down` takes the dead-supervisor path.
    const dead = { ...seams, probeSocket: async () => "stale" as const };
    const second = (await runDown(dead).catch((e: unknown) => e)) as {
      code?: string;
      details?: { survivors?: unknown[] };
    };
    expect(second.code).toBe("DOWN_INCOMPLETE");
    expect(second.details?.survivors).toMatchObject([{ service: "db", port: dbPort }]);
    // Once the listener is gone, the same `down` succeeds, and stays succeeded.
    listening = false;
    await expect(runDown(dead)).resolves.toMatchObject({ stopped: false });
    listening = true;
    await expect(runDown(dead)).resolves.toMatchObject({ stopped: false });
  });

  it("waits for a port that closes shortly after the stop instead of reporting it", async () => {
    const { deps, port } = await liveInstance([{ name: "web", status: "Running" }]);
    let checks = 0;
    const result = await runDown({
      ...deps,
      portSettleMs: 2_000,
      // Still open on the first check, closed on the next.
      portAccepts: async (p) => p === port("WEB_PORT") && checks++ === 0,
    });
    expect(result).toMatchObject({ stopped: true });
    expect(checks).toBe(2);
  });

  it("never checks the ports of a service the instance did not boot", async () => {
    const { deps, port } = await liveInstance([{ name: "web", status: "Running" }]);
    const probed: number[] = [];
    await runDown({
      ...deps,
      portAccepts: async (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toEqual([port("WEB_PORT")]);
  });
});

describe("STALE_PORT_BLOCK holders that refuse connections (#155)", () => {
  const stack: ResolvedStack = {
    services: [isolated("web", "node web.js", ["WEB_PORT"]), isolated("api", "x", ["API_PORT"])],
  };

  it("does not fail up when every holder refuses connections; it warns instead", async () => {
    const warnings: string[] = [];
    const deps: CommandDeps = {
      ...stubDeps({ stack, warn: (m) => warnings.push(m) }),
      portHolder: async () => ({ free: false as const, pid: 77, command: "OrbStack Helper" }),
      portAccepts: async () => false,
    };
    await runUp(deps);
    const warning = warnings.find((w) => w.includes("refuses connections"));
    expect(warning).toBeDefined();
    expect(warning).toContain("pid 77 (OrbStack Helper)");
    expect(warning).toContain("do not kill it");
  });

  it("fails when one holder accepts, labelling the refusing one and a port forwarder not to kill", async () => {
    const holders: Record<string, { pid: number; command: string }> = {};
    const deps: CommandDeps = {
      ...stubDeps({ stack }),
      portHolder: async (port) => {
        const h = holders[String(port)] ?? { pid: port, command: "OrbStack Helper" };
        return { free: false as const, ...h };
      },
      portAccepts: async () => true,
    };
    const first = (await runUp(deps).catch((e: unknown) => e)) as Error & {
      details?: { collisions: Array<{ port: number; port_name: string }> };
    };
    const ports = first.details!.collisions;
    const web = ports.find((c) => c.port_name === "WEB_PORT")!.port;
    const api = ports.find((c) => c.port_name === "API_PORT")!.port;
    holders[String(web)] = { pid: 4242, command: "node stale.mjs" };
    const err = (await runUp({
      ...deps,
      portAccepts: async (port) => port === web,
    }).catch((e: unknown) => e)) as Error & {
      code?: string;
      details?: { collisions: Array<{ port: number; accepts_connections: boolean }> };
    };
    expect(err.code).toBe("STALE_PORT_BLOCK");
    expect(err.details?.collisions.map((c) => [c.port, c.accepts_connections])).toEqual([
      [web, true],
      [api, false],
    ]);
    expect(err.message).toContain(`WEB_PORT ${web}: pid 4242 (node stale.mjs)\n`);
    expect(err.message).toMatch(
      new RegExp(`API_PORT ${api}: pid ${api} .*refuses connections.*do not kill it`),
    );
    // An accepting port forwarder is labelled too (#217's wildcard probe sees OrbStack forwards).
    expect(first.message).toContain("never this process");
  });
});

/**
 * Namespaced shared services and selection-scoped SHARED_DRIFT (#236,
 * ADR-0010). One shared instance still serves every worktree; a shared
 * service with a `namespace:` joins it only once an `up` selects that
 * namespace, and drift is checked only for the shared services an `up`
 * selects.
 */
describe("runUp / runEnv / runUpDryRun — namespaced shared services (#236)", () => {
  const inNs = <S extends ResolvedService>(service: S, namespace: string): S => ({
    ...service,
    namespace,
  });
  // `postgres` is always on; `db-shared` (shared) and `db` (isolated) are the
  // two database tiers a consumer picks between with `-n`.
  const stackOf = (dbSharedCommand = "supabase start"): ResolvedStack => ({
    services: [
      shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
      inNs(shared("db-shared", dbSharedCommand, ["SB_PORT"]), "db-shared"),
      inNs(isolated("db", "supabase start --isolated", ["ISO_DB_PORT"]), "db"),
      inNs(isolated("api", "node api.js", ["API_PORT"]), "app"),
    ],
  });
  const base = stackOf();
  const drifted = stackOf("supabase start --debug");
  const runningRow = (name: string): ServiceStatus => ({
    name,
    status: "Running",
    health: "ready",
  });

  type Fixture = ReturnType<typeof multiWorktreeFixture>;

  /**
   * Deps for one worktree against a shared fixture, recording every
   * hot-reload request. The worktree's own project reports its selected
   * isolated services as running; the shared one reports what its derived
   * config lists.
   */
  function wt(
    fixture: Fixture,
    stack: ResolvedStack,
    worktreeId: string,
    opts: { reloadStatus?: number; namespaces?: string[]; track?: StubSpawn } = {},
  ) {
    const reloads: ControlRequest[] = [];
    const track = opts.track ?? { invocations: [], touchSocket: true };
    const deps = stubDeps({
      stack,
      worktreeId,
      anchorOverride: fixture.sharedAnchor,
      worktreeRootOverride: fixture.wtRoot,
      registryRef: fixture.registryRef,
      track,
    });
    const sharedConfig = sharedInstancePaths(fixture.sharedAnchor).configPath;
    const withDriver: CommandDeps = {
      ...deps,
      ...(opts.namespaces !== undefined ? { namespaces: opts.namespaces } : {}),
      driver: {
        ...deps.driver,
        controlRequest: reloadAnswering(opts.reloadStatus ?? 200, reloads),
      },
      getServiceStatuses: async (socketPath) => {
        if (socketPath.endsWith("/shared.sock")) {
          return Object.keys(sharedProcesses(sharedConfig)).map(runningRow);
        }
        const ns = opts.namespaces ?? [];
        return stack.services
          .filter((s) => s.tier === "isolated" && ns.includes(String(s.namespace)))
          .map((s) => runningRow(s.name));
      },
    };
    return { deps: withDriver, reloads, track };
  }

  function sharedProcesses(configPath: string): Record<string, unknown> {
    if (!existsSync(configPath)) return {};
    const doc = parseYaml(readFileSync(configPath, "utf8")) as { processes?: object };
    return (doc.processes ?? {}) as Record<string, unknown>;
  }

  const sharedConfigOf = (fixture: Fixture) =>
    sharedProcesses(sharedInstancePaths(fixture.sharedAnchor).configPath);

  async function failure(p: Promise<unknown>) {
    return p.then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
  }

  it("an up that does not select a namespaced shared service does not start it", async () => {
    const fixture = multiWorktreeFixture("dt-nss-unselected-");
    const result = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);

    expect(result.sharedStarted).toBe(true);
    expect(Object.keys(sharedConfigOf(fixture))).toEqual(["postgres"]);
    expect(Object.keys(readSharedState(fixture.sharedAnchor)?.services ?? {})).toEqual([
      "postgres",
    ]);
    // Connection info is still injected for every shared service (unchanged).
    expect(result.env.SB_PORT).toBeDefined();
  });

  it("a fresh up selecting the namespace starts the shared service with the shared instance", async () => {
    const fixture = multiWorktreeFixture("dt-nss-fresh-");
    const result = await runUp(
      wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps,
    );
    expect(result.sharedStarted).toBe(true);
    expect(result.sharedActivated).toEqual([]);
    expect(Object.keys(sharedConfigOf(fixture))).toEqual(["postgres", "db-shared"]);
  });

  it("with only namespaced shared services and none selected, the shared instance is not started", async () => {
    const fixture = multiWorktreeFixture("dt-nss-none-");
    const onlyNamespaced: ResolvedStack = {
      services: base.services.filter((s) => s.name !== "postgres"),
    };
    const { deps, track } = wt(fixture, onlyNamespaced, "login", { namespaces: ["app", "db"] });
    const result = await runUp(deps);
    expect(result.sharedStarted).toBe(false);
    expect(track.invocations.some((i) => i.socketPath.endsWith("/shared.sock"))).toBe(false);
  });

  it("a later up selecting it adds it to the running shared instance, leaving the others as they were", async () => {
    const fixture = multiWorktreeFixture("dt-nss-activate-");
    const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
    const postgresBefore = sharedConfigOf(fixture).postgres;

    const second = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
    const result = await runUp(second.deps);

    expect(result.sharedStarted).toBe(false);
    expect(result.sharedActivated).toEqual(["db-shared"]);
    // One reload, sent to the shared instance: process-compose re-reads its config.
    expect(second.reloads).toHaveLength(1);
    expect(second.reloads[0]).toMatchObject({
      socketPath: sharedInstancePaths(fixture.sharedAnchor).socketPath,
      method: "POST",
      path: "/project/configuration",
    });
    // No second shared spawn, and postgres's process is byte-for-byte unchanged,
    // so the reload leaves it running.
    expect(second.track.invocations.some((i) => i.socketPath.endsWith("/shared.sock"))).toBe(false);
    const after = sharedConfigOf(fixture);
    expect(Object.keys(after)).toEqual(["postgres", "db-shared"]);
    expect(after.postgres).toEqual(postgresBefore);
    // The port the first worktree was told about is the one that was bound.
    expect(result.env.SB_PORT).toBe(first.env.SB_PORT);
    const state = readSharedState(fixture.sharedAnchor);
    expect(state?.ports.SB_PORT).toBe(Number(first.env.SB_PORT));
    expect(state?.services?.["db-shared"]?.hash).toBe(
      sharedServiceHash(base.services[1] as ResolvedService),
    );
    // The pre-#236 hash stays the always-on subset's, so an older devtrees
    // beside this one keeps matching.
    expect(state?.hash).toBe(sharedStackHash({ services: [base.services[0] as ResolvedService] }));
  });

  it("an up that already finds it running adds nothing", async () => {
    const fixture = multiWorktreeFixture("dt-nss-noop-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);
    const second = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
    const result = await runUp(second.deps);
    expect(result.sharedActivated).toEqual([]);
    expect(second.reloads).toEqual([]);
  });

  it("drift in a namespaced shared service does not block an up that does not select it", async () => {
    const fixture = multiWorktreeFixture("dt-nss-drift-scoped-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);

    const result = await runUp(wt(fixture, drifted, "billing", { namespaces: ["app", "db"] }).deps);
    expect(result.sharedStarted).toBe(false);

    const env = await runEnv(wt(fixture, drifted, "billing").deps);
    expect(env.env.SB_PORT).toBe(String(readSharedState(fixture.sharedAnchor)?.ports.SB_PORT));
  });

  it("drift in a namespaced shared service fails an up that selects it, naming only that service", async () => {
    const fixture = multiWorktreeFixture("dt-nss-drift-selected-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);

    const track: StubSpawn = { invocations: [], touchSocket: true };
    const err = await failure(
      runUp(wt(fixture, drifted, "billing", { namespaces: ["app", "db-shared"], track }).deps),
    );
    expect(err?.code).toBe("SHARED_DRIFT");
    expect(err?.message).toMatch(
      /'db-shared' \(running [0-9a-f]{12}, this worktree [0-9a-f]{12}\)/,
    );
    expect(err?.message).not.toMatch(/'postgres'/);
    expect(err?.details?.services).toEqual([
      {
        service: "db-shared",
        running_hash: sharedServiceHash(base.services[1] as ResolvedService),
        local_hash: sharedServiceHash(drifted.services[1] as ResolvedService),
      },
    ]);
    expect(err?.details?.remedy).toBe("devtrees down --shared && devtrees up");
    // Nothing was spawned for the divergent worktree.
    expect(track.invocations).toEqual([]);
  });

  it("a bare up on a running instance re-selects the namespaced shared services of the namespaces it booted", async () => {
    const fixture = multiWorktreeFixture("dt-nss-bare-");
    // `db-shared` shares the `app` namespace with an isolated service here, so
    // the boot selection is observable in the worktree project.
    const appShared = (cmd: string): ResolvedStack => ({
      services: [
        shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
        inNs(shared("db-shared", cmd, ["SB_PORT"]), "app"),
        inNs(isolated("api", "node api.js", ["API_PORT"]), "app"),
        isolated("web", "node web.js", ["WEB_PORT"]),
      ],
    });
    await runUp(wt(fixture, appShared("supabase start"), "login", { namespaces: ["app"] }).deps);

    // A worktree booted with `-n app`, now on a branch that edited `db-shared`:
    // its bare re-up reads `app` back and so checks `db-shared`.
    await runUp(wt(fixture, appShared("supabase start"), "billing", { namespaces: ["app"] }).deps);
    const bare = wt(fixture, appShared("supabase start --debug"), "billing");
    const boot = bare.deps.getServiceStatuses;
    const err = await failure(
      runUp({
        ...bare.deps,
        getServiceStatuses: async (socketPath) =>
          socketPath.endsWith("/shared.sock") ? (boot?.(socketPath) ?? []) : [runningRow("api")],
      }),
    );
    expect(err?.code).toBe("SHARED_DRIFT");

    // A worktree booted without `app` is not affected by the same edit.
    await runUp(wt(fixture, appShared("supabase start"), "orders").deps);
    const other = wt(fixture, appShared("supabase start --debug"), "orders");
    const ok = await runUp({
      ...other.deps,
      getServiceStatuses: async (socketPath) =>
        socketPath.endsWith("/shared.sock")
          ? (other.deps.getServiceStatuses?.(socketPath) ?? [])
          : [runningRow("web")],
    });
    expect(ok.sharedActivated).toEqual([]);
  });

  it("a selected shared service's shared dependency is selected with it", async () => {
    const fixture = multiWorktreeFixture("dt-nss-closure-");
    const withDep: ResolvedStack = {
      services: [
        inNs(shared("auth-shared", "gotrue", ["AUTH_PORT"]), "auth"),
        {
          ...inNs(shared("db-shared", "supabase start", ["SB_PORT"]), "db-shared"),
          dependsOn: [{ name: "auth-shared" }],
        },
        inNs(isolated("api", "node api.js", ["API_PORT"]), "app"),
      ],
    };
    await runUp(wt(fixture, withDep, "login", { namespaces: ["app", "db-shared"] }).deps);
    expect(Object.keys(sharedConfigOf(fixture))).toEqual(["auth-shared", "db-shared"]);
  });

  it("a refused reload fails SHARED_ACTIVATION_FAILED, restores the shared config and records nothing", async () => {
    const fixture = multiWorktreeFixture("dt-nss-refused-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
    const configPath = sharedInstancePaths(fixture.sharedAnchor).configPath;
    const before = readFileSync(configPath, "utf8");

    const err = await failure(
      runUp(
        wt(fixture, base, "billing", { namespaces: ["app", "db-shared"], reloadStatus: 500 }).deps,
      ),
    );
    expect(err?.code).toBe("SHARED_ACTIVATION_FAILED");
    expect(err?.details).toMatchObject({ services: ["db-shared"], reason: "error" });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(readSharedState(fixture.sharedAnchor)?.services?.["db-shared"]).toBeUndefined();
    expect(classifyError(err as Error).code).toBe("SHARED_ACTIVATION_FAILED");
  });

  it("a not-yet-running service whose port a running shared service owns is SHARED_DRIFT", async () => {
    const fixture = multiWorktreeFixture("dt-nss-port-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);
    // A branch that renamed `db-shared` but kept its port name.
    const renamed: ResolvedStack = {
      services: base.services.map((s) => (s.name === "db-shared" ? { ...s, name: "supabase" } : s)),
    };
    const err = await failure(
      runUp(wt(fixture, renamed, "billing", { namespaces: ["app", "db-shared"] }).deps),
    );
    expect(err?.code).toBe("SHARED_DRIFT");
    expect(err?.details?.port_conflicts).toEqual([
      { service: "supabase", port: "SB_PORT", owner: "db-shared" },
    ]);
  });

  it("drift in an always-on shared service still fails every up and env", async () => {
    const fixture = multiWorktreeFixture("dt-nss-always-on-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
    const edited: ResolvedStack = {
      services: base.services.map((s) =>
        s.name === "postgres" ? { ...s, command: "postgres -D ./other" } : s,
      ),
    };
    const err = await failure(
      runUp(wt(fixture, edited, "billing", { namespaces: ["app", "db"] }).deps),
    );
    expect(err?.code).toBe("SHARED_DRIFT");
    expect((await failure(runEnv(wt(fixture, edited, "billing").deps)))?.code).toBe("SHARED_DRIFT");
  });

  describe("a shared-state.json written before #236 (no per-service records)", () => {
    function legacy(fixture: Fixture, hash: string): void {
      const state = readSharedState(fixture.sharedAnchor);
      if (state === undefined) throw new Error("expected shared state");
      writeFileSync(
        join(fixture.sharedAnchor, "devtrees", "shared-state.json"),
        JSON.stringify({ hash, ports: state.ports }),
        "utf8",
      );
    }

    it("is attributed to this worktree's definitions when they match it, so adding a service works", async () => {
      const fixture = multiWorktreeFixture("dt-nss-legacy-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      legacy(fixture, sharedStackHash({ services: [base.services[0] as ResolvedService] }));

      const result = await runUp(
        wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] }).deps,
      );
      expect(result.sharedActivated).toEqual(["db-shared"]);
      expect(Object.keys(readSharedState(fixture.sharedAnchor)?.services ?? {})).toEqual([
        "postgres",
        "db-shared",
      ]);
    });

    it("drifts with an unknown revision when they do not match it", async () => {
      const fixture = multiWorktreeFixture("dt-nss-legacy-drift-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      legacy(fixture, "not-this-stack");

      const err = await failure(
        runUp(wt(fixture, base, "billing", { namespaces: ["app", "db"] }).deps),
      );
      expect(err?.code).toBe("SHARED_DRIFT");
      expect(err?.message).toMatch(/'postgres' \(running unknown/);
    });
  });

  it("up --dry-run reports the shared services the selection includes and previews only those", async () => {
    const fixture = multiWorktreeFixture("dt-nss-dry-");
    const without = await runUpDryRun(
      wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps,
    );
    expect(without.selectedSharedServices).toEqual(["postgres"]);
    expect(Object.keys(without.sharedConfig?.processes ?? {})).toEqual(["postgres"]);

    const withShared = await runUpDryRun(
      wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps,
    );
    expect(withShared.selectedSharedServices).toEqual(["postgres", "db-shared"]);
    expect(Object.keys(withShared.sharedConfig?.processes ?? {})).toEqual([
      "postgres",
      "db-shared",
    ]);
  });
});
