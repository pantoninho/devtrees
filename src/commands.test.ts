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
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  filterLogEventsSince,
  findUnmanagedPortBinds,
  runAttach,
  runDown,
  runEnv,
  runLogs,
  runPruneSharedPorts,
  runUp,
  runUpDryRun,
  type CommandDeps,
  type WithLifecycleLock,
  type WithSharedLock,
} from "./commands.js";
import {
  inFlightWorktrees,
  sharedStepMarkerFile,
  withLifecycleLock,
  withSharedLock,
  writeSharedStepMarker,
  type InFlightWorktree,
} from "./registry.js";
import { deriveWorktreeId } from "./anchor.js";
import { deriveSharedConfig, deriveWorktreeConfig, type DerivedConfig } from "./deriver.js";
import type { RegistrySnapshot } from "./allocator.js";
import {
  parseServiceStatuses,
  type Driver,
  type InstanceRef,
  type ReloadResult,
  type LogEvent,
  type ServiceStatus,
} from "./driver.js";
import {
  createInMemoryProcessCompose,
  type InMemoryProcessCompose,
  type InMemoryProcessComposeOptions,
  type PcRequest,
} from "./in-memory-driver.js";
import type { InstanceInfo, InstanceStatus } from "./instances.js";
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
import { readSharedPortMap, sharedPortMapFile, writeSharedPortMap } from "./shared-ports.js";
import {
  clearPendingReload,
  readPendingReload,
  writePendingReload,
  type PendingReload,
} from "./reload-pending.js";
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

/**
 * The neutral `CommandDeps`: a fake git, a stack, an in-memory registry, and
 * stubs for the seams that would touch real ports, a TTY or a health poll.
 * It wires no process-compose: tests that drive one put the in-memory Driver
 * in with `onInMemoryPc` or `pcDeps`.
 */
function stubDeps(opts: {
  stack: ResolvedStack;
  worktreeId?: string;
  initialRegistry?: RegistrySnapshot;
  isPortFree?: (port: number) => boolean | Promise<boolean>;
  warn?: (m: string) => void;
  anchorOverride?: string;
  worktreeRootOverride?: string;
  registryRef?: { snapshot: RegistrySnapshot };
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
  };
}

/**
 * The command deps that put a command on the in-memory process-compose
 * (src/in-memory-driver.ts, #255): the Driver and the liveness probe answer
 * from the model, and the bounded stop's process-table seams see no OS
 * processes, so the model's pids never reach a real `ps` or `kill`.
 */
function inMemoryPcDeps(pc: InMemoryProcessCompose) {
  return {
    processCompose: pc.driver,
    probeSocket: (socketPath: string) => pc.probeSocket(socketPath),
    stop: {
      readProcessTable: async () => [],
      isAlive: () => false,
      kill: () => {},
      pollMs: 1,
      treeGraceMs: 1,
    },
  } satisfies CommandDeps;
}

/** `deps` on a fresh in-memory process-compose. */
function onInMemoryPc<D extends CommandDeps>(
  deps: D,
  opts: InMemoryProcessComposeOptions = {},
): { deps: D; pc: InMemoryProcessCompose } {
  const pc = createInMemoryProcessCompose(opts);
  const pcDeps = inMemoryPcDeps(pc);
  return {
    pc,
    deps: { ...deps, ...pcDeps, stop: { ...pcDeps.stop, ...deps.stop } } as D,
  };
}

/** The worktree and shared instance sockets of a stub-deps worktree. */
function socketsOf(deps: StubbedDeps): { worktree: string; shared: string } {
  const anchor = (deps.git!(["rev-parse", "--git-common-dir"]) as string).trim();
  return {
    worktree: instancePaths(anchor, deps.expectedWorktreeId).socketPath,
    shared: sharedInstancePaths(anchor).socketPath,
  };
}

/** The `op` requests process-compose received, oldest first. */
const requestsOf = (pc: InMemoryProcessCompose, op: PcRequest["op"]) =>
  pc.requests.filter((r) => r.op === op);

/**
 * `stubDeps` with process-compose as the in-memory adapter
 * (src/in-memory-driver.ts): `up` boots a
 * process table from the derived config, binds the control socket and
 * answers `process list` from that table. Tests make things happen to its
 * processes and assert on its state (`pc.isUp`, `pc.rows`), never on argv.
 *
 * Liveness is still read through `probeSocket` (default: the adapter's own,
 * `running` only while a server holds the socket). Pass `pc` to share one
 * process-compose between several worktrees of the same anchor.
 */
type PcDeps = StubbedDeps & {
  readonly pc: InMemoryProcessCompose;
  /** The git common dir the stubbed git resolves to. */
  readonly anchor: string;
  /** The worktree instance's config and socket paths. */
  readonly inst: InstanceRef;
  /** The shared instance's config and socket paths. */
  readonly sharedInst: InstanceRef;
};

function pcDeps(
  opts: Parameters<typeof stubDeps>[0] & {
    pc?: InMemoryProcessCompose;
    /** Liveness verdict for a control socket (#80). Default: the adapter's own. */
    probeSocket?: (socketPath: string) => Promise<InstanceStatus>;
    /**
     * Runs right after process-compose boots an instance, before `up` sees
     * it: e.g. a process exits at once (`pc.exit`), so the server exits and
     * removes its socket when nothing else runs (ADR-0009).
     */
    onBoot?: (inst: InstanceRef, pc: InMemoryProcessCompose) => void;
  },
): PcDeps {
  const pc = opts.pc ?? createInMemoryProcessCompose();
  const { onBoot } = opts;
  const base = stubDeps(opts);
  const anchor = base.git!(["rev-parse", "--git-common-dir"]);
  const onPc = inMemoryPcDeps(pc);
  return {
    ...base,
    probeSocket: opts.probeSocket ?? onPc.probeSocket,
    stop: { ...onPc.stop, ...base.stop },
    processCompose:
      onBoot === undefined
        ? pc.driver
        : {
            ...pc.driver,
            async up(inst, namespaces) {
              await pc.driver.up(inst, namespaces);
              if (pc.isUp(inst.socketPath)) onBoot(inst, pc);
            },
          },
    pc,
    anchor,
    inst: instancePaths(anchor, base.expectedWorktreeId),
    sharedInst: sharedInstancePaths(anchor),
  };
}

/** The `up` requests process-compose received on `socketPath`. */
function upsOn(pc: InMemoryProcessCompose, socketPath: string): PcRequest[] {
  return requestsOf(pc, "up").filter((r) => r.socketPath === socketPath);
}

/**
 * An `onBoot` under which the instance on a socket `doomed` matches dies at
 * once: every process it booted exits 1, so process-compose exits and
 * removes its control socket before anyone can connect.
 */
function diesAtBoot(doomed: (socketPath: string) => boolean) {
  return (inst: InstanceRef, pc: InMemoryProcessCompose): void => {
    if (!doomed(inst.socketPath)) return;
    for (const { name } of pc.rows(inst.socketPath)) pc.exit(inst.socketPath, name, 1);
  };
}

const isSharedSocket = (socketPath: string) => socketPath.endsWith("/shared.sock");

/**
 * `pc`'s Driver, except that its config reload fails with `failure` and
 * applies nothing. The in-memory adapter models a reload that lands; one
 * process-compose refuses (no reload route, an HTTP error) or never finishes
 * is this answer, the one the real driver maps those to (src/driver.test.ts
 * pins that mapping).
 */
function reloadFailing(
  pc: InMemoryProcessCompose,
  failure: Extract<ReloadResult, { ok: false }>,
): Driver {
  return { ...pc.driver, reloadConfig: async () => failure };
}

describe("runUp — port injection", () => {
  it("maps multiple named ports on one service to consecutive offsets within its block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js", ["WEB_PORT", "METRICS_PORT", "DEBUG_PORT"])],
    };
    const result = await runUp(pcDeps({ stack }));

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
    const result = await runUp(pcDeps({ stack }));
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
    await expect(runUp(pcDeps({ stack }))).rejects.toThrow(/block_size is 2/);
  });
});

describe("runUp — minimum process-compose version (#173)", () => {
  it("fails before allocating or spawning when the version probe rejects", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node server.js", ["WEB_PORT"])] };
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const pc = createInMemoryProcessCompose({ version: "v1.100.0" });
    const deps = pcDeps({ stack, pc, registryRef });
    await expect(runUp(deps)).rejects.toMatchObject({
      code: "PROCESS_COMPOSE_TOO_OLD",
      details: { installed_version: "1.100.0" },
    });
    // Nothing allocated, nothing started.
    expect(registryRef.snapshot).toEqual({});
    expect(requestsOf(pc, "up")).toEqual([]);
    expect(pc.isUp(deps.inst.socketPath)).toBe(false);
  });
});

