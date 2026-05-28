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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  findUnmanagedPortBinds,
  runDown,
  runUp,
  type CommandDeps,
  type WithSharedLock,
} from "./commands.js";
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
    withSharedLock: passThroughSharedLock,
    isPortFree: opts.isPortFree ?? (() => true),
    warn: opts.warn,
    attach: false,
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
