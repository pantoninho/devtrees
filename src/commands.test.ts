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

import { afterEach, describe, expect, it } from "vite-plus/test";
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
import { join } from "node:path";
import { Readable } from "node:stream";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  findUnmanagedPortBinds,
  runAttach,
  runDown,
  runEnv,
  runGenerate,
  runLogs,
  runUp,
  type CommandDeps,
  type WithSharedLock,
} from "./commands.js";
import { deriveSharedConfig, deriveWorktreeConfig } from "./deriver.js";
import type { RegistrySnapshot } from "./allocator.js";
import type { SpawnedProcess } from "./driver.js";
import { SHARED_REGISTRY_KEY } from "./paths.js";
import type { ResolvedStack } from "./stack.js";

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
  return { name, tier, command, ports, dependsOn: [] as string[], environment: [] as string[] };
}
const isolated = (name: string, command: string, ports: string[] = []) =>
  service(name, command, ports, "isolated");
const shared = (name: string, command: string, ports: string[] = []) =>
  service(name, command, ports, "shared");

function tmpAnchor(): { anchor: string; worktreeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "dt-cmd-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { anchor: join(root, ".git"), worktreeRoot: join(root, "wt") };
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

/** Build a `CommandDeps` whose every collaborator is a deterministic stub. */
function stubDeps(opts: {
  stack: ResolvedStack;
  worktreeId?: string;
  initialRegistry?: RegistrySnapshot;
  isPortFree?: (port: number) => boolean;
  warn?: (m: string) => void;
  /**
   * Tracker for `process-compose up` invocations + a flag to make the stub
   * spawner touch the socket file (so the shared lazy-start sees it as running).
   */
  track?: StubSpawn;
  anchorOverride?: string;
  worktreeRootOverride?: string;
  registryRef?: { snapshot: RegistrySnapshot };
}): CommandDeps {
  const tmp = tmpAnchor();
  const anchor = opts.anchorOverride ?? tmp.anchor;
  const worktreeRoot = opts.worktreeRootOverride ?? tmp.worktreeRoot;
  const worktreeId = opts.worktreeId ?? "login";
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
    cwd: join(worktreeRoot, worktreeId),
    git,
    readStack: () => opts.stack,
    withRegistryLock: (_anchor, mutate) => {
      const after = mutate(snapshotRef.snapshot);
      snapshotRef.snapshot = after;
      return after;
    },
    readRegistry: () => snapshotRef.snapshot,
    withSharedLock: passThroughSharedLock,
    isPortFree: opts.isPortFree ?? (() => true),
    warn: opts.warn,
    attach: false,
    // Tests that don't care about the worktree health-wait (#28) get a no-op
    // stub — the default polls a real `process-compose` over the UDS, which
    // would hang the unit test. Tests that *do* care override this field.
    waitForHealth: () => Promise.resolve(),
    // Driver that records every spawn but doesn't actually run anything.
    driver: {
      exists: () => Promise.resolve(true),
      spawner: makeStubSpawner(track),
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
    const result = await runUp(
      stubDeps({ stack: singleWebStack, initialRegistry: { login: 30000 } }),
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
    const lock = (_a: string, m: (s: RegistrySnapshot) => RegistrySnapshot) => {
      const after = m(snapshot);
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
      services: [isolated("web", "node server.js --port ${WEB_PORT}", ["WEB_PORT"])],
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

describe("runUp — cross-tier wiring (ADR-0003)", () => {
  /** isolated `web` depends on shared `postgres` — the canonical cross-tier edge. */
  const crossTierStack: ResolvedStack = {
    services: [
      {
        name: "web",
        tier: "isolated",
        command: "node server.js",
        ports: ["WEB_PORT"],
        dependsOn: ["postgres"],
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
          dependsOn: ["api"],
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
    const deps: CommandDeps = {
      ...stubDeps({ stack: twoIsolated, track }),
      waitForHealth: async ({ socketPath }) => {
        seen.push(socketPath);
      },
    };
    await runUp(deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/login\.sock$/);
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

  it("on health timeout: throws HEALTH_TIMEOUT and does NOT attach the TUI", async () => {
    // ADR-0005: timeout exits non-zero, leaves the stack running, agent can
    // then call `devtrees logs <service>` to inspect. So the worktree's
    // `process-compose down` must NOT be invoked from this path.
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    const sawAttach = { called: false };
    const sawDown = { called: false };
    const deps: CommandDeps = {
      ...baseDeps,
      attach: true, // force attach so we can prove the timeout skipped it
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

  it("attaches after a successful wait when deps.attach is true", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const baseDeps = stubDeps({ stack: twoIsolated, track });
    const inner = baseDeps.driver?.spawner;
    if (inner === undefined) throw new Error("expected stub spawner");

    const order: string[] = [];
    const deps: CommandDeps = {
      ...baseDeps,
      attach: true,
      waitForHealth: async () => {
        order.push("wait");
      },
      driver: {
        ...baseDeps.driver,
        spawner: (binary, args, options) => {
          if (args[0] === "attach") order.push("attach");
          return inner(binary, args, options);
        },
      },
    };
    await runUp(deps);
    expect(order).toEqual(["wait", "attach"]);
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

  it("runDown(--shared) tears down the shared instance and clears its registry entry", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: true };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = stubDeps({ stack: mixedStack, track, registryRef });
    await runUp(deps);

    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBeDefined();
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
    // The shared registry entry is cleared so `ls` and re-`up` reflect the down.
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBeUndefined();
  });

  it("runDown(--shared) is a tidy no-op when the shared instance is not running", async () => {
    const deps = stubDeps({ stack: mixedStack });
    // No prior `up` — the socket doesn't exist.
    await runDown(deps, { shared: true });
    // Nothing thrown; registry still has no shared entry.
  });
});

describe("runGenerate — emit derived configs to disk", () => {
  it("writes the worktree-isolated config to <anchor>/devtrees/<worktreeId>.yaml and its YAML matches the deriver's output", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js", ["WEB_PORT", "METRICS_PORT"])],
    };
    const deps = stubDeps({ stack });
    const result = await runGenerate(deps);

    // The emitted path is the same one runUp would write (acceptance: runnable with raw process-compose).
    expect(result.worktreePath).toMatch(/devtrees\/login\.yaml$/);
    expect(existsSync(result.worktreePath)).toBe(true);

    // Re-derive with the same allocation and assert byte-equivalent content.
    const expected = deriveWorktreeConfig(stack, {
      worktreeId: "login",
      worktreeRoot: result.worktreeRoot,
      portFor: (name) => (result.env[name] !== undefined ? Number(result.env[name]) : undefined),
    });
    const onDisk = parseYaml(readFileSync(result.worktreePath, "utf8"));
    expect(onDisk).toEqual(expected.config);
  });

  it("also writes the shared subset to <anchor>/devtrees/shared.yaml and its YAML matches the shared deriver's output", async () => {
    const mixedStack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
      ],
    };
    const result = await runGenerate(stubDeps({ stack: mixedStack }));

    expect(result.sharedPath).toBeDefined();
    expect(result.sharedPath).toMatch(/devtrees\/shared\.yaml$/);
    if (!result.sharedPath) throw new Error("expected sharedPath");
    expect(existsSync(result.sharedPath)).toBe(true);
    if (!result.sharedEnv) throw new Error("expected sharedEnv");

    const expected = deriveSharedConfig(mixedStack, {
      workingDir: result.sharedPath.replace(/\/devtrees\/shared\.yaml$/, ""),
      portFor: (name) =>
        result.sharedEnv?.[name] !== undefined ? Number(result.sharedEnv[name]) : undefined,
    });
    const onDisk = parseYaml(readFileSync(result.sharedPath, "utf8"));
    expect(onDisk).toEqual(expected.config);

    // The worktree config also reflects shared ports injected as connection info.
    expect(result.env.DB_PORT).toBe(result.sharedEnv.DB_PORT);
  });

  it("omits the shared file when the stack declares no shared services", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runGenerate(stubDeps({ stack }));

    expect(result.sharedPath).toBeUndefined();
    expect(result.sharedEnv).toBeUndefined();
    // The directory contains only the worktree config, not shared.yaml.
    const sharedYaml = result.worktreePath.replace(/login\.yaml$/, "shared.yaml");
    expect(existsSync(sharedYaml)).toBe(false);
  });

  it("does not spawn process-compose (generate is a write-only command)", async () => {
    const track: StubSpawn = { invocations: [], touchSocket: false };
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    await runGenerate(stubDeps({ stack, track }));
    expect(track.invocations).toEqual([]);
  });

  it("strips the devtrees-only `tier` key — emitted YAML is clean process-compose", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    const result = await runGenerate(stubDeps({ stack }));

    const wt = parseYaml(readFileSync(result.worktreePath, "utf8")) as {
      processes: Record<string, Record<string, unknown>>;
    };
    for (const proc of Object.values(wt.processes)) {
      expect("tier" in proc).toBe(false);
    }
    if (!result.sharedPath) throw new Error("expected sharedPath");
    const sh = parseYaml(readFileSync(result.sharedPath, "utf8")) as {
      processes: Record<string, Record<string, unknown>>;
    };
    for (const proc of Object.values(sh.processes)) {
      expect("tier" in proc).toBe(false);
    }
  });

  it("persists the worktree's block in the registry so a subsequent up reuses it", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = stubDeps({ stack, registryRef });

    const generated = await runGenerate(deps);
    expect(registryRef.snapshot.login).toBeGreaterThanOrEqual(20000);

    // The follow-up `up` against the same registry sees the same block.
    const upped = await runUp(deps);
    expect(upped.env.WEB_PORT).toBe(generated.env.WEB_PORT);
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
    const paths = {
      configPath: join(tmp.anchor, "devtrees", `${worktreeId}.yaml`),
      socketPath: join(tmp.anchor, "devtrees", "run", `${worktreeId}.sock`),
    };
    // Mimic a running instance: the control socket file exists.
    mkdtempSync(join(tmpdir(), "dt-noop-")); // (no-op; keep symmetric with other tests)
    // Use the actual path layout — create the directory and socket file.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmp.anchor, "devtrees", "run"), { recursive: true });
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
    const sharedSocket = join(tmp.anchor, "devtrees", "run", "shared.sock");
    mkdirSync(join(tmp.anchor, "devtrees", "run"), { recursive: true });
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
      status?: "running" | "stale";
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
      discover: async () => [instance("login"), instance("billing")],
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
    mkdirSync(join(tmp.anchor, "devtrees", "run"), { recursive: true });
    const orphanSocket = join(tmp.anchor, "devtrees", "run", "removed.sock");
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
        instance("login", { status: "running", socketPath: "/x/login.sock" }),
        instance("removed", {
          status: "running",
          socketPath: orphanSocket,
        }),
      ],
      withRegistryLock: (_anchor, mutate) => {
        const after = mutate(registryRef.snapshot);
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

  it("cleans up a stale orphan (socket file with no listener) without calling driver.down", async () => {
    // When the process-compose has already died, there is nothing to stop —
    // just leftover files to clear. The driver should not be invoked.
    const tmp = tmpAnchor();
    mkdirSync(join(tmp.anchor, "devtrees", "run"), { recursive: true });
    const orphanSocket = join(tmp.anchor, "devtrees", "run", "removed.sock");
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
      withRegistryLock: (_anchor, mutate) => {
        const after = mutate(registryRef.snapshot);
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
      discover: async () => [instance("login", { status: "stale" })],
    });
    expect(result.pruned).toEqual([]);
  });

  it("continues pruning the rest when one orphan's driver.down fails", async () => {
    // A best-effort cleanup: if `process-compose down` errors (binary gone,
    // socket already half-dead), prune still removes anchor state and moves
    // on. The whole point of prune is to reclaim stale state.
    const tmp = tmpAnchor();
    mkdirSync(join(tmp.anchor, "devtrees", "run"), { recursive: true });
    const a = join(tmp.anchor, "devtrees", "run", "alpha.sock");
    const b = join(tmp.anchor, "devtrees", "run", "beta.sock");
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
      withRegistryLock: (_anchor, mutate) => {
        const after = mutate(registryRef.snapshot);
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
    const initialRegistry: RegistrySnapshot = { login: 20000, [SHARED_REGISTRY_KEY]: 30000 };
    const result = await runEnv(stubDeps({ stack, initialRegistry }));

    expect(result.env.DEVTREES_WORKTREE_ID).toBe("login");
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
    const initialRegistry: RegistrySnapshot = { login: 20096, [SHARED_REGISTRY_KEY]: 30016 };
    const result = await runEnv(stubDeps({ stack, initialRegistry }));

    // The deriver's env is the source of truth; runEnv must reproduce it exactly.
    const expected = deriveWorktreeConfig(stack, {
      worktreeId: "login",
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
    const registryRef = { snapshot: { login: 20064 } as RegistrySnapshot };
    let lockCalls = 0;
    const deps: CommandDeps = {
      ...stubDeps({ stack, registryRef }),
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
    const result = await runEnv(stubDeps({ stack, initialRegistry: {} }));
    // The would-be allocation is deterministic; we don't pin the exact number
    // but it must be in the default block range and consistent across calls.
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(20000);
    expect(result.env.DEVTREES_WORKTREE_ID).toBe("login");

    const again = await runEnv(stubDeps({ stack, initialRegistry: {} }));
    expect(again.env.WEB_PORT).toBe(result.env.WEB_PORT);
  });

  it("omits shared ports when the stack declares no shared services", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runEnv(stubDeps({ stack, initialRegistry: { login: 20000 } }));
    expect(result.env.WEB_PORT).toBe("20000");
    expect(result.env.DEVTREES_WORKTREE_ID).toBe("login");
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
  const runDir = join(anchor, "devtrees", "run");
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, `${fileStem}.sock`);
  writeFileSync(path, "");
  return path;
}

describe("runLogs — stream service logs without locking", () => {
  it("streams the worktree instance's named service from its socket", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    const socketPath = touchSocket(tmp.anchor, worktreeId);
    writeDerivedConfig(tmp.anchor, worktreeId, ["web", "worker"]);

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

  it("with { all: true }, enumerates services from the derived config and interleaves them", async () => {
    const tmp = tmpAnchor();
    const worktreeId = "login";
    touchSocket(tmp.anchor, worktreeId);
    writeDerivedConfig(tmp.anchor, worktreeId, ["web", "worker"]);

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
    touchSocket(tmp.anchor, worktreeId);
    writeDerivedConfig(tmp.anchor, worktreeId, ["web"]);

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
    touchSocket(tmp.anchor, worktreeId);
    writeDerivedConfig(tmp.anchor, worktreeId, ["web"]);

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
