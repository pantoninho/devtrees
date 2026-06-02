/**
 * Commands (orchestration).
 *
 * `up` and `down` wire the deep cores (anchor resolver, stack model, allocator,
 * deriver) to the adapters (driver, filesystem, registry). They own no domain
 * logic of their own — they sequence the modules and perform the I/O. Every
 * side-effecting collaborator is injected so the orchestration is exercisable in
 * an e2e against a temp git repo + stub process-compose.
 */

import { allocateBlock, type AllocatorOptions, type RegistrySnapshot } from "./allocator.js";
import { resolveAnchor, type GitProbe } from "./anchor.js";
import { deriveSharedConfig, deriveWorktreeConfig, type DroppedEdge } from "./deriver.js";
import { discoverInstances, type InstanceInfo, type Service } from "./instances.js";
import { SHARED_REGISTRY_KEY, instancePaths, sharedInstancePaths } from "./paths.js";
import { findOrphans, parseWorktreeIds } from "./prune.js";
import { loadStack, type ResolvedService, type ResolvedStack } from "./stack.js";
import {
  createDriver,
  type DriverDeps,
  type LogEvent,
  type ServiceStatus,
  type StreamLogsOptions,
} from "./driver.js";
import { readRegistry, withRegistryLock, withSharedLock } from "./registry.js";
import { defaultIsPortFree } from "./port-probe.js";
import { stackHash } from "./hash.js";
import {
  readStoredHash as defaultReadStoredHash,
  writeStoredHash as defaultWriteStoredHash,
} from "./hashes.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Thrown when `up` detects config drift against a running instance and the
 * driver could not hot-reload (older process-compose without `project
 * update`, or any failure to apply the new config). The instance keeps
 * running unchanged; the CLI maps this to the `CONFIG_DRIFT` error
 * envelope so an agent can decide whether to `down` + `up` or hand off to
 * a human (ADR-0005).
 */
class ConfigDriftError extends Error {
  readonly code = "CONFIG_DRIFT";
  constructor(message: string) {
    super(message);
    this.name = "ConfigDriftError";
  }
}

const DEFAULT_ALLOCATOR: AllocatorOptions = { portBase: 20000, blockSize: 32 };

/** Type of the lock-guarded mutator the caller passes for testability. */
export type WithRegistryLock = (
  anchor: string,
  mutate: (snapshot: RegistrySnapshot) => RegistrySnapshot | Promise<RegistrySnapshot>,
) => Promise<RegistrySnapshot>;

/** Type of the async lifecycle lock the caller passes for testability. */
export type WithSharedLock = <T>(anchor: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Wait until every shared service is healthy enough that an isolated service
 * depending on it can be started. Called between starting the shared instance
 * and starting the worktree instance whenever the worktree has cross-tier
 * `depends_on` edges (ADR-0003). The default polls process-compose over the
 * shared instance's UDS; tests stub it.
 */
export type WaitForSharedHealth = (args: {
  readonly anchor: string;
  readonly socketPath: string;
  readonly sharedServiceNames: ReadonlyArray<string>;
}) => Promise<void>;

/**
 * Wait until every named service in an instance is healthy. Called after the
 * worktree instance starts so `up` only returns 0 when the stack can actually
 * serve traffic (PRD #26, ADR-0005). On timeout, implementations must throw a
 * `HealthTimeoutError` — left running, not torn down, so the agent can inspect
 * the failure with `devtrees logs <service>` afterwards.
 */
export type WaitForHealth = (args: {
  readonly socketPath: string;
  readonly serviceNames: ReadonlyArray<string>;
  readonly timeoutMs: number;
}) => Promise<void>;

/**
 * Throw on health-wait timeout; carries the `HEALTH_TIMEOUT` error code so the
 * CLI's error classifier routes it to the documented `--json` envelope without
 * pattern-matching on the message.
 */
class HealthTimeoutError extends Error {
  readonly code = "HEALTH_TIMEOUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "HealthTimeoutError";
  }
}

/** Default health-wait window for the worktree instance — overridable per call. */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export interface CommandDeps {
  /** Working directory to resolve the worktree from. Default: process.cwd(). */
  readonly cwd?: string;
  /** Inject git. Default: runs the real `git` in `cwd`. */
  readonly git?: GitProbe;
  /** Read the stack from a directory. Default: reads `devtrees.yaml` from disk. */
  readonly readStack?: (dir: string) => ReturnType<typeof loadStack>;
  /**
   * Acquire the allocation-registry lock, run a read-modify-write against an
   * atomic snapshot, and persist the result. Default: real flock under the
   * anchor (`registry.ts`). Injected so tests can stub it.
   */
  readonly withRegistryLock?: WithRegistryLock;
  /**
   * Read the persisted allocation registry without acquiring the lock — used by
   * pure-read commands (e.g. `env`, #32) that must not interfere with concurrent
   * `up`s. Default: real read from `<anchor>/devtrees/registry.json`.
   */
  readonly readRegistry?: (anchor: string) => RegistrySnapshot;
  /**
   * Async lifecycle lock around shared-instance start/stop. Default: real
   * lockfile at <anchor>/devtrees/shared.lock. Injected so tests can stub it.
   */
  readonly withSharedLock?: WithSharedLock;
  /**
   * Wait for shared services to be healthy before bringing the worktree
   * instance up — orchestration-layer stand-in for the dropped cross-tier
   * `depends_on` edges (ADR-0003). Default: polls `process-compose process
   * list` over the shared UDS. Injected so tests can stub it.
   */
  readonly waitForSharedHealth?: WaitForSharedHealth;
  /**
   * Wait for the worktree instance's services to be healthy after `driver.up`
   * — the gate that turns "up returned" into "the stack is serving traffic"
   * (PRD #26, ADR-0005). Default polls process-compose over the worktree
   * instance's UDS; injected so tests stub it.
   */
  readonly waitForHealth?: WaitForHealth;
  /** Health-wait window for the worktree instance. Default: 120s. */
  readonly waitTimeoutMs?: number;
  /**
   * Read the per-service runtime state for the worktree instance after health
   * is reached, so `runUp` can publish `services[]` in the issue-#30 state
   * envelope. Default: shells out to the driver's `getServiceStatuses` (same
   * primitive `ls --json` uses, issue #29). Injected so tests stub it.
   */
  readonly getServiceStatuses?: (socketPath: string) => Promise<ServiceStatus[]>;
  /** Is a concrete port free to bind? Default: probes a real TCP bind. */
  readonly isPortFree?: (port: number) => boolean | Promise<boolean>;
  /**
   * Allocator defaults — `port_base` and `block_size`. The stack's `allocator`
   * field overrides these on a field-by-field basis. Default: 20000 / 32.
   */
  readonly allocator?: AllocatorOptions;
  readonly driver?: DriverDeps;
  /**
   * Read the resolved-stack hash previously stored for a worktree (issue #31).
   * Default: reads `<anchor>/devtrees/hashes.json`. Injected so noop / drift
   * branch tests can run without touching disk.
   */
  readonly readStoredHash?: (anchor: string, worktreeId: string) => string | undefined;
  /**
   * Persist the resolved-stack hash for a worktree (issue #31). Default:
   * writes to `<anchor>/devtrees/hashes.json`.
   */
  readonly writeStoredHash?: (anchor: string, worktreeId: string, hash: string) => void;
  /**
   * Attach the TUI after a successful up. Default: only when both stdout and
   * stderr are TTYs (ADR-0005 — agent invocations shouldn't be hijacked by
   * the TUI). Setting this explicitly overrides the auto-detect.
   */
  readonly attach?: boolean;
  /**
   * Inject the TTY check so unit tests can prove the auto-detect logic
   * without touching `process.stdout.isTTY`. Default: returns true only when
   * both stdout and stderr are TTYs. Ignored when `attach` is set explicitly.
   */
  readonly isTTY?: () => boolean;
  /** Sink for non-fatal warnings (e.g. unmanaged port detection). Default: stderr. */
  readonly warn?: (message: string) => void;
}

