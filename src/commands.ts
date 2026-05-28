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
import { discoverInstances, type InstanceInfo } from "./instances.js";
import { SHARED_REGISTRY_KEY, instancePaths, sharedInstancePaths } from "./paths.js";
import { findOrphans, parseWorktreeIds } from "./prune.js";
import { loadStack, type ResolvedService, type ResolvedStack } from "./stack.js";
import { createDriver, type DriverDeps } from "./driver.js";
import { withRegistryLock, withSharedLock } from "./registry.js";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";

const DEFAULT_ALLOCATOR: AllocatorOptions = { portBase: 20000, blockSize: 32 };

/** Type of the lock-guarded mutator the caller passes for testability. */
export type WithRegistryLock = (
  anchor: string,
  mutate: (snapshot: RegistrySnapshot) => RegistrySnapshot,
) => RegistrySnapshot;

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
  /** Is a concrete port free to bind? Default: probes a real TCP bind. */
  readonly isPortFree?: (port: number) => boolean;
  /**
   * Allocator defaults — `port_base` and `block_size`. The stack's `allocator`
   * field overrides these on a field-by-field basis. Default: 20000 / 32.
   */
  readonly allocator?: AllocatorOptions;
  readonly driver?: DriverDeps;
  /** Attach the TUI after a successful up. Default: only when stdout is a TTY. */
  readonly attach?: boolean;
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
function allocateAndBuildPortMaps(args: {
  readonly anchor: string;
  readonly worktreeId: string;
  readonly stack: ResolvedStack;
  readonly options: AllocatorOptions;
  readonly lock: WithRegistryLock;
  readonly isPortFree: (port: number) => boolean;
}): AllocatedPortMaps {
  const { anchor, worktreeId, stack, options, lock, isPortFree } = args;
  const sharedNeeded = hasTier(stack, "shared");

  let blockBase = -1;
  let sharedBase: number | undefined;
  lock(anchor, (snapshot) => {
    let next = snapshot;
    const block = allocateBlock(worktreeId, next, options, isPortFree);
    blockBase = block.base;
    if (next[worktreeId] === undefined) {
      next = { ...next, [worktreeId]: block.base };
    }
    if (sharedNeeded) {
      const sblock = allocateBlock(SHARED_REGISTRY_KEY, next, options, isPortFree);
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

/** Bring up this worktree's isolated stack and lazily start the shared instance if needed. */
export async function runUp(deps: CommandDeps = {}): Promise<UpResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const sharedLock = deps.withSharedLock ?? defaultWithSharedLock;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  const warn = deps.warn ?? defaultWarn;

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
  const { blockBase, portFor, sharedPortFor } = allocateAndBuildPortMaps({
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
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.configPath, stringifyYaml(derived.config), "utf8");

  const driver = createDriver(deps.driver);
  const inst = { configPath: paths.configPath, socketPath: paths.socketPath };

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

  const shouldAttach = deps.attach ?? Boolean(process.stdout.isTTY);
  if (shouldAttach) await driver.attach(inst);

  return {
    worktreeId: anchor.worktreeId,
    socketPath: paths.socketPath,
    env: derived.env,
    sharedStarted,
  };
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

  const { portFor, sharedPortFor } = allocateAndBuildPortMaps({
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
 * Stop this worktree's instance (default) or — with `{ shared: true }` — the
 * shared instance. The two are decoupled (ADR-0001): worktree `down` never
 * touches shared, so other worktrees keep their connections.
 *
 * Shared teardown is gated by the shared lifecycle lock and idempotent: if the
 * shared instance is not running, the call is a no-op and the registry entry
 * is still cleared so a subsequent `up` can re-lazy-start it.
 */
export async function runDown(deps: CommandDeps = {}, options: DownOptions = {}): Promise<void> {
  const { anchor } = resolve(deps);
  const driver = createDriver(deps.driver);

  if (options.shared) {
    const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
    const sharedLock = deps.withSharedLock ?? defaultWithSharedLock;
    const paths = sharedInstancePaths(anchor.anchor);

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
    lock(anchor.anchor, (snapshot) => {
      if (snapshot[SHARED_REGISTRY_KEY] === undefined) return snapshot;
      const { [SHARED_REGISTRY_KEY]: _drop, ...rest } = snapshot;
      void _drop;
      return rest;
    });
    return;
  }

  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  await driver.down({ configPath: paths.configPath, socketPath: paths.socketPath });
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
  readonly discover?: (anchor: string) => Promise<InstanceInfo[]>;
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
 */
export async function runLs(deps: LsDeps = {}): Promise<LsResult> {
  const { anchor } = resolve(deps);
  const discover = deps.discover ?? discoverInstances;
  const instances = await discover(anchor.anchor);
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
  lock(anchor.anchor, (snapshot) => {
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

// --- default I/O implementations -------------------------------------------

function defaultGit(cwd: string): GitProbe {
  return (args) => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const defaultWithRegistryLock: WithRegistryLock = (anchor, mutate) =>
  withRegistryLock(anchor, mutate);

const defaultWithSharedLock: WithSharedLock = (anchor, fn) => withSharedLock(anchor, fn);

function defaultIsPortFree(port: number): boolean {
  try {
    // Best-effort, synchronous: if lsof finds a listener, the port is busy.
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
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
    const states = readSharedProcessStates(socketPath);
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
 * Run `process-compose process list -U -u <socket> -o json` and return a
 * `name -> status` map. Returns `undefined` when the socket isn't reachable
 * yet (the shared instance is still starting), so the caller treats it as
 * "not ready, keep polling".
 */
function readSharedProcessStates(socketPath: string): Map<string, string> | undefined {
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