describe("runUp — per-repo allocator config", () => {
  it("honours port_base from devtrees.yaml so two repos can keep their ranges apart", async () => {
    const stack: ResolvedStack = {
      allocator: { portBase: 40000, blockSize: 8 },
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUp(pcDeps({ stack }));
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(40000);
    // First block starts at port_base; offset 0 maps to the block base.
    expect((Number(result.env.WEB_PORT) - 40000) % 8).toBe(0);
  });

  it("falls back to deps-level defaults when devtrees.yaml omits the allocator section", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUp(pcDeps({ stack }));
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
    const deps = pcDeps({ stack: singleWebStack });

    const first = await runUp(deps);
    const second = await runUp(deps);

    expect(second.env.WEB_PORT).toBe(first.env.WEB_PORT);
  });

  it("respects an already-registered block from the snapshot (stable across restarts)", async () => {
    // The registry is keyed by the derived worktree id, so seed it under the
    // same id the stubbed git probe will resolve to.
    const result = await runUp(
      pcDeps({
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

    const loginDeps = { ...pcDeps({ stack, worktreeId: "login" }), withRegistryLock: lock };
    const billingDeps = { ...pcDeps({ stack, worktreeId: "billing" }), withRegistryLock: lock };

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
    await runUp(pcDeps({ stack, warn: (m) => warnings.push(m) }));

    expect(warnings.some((w) => /3000/.test(w) && /web/.test(w))).toBe(true);
  });

  it("stays silent when every port literal in the command is inside the allocated block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js --port $WEB_PORT", ["WEB_PORT"])],
    };
    const warnings: string[] = [];
    await runUp(pcDeps({ stack, warn: (m) => warnings.push(m) }));

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
    const deps = pcDeps({ stack: mixedStack });
    const result = await runUp(deps);

    // Two instances up: the shared one and the worktree instance.
    expect(requestsOf(deps.pc, "up")).toHaveLength(2);
    expect(upsOn(deps.pc, deps.sharedInst.socketPath)).toHaveLength(1);
    expect(deps.pc.isUp(deps.sharedInst.socketPath)).toBe(true);
    expect(deps.pc.isUp(deps.inst.socketPath)).toBe(true);
    expect(deps.pc.rows(deps.sharedInst.socketPath).map((r) => r.name)).toEqual(["postgres"]);
    expect(deps.pc.rows(deps.inst.socketPath).map((r) => r.name)).toEqual(["web"]);
    expect(result.sharedStarted).toBe(true);
  });

  it("registers the shared block under SHARED_REGISTRY_KEY", async () => {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    await runUp(pcDeps({ stack: mixedStack, registryRef }));
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBeGreaterThanOrEqual(20000);
  });

  it("injects the shared service's named port into the worktree env identically", async () => {
    const result = await runUp(pcDeps({ stack: mixedStack }));
    expect(result.env.DB_PORT).toBeDefined();
    expect(Number(result.env.DB_PORT)).toBeGreaterThanOrEqual(20000);
  });

  it("a second worktree reuses the running shared instance rather than starting another", async () => {
    // Two worktrees, same anchor and same registry — the second `up` must see
    // the shared socket from the first and skip lazy-start (acceptance).
    const { sharedAnchor, wtRoot, registryRef } = multiWorktreeFixture("dt-shared-");
    const pc = createInMemoryProcessCompose();
    const fixture = {
      stack: mixedStack,
      anchorOverride: sharedAnchor,
      worktreeRootOverride: wtRoot,
      registryRef,
      pc,
    };

    const login = pcDeps({ ...fixture, worktreeId: "login" });
    const a = await runUp(login);
    const sharedPid = pc.pidOf(login.sharedInst.socketPath, "postgres");
    const billing = pcDeps({ ...fixture, worktreeId: "billing" });
    const b = await runUp(billing);

    // First call started shared; second saw it already running.
    expect(a.sharedStarted).toBe(true);
    expect(b.sharedStarted).toBe(false);

    // Only one shared instance was ever started, and its postgres kept running;
    // the second `up` only started its own worktree instance.
    expect(upsOn(pc, login.sharedInst.socketPath)).toHaveLength(1);
    expect(pc.pidOf(login.sharedInst.socketPath, "postgres")).toBe(sharedPid);
    expect(pc.isUp(billing.inst.socketPath)).toBe(true);

    // Same DB_PORT in both worktrees (repo-wide injection).
    expect(a.env.DB_PORT).toBe(b.env.DB_PORT);
    // Distinct WEB_PORTs (per-worktree blocks).
    expect(a.env.WEB_PORT).not.toBe(b.env.WEB_PORT);
  });

  it("writes a derived shared config to <anchor>/devtrees/shared.yaml", async () => {
    const deps = pcDeps({ stack: mixedStack });
    await runUp(deps);
    const configPath = deps.sharedInst.configPath;
    expect(configPath).toMatch(/\/devtrees\/shared\.yaml$/);
    expect(existsSync(configPath)).toBe(true);
    const config = parseYaml(readFileSync(configPath, "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(Object.keys(config.processes)).toEqual(["postgres"]);
    // The shared instance booted from that config.
    expect(deps.pc.rows(deps.sharedInst.socketPath).map((r) => r.name)).toEqual(["postgres"]);
  });

  it("does not start a shared instance when the stack declares no shared services", async () => {
    const onlyIsolated: ResolvedStack = {
      services: [isolated("web", "node server.js", ["WEB_PORT"])],
    };
    const deps = pcDeps({ stack: onlyIsolated });
    const result = await runUp(deps);
    expect(result.sharedStarted).toBe(false);
    expect(upsOn(deps.pc, deps.sharedInst.socketPath)).toEqual([]);
    expect(deps.pc.isUp(deps.sharedInst.socketPath)).toBe(false);
  });

  it("two simultaneous ups see the lock-guarded ensureSharedStarted serialize them", async () => {
    // The shared lifecycle lock serialises the check-and-start, so even if both
    // worktrees race their ups, only one ends up spawning the shared instance.
    const { sharedAnchor, wtRoot, registryRef } = multiWorktreeFixture("dt-race-");
    const pc = createInMemoryProcessCompose();

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

    const fixture = {
      stack: mixedStack,
      anchorOverride: sharedAnchor,
      worktreeRootOverride: wtRoot,
      registryRef,
      pc,
    };
    const depsA = {
      ...pcDeps({ ...fixture, worktreeId: "login" }),
      withSharedLock: realSharedLock,
    };
    const depsB = {
      ...pcDeps({ ...fixture, worktreeId: "billing" }),
      withSharedLock: realSharedLock,
    };

    const [a, b] = await Promise.all([runUp(depsA), runUp(depsB)]);
    const totalSharedStarts = Number(a.sharedStarted) + Number(b.sharedStarted);
    expect(totalSharedStarts).toBe(1);
    // Exactly one `up` reached the shared socket.
    expect(upsOn(pc, depsA.sharedInst.socketPath)).toHaveLength(1);
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
    // The shared instance dies at once and removes its socket: exactly what an
    // instantly-dying shared instance looks like from here.
    const deps = {
      ...pcDeps({ stack: mixedStack, onBoot: diesAtBoot(isSharedSocket) }),
      sharedSocketTimeoutMs: 50,
    };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("SHARED_START_FAILED");
    expect(err.message).toMatch(/shared/i);
    // The worktree instance was never started — only the doomed shared up.
    expect(upsOn(deps.pc, deps.inst.socketPath)).toEqual([]);
    expect(deps.pc.isUp(deps.inst.socketPath)).toBe(false);
  });

  it("names the shared instance's real config in the remediation, not a placeholder", async () => {
    // The message used to print a literal `process-compose -f <shared config>`,
    // which is advice nobody can copy-paste. It must be the file the lazy-start
    // just wrote and spawned against — the same one `details.config_path`
    // publishes, mirroring the worktree envelope's shape (#157 follow-up).
    const deps = {
      ...pcDeps({ stack: mixedStack, onBoot: diesAtBoot(isSharedSocket) }),
      sharedSocketTimeoutMs: 50,
    };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject");

    expect(err.code).toBe("SHARED_START_FAILED");
    const configPath = String((err.details ?? {})["config_path"]);
    // The config the shared instance was booted from, not a reconstruction.
    expect(configPath).toBe(deps.sharedInst.configPath);
    expect(upsOn(deps.pc, deps.sharedInst.socketPath)).toHaveLength(1);
    expect(existsSync(configPath)).toBe(true);
    expect(err.message).toContain(`process-compose -f ${configPath}`);
    expect(err.message).not.toContain("<shared config>");
  });

  it("does not persist shared state when the start failed", async () => {
    // The persisted name→port map is the running instance's identity (#83);
    // a failed start must not record one, or the next `up` would inject
    // numbers nothing ever bound.
    const { sharedAnchor, wtRoot, registryRef } = multiWorktreeFixture("dt-sockfail-");
    const deps = {
      ...pcDeps({
        stack: mixedStack,
        anchorOverride: sharedAnchor,
        worktreeRootOverride: wtRoot,
        registryRef,
        onBoot: diesAtBoot(isSharedSocket),
      }),
      sharedSocketTimeoutMs: 50,
    };
    await expect(runUp(deps)).rejects.toThrow(/shared/i);
    expect(readSharedState(sharedAnchor)).toBeUndefined();
  });
});

/**
 * Issue #262 — a shared service whose command exits at once (e.g. `node
 * server.mjs` where the file exists only in the worktree, while shared
 * services run from the anchor) was reported as started. The lazy start only
 * waited for the control socket; the selected shared services were waited on
 * only when an isolated service `depends_on` one (the cross-tier wait,
 * ADR-0003), so a stack without such an edge saw `shared_started: true` for a
 * dead service. Both stacks below have no cross-tier edge.
 */
describe("runUp — a lazy-started shared service that exits at once (#262)", () => {
  it("one of two shared services dies: fails SHARED_SERVICE_DEAD died_while_waiting", async () => {
    // `cache` keeps process-compose (and its socket) alive; `api` exits 1.
    const stack: ResolvedStack = {
      services: [
        isolated("web", "sleep 300", ["WEB_PORT"]),
        shared("cache", "sleep 300"),
        shared("api", "node server.mjs", ["API_PORT"]),
      ],
    };
    const base = pcDeps({
      stack,
      onBoot: (inst, pc) => {
        if (isSharedSocket(inst.socketPath)) pc.exit(inst.socketPath, "api", 1);
      },
    });
    const deps = {
      ...base,
      // The real wait on the shared services, not the suite's no-op.
      waitForSharedReady: undefined,
      waitTimeoutMs: 5_000,
    };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject, not report shared started");
    expect(err.code).toBe("SHARED_SERVICE_DEAD");
    expect(err.details).toMatchObject({
      reason: "died_while_waiting",
      dead_services: [{ name: "api", exit_code: 1 }],
    });
    // Waited on before the worktree spawns, like the cross-tier wait.
    expect(upsOn(deps.pc, deps.inst.socketPath)).toEqual([]);
    expect(deps.pc.isUp(deps.inst.socketPath)).toBe(false);
  });

  it("the only shared service dies, so process-compose exits: up fails, not shared_started", async () => {
    // process-compose exits once nothing runs, removing its socket: the first
    // read after the socket appeared finds nothing listening.
    const stack: ResolvedStack = {
      services: [
        isolated("web", "sleep 300", ["WEB_PORT"]),
        shared("api", "node server.mjs", ["API_PORT"]),
      ],
    };
    const base = pcDeps({ stack, onBoot: diesAtBoot(isSharedSocket) });
    const deps = { ...base, waitForSharedReady: undefined, waitTimeoutMs: 5_000 };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject, not report shared started");
    // A failed start, as when the socket never appears (#92): same details.
    expect(err.code).toBe("SHARED_START_FAILED");
    expect(err.details).toMatchObject({
      socket_path: deps.sharedInst.socketPath,
      config_path: deps.sharedInst.configPath,
      timeout_ms: expect.any(Number),
    });
    expect(err.message).toContain(`process-compose -f ${deps.sharedInst.configPath}`);
    expect(deps.pc.isUp(deps.sharedInst.socketPath)).toBe(false);
    expect(upsOn(deps.pc, deps.inst.socketPath)).toEqual([]);
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

  /** The real socket wait, with a deadline short enough for a unit test. */
  function withRealSocketWait<D extends CommandDeps>(base: D): D {
    return { ...base, worktreeSocketTimeoutMs: 50 };
  }

  it("attributes the failure to the worktree instance on a stack with no shared tier", async () => {
    // Exactly the reproduction from #157: two isolated services, no shared
    // service anywhere, a worktree instance that dies at once. Before the fix
    // this failed with SHARED_START_FAILED and a details.socket_path pointing
    // at the worktree's own socket.
    const base = pcDeps({ stack: allIsolated, onBoot: diesAtBoot(() => true) });
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
    expect(details["socket_path"]).toBe(base.inst.socketPath);
    expect(String(details["socket_path"])).not.toContain("shared.sock");
    // The remediation names the worktree's config, not the shared one — the
    // file an agent (or human) actually runs `process-compose -f` against.
    const configPath = String(details["config_path"]);
    expect(configPath).toBe(base.inst.configPath);
    expect(err.message).toContain(configPath);
    expect(details["timeout_ms"]).toBe(50);
  });

  it("still attributes a shared-instance socket failure to the shared instance", async () => {
    // The other half of the contract: nothing about #157 may change the #92
    // envelope, which something already branches on. Mixed stack, the shared
    // instance is the one that dies at once.
    const mixedStack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    const deps = {
      ...withRealSocketWait(pcDeps({ stack: mixedStack, onBoot: diesAtBoot(isSharedSocket) })),
      sharedSocketTimeoutMs: 50,
    };
    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject");

    expect(err.code).toBe("SHARED_START_FAILED");
    expect(err.message).toMatch(/shared instance/i);
    expect((err.details ?? {})["socket_path"]).toBe(deps.sharedInst.socketPath);
    // Both envelopes now carry a real `config_path`; the discriminator is
    // which instance's config it is, so pin that rather than its presence.
    expect((err.details ?? {})["config_path"]).toBe(deps.sharedInst.configPath);
  });

  it("blames the worktree when the shared instance came up fine and only the worktree died", async () => {
    // The discriminating case: both instances are started, the shared one
    // stays up, the worktree one dies at once. One code covering both would
    // report this as a shared failure against a demonstrably healthy shared
    // instance — the exact misdirection #154 chased.
    const mixedStack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    const base = pcDeps({
      stack: mixedStack,
      onBoot: diesAtBoot((socketPath) => !isSharedSocket(socketPath)),
    });
    const deps = { ...withRealSocketWait(base), sharedSocketTimeoutMs: 50 };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    if (err === undefined) throw new Error("expected runUp to reject");

    expect(err.code).toBe("WORKTREE_START_FAILED");
    expect((err.details ?? {})["socket_path"]).toBe(deps.inst.socketPath);
    // Both instances were started — the shared one is up, not the failure.
    expect(deps.pc.isUp(deps.sharedInst.socketPath)).toBe(true);
    expect(upsOn(deps.pc, deps.inst.socketPath)).toHaveLength(1);
    expect(deps.pc.isUp(deps.inst.socketPath)).toBe(false);
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
    const deps = {
      ...pcDeps({ stack: crossTierStack, warn: (m) => warnings.push(m) }),
      waitForSharedHealth: () => Promise.resolve(),
    };
    await runUp(deps);

    const droppedWarning = warnings.find(
      (w) => /web/.test(w) && /postgres/.test(w) && /depends_on/i.test(w),
    );
    expect(droppedWarning).toBeDefined();
  });

  it("waits for shared services to be healthy before starting the worktree instance", async () => {
    // The shared-health wait happens between the shared instance's start and
    // the worktree instance's — that's the orchestration layer's stand-in for
    // the dropped cross-tier depends_on edge (ADR-0003).
    const order: string[] = [];
    let waitResolved = false;

    const waitForSharedHealth = (): Promise<void> =>
      new Promise<void>((resolve) => {
        order.push("wait:start");
        setTimeout(() => {
          waitResolved = true;
          order.push("wait:resolve");
          resolve();
        }, 5);
      });

    // Record each instance's start relative to the wait.
    const pc = createInMemoryProcessCompose({
      onRequest: (r) => {
        if (r.op === "up") order.push(isSharedSocket(r.socketPath) ? "up:shared" : "up:worktree");
      },
    });
    const deps = { ...pcDeps({ stack: crossTierStack, pc }), waitForSharedHealth };

    await runUp(deps);
    // The wait must have run, and the worktree up must not have started before it resolved.
    expect(waitResolved).toBe(true);
    expect(order).toEqual(["up:shared", "wait:start", "wait:resolve", "up:worktree"]);
    expect(pc.isUp(deps.sharedInst.socketPath)).toBe(true);
    expect(pc.isUp(deps.inst.socketPath)).toBe(true);
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
    const deps = { ...pcDeps({ stack: independent }), waitForSharedHealth };
    await runUp(deps);
    expect(called).toBe(false);
  });

  it("logs a 'waiting for shared' message when the wait runs", async () => {
    const warnings: string[] = [];
    const deps = {
      ...pcDeps({ stack: crossTierStack, warn: (m) => warnings.push(m) }),
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
    const deps = pcDeps({ stack: sameTier });
    await runUp(deps);
    // The worktree instance booted from this config.
    expect(deps.pc.rows(deps.inst.socketPath).map((r) => r.name)).toEqual(["api", "web"]);
    const config = parseYaml(readFileSync(deps.inst.configPath, "utf8")) as {
      processes: Record<string, { depends_on?: Record<string, { condition: string }> }>;
    };
    expect(config.processes.web?.depends_on).toEqual({ api: { condition: "process_started" } });
  });

  it("does not emit cross-tier depends_on edges in the derived worktree config", async () => {
    // The whole point of the deriver's edge-dropping: process-compose would
    // raise an "unknown process 'postgres'" error otherwise.
    const deps = {
      ...pcDeps({ stack: crossTierStack }),
      waitForSharedHealth: () => Promise.resolve(),
    };
    await runUp(deps);
    expect(deps.pc.rows(deps.inst.socketPath).map((r) => r.name)).toEqual(["web"]);
    const config = parseYaml(readFileSync(deps.inst.configPath, "utf8")) as {
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

  /** The TUI attaches process-compose received. */
  const attaches = (pc: InMemoryProcessCompose) => pc.requests.filter((r) => r.op === "attach");

  it("waits for the worktree instance's services to be healthy after starting it", async () => {
    // The wait must happen between `driver.up` of the worktree and any subsequent
    // attach — that is the gate that turns "up returned" into "the stack is
    // serving traffic" (PRD #26, ADR-0005).
    const order: string[] = [];
    const pc = createInMemoryProcessCompose({
      onRequest: (r) => {
        if (r.op === "up") order.push("up:worktree");
        if (r.op === "attach") order.push("attach");
      },
    });
    const deps = {
      ...pcDeps({ stack: twoIsolated, pc }),
      waitForHealth: async ({ serviceNames }: { serviceNames: ReadonlyArray<string> }) => {
        // The instance is up by the time the wait runs.
        order.push(`wait:${[...serviceNames].sort().join(",")}:${pc.isUp(deps.inst.socketPath)}`);
      },
    };

    await runUp(deps);
    expect(order).toContain("wait:web,worker:true");
    // The wait must run after the worktree up (otherwise it polls a socket
    // that doesn't exist yet).
    expect(order.indexOf("up:worktree")).toBeLessThan(order.indexOf("wait:web,worker:true"));
  });

  it("passes the worktree's own socket path to the wait — not the shared one", async () => {
    const seen: string[] = [];
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = {
      ...base,
      waitForHealth: async ({ socketPath }) => {
        seen.push(socketPath);
      },
    };
    await runUp(deps);
    expect(seen).toEqual([base.inst.socketPath]);
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
    const deps: CommandDeps = {
      ...pcDeps({ stack: probedStack }),
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
    const deps: CommandDeps = {
      ...pcDeps({ stack: probedCrossTier }),
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
    const deps: CommandDeps = {
      ...pcDeps({ stack: twoIsolated }),
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
    const deps: CommandDeps = {
      ...pcDeps({ stack: twoIsolated }),
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
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = {
      ...base,
      attach: false, // headless: the path the silent health-wait gates
      waitForHealth: async () => {
        const err = new Error(
          "timed out waiting for services to be healthy [web, worker] after 120000ms",
        ) as Error & { code: string };
        err.code = "HEALTH_TIMEOUT";
        throw err;
      },
    };

    const err = await runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    if (err === undefined) throw new Error("expected runUp to reject");
    expect(err.code).toBe("HEALTH_TIMEOUT");
    expect(attaches(base.pc)).toEqual([]);
    // The stack is left running.
    expect(base.pc.requests.filter((r) => r.op === "down")).toEqual([]);
    expect(base.pc.isUp(base.inst.socketPath)).toBe(true);
    expect(base.pc.rows(base.inst.socketPath).map((r) => [r.name, r.status])).toEqual([
      ["web", "Running"],
      ["worker", "Running"],
    ]);
  });

  it("does not attach when deps.attach is false even if the wait succeeds", async () => {
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = { ...base, attach: false, waitForHealth: async () => {} };
    await runUp(deps);
    expect(attaches(base.pc)).toEqual([]);
  });

  it("auto-detect: attaches when isTTY()===true and deps.attach is unset", async () => {
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = { ...base, attach: undefined, isTTY: () => true };
    await runUp(deps);
    expect(attaches(base.pc)).toEqual([{ op: "attach", socketPath: base.inst.socketPath }]);
  });

  it("auto-detect: skips attach when isTTY()===false (non-interactive caller)", async () => {
    // The whole point of #28: an agent / CI step calling `devtrees up` must
    // not be hijacked into a TUI. With no explicit override and a non-TTY
    // environment, the TUI stays off and `up` returns after the health-wait.
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = { ...base, attach: undefined, isTTY: () => false };
    await runUp(deps);
    expect(attaches(base.pc)).toEqual([]);
  });

  it("explicit deps.attach=true overrides isTTY()===false", async () => {
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = { ...base, attach: true, isTTY: () => false };
    await runUp(deps);
    expect(attaches(base.pc)).toEqual([{ op: "attach", socketPath: base.inst.socketPath }]);
  });

  it("explicit deps.attach=false overrides isTTY()===true", async () => {
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = { ...base, attach: false, isTTY: () => true };
    await runUp(deps);
    expect(attaches(base.pc)).toEqual([]);
  });

  it("attach mode (#132): attaches the live TUI and skips the silent health-wait", async () => {
    // Option 1: the server is already started detached and `process-compose
    // attach` renders services going starting -> ready, so in attach mode we
    // attach the TUI immediately — the human watching it is the progress AND the
    // health signal. The silent `waitForHealth` gate (and HEALTH_TIMEOUT) is for
    // the headless paths only, so it must NOT run here.
    const base = pcDeps({ stack: twoIsolated });
    let waited = false;
    const deps: CommandDeps = {
      ...base,
      attach: true,
      waitForHealth: async () => {
        waited = true;
      },
    };
    await runUp(deps);
    expect(attaches(base.pc)).toEqual([{ op: "attach", socketPath: base.inst.socketPath }]);
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
      ...pcDeps({ stack }),
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
    const base = pcDeps({ stack: listNamespaces });
    const deps: CommandDeps = {
      ...base,
      namespaces: ["two"],
      warn: (m) => warnings.push(m),
      waitForHealth: async ({ serviceNames }) => {
        waited = [...serviceNames];
      },
    };
    const result = await runUp(deps);
    expect(waited).toEqual(["db", "api"]);
    // process-compose booted exactly them.
    expect(base.pc.rows(base.inst.socketPath).map((r) => r.name)).toEqual(["db", "api"]);
    expect(result.droppedNamespaceEdges).toEqual([]);
    expect(warnings.filter((w) => /cross-namespace/.test(w))).toEqual([]);
  });

  it("#179: warns once per depends_on edge whose target no selected namespace covers", async () => {
    const warnings: string[] = [];
    const deps: CommandDeps = {
      ...pcDeps({ stack: listNamespaces }),
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

  it("starts the worktree instance with exactly the requested namespace", async () => {
    const base = pcDeps({ stack: mixedNamespaces });
    await runUp({ ...base, namespaces: ["default"] });
    expect(upsOn(base.pc, base.inst.socketPath)).toEqual([
      { op: "up", socketPath: base.inst.socketPath, namespaces: ["default"] },
    ]);
    // Only the default-namespace web runs; the local-backend api was not started.
    expect(base.pc.rows(base.inst.socketPath).map((r) => r.name)).toEqual(["web"]);
  });

  it("narrows the health-wait's expected set to the selected namespaces", async () => {
    // The crux of #128: `up -n default` must NOT wait on the excluded
    // local-backend api (a probed service) — otherwise it HEALTH_TIMEOUTs on a
    // service it never asked process-compose to start.
    let observed: { serviceNames: string[]; probedServiceNames: string[] } | undefined;
    const deps: CommandDeps = {
      ...pcDeps({ stack: mixedNamespaces }),
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
    const deps: CommandDeps = {
      ...pcDeps({ stack: mixedNamespaces }),
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

  it("a bare fresh up selects only `default`: starts and waits only on default services (#176)", async () => {
    let observed: string[] | undefined;
    const base = pcDeps({ stack: mixedNamespaces });
    const deps: CommandDeps = {
      ...base,
      waitForHealth: async ({ serviceNames }) => {
        observed = [...serviceNames].sort();
      },
    };
    await runUp(deps);
    // Namespaces are opt-in (ADR-0008): the excluded local-backend api is
    // neither started nor waited on.
    expect(observed).toEqual(["web"]);
    expect(upsOn(base.pc, base.inst.socketPath).map((r) => r.namespaces)).toEqual([["default"]]);
    expect(base.pc.rows(base.inst.socketPath).map((r) => r.name)).toEqual(["web"]);
  });

  it("`-n <ns>` stays exact: it never adds `default` on top (#176)", async () => {
    const base = pcDeps({ stack: mixedNamespaces });
    await runUp({ ...base, namespaces: ["local-backend"], waitForHealth: async () => {} });
    expect(upsOn(base.pc, base.inst.socketPath).map((r) => r.namespaces)).toEqual([
      ["local-backend"],
    ]);
    // The default-namespace web was not started.
    expect(base.pc.rows(base.inst.socketPath).map((r) => r.name)).toEqual(["api"]);
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
    const deps = pcDeps({ stack: allNamespaced });
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
    expect(requestsOf(deps.pc, "up")).toEqual([]);
  });

  it("`-n` naming only a namespace with NO services fails NO_SERVICES_SELECTED before any state is written (#203)", async () => {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = pcDeps({ stack: allNamespaced, registryRef });
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
    expect(requestsOf(deps.pc, "up")).toEqual([]);
    expect(registryRef.snapshot).toEqual({});
  });

  it("`-n app -n nope` still starts: only an overall empty selection is an error (#203)", async () => {
    let observed: string[] | undefined;
    const base = pcDeps({ stack: allNamespaced });
    await runUp({
      ...base,
      namespaces: ["app", "nope"],
      waitForHealth: async ({ serviceNames }) => {
        observed = [...serviceNames].sort();
      },
    });
    expect(observed).toEqual(["web", "worker"]);
    expect(base.pc.rows(base.inst.socketPath).map((r) => r.name)).toEqual(["web", "worker"]);
  });

  it("a bare up on a RUNNING instance is not a fresh start: no NO_SERVICES_SELECTED, no spawn (#177's scope)", async () => {
    const baseDeps = pcDeps({ stack: allNamespaced });
    await runUp({ ...baseDeps, namespaces: ["app"], waitForHealth: async () => {} });
    const upsAfterBoot = requestsOf(baseDeps.pc, "up").length;
    const webPid = baseDeps.pc.pidOf(baseDeps.inst.socketPath, "web");
    // Bare re-up against the live instance takes the reconcile path unchanged.
    const result = await runUp(baseDeps);
    expect(result.worktreeId).toBe(baseDeps.expectedWorktreeId);
    expect(requestsOf(baseDeps.pc, "up")).toHaveLength(upsAfterBoot);
    expect(baseDeps.pc.pidOf(baseDeps.inst.socketPath, "web")).toBe(webPid);
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

  /** The `process list` reads process-compose answered on `socketPath`. */
  const listsOn = (pc: InMemoryProcessCompose, socketPath: string) =>
    pc.requests.filter((r) => r.op === "list" && r.socketPath === socketPath);

  it("returns the allocated block_base on the up result", async () => {
    const result = await runUp(pcDeps({ stack: twoIsolated }));
    // block_base is the bottom of this worktree's allocated block: the
    // first named port (offset 0 within the block) lines up with it, and
    // every other port falls inside [blockBase, blockBase + blockSize).
    // The exact number depends on the allocator's hash of the worktree id;
    // assert the contract, not the hash.
    expect(result.blockBase).toBe(Number(result.env.WEB_PORT));
    expect(Number(result.env.WORKER_PORT)).toBeGreaterThanOrEqual(result.blockBase);
    expect(Number(result.env.WORKER_PORT)).toBeLessThan(result.blockBase + 32);
  });

  it("populates services[] from process-compose's rows, zipped with named-port allocations", async () => {
    // Both probed: web passes its readiness probe, worker does not (yet).
    const probed: ResolvedStack = {
      services: twoIsolated.services.map((s) => ({ ...s, readinessProbe: { exec: {} } })),
    };
    const deps = pcDeps({
      stack: probed,
      onBoot: (inst, pc) => pc.setReady(inst.socketPath, "worker", false),
    });
    const result = await runUp(deps);
    // Read once, from the worktree's own socket.
    expect(listsOn(deps.pc, deps.inst.socketPath)).toHaveLength(1);
    expect(deps.pc.requests.filter((r) => r.op === "list")).toHaveLength(1);
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

  it("services[] is the empty array (not undefined) when process-compose lists no processes", async () => {
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = {
      ...base,
      // A process-compose whose `process list` answers with no rows.
      processCompose: { ...base.pc.driver, getServiceStatuses: async () => [] },
    };
    const result = await runUp(deps);
    expect(result.services).toEqual([]);
  });

  it("a failed status read does not abort `up` — services[] degrades to []", async () => {
    // Same containment rule `ls --json` uses (issue #29): a flaky driver call
    // must not turn an otherwise-healthy worktree into a failed `up`. The
    // stack is running; the envelope just gets the partial answer. Here
    // process-compose stops answering once the health-wait is done.
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = {
      ...base,
      waitForHealth: async ({ socketPath }) => base.pc.freeze(socketPath),
    };
    const result = await runUp(deps);
    expect(listsOn(base.pc, base.inst.socketPath).length).toBeGreaterThan(0);
    expect(result.services).toEqual([]);
    // The rest of the envelope is still well-formed.
    expect(result.blockBase).toBe(Number(result.env.WEB_PORT));
    expect(result.env.WEB_PORT).toBeDefined();
  });

  it("reads the service rows after the health-wait, never before", async () => {
    // Order matters: the status read polls the running stack — reading it
    // before the wait would return process-compose's transient "starting"
    // state instead of the healthy snapshot the agent is contracting for.
    const order: string[] = [];
    const pc = createInMemoryProcessCompose({
      onRequest: (r) => {
        if (r.op === "list") order.push("statuses");
      },
    });
    const deps: CommandDeps = {
      ...pcDeps({ stack: twoIsolated, pc }),
      waitForHealth: async () => {
        order.push("wait");
      },
    };
    await runUp(deps);
    expect(order).toEqual(["wait", "statuses"]);
  });

  it("does not read the service rows when the health-wait threw HEALTH_TIMEOUT", async () => {
    // The stack is left running (ADR-0005), but the agent reads the
    // `HEALTH_TIMEOUT` error envelope, not the success envelope — so the
    // success-only `services[]` fetch must be skipped.
    const base = pcDeps({ stack: twoIsolated });
    const deps: CommandDeps = {
      ...base,
      waitForHealth: async () => {
        const err = new Error("timed out") as Error & { code: string };
        err.code = "HEALTH_TIMEOUT";
        throw err;
      },
    };
    await expect(runUp(deps)).rejects.toThrow(/timed out/);
    expect(base.pc.requests.filter((r) => r.op === "list")).toEqual([]);
    expect(base.pc.isUp(base.inst.socketPath)).toBe(true);
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
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    await runUp(deps);
    const sockets = socketsOf(deps);
    expect(pc.isUp(sockets.shared)).toBe(true);
    expect(pc.isUp(sockets.worktree)).toBe(true);

    await runDown(deps);
    expect(pc.isUp(sockets.worktree)).toBe(false);
    // runDown without --shared leaves the shared instance and its postgres running.
    expect(pc.isUp(sockets.shared)).toBe(true);
    expect(existsSync(sockets.shared)).toBe(true);
    expect(pc.rows(sockets.shared).map((r) => [r.name, r.status])).toEqual([
      ["postgres", "Running"],
    ]);
  });

  it("runDown(--shared) tears down the shared instance but preserves its registry entry (#51)", async () => {
    // The shared block must stay pinned across a `down --shared` + `up` cycle
    // so agents that record `DB_PORT` once can reuse it. Liveness in `ls --json`
    // is driven by socket presence, not registry presence (instances.ts), so
    // dropping the entry was tidy theatre at the cost of port stability.
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack, registryRef }));
    await runUp(deps);
    const sockets = socketsOf(deps);

    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBeDefined();
    const priorSharedBase = registryRef.snapshot[SHARED_REGISTRY_KEY];
    expect(existsSync(sockets.shared)).toBe(true);

    await runDown(deps, { shared: true });
    expect(pc.isUp(sockets.shared)).toBe(false);
    expect(existsSync(sockets.shared)).toBe(false);
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
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack, registryRef }));
    const firstUp = await runUp(deps);
    const firstSharedBase = registryRef.snapshot[SHARED_REGISTRY_KEY];
    expect(firstSharedBase).toBeDefined();
    const sockets = socketsOf(deps);

    // Tear the worktree down too so the second `up` takes the full lazy-start
    // path (the idempotency branch in `runUp` short-circuits before it would
    // re-check the shared socket).
    await runDown(deps);
    await runDown(deps, { shared: true });

    // The shared registry entry survived the teardown.
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBe(firstSharedBase);

    // Re-`up`: shared lazy-starts again (its socket was removed) on the same block.
    expect(existsSync(sockets.shared)).toBe(false);
    const secondUp = await runUp(deps);
    expect(registryRef.snapshot[SHARED_REGISTRY_KEY]).toBe(firstSharedBase);
    expect(secondUp.env.DB_PORT).toBe(firstUp.env.DB_PORT);
    expect(secondUp.sharedStarted).toBe(true);
    // The shared instance runs again: lazy-start ran.
    expect(pc.isUp(sockets.shared)).toBe(true);
    expect(requestsOf(pc, "up").filter((r) => r.socketPath === sockets.shared)).toHaveLength(2);
  });

  it("runDown(--shared) is a tidy no-op when the shared instance is not running", async () => {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    // No prior `up` — the socket doesn't exist.
    await runDown(deps, { shared: true });
    // Nothing thrown, and nothing asked of process-compose.
    expect(pc.requests).toEqual([]);
  });

  it("up → down --shared → up lazy-restarts shared even though the worktree socket is still present (#56)", async () => {
    // Issue #56: the idempotency branch in `runUp` short-circuits before ever
    // checking the shared socket. If a prior `down --shared` killed the shared
    // tier but the worktree's own instance is still up, the next `up` must
    // still recover shared (and the envelope must report `shared_started:
    // true` so an agent can tell shared was just brought back).
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack, registryRef }));
    const first = await runUp(deps);
    expect(first.sharedStarted).toBe(true);
    const sockets = socketsOf(deps);
    expect(pc.isUp(sockets.shared)).toBe(true);

    // Note we DO NOT call `runDown` for the worktree — its instance stays up
    // so the second `up` hits the idempotency branch.
    await runDown(deps, { shared: true });
    expect(pc.isUp(sockets.shared)).toBe(false);
    expect(existsSync(sockets.shared)).toBe(false);
    expect(pc.isUp(sockets.worktree)).toBe(true);

    // Second `up` from the same (still-running) worktree must lazy-restart
    // shared — the idempotency branch can no longer skip the shared check.
    const second = await runUp(deps);
    expect(second.sharedStarted).toBe(true);
    expect(pc.isUp(sockets.shared)).toBe(true);
    // Shared block stayed the same (registry entry survived the down).
    expect(second.env.DB_PORT).toBe(first.env.DB_PORT);
  });
});

/**
 * The worktree `down` runs under the per-worktree lifecycle lock (#178), so
 * an `up` restarting dead services cannot `process start` on a supervisor
 * that is shutting down.
 */
describe("runDown — worktree teardown holds the lifecycle lock (#178)", () => {
  const stack: ResolvedStack = { services: [isolated("web", "node server.js", ["WEB_PORT"])] };

  it("probes and stops the instance inside the worktree's lifecycle lock", async () => {
    const events: string[] = [];
    const { deps, pc } = onInMemoryPc(stubDeps({ stack }), {
      onRequest: (r) => events.push(r.op),
    });
    await runUp(deps);
    events.length = 0;
    const result = await runDown({
      ...deps,
      withLifecycleLock: async (_a, instanceId, fn) => {
        events.push(`lock ${instanceId}`);
        const out = await fn();
        events.push("unlock");
        return out;
      },
    });
    expect(result.stopped).toBe(true);
    expect(pc.isUp(socketsOf(deps).worktree)).toBe(false);
    // The pre-stop snapshot (`process list`, #190) also runs under the lock.
    expect(events).toEqual([`lock ${deps.expectedWorktreeId}`, "list", "down", "unlock"]);
  });

  it("a lock held by a concurrent up fails LOCK_CONTENTION and stops nothing", async () => {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack }));
    await runUp(deps);
    const anchor = (deps.git!(["rev-parse", "--git-common-dir"]) as string).trim();
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
    }).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    release();
    await holder;
    expect(err?.code).toBe("LOCK_CONTENTION");
    expect(requestsOf(pc, "down")).toEqual([]);
    expect(pc.isUp(socketsOf(deps).worktree)).toBe(true);
  });
});

/**
 * Issue #48 — `devtrees down --json` is operation-output only. `runDown`
 * returns an identity-only `DownResult`: exactly one of `{shared: true}` or
 * `{shared: false, worktreeId: "<id>"}` (discriminated union). Pre- and
 * post-teardown state belongs to `ls --json`, not this envelope.
 */
describe("runDown — operation-output result (#48)", () => {
  const mixedStack: ResolvedStack = {
    services: [
      isolated("web", "node server.js", ["WEB_PORT"]),
      shared("postgres", "postgres", ["DB_PORT"]),
    ],
  };

  it("worktree teardown returns {shared: false, worktreeId}", async () => {
    const { deps } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    await runUp(deps);
    const result = await runDown(deps);
    expect(result.shared).toBe(false);
    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
  });

  it("shared teardown returns {shared: true} and no worktreeId", async () => {
    const { deps } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    await runUp(deps);

    const result = await runDown(deps, { shared: true });
    expect(result.shared).toBe(true);
    expect(result.worktreeId).toBeUndefined();
  });

  it("runDown(--shared) on an already-stopped shared instance is a tidy no-op that still returns {shared: true}", async () => {
    const { deps } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    const result = await runDown(deps, { shared: true });
    expect(result.shared).toBe(true);
    expect(result.worktreeId).toBeUndefined();
  });

  it("still calls driver.down so the lifecycle contract (#1 plain runDown stops the worktree instance) holds", async () => {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    await runUp(deps);
    const sockets = socketsOf(deps);

    await runDown(deps);
    expect(requestsOf(pc, "down").map((r) => r.socketPath)).toEqual([sockets.worktree]);
    expect(pc.isUp(sockets.worktree)).toBe(false);
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

  it("worktree down with no instance running skips the driver and returns stopped: false", async () => {
    // No prior `up` — the worktree's control socket does not exist.
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    const result = await runDown(deps);
    expect(requestsOf(pc, "down")).toHaveLength(0);
    expect(result.shared).toBe(false);
    expect(result.stopped).toBe(false);
  });

  it("worktree down against a live instance calls the driver and returns stopped: true", async () => {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    await runUp(deps);
    const result = await runDown(deps);
    expect(requestsOf(pc, "down")).toHaveLength(1);
    expect(pc.isUp(socketsOf(deps).worktree)).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
  });

  it("worktree down against a stale socket file (dead listener) is a no-op that unlinks the orphan", async () => {
    // A SIGKILLed instance: the socket *file* survives in anchor state but no
    // listener answers (#80). `down` must not shell out against the dead UDS
    // — that's the raw "exited with code N" UNKNOWN the issue fixes.
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    await runUp(deps);
    const { worktree } = socketsOf(deps);
    pc.crash(worktree);
    expect(existsSync(worktree)).toBe(true);

    const result = await runDown(deps);
    expect(requestsOf(pc, "down")).toHaveLength(0);
    expect(result.stopped).toBe(false);
    // The probe gate unlinked the orphaned socket file on the way through.
    expect(existsSync(worktree)).toBe(false);
  });

  it("shared down reports stopped: true when it actually tore the instance down", async () => {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    await runUp(deps);
    const { shared: sharedSocket } = socketsOf(deps);
    const result = await runDown(deps, { shared: true });
    expect(requestsOf(pc, "down").map((r) => r.socketPath)).toEqual([sharedSocket]);
    expect(pc.isUp(sharedSocket)).toBe(false);
    expect(result.shared).toBe(true);
    expect(result.stopped).toBe(true);
  });

  it("shared down no-op reports stopped: false", async () => {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: mixedStack }));
    const result = await runDown(deps, { shared: true });
    expect(requestsOf(pc, "down")).toHaveLength(0);
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
    // The staged socket file has no server behind it: the probe reads it stale.
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: hookStack }));
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
    // Nothing was asked of the dead supervisor.
    expect(requestsOf(pc, "down")).toHaveLength(0);
    // The stale socket file is reclaimed; result is the worktree teardown.
    expect(existsSync(staged.socketPath)).toBe(false);
    expect(result.shared).toBe(false);
    expect(result.stopped).toBe(false);
  });

  it("does NOT run the direct reap when the supervisor is live (graceful down fires the hook) — no regression on acceptance 4", async () => {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: hookStack }));
    const staged = stageWorktreeInstance(deps);
    await pc.driver.up({ configPath: staged.configPath, socketPath: staged.socketPath });
    const reapCalls: unknown[] = [];

    const result = await runDown({
      ...deps,
      reap: async (config, rdeps) => {
        reapCalls.push({ config, cwd: rdeps.cwd });
        return { ranCount: 0, failures: [] };
      },
    });

    // Live supervisor: the graceful `process-compose down` fires the hook from
    // the (present) worktree, so devtrees must NOT also run it directly.
    expect(reapCalls).toHaveLength(0);
    expect(pc.isUp(staged.socketPath)).toBe(false);
    expect(result.stopped).toBe(true);
  });

  it("reflects a failed dead-supervisor reap in DownResult.warning (acceptance 5)", async () => {
    const { deps } = onInMemoryPc(stubDeps({ stack: hookStack }));
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
    const deps = pcDeps({ stack: mixed });
    const result = await runUpDryRun(deps);
    expect(result.namespaces).toEqual(["default"]);
    expect(result.selectedServices).toEqual(["web"]);
    // The derived config still carries every service; `-n` filters at launch.
    expect(Object.keys(result.config.processes).sort()).toEqual(["api", "web"]);
    expect(deps.pc.requests).toEqual([]);
  });

  it("`-n` is previewed verbatim and exactly", async () => {
    const result = await runUpDryRun({
      ...pcDeps({ stack: mixed }),
      namespaces: ["local-backend"],
    });
    expect(result.namespaces).toEqual(["local-backend"]);
    expect(result.selectedServices).toEqual(["api"]);
  });

  it("a bare dry run of an all-namespaced stack fails NO_SERVICES_SELECTED without touching the registry", async () => {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const deps = pcDeps({
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
    const deps = pcDeps({
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
  const noDefault: ResolvedStack = {
    services: [
      { ...isolated("api", "sleep 300", ["API_PORT"]), namespace: "local-backend" },
      { ...isolated("worker", "sleep 300"), namespace: "jobs" },
    ],
  };

  /** The config a stack's services boot from: just what process-compose selects on. */
  const bootConfig = (stack: ResolvedStack) => ({
    processes: Object.fromEntries(
      stack.services.map((s) => [
        s.name,
        { command: s.command, ...(s.namespace !== undefined ? { namespace: s.namespace } : {}) },
      ]),
    ),
  });

  /**
   * A live worktree instance on the in-memory process-compose, booted from
   * `boot.from` (default: `stack`) with `boot.namespaces`; the `boot.dead`
   * processes were then killed (exit -1). Pids start at `boot.firstPid`.
   * `effects` counts the side-effecting seams; process-compose's requests are
   * on `pc`. `boot: false` boots nothing.
   */
  async function live(
    stack: ResolvedStack,
    boot:
      | {
          namespaces: string[];
          dead?: string[];
          firstPid?: number;
          from?: ResolvedStack;
        }
      | false,
    extra: Partial<CommandDeps> = {},
  ) {
    const registryRef = { snapshot: {} as RegistrySnapshot };
    const pc = createInMemoryProcessCompose(
      boot === false || boot.firstPid === undefined ? {} : { firstPid: boot.firstPid },
    );
    const base = pcDeps({ stack, registryRef, pc });
    const { inst, anchor } = base;
    const id = base.expectedWorktreeId;
    if (boot !== false) {
      mkdirSync(runDir(anchor), { recursive: true });
      writeFileSync(inst.configPath, stringifyYaml(bootConfig(boot.from ?? stack)));
      await pc.driver.up(inst, boot.namespaces);
      for (const name of boot.dead ?? []) pc.exit(inst.socketPath, name, -1);
    }
    const bootRequests = pc.requests.length;
    const effects = { lifecycleLock: 0, hashWrites: 0 };
    const deps: PcDeps = {
      ...base,
      readStoredHash: () => stackHash(stack),
      writeStoredHash: () => {
        effects.hashWrites++;
      },
      withLifecycleLock: async (_a, _i, fn) => {
        effects.lifecycleLock++;
        return fn();
      },
      // An old run's pid is not some unrelated process on this machine.
      isProcessAlive: () => false,
      ...extra,
    };
    /** process-compose's requests since the boot, by op. */
    const since = (...ops: PcRequest["op"][]) =>
      pc.requests.slice(bootRequests).filter((r) => ops.includes(r.op));
    return { deps, effects, since, pc, paths: inst, id, anchor, registryRef };
  }

  async function dryFailure(deps: CommandDeps) {
    return runUpDryRun(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
  }

  it("a bare dry run targets the booted namespaces, as the real bare up does (no default services)", async () => {
    const { deps, since } = await live(noDefault, { namespaces: ["local-backend"] });
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
    // Neither started, stopped nor attached an instance.
    expect(since("up", "down", "attach")).toEqual([]);
  });

  it("-n naming a namespace the instance was not booted with fails NAMESPACE_NOT_RUNNING, registry untouched", async () => {
    const { deps, id, registryRef } = await live(noDefault, { namespaces: ["local-backend"] });
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
    const { deps } = await live(noDefault, { namespaces: ["local-backend"] });
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
    const { deps, effects, since, pc, paths } = await live(stack, {
      namespaces: ["default"],
      dead: ["web", "db"],
    });
    const dry = await runUpDryRun(deps);
    // `depends_on` order, as the real restart uses.
    expect(dry.wouldRestart).toEqual(["db", "web"]);
    expect(since("up", "down", "attach", "start", "stop", "reload")).toEqual([]);
    expect(
      pc
        .rows(paths.socketPath)
        .filter((r) => r.running)
        .map((r) => r.name),
    ).toEqual(["ok"]);
    expect(effects.lifecycleLock).toBe(0);
  });

  it("reports a drifted stack as a reload without reloading, writing the config or the hash", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node b.js", ["WEB_PORT"])] };
    const { deps, effects, since, paths } = await live(
      stack,
      { namespaces: ["default"] },
      { readStoredHash: () => "older-hash" },
    );
    writeFileSync(paths.configPath, "processes: {}\n");
    const dry = await runUpDryRun(deps);
    expect(dry.instance).toBe("running");
    expect(dry.wouldReload).toBe(true);
    expect(since("reload")).toEqual([]);
    expect(effects.hashWrites).toBe(0);
    expect(readFileSync(paths.configPath, "utf8")).toBe("processes: {}\n");
  });

  it("a pending reload fails CONFIG_DRIFT reload_pending like the real up; the marker is kept", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node b.js"), isolated("api", "node api.js")],
    };
    // The reload has not landed yet: the instance still lists only api.
    const { deps, anchor, id } = await live(
      stack,
      { namespaces: ["default"], firstPid: 200, from: { services: [stack.services[1]!] } },
      { isProcessAlive: (pid) => pid === 100 },
    );
    const marker: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] };
    writePendingReload(anchor, id, marker);
    const err = await dryFailure(deps);
    expect(err?.code).toBe("CONFIG_DRIFT");
    expect(err?.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [100] });
    expect(readPendingReload(anchor, id)).toEqual(marker);
  });

  it("a converged pending reload passes, but only the real up clears its marker", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node b.js")] };
    const { deps, anchor, id } = await live(stack, { namespaces: ["default"], firstPid: 101 });
    const marker: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] };
    writePendingReload(anchor, id, marker);
    const dry = await runUpDryRun(deps);
    expect(dry.instance).toBe("running");
    expect(readPendingReload(anchor, id)).toEqual(marker);
  });

  it("a stale socket file previews a fresh start and is left in place", async () => {
    // process-compose died without cleaning up: its socket file stays, nothing answers.
    const { deps, paths, since, pc } = await live(noDefault, { namespaces: ["jobs"] });
    pc.crash(paths.socketPath);
    const dry = await runUpDryRun({ ...deps, namespaces: ["jobs"] });
    expect(dry.instance).toBe("fresh");
    expect(dry.selectedServices).toEqual(["worker"]);
    expect(existsSync(paths.socketPath)).toBe(true);
    expect(since("list")).toEqual([]);
  });

  it("with no instance running, a bare dry run of a stack with no default services still fails NO_SERVICES_SELECTED", async () => {
    const { deps } = await live(noDefault, false);
    const err = await dryFailure(deps);
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
  });

  /**
   * The real `up` hot-reloads a drifted stack before it reads the selection
   * back, so the preview must decide against the project the reload leaves.
   * `before` is the config the instance runs (on disk); process-compose's
   * reload works out the project the drifted config leaves.
   */
  describe("a drifted stack is previewed after its reload", () => {
    const lb = (name: string) => ({ ...isolated(name, `run ${name}`), namespace: "local-backend" });
    const jobs = (name: string) => ({ ...isolated(name, `run ${name}`), namespace: "jobs" });
    const before: ResolvedStack = { services: [lb("api"), lb("db"), jobs("worker")] };

    /** A live instance booted with `-n local-backend` from `before`, now drifted to `after`. */
    async function drifted(after: ResolvedStack) {
      const fixture = await live(
        after,
        { namespaces: ["local-backend"], from: before },
        { readStoredHash: () => stackHash(before) },
      );
      return { deps: fixture.deps, project: () => fixture.pc.rows(fixture.paths.socketPath) };
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
      const scoped = await drifted(after);
      const dryScoped = await runUpDryRun({ ...scoped.deps, namespaces: ["local-backend"] });
      expect(dryScoped.wouldReload).toBe(true);
      expect(dryScoped.selectedServices).toEqual(["api", "db", "cache"]);
      expect(await realChecks({ ...scoped.deps, namespaces: ["local-backend"] })).toEqual(
        dryScoped.selectedServices,
      );
      expect(scoped.project().map((r) => r.name)).toEqual(["api", "db", "cache"]);

      const bare = await drifted(after);
      const dryBare = await runUpDryRun(bare.deps);
      expect(dryBare.namespaces).toEqual(["local-backend"]);
      expect(dryBare.selectedServices).toEqual(["api", "db", "cache"]);
      expect(await realChecks(bare.deps)).toEqual(dryBare.selectedServices);
    });

    it("a service removed from a booted namespace", async () => {
      const after: ResolvedStack = { services: [lb("api"), jobs("worker")] };
      const { deps, project } = await drifted(after);
      const preview = await runUpDryRun(deps);
      expect(preview.namespaces).toEqual(["local-backend"]);
      expect(preview.selectedServices).toEqual(["api"]);
      expect(await realChecks(deps)).toEqual(preview.selectedServices);
      expect(project().map((r) => r.name)).toEqual(["api"]);
    });

    it("a service moved to an unbooted namespace leaves the project", async () => {
      const after: ResolvedStack = { services: [jobs("api"), lb("db"), jobs("worker")] };
      const bare = await drifted(after);
      const preview = await runUpDryRun(bare.deps);
      expect(preview.namespaces).toEqual(["local-backend"]);
      expect(preview.selectedServices).toEqual(["db"]);
      expect(await realChecks(bare.deps)).toEqual(preview.selectedServices);
      expect(bare.project().map((r) => r.name)).toEqual(["db"]);

      const scoped = await drifted(after);
      const err = await dryFailure({ ...scoped.deps, namespaces: ["jobs"] });
      expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
      expect(err?.details?.["services"]).toEqual(["api", "worker"]);
      expect(await realChecks({ ...scoped.deps, namespaces: ["jobs"] })).toBe(
        "NAMESPACE_NOT_RUNNING",
      );
    });

    it("a dead service the reload edits is started by the reload, so it is not in would_restart", async () => {
      const stack: ResolvedStack = {
        services: [isolated("edited", "run a"), isolated("kept", "run k"), isolated("ok", "run o")],
      };
      const { deps, paths } = await live(stack, {
        namespaces: ["default"],
        dead: ["edited", "kept"],
      });
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
    const { deps, anchor, id, pc, since } = await live(
      stack,
      { namespaces: ["default"], firstPid: 101 },
      { waitForHealth: async () => {} },
    );
    // process-compose fails its first `process list`, then answers.
    let reads = 0;
    const flaky: CommandDeps = {
      ...deps,
      processCompose: {
        ...pc.driver,
        getServiceStatuses: async (socketPath, opts) => {
          reads++;
          if (reads === 1) throw new Error("process list failed");
          return pc.driver.getServiceStatuses(socketPath, opts);
        },
      },
    };
    const marker: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] };
    writePendingReload(anchor, id, marker);
    await runUp(flaky);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(since("list").length).toBe(reads - 1);
    expect(readPendingReload(anchor, id)).toEqual(marker);
  });

  it("caps its process list read at 5s by default, and at --wait-timeout when given", async () => {
    // process-compose stops answering: every `process list` fails.
    const { deps, pc, paths } = await live(noDefault, { namespaces: ["local-backend"] });
    pc.freeze(paths.socketPath);
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
    const deps = pcDeps({ stack });

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

    // Nothing started, no config file on disk.
    expect(deps.pc.requests).toEqual([]);
    expect(deps.pc.isUp(deps.inst.socketPath)).toBe(false);
    expect(existsSync(deps.inst.configPath)).toBe(false);
  });

  it("derives both the worktree and shared config(s) + injects shared ports into env", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node server.js", ["WEB_PORT"]),
        shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
      ],
    };
    const deps = pcDeps({ stack });
    const result = await runUpDryRun(deps);

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
    expect(deps.pc.requests).toEqual([]);
    expect(deps.pc.isUp(deps.sharedInst.socketPath)).toBe(false);
  });

  it("omits the shared config when the stack declares no shared services", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUpDryRun(pcDeps({ stack }));
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
    const result = await runUpDryRun(pcDeps({ stack }));

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
    const result = await runUpDryRun(pcDeps({ stack }));
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
    const result = await runUpDryRun({ ...pcDeps({ stack }), namespaces: ["two"] });
    expect(result.droppedNamespaceEdges).toEqual([
      { from: "api", to: "db", toNamespaces: ["one", "three"] },
    ]);
    const kept = await runUpDryRun({ ...pcDeps({ stack }), namespaces: ["two", "three"] });
    expect(kept.droppedNamespaceEdges).toEqual([]);
  });

  it("reports no dropped edges when every depends_on stays within a tier", async () => {
    const web = { ...isolated("web", "node x.js", ["WEB_PORT"]), dependsOn: [{ name: "api" }] };
    const stack: ResolvedStack = {
      services: [web, isolated("api", "node api.js", ["API_PORT"])],
    };
    const result = await runUpDryRun(pcDeps({ stack }));
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
      ...pcDeps({ stack }),
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
    const base = pcDeps({ stack });
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
    // The process-compose Driver is the same one up/down use; the discoverer
    // is handed a read that reaches it.
    const pc = createInMemoryProcessCompose();
    const inst = instancePaths(tmp.anchor, "login");
    mkdirSync(inst.runDir, { recursive: true });
    writeFileSync(inst.configPath, stringifyYaml({ processes: { web: { command: "sleep 300" } } }));
    await pc.driver.up(inst);
    let received: ServiceStatus[] | undefined;
    const { runLs } = await import("./commands.js");
    await runLs({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      processCompose: pc.driver,
      probeSocket: (path) => pc.probeSocket(path),
      discover: async (_anchor, deps) => {
        received = await deps.getServiceStatuses?.(inst.socketPath);
        return [];
      },
    });
    // The read the discoverer was handed answers with the instance's rows.
    expect(received?.map((r) => [r.name, r.status, r.pid])).toEqual([
      ["web", "Running", pc.pidOf(inst.socketPath, "web")],
    ]);
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
    // `wedged` stops answering, like a SIGSTOPped process-compose: it still
    // accepts connections (the probe reads it running), so the read retries
    // until its budget runs out. `login` answers at once. Killing a hung
    // `process list` client at the cap is the real driver's, covered in
    // driver.test.ts ("kills a `process list` that never answers ...").
    const pc = createInMemoryProcessCompose();
    const login = instancePaths(tmp.anchor, "login");
    const wedged = instancePaths(tmp.anchor, "wedged");
    mkdirSync(login.runDir, { recursive: true });
    for (const inst of [login, wedged]) {
      writeFileSync(
        inst.configPath,
        stringifyYaml({ processes: { web: { command: "sleep 300" } } }),
      );
      await pc.driver.up(inst);
    }
    pc.freeze(wedged.socketPath);
    const reads: Array<{ socket: string; ms: number; ok: boolean }> = [];
    const { runLs } = await import("./commands.js");
    const started = Date.now();
    await runLs({
      cwd: join(tmp.worktreeRoot, "login"),
      git,
      processCompose: pc.driver,
      readTimeoutMs: 300,
      probeSocket: (path) => pc.probeSocket(path),
      discover: async (_anchor, deps) => {
        await Promise.all(
          [wedged.socketPath, login.socketPath].map(async (socket) => {
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
    const wedgedRead = reads.find((r) => r.socket === wedged.socketPath);
    expect(reads.find((r) => r.socket === login.socketPath)?.ok).toBe(true);
    expect(wedgedRead?.ok).toBe(false);
    // Retried for the whole budget, never waited on past it.
    expect(wedgedRead?.ms).toBeGreaterThanOrEqual(290);
    expect(wedgedRead?.ms).toBeLessThan(2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/**
 * A `CommandDeps` for `runAttach` on the in-memory process-compose; unlike
 * `pcDeps`, this skips the allocator/lock plumbing because `runAttach` does
 * not allocate ports or read the stack. `boot` starts an instance (one
 * `web` process) the way `up` leaves it running.
 */
function attachFixture(worktreeId = "login") {
  const tmp = tmpAnchor();
  const git = (args: ReadonlyArray<string>): string => {
    const flag = args[1];
    if (flag === "--git-common-dir") return tmp.anchor;
    if (flag === "--show-toplevel") return join(tmp.worktreeRoot, worktreeId);
    if (flag === "--is-bare-repository") return "false";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  const pc = createInMemoryProcessCompose();
  const deps: CommandDeps = {
    cwd: join(tmp.worktreeRoot, worktreeId),
    git,
    processCompose: pc.driver,
    probeSocket: (path) => pc.probeSocket(path),
  };
  const inst = instancePaths(tmp.anchor, idFor(tmp.worktreeRoot, worktreeId));
  const sharedInst = sharedInstancePaths(tmp.anchor);
  async function boot(target: InstanceRef): Promise<void> {
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(target.configPath, stringifyYaml({ processes: { web: { command: "x" } } }));
    await pc.driver.up(target);
  }
  /** The TUI attaches process-compose received. */
  const attaches = () => pc.requests.filter((r) => r.op === "attach");
  return { deps, pc, inst, sharedInst, boot, attaches };
}

describe("runAttach — attach to a running instance", () => {
  it("attaches the worktree instance by default — driver receives that socket", async () => {
    const { deps, inst, boot, attaches } = attachFixture();
    await boot(inst);

    await runAttach(deps, { shared: false });
    expect(attaches()).toEqual([{ op: "attach", socketPath: inst.socketPath }]);
  });

  it("attaches the shared instance with { shared: true }", async () => {
    const { deps, sharedInst, boot, attaches } = attachFixture();
    await boot(sharedInst);

    await runAttach(deps, { shared: true });
    expect(attaches()).toEqual([{ op: "attach", socketPath: sharedInst.socketPath }]);
  });

  it("throws a clear error when the worktree instance is not running", async () => {
    // Only the shared instance runs: attach must not fall back to it.
    const { deps, sharedInst, boot, pc } = attachFixture();
    await boot(sharedInst);
    await expect(runAttach(deps, { shared: false })).rejects.toThrow(/no worktree instance.*login/);
    expect(pc.requests.filter((r) => r.op !== "up")).toEqual([]);
  });

  it("throws a clear error when the shared instance is not running", async () => {
    const { deps, inst, boot, pc } = attachFixture();
    await boot(inst);
    await expect(runAttach(deps, { shared: true })).rejects.toThrow(
      /no shared instance is running/,
    );
    expect(pc.requests.filter((r) => r.op !== "up")).toEqual([]);
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
    writeFileSync(orphanConfig, stringifyYaml({ processes: { web: { command: "sleep 300" } } }));
    // The orphan's process-compose still runs.
    const pc = createInMemoryProcessCompose();
    await pc.driver.up({ configPath: orphanConfig, socketPath: orphanSocket });

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
      ...inMemoryPcDeps(pc),
    });

    // Acceptance: orphan is reported in the result.
    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
    // Acceptance: driver.down was called for the orphan only, and stopped it.
    expect(requestsOf(pc, "down").map((r) => r.socketPath)).toEqual([orphanSocket]);
    expect(pc.isUp(orphanSocket)).toBe(false);
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
    const orphan = instancePaths(tmp.anchor, "removed");
    const orphanSocket = orphan.socketPath;
    writeFileSync(
      orphan.configPath,
      stringifyYaml({ processes: { web: { command: "sleep 300" } } }),
    );
    // It is a live process-compose that was merely slow to answer.
    const pc = createInMemoryProcessCompose();
    await pc.driver.up(orphan);
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
      ...inMemoryPcDeps(pc),
    });
    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
    expect(requestsOf(pc, "down").map((r) => r.socketPath)).toEqual([orphanSocket]);
    expect(pc.isUp(orphanSocket)).toBe(false);
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
      // No server answers on the orphan's socket, so its `down` fails.
      ...inMemoryPcDeps(createInMemoryProcessCompose()),
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
    const pc = createInMemoryProcessCompose();
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
      // No server answers on the orphan's socket, so its `down` fails.
      ...inMemoryPcDeps(pc),
    });
    expect(requestsOf(pc, "down").map((r) => r.socketPath)).toEqual([orphanSocket]);
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

    const pc = createInMemoryProcessCompose();
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
      ...inMemoryPcDeps(pc),
    });

    expect(result.pruned.map((p) => p.id)).toEqual(["removed"]);
    // Acceptance: no driver.down for a stale instance — nothing is listening.
    expect(pc.requests).toEqual([]);
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
    const alpha = instancePaths(tmp.anchor, "alpha");
    const beta = instancePaths(tmp.anchor, "beta");
    const a = alpha.socketPath;
    const b = beta.socketPath;
    writeFileSync(alpha.configPath, stringifyYaml({ processes: { web: { command: "sleep 1" } } }));
    writeFileSync(beta.configPath, stringifyYaml({ processes: { web: { command: "sleep 1" } } }));
    // alpha's process-compose has died, leaving its socket file: its `down`
    // fails. beta's still runs.
    const pc = createInMemoryProcessCompose();
    await pc.driver.up(alpha);
    await pc.driver.up(beta);
    pc.crash(a);

    const git = pruneGit({
      anchor: tmp.anchor,
      worktreeRoot: tmp.worktreeRoot,
      worktreeId: "live",
      porcelain: [`worktree ${join(tmp.worktreeRoot, "live")}`, "HEAD x", ""].join("\n"),
    });
    const registryRef = { snapshot: { alpha: 20000, beta: 20032 } as RegistrySnapshot };
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
      ...inMemoryPcDeps(pc),
    });

    expect(result.pruned.map((p) => p.id).sort()).toEqual(["alpha", "beta"]);
    // alpha's down failed; beta's still ran and stopped it.
    expect(
      requestsOf(pc, "down")
        .map((r) => r.socketPath)
        .sort(),
    ).toEqual([a, b]);
    expect(pc.isUp(b)).toBe(false);
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
    // A running supervisor still serves the orphan's socket; a stale one left
    // only the file behind.
    const pc = createInMemoryProcessCompose();
    return { tmp, orphanSocket, orphanConfig, goneWorktree, git, registryRef, status, pc };
  }

  for (const status of ["running", "stale"] as const) {
    it(`runs each orphan's shutdown.command from the anchor (not the deleted working_dir) — ${status} supervisor (#148)`, async () => {
      const fx = reapFixture(status);
      if (status === "running") {
        await fx.pc.driver.up({ configPath: fx.orphanConfig, socketPath: fx.orphanSocket });
      }
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
        ...inMemoryPcDeps(fx.pc),
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
      // A running supervisor is also stopped gracefully; a stale one is not asked.
      expect(requestsOf(fx.pc, "down")).toHaveLength(status === "running" ? 1 : 0);
      expect(fx.pc.isUp(fx.orphanSocket)).toBe(false);
    });
  }

  it("reflects a failed orphan reap in PruneResult.warnings — NOT a silent clean teardown (#148 acceptance 5)", async () => {
    const fx = reapFixture("running");
    await fx.pc.driver.up({ configPath: fx.orphanConfig, socketPath: fx.orphanSocket });

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
      ...inMemoryPcDeps(fx.pc),
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
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node x.js", ["WEB_PORT"]),
        shared("postgres", "postgres", ["DB_PORT"]),
      ],
    };
    const { deps, pc } = onInMemoryPc(stubDeps({ stack }));
    await runEnv(deps);
    expect(pc.requests).toEqual([]);
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

/**
 * A `CommandDeps` for `runLogs` on the in-memory process-compose — no
 * allocator/lock plumbing needed. `boot` writes an instance's derived config
 * (`--all` enumerates services from it) and starts the instance from it;
 * `pc.log` makes a process write a line.
 */
function logsFixture(worktreeId = "login") {
  const tmp = tmpAnchor();
  const git = (args: ReadonlyArray<string>): string => {
    const flag = args[1];
    if (flag === "--git-common-dir") return tmp.anchor;
    if (flag === "--show-toplevel") return join(tmp.worktreeRoot, worktreeId);
    if (flag === "--is-bare-repository") return "false";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  const pc = createInMemoryProcessCompose();
  const deps: CommandDeps = {
    cwd: join(tmp.worktreeRoot, worktreeId),
    git,
    processCompose: pc.driver,
    probeSocket: (path) => pc.probeSocket(path),
  };
  const inst = instancePaths(tmp.anchor, idFor(tmp.worktreeRoot, worktreeId));
  const sharedInst = sharedInstancePaths(tmp.anchor);
  /** Start `target` running `services`, each having logged its `lines`. */
  async function boot(
    target: InstanceRef,
    services: ReadonlyArray<string>,
    lines: Readonly<Record<string, ReadonlyArray<string>>> = {},
  ): Promise<void> {
    mkdirSync(dirname(target.configPath), { recursive: true });
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const processes: Record<string, { command: string }> = {};
    for (const s of services) processes[s] = { command: "sleep 1" };
    writeFileSync(target.configPath, stringifyYaml({ processes }));
    await pc.driver.up(target);
    for (const [service, logged] of Object.entries(lines)) {
      for (const line of logged) pc.log(target.socketPath, service, line);
    }
  }
  /** The `process logs` reads process-compose served. */
  const logReads = () => pc.requests.filter((r) => r.op === "logs");
  return { deps, pc, inst, sharedInst, boot, logReads };
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

describe("runLogs — stream service logs without locking", () => {
  it("streams the worktree instance's named service from its socket", async () => {
    const { deps, inst, boot, logReads } = logsFixture();
    await boot(inst, ["web", "worker"], { web: ["hello", "world"], worker: ["other"] });

    const result = await runLogs(deps, { service: "web" });
    expect(result.services).toEqual(["web"]);
    const events = await collectLogs(result.events);
    expect(events).toEqual([
      { service: "web", line: "hello" },
      { service: "web", line: "world" },
    ]);
    expect(logReads()).toEqual([{ op: "logs", socketPath: inst.socketPath, services: ["web"] }]);
  });

  it("streams the shared instance with { shared: true } (different socket)", async () => {
    const { deps, inst, sharedInst, boot, logReads } = logsFixture();
    await boot(sharedInst, ["postgres"], { postgres: ["ready to accept connections"] });
    await boot(inst, ["web"], { web: ["not this one"] });

    const result = await runLogs(deps, { service: "postgres", shared: true });
    const events = await collectLogs(result.events);
    expect(events).toEqual([{ service: "postgres", line: "ready to accept connections" }]);
    expect(logReads().map((r) => r.socketPath)).toEqual([sharedInst.socketPath]);
  });

  it("throws a clear error when the worktree control socket is missing (→ INSTANCE_NOT_FOUND)", async () => {
    // Only the shared instance runs.
    const { deps, sharedInst, boot, logReads } = logsFixture();
    await boot(sharedInst, ["web"]);
    await expect(runLogs(deps, { service: "web" })).rejects.toThrow(/no worktree instance.*login/);
    expect(logReads()).toEqual([]);
  });

  it("throws when --shared is set and the shared socket is missing", async () => {
    const { deps, inst, boot, logReads } = logsFixture();
    await boot(inst, ["postgres"]);
    await expect(runLogs(deps, { service: "postgres", shared: true })).rejects.toThrow(
      /no shared instance is running/,
    );
    expect(logReads()).toEqual([]);
  });

  it("rejects an unknown service with SERVICE_NOT_FOUND before spawning anything (#109)", async () => {
    const { deps, inst, boot, logReads } = logsFixture();
    await boot(inst, ["web", "worker"]);

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
    // Fail-fast: no `process logs` read may have been made.
    expect(logReads()).toEqual([]);
  });

  it("rejects an unknown service on the shared instance the same way (#109)", async () => {
    const { deps, sharedInst, boot, logReads } = logsFixture();
    await boot(sharedInst, ["postgres"]);

    const err = (await runLogs(deps, { service: "web", shared: true }).then(
      () => undefined,
      (e: unknown) => e,
    )) as (Error & { code?: string; details?: Record<string, unknown> }) | undefined;
    expect(err).toBeInstanceOf(Error);
    expect(err?.code).toBe("SERVICE_NOT_FOUND");
    expect(err?.message).toContain("web");
    expect(err?.message).toContain("postgres");
    expect(err?.details).toEqual({ service: "web", valid_services: ["postgres"] });
    expect(logReads()).toEqual([]);
  });

  it("with { all: true }, enumerates services from the derived config and interleaves them", async () => {
    const { deps, inst, boot, logReads } = logsFixture();
    await boot(inst, ["web", "worker"], { web: ["w1", "w2"], worker: ["k1"] });

    const result = await runLogs(deps, { all: true });
    expect([...result.services].sort()).toEqual(["web", "worker"]);
    const events = await collectLogs(result.events);
    // Both services must appear; order is not guaranteed (real interleave).
    expect(events.map((e) => e.line).sort()).toEqual(["k1", "w1", "w2"]);
    // One read per service.
    expect(
      logReads()
        .flatMap((r) => r.services ?? [])
        .sort(),
    ).toEqual(["web", "worker"]);
  });

  it("forwards follow and tail to the driver: the last N lines, then new ones as they come", async () => {
    const { deps, pc, inst, boot } = logsFixture();
    await boot(inst, ["web"], { web: ["old", "a", "b"] });
    const result = await runLogs(deps, { service: "web", follow: true, tail: 2 });
    const seen: string[] = [];
    const drained = (async () => {
      for await (const ev of result.events) {
        seen.push(ev.line);
        // Following: a line logged after the history is streamed too.
        if (ev.line === "b") pc.log(inst.socketPath, "web", "c");
      }
    })();
    await vi.waitFor(() => expect(seen).toEqual(["a", "b", "c"]));
    // The follow ends when the instance goes away.
    await pc.driver.down(inst);
    await drained;
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("an aborted signal ends a quiet follow on every service, with the instance still up (#282)", async () => {
    const { deps, pc, inst, boot } = logsFixture();
    await boot(inst, ["web", "worker"], { web: ["a"], worker: ["b"] });
    const controller = new AbortController();
    const result = await runLogs(deps, { all: true, follow: true, signal: controller.signal });
    const seen: string[] = [];
    const drained = (async () => {
      for await (const ev of result.events) seen.push(ev.line);
    })();
    await vi.waitFor(() => expect([...seen].sort()).toEqual(["a", "b"]));
    // Nothing more is logged, so each follower is parked waiting for a line.
    controller.abort();
    await drained;
    expect(pc.isUp(inst.socketPath)).toBe(true);
  });

  it("does not take the allocation-registry lock (lock-free path)", async () => {
    const { deps: base, inst, boot } = logsFixture();
    await boot(inst, ["web"], { web: ["a"] });

    let lockCalls = 0;
    const deps: CommandDeps = {
      ...base,
      withRegistryLock: () => {
        lockCalls++;
        throw new Error("runLogs must not take the allocation-registry lock");
      },
    };
    const result = await runLogs(deps, { service: "web" });
    expect(await collectLogs(result.events)).toEqual([{ service: "web", line: "a" }]);
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
    const { deps, inst, boot } = logsFixture();
    await boot(inst, ["web"], { web: ["hello", "world"] });

    // Events are stamped at read time (now), so a 1h window keeps them all.
    const result = await runLogs(deps, { service: "web", sinceMs: 3_600_000 });
    const events = await collectLogs(result.events);
    expect(events).toEqual([
      { service: "web", line: "hello" },
      { service: "web", line: "world" },
    ]);
  });

  it("rejects a non-finite or negative sinceMs before spawning anything", async () => {
    const { deps, inst, boot, logReads } = logsFixture();
    await boot(inst, ["web"], { web: ["a"] });

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5_000]) {
      await expect(runLogs(deps, { service: "web", sinceMs: bad })).rejects.toThrow(/since/);
      expect(logReads()).toHaveLength(0);
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

  /** The config reloads process-compose received. */
  const reloads = (pc: InMemoryProcessCompose) => pc.requests.filter((r) => r.op === "reload");

  it("writes the stack hash to the hash store after a successful first up", async () => {
    const hashes = hashStore();
    const base = pcDeps({ stack: stackA });
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
    const hashes = hashStore();
    const registryRef = { snapshot: {} as RegistrySnapshot };
    let writeCalls = 0;
    const base = pcDeps({ stack: stackA, registryRef });
    const deps: CommandDeps = {
      ...base,
      readStoredHash: hashes.read,
      writeStoredHash: (anchor, id, h) => {
        writeCalls++;
        hashes.write(anchor, id, h);
      },
    };

    const first = await runUp(deps);
    const firstWriteCount = writeCalls;
    const webPid = base.pc.pidOf(base.inst.socketPath, "web");

    const second = await runUp(deps);

    // Same envelope shape.
    expect(second.env).toEqual(first.env);
    expect(second.blockBase).toBe(first.blockBase);
    // Started once; the running web was left alone.
    expect(upsOn(base.pc, base.inst.socketPath)).toHaveLength(1);
    expect(base.pc.pidOf(base.inst.socketPath, "web")).toBe(webPid);
    // No additional hash store write.
    expect(writeCalls).toBe(firstWriteCount);
  });

  it("noop path populates services[] from process-compose's rows for the running instance", async () => {
    const probed: ResolvedStack = {
      services: [{ ...isolated("web", "node a.js", ["WEB_PORT"]), readinessProbe: { exec: {} } }],
    };
    const hashes = hashStore();
    const deps: CommandDeps = {
      ...pcDeps({ stack: probed }),
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };
    await runUp(deps);
    const second = await runUp(deps);
    expect(second.services).toEqual([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: second.blockBase } },
    ]);
  });

  it("on drift, calls driver.reloadConfig and on success returns the new envelope + updates the stored hash", async () => {
    const hashes = hashStore();

    // Seed the hash store with the OLD stack's hash so the second up sees drift.
    const baseDeps = pcDeps({ stack: stackA });
    const { pc, inst } = baseDeps;
    const firstDeps: CommandDeps = {
      ...baseDeps,
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const webPid = pc.pidOf(inst.socketPath, "web");

    // Now swap to a different stack — same worktree/anchor/registry deps —
    // so the second up sees drift relative to the stored hash.
    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => stackB };
    const result = await runUp(secondDeps);

    // The reload asks the worktree's own instance to re-read its config.
    expect(reloads(pc)).toEqual([{ op: "reload", socketPath: inst.socketPath }]);
    // Driver.up was NOT called a second time — reload, not restart of the
    // instance; process-compose restarted the changed web.
    expect(upsOn(pc, inst.socketPath)).toHaveLength(1);
    expect(pc.pidOf(inst.socketPath, "web")).not.toBe(webPid);
    expect(pc.rows(inst.socketPath)).toMatchObject([{ name: "web", status: "Running" }]);
    // Envelope is well-formed.
    expect(result.env.WEB_PORT).toBeDefined();
    // Stored hash was updated to the new stack's hash.
    const anchorStore = Object.values(hashes.raw)[0];
    if (!anchorStore) throw new Error("expected hash store entry");
    expect(anchorStore[baseDeps.expectedWorktreeId]).toBe(stackHash(stackB));
  });

  it("a probe-only edit triggers the drift/reload path on the next up (#86)", async () => {
    const hashes = hashStore();

    const baseDeps = pcDeps({ stack: stackA });
    const firstDeps: CommandDeps = {
      ...baseDeps,
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);

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
    expect(reloads(baseDeps.pc)).toHaveLength(1);
    expect(upsOn(baseDeps.pc, baseDeps.inst.socketPath)).toHaveLength(1);
    expect(result.env.WEB_PORT).toBeDefined();
    // Stored hash now reflects the probed stack.
    const anchorStore = Object.values(hashes.raw)[0];
    if (!anchorStore) throw new Error("expected hash store entry");
    expect(anchorStore[baseDeps.expectedWorktreeId]).toBe(stackHash(probed));
  });

  it("a namespace-only edit triggers the drift/reload path on the next up (#175)", async () => {
    const hashes = hashStore();
    // `api` stays in `default`, so the instance keeps running once `web` leaves it.
    const api = isolated("api", "node api.js");
    const baseDeps = pcDeps({ stack: { services: [...stackA.services, api] } });
    const firstDeps: CommandDeps = {
      ...baseDeps,
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };
    await runUp(firstDeps);

    const moved: ResolvedStack = {
      services: [{ ...isolated("web", "node a.js", ["WEB_PORT"]), namespace: "backend" }, api],
    };
    await runUp({ ...firstDeps, readStack: () => moved });

    expect(reloads(baseDeps.pc)).toHaveLength(1);
    expect(upsOn(baseDeps.pc, baseDeps.inst.socketPath)).toHaveLength(1);
    // The reload dropped web from the instance booted with `-n default`.
    expect(baseDeps.pc.rows(baseDeps.inst.socketPath).map((r) => r.name)).toEqual(["api"]);
    const anchorStore = Object.values(hashes.raw)[0];
    if (!anchorStore) throw new Error("expected hash store entry");
    expect(anchorStore[baseDeps.expectedWorktreeId]).toBe(stackHash(moved));
  });

  it("on drift, if driver.reloadConfig reports not_supported, throws an Error tagged code:CONFIG_DRIFT and does not update the stored hash", async () => {
    const hashes = hashStore();

    const baseDeps = pcDeps({ stack: stackA });
    // A process-compose build without the reload route.
    const firstDeps: CommandDeps = {
      ...baseDeps,
      processCompose: reloadFailing(baseDeps.pc, { ok: false, reason: "not_supported" }),
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const storedAfterFirst = Object.values(hashes.raw)[0]?.[baseDeps.expectedWorktreeId];
    if (storedAfterFirst === undefined) throw new Error("expected a stored hash after first up");
    const webPid = baseDeps.pc.pidOf(baseDeps.inst.socketPath, "web");

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
    // The instance keeps running unchanged.
    expect(baseDeps.pc.pidOf(baseDeps.inst.socketPath, "web")).toBe(webPid);
  });

  it("on failed reload, the on-disk derived config is restored to match the running instance (#92)", async () => {
    // The drift path used to write the new config before attempting the
    // reload; on failure the on-disk config no longer matched the running
    // instance, so `ls` (which reads ports from the derived config) reported
    // ports that were never bound.
    const hashes = hashStore();

    const baseDeps = pcDeps({ stack: stackA });
    // process-compose refuses the reload.
    const firstDeps: CommandDeps = {
      ...baseDeps,
      processCompose: reloadFailing(baseDeps.pc, {
        ok: false,
        reason: "error",
        message: "process-compose config reload answered HTTP 400",
      }),
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const { configPath } = baseDeps.inst;
    const configBefore = readFileSync(configPath, "utf8");

    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => stackB };
    await expect(runUp(secondDeps)).rejects.toThrow(/drift/i);

    // The on-disk derived config still describes what the instance is
    // actually running (stackA), byte-for-byte.
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(parsed.processes.web?.command).toBe("node a.js");
  });

  it("on drift, a reload that never answers is bounded: CONFIG_DRIFT, config restored, hash invalidated (#191)", async () => {
    // process-compose's config reload blocks until each changed process's old
    // incarnation exits. When it never exits (a shutdown.command that does not stop
    // it, or SIGTERM ignored with no shutdown.timeout_seconds), `up` used to hang.
    // The driver bounds the request and reports reason:'timeout' (its abort is
    // covered in src/driver.test.ts).
    const hashes = hashStore();
    const baseDeps = pcDeps({ stack: stackA });
    const firstDeps: CommandDeps = {
      ...baseDeps,
      processCompose: reloadFailing(baseDeps.pc, {
        ok: false,
        reason: "timeout",
        message: "process-compose config reload did not finish within 0s",
      }),
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);
    const { configPath } = baseDeps.inst;
    const configBefore = readFileSync(configPath, "utf8");
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
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    // Neither the old hash nor the new one: process-compose is still applying
    // the new config, so the next `up` must see drift once that converges.
    const storedAfter = Object.values(hashes.raw)[0]?.[baseDeps.expectedWorktreeId];
    expect(storedAfter).not.toBe(storedBefore);
    expect(storedAfter).not.toBe(stackHash(stackB));
  });

  it("on successful reload, the new derived config is on disk (#92)", async () => {
    const hashes = hashStore();

    const baseDeps = pcDeps({ stack: stackA });
    const firstDeps: CommandDeps = {
      ...baseDeps,
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };

    await runUp(firstDeps);

    const secondDeps: CommandDeps = { ...firstDeps, readStack: () => stackB };
    await runUp(secondDeps);

    const parsed = parseYaml(readFileSync(baseDeps.inst.configPath, "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(parsed.processes.web?.command).toBe("node b.js");
  });

  it("noop path does NOT call driver.reloadConfig (no process-compose churn when the config matches)", async () => {
    const hashes = hashStore();
    const baseDeps = pcDeps({ stack: stackA });
    const deps: CommandDeps = {
      ...baseDeps,
      readStoredHash: hashes.read,
      writeStoredHash: hashes.write,
    };
    await runUp(deps);
    await runUp(deps);
    expect(reloads(baseDeps.pc)).toHaveLength(0);
  });
});

/**
 * A reload whose old process never stops leaves process-compose applying it
 * after `up` gave up; reloading again in that window starts an untracked
 * second copy (#191). `up` refuses with `CONFIG_DRIFT` / `reload_pending`
 * until the pending update has converged.
 */
describe("runUp — pending-reload guard (#191)", () => {
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

  type Processes = Record<string, Record<string, unknown>>;
  const processesIn = (path: string): Processes =>
    (parseYaml(readFileSync(path, "utf8")) as { processes?: Processes }).processes ?? {};

  /**
   * An instance on the in-memory process-compose (pids from 100) whose config
   * reload the test drives. `reload: "hang"` never finishes, like
   * process-compose waiting on an old process that will not stop: the
   * request times out and process-compose keeps applying the update in the
   * background. The test then moves that update along:
   *
   *  - `begin()`: process-compose drops each changed or removed process; its
   *    old run stays alive (stuck) until it exits or devtrees kills it;
   *  - `finish()`: the update lands; the changed processes run again with new pids.
   *
   * The OS process table (`ps`, liveness, kill) is process-compose (pid 9)
   * with every running process and stuck old run as its child.
   */
  function fixture(stack: ResolvedStack = stackA) {
    const pc = createInMemoryProcessCompose({ firstPid: 100 });
    const base = pcDeps({ stack, pc });
    const { inst } = base;
    const state = {
      stack,
      reload: "ok" as "ok" | "hang",
      reloads: 0,
      /** Old runs process-compose stopped tracking that have not exited. */
      stuck: new Set<number>(),
      /** What process-compose does once devtrees SIGKILLs `pid`. */
      onKill: undefined as ((pid: number) => void) | undefined,
      /** What process-compose does when a reload request arrives. */
      onReload: undefined as (() => void) | undefined,
    };
    /** The config process-compose last finished applying, and the one it is applying. */
    let applied: Processes = {};
    let pending: Processes | undefined;

    /** Apply `processes` to the running instance, as process-compose's reload does. */
    async function apply(processes: Processes): Promise<void> {
      const scratch = { configPath: `${inst.configPath}.applying`, socketPath: inst.socketPath };
      writeFileSync(scratch.configPath, stringifyYaml({ processes }));
      await pc.driver.reloadConfig(scratch);
      rmSync(scratch.configPath, { force: true });
    }

    const runningPids = (): number[] => {
      if (!pc.isUp(inst.socketPath)) return [];
      return pc.rows(inst.socketPath).flatMap((r) => (r.running && r.pid ? [r.pid] : []));
    };
    const alive = (pid: number) => state.stuck.has(pid) || runningPids().includes(pid);

    const driver: Driver = {
      ...pc.driver,
      async up(target, namespaces) {
        await pc.driver.up(target, namespaces);
        if (target.socketPath === inst.socketPath) applied = processesIn(target.configPath);
      },
      async reloadConfig(target, opts) {
        state.reloads++;
        state.onReload?.();
        if (state.reload === "ok") {
          const result = await pc.driver.reloadConfig(target, opts);
          applied = processesIn(target.configPath);
          return result;
        }
        pending = processesIn(target.configPath);
        return {
          ok: false,
          reason: "timeout",
          message:
            "process-compose config reload did not finish within 0s; a changed service's " +
            "old process has not stopped",
        };
      },
    };

    const pendingUpdate = {
      /** process-compose drops what the update changes or removes; their old runs live on. */
      async begin(): Promise<void> {
        if (pending === undefined) throw new Error("no reload is pending");
        const next = pending;
        const unchanged = Object.fromEntries(
          Object.entries(next).filter(([name, def]) => isDeepStrictEqual(applied[name], def)),
        );
        for (const name of Object.keys(applied)) {
          if (!(name in unchanged)) {
            const pid = pc.pidOf(inst.socketPath, name);
            if (pid !== undefined) state.stuck.add(pid);
          }
        }
        await apply(unchanged);
      },
      /** The update lands: what it changed or added runs again. */
      async finish(): Promise<void> {
        if (pending === undefined) throw new Error("no reload is pending");
        await apply(pending);
        applied = pending;
        pending = undefined;
      },
    };

    const deps: CommandDeps = {
      ...base,
      readStack: () => state.stack,
      processCompose: driver,
      isProcessAlive: alive,
      // Never the real `process.kill`: a SIGKILL ends the stuck old run.
      stop: {
        readProcessTable: async () => [
          { pid: 9, ppid: 1, pgid: 9, command: `process-compose up -u ${inst.socketPath}` },
          ...[...state.stuck, ...runningPids()].map((pid) => ({
            pid,
            ppid: 9,
            pgid: pid,
            command: `cmd-${pid}`,
          })),
        ],
        kill: (target) => {
          state.stuck.delete(Math.abs(target));
          state.onKill?.(Math.abs(target));
        },
        // process-compose (pid 9) stays up throughout.
        isAlive: (pid) => pid === 9 || alive(pid),
        settleMs: 20,
        pollMs: 2,
        stuckGraceMs: 0,
      },
    };
    const where = (): { anchor: string; id: string } => ({
      anchor: base.anchor,
      id: base.expectedWorktreeId,
    });
    const marker = (): PendingReload | undefined =>
      readPendingReload(base.anchor, base.expectedWorktreeId);
    const pidOf = (name: string) => pc.pidOf(inst.socketPath, name);
    return { state, deps, marker, where, pendingUpdate, pc, inst, pidOf };
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
    const { state, deps, marker, pendingUpdate, pidOf } = fixture(stackA);
    await runUp(deps);
    expect(pidOf("web")).toBe(100);

    state.stack = stackB;
    state.reload = "hang";
    const timedOut = await upError(deps);
    expect(timedOut.details).toEqual({ reason: "timeout" });
    expect(marker()).toEqual({
      services: ["web"],
      oldRuns: [{ name: "web", pid: 100, identity: { ppid: 9, pgid: 100, command: "cmd-100" } }],
    });

    // process-compose dropped `web` and is waiting for pid 100 to exit.
    await pendingUpdate.begin();
    const retry = await upError(deps);
    expect(retry.code).toBe("CONFIG_DRIFT");
    expect(retry.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [100] });
    expect(retry.message).toMatch(/kill 100/);
    expect(state.reloads).toBe(1);

    // The old process exited, but the pending update has not started the
    // new one yet: still pending, now without a PID to kill.
    state.stuck.delete(100);
    const between = await upError(deps);
    expect(between.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [] });
    expect(state.reloads).toBe(1);

    // The pending update finished: `up` resyncs and the marker is gone.
    await pendingUpdate.finish();
    state.reload = "ok";
    await runUp(deps);
    expect(state.reloads).toBe(2);
    expect(marker()).toBeUndefined();
  });

  it("reverting devtrees.yaml mid-reload: refused while pending, then the reverted config is re-applied", async () => {
    const { state, deps, marker, where, pendingUpdate, pc, inst } = fixture(stackA);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    await upError(deps);
    // Reverting devtrees.yaml does not stop process-compose applying stackB.
    state.stack = stackA;
    await pendingUpdate.begin();
    const err = await upError(deps);
    expect(err.details).toMatchObject({ reason: "reload_pending", services: ["web"] });
    expect(marker()).toBeDefined();

    // The old process exits and process-compose finishes applying stackB.
    // devtrees.yaml, the derived config and (before #191's fix) the stored
    // hash all said stackA, so `up` used to see no drift and leave B running.
    state.stuck.delete(100);
    await pendingUpdate.finish();
    state.reload = "ok";
    await runUp(deps);
    expect(state.reloads).toBe(2);
    expect(marker()).toBeUndefined();
    const { anchor, id } = where();
    const onDisk = parseYaml(readFileSync(join(anchor, "devtrees", `${id}.yaml`), "utf8")) as {
      processes: Record<string, { command: string }>;
    };
    expect(onDisk.processes.web?.command).toBe("node a.js");
    expect(pc.rows(inst.socketPath).map((r) => r.name)).toEqual(["api", "web"]);
    // Converged: the next `up` is a noop.
    await runUp(deps);
    expect(state.reloads).toBe(2);
  });

  it("retries an empty ps read when it records the old runs' identity", async () => {
    const { state, deps, marker } = fixture(stackA);
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
    const { state, deps, marker, pendingUpdate } = fixture(stackA);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    // process-compose drops `web` as soon as its update begins.
    state.onReload = () => {
      // The reload request has just reached process-compose; its update begins.
      queueMicrotask(() => void pendingUpdate.begin());
    };
    const before = Date.now();
    await upError(deps);
    const [web] = marker()?.oldRuns ?? [];
    expect(web?.unlistedAt).toBeGreaterThanOrEqual(before);
    expect(web?.unlistedAt).toBeLessThanOrEqual(Date.now());
  });

  it("down kills the stuck old run, waits for the new copy, stops, and clears the marker", async () => {
    const { state, deps, marker, pendingUpdate, pc, inst } = fixture(stackA);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    await upError(deps);
    expect(marker()).toBeDefined();
    // process-compose dropped `web` and waits on pid 100. Once it dies, the
    // pending update lists `web` again with a new pid.
    await pendingUpdate.begin();
    state.onKill = (pid) => {
      if (pid === 100) void pendingUpdate.finish();
    };
    const result = await runDown(deps);
    expect(result.forceKilled).toEqual([{ service: "web", pid: 100 }]);
    expect(marker()).toBeUndefined();
    expect(pc.isUp(inst.socketPath)).toBe(false);
  });

  it("down does not stop the instance while the pending update never finishes, and keeps the marker", async () => {
    const { state, deps, marker, pendingUpdate, pc, inst } = fixture(stackA);
    await runUp(deps);
    state.stack = stackB;
    state.reload = "hang";
    await upError(deps);
    await pendingUpdate.begin();
    const err = await runDown(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    expect(err?.code).toBe("DOWN_TIMEOUT");
    expect(err?.details).toMatchObject({ pending_reload: ["web"], stuck_services: [] });
    expect(marker()).toBeDefined();
    expect(pc.isUp(inst.socketPath)).toBe(true);
  });

  it("a fresh start clears a marker left by an instance that is gone", async () => {
    const { deps, marker, where, pc, inst } = fixture(stackA);
    await runUp(deps);
    const { anchor, id } = where();
    writePendingReload(anchor, id, { services: ["web"], oldRuns: [{ name: "web", pid: 100 }] });
    // The instance died (stale socket): this `up` starts a new one.
    pc.crash(inst.socketPath);
    await runUp(deps);
    expect(marker()).toBeUndefined();
    expect(upsOn(pc, inst.socketPath)).toHaveLength(2);
    expect(pc.isUp(inst.socketPath)).toBe(true);
  });

  it("no marker: a service absent from the project does not block a reload", async () => {
    // Without a marker there is nothing to wait on: the project's shape alone
    // is not evidence (a timed-out rename leaves a stale on-disk config).
    const { state, deps, pendingUpdate, pc, inst, where } = fixture(stackA);
    await runUp(deps);
    // process-compose dropped `web` (an update it is still applying), and no
    // marker records it.
    state.stack = stackB;
    state.reload = "hang";
    await upError(deps);
    await pendingUpdate.begin();
    clearPendingReload(where().anchor, where().id);
    expect(pc.rows(inst.socketPath).map((r) => r.name)).toEqual(["api"]);
    state.reload = "ok";
    await runUp(deps);
    expect(state.reloads).toBe(2);
  });

  it("a timed-out rename converges: once the old pid exits, up succeeds and the next up is a noop", async () => {
    const before: ResolvedStack = {
      services: [svc("keeper", "node k.js"), svc("web", "node a.js")],
    };
    const { state, deps, marker, pendingUpdate, pc, inst, pidOf } = fixture(before);
    await runUp(deps);
    const webPid = pidOf("web");
    // Rename web -> web2; the old `web` never stops, so the reload times out.
    state.stack = { services: [svc("keeper", "node k.js"), svc("web2", "node a.js")] };
    state.reload = "hang";
    await upError(deps);
    expect(marker()).toEqual({
      services: [],
      oldRuns: [
        {
          name: "web",
          pid: webPid,
          identity: { ppid: 9, pgid: webPid, command: `cmd-${webPid}` },
        },
      ],
    });

    // Still pending while the old pid lives...
    await pendingUpdate.begin();
    const pending = await upError(deps);
    expect(pending.details).toEqual({
      reason: "reload_pending",
      services: ["web"],
      pids: [webPid],
    });

    // ...and converged once it exits: process-compose runs keeper + web2. The
    // restored on-disk config still names `web`; that must not read as stuck.
    state.stuck.delete(webPid!);
    await pendingUpdate.finish();
    expect(pc.rows(inst.socketPath).map((r) => r.name)).toEqual(["keeper", "web2"]);
    state.reload = "ok";
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
    const { state, deps, pendingUpdate } = fixture(wide);
    await runUp({ ...deps, namespaces: ["one", "two"] });
    state.stack = {
      services: [svc("web", "node b.js", "one"), svc("worker", "node w.js", "two")],
    };
    state.reload = "hang";
    await upError({ ...deps, namespaces: ["one"] });
    // The old `web` exited; process-compose has not started the new one yet.
    await pendingUpdate.begin();
    state.stuck.delete(100);
    const err = await upError({ ...deps, namespaces: ["one"] });
    expect(err.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [] });
    expect(err.message).toContain("`devtrees down && devtrees up -n one -n two`");
  });

  it("an empty-selection instance can no longer exist: `-n nope` is refused before any boot or reload (#203)", async () => {
    // process-compose exits after reloading an empty project, so `up -n nope`
    // never boots one (it used to, #176).
    const { state, deps, pc } = fixture(stackA);
    await expect(upError({ ...deps, namespaces: ["nope"] })).resolves.toMatchObject({
      code: "NO_SERVICES_SELECTED",
    });
    expect(state.reloads).toBe(0);
    expect(requestsOf(pc, "up")).toEqual([]);
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
    const { state, deps, pc, inst } = fixture(stack);
    await runUp({ ...deps, namespaces: ["two"] });
    expect(pc.rows(inst.socketPath).map((r) => r.name)).toEqual(["db", "worker"]);
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
    const { state, deps } = fixture(wide);
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
  /** A process-compose config entry for `s`: what process-compose selects and probes on. */
  const procOf = (s: ResolvedService) => ({
    command: s.command,
    ...(s.namespace !== undefined ? { namespace: s.namespace } : {}),
    ...(s.readinessProbe !== undefined ? { readiness_probe: s.readinessProbe } : {}),
  });

  /**
   * A live worktree instance on the in-memory process-compose, booted with
   * `boot.namespaces` (default `default`) from the stack's isolated services,
   * plus a live shared instance of its shared services when it has any. The
   * stored hash matches, so `runUp` takes the already-running path with no
   * reload. The real health wait runs (no `waitForHealth` stub).
   *
   * Tests make things happen to the processes through `pc` (`exit`,
   * `backoff`, `setReady`, `refuse`), and to the requests as they arrive
   * through `on`. `ours(...ops)` lists the requests `up` made since the
   * boot; `byOthers` makes requests on someone else's behalf (a concurrent
   * `devtrees` or a human), which `ours` leaves out.
   */
  async function liveInstance(
    stack: ResolvedStack,
    boot: { namespaces?: string[]; worktree?: boolean } = {},
    extra: Partial<CommandDeps> = {},
  ) {
    const hooks: Array<{ op: PcRequest["op"]; fn: (r: PcRequest) => void }> = [];
    const others = new Set<PcRequest>();
    let external = false;
    const pc = createInMemoryProcessCompose({
      onRequest: (r) => {
        if (external) others.add(r);
        for (const h of hooks) if (h.op === r.op) h.fn(r);
      },
    });
    const base = pcDeps({ stack, pc });
    const { inst, sharedInst, anchor } = base;
    mkdirSync(runDir(anchor), { recursive: true });
    const config = (tier: "isolated" | "shared") => ({
      processes: Object.fromEntries(
        stack.services.filter((s) => s.tier === tier).map((s) => [s.name, procOf(s)]),
      ),
    });
    if (stack.services.some((s) => s.tier === "shared")) {
      writeFileSync(sharedInst.configPath, stringifyYaml(config("shared")));
      await pc.driver.up(sharedInst);
    }
    if (boot.worktree !== false) {
      writeFileSync(inst.configPath, stringifyYaml(config("isolated")));
      await pc.driver.up(inst, boot.namespaces ?? ["default"]);
    }
    const booted = pc.requests.length;
    const deps: CommandDeps = {
      ...base,
      waitForHealth: undefined,
      readStoredHash: () => stackHash(stack),
      writeStoredHash: () => {},
      ...extra,
    };
    return {
      deps,
      pc,
      wtSocket: inst.socketPath,
      sharedSocket: sharedInst.socketPath,
      id: base.expectedWorktreeId,
      anchor,
      /** Run `fn` as each `op` request reaches process-compose, before it is answered. */
      on: (op: PcRequest["op"], fn: (r: PcRequest) => void): void => {
        hooks.push({ op, fn });
      },
      /** Requests made in `fn` are someone else's, not `up`'s. */
      byOthers: (fn: () => void): void => {
        external = true;
        try {
          fn();
        } finally {
          external = false;
        }
      },
      /** The requests `up` made since the boot, by op (all of them when none given). */
      ours: (...ops: PcRequest["op"][]): PcRequest[] =>
        pc.requests
          .slice(booted)
          .filter((r) => !others.has(r) && (ops.length === 0 || ops.includes(r.op))),
    };
  }

  async function failure(deps: CommandDeps) {
    return runUp(deps).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
  }

  /** Requests that start, stop, reload or attach an instance. */
  const lifecycle = ["up", "down", "reload", "attach"] as const;

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

  it("#179: warns about edges the effective (read-back) selection drops on a bare up", async () => {
    // Booted with -n one: web and db present, api absent. web -> api is dropped.
    const warnings: string[] = [];
    const { deps } = await liveInstance(
      listNamespaces,
      { namespaces: ["one"] },
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
    const { deps, ours, id } = await liveInstance(twoNamespaces, { namespaces: ["one"] });
    const err = await failure({ ...deps, namespaces: ["nope"] });
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
    expect(err?.details).toEqual({
      worktree_id: id,
      selected_namespaces: ["nope"],
      namespaces: ["one", "two"],
    });
    expect(ours(...lifecycle)).toEqual([]);
  });

  it("#203: -n one -n nope on a running instance keeps today's behaviour for the real namespace", async () => {
    const waited: string[][] = [];
    const { deps } = await liveInstance(
      twoNamespaces,
      { namespaces: ["one"] },
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
    const { deps, ours, id } = await liveInstance(twoNamespaces, { namespaces: ["one"] });
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
    expect(ours(...lifecycle, "start", "stop")).toEqual([]);
  });

  it("a narrower -n than what runs leaves the rest alone and does not fail", async () => {
    const waited: string[][] = [];
    const { deps, ours, pc, wtSocket } = await liveInstance(
      twoNamespaces,
      { namespaces: ["one", "two"] },
      {
        namespaces: ["one"],
        waitForHealth: async ({ serviceNames }) => {
          waited.push([...serviceNames]);
        },
      },
    );
    pc.exit(wtSocket, "b", -1);
    await expect(runUp(deps)).resolves.toBeDefined();
    // Only `one` is checked — `b` being dead in `two` is not this call's
    // business, so it is not restarted either (#178).
    expect(waited).toEqual([["a"]]);
    expect(ours(...lifecycle, "start", "stop")).toEqual([]);
    expect(pc.rows(wtSocket).find((r) => r.name === "b")).toMatchObject({ status: "Completed" });
  });

  describe("restarting dead isolated services (#178)", () => {
    const toyStack: ResolvedStack = {
      services: [
        { ...isolated("toy", "python3 -m http.server", ["TOY_PORT"]), namespace: "test" },
        { ...isolated("keeper", "sleep 100000"), namespace: "test" },
      ],
    };

    it("#162: a killed service is started again over the control socket, then up succeeds", async () => {
      const { deps, ours, pc, wtSocket } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"], waitTimeoutMs: 10_000 },
      );
      pc.exit(wtSocket, "toy", -1);
      const deadPid = pc.pidOf(wtSocket, "toy");
      const result = await runUp(deps);
      expect(ours("start")).toEqual([{ op: "start", socketPath: wtSocket, services: ["toy"] }]);
      expect(result.restarted).toEqual(["toy"]);
      expect(pc.rows(wtSocket).find((r) => r.name === "toy")).toMatchObject({ status: "Running" });
      expect(pc.pidOf(wtSocket, "toy")).not.toBe(deadPid);
      // Never stops anything: no `down`, no `up`, no reload.
      expect(ours(...lifecycle, "stop")).toEqual([]);
    });

    it("the stale pre-restart row read right after `process start` does not fail-fast", async () => {
      // process-compose accepts the start but lists the old corpse (same pid:
      // not a new death) for three more reads before the new run shows up.
      const { deps, pc, wtSocket, on } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"], waitTimeoutMs: 10_000 },
      );
      pc.exit(wtSocket, "toy", -1);
      let staleReads: number | undefined;
      const lagging: CommandDeps = {
        ...deps,
        processCompose: {
          ...pc.driver,
          startProcess: async () => {
            staleReads = 3;
            return { ok: true, alreadyRunning: false };
          },
        },
      };
      on("list", () => {
        if (staleReads !== undefined && staleReads-- === 0)
          void pc.driver.startProcess(wtSocket, "toy");
      });
      const result = await runUp(lagging);
      expect(result.restarted).toEqual(["toy"]);
      expect(pc.rows(wtSocket).find((r) => r.name === "toy")).toMatchObject({ status: "Running" });
    });

    it("a restarted service that dies again (new pid) fails fast with HEALTH_TIMEOUT naming it", async () => {
      const { deps, ours, pc, wtSocket, on } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"], waitTimeoutMs: 60_000 },
      );
      pc.exit(wtSocket, "toy", -1);
      // The new run exits 1 at once.
      on("start", () => queueMicrotask(() => pc.exit(wtSocket, "toy", 1)));
      const started = Date.now();
      const err = await failure(deps);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(err?.code).toBe("HEALTH_TIMEOUT");
      expect(err?.message).toContain("toy (Completed, exit 1)");
      expect(err?.message).toContain("restarted toy, and it died again");
      expect(err?.message).toContain("devtrees down && devtrees up -n test");
      expect(err?.details).toMatchObject({
        dead_services: [{ name: "toy", status: "Completed", exit_code: 1 }],
      });
      expect(ours("start")).toHaveLength(1);
    });

    it("a restarted service that dies again after being read running fails fast too", async () => {
      // toy is probed: read running but not ready yet once after the restart,
      // then it is killed.
      const probedToy: ResolvedStack = {
        services: toyStack.services.map((s) =>
          s.name === "toy" ? { ...s, readinessProbe: { exec: { command: "x" } } } : s,
        ),
      };
      const { deps, pc, wtSocket, on } = await liveInstance(
        probedToy,
        { namespaces: ["test"] },
        { namespaces: ["test"], waitTimeoutMs: 60_000 },
      );
      pc.exit(wtSocket, "toy", -1);
      let readsSinceStart: number | undefined;
      on("start", () => {
        readsSinceStart = 0;
        queueMicrotask(() => pc.setReady(wtSocket, "toy", false));
      });
      on("list", () => {
        if (readsSinceStart !== undefined && ++readsSinceStart === 2) pc.exit(wtSocket, "toy", -1);
      });
      const started = Date.now();
      const err = await failure(deps);
      expect(readsSinceStart).toBeGreaterThanOrEqual(2);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(err?.code).toBe("HEALTH_TIMEOUT");
      expect(err?.message).toContain("died again");
    });

    it("a restarted service process-compose never runs (its old row stays) is reported dead at the deadline, not before", async () => {
      // process-compose accepts the start, but the row keeps the old run's
      // pid: never read alive, never a new death, so dead only at the deadline.
      const { deps, pc, wtSocket } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"], waitTimeoutMs: 600 },
      );
      pc.exit(wtSocket, "toy", -1);
      const started = Date.now();
      const err = await failure({
        ...deps,
        processCompose: {
          ...pc.driver,
          startProcess: async () => ({ ok: true, alreadyRunning: false }),
        },
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
      const { deps, ours, pc, wtSocket, on } = await liveInstance(
        stack,
        {},
        { waitTimeoutMs: 400 },
      );
      pc.exit(wtSocket, "toy", -1);
      // The new run fails its readiness probe.
      on("start", () => queueMicrotask(() => pc.setReady(wtSocket, "toy", false)));
      const err = await failure(deps);
      expect(err?.code).toBe("HEALTH_TIMEOUT");
      expect(err?.message).toContain("healthy [toy] after 400ms");
      expect(ours("start")).toHaveLength(1);
    });

    it("a failing one-shot (non-zero exit) is restarted; an exit-0 one-shot is not", async () => {
      const stack: ResolvedStack = {
        services: [isolated("seed", "x"), isolated("migrate", "true"), isolated("web", "y")],
      };
      const { deps, ours, pc, wtSocket, on } = await liveInstance(stack);
      pc.exit(wtSocket, "seed", 3);
      pc.exit(wtSocket, "migrate", 0);
      // The restarted seed runs to completion this time.
      on("start", () => queueMicrotask(() => pc.exit(wtSocket, "seed", 0)));
      const result = await runUp(deps);
      expect(ours("start").map((r) => r.services)).toEqual([["seed"]]);
      expect(result.restarted).toEqual(["seed"]);
    });

    it("a service process-compose is already Restarting is left to its restart policy", async () => {
      const { deps, ours, pc, wtSocket } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"], waitForHealth: async () => {} },
      );
      pc.backoff(wtSocket, "toy");
      const result = await runUp(deps);
      expect(ours("start")).toEqual([]);
      expect(result.restarted).toEqual([]);
    });

    it("a refused start fails with SERVICE_START_FAILED naming the service and the down + up remedy", async () => {
      const { deps, ours, pc, wtSocket, id } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"] },
      );
      pc.exit(wtSocket, "toy", -1);
      pc.refuse("start", "toy", 'FTL failed to start process toy error="no such process"');
      const err = await failure(deps);
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
      expect(ours(...lifecycle, "stop")).toEqual([]);
    });

    it("process-compose refusing because the service is already running is not a failure", async () => {
      const { deps, ours, pc, wtSocket, on, byOthers } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"] },
      );
      pc.exit(wtSocket, "toy", -1);
      // Someone else starts toy just before up's start reaches process-compose.
      let beaten = false;
      on("start", () => {
        if (beaten) return;
        beaten = true;
        byOthers(() => void pc.driver.startProcess(wtSocket, "toy"));
      });
      const result = await runUp(deps);
      // Someone else started it: not reported as restarted by this `up`.
      expect(result.restarted).toEqual([]);
      expect(ours("start")).toHaveLength(1);
      expect(pc.rows(wtSocket).find((r) => r.name === "toy")).toMatchObject({ status: "Running" });
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
      const { deps, ours, pc, wtSocket } = await liveInstance(stack);
      for (const name of ["web", "api", "db"]) pc.exit(wtSocket, name, -1);
      const result = await runUp(deps);
      expect(ours("start").map((r) => r.services)).toEqual([["db"], ["api"], ["web"]]);
      expect(result.restarted).toEqual(["db", "api", "web"]);
      expect(pc.rows(wtSocket).every((r) => r.status === "Running")).toBe(true);
    });

    it("a `down` holding the lifecycle lock: up starts nothing and fails LOCK_CONTENTION", async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      let down: Promise<void> | undefined;
      let locks = 0;
      const { deps, ours, pc, wtSocket } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        {
          namespaces: ["test"],
          // Up's own spawn-window lock passes. Right after it is released, a
          // `down` takes the lifecycle lock, before up's restart: the
          // restart's lock is held and only retried briefly.
          withLifecycleLock: async (a, i, fn) => {
            if (++locks === 2 && down === undefined) {
              let acquired: () => void = () => {};
              const isHeld = new Promise<void>((r) => (acquired = r));
              down = withLifecycleLock(a, i, async () => {
                acquired();
                await held;
              });
              await isHeld;
            }
            return withLifecycleLock(a, i, fn, { retries: 3, retryDelayMs: 10 });
          },
        },
      );
      pc.exit(wtSocket, "toy", -1);
      const err = await failure(deps);
      release();
      await down;
      expect(locks).toBe(2);
      expect(err?.code).toBe("LOCK_CONTENTION");
      expect(ours("start")).toEqual([]);
    });

    it("an instance that stopped between the read and the lock: nothing started, INSTANCE_NOT_FOUND", async () => {
      let locks = 0;
      let crash: (() => void) | undefined;
      const { deps, ours, pc, wtSocket, id } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        {
          namespaces: ["test"],
          // Live for up's own spawn-window gate; the instance dies before the
          // restart's lock is taken, so its re-probe finds the socket stale.
          withLifecycleLock: async (a, i, fn) => {
            if (++locks === 2) crash?.();
            return withLifecycleLock(a, i, fn);
          },
        },
      );
      crash = () => pc.crash(wtSocket);
      locks = 0;
      pc.exit(wtSocket, "toy", -1);
      const err = await failure(deps);
      expect(err?.code).toBe("INSTANCE_NOT_FOUND");
      expect(err?.message).toContain("Nothing was started");
      expect(err?.details).toEqual({ worktree_id: id });
      expect(ours("start")).toEqual([]);
    });

    it("re-reads under the lock: a service no longer dead there is not started", async () => {
      const { deps, ours, pc, wtSocket, on, byOthers } = await liveInstance(
        toyStack,
        { namespaces: ["test"] },
        { namespaces: ["test"] },
      );
      pc.exit(wtSocket, "toy", -1);
      // Someone else starts toy between up's first read and its re-read.
      let reads = 0;
      on("list", () => {
        if (++reads === 2) byOthers(() => void pc.driver.startProcess(wtSocket, "toy"));
      });
      const result = await runUp(deps);
      expect(ours("start")).toEqual([]);
      expect(result.restarted).toEqual([]);
    });
  });

  it("a completed exit-0 one-shot does not fail up", async () => {
    const stack: ResolvedStack = {
      services: [isolated("migrate", "true"), isolated("web", "node a.js")],
    };
    const { deps, pc, wtSocket } = await liveInstance(stack);
    pc.exit(wtSocket, "migrate", 0);
    await expect(runUp(deps)).resolves.toBeDefined();
  });

  it("a probed service that is still coming up is waited on with --wait-timeout", async () => {
    const stack: ResolvedStack = {
      services: [{ ...isolated("web", "node a.js"), readinessProbe: { exec: { command: "x" } } }],
    };
    const { deps, pc, wtSocket } = await liveInstance(stack, {}, { waitTimeoutMs: 300 });
    pc.setReady(wtSocket, "web", false);
    const err = await failure(deps);
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("after 300ms");
  });

  // These shared instances record no shared state (pre-#83): with no revision
  // to check drift against, a dead shared service is reported, not restarted
  // (#240). With state, `up` restarts it — see "restarting dead shared
  // services (#240)" below. `cache` keeps the shared process-compose running.
  it("a dead shared service in a stateless (pre-#83) shared instance fails SHARED_SERVICE_DEAD unknown_revision", async () => {
    const stack: ResolvedStack = {
      services: [
        shared("db", "postgres", ["DB_PORT"]),
        shared("cache", "redis-server"),
        isolated("web", "node a.js"),
      ],
    };
    const { deps, ours, pc, sharedSocket } = await liveInstance(stack);
    pc.exit(sharedSocket, "db", -1);
    const err = await failure(deps);
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.message).toContain("db (Completed, exit -1)");
    expect(err?.details).toEqual({
      dead_services: [{ name: "db", status: "Completed", exit_code: -1 }],
      reason: "unknown_revision",
      remedy: "devtrees down --shared && devtrees up",
    });
    // Reported, not restarted.
    expect(ours(...lifecycle, "start", "stop")).toEqual([]);
  });

  it("a FRESH up against a stateless running shared instance with a dead service fails SHARED_SERVICE_DEAD before spawning", async () => {
    // Same check, other path: after `down`, a fresh `up` used to start the
    // worktree over the dead shared service and report `is up`.
    const stack: ResolvedStack = {
      services: [
        shared("db", "postgres", ["DB_PORT"]),
        shared("cache", "redis-server"),
        { ...isolated("web", "node a.js"), namespace: "test" },
      ],
    };
    const { deps, ours, pc, sharedSocket, wtSocket } = await liveInstance(
      stack,
      { worktree: false },
      { namespaces: ["test"] },
    );
    pc.exit(sharedSocket, "db", -1);
    const err = await failure(deps);
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.details).toMatchObject({ remedy: "devtrees down --shared && devtrees up" });
    // Nothing started: neither the worktree instance nor a shared restart.
    expect(ours(...lifecycle, "start", "stop")).toEqual([]);
    expect(pc.isUp(wtSocket)).toBe(false);
  });

  it("a selection read that keeps failing is HEALTH_TIMEOUT, never a success over an unknown selection", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const { deps, pc, wtSocket } = await liveInstance(stack, {}, { waitTimeoutMs: 300 });
    // process-compose stops answering.
    pc.freeze(wtSocket);
    await expect(runUp(deps)).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
  });

  it("#192: a status read that keeps failing prints one retry notice through warn", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const warnings: string[] = [];
    const { deps, pc, wtSocket } = await liveInstance(
      stack,
      {},
      { waitTimeoutMs: 300, warn: (m) => warnings.push(m) },
    );
    pc.freeze(wtSocket);
    await expect(runUp(deps)).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
    const notices = warnings.filter((w) => /service status failed/.test(w));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("did not answer within");
  });

  it("#192: a status read that hangs is cut off at the wait budget, not waited on forever", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const warnings: string[] = [];
    const { deps, pc, wtSocket } = await liveInstance(
      stack,
      {},
      { waitTimeoutMs: 150, warn: (m) => warnings.push(m) },
    );
    pc.freeze(wtSocket);
    const started = Date.now();
    await expect(runUp(deps)).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1500);
    // The read was bounded by the 150ms wait budget, not the 5s default.
    const notice = warnings.find((w) => /service status failed/.test(w));
    expect(notice).toContain("did not answer within 0s");
  });

  it("a healthy re-up reads the instance once: the selection read is the health poll and the envelope", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js", ["WEB_PORT"])] };
    const { deps, ours, wtSocket } = await liveInstance(stack);
    const result = await runUp(deps);
    expect(ours("list").filter((r) => r.socketPath === wtSocket)).toHaveLength(1);
    expect(result.services).toEqual([
      { name: "web", status: "Running", health: "unknown", ports: { WEB_PORT: result.blockBase } },
    ]);
  });

  it("a live shared tier does not fail up", async () => {
    const stack: ResolvedStack = {
      services: [shared("db", "postgres", ["DB_PORT"]), isolated("web", "node a.js")],
    };
    const { deps } = await liveInstance(stack);
    await expect(runUp(deps)).resolves.toBeDefined();
  });

  it("never attaches on the running path, even when a TTY is present", async () => {
    const stack: ResolvedStack = { services: [isolated("web", "node a.js")] };
    const { deps, ours } = await liveInstance(stack, {}, { attach: true });
    await runUp(deps);
    expect(ours("attach")).toEqual([]);
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
    // Pin the worktree root so both pcDeps calls derive the same id.
    const loginId = idFor("/wt", "login");
    const probeDeps = pcDeps({ stack, worktreeRootOverride: "/wt" });
    const probeResult = await runUp(probeDeps);
    const blockBase = probeResult.blockBase;
    // Reset for a fresh first-up against a clean anchor (separate pcDeps()
    // call gives us a fresh tmp anchor with no instance running).
    heldPorts.add(blockBase); // WEB_PORT (offset 0)

    const base = pcDeps({
      stack,
      worktreeRootOverride: "/wt",
      initialRegistry: { [loginId]: blockBase },
    });
    const deps: CommandDeps = { ...base, portHolder, portAccepts: async () => true };

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
    // Aborted before the start.
    expect(requestsOf(base.pc, "up")).toEqual([]);
  });

  it("collects every collision (not just the first) so the agent can kill all orphans in one pass", async () => {
    const portHolder = async (port: number) => ({
      free: false as const,
      pid: port, // pid = port for easy assertion
      command: `proc@${port}`,
    });
    const deps: CommandDeps = { ...pcDeps({ stack }), portHolder, portAccepts: async () => true };
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
    const deps: CommandDeps = { ...pcDeps({ stack }), portHolder, portAccepts: async () => true };
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
    // The first up starts the instance, so a second up takes the idempotent
    // branch. If the pre-flight ran on that branch it would trip on our own
    // listener and break re-runs.
    let holderCalls = 0;
    const portHolder = async () => {
      holderCalls++;
      return { free: false as const, pid: 999, command: "node should-not-trip" };
    };
    // First up uses a non-tripping holder to get us into the running state.
    const base = pcDeps({ stack });
    const deps: CommandDeps = {
      ...base,
      portHolder: async () => ({ free: true as const }),
    };
    await runUp(deps);
    // Second up: instance running → idempotent path. Swap in the tripping
    // holder; if the check ran, this call would reject.
    const drifted: CommandDeps = { ...deps, portHolder };
    const result = await runUp(drifted);
    expect(result.worktreeId).toBe(base.expectedWorktreeId);
    expect(holderCalls).toBe(0);
    expect(upsOn(base.pc, base.inst.socketPath)).toHaveLength(1);
  });

  it("clean start (no holder reports a collision) does not throw — the happy path is unchanged", async () => {
    const base = pcDeps({ stack });
    const deps: CommandDeps = {
      ...base,
      portHolder: async () => ({ free: true as const }),
    };
    const result = await runUp(deps);
    expect(result.worktreeId).toBe(base.expectedWorktreeId);
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(20000);
    expect(base.pc.isUp(base.inst.socketPath)).toBe(true);
  });

  it("only probes declared named ports — not the full 32-port allocation block (PRD §port block)", async () => {
    const probed: number[] = [];
    const portHolder = async (port: number) => {
      probed.push(port);
      return { free: true as const };
    };
    const deps: CommandDeps = { ...pcDeps({ stack }), portHolder, portAccepts: async () => true };
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
   * An instance SIGKILLed the way a crash leaves it: its socket file stays,
   * nothing listens on it.
   */
  async function crashedInstance(deps: PcDeps, inst: InstanceRef): Promise<void> {
    mkdirSync(dirname(inst.socketPath), { recursive: true });
    writeFileSync(inst.configPath, stringifyYaml({ processes: { web: { command: "x" } } }));
    await deps.pc.driver.up(inst);
    deps.pc.crash(inst.socketPath);
  }

  it("starts a fresh instance when the socket file exists but nothing listens (post-SIGKILL)", async () => {
    const deps = pcDeps({ stack });
    await crashedInstance(deps, deps.inst);
    const { socketPath } = deps.inst;
    expect(existsSync(socketPath)).toBe(true);

    const result = await runUp(deps);

    // Not a silent no-op: a fresh instance was started on this worktree's socket.
    expect(upsOn(deps.pc, socketPath)).toHaveLength(2);
    expect(deps.pc.isUp(socketPath)).toBe(true);
    // Normal started envelope, exactly as a first up would return.
    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(20000);
  });

  it("unlinks the stale socket file when detected", async () => {
    // Whether the stale file was still there when the fresh start reached
    // process-compose: it must have been unlinked, not merely bound over.
    const seenAtStart: boolean[] = [];
    let socketPath = "";
    const pc = createInMemoryProcessCompose({
      onRequest: (r) => {
        if (r.op === "up" && r.socketPath === socketPath) seenAtStart.push(existsSync(socketPath));
      },
    });
    const deps = pcDeps({ stack, pc });
    await crashedInstance(deps, deps.inst);
    socketPath = deps.inst.socketPath;

    await runUp(deps);

    expect(seenAtStart).toEqual([false]);
  });

  it("a stale socket does not disable the STALE_PORT_BLOCK pre-flight (#58)", async () => {
    const base = pcDeps({ stack });
    await crashedInstance(base, base.inst);
    const deps: CommandDeps = {
      ...base,
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
    expect(base.pc.isUp(base.inst.socketPath)).toBe(false);
  });

  it("a live socket (probe says running) still takes the idempotent no-op path", async () => {
    const probed: string[] = [];
    const pc = createInMemoryProcessCompose();
    const deps = pcDeps({
      stack,
      pc,
      probeSocket: async (p) => {
        probed.push(p);
        return pc.probeSocket(p);
      },
    });
    await runUp(deps);
    const { socketPath } = deps.inst;
    const webPid = pc.pidOf(socketPath, "web");

    const result = await runUp(deps);

    // No fresh start, socket left in place, envelope still emitted.
    expect(upsOn(pc, socketPath)).toHaveLength(1);
    expect(pc.pidOf(socketPath, "web")).toBe(webPid);
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

  /** A running shared instance of `postgres`. */
  async function sharedInstance(deps: PcDeps): Promise<void> {
    mkdirSync(dirname(deps.sharedInst.socketPath), { recursive: true });
    writeFileSync(
      deps.sharedInst.configPath,
      stringifyYaml({ processes: { postgres: { command: "postgres" } } }),
    );
    await deps.pc.driver.up(deps.sharedInst);
  }

  it("restarts the shared instance when its socket file exists but nothing listens", async () => {
    const deps = pcDeps({ stack: mixedStack });
    await sharedInstance(deps);
    // SIGKILLed: the socket file stays behind, nothing listens.
    deps.pc.crash(deps.sharedInst.socketPath);
    expect(existsSync(deps.sharedInst.socketPath)).toBe(true);

    const result = await runUp(deps);

    // The lazy-start actually restarted shared — and reports having done so.
    expect(upsOn(deps.pc, deps.sharedInst.socketPath)).toHaveLength(2);
    expect(deps.pc.isUp(deps.sharedInst.socketPath)).toBe(true);
    expect(result.sharedStarted).toBe(true);
  });

  it("a live shared socket is left alone — lazy start stays idempotent", async () => {
    const deps = pcDeps({ stack: mixedStack });
    await sharedInstance(deps);
    const pid = deps.pc.pidOf(deps.sharedInst.socketPath, "postgres");

    const result = await runUp(deps);

    expect(upsOn(deps.pc, deps.sharedInst.socketPath)).toHaveLength(1);
    expect(deps.pc.pidOf(deps.sharedInst.socketPath, "postgres")).toBe(pid);
    expect(result.sharedStarted).toBe(false);
    expect(existsSync(deps.sharedInst.socketPath)).toBe(true);
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

  /** The shared instance on the in-memory process-compose, booted with `postgres`. */
  async function sharedRunning() {
    const tmp = tmpAnchor();
    const sharedPaths = sharedInstancePaths(tmp.anchor);
    mkdirSync(sharedPaths.runDir, { recursive: true });
    writeFileSync(
      sharedPaths.configPath,
      stringifyYaml({ processes: { postgres: { command: "postgres" } } }),
    );
    const { deps, pc } = onInMemoryPc(
      stubDeps({
        stack: mixedStack,
        anchorOverride: tmp.anchor,
        worktreeRootOverride: tmp.worktreeRoot,
      }),
    );
    await pc.driver.up(sharedPaths);
    return { deps, pc, sharedPaths };
  }

  it("cleans up the stale socket file and no-ops instead of signalling a dead instance", async () => {
    // A SIGKILLed shared instance: its socket file stays, nothing answers.
    const { deps, pc, sharedPaths } = await sharedRunning();
    pc.crash(sharedPaths.socketPath);
    const before = pc.requests.length;

    const result = await runDown(deps, { shared: true });

    // Idempotent no-op result, no `process-compose down` against the dead UDS.
    expect(result).toEqual({ shared: true, stopped: false, forceKilled: [] });
    expect(pc.requests.slice(before)).toEqual([]);
    // The orphaned socket file was unlinked, so the next up lazy-starts fresh.
    expect(existsSync(sharedPaths.socketPath)).toBe(false);
  });

  it("still signals a live shared instance through the driver", async () => {
    const { deps, pc, sharedPaths } = await sharedRunning();

    const result = await runDown(deps, { shared: true });

    expect(result).toEqual({ shared: true, stopped: true, forceKilled: [] });
    expect(requestsOf(pc, "down").map((r) => r.socketPath)).toEqual([sharedPaths.socketPath]);
    expect(pc.isUp(sharedPaths.socketPath)).toBe(false);
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
   * A worktree instance running `web` on the in-memory process-compose
   * (unchanged config, so a live verdict takes the quiet already-running
   * path), with every reap recorded. The liveness probe is `probeSocket`, so
   * a test can make it answer `unknown`.
   */
  async function staged(
    probeSocket: (socketPath: string) => Promise<InstanceStatus>,
    stack: ResolvedStack = isolatedStack,
  ) {
    const tmp = tmpAnchor();
    const onPc = onInMemoryPc(
      stubDeps({
        stack,
        anchorOverride: tmp.anchor,
        worktreeRootOverride: tmp.worktreeRoot,
      }),
    );
    const { pc } = onPc;
    const wt = instancePaths(tmp.anchor, onPc.deps.expectedWorktreeId);
    const wtSocket = wt.socketPath;
    const sharedSocket = sharedInstancePaths(tmp.anchor).socketPath;
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    writeFileSync(
      wt.configPath,
      stringifyYaml({ processes: { web: { command: "node server.js" } } }),
    );
    await pc.driver.up(wt);
    const booted = pc.requests.length;
    const reaped: string[] = [];
    const deps: CommandDeps = {
      ...onPc.deps,
      probeSocket,
      probeRetryDelaysMs: [0, 0, 0],
      readStoredHash: () => stackHash(stack),
      writeStoredHash: () => {},
      reap: async () => {
        reaped.push("reap");
        return { ranCount: 0, failures: [] };
      },
    };
    /** The `op` requests process-compose received since the instance was staged. */
    const sent = (op: PcRequest["op"]) => pc.requests.slice(booted).filter((r) => r.op === op);
    return { deps, pc, sent, reaped, wtSocket, sharedSocket, id: onPc.deps.expectedWorktreeId };
  }

  async function rejection(p: Promise<unknown>) {
    return p.then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
  }

  it("up: an unknown worktree socket fails INSTANCE_UNRESPONSIVE and starts no fresh instance", async () => {
    const fx = await staged(async () => "unknown");
    const err = await rejection(runUp(fx.deps));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.details).toMatchObject({ instance: fx.id, socket_path: fx.wtSocket });
    // No fresh start beside a possibly-live instance (it would collide on its ports).
    expect(requestsOf(fx.pc, "up")).toHaveLength(1);
    expect(fx.sent("up")).toEqual([]);
    expect(existsSync(fx.wtSocket)).toBe(true);
  });

  it("up --dry-run: an unknown worktree socket fails INSTANCE_UNRESPONSIVE instead of previewing a fresh start", async () => {
    const fx = await staged(async () => "unknown");
    const err = await rejection(runUpDryRun(fx.deps));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.details).toMatchObject({ instance: fx.id, socket_path: fx.wtSocket });
    expect(fx.sent("up")).toEqual([]);
    expect(existsSync(fx.wtSocket)).toBe(true);
  });

  it("down: an unknown socket fails INSTANCE_UNRESPONSIVE — never 'nothing running', never the dead-supervisor reap", async () => {
    const fx = await staged(async () => "unknown");
    const err = await rejection(runDown(fx.deps));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.message).toContain("socket was kept");
    expect(String(err?.details?.remedy)).toContain("devtrees down");
    expect(fx.sent("down")).toEqual([]);
    expect(fx.reaped).toEqual([]);
    expect(existsSync(fx.wtSocket)).toBe(true);
    expect(fx.pc.isUp(fx.wtSocket)).toBe(true);
  });

  it("down: a probe that answers on a retry stops the instance through the driver", async () => {
    let probes = 0;
    const fx = await staged(async () => (++probes === 1 ? "unknown" : "running"));
    const result = await runDown(fx.deps);
    expect(result.stopped).toBe(true);
    expect(fx.sent("down")).toHaveLength(1);
    expect(fx.pc.isUp(fx.wtSocket)).toBe(false);
  });

  it("down --shared: an unknown shared socket fails INSTANCE_UNRESPONSIVE and keeps the socket", async () => {
    const fx = await staged(async () => "unknown", mixedStack);
    writeFileSync(fx.sharedSocket, "");
    const err = await rejection(runDown(fx.deps, { shared: true }));
    expect(err?.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err?.details).toMatchObject({ instance: "shared" });
    expect(String(err?.details?.remedy)).toContain("devtrees down --shared");
    expect(fx.sent("down")).toEqual([]);
    expect(existsSync(fx.sharedSocket)).toBe(true);
  });

  it("the envelope classifies as INSTANCE_UNRESPONSIVE with its details", async () => {
    const fx = await staged(async () => "unknown");
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

  /** A common anchor/registry fixture, with one process-compose model shared by every worktree. */
  function pcFixture(prefix: string) {
    return { ...multiWorktreeFixture(prefix), pc: createInMemoryProcessCompose() };
  }

  /** deps for one worktree against a common anchor/registry fixture. */
  function worktreeDeps(
    fixture: ReturnType<typeof pcFixture>,
    stack: ResolvedStack,
    worktreeId: string,
  ): PcDeps {
    return pcDeps({
      stack,
      worktreeId,
      anchorOverride: fixture.sharedAnchor,
      worktreeRootOverride: fixture.wtRoot,
      registryRef: fixture.registryRef,
      pc: fixture.pc,
    });
  }

  it("persists the shared name→port map + subset hash in anchor state when shared starts", async () => {
    const fixture = pcFixture("dt-map-");
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
    const fixture = pcFixture("dt-reorder-");
    const a = await runUp(worktreeDeps(fixture, stackA, "login"));
    const b = await runUp(worktreeDeps(fixture, stackBReordered, "billing"));

    expect(b.sharedStarted).toBe(false);
    expect(b.env.DB_PORT).toBe(a.env.DB_PORT);
    expect(b.env.CACHE_PORT).toBe(a.env.CACHE_PORT);
  });

  it("does not flag drift when the shared subsets are identical (no false positives)", async () => {
    const fixture = pcFixture("dt-same-");
    const a = await runUp(worktreeDeps(fixture, stackA, "login"));
    // Structurally-equal but distinct stack object — same branch, fresh parse.
    const sameStack: ResolvedStack = JSON.parse(JSON.stringify(stackA)) as ResolvedStack;
    const b = await runUp(worktreeDeps(fixture, sameStack, "billing"));
    expect(b.env.DB_PORT).toBe(a.env.DB_PORT);
    expect(b.env.CACHE_PORT).toBe(a.env.CACHE_PORT);
  });

  it("fails with SHARED_DRIFT when a worktree's shared subset diverges from the running instance", async () => {
    const fixture = pcFixture("dt-drift-");
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
    const fixture = pcFixture("dt-drift-spawn-");
    await runUp(worktreeDeps(fixture, stackA, "login"));
    const before = fixture.pc.requests.length;

    const billing = worktreeDeps(fixture, stackBDivergent, "billing");
    await expect(runUp(billing)).rejects.toThrow();
    expect(fixture.pc.requests.slice(before).filter((r) => r.op === "up")).toEqual([]);
    expect(fixture.pc.isUp(billing.inst.socketPath)).toBe(false);
  });

  it("down --shared followed by up from the divergent worktree succeeds and re-persists the new map", async () => {
    const fixture = pcFixture("dt-repersist-");
    await runUp(worktreeDeps(fixture, stackA, "login"));

    const bDeps = worktreeDeps(fixture, stackBDivergent, "billing");
    await expect(runUp(bDeps)).rejects.toThrow(/down --shared/);

    // The in-memory `down` stops shared and removes its control socket.
    await runDown(bDeps, { shared: true });
    expect(fixture.pc.isUp(bDeps.sharedInst.socketPath)).toBe(false);

    const b = await runUp(bDeps);
    expect(b.sharedStarted).toBe(true);
    expect(fixture.pc.isUp(bDeps.sharedInst.socketPath)).toBe(true);

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
      const fixture = pcFixture("dt-shared-field-");
      const before = withShutdown("pg_ctl stop");
      const after = withShutdown("pg_ctl stop -m fast");
      expect(stackHash(after)).toBe(stackHash(before));

      await runUp(worktreeDeps(fixture, before, "login"));
      const since = fixture.pc.requests.length;
      const warnings: string[] = [];
      const result = await runUp({
        ...worktreeDeps(fixture, after, "login"),
        warn: (m) => warnings.push(m),
      });

      expect(result.sharedFieldChanges).toEqual([{ service: "postgres", field: "shutdown" }]);
      const line = warnings.find((w) => w.includes("shared service 'postgres'"));
      expect(line).toMatch(/'shutdown'/);
      expect(line).toMatch(/devtrees down --shared && devtrees up/);
      // No worktree hot-reload and no fresh start for the unchanged instance.
      const changes = fixture.pc.requests
        .slice(since)
        .filter((r) => r.op === "up" || r.op === "reload" || r.op === "start");
      expect(changes).toEqual([]);
    });

    it("an unchanged stack reports no shared field changes", async () => {
      const fixture = pcFixture("dt-shared-field-same-");
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
      const fixture = pcFixture("dt-shared-field-old-");
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
    const fixture = pcFixture("dt-legacy-");
    // Simulate a shared instance started by an older devtrees: shared runs,
    // but nothing records its ports — no shared-state.json, no shared port
    // map (#238), and no derived shared config to read the live env from.
    const login = worktreeDeps(fixture, stackA, "login");
    const a = await runUp(login);
    rmSync(join(fixture.sharedAnchor, "devtrees", "shared-state.json"));
    rmSync(sharedPortMapFile(fixture.sharedAnchor));
    rmSync(login.sharedInst.configPath);
    expect(fixture.pc.isUp(login.sharedInst.socketPath)).toBe(true);

    // A branch that reorders the shared services: positional offsets follow
    // its own order, so DB_PORT and CACHE_PORT trade places.
    const result = await runUp(worktreeDeps(fixture, stackBReordered, "billing"));
    expect(result.sharedStarted).toBe(false);
    expect(result.env.DB_PORT).toBe(a.env.CACHE_PORT);
    expect(result.env.CACHE_PORT).toBe(a.env.DB_PORT);
  });

  it("runEnv reads the persisted map so a reordered branch sees what shared actually bound", async () => {
    const fixture = pcFixture("dt-env-map-");
    const a = await runUp(worktreeDeps(fixture, stackA, "login"));

    const env = await runEnv(worktreeDeps(fixture, stackBReordered, "billing"));
    expect(env.env.DB_PORT).toBe(a.env.DB_PORT);
    expect(env.env.CACHE_PORT).toBe(a.env.CACHE_PORT);
  });

  it("runEnv fails with SHARED_DRIFT for a divergent worktree instead of reporting wrong ports", async () => {
    const fixture = pcFixture("dt-env-drift-");
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
    const fixture = pcFixture("dt-env-down-");
    const env = await runEnv(worktreeDeps(fixture, stackA, "login"));
    expect(Number(env.env.DB_PORT)).toBeGreaterThanOrEqual(20000);
    expect(Number(env.env.CACHE_PORT)).toBe(Number(env.env.DB_PORT) + 1);
    expect(fixture.pc.requests).toEqual([]);
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
    const deps = pcDeps({ stack: oneIsolatedService });

    await withRuntimeDir(`/tmp/${"d".repeat(120)}`, async () => {
      await expect(runUp(deps)).rejects.toThrow(/unix-socket limit/);
    });

    // Nothing was started: the failure is a pre-flight, not a dead instance.
    expect(deps.pc.requests).toEqual([]);
  });

  it("tags the failure with the SOCKET_PATH_TOO_LONG code and an actionable envelope", async () => {
    const deps = pcDeps({ stack: oneIsolatedService });

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
    const deps = pcDeps({ stack: oneIsolatedService });

    const result = await runUp(deps);

    expect(result.worktreeId).toBe(deps.expectedWorktreeId);
    expect(Buffer.byteLength(result.socketPath)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);
    expect(requestsOf(deps.pc, "up")).toHaveLength(1);
    expect(deps.pc.isUp(result.socketPath)).toBe(true);
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
    const pc = createInMemoryProcessCompose({
      onRequest: (r) => {
        if (r.op === "up") events.push("spawn");
      },
    });
    const base = pcDeps({ stack: oneIsolated, pc });

    const deps: CommandDeps = {
      ...base,
      withLifecycleLock: makeSpyLock(events),
      waitForSocketFile: async () => {
        events.push("socket-wait");
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
    const pc = createInMemoryProcessCompose();
    const base = pcDeps({
      stack: oneIsolated,
      pc,
      probeSocket: async (path) => {
        events.push("probe");
        return pc.probeSocket(path);
      },
    });
    // An already-live instance, started by an earlier `up`.
    await runUp(base);
    events.length = 0;
    const before = pc.requests.length;

    const currentHashStore: Record<string, string> = {};
    const deps: CommandDeps = {
      ...base,
      withLifecycleLock: makeSpyLock(events),
      readStoredHash: (_a, id) => currentHashStore[id],
      writeStoredHash: (_a, id, h) => {
        events.push("hash-write");
        currentHashStore[id] = h;
      },
    };

    await runUp(deps);

    const id = base.expectedWorktreeId;
    // Liveness probe inside the hold; reconcile (here: drift-path hash write,
    // since no hash was stored) also inside; no spawn anywhere.
    expect(events).toEqual([`acquire:${id}`, "probe", "hash-write", `release:${id}`]);
    expect(pc.requests.slice(before).filter((r) => r.op === "up")).toEqual([]);
  });

  it("two concurrent ups in the same worktree spawn exactly one instance; the loser reports already-up", async () => {
    const base = pcDeps({ stack: oneIsolated });
    const store: Record<string, string> = {};
    // No `withLifecycleLock` injection: the REAL per-worktree lockfile under
    // the temp anchor is the mechanism under test here.
    const deps: CommandDeps = {
      ...base,
      readStoredHash: (_a, id) => store[id],
      writeStoredHash: (_a, id, h) => {
        store[id] = h;
      },
    };

    const [a, b] = await Promise.all([runUp(deps), runUp(deps)]);

    expect(upsOn(base.pc, base.inst.socketPath)).toHaveLength(1);
    expect(base.pc.isUp(base.inst.socketPath)).toBe(true);
    // The loser reconciled against the winner's live instance: same envelope.
    expect(b.env).toEqual(a.env);
    expect(b.blockBase).toBe(a.blockBase);
    expect(a.worktreeId).toBe(b.worktreeId);
  });

  it("releases the lock when the spawn throws, so a follow-up up is not bricked", async () => {
    const base = pcDeps({ stack: oneIsolated });
    const deps: CommandDeps = {
      ...base,
      processCompose: {
        ...base.pc.driver,
        up: async () => {
          throw new Error("spawn failed");
        },
      },
    };

    await expect(runUp(deps)).rejects.toThrow("spawn failed");

    // The real default lifecycle lock was used; a leaked lockfile here would
    // brick every subsequent `up` in this worktree until hand-deleted.
    const lockPath = join(base.anchor, "devtrees", `${base.expectedWorktreeId}.lock`);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("surfaces LOCK_CONTENTION when the lock is held by a live process beyond the wait budget", async () => {
    const base = pcDeps({ stack: oneIsolated });
    // A live holder (our own pid — never stolen) already owns this worktree's lock.
    mkdirSync(join(base.anchor, "devtrees"), { recursive: true });
    writeFileSync(
      join(base.anchor, "devtrees", `${base.expectedWorktreeId}.lock`),
      `${process.pid}\n`,
      { flag: "wx" },
    );
    const deps: CommandDeps = {
      ...base,
      // Zero retries: exercise the budget-exhausted path without the default wait.
      withLifecycleLock: (anchor, id, fn) => withLifecycleLock(anchor, id, fn, { retries: 0 }),
    };

    await expect(runUp(deps)).rejects.toMatchObject({ code: "LOCK_CONTENTION" });
    expect(base.pc.requests).toEqual([]);
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

  /**
   * The in-memory process-compose (its first process runs as WEB_PID) whose
   * server stops answering once it is asked to `down`: a service ignores
   * SIGTERM, so the `down` does not finish within its budget and reports the
   * timeout. The rows read before it (the pre-stop snapshot) are the model's.
   */
  function stuckPc() {
    const downs: string[] = [];
    const pc: InMemoryProcessCompose = createInMemoryProcessCompose({
      firstPid: WEB_PID,
      onRequest: (r) => {
        if (r.op !== "down") return;
        downs.push(r.socketPath);
        pc.freeze(r.socketPath);
      },
    });
    return { pc, downs, pcDeps: inMemoryPcDeps(pc) };
  }

  /**
   * Stop seams over a fake process table: process-compose (PC_PID) bound to
   * `socketPath`, the stuck service (`servicePid`, default WEB_PID) its
   * child, plus `extra` children (alive until killed). `pcExits` decides
   * whether process-compose exits once the stuck service is killed;
   * `pcExitsOnKill` makes it exit once that pid is killed instead.
   */
  function stopSeams(
    socketPath: string,
    opts: {
      pcExits: boolean;
      pcExitsOnKill?: number;
      servicePid?: number;
      extra?: ReadonlyArray<{ pid: number; ppid: number; pgid: number; command: string }>;
    },
  ) {
    const servicePid = opts.servicePid ?? WEB_PID;
    const kills: Array<[number, string]> = [];
    const killed = new Set<number>();
    const pcGone = (): boolean =>
      (opts.pcExits && killed.has(servicePid)) ||
      (opts.pcExitsOnKill !== undefined && killed.has(opts.pcExitsOnKill));
    const seams: NonNullable<CommandDeps["stop"]> = {
      readProcessTable: async () => [
        {
          pid: PC_PID,
          ppid: 1,
          pgid: PC_PID,
          command: `process-compose up -f x.yaml -U -u ${socketPath} -t=false`,
        },
        { pid: servicePid, ppid: PC_PID, pgid: servicePid, command: "bash -c tail -f hold" },
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

  /** A worktree `up` on a stuck in-memory process-compose. */
  async function upStuck(stack: ResolvedStack) {
    const stuck = stuckPc();
    const base = stubDeps({ stack });
    const deps = { ...base, ...stuck.pcDeps };
    await runUp(deps);
    return { ...stuck, deps };
  }

  type Failure = Error & { code?: string; details?: Record<string, unknown> };

  const PENDING: PendingReload = { services: ["web"], oldRuns: [{ name: "web", pid: 99 }] };

  it("worktree down force-kills only the stuck service and reports it", async () => {
    const { deps, pc } = await upStuck(isolatedStack);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    expect(pc.pidOf(paths.socketPath, "web")).toBe(WEB_PID);
    const { seams, kills } = stopSeams(paths.socketPath, { pcExits: true });
    // A successful bounded stop clears any pending reload (#191).
    writePendingReload(anchorOf(deps), deps.expectedWorktreeId, PENDING);
    const result = await runDown({ ...deps, stop: seams });
    expect(result).toMatchObject({ shared: false, stopped: true });
    expect(result.forceKilled).toEqual([{ service: "web", pid: WEB_PID }]);
    // The service's process group, never process-compose itself.
    expect(kills).toEqual([[-WEB_PID, "SIGKILL"]]);
    expect(readPendingReload(anchorOf(deps), deps.expectedWorktreeId)).toBeUndefined();
  });

  it("worktree down force-kills a pending reload's unlisted old run before stopping, then clears the marker (#206)", async () => {
    const { deps } = await upStuck(isolatedStack);
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
    const result = await runDown({ ...deps, stop: seams });
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
    const { deps, downs } = await upStuck(isolatedStack);
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
    const reaps: unknown[] = [];
    const result = await runDown({
      ...deps,
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
    const { deps } = await upStuck(isolatedStack);
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
    const { deps, pc } = await upStuck(isolatedStack);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    const { seams, kills } = stopSeams(paths.socketPath, { pcExits: false });
    // A pending reload (#191) must survive a DOWN_TIMEOUT: the instance is still up.
    writePendingReload(anchorOf(deps), deps.expectedWorktreeId, PENDING);
    const err = (await runDown({ ...deps, stop: seams }).catch((e: unknown) => e)) as Failure;
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
    expect(pc.isUp(paths.socketPath)).toBe(true);
    expect(readPendingReload(anchorOf(deps), deps.expectedWorktreeId)).toEqual(PENDING);
  });

  it("the down budget is the base plus the derived config's shutdown.timeout_seconds", async () => {
    const { deps } = await upStuck(isolatedStack);
    const paths = instancePaths(anchorOf(deps), deps.expectedWorktreeId);
    writeFileSync(
      paths.configPath,
      stringifyYaml({ processes: { web: { command: "x", shutdown: { timeout_seconds: 1 } } } }),
    );
    const { seams } = stopSeams(paths.socketPath, { pcExits: false });
    const err = (await runDown({ ...deps, stop: seams }).catch((e: unknown) => e)) as Failure;
    expect(err.details?.timeout_ms).toBe(1020);
  });

  it("down --shared reports force-killed services", async () => {
    const { deps, pc } = await upStuck(mixedStack);
    const paths = sharedInstancePaths(anchorOf(deps));
    const postgresPid = pc.pidOf(paths.socketPath, "postgres");
    const { seams } = stopSeams(paths.socketPath, { pcExits: true, servicePid: postgresPid });
    const result = await runDown({ ...deps, stop: seams }, { shared: true });
    expect(result).toEqual({
      shared: true,
      stopped: true,
      forceKilled: [{ service: "postgres", pid: postgresPid }],
    });
    expect(existsSync(paths.configPath)).toBe(false);
  });

  it("down --shared fails DOWN_TIMEOUT and keeps the shared config", async () => {
    const { deps } = await upStuck(mixedStack);
    const paths = sharedInstancePaths(anchorOf(deps));
    const { seams } = stopSeams(paths.socketPath, { pcExits: false });
    const err = (await runDown({ ...deps, stop: seams }, { shared: true }).catch(
      (e: unknown) => e,
    )) as Failure;
    expect(err.code).toBe("DOWN_TIMEOUT");
    expect(err.details?.instance).toBe("shared");
    expect(String(err.details?.remedy)).toContain("`devtrees down --shared`");
    expect(existsSync(paths.configPath)).toBe(true);
    expect(existsSync(paths.socketPath)).toBe(true);
  });

  /**
   * Prune inputs with only `login` live, so `removed` is an orphan, running
   * `web` (as WEB_PID) on a stuck in-memory process-compose.
   */
  async function pruneInputs(tmp: { anchor: string; worktreeRoot: string }) {
    mkdirSync(runDir(tmp.anchor), { recursive: true });
    const orphan = instancePaths(tmp.anchor, "removed");
    writeFileSync(
      orphan.configPath,
      stringifyYaml({ processes: { web: { command: "tail -f hold" } } }),
    );
    const { pc, pcDeps } = stuckPc();
    await pc.driver.up(orphan);
    const inputs = {
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
          socketPath: orphan.socketPath,
          ports: {},
          blockBase: undefined,
          services: [],
        },
      ],
      ...pcDeps,
    };
    return { orphan, inputs };
  }

  it("prune reports a force-killed orphan stop on its pruned row", async () => {
    const tmp = tmpAnchor();
    const { orphan, inputs } = await pruneInputs(tmp);
    const { seams } = stopSeams(orphan.socketPath, { pcExits: true });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      ...inputs,
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
    const { orphan, inputs } = await pruneInputs(tmp);
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
      ...inputs,
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
    const { orphan, inputs } = await pruneInputs(tmp);
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
      ...inputs,
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
    const { orphan, inputs } = await pruneInputs(tmp);
    const registryRef = { snapshot: { removed: 20032 } as RegistrySnapshot };
    const { seams } = stopSeams(orphan.socketPath, { pcExits: false });
    const { runPrune } = await import("./commands.js");
    const result = await runPrune({
      ...inputs,
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

  /**
   * A live instance on the in-memory process-compose whose status reads
   * answer `rows`, parsed as `process list -o json` prints them. Only for
   * the statuses the adapter does not model (a daemon's `Launched`,
   * `Error`); everything else uses `pcInstance`.
   */
  async function liveInstance(
    rows: ReadonlyArray<{ name: string; status: string; exit_code?: number }>,
    declared: ResolvedStack = stack,
  ) {
    const { deps, pc } = onInMemoryPc(stubDeps({ stack: declared }));
    const up = await runUp(deps);
    const listed = rows.map((r) => ({ ...r, is_ready: "-", is_running: false }));
    const driver = {
      ...pc.driver,
      getServiceStatuses: async () => parseServiceStatuses(JSON.stringify(listed)),
    };
    const reaped: string[][] = [];
    const reap: CommandDeps["reap"] = async (config) => {
      reaped.push(Object.keys(config.processes));
      return { ranCount: Object.keys(config.processes).length, failures: [] };
    };
    const port = (name: string): number => Number(up.env[name]);
    return { deps: { ...deps, processCompose: driver, reap }, reaped, port };
  }

  /**
   * A live instance of `declared` on the in-memory process-compose, booted
   * with `namespaces` (default: all), every reap recorded. Tests make things
   * happen to its processes (`pc.exit`) before the `down`.
   */
  async function pcInstance(declared: ResolvedStack = stack, namespaces?: string[]) {
    const onPc = onInMemoryPc(stubDeps({ stack: declared }));
    const { pc } = onPc;
    const base = namespaces === undefined ? onPc.deps : { ...onPc.deps, namespaces };
    const up = await runUp(base);
    const socket = socketsOf(onPc.deps).worktree;
    const reaped: string[][] = [];
    const reap: CommandDeps["reap"] = async (config) => {
      reaped.push(Object.keys(config.processes));
      return { ranCount: Object.keys(config.processes).length, failures: [] };
    };
    const port = (name: string): number => Number(up.env[name]);
    return { deps: { ...base, reap }, pc, socket, reaped, port };
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
    const { deps, pc, socket, reaped } = await pcInstance();
    pc.exit(socket, "db", 0);
    pc.exit(socket, "cache", 0);
    await runDown(deps);
    expect(reaped).toEqual([]);
    expect(pc.isUp(socket)).toBe(false);
  });

  it("never runs a hook for a failed service that is not a daemon", async () => {
    // `web` has a hook and failed: only the is_daemon filter keeps it out.
    const { deps, pc, socket, reaped } = await pcInstance(hooked);
    pc.exit(socket, "web", 1);
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
    const { deps, pc, socket, port } = await pcInstance();
    pc.exit(socket, "db", 0);
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
    const { deps, pc, socket, port } = await pcInstance();
    pc.exit(socket, "db", 1);
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
    expect(pc.isUp(socket)).toBe(false);
    const dead = seams;
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
    const { deps, port } = await pcInstance();
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
    // db and cache are in a namespace this up does not select: never booted.
    const { deps, pc, socket, port } = await pcInstance(
      {
        services: stack.services.map((svc) =>
          svc.name === "web" ? svc : { ...svc, namespace: "data" },
        ),
      },
      ["default"],
    );
    expect(pc.rows(socket).map((r) => r.name)).toEqual(["web"]);
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
    const base = pcDeps({ stack, warn: (m) => warnings.push(m) });
    const deps: CommandDeps = {
      ...base,
      portHolder: async () => ({ free: false as const, pid: 77, command: "OrbStack Helper" }),
      portAccepts: async () => false,
    };
    await runUp(deps);
    expect(base.pc.isUp(base.inst.socketPath)).toBe(true);
    const warning = warnings.find((w) => w.includes("refuses connections"));
    expect(warning).toBeDefined();
    expect(warning).toContain("pid 77 (OrbStack Helper)");
    expect(warning).toContain("do not kill it");
  });

  it("fails when one holder accepts, labelling the refusing one and a port forwarder not to kill", async () => {
    const holders: Record<string, { pid: number; command: string }> = {};
    const base = pcDeps({ stack });
    const deps: CommandDeps = {
      ...base,
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
    // Neither failed up started process-compose.
    expect(requestsOf(base.pc, "up")).toEqual([]);
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

  /**
   * A common anchor/registry fixture with one in-memory process-compose for
   * every worktree. `on` registers a hook told about each request as it
   * arrives (before it is answered).
   */
  function nsFixture(prefix: string) {
    const hooks: Array<(r: PcRequest) => void> = [];
    const pc = createInMemoryProcessCompose({ onRequest: (r) => hooks.forEach((h) => h(r)) });
    return {
      ...multiWorktreeFixture(prefix),
      pc,
      on: (hook: (r: PcRequest) => void) => hooks.push(hook),
    };
  }
  type Fixture = ReturnType<typeof nsFixture>;

  /**
   * Deps for one worktree against a shared fixture, on its in-memory
   * process-compose. `reloads` and `ups` list the requests of that kind
   * process-compose received since these deps were made. A `reloadFailure`
   * answers every config reload with it, applying nothing.
   */
  function wt(
    fixture: Fixture,
    stack: ResolvedStack,
    worktreeId: string,
    opts: {
      reloadFailure?: Extract<ReloadResult, { ok: false }>;
      namespaces?: string[];
    } = {},
  ) {
    const deps = pcDeps({
      stack,
      worktreeId,
      anchorOverride: fixture.sharedAnchor,
      worktreeRootOverride: fixture.wtRoot,
      registryRef: fixture.registryRef,
      pc: fixture.pc,
    });
    const since = fixture.pc.requests.length;
    const sinceThen = (op: PcRequest["op"]) =>
      fixture.pc.requests.slice(since).filter((r) => r.op === op);
    const withDriver: CommandDeps = {
      ...deps,
      ...(opts.namespaces !== undefined ? { namespaces: opts.namespaces } : {}),
      ...(opts.reloadFailure !== undefined
        ? { processCompose: reloadFailing(fixture.pc, opts.reloadFailure) }
        : {}),
    };
    return {
      deps: withDriver,
      get reloads() {
        return sinceThen("reload");
      },
      get ups() {
        return sinceThen("up");
      },
      sharedSock: deps.sharedInst.socketPath,
    };
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
    const fixture = nsFixture("dt-nss-unselected-");
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
    const fixture = nsFixture("dt-nss-fresh-");
    const result = await runUp(
      wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps,
    );
    expect(result.sharedStarted).toBe(true);
    expect(result.sharedActivated).toEqual([]);
    expect(Object.keys(sharedConfigOf(fixture))).toEqual(["postgres", "db-shared"]);
  });

  it("with only namespaced shared services and none selected, the shared instance is not started", async () => {
    const fixture = nsFixture("dt-nss-none-");
    const onlyNamespaced: ResolvedStack = {
      services: base.services.filter((s) => s.name !== "postgres"),
    };
    const login = wt(fixture, onlyNamespaced, "login", { namespaces: ["app", "db"] });
    const result = await runUp(login.deps);
    expect(result.sharedStarted).toBe(false);
    expect(login.ups.filter((r) => r.socketPath === login.sharedSock)).toEqual([]);
    expect(fixture.pc.isUp(login.sharedSock)).toBe(false);
  });

  it("a later up selecting it adds it to the running shared instance, leaving the others as they were", async () => {
    const fixture = nsFixture("dt-nss-activate-");
    const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
    const postgresBefore = sharedConfigOf(fixture).postgres;
    const sharedSock = sharedInstancePaths(fixture.sharedAnchor).socketPath;
    const postgresPid = fixture.pc.pidOf(sharedSock, "postgres");

    const second = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
    const result = await runUp(second.deps);

    expect(result.sharedStarted).toBe(false);
    expect(result.sharedActivated).toEqual(["db-shared"]);
    // One reload, sent to the shared instance: process-compose re-reads its config.
    expect(second.reloads).toHaveLength(1);
    expect(second.reloads[0]).toMatchObject({ socketPath: second.sharedSock });
    // No second shared start, and postgres's process is byte-for-byte unchanged,
    // so the reload leaves it running.
    expect(second.ups.filter((r) => r.socketPath === second.sharedSock)).toEqual([]);
    expect(fixture.pc.rows(second.sharedSock).map((r) => [r.name, r.status])).toEqual([
      ["postgres", "Running"],
      ["db-shared", "Running"],
    ]);
    expect(fixture.pc.pidOf(sharedSock, "postgres")).toBe(postgresPid);
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
    const fixture = nsFixture("dt-nss-noop-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);
    const second = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
    const result = await runUp(second.deps);
    expect(result.sharedActivated).toEqual([]);
    expect(second.reloads).toEqual([]);
  });

  it("drift in a namespaced shared service does not block an up that does not select it", async () => {
    const fixture = nsFixture("dt-nss-drift-scoped-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);

    const result = await runUp(wt(fixture, drifted, "billing", { namespaces: ["app", "db"] }).deps);
    expect(result.sharedStarted).toBe(false);

    const env = await runEnv(wt(fixture, drifted, "billing").deps);
    expect(env.env.SB_PORT).toBe(String(readSharedState(fixture.sharedAnchor)?.ports.SB_PORT));
  });

  it("drift in a namespaced shared service fails an up that selects it, naming only that service", async () => {
    const fixture = nsFixture("dt-nss-drift-selected-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);

    const billing = wt(fixture, drifted, "billing", { namespaces: ["app", "db-shared"] });
    const err = await failure(runUp(billing.deps));
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
    // A namespaced drifted service gets the namespaced teardown (#239).
    expect(err?.details?.remedy).toBe(
      "devtrees down --shared -n db-shared --force && devtrees up -n app -n db-shared",
    );
    expect(err?.message).toContain("interrupts the worktrees that use these");
    expect(err?.message).toContain("devtrees down --shared && devtrees up");
    // Nothing was started for the divergent worktree.
    expect(billing.ups).toEqual([]);
  });

  it("a bare up on a running instance re-selects the namespaced shared services of the namespaces it booted", async () => {
    const fixture = nsFixture("dt-nss-bare-");
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
    const err = await failure(runUp(bare.deps));
    expect(err?.code).toBe("SHARED_DRIFT");

    // A worktree booted without `app` is not affected by the same edit.
    await runUp(wt(fixture, appShared("supabase start"), "orders").deps);
    const other = wt(fixture, appShared("supabase start --debug"), "orders");
    const ok = await runUp(other.deps);
    expect(ok.sharedActivated).toEqual([]);
  });

  it("a selected shared service's shared dependency is selected with it", async () => {
    const fixture = nsFixture("dt-nss-closure-");
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
    const fixture = nsFixture("dt-nss-refused-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
    const configPath = sharedInstancePaths(fixture.sharedAnchor).configPath;
    const before = readFileSync(configPath, "utf8");

    const err = await failure(
      runUp(
        wt(fixture, base, "billing", {
          namespaces: ["app", "db-shared"],
          reloadFailure: { ok: false, reason: "error", message: "HTTP 500" },
        }).deps,
      ),
    );
    expect(err?.code).toBe("SHARED_ACTIVATION_FAILED");
    expect(err?.details).toMatchObject({ services: ["db-shared"], reason: "error" });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(readSharedState(fixture.sharedAnchor)?.services?.["db-shared"]).toBeUndefined();
    expect(classifyError(err as Error).code).toBe("SHARED_ACTIVATION_FAILED");
  });

  it("a not-yet-running service whose port a running shared service owns is SHARED_DRIFT", async () => {
    const fixture = nsFixture("dt-nss-port-");
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
    const fixture = nsFixture("dt-nss-always-on-");
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
      const fixture = nsFixture("dt-nss-legacy-");
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
      const fixture = nsFixture("dt-nss-legacy-drift-");
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
    const fixture = nsFixture("dt-nss-dry-");
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

  it("a timed-out add is recorded and fails SHARED_ACTIVATION_FAILED; the retried up re-sends the reload", async () => {
    const fixture = nsFixture("dt-nss-timeout-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);

    // process-compose never answers the reload within its budget.
    const hanging = wt(fixture, base, "billing", {
      namespaces: ["app", "db-shared"],
      reloadFailure: {
        ok: false,
        reason: "timeout",
        message:
          "process-compose config reload did not finish within 0s; a changed service's old process has not stopped",
      },
    });
    const err = await failure(runUp(hanging.deps));
    expect(err?.code).toBe("SHARED_ACTIVATION_FAILED");
    expect(err?.details).toMatchObject({
      services: ["db-shared"],
      reason: "timeout",
      remedy: "retry `devtrees up`",
    });
    // Kept and recorded: process-compose may still apply it.
    expect(Object.keys(sharedConfigOf(fixture))).toEqual(["postgres", "db-shared"]);
    expect(readSharedState(fixture.sharedAnchor)?.services?.["db-shared"]).toBeDefined();

    // The reload never landed: the instance still runs postgres alone. The
    // retry must not trust the record — it re-sends the reload.
    expect(fixture.pc.rows(hanging.sharedSock).map((r) => r.name)).toEqual(["postgres"]);
    const retry = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
    const result = await runUp(retry.deps);
    expect(result.sharedActivated).toEqual(["db-shared"]);
    expect(retry.reloads).toHaveLength(1);
    expect(fixture.pc.rows(retry.sharedSock).map((r) => r.name)).toEqual(["postgres", "db-shared"]);
    expect(Object.keys(sharedConfigOf(fixture))).toEqual(["postgres", "db-shared"]);
  });

  it("a recorded service the instance runs is not re-added", async () => {
    const fixture = nsFixture("dt-nss-present-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);
    const again = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
    const result = await runUp(again.deps);
    expect(result.sharedActivated).toEqual([]);
    expect(again.reloads).toEqual([]);
  });

  /**
   * #238 (ADR-0011): shared ports are stable by name. The shared port map is
   * recorded under the shared lock the first time an `up` sees a name, and
   * every later `up` and `env`, on any branch, reuses it.
   */
  it("the namespaced remedy names the namespace the RUNNING definition is in, not this branch's (#244 follow-up)", async () => {
    const fixture = nsFixture("dt-nss-drift-running-ns-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);
    // This branch moved db-shared to namespace `db2` (and changed it): the
    // running instance still runs it in `db-shared`, which is what the
    // teardown selects its targets by.
    const moved: ResolvedStack = {
      services: drifted.services.map((s) => (s.name === "db-shared" ? inNs(s, "db2") : s)),
    };
    const err = await failure(
      runUp(wt(fixture, moved, "billing", { namespaces: ["app", "db2"] }).deps),
    );
    expect(err?.code).toBe("SHARED_DRIFT");
    expect(err?.details?.remedy).toBe(
      "devtrees down --shared -n db-shared --force && devtrees up -n app -n db2",
    );
  });

  describe("shared-step markers (#244 follow-up)", () => {
    /** Run `fn` with `deps`, observing the in-flight worktrees right after each shared step. */
    function observingSharedStep(deps: CommandDeps) {
      const seen: InFlightWorktree[][] = [];
      return {
        seen,
        deps: {
          ...deps,
          withSharedLock: async <T>(anchor: string, fn: () => Promise<T>): Promise<T> => {
            const result = await fn();
            seen.push(inFlightWorktrees(anchor));
            return result;
          },
        } as CommandDeps,
      };
    }

    it("an up's shared step names the shared services it selected and the shared ports it injects", async () => {
      const fixture = nsFixture("dt-marker-up-");
      const id = idFor(fixture.wtRoot, "login");
      const { deps, seen } = observingSharedStep(
        wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps,
      );
      await runUp(deps);
      expect(seen[0]).toEqual([
        {
          id,
          marker: expect.objectContaining({
            services: ["postgres", "db-shared"],
            ports: ["DB_PORT", "SB_PORT"],
          }),
        },
      ]);
      // Cleared with the worktree lifecycle lock.
      expect(existsSync(sharedStepMarkerFile(fixture.sharedAnchor, id))).toBe(false);
      expect(inFlightWorktrees(fixture.sharedAnchor)).toEqual([]);
    });

    it("names a shared service a booted isolated one depends on, though no selected namespace pulls it in", async () => {
      // `api` (ns app) depends on shared `sa` (ns a); `-n app` does not select
      // `sa` (ADR-0010), yet `api` starts against it. `worker` (ns w) depends
      // on `sw` and is not booted by a fresh `-n app`.
      const sa = inNs(shared("sa", "sa-server", ["SA_PORT"]), "a");
      const sw = inNs(shared("sw", "sw-server", ["SW_PORT"]), "w");
      const api = { ...inNs(isolated("api", "node api.js", ["API_PORT"]), "app") };
      const worker = { ...inNs(isolated("worker", "node w.js", ["W_PORT"]), "w") };
      const edged: ResolvedStack = {
        services: [
          shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]),
          sa,
          sw,
          { ...api, dependsOn: [{ name: "sa" }, { name: "postgres" }] },
          { ...worker, dependsOn: [{ name: "sw" }] },
        ],
      };
      const fixture = nsFixture("dt-marker-edge-");
      const fresh = observingSharedStep(wt(fixture, edged, "login", { namespaces: ["app"] }).deps);
      await runUp(fresh.deps);
      expect(fresh.seen[0]?.[0]?.marker?.services).toEqual(["postgres", "sa"]);
      // The running path: a hot-reload may start any isolated service, so
      // every cross-tier edge of the stack counts.
      const running = observingSharedStep(
        wt(fixture, edged, "login", { namespaces: ["app"] }).deps,
      );
      await runUp(running.deps);
      expect(running.seen[0]?.[0]?.marker?.services).toEqual(["postgres", "sa", "sw"]);
    });

    it("an up of a stack with no shared tier, and a worktree down, name no shared service", async () => {
      const fixture = nsFixture("dt-marker-noshared-");
      const id = idFor(fixture.wtRoot, "login");
      const isolatedOnly: ResolvedStack = { services: [isolated("web", "node web.js", ["WEB"])] };
      const observed: InFlightWorktree[][] = [];
      const observe: WithLifecycleLock = (anchor, instanceId, fn) =>
        withLifecycleLock(anchor, instanceId, async () => {
          const result = await fn();
          observed.push(inFlightWorktrees(anchor));
          return result;
        });
      const deps = { ...wt(fixture, isolatedOnly, "login").deps, withLifecycleLock: observe };
      await runUp(deps);
      await runDown(deps);
      expect(observed[0]).toEqual([
        { id, marker: expect.objectContaining({ services: [], ports: [] }) },
      ]);
      expect(observed[1]?.[0]?.marker?.services).toEqual([]);
      expect(observed[1]?.[0]?.marker?.ports).toBeUndefined();
      expect(existsSync(sharedStepMarkerFile(fixture.sharedAnchor, id))).toBe(false);
    });
  });

  describe("stable shared ports by name (#238)", () => {
    // Branch A declares postgres + x; branch B declares postgres + y + x. By
    // position, A's X_PORT and B's Y_PORT both take the shared block's second
    // slot: the cross-branch collision #238 reports.
    const x = inNs(shared("x", "x-server", ["X_PORT"]), "xs");
    const y = inNs(shared("y", "y-server", ["Y_PORT"]), "ys");
    const postgres = shared("postgres", "postgres -D ./pgdata", ["DB_PORT"]);
    const branchA: ResolvedStack = {
      services: [postgres, x, inNs(isolated("api", "node api.js", ["API_PORT"]), "app")],
    };
    const branchB: ResolvedStack = {
      services: [postgres, y, x, inNs(isolated("api", "node api.js", ["API_PORT"]), "app")],
    };
    const mapOf = (fixture: Fixture) => readSharedPortMap(fixture.sharedAnchor);

    for (const order of ["A then B", "B then A"] as const) {
      it(`two branches with different shared layouts agree on every port (${order})`, async () => {
        const fixture = nsFixture("dt-238-order-");
        const [first, second] =
          order === "A then B"
            ? [
                { stack: branchA, id: "login", ns: ["app"] },
                { stack: branchB, id: "billing", ns: ["app", "ys"] },
              ]
            : [
                { stack: branchB, id: "billing", ns: ["app", "ys"] },
                { stack: branchA, id: "login", ns: ["app"] },
              ];
        const one = await runUp(wt(fixture, first.stack, first.id, { namespaces: first.ns }).deps);
        const two = await runUp(
          wt(fixture, second.stack, second.id, { namespaces: second.ns }).deps,
        );
        const [envA, envB] = order === "A then B" ? [one.env, two.env] : [two.env, one.env];
        expect(envA.X_PORT).toBe(envB.X_PORT);
        expect(envA.DB_PORT).toBe(envB.DB_PORT);
        expect(new Set([envB.DB_PORT, envB.X_PORT, envB.Y_PORT]).size).toBe(3);

        // Activating x from either branch binds the number both were told.
        const activate = await runUp(
          wt(fixture, branchA, "login", { namespaces: ["app", "xs"] }).deps,
        );
        expect(activate.sharedActivated).toEqual(["x"]);
        expect(activate.env.X_PORT).toBe(envB.X_PORT);
        expect(readSharedState(fixture.sharedAnchor)?.ports.X_PORT).toBe(Number(envA.X_PORT));
        expect(mapOf(fixture)).toEqual({
          DB_PORT: Number(envB.DB_PORT),
          X_PORT: Number(envB.X_PORT),
          Y_PORT: Number(envB.Y_PORT),
        });
      });
    }

    it("env and up --dry-run read the map and never write it; their origins say so", async () => {
      const fixture = nsFixture("dt-238-readonly-");
      const deps = wt(fixture, branchA, "login", { namespaces: ["app"] }).deps;
      const before = await runEnv(deps);
      await runUpDryRun(deps);
      expect(mapOf(fixture)).toBeUndefined();
      expect(before.sharedPorts?.X_PORT?.origin).toBe("predicted");

      const up = await runUp(deps);
      expect(Number(up.env.X_PORT)).toBe(before.sharedPorts?.X_PORT?.port);
      const after = await runEnv(deps);
      expect(after.sharedPorts).toEqual({
        DB_PORT: { port: Number(up.env.DB_PORT), origin: "active" },
        X_PORT: { port: Number(up.env.X_PORT), origin: "recorded" },
      });
    });

    it("the map survives down --shared, so the next shared start binds the same numbers", async () => {
      const fixture = nsFixture("dt-238-down-");
      const a = await runUp(wt(fixture, branchA, "login", { namespaces: ["app"] }).deps);
      await runDown(wt(fixture, branchA, "login").deps, { shared: true });
      expect(existsSync(sharedInstancePaths(fixture.sharedAnchor).socketPath)).toBe(false);
      const b = await runUp(wt(fixture, branchB, "billing", { namespaces: ["app", "ys"] }).deps);
      expect(b.sharedStarted).toBe(true);
      expect(b.env.X_PORT).toBe(a.env.X_PORT);
      expect(b.env.Y_PORT).not.toBe(a.env.X_PORT);
    });

    it("a 0.4.0 shared instance (no map) is seeded from its live numbers: no reload, no drift", async () => {
      const fixture = nsFixture("dt-238-migrate-");
      const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      rmSync(sharedPortMapFile(fixture.sharedAnchor));
      const configBefore = sharedConfigOf(fixture);

      const second = wt(fixture, base, "billing", { namespaces: ["app", "db"] });
      const result = await runUp(second.deps);
      expect(result.sharedStarted).toBe(false);
      expect(second.reloads).toEqual([]);
      expect(sharedConfigOf(fixture)).toEqual(configBefore);
      expect(result.env.DB_PORT).toBe(first.env.DB_PORT);
      expect(result.env.SB_PORT).toBe(first.env.SB_PORT);
      expect(mapOf(fixture)).toEqual({
        DB_PORT: Number(first.env.DB_PORT),
        SB_PORT: Number(first.env.SB_PORT),
      });
    });

    it("seeds a 0.4.0 prediction from the running processes' env, not this branch's layout", async () => {
      // 0.4.0 started postgres from a branch that predicted SB_PORT one slot
      // further on; that number is in postgres's env, so it is the one kept.
      const fixture = nsFixture("dt-238-migrate-env-");
      const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const predicted = Number(first.env.SB_PORT) + 5;
      rewriteSharedEnv(fixture, "postgres", "SB_PORT", predicted);
      rmSync(sharedPortMapFile(fixture.sharedAnchor));

      const result = await runUp(wt(fixture, base, "billing", { namespaces: ["app", "db"] }).deps);
      expect(Number(result.env.SB_PORT)).toBe(predicted);
      expect(mapOf(fixture)?.SB_PORT).toBe(predicted);
    });

    it("a recorded port another running service binds fails SHARED_PORT_CONFLICT and changes nothing", async () => {
      // An older devtrees beside this one bound DB_PORT on SB_PORT's
      // recorded number: handing it out would give one port to two names.
      const fixture = nsFixture("dt-238-conflict-");
      const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      writeSharedPortMap(fixture.sharedAnchor, {
        DB_PORT: Number(first.env.SB_PORT),
        SB_PORT: Number(first.env.SB_PORT),
      });
      const mapBefore = readFileSync(sharedPortMapFile(fixture.sharedAnchor), "utf8");

      const blocked = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      const err = await failure(runUp(blocked.deps));
      expect(err?.code).toBe("SHARED_PORT_CONFLICT");
      expect(err?.details?.conflicts).toContainEqual({
        reason: "port_taken",
        port_name: "SB_PORT",
        port: Number(first.env.SB_PORT),
        holder: "DB_PORT",
      });
      expect(err?.details?.remedy).toBe("devtrees down --shared && devtrees up");
      expect(blocked.reloads).toEqual([]);
      expect(readFileSync(sharedPortMapFile(fixture.sharedAnchor), "utf8")).toBe(mapBefore);
      // `env` reports the same conflict instead of a wrong number.
      expect((await failure(runEnv(blocked.deps)))?.code).toBe("SHARED_PORT_CONFLICT");
    });

    it("a running process holding a stale number blocks only the up that would add its service", async () => {
      // 0.4.0 left postgres with SB_PORT=<DB_PORT>: a number another name holds.
      const fixture = nsFixture("dt-238-stale-");
      const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      rewriteSharedEnv(fixture, "postgres", "SB_PORT", Number(first.env.DB_PORT));
      rmSync(sharedPortMapFile(fixture.sharedAnchor));

      const warnings: string[] = [];
      const unaffected = wt(fixture, base, "billing", { namespaces: ["app", "db"] });
      await runUp({ ...unaffected.deps, warn: (m) => warnings.push(m) });
      expect(warnings.some((w) => w.includes("'postgres'") && w.includes("SB_PORT"))).toBe(true);

      const adding = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      const err = await failure(runUp(adding.deps));
      expect(err?.code).toBe("SHARED_PORT_CONFLICT");
      expect(err?.details?.conflicts).toEqual([
        expect.objectContaining({ reason: "stale_env", port_name: "SB_PORT", process: "postgres" }),
      ]);
      expect(adding.reloads).toEqual([]);
      expect(Object.keys(sharedConfigOf(fixture))).toEqual(["postgres"]);
    });

    it("a full shared block fails SHARED_PORT_CONFLICT block_full; prune --shared-ports frees it", async () => {
      // Names no branch uses any more hold every number of the shared block.
      const fixture = nsFixture("dt-238-full-");
      const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const used = { DB_PORT: Number(first.env.DB_PORT), SB_PORT: Number(first.env.SB_PORT) };
      const sharedBase = fixture.registryRef.snapshot.__shared__ ?? 0;
      const stale: Record<string, number> = {};
      for (let port = sharedBase; port < sharedBase + 32; port++) {
        if (!Object.values(used).includes(port)) stale[`OLD_${port}`] = port;
      }
      writeSharedPortMap(fixture.sharedAnchor, { ...used, ...stale });

      const grown: ResolvedStack = {
        services: [...base.services, shared("cache", "redis-server", ["CACHE_PORT"])],
      };
      const blocked = wt(fixture, grown, "billing", { namespaces: ["app", "db"] });
      const err = await failure(runUp(blocked.deps));
      expect(err?.code).toBe("SHARED_PORT_CONFLICT");
      expect(err?.details?.conflicts).toEqual([{ reason: "block_full", port_name: "CACHE_PORT" }]);
      expect(err?.details?.remedy).toBe("devtrees prune --shared-ports");
      expect((await failure(runEnv(blocked.deps)))?.code).toBe("SHARED_PORT_CONFLICT");

      const pruned = await runPruneSharedPorts(blocked.deps);
      expect(pruned.kept).toEqual(["DB_PORT", "SB_PORT"]);
      expect(pruned.dropped).toHaveLength(Object.keys(stale).length);
      const result = await runUp(blocked.deps);
      expect(result.env.DB_PORT).toBe(first.env.DB_PORT);
      expect(Number(result.env.CACHE_PORT)).toBeGreaterThanOrEqual(sharedBase);
    });

    it("prune --shared-ports keeps a name only a worktree's derived config holds", async () => {
      const fixture = nsFixture("dt-238-prune-wt-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const map = readSharedPortMap(fixture.sharedAnchor) ?? {};
      writeSharedPortMap(fixture.sharedAnchor, { ...map, GONE_PORT: 1 });
      // SB_PORT is no running service's, but the worktree's env carries it.
      const result = await runPruneSharedPorts(wt(fixture, base, "login").deps);
      // GONE_PORT=1 lies outside the shared block, and nothing running holds it.
      expect(result).toEqual({
        dropped: ["GONE_PORT"],
        kept: ["DB_PORT", "SB_PORT"],
        outOfBlock: ["GONE_PORT"],
        dryRun: false,
        blockedBy: [],
      });
      expect(readSharedPortMap(fixture.sharedAnchor)).toEqual(map);
    });

    it("prune --shared-ports refuses while a worktree's up holds its lifecycle lock", async () => {
      const fixture = nsFixture("dt-238-prune-lock-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const before = readFileSync(sharedPortMapFile(fixture.sharedAnchor), "utf8");
      writeFileSync(join(fixture.sharedAnchor, "devtrees", "billing.lock"), String(process.pid));
      const err = await failure(runPruneSharedPorts(wt(fixture, base, "login").deps));
      expect(err?.code).toBe("LOCK_CONTENTION");
      expect(readFileSync(sharedPortMapFile(fixture.sharedAnchor), "utf8")).toBe(before);
    });

    it("prune --shared-ports goes ahead beside an up past its shared step, and keeps the ports it injects", async () => {
      const fixture = nsFixture("dt-238-prune-marked-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const map = readSharedPortMap(fixture.sharedAnchor) ?? {};
      writeSharedPortMap(fixture.sharedAnchor, {
        ...map,
        NEW_PORT: map.DB_PORT! + 5,
        GONE_PORT: 1,
      });
      const id = idFor(fixture.wtRoot, "billing");
      const result = await withLifecycleLock(fixture.sharedAnchor, id, async () => {
        // billing's `up` recorded NEW_PORT and has not written its config yet.
        writeSharedStepMarker(fixture.sharedAnchor, id, { services: [], ports: ["NEW_PORT"] });
        return await runPruneSharedPorts(wt(fixture, base, "login").deps);
      });
      expect(result.dropped).toEqual(["GONE_PORT"]);
      expect(result.kept).toEqual(["DB_PORT", "NEW_PORT", "SB_PORT"]);
    });

    it("prune --shared-ports --dry-run reports what it would drop, writes nothing, and never refuses", async () => {
      const fixture = nsFixture("dt-238-prune-dry-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const map = readSharedPortMap(fixture.sharedAnchor) ?? {};
      writeSharedPortMap(fixture.sharedAnchor, { ...map, GONE_PORT: map.DB_PORT! + 7 });
      const before = readFileSync(sharedPortMapFile(fixture.sharedAnchor), "utf8");
      const lock = join(
        fixture.sharedAnchor,
        "devtrees",
        `${idFor(fixture.wtRoot, "billing")}.lock`,
      );
      writeFileSync(lock, String(process.pid));
      const deps = wt(fixture, base, "login").deps;
      const preview = await runPruneSharedPorts(
        { ...deps, withSharedLock: () => Promise.reject(new Error("no lock in a dry run")) },
        { dryRun: true },
      );
      expect(preview).toEqual({
        dropped: ["GONE_PORT"],
        kept: ["DB_PORT", "SB_PORT"],
        outOfBlock: [],
        dryRun: true,
        blockedBy: [idFor(fixture.wtRoot, "billing")],
      });
      expect(readFileSync(sharedPortMapFile(fixture.sharedAnchor), "utf8")).toBe(before);
      rmSync(lock);
      const real = await runPruneSharedPorts(deps);
      expect(real).toMatchObject({ dropped: ["GONE_PORT"], dryRun: false, blockedBy: [] });
    });

    it("prune --shared-ports drops a name recorded outside the block once nothing running holds it", async () => {
      const fixture = nsFixture("dt-238-prune-outside-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const map = readSharedPortMap(fixture.sharedAnchor) ?? {};
      writeSharedPortMap(fixture.sharedAnchor, {
        ...map,
        OLD_PORT: 7,
        KEEP_PORT: map.DB_PORT! + 9,
      });
      // A stopped worktree's config still carries both names (no socket: not running).
      const stopped = instancePaths(fixture.sharedAnchor, "old-0a1b2c3d").configPath;
      writeFileSync(
        stopped,
        stringifyYaml({
          processes: {
            web: { command: "x", environment: ["OLD_PORT=7", `KEEP_PORT=${map.DB_PORT! + 9}`] },
          },
        }),
      );
      const deps = wt(fixture, base, "login").deps;
      const preview = await runPruneSharedPorts(deps, { dryRun: true });
      // KEEP_PORT is inside the block: a config on disk holds it, as before.
      expect(preview).toMatchObject({ dropped: ["OLD_PORT"], outOfBlock: ["OLD_PORT"] });
      expect(preview.kept).toContain("KEEP_PORT");

      // A running instance carrying it holds it.
      const runningOld: InstanceInfo = {
        id: "old-0a1b2c3d",
        kind: "worktree",
        status: "running",
        socketPath: instancePaths(fixture.sharedAnchor, "old-0a1b2c3d").socketPath,
        ports: {},
        blockBase: undefined,
        services: [],
        namespaces: [],
        servicesRead: "skipped",
      };
      const held = await runPruneSharedPorts({ ...deps, discover: async () => [runningOld] });
      expect(held).toMatchObject({ dropped: [], outOfBlock: [] });
      expect(readSharedPortMap(fixture.sharedAnchor)?.OLD_PORT).toBe(7);

      const result = await runPruneSharedPorts(deps);
      expect(result).toMatchObject({ dropped: ["OLD_PORT"], outOfBlock: ["OLD_PORT"] });
      expect(readSharedPortMap(fixture.sharedAnchor)?.OLD_PORT).toBeUndefined();
      // The warning `up` printed for it is gone, and the next `up` keeps every other number.
      const warnings: string[] = [];
      const again = await runUp({
        ...wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps,
        warn: (m) => warnings.push(m),
      });
      expect(again.env.DB_PORT).toBe(String(map.DB_PORT));
      expect(warnings.filter((w) => w.includes("outside the shared block"))).toEqual([]);
    });

    it("an up rewrites a map with an invalid entry, so its warning is printed once", async () => {
      const fixture = nsFixture("dt-238-repair-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const map = readSharedPortMap(fixture.sharedAnchor) ?? {};
      writeFileSync(
        sharedPortMapFile(fixture.sharedAnchor),
        JSON.stringify({ version: 1, ports: { ...map, BAD_PORT: "nope" } }),
      );
      const warnings: string[] = [];
      const deps = {
        ...wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps,
        warn: (m: string) => warnings.push(m),
      };
      // `env` only reads: it warns and leaves the file as it is.
      await runEnv(deps);
      expect(warnings.filter((w) => w.includes("BAD_PORT"))).toHaveLength(1);
      await runUp(deps);
      expect(warnings.filter((w) => w.includes("BAD_PORT"))).toHaveLength(2);
      expect(readSharedPortMap(fixture.sharedAnchor)).toEqual(map);
      await runEnv(deps);
      await runUp(deps);
      expect(warnings.filter((w) => w.includes("BAD_PORT"))).toHaveLength(2);
    });

    it("prune --shared-ports rewrites a map with an invalid entry even when it drops nothing", async () => {
      const fixture = nsFixture("dt-238-prune-repair-");
      await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      const map = readSharedPortMap(fixture.sharedAnchor) ?? {};
      writeFileSync(
        sharedPortMapFile(fixture.sharedAnchor),
        JSON.stringify({ version: 1, ports: { ...map, BAD_PORT: -1 } }),
      );
      const result = await runPruneSharedPorts({
        ...wt(fixture, base, "login").deps,
        warn: () => {},
      });
      expect(result.dropped).toEqual([]);
      expect(JSON.parse(readFileSync(sharedPortMapFile(fixture.sharedAnchor), "utf8"))).toEqual({
        version: 1,
        ports: map,
      });
    });

    it("SHARED_PORT_CONFLICT's remedy is one runnable command; 'every worktree' is in the message", async () => {
      const fixture = nsFixture("dt-238-remedy-");
      const first = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
      writeSharedPortMap(fixture.sharedAnchor, {
        DB_PORT: Number(first.env.DB_PORT),
        SB_PORT: Number(first.env.DB_PORT),
      });
      const err = await failure(runUp(wt(fixture, base, "billing", { namespaces: ["app"] }).deps));
      expect(err?.details?.remedy).toBe("devtrees down --shared && devtrees up");
      expect(err?.message).toContain("for every worktree");
      expect(err?.message).toContain("surface it to a human");
    });

    it("env reports no port active for a leftover socket nothing listens on", async () => {
      const fixture = nsFixture("dt-238-stale-sock-");
      const deps = wt(fixture, branchA, "login", { namespaces: ["app"] }).deps;
      await runUp(deps);
      const sharedSock = sharedInstancePaths(fixture.sharedAnchor).socketPath;
      // The shared process-compose was killed: its socket file stays, nothing listens.
      fixture.pc.crash(sharedSock);
      expect(existsSync(sharedSock)).toBe(true);
      const env = await runEnv(deps);
      expect(env.sharedPorts?.DB_PORT?.origin).toBe("recorded");
    });

    /** Rewrite one shared process's injected value for `name`, as a 0.4.0 prediction would. */
    function rewriteSharedEnv(fixture: Fixture, process: string, name: string, port: number) {
      const path = sharedInstancePaths(fixture.sharedAnchor).configPath;
      const doc = parseYaml(readFileSync(path, "utf8")) as {
        processes: Record<string, { environment: string[] }>;
      };
      const proc = doc.processes[process];
      if (proc === undefined) throw new Error(`no process ${process}`);
      proc.environment = proc.environment.map((e) =>
        e.startsWith(`${name}=`) ? `${name}=${port}` : e,
      );
      writeFileSync(path, stringifyYaml(doc), "utf8");
    }
  });

  /**
   * #240: `up` restarts a dead selected shared service instead of failing
   * SHARED_SERVICE_DEAD — after the drift check, under the shared lock, with
   * `process start` on the shared socket, in `depends_on` order — then waits
   * for it. A running shared service is never touched.
   */
  describe("restarting dead shared services (#240)", () => {
    /** The shared process `name` was killed: `Completed`, exit -1, not running. */
    const kill = (fixture: Fixture, ...names: string[]) => {
      const sock = sharedInstancePaths(fixture.sharedAnchor).socketPath;
      for (const name of names) fixture.pc.exit(sock, name, -1);
    };

    /**
     * One worktree's `up` deps against the running shared instance, with the
     * real wait on the shared services (#240), not the suite's no-op.
     * `starts` lists the services a `process start` on the shared socket
     * named since these deps were made.
     */
    function againstDead(
      fixture: Fixture,
      stack: ResolvedStack,
      worktreeId: string,
      opts: { readonly namespaces: string[] },
    ) {
      const w = wt(fixture, stack, worktreeId, { namespaces: opts.namespaces });
      const since = fixture.pc.requests.length;
      const deps: CommandDeps = { ...w.deps, waitForSharedReady: undefined };
      return {
        deps,
        get reloads() {
          return w.reloads;
        },
        get ups() {
          return w.ups;
        },
        sharedSock: w.sharedSock,
        get starts() {
          return fixture.pc.requests
            .slice(since)
            .filter((r) => r.op === "start" && r.socketPath === w.sharedSock)
            .flatMap((r) => r.services ?? []);
        },
      };
    }

    /** Start the shared instance (postgres, db-shared) from a first worktree. */
    async function sharedRunning(prefix: string, stack: ResolvedStack = base) {
      const fixture = nsFixture(prefix);
      await runUp(wt(fixture, stack, "login", { namespaces: ["app", "db-shared"] }).deps);
      return fixture;
    }

    it("a dead always-on shared service is restarted on the shared socket; running ones are untouched", async () => {
      const fixture = await sharedRunning("dt-rds-basic-");
      const configBefore = readFileSync(
        sharedInstancePaths(fixture.sharedAnchor).configPath,
        "utf8",
      );
      const billing = againstDead(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      const dbSharedPid = fixture.pc.pidOf(billing.sharedSock, "db-shared");
      kill(fixture, "postgres");
      const result = await runUp(billing.deps);

      expect(billing.starts).toEqual(["postgres"]);
      expect(fixture.pc.rows(billing.sharedSock).map((r) => [r.name, r.status])).toEqual([
        ["postgres", "Running"],
        ["db-shared", "Running"],
      ]);
      expect(result.sharedRestarted).toEqual(["postgres"]);
      expect(result.sharedStarted).toBe(false);
      expect(result.sharedActivated).toEqual([]);
      // db-shared, running, was not started, stopped or reloaded; neither was
      // the shared instance itself.
      expect(fixture.pc.pidOf(billing.sharedSock, "db-shared")).toBe(dbSharedPid);
      expect(billing.reloads).toEqual([]);
      expect(billing.ups.filter((r) => r.socketPath === billing.sharedSock)).toEqual([]);
      expect(readFileSync(sharedInstancePaths(fixture.sharedAnchor).configPath, "utf8")).toBe(
        configBefore,
      );
    });

    it("restarts on the running-instance path too (the worktree instance is already up)", async () => {
      const fixture = await sharedRunning("dt-rds-running-");
      await runUp(wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] }).deps);
      const again = againstDead(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      kill(fixture, "db-shared");
      const result = await runUp(again.deps);
      expect(again.starts).toEqual(["db-shared"]);
      expect(result.sharedRestarted).toEqual(["db-shared"]);
      expect(result.restarted).toEqual([]);
    });

    it("drift first: a drifted selected service fails SHARED_DRIFT and nothing is restarted", async () => {
      // `cache` keeps the shared process-compose up while both are dead.
      const withCache = (stack: ResolvedStack): ResolvedStack => ({
        services: [...stack.services, shared("cache", "redis-server", ["CACHE_PORT"])],
      });
      const fixture = await sharedRunning("dt-rds-drift-", withCache(base));
      const billing = againstDead(fixture, withCache(drifted), "billing", {
        namespaces: ["app", "db-shared"],
      });
      kill(fixture, "postgres", "db-shared");
      const err = await failure(runUp(billing.deps));
      expect(err?.code).toBe("SHARED_DRIFT");
      expect(billing.starts).toEqual([]);
      const statusOf = (name: string) =>
        fixture.pc.rows(billing.sharedSock).find((r) => r.name === name)?.status;
      expect(statusOf("postgres")).toBe("Completed");
      expect(statusOf("db-shared")).toBe("Completed");
    });

    it("a dead namespaced shared service this up does not select is left dead", async () => {
      const fixture = await sharedRunning("dt-rds-unselected-");
      const billing = againstDead(fixture, base, "billing", { namespaces: ["app", "db"] });
      kill(fixture, "db-shared");
      const result = await runUp(billing.deps);
      expect(billing.starts).toEqual([]);
      expect(result.sharedRestarted).toEqual([]);
      expect(fixture.pc.rows(billing.sharedSock).find((r) => r.name === "db-shared")?.status).toBe(
        "Completed",
      );
    });

    it("an exit-0 one-shot is done, and a Restarting service is left to process-compose", async () => {
      const fixture = await sharedRunning("dt-rds-done-");
      const billing = againstDead(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      fixture.pc.exit(billing.sharedSock, "postgres", 0);
      fixture.pc.backoff(billing.sharedSock, "db-shared");
      // Nothing is started; up still waits for the Restarting service, and
      // fails not_healthy when it never comes back.
      const err = await failure(runUp({ ...billing.deps, waitTimeoutMs: 300 }));
      expect(billing.starts).toEqual([]);
      expect(err?.code).toBe("SHARED_SERVICE_DEAD");
      expect(err?.details).toMatchObject({
        reason: "not_healthy",
        unhealthy_services: ["db-shared"],
      });
    });

    it("an up that restarts nothing still waits for a running shared service that is not ready yet", async () => {
      // Another worktree's up restarted db-shared: Running, its probe not passed yet.
      const probed: ResolvedStack = {
        services: base.services.map((s) =>
          s.name === "db-shared" ? { ...s, readinessProbe: { exec: { command: "x" } } } : s,
        ),
      };
      const fixture = await sharedRunning("dt-rds-notready-", probed);
      const billing = againstDead(fixture, probed, "billing", { namespaces: ["app", "db-shared"] });
      fixture.pc.setReady(billing.sharedSock, "db-shared", false);
      // The probe passes on the fourth read of the shared instance.
      let sharedReads = 0;
      fixture.on((r) => {
        if (r.op !== "list" || r.socketPath !== billing.sharedSock) return;
        sharedReads += 1;
        if (sharedReads === 4) fixture.pc.setReady(billing.sharedSock, "db-shared", true);
      });
      const result = await runUp(billing.deps);
      expect(billing.starts).toEqual([]);
      expect(result.sharedRestarted).toEqual([]);
      // It returned only once the probe passed.
      expect(sharedReads).toBeGreaterThanOrEqual(4);
    });

    it("on the running path the shared wait runs outside the worktree lifecycle lock; on the fresh path inside it", async () => {
      const fixture = await sharedRunning("dt-rds-lock-");
      // A `down` of the same worktree must get the lock while up waits on shared.
      const lockFreeDuringWait = async (deps: CommandDeps, id: string): Promise<boolean> => {
        let free: boolean | undefined;
        await runUp({
          ...deps,
          waitForSharedReady: async () => {
            free = await withLifecycleLock(fixture.sharedAnchor, id, async () => true, {
              retries: 0,
            }).catch(() => false);
          },
        });
        if (free === undefined) throw new Error("the shared wait did not run");
        return free;
      };
      const fresh = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      const id = idFor(fixture.wtRoot, "billing");
      expect(await lockFreeDuringWait(fresh.deps, id)).toBe(false);
      const running = wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      expect(await lockFreeDuringWait(running.deps, id)).toBe(true);
    });

    it("dead shared services are started in depends_on order", async () => {
      const chain: ResolvedStack = {
        services: [
          { ...shared("api-shared", "api", ["SAPI_PORT"]), dependsOn: [{ name: "pg" }] },
          shared("pg", "postgres", ["PG_PORT"]),
          // Keeps the shared process-compose up while the other two are dead.
          shared("cache", "redis-server", ["CACHE_PORT"]),
          inNs(isolated("api", "node api.js", ["API_PORT"]), "app"),
        ],
      };
      const fixture = await sharedRunning("dt-rds-order-", chain);
      const billing = againstDead(fixture, chain, "billing", { namespaces: ["app"] });
      kill(fixture, "api-shared", "pg");
      const result = await runUp(billing.deps);
      expect(billing.starts).toEqual(["pg", "api-shared"]);
      expect(result.sharedRestarted).toEqual(["pg", "api-shared"]);
    });

    it("a refused start fails SHARED_SERVICE_DEAD start_refused with process-compose's message", async () => {
      const fixture = await sharedRunning("dt-rds-refused-");
      const billing = againstDead(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      kill(fixture, "postgres");
      fixture.pc.refuse("start", "postgres", 'FTL failed to start process postgres error="boom"');
      const err = await failure(runUp(billing.deps));
      expect(err?.code).toBe("SHARED_SERVICE_DEAD");
      expect(err?.message).toContain("process-compose refused to start it again");
      expect(err?.details).toEqual({
        dead_services: [{ name: "postgres", status: "Completed", exit_code: -1 }],
        reason: "start_refused",
        start_failures: [
          { name: "postgres", message: 'FTL failed to start process postgres error="boom"' },
        ],
        remedy: "devtrees down --shared && devtrees up",
      });
      expect(classifyError(err as Error).code).toBe("SHARED_SERVICE_DEAD");
    });

    it("a start answered 'already running' is not a failure and not reported as restarted", async () => {
      const fixture = await sharedRunning("dt-rds-already-");
      const billing = againstDead(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      kill(fixture, "postgres");
      // Another client starts postgres between this up's read and its start.
      let rivalStarted = false;
      const raced: CommandDeps = {
        ...billing.deps,
        processCompose: {
          ...fixture.pc.driver,
          async startProcess(socketPath, service) {
            if (!rivalStarted) {
              rivalStarted = true;
              await fixture.pc.driver.startProcess(socketPath, service);
            }
            return fixture.pc.driver.startProcess(socketPath, service);
          },
        },
      };
      const result = await runUp(raced);
      // The rival's start, then this up's one start, answered "already running".
      expect(billing.starts).toEqual(["postgres", "postgres"]);
      expect(result.sharedRestarted).toEqual([]);
      expect(fixture.pc.rows(billing.sharedSock).find((r) => r.name === "postgres")?.status).toBe(
        "Running",
      );
    });

    it("a restarted shared service that dies again fails fast with SHARED_SERVICE_DEAD died_again", async () => {
      const fixture = await sharedRunning("dt-rds-dies-");
      const billing = againstDead(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      kill(fixture, "postgres");
      // The restarted postgres exits 1 at once.
      const dying: CommandDeps = {
        ...billing.deps,
        processCompose: {
          ...fixture.pc.driver,
          async startProcess(socketPath, service) {
            const started = await fixture.pc.driver.startProcess(socketPath, service);
            fixture.pc.exit(socketPath, service, 1);
            return started;
          },
        },
      };
      const started = Date.now();
      const err = await failure(runUp({ ...dying, waitTimeoutMs: 60_000 }));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(err?.code).toBe("SHARED_SERVICE_DEAD");
      expect(err?.message).toContain("devtrees restarted postgres, and it died again");
      expect(err?.details).toMatchObject({
        dead_services: [{ name: "postgres", status: "Completed", exit_code: 1 }],
        reason: "died_again",
        remedy: "devtrees down --shared && devtrees up",
      });
      expect(billing.starts).toHaveLength(1);
    });

    it("two concurrent ups from different worktrees start the dead service once", async () => {
      const fixture = await sharedRunning("dt-rds-race-");
      // The real file lock, not the suite's pass-through: without it both ups
      // read postgres dead and both start it.
      const realLock: WithSharedLock = (anchor, fn) => withSharedLock(anchor, fn);
      const opts = { namespaces: ["app", "db-shared"] };
      const one = againstDead(fixture, base, "billing", opts);
      const two = againstDead(fixture, base, "orders", opts);
      kill(fixture, "postgres");
      const results = await Promise.all([
        runUp({ ...one.deps, withSharedLock: realLock }),
        runUp({ ...two.deps, withSharedLock: realLock }),
      ]);
      expect(one.starts).toEqual(["postgres"]);
      expect(results.flatMap((r) => r.sharedRestarted)).toEqual(["postgres"]);
    });

    it("restarts a dead service before adding a newly selected one", async () => {
      // `cache` keeps the shared process-compose up while postgres is dead.
      const withCache: ResolvedStack = {
        services: [...base.services, shared("cache", "redis-server", ["CACHE_PORT"])],
      };
      const fixture = nsFixture("dt-rds-add-");
      await runUp(wt(fixture, withCache, "login", { namespaces: ["app", "db"] }).deps);
      const billing = againstDead(fixture, withCache, "billing", {
        namespaces: ["app", "db-shared"],
      });
      kill(fixture, "postgres");
      const result = await runUp(billing.deps);
      expect(result.sharedRestarted).toEqual(["postgres"]);
      expect(result.sharedActivated).toEqual(["db-shared"]);
      expect(billing.starts).toEqual(["postgres"]);
    });

    it("up --dry-run previews the dead shared services up would restart, and starts nothing", async () => {
      const fixture = await sharedRunning("dt-rds-dry-");
      const billing = againstDead(fixture, base, "billing", { namespaces: ["app", "db-shared"] });
      kill(fixture, "postgres");
      const preview = await runUpDryRun(billing.deps);
      expect(preview.wouldRestartShared).toEqual(["postgres"]);
      expect(billing.starts).toEqual([]);

      // Not selected: not previewed.
      // (postgres is back; db-shared is the dead one now.)
      await fixture.pc.driver.startProcess(billing.sharedSock, "postgres");
      kill(fixture, "db-shared");
      const narrow = againstDead(fixture, base, "billing", { namespaces: ["app", "db"] });
      expect((await runUpDryRun(narrow.deps)).wouldRestartShared).toEqual([]);

      // Drifted: the real up would fail SHARED_DRIFT and restart nothing.
      const drift = againstDead(fixture, drifted, "billing", { namespaces: ["app", "db-shared"] });
      expect((await runUpDryRun(drift.deps)).wouldRestartShared).toEqual([]);
      expect(drift.starts).toEqual([]);
    });
  });

  it("a shared instance with no shared state (pre-#83) cannot have a namespaced service added: SHARED_ACTIVATION_FAILED", async () => {
    const fixture = nsFixture("dt-nss-pre83-");
    // A shared instance an older devtrees started: it runs postgres, but
    // there is no shared-state.json, no shared port map and no derived
    // shared config to read its ports back from.
    await runUp(wt(fixture, base, "orders", { namespaces: ["app", "db"] }).deps);
    rmSync(join(fixture.sharedAnchor, "devtrees", "shared-state.json"));
    rmSync(sharedPortMapFile(fixture.sharedAnchor));
    rmSync(sharedInstancePaths(fixture.sharedAnchor).configPath);

    // Always-on only: the old positional fallback still applies.
    const ok = await runUp(wt(fixture, base, "login", { namespaces: ["app", "db"] }).deps);
    expect(ok.sharedStarted).toBe(false);

    const err = await failure(
      runUp(wt(fixture, base, "billing", { namespaces: ["app", "db-shared"] }).deps),
    );
    expect(err?.code).toBe("SHARED_ACTIVATION_FAILED");
    expect(err?.details).toMatchObject({ services: ["db-shared"], reason: "not_supported" });
  });

  it("SHARED_DRIFT keeps running_hash/local_hash as the always-on whole-subset hashes", async () => {
    const fixture = nsFixture("dt-nss-hashes-");
    await runUp(wt(fixture, base, "login", { namespaces: ["app", "db-shared"] }).deps);
    const err = await failure(
      runUp(wt(fixture, drifted, "billing", { namespaces: ["app", "db-shared"] }).deps),
    );
    const alwaysOn = { services: [base.services[0] as ResolvedService] };
    expect(err?.details).toMatchObject({
      running_hash: sharedStackHash(alwaysOn),
      local_hash: sharedStackHash(alwaysOn),
    });
  });
});