export interface UpResult {
  readonly worktreeId: string;
  readonly socketPath: string;
  /**
   * Flat env injection: this worktree's own named ports + the shared services'
   * named ports + the worktree id. Connection info for shared services is in
   * here so an isolated service can reach a shared one through `${...}` with
   * no extra wiring.
   */
  readonly env: Record<string, string>;
  /** True iff this `up` triggered the lazy start of the shared instance. */
  readonly sharedStarted: boolean;
  /**
   * Base port of this worktree's allocation block (issue #30). The `env`
   * named-port numbers all fall within `[blockBase, blockBase + blockSize)`;
   * `block_base` in the `up --json` envelope is this value.
   */
  readonly blockBase: number;
  /**
   * One row per service the driver reports running on this worktree's
   * instance after the health-wait — same shape `ls --json` (issue #29)
   * publishes. Degrades to `[]` on a getServiceStatuses error so a flaky
   * driver call cannot fail an otherwise-healthy `up`.
   */
  readonly services: ReadonlyArray<Service>;
}

export interface GenerateResult {
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  /** Path of the written worktree-isolated config. */
  readonly worktreePath: string;
  /** Path of the written shared config — present iff the stack has shared services. */
  readonly sharedPath?: string;
  /**
   * Env injection the worktree instance would receive — this worktree's own
   * named ports + the shared services' named ports + the worktree id. Same
   * shape `runUp` returns; lets callers re-derive identically.
   */
  readonly env: Record<string, string>;
  /** Env injection for the shared instance — present iff a shared file was written. */
  readonly sharedEnv?: Record<string, string>;
}

export interface DownOptions {
  /**
   * When true, tears down the shared instance (CONTEXT.md "Shared instance":
   * lifecycle is decoupled from any single worktree's `down`). Defaults to
   * false — a plain `devtrees down` only stops this worktree's instance and
   * leaves shared running for the others.
   */
  readonly shared?: boolean;
}

function resolve(deps: CommandDeps) {
  const cwd = deps.cwd ?? process.cwd();
  const git = deps.git ?? defaultGit(cwd);
  const anchor = resolveAnchor(cwd, git);
  return { cwd, anchor };
}

/**
 * Merge the per-repo allocator overrides parsed from `devtrees.yaml` over the
 * deps-level defaults, on a field-by-field basis. The result is what the
 * allocator runs with.
 */
function resolveAllocatorOptions(
  stack: ResolvedStack,
  fallback: AllocatorOptions,
): AllocatorOptions {
  const overrides = stack.allocator;
  if (overrides === undefined) return fallback;
  return {
    portBase: overrides.portBase ?? fallback.portBase,
    blockSize: overrides.blockSize ?? fallback.blockSize,
  };
}

/**
 * Map every named port a tier's services declare to a fixed offset within
 * its allocated block — first service's ports get offset 0, 1, 2, ...; next
 * service's continue. Throws if the count exceeds `blockSize`.
 */
function buildOffsetMap(
  services: ReadonlyArray<ResolvedService>,
  tier: "isolated" | "shared",
  blockSize: number,
): Map<string, number> {
  const out = new Map<string, number>();
  let next = 0;
  for (const service of services) {
    if (service.tier !== tier) continue;
    for (const portName of service.ports) {
      out.set(portName, next++);
    }
  }
  if (next > blockSize) {
    throw new Error(`stack declares ${next} ${tier} named ports but block_size is ${blockSize}`);
  }
  return out;
}

/** Does the stack contain at least one service in the given tier? */
function hasTier(stack: ResolvedStack, tier: "isolated" | "shared"): boolean {
  return stack.services.some((s) => s.tier === tier);
}

interface AllocatedPortMaps {
  readonly blockBase: number;
  readonly sharedBase?: number;
  /** Resolve an isolated-tier named port to a concrete number, or `undefined` if unknown. */
  readonly portFor: (name: string) => number | undefined;
  /** Resolve a shared-tier named port; `undefined` when the stack has no shared services. */
  readonly sharedPortFor: (name: string) => number | undefined;
}

/**
 * Allocate this worktree's port block — and, if the stack declares shared
 * services, the shared block — under one read-modify-write of the registry
 * lock, then build the named-port → number resolvers from the resulting
 * offsets. Both `runUp` and `runGenerate` need the same allocation pass; the
 * only thing they do differently is what they do with the resolved ports
 * afterwards.
 */
async function allocateAndBuildPortMaps(args: {
  readonly anchor: string;
  readonly worktreeId: string;
  readonly stack: ResolvedStack;
  readonly options: AllocatorOptions;
  readonly lock: WithRegistryLock;
  readonly isPortFree: (port: number) => boolean | Promise<boolean>;
}): Promise<AllocatedPortMaps> {
  const { anchor, worktreeId, stack, options, lock, isPortFree } = args;
  const sharedNeeded = hasTier(stack, "shared");

  let blockBase = -1;
  let sharedBase: number | undefined;
  await lock(anchor, async (snapshot) => {
    let next = snapshot;
    const block = await allocateBlock(worktreeId, next, options, isPortFree);
    blockBase = block.base;
    if (next[worktreeId] === undefined) {
      next = { ...next, [worktreeId]: block.base };
    }
    if (sharedNeeded) {
      const sblock = await allocateBlock(SHARED_REGISTRY_KEY, next, options, isPortFree);
      sharedBase = sblock.base;
      if (next[SHARED_REGISTRY_KEY] === undefined) {
        next = { ...next, [SHARED_REGISTRY_KEY]: sblock.base };
      }
    }
    return next === snapshot ? snapshot : next;
  });

  const isolatedOffsets = buildOffsetMap(stack.services, "isolated", options.blockSize);
  const sharedOffsets = sharedNeeded
    ? buildOffsetMap(stack.services, "shared", options.blockSize)
    : new Map<string, number>();

  const portFor = (name: string): number | undefined => {
    const offset = isolatedOffsets.get(name);
    return offset === undefined ? undefined : blockBase + offset;
  };
  const sharedPortFor = (name: string): number | undefined => {
    if (sharedBase === undefined) return undefined;
    const offset = sharedOffsets.get(name);
    return offset === undefined ? undefined : sharedBase + offset;
  };

  return sharedBase === undefined
    ? { blockBase, portFor, sharedPortFor }
    : { blockBase, sharedBase, portFor, sharedPortFor };
}

/**
 * Bring up this worktree's isolated stack, idempotently.
 *
 * Three branches (issue #31):
 *  - **First up** (socket absent): allocate ports, write derived config,
 *    `driver.up`, health-wait, persist the stack-hash, return envelope.
 *  - **Already up, unchanged config** (socket present, stored hash matches):
 *    noop — skip `driver.up`, skip registry write, just re-emit the state
 *    envelope an agent would see from a fresh `up`.
 *  - **Already up, drifted config** (socket present, stored hash differs):
 *    write the new derived config, call `driver.reloadConfig`. On success,
 *    update the stored hash and return the new envelope; on failure
 *    (`not_supported` or otherwise), throw `ConfigDriftError` (code
 *    `CONFIG_DRIFT`) and leave the instance running unchanged.
 */
