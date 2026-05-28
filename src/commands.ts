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
import { deriveSharedConfig, deriveWorktreeConfig } from "./deriver.js";
import { SHARED_REGISTRY_KEY, instancePaths, sharedInstancePaths } from "./paths.js";
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
  let blockBase = -1;
  let sharedBase: number | undefined;
  lock(anchor.anchor, (snapshot) => {
    let next = snapshot;
    const block = allocateBlock(anchor.worktreeId, next, options, isPortFree);
    blockBase = block.base;
    if (next[anchor.worktreeId] === undefined) {
      next = { ...next, [anchor.worktreeId]: block.base };
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
  const block = { base: blockBase, portFor: (offset: number) => blockBase + offset };

  // Each tier's named ports map to fixed offsets within its block so a service
  // declaring multiple named ports (http + metrics + debug) gets consecutive
  // numbers starting from its own base offset.
  const isolatedOffsets = buildOffsetMap(stack.services, "isolated", options.blockSize);
  const sharedOffsets = sharedNeeded
    ? buildOffsetMap(stack.services, "shared", options.blockSize)
    : new Map<string, number>();

  const sharedPortFor = (name: string): number | undefined => {
    if (sharedBase === undefined) return undefined;
    const offset = sharedOffsets.get(name);
    return offset === undefined ? undefined : sharedBase + offset;
  };

  const derived = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    portFor: (name) => {
      const offset = isolatedOffsets.get(name);
      return offset === undefined ? undefined : block.portFor(offset);
    },
    sharedPortFor,
  });

  // Warn for any port literal in a service command that is outside this
  // worktree's block — a hardcoded number devtrees did not allocate (PRD US-24).
  for (const warning of findUnmanagedPortBinds(stack, block.base, options.blockSize)) {
    warn(warning);
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