export async function runUp(deps: CommandDeps = {}): Promise<UpResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const sharedLock = deps.withSharedLock ?? defaultWithSharedLock;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  const warn = deps.warn ?? defaultWarn;
  const readHash = deps.readStoredHash ?? defaultReadStoredHash;
  const writeHash = deps.writeStoredHash ?? defaultWriteStoredHash;

  const stack = readStack(anchor.worktreeRoot);
  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);
  const sharedNeeded = hasTier(stack, "shared");

  // Lock-guarded read-modify-write: allocate (or look up) both the worktree's
  // own block and — if the stack has shared services — the repo-wide shared
  // block under the same lock. Two concurrent `up`s on different worktrees
  // therefore cannot race to the same block, and the shared block stays
  // consistent regardless of which worktree got there first (acceptance:
  // "shared instance appears in the allocation registry as an anchor-keyed
  // entry with its own block", PRD US-32).
  const { blockBase, portFor, sharedPortFor } = await allocateAndBuildPortMaps({
    anchor: anchor.anchor,
    worktreeId: anchor.worktreeId,
    stack,
    options,
    lock,
    isPortFree,
  });

  const derived = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    portFor,
    sharedPortFor,
  });

  // Warn for any port literal in a service command that is outside this
  // worktree's block — a hardcoded number devtrees did not allocate (PRD US-24).
  for (const warning of findUnmanagedPortBinds(stack, blockBase, options.blockSize)) {
    warn(warning);
  }

  // Surface every cross-tier `depends_on` edge devtrees just dropped. Silent
  // dropping would make the orchestration-layer wiring a mystery (ADR-0003
  // "Consequences").
  for (const edge of derived.droppedEdges) {
    warn(formatDroppedEdgeWarning(edge));
  }

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  const driver = createDriver(deps.driver);
  const inst = { configPath: paths.configPath, socketPath: paths.socketPath };

  // Idempotency branch (issue #31): if this worktree's control socket is
  // already present, the instance is up. Compare the current resolved-stack
  // hash to the one stored from the previous successful `up`:
  //   - match  -> noop, re-emit the envelope (no driver.up, no registry write)
  //   - drift  -> attempt hot-reload via the driver; map failure to CONFIG_DRIFT.
  if (existsSync(paths.socketPath)) {
    return await reconcileRunning({
      stack,
      anchor,
      paths,
      blockBase,
      portFor,
      derived,
      inst,
      driver,
      readHash,
      writeHash,
      deps,
    });
  }

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");

  // Lazy-start the shared instance if any shared services are declared. The
  // start is gated by `withSharedLock` and an idempotent socket-presence check
  // so two simultaneous `up`s never double-start it (acceptance).
  let sharedStarted = false;
  if (sharedNeeded) {
    sharedStarted = await ensureSharedStarted(anchor.anchor, stack, sharedPortFor, sharedLock, {
      driver,
    });
  }

  // Shared-health wait: gate the worktree start on the shared services'
  // readiness probes whenever this worktree drops a cross-tier `depends_on`
  // edge — orchestration-layer stand-in for the edge process-compose can't
  // express across instances (ADR-0003). Skipped when there are no such edges
  // (a stack with shared services nobody isolated depends on doesn't need it).
  if (derived.droppedEdges.length > 0) {
    const sharedPaths = sharedInstancePaths(anchor.anchor);
    const sharedNames = stack.services.filter((s) => s.tier === "shared").map((s) => s.name);
    warn(formatHealthWaitNotice(sharedNames));
    const wait = deps.waitForSharedHealth ?? defaultWaitForSharedHealth;
    await wait({
      anchor: anchor.anchor,
      socketPath: sharedPaths.socketPath,
      sharedServiceNames: sharedNames,
    });
  }

  await driver.up(inst);

  await waitForWorktreeHealth(stack, paths.socketPath, deps);

  // After the health-wait, snapshot the per-service runtime rows so the
  // issue-#30 `up --json` envelope can publish them without a follow-up
  // `ls --json`. Best-effort: a driver-side hiccup here must not turn the
  // healthy worktree into a failed `up` (same containment rule `ls --json`
  // applies, issue #29).
  const services = await collectIsolatedServices(stack, paths.socketPath, portFor, deps, driver);

  // First-up bookkeeping: remember the resolved-stack hash so a subsequent
  // `up` can branch on noop vs. drift (issue #31).
  writeHash(anchor.anchor, anchor.worktreeId, stackHash(stack));

  if (shouldAttachAfterUp(deps)) await driver.attach(inst);

  return {
    worktreeId: anchor.worktreeId,
    socketPath: paths.socketPath,
    env: derived.env,
    sharedStarted,
    blockBase,
    services,
  };
}

/**
 * Read this worktree instance's per-service runtime state and zip it with the
 * named-port allocations devtrees injected at derivation time. Returns the
 * same `Service` rows `discoverInstances` produces — that's the slice-#29
 * shape `up --json` reuses.
 *
 * Best-effort: a driver-side hiccup (process-compose has gone away between
 * the health-wait and now, a permission glitch on the UDS, …) yields an
 * empty array rather than throwing — the worktree itself is healthy at this
 * point, and an agent reading the envelope can still see the port block and
 * env, just without per-service rows.
 */
async function collectIsolatedServices(
  stack: ResolvedStack,
  socketPath: string,
  portFor: (name: string) => number | undefined,
  deps: CommandDeps,
  driver: ReturnType<typeof createDriver>,
): Promise<Service[]> {
  const fetch = deps.getServiceStatuses ?? ((s: string) => driver.getServiceStatuses(s));
  let statuses: ServiceStatus[];
  try {
    statuses = await fetch(socketPath);
  } catch {
    return [];
  }
  const portsByService = new Map<string, Record<string, number>>();
  for (const svc of stack.services) {
    if (svc.tier !== "isolated") continue;
    const portMap: Record<string, number> = {};
    for (const name of svc.ports) {
      const port = portFor(name);
      if (port !== undefined) portMap[name] = port;
    }
    portsByService.set(svc.name, portMap);
  }
  return statuses.map((s) => ({
    name: s.name,
    status: s.status,
    health: s.health,
    ports: portsByService.get(s.name) ?? {},
  }));
}

/**
 * Emit the derived process-compose config(s) to disk without starting anything.
 * Allocates port blocks the same way `runUp` does — so the emitted files reflect
 * the very ports `up` would use — but does not spawn `process-compose` and does
 * not lazy-start the shared instance. Useful for debugging or for running with
 * raw `process-compose -f <derived>.yaml` (acceptance, #10).
 *
 * The worktree-isolated subset is always written. The shared subset is written
 * only when the stack declares shared services.
 */
export async function runGenerate(deps: CommandDeps = {}): Promise<GenerateResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;

  const stack = readStack(anchor.worktreeRoot);
  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);
  const sharedNeeded = hasTier(stack, "shared");

  const { portFor, sharedPortFor } = await allocateAndBuildPortMaps({
    anchor: anchor.anchor,
    worktreeId: anchor.worktreeId,
    stack,
    options,
    lock,
    isPortFree,
  });

  const derivedWt = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    portFor,
    sharedPortFor,
  });

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.configPath, stringifyYaml(derivedWt.config), "utf8");

  if (sharedNeeded) {
    const derivedShared = deriveSharedConfig(stack, {
      workingDir: anchor.anchor,
      portFor: sharedPortFor,
    });
    const sharedPaths = sharedInstancePaths(anchor.anchor);
    writeFileSync(sharedPaths.configPath, stringifyYaml(derivedShared.config), "utf8");
    return {
      worktreeId: anchor.worktreeId,
      worktreeRoot: anchor.worktreeRoot,
      worktreePath: paths.configPath,
      sharedPath: sharedPaths.configPath,
      env: derivedWt.env,
      sharedEnv: derivedShared.env,
    };
  }

  return {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    worktreePath: paths.configPath,
    env: derivedWt.env,
  };
}

/**
 * Options for `runAttach`. Default is to attach this worktree's instance;
 * `{ shared: true }` attaches the shared instance instead.
 */
export interface AttachOptions {
  readonly shared?: boolean;
}

/**
 * Attach a TUI to a running instance — this worktree's by default, or the
 * shared one with `{ shared: true }`. The instance is identified by its
 * control socket under the anchor (CONTEXT.md "Control socket"); if that
 * socket is absent the instance is not running and we throw a clear error
 * instead of letting `process-compose attach` fail with a noisy stack
 * (acceptance, #11).
 *
 * No allocation, no spawn of `up`-style detached processes — we run the
 * driver's `attach` foreground so the TUI inherits the user's terminal,
 * then return when the user detaches and the child exits.
 */
export async function runAttach(
  deps: CommandDeps = {},
  options: AttachOptions = {},
): Promise<void> {
  const { anchor } = resolve(deps);
  const driver = createDriver(deps.driver);

  if (options.shared) {
    const paths = sharedInstancePaths(anchor.anchor);
    if (!existsSync(paths.socketPath)) {
      throw new Error(
        "no shared instance is running. Bring it up implicitly via `devtrees up` " +
          "(when the stack declares shared services) before attaching.",
      );
    }
    await driver.attach({ configPath: paths.configPath, socketPath: paths.socketPath });
    return;
  }

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  if (!existsSync(paths.socketPath)) {
    throw new Error(
      `no worktree instance is running for '${anchor.worktreeId}'. ` +
        `Run \`devtrees up\` to bring it up first.`,
    );
  }
  await driver.attach({ configPath: paths.configPath, socketPath: paths.socketPath });
}

/**
 * Idempotently lazy-start the shared instance: under the shared lifecycle lock,
 * if its control socket is already present do nothing; otherwise write a fresh
 * derived shared config and spawn `process-compose` against it. The lock is the
 * gate — two simultaneous callers see a consistent answer and at most one
 * actually starts the instance.
 */
async function ensureSharedStarted(
  anchor: string,
  stack: ResolvedStack,
  sharedPortFor: (name: string) => number | undefined,
  sharedLock: WithSharedLock,
  deps: { driver: ReturnType<typeof createDriver> },
): Promise<boolean> {
  return await sharedLock(anchor, async () => {
    const paths = sharedInstancePaths(anchor);
    if (existsSync(paths.socketPath)) return false;

    const derived = deriveSharedConfig(stack, {
      workingDir: anchor,
      portFor: sharedPortFor,
    });

    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");

    await deps.driver.up({ configPath: paths.configPath, socketPath: paths.socketPath });
    return true;
  });
}

// A real port a service binds shows up in its command as `--port 3000` / `:3000` /
// `PORT=3000`; this matches 4–5 digit numbers after an option-like separator.
const PORT_LITERAL_RE = /(?:^|[:=\s])(\d{4,5})(?=\b)/g;
const MIN_USER_PORT = 1024;
const MAX_TCP_PORT = 65535;

/** All distinct user-port-range literals appearing in a command string. */
function extractPortLiterals(command: string): number[] {
  const seen = new Set<number>();
  for (const match of command.matchAll(PORT_LITERAL_RE)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    const n = Number(candidate);
    if (n >= MIN_USER_PORT && n <= MAX_TCP_PORT) seen.add(n);
  }
  return [...seen];
}

function formatUnmanagedPortWarning(
  serviceName: string,
  port: number,
  blockBase: number,
  blockEnd: number,
): string {
  return (
    `devtrees: service '${serviceName}' command appears to bind port ${port}, ` +
    `which is outside this worktree's allocated block [${blockBase}, ${blockEnd - 1}]. ` +
    `Devtrees did not allocate it — declare it as a named port (e.g. ports: [WEB_PORT]) ` +
    `and reference it as \${WEB_PORT} instead.`
  );
}

/**
 * Heuristic static scan for hardcoded port literals in isolated-service commands
 * that fall outside the worktree's allocated block. If the number is in TCP
 * user-port range (1024–65535) and not inside this worktree's block, devtrees
 * did not manage it (CONTEXT.md "Port block", PRD US-24).
 *
 * Exported for unit tests; the warning emission itself is exercised through
 * `runUp` so callers see a black-box behaviour.
 */
export function findUnmanagedPortBinds(
  stack: ResolvedStack,
  blockBase: number,
  blockSize: number,
): string[] {
  const blockEnd = blockBase + blockSize;
  const isInBlock = (n: number): boolean => n >= blockBase && n < blockEnd;
  return stack.services
    .filter((s) => s.tier === "isolated")
    .flatMap((service) =>
      extractPortLiterals(service.command)
        .filter((n) => !isInBlock(n))
        .map((n) => formatUnmanagedPortWarning(service.name, n, blockBase, blockEnd)),
    );
}

/**
 * Result of `runDown` — the prior state of the instance that was stopped, so
 * `devtrees down --json` (issue #34) can publish a record of what was torn
 * down in the same shape `up --json` (slice #30) emits on success.
 *
 * `worktreeId` and `blockBase` are optional: shared teardown has no
 * worktree, and an already-stopped instance with no registry entry yields no
 * `blockBase` to report.
 */
export interface DownResult {
  /** True iff the teardown targeted the shared instance (`{shared: true}`). */
  readonly shared: boolean;
  /** Id of the stopped worktree instance. Absent for shared teardown. */
  readonly worktreeId?: string;
  /**
   * Block base recovered from the registry snapshot at teardown time. Absent
   * when no entry existed (e.g. a tidy no-op `down --shared` against an
   * already-stopped instance).
   */
  readonly blockBase?: number;
  /**
   * The injected-value map the instance was running with — same shape `up`
   * returns. For a worktree teardown: own ports + shared ports + worktree id.
   * For a shared teardown: the shared services' named ports.
   */
  readonly env: Record<string, string>;
  /**
   * Per-service runtime rows snapshotted via `driver.getServiceStatuses`
   * *before* the teardown (the socket is dead afterwards). Same shape `ls
   * --json` (slice #29) publishes. Degrades to `[]` on a fetch error or when
   * the instance was already stopped (no socket to query).
   */
  readonly services: ReadonlyArray<Service>;
}

/**
 * Stop this worktree's instance (default) or — with `{ shared: true }` — the
 * shared instance, and return the prior state of what was torn down.
 *
 * The two lifecycles are decoupled (ADR-0001): worktree `down` never touches
 * shared, so other worktrees keep their connections. Shared teardown is gated
 * by the shared lifecycle lock and idempotent: if the shared instance is not
 * running, the call is a no-op and the registry entry is still cleared so a
 * subsequent `up` can re-lazy-start it.
 *
 * The prior-state snapshot is taken before `driver.down` — once the socket is
 * gone, `getServiceStatuses` has nothing to talk to — and is best-effort: a
 * stack-read or driver hiccup degrades the relevant field rather than
 * aborting the teardown (issue #34 acceptance).
 */
export async function runDown(
  deps: CommandDeps = {},
  options: DownOptions = {},
): Promise<DownResult> {
  const { anchor } = resolve(deps);
  const driver = createDriver(deps.driver);
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  const readReg = deps.readRegistry ?? readRegistry;
  const fetchStatuses =
    deps.getServiceStatuses ?? ((socketPath: string) => driver.getServiceStatuses(socketPath));

  // Compute the would-be env + block bases against the persisted registry
  // (the same lock-free read `runEnv` uses, #32). Stack-read errors degrade
  // to an empty envelope so a missing devtrees.yaml still tears down whatever
  // is running.
  const priorState = readPriorState(deps, anchor, readReg, isPortFree);

  if (options.shared) {
    const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
    const sharedLock = deps.withSharedLock ?? defaultWithSharedLock;
    const paths = sharedInstancePaths(anchor.anchor);

    // Snapshot services concurrently with the teardown — the status fetch
    // talks to the live socket while `process-compose down` is in-flight,
    // so the prior-state envelope doesn't add serial latency to `down`. If
    // the fetch races past the socket teardown it degrades to [] (same rule
    // a flaky driver call follows).
    const servicesPromise = existsSync(paths.socketPath)
      ? collectServicesForTier(priorState.stack, paths.socketPath, "shared", fetchStatuses, (n) =>
          priorState.sharedPortFor(n),
        )
      : Promise.resolve<Service[]>([]);

    await sharedLock(anchor.anchor, async () => {
      if (existsSync(paths.socketPath)) {
        await driver.down({ configPath: paths.configPath, socketPath: paths.socketPath });
      }
      // Best-effort cleanup of the derived config — a future `up` re-derives it.
      rmSync(paths.configPath, { force: true });
    });

    // Drop the shared entry from the registry so a future `up` re-allocates
    // (or, far more likely, re-uses the same block; the entry is removed for
    // tidiness and so `ls` reflects that the shared instance is down).
    await lock(anchor.anchor, (snapshot) => {
      if (snapshot[SHARED_REGISTRY_KEY] === undefined) return snapshot;
      const { [SHARED_REGISTRY_KEY]: _drop, ...rest } = snapshot;
      void _drop;
      return rest;
    });

    const services = await servicesPromise;
    return {
      shared: true,
      ...(priorState.sharedBase !== undefined ? { blockBase: priorState.sharedBase } : {}),
      env: priorState.sharedEnv,
      services,
    };
  }

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  const servicesPromise = existsSync(paths.socketPath)
    ? collectServicesForTier(priorState.stack, paths.socketPath, "isolated", fetchStatuses, (n) =>
        priorState.portFor(n),
      )
    : Promise.resolve<Service[]>([]);

  await driver.down({ configPath: paths.configPath, socketPath: paths.socketPath });
  const services = await servicesPromise;

  return {
    shared: false,
    worktreeId: anchor.worktreeId,
    ...(priorState.blockBase !== undefined ? { blockBase: priorState.blockBase } : {}),
    env: priorState.env,
    services,
  };
}

/**
 * Prior-state derivation for `runDown` — pure read of the persisted registry
 * (same lock-free path `runEnv` uses, #32) re-derives the worktree and shared
 * env maps so the `down --json` envelope can publish them without touching
 * the running stack. Returns `undefined`-marked fields for the things that
 * weren't available (no stack on disk, no registry entry).
 */
interface PriorState {
  readonly stack: ResolvedStack | undefined;
  readonly blockBase: number | undefined;
  readonly sharedBase: number | undefined;
  readonly env: Record<string, string>;
  readonly sharedEnv: Record<string, string>;
  readonly portFor: (name: string) => number | undefined;
  readonly sharedPortFor: (name: string) => number | undefined;
}

function readPriorState(
  deps: CommandDeps,
  anchor: { anchor: string; worktreeId: string; worktreeRoot: string },
  readReg: (anchor: string) => RegistrySnapshot,
  isPortFree: (port: number) => boolean | Promise<boolean>,
): PriorState {
  const readStack = deps.readStack ?? loadStack;
  const noop = () => undefined;
  let stack: ResolvedStack | undefined;
  try {
    stack = readStack(anchor.worktreeRoot);
  } catch {
    // No usable stack — return a minimal envelope shape rather than aborting
    // the teardown. The agent still gets `shared` + (maybe) `block_base`.
    return {
      stack: undefined,
      blockBase: undefined,
      sharedBase: undefined,
      env: {},
      sharedEnv: {},
      portFor: noop,
      sharedPortFor: noop,
    };
  }

  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);
  const sharedNeeded = hasTier(stack, "shared");
  const snapshot = readReg(anchor.anchor);

  // Use the persisted registry entry verbatim when it exists — that is what
  // the instance was actually allocated against. Fall back to the allocator's
  // deterministic answer for the rare "no entry but want a guess" case (e.g.
  // a tidy no-op shared down) so the envelope still carries *some* block_base
  // candidate where possible.
  const blockBase = snapshot[anchor.worktreeId];
  const sharedBase = sharedNeeded ? snapshot[SHARED_REGISTRY_KEY] : undefined;

  const isolatedOffsets = buildOffsetMap(stack.services, "isolated", options.blockSize);
  const sharedOffsets = sharedNeeded
    ? buildOffsetMap(stack.services, "shared", options.blockSize)
    : new Map<string, number>();

  const portFor = (name: string): number | undefined => {
    if (blockBase === undefined) return undefined;
    const offset = isolatedOffsets.get(name);
    return offset === undefined ? undefined : blockBase + offset;
  };
  const sharedPortFor = (name: string): number | undefined => {
    if (sharedBase === undefined) return undefined;
    const offset = sharedOffsets.get(name);
    return offset === undefined ? undefined : sharedBase + offset;
  };
  void isPortFree; // unused: we read the registry verbatim instead of re-probing.

  const derived = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    portFor,
    sharedPortFor,
  });
  const sharedDerived = sharedNeeded
    ? deriveSharedConfig(stack, { workingDir: anchor.anchor, portFor: sharedPortFor })
    : { env: {} as Record<string, string> };

  return {
    stack,
    blockBase,
    sharedBase,
    env: derived.env,
    sharedEnv: sharedDerived.env,
    portFor,
    sharedPortFor,
  };
}

/**
 * Cap how long `runDown` waits on `getServiceStatuses` before giving up and
 * publishing `services: []`. The teardown itself isn't blocked by this — the
 * snapshot is best-effort (issue #34) and we'd rather a partial envelope than
 * a stalled `down` if process-compose is slow to answer over the UDS.
 */
const DOWN_SERVICES_SNAPSHOT_TIMEOUT_MS = 1_500;

/**
 * Snapshot per-service runtime state for one tier's services, zipped with the
 * named-port allocations devtrees would have injected at derivation time. Same
 * primitive `up --json` (#30) and `ls --json` (#29) use; degrades to `[]` on a
 * driver hiccup, a missing stack, *or* a slow probe — `runDown` must not wait
 * indefinitely on a flaky `process list` when the operator asked for a
 * teardown.
 */
async function collectServicesForTier(
  stack: ResolvedStack | undefined,
  socketPath: string,
  tier: "isolated" | "shared",
  fetchStatuses: (socketPath: string) => Promise<ServiceStatus[]>,
  portFor: (name: string) => number | undefined,
): Promise<Service[]> {
  if (stack === undefined) return [];
  let statuses: ServiceStatus[];
  try {
    statuses = await Promise.race<ServiceStatus[]>([
      fetchStatuses(socketPath),
      new Promise<ServiceStatus[]>((_, reject) =>
        setTimeout(
          () => reject(new Error("getServiceStatuses snapshot timed out")),
          DOWN_SERVICES_SNAPSHOT_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
  } catch {
    return [];
  }
  const portsByService = new Map<string, Record<string, number>>();
  for (const svc of stack.services) {
    if (svc.tier !== tier) continue;
    const portMap: Record<string, number> = {};
    for (const name of svc.ports) {
      const port = portFor(name);
      if (port !== undefined) portMap[name] = port;
    }
    portsByService.set(svc.name, portMap);
  }
  return statuses.map((s) => ({
    name: s.name,
    status: s.status,
    health: s.health,
    ports: portsByService.get(s.name) ?? {},
  }));
}

/** Inputs unique to `runLs` — same anchor resolution as the other commands. */
export interface LsDeps {
  /** Working directory to resolve the anchor from. Default: process.cwd(). */
  readonly cwd?: string;
  /** Inject git. Default: runs the real `git` in `cwd`. */
  readonly git?: GitProbe;
  /**
   * Discover instances at the anchor. Default: real socket enumeration via
   * `discoverInstances`. Injected so the command can be unit-tested without
   * touching `<anchor>/devtrees/run/`.
   */
  readonly discover?: (
    anchor: string,
    deps: { getServiceStatuses?: (socketPath: string) => Promise<ServiceStatus[]> },
  ) => Promise<InstanceInfo[]>;
  /**
   * Process-compose driver — used (best-effort) to populate each running
   * instance's `services[]` with live runtime state. Defaults to the real
   * driver so `ls --json` answers "is `worker` healthy?" out of the box;
   * tests stub it.
   */
  readonly driver?: DriverDeps;
}

export interface LsResult {
  /** The anchor instances were discovered from — useful for human-readable output. */
  readonly anchor: string;
  readonly instances: ReadonlyArray<InstanceInfo>;
}

/**
 * List every devtrees instance across the repo. Resolves the anchor from `cwd`
 * the same way `up`/`down` do, then defers to the discovery primitive — no
 * domain logic here, just wiring. The result is structured (not pre-formatted)
 * so the CLI shell, JSON output, and future callers (e.g. #9 prune) can
 * consume the same data.
 *
 * `ls` stays lock-free: discovery never writes the allocation registry, and
 * the driver's `getServiceStatuses` call talks to each instance's UDS only —
 * a stale or failing instance does not abort the walk.
 */
export async function runLs(deps: LsDeps = {}): Promise<LsResult> {
  const { anchor } = resolve(deps);
  const discover = deps.discover ?? discoverInstances;
  const driver = createDriver(deps.driver ?? {});
  const instances = await discover(anchor.anchor, {
    getServiceStatuses: (socketPath) => driver.getServiceStatuses(socketPath),
  });
  return { anchor: anchor.anchor, instances };
}

/** Inputs unique to `runPrune` — same anchor resolution as the other commands. */
export interface PruneDeps {
  /** Working directory to resolve the anchor from. Default: process.cwd(). */
  readonly cwd?: string;
  /**
   * Inject git. Default: runs the real `git` in `cwd`. Prune additionally
   * calls `git worktree list --porcelain` to enumerate live worktrees —
   * devtrees does not manage git, so this is the authoritative liveness
   * signal (#9 acceptance).
   */
  readonly git?: GitProbe;
  /**
   * Discover instances at the anchor. Default: real socket enumeration via
   * `discoverInstances`. Injected so the command can be unit-tested without
   * touching `<anchor>/devtrees/run/`.
   */
  readonly discover?: (anchor: string) => Promise<InstanceInfo[]>;
  /**
   * Driver for invoking `process-compose down` on a running orphan. Default:
   * real shell-out. Injected so tests can assert on the spawn surface
   * without launching `process-compose`.
   */
  readonly driver?: DriverDeps;
  /**
   * Acquire the allocation-registry lock to delete each orphan's entry under
   * the same read-modify-write semantics `up`/`down` use. Default: real lock
   * under the anchor.
   */
  readonly withRegistryLock?: WithRegistryLock;
}

export interface PruneResult {
  readonly anchor: string;
  /** The orphans that were stopped + cleaned. Source order from discovery. */
  readonly pruned: ReadonlyArray<InstanceInfo>;
}

/**
 * Reconcile devtrees' notion of running instances against `git worktree list`
 * and reclaim any orphan state.
 *
 * Devtrees does not manage git worktrees (CONTEXT.md "Devtrees"); when a
 * developer runs `git worktree remove` while the stack is still up, the
 * instance's anchor state survives unnoticed. `runPrune` walks the discovered
 * instances, treats any worktree-kind instance whose worktree dir is no
 * longer in `git worktree list` as an orphan, and cleans it up:
 *
 *   1. If the orphan is still running, ask the driver to stop it. Errors are
 *      swallowed — the whole point of prune is to reclaim stale state, and a
 *      `process-compose down` against a half-dead socket must not abort the
 *      sweep over other orphans.
 *   2. Remove the orphan's control socket and derived config from the anchor
 *      state.
 *   3. Drop the orphan's allocation-registry entry under the registry lock.
 *
 * The shared instance is never an orphan: it is anchored at the git common
 * dir, not at any single worktree, and its lifecycle is decoupled from any
 * worktree's `down` (ADR-0001). Tear it down explicitly with `down --shared`.
 */
export async function runPrune(deps: PruneDeps = {}): Promise<PruneResult> {
  const cwd = deps.cwd ?? process.cwd();
  const git = deps.git ?? defaultGit(cwd);
  const anchor = resolveAnchor(cwd, git);
  const discover = deps.discover ?? discoverInstances;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const driver = createDriver(deps.driver);

  const instances = await discover(anchor.anchor);
  const porcelain = git(["worktree", "list", "--porcelain"]);
  const liveIds = parseWorktreeIds(porcelain);
  const orphans = findOrphans(instances, liveIds);
  if (orphans.length === 0) return { anchor: anchor.anchor, pruned: [] };

  for (const orphan of orphans) {
    const paths = instancePaths(anchor.anchor, orphan.id);
    if (orphan.status === "running") {
      try {
        await driver.down({
          configPath: paths.configPath,
          socketPath: paths.socketPath,
        });
      } catch {
        // Best-effort: a failed down still leaves us removing the on-disk
        // state below, which is the whole point of prune.
      }
    }
    // Remove the socket file (driver.down typically removes it on a clean
    // exit, but stale/failed orphans need explicit cleanup).
    rmSync(paths.socketPath, { force: true });
    // Remove the derived config — a future `up` re-derives it.
    rmSync(paths.configPath, { force: true });
  }

  // Drop every orphan's registry entry under one lock acquire so concurrent
  // `up`s can re-use the freed block bases.
  await lock(anchor.anchor, (snapshot) => {
    let next = snapshot;
    let changed = false;
    for (const orphan of orphans) {
      if (next[orphan.id] !== undefined) {
        const { [orphan.id]: _drop, ...rest } = next;
        void _drop;
        next = rest;
        changed = true;
      }
    }
    return changed ? next : snapshot;
  });

  return { anchor: anchor.anchor, pruned: orphans };
}

export interface EnvResult {
  readonly worktreeId: string;
  /**
   * The injected-value map the worktree instance would receive — same shape
   * `runUp` and `runGenerate` produce. Computed without spawning, locking, or
   * persisting (issue #32 "Pure read").
   */
  readonly env: Record<string, string>;
}

/**
 * Emit the injected-value map for this worktree without starting anything,
 * without acquiring the allocation-registry lock, and without writing.
 *
 * The map is exactly what the config deriver would inject (CONTEXT.md
 * "Injected value"): this worktree's named ports + the shared services' named
 * ports + the worktree id. The registry is read directly (no lock). When the
 * worktree (or shared) entry is absent, the allocator's deterministic
 * hash-and-probe yields the "would-be" block against the read snapshot — the
 * same answer a follow-up `up` would persist, barring a concurrent allocation
 * (the racy edge case the spec explicitly accepts).
 */
export async function runEnv(deps: CommandDeps = {}): Promise<EnvResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  const readReg = deps.readRegistry ?? readRegistry;

  const stack = readStack(anchor.worktreeRoot);
  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);
  const sharedNeeded = hasTier(stack, "shared");

  // Pure read — no lock. If the registry has no entry for this worktree (or
  // shared), `allocateBlock` returns what a future `up` would pick against
  // this snapshot. No write happens here.
  const snapshot = readReg(anchor.anchor);
  const block = await allocateBlock(anchor.worktreeId, snapshot, options, isPortFree);
  const sharedBlock = sharedNeeded
    ? await allocateBlock(SHARED_REGISTRY_KEY, snapshot, options, isPortFree)
    : undefined;

  const isolatedOffsets = buildOffsetMap(stack.services, "isolated", options.blockSize);
  const sharedOffsets = sharedNeeded
    ? buildOffsetMap(stack.services, "shared", options.blockSize)
    : new Map<string, number>();

  const portFor = (name: string): number | undefined => {
    const offset = isolatedOffsets.get(name);
    return offset === undefined ? undefined : block.base + offset;
  };
  const sharedPortFor = (name: string): number | undefined => {
    if (sharedBlock === undefined) return undefined;
    const offset = sharedOffsets.get(name);
    return offset === undefined ? undefined : sharedBlock.base + offset;
  };

  const derived = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    portFor,
    sharedPortFor,
  });

  return { worktreeId: anchor.worktreeId, env: derived.env };
}

/**
 * Options governing a `devtrees logs` call. The single-service form passes
 * `service`; `--all` (interleave every service in the instance) sets `all`.
 * `--shared` flips socket selection from the worktree instance to the shared
 * one. `follow`, `tail`, and `since` thread straight through to the driver.
 */
export interface LogsOptions {
  /** Name of one service to stream. Mutually exclusive with `all`. */
  readonly service?: string;
  /** Interleave every service in the target instance. Reads the derived config to enumerate. */
  readonly all?: boolean;
  /** Read the shared instance's socket instead of the worktree's. */
  readonly shared?: boolean;
  /** Keep streaming after the historical buffer drains. */
  readonly follow?: boolean;
  /** Start from the last N lines. */
  readonly tail?: number;
  /**
   * Start from the given duration ago (e.g. "5m"). Currently accepted but not
   * passed through to process-compose — its `process logs` CLI does not yet
   * expose a `--since` flag, so the option is recorded for forward compatibility
   * and surfaced in the driver's `LogEvent` ts (the agent can filter client-side).
   */
  readonly since?: string;
}

export interface LogsResult {
  /** Services this call is streaming. One entry for the single-service form; many for `--all`. */
  readonly services: ReadonlyArray<string>;
  /** Merged log stream. Iterating consumes the spawn(s); cancelling the iterator kills the children. */
  readonly events: AsyncIterable<LogEvent>;
}

/**
 * Stream a service's logs from a running instance without taking any lock.
 *
 * Socket selection — `options.shared` flips between this worktree's control
 * socket and the shared instance's. If the target socket is missing, the
 * instance is not running and we throw a clear error here that `classifyError`
 * maps to the `INSTANCE_NOT_FOUND` envelope (ADR-0005). The lock-free path
 * (acceptance, #33) is what lets concurrent agents tail sibling worktrees
 * without serializing on a shared mutex.
 *
 * `--all` enumerates services from the derived config on disk — the same file
 * `devtrees up` writes — so we don't need a process-compose round-trip to list
 * processes. One driver `streamLogs` call per service; their outputs are
 * merged into a single async iterable.
 */
export async function runLogs(
  deps: CommandDeps = {},
  options: LogsOptions = {},
): Promise<LogsResult> {
  const { anchor } = resolve(deps);
  const paths = options.shared
    ? sharedInstancePaths(anchor.anchor)
    : instancePaths(anchor.anchor, anchor.worktreeId);

  if (!existsSync(paths.socketPath)) {
    if (options.shared) {
      throw new Error(
        "no shared instance is running. Bring it up implicitly via `devtrees up` " +
          "(when the stack declares shared services) before tailing its logs.",
      );
    }
    throw new Error(
      `no worktree instance is running for '${anchor.worktreeId}'. ` +
        "Run `devtrees up` to bring it up first.",
    );
  }

  const services = options.all
    ? readDerivedServices(paths.configPath)
    : options.service !== undefined
      ? [options.service]
      : [];
  if (services.length === 0) {
    throw new Error("devtrees logs: specify a service (e.g. `devtrees logs web`) or pass `--all`.");
  }

  const driver = createDriver(deps.driver);
  const streams = services.map((service) => {
    const driverOpts: StreamLogsOptions = {
      service,
      follow: options.follow,
      tail: options.tail,
    };
    return driver.streamLogs(paths.socketPath, driverOpts);
  });

  return { services, events: mergeAsyncIterables(streams) };
}

/**
 * Read the derived process-compose config from disk and return its service
 * names in source order. Used by `--all` to know which services to spawn a
 * `process logs` subprocess for. The config is the same file `devtrees up`
 * writes, so the list is authoritative for the running instance.
 */
function readDerivedServices(configPath: string): string[] {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as { processes?: Record<string, unknown> } | null;
    if (parsed === null || typeof parsed !== "object") return [];
    return Object.keys(parsed.processes ?? {});
  } catch {
    // Treat any read/parse failure as "no services known"; the caller errors
    // with a usage hint via the empty-services check above.
    return [];
  }
}

/**
 * Merge N async iterables into one. Races each iterator's `next()` and yields
 * whichever event arrives first; finishes when every iterator is done. On
 * consumer break/throw, the `return()` calls cascade to each underlying
 * iterator so the spawned children are killed (the driver's `finally` block).
 */
async function* mergeAsyncIterables<T>(
  iterables: ReadonlyArray<AsyncIterable<T>>,
): AsyncIterable<T> {
  if (iterables.length === 0) return;
  if (iterables.length === 1) {
    const only = iterables[0];
    if (only === undefined) return;
    yield* only;
    return;
  }
  type Live = {
    it: AsyncIterator<T>;
    pending: Promise<{ live: Live; result: IteratorResult<T> }>;
  };
  const lives: Live[] = [];
  for (const iterable of iterables) {
    const it = iterable[Symbol.asyncIterator]();
    const slot: Live = { it, pending: Promise.resolve() as unknown as Live["pending"] };
    slot.pending = it.next().then((result) => ({ live: slot, result }));
    lives.push(slot);
  }

  try {
    while (lives.length > 0) {
      const { live, result } = await Promise.race(lives.map((l) => l.pending));
      if (result.done) {
        const idx = lives.indexOf(live);
        if (idx >= 0) lives.splice(idx, 1);
        continue;
      }
      yield result.value;
      live.pending = live.it.next().then((r) => ({ live, result: r }));
    }
  } finally {
    await Promise.allSettled(lives.map((l) => Promise.resolve(l.it.return?.(undefined))));
  }
}

/**
 * Idempotency / drift dispatch for a `runUp` whose worktree instance is
 * already running. Two outcomes:
 *
 *  - **Matching hash** -> noop: skip `driver.up` and the registry write, just
 *    re-collect per-service runtime rows and return the same envelope shape
 *    a fresh `up` would (issue-#30 contract).
 *  - **Drift** -> write the new derived config and call `driver.reloadConfig`.
 *    On success, persist the new hash and return the new envelope; on any
 *    failure, throw `ConfigDriftError` so the CLI emits the `CONFIG_DRIFT`
 *    envelope and the instance keeps running (ADR-0005).
 */
async function reconcileRunning(args: {
  readonly stack: ResolvedStack;
  readonly anchor: { readonly anchor: string; readonly worktreeId: string };
  readonly paths: {
    readonly runDir: string;
    readonly configPath: string;
    readonly socketPath: string;
  };
  readonly blockBase: number;
  readonly portFor: (name: string) => number | undefined;
  readonly derived: ReturnType<typeof deriveWorktreeConfig>;
  readonly inst: { readonly configPath: string; readonly socketPath: string };
  readonly driver: ReturnType<typeof createDriver>;
  readonly readHash: (anchor: string, id: string) => string | undefined;
  readonly writeHash: (anchor: string, id: string, hash: string) => void;
  readonly deps: CommandDeps;
}): Promise<UpResult> {
  const { stack, anchor, paths, blockBase, portFor, derived, inst, driver } = args;
  const currentHash = stackHash(stack);
  const storedHash = args.readHash(anchor.anchor, anchor.worktreeId);
  if (storedHash !== currentHash) {
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");
    const reload = await driver.reloadConfig(inst);
    if (!reload.ok) {
      throw new ConfigDriftError(
        `devtrees up: config drift detected for '${anchor.worktreeId}' and the running ` +
          `process-compose could not hot-reload the new config` +
          (reload.message ? ` (${reload.message})` : "") +
          ". The instance is still running — run `devtrees down && devtrees up` to apply the new config.",
      );
    }
    args.writeHash(anchor.anchor, anchor.worktreeId, currentHash);
  }
  const services = await collectIsolatedServices(
    stack,
    paths.socketPath,
    portFor,
    args.deps,
    driver,
  );
  return {
    worktreeId: anchor.worktreeId,
    socketPath: paths.socketPath,
    env: derived.env,
    sharedStarted: false,
    blockBase,
    services,
  };
}

// --- default I/O implementations -------------------------------------------

function defaultGit(cwd: string): GitProbe {
  return (args) => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const defaultWithRegistryLock: WithRegistryLock = (anchor, mutate) =>
  withRegistryLock(anchor, mutate);

const defaultWithSharedLock: WithSharedLock = (anchor, fn) => withSharedLock(anchor, fn);

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Both stdout AND stderr must be TTYs for the auto-detect to mean "a human at
 * a terminal is watching". If either is redirected (a pipe, a CI log capture,
 * an agent's pty wrapper that only inherits stdout), we skip the TUI so the
 * caller gets the headless behaviour they implicitly asked for (ADR-0005).
 */
function defaultIsTTY(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

/**
 * Worktree-instance health gate: poll until every isolated service reports a
 * healthy state, or throw `HealthTimeoutError` (code: HEALTH_TIMEOUT) so the
 * caller exits non-zero. The stack is left running on failure — the explicit
 * ADR-0005 choice so the agent can inspect logs after the timeout.
 */
async function waitForWorktreeHealth(
  stack: ResolvedStack,
  socketPath: string,
  deps: CommandDeps,
): Promise<void> {
  const wait = deps.waitForHealth ?? defaultWaitForHealth;
  await wait({
    socketPath,
    serviceNames: stack.services.filter((s) => s.tier === "isolated").map((s) => s.name),
    timeoutMs: deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
  });
}

/** Explicit `attach`/`no-attach` override wins; otherwise consult `isTTY()`. */
function shouldAttachAfterUp(deps: CommandDeps): boolean {
  return deps.attach ?? (deps.isTTY ?? defaultIsTTY)();
}

/**
 * One human-readable line per dropped cross-tier edge. Tells the developer
 * which edge devtrees just lifted out of the derived config and why — the
 * orchestration layer is now responsible for the equivalent gating.
 */
function formatDroppedEdgeWarning(edge: DroppedEdge): string {
  return (
    `devtrees: dropped cross-tier depends_on '${edge.from}' (${edge.fromTier}) -> ` +
    `'${edge.to}' (${edge.toTier}). ` +
    `Process-compose cannot express a dependency across instances (ADR-0003); ` +
    `devtrees waits for shared services to be healthy before starting the worktree instance instead.`
  );
}

/** Single notice that the worktree start is gated on the shared-health wait. */
function formatHealthWaitNotice(sharedNames: ReadonlyArray<string>): string {
  return (
    `devtrees: waiting for shared services to be healthy ` +
    `[${sharedNames.join(", ")}] before starting this worktree's instance...`
  );
}

/**
 * Default shared-health wait: shells out to `process-compose process list`
 * over the shared instance's UDS and polls until every shared service reports
 * a healthy state ('Running'/'Ready'/'Completed') or the timeout expires.
 *
 * "Healthy enough to start a depender" = the process is up. Services with a
 * readiness probe report `Ready`; services without one report `Running`; one-shot
 * jobs may have already moved to `Completed` — all three are fine to depend on.
 * Anything else (`Pending`, `Restarting`, `Failed`) means we keep waiting.
 */
const SHARED_HEALTH_TIMEOUT_MS = 30_000;
const SHARED_HEALTH_POLL_MS = 200;
const HEALTHY_STATES = new Set(["running", "ready", "completed"]);

const defaultWaitForSharedHealth: WaitForSharedHealth = async ({
  socketPath,
  sharedServiceNames,
}) => {
  if (sharedServiceNames.length === 0) return;
  const deadline = Date.now() + SHARED_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const states = readProcessStates(socketPath);
    if (states !== undefined) {
      const allHealthy = sharedServiceNames.every((name) => {
        const status = states.get(name)?.toLowerCase();
        return status !== undefined && HEALTHY_STATES.has(status);
      });
      if (allHealthy) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SHARED_HEALTH_POLL_MS));
  }
  throw new Error(
    `timed out waiting for shared services to be healthy [${sharedServiceNames.join(", ")}] ` +
      `after ${SHARED_HEALTH_TIMEOUT_MS}ms. Check the shared instance's logs (\`devtrees attach --shared\`).`,
  );
};

/**
 * Default worktree health-wait: same poll loop as the shared variant — the
 * mechanics are identical (poll `process-compose process list` over the
 * instance's UDS until every named service reports a healthy state) and only
 * the socket path, service set, and timeout differ. On timeout, throws
 * `HealthTimeoutError` so the CLI maps it to the documented `HEALTH_TIMEOUT`
 * envelope without pattern-matching on the message (ADR-0005).
 *
 * A zero-service wait returns immediately so a stack with no isolated services
 * does not synthesize a timeout out of thin air.
 */
const defaultWaitForHealth: WaitForHealth = async ({ socketPath, serviceNames, timeoutMs }) => {
  if (serviceNames.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = readProcessStates(socketPath);
    if (states !== undefined) {
      const allHealthy = serviceNames.every((name) => {
        const status = states.get(name)?.toLowerCase();
        return status !== undefined && HEALTHY_STATES.has(status);
      });
      if (allHealthy) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SHARED_HEALTH_POLL_MS));
  }
  throw new HealthTimeoutError(
    `timed out waiting for services to be healthy [${serviceNames.join(", ")}] ` +
      `after ${timeoutMs}ms. The worktree instance is still running — ` +
      `inspect it with \`devtrees logs <service>\` or \`devtrees ls --json\`.`,
  );
};

/**
 * Run `process-compose process list -U -u <socket> -o json` and return a
 * `name -> status` map. Returns `undefined` when the socket isn't reachable
 * yet (the shared instance is still starting), so the caller treats it as
 * "not ready, keep polling".
 */
function readProcessStates(socketPath: string): Map<string, string> | undefined {
  try {
    const out = execFileSync(
      "process-compose",
      ["process", "list", "-U", "-u", socketPath, "-o", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    interface RawProc {
      readonly name?: string;
      readonly status?: string;
    }
    const parsed: unknown = JSON.parse(out);
    const items: ReadonlyArray<RawProc> = Array.isArray(parsed)
      ? (parsed as ReadonlyArray<RawProc>)
      : ((parsed as { processes?: ReadonlyArray<RawProc> }).processes ?? []);
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.name && item.status) map.set(item.name, item.status);
    }
    return map;
  } catch {
    return undefined;
  }
}
