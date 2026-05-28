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
import { deriveWorktreeConfig } from "./deriver.js";
import { instancePaths } from "./paths.js";
import { loadStack, type ResolvedStack } from "./stack.js";
import { createDriver, type DriverDeps } from "./driver.js";
import { withRegistryLock } from "./registry.js";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";

const DEFAULT_ALLOCATOR: AllocatorOptions = { portBase: 20000, blockSize: 32 };

/** Type of the lock-guarded mutator the caller passes for testability. */
export type WithRegistryLock = (
  anchor: string,
  mutate: (snapshot: RegistrySnapshot) => RegistrySnapshot,
) => RegistrySnapshot;

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
  readonly env: Record<string, string>;
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

/** Bring up this worktree's isolated stack and (optionally) attach its TUI. */
export async function runUp(deps: CommandDeps = {}): Promise<UpResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const lock = deps.withRegistryLock ?? defaultWithRegistryLock;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  const warn = deps.warn ?? defaultWarn;

  const stack = readStack(anchor.worktreeRoot);
  const options = resolveAllocatorOptions(stack, deps.allocator ?? DEFAULT_ALLOCATOR);

  // Lock-guarded read-modify-write: allocate (or look up) the block and persist
  // a freshly-assigned entry under the same lock so two concurrent `up`s on
  // different worktrees cannot race to the same block (PRD US-32).
  let blockBase = -1;
  lock(anchor.anchor, (snapshot) => {
    const block = allocateBlock(anchor.worktreeId, snapshot, options, isPortFree);
    blockBase = block.base;
    if (snapshot[anchor.worktreeId] !== undefined) return snapshot;
    return { ...snapshot, [anchor.worktreeId]: block.base };
  });
  const block = { base: blockBase, portFor: (offset: number) => blockBase + offset };

  // Each isolated service gets a fixed-offset *sub-range* inside the block, so
  // a service declaring multiple named ports (http + metrics + debug) maps each
  // to consecutive offsets starting at the service's own base offset.
  const offsetOf = new Map<string, number>();
  let nextOffset = 0;
  for (const service of stack.services) {
    if (service.tier !== "isolated") continue;
    for (const portName of service.ports) {
      offsetOf.set(portName, nextOffset++);
    }
  }
  if (nextOffset > options.blockSize) {
    throw new Error(
      `stack declares ${nextOffset} isolated named ports but block_size is ${options.blockSize}`,
    );
  }

  const derived = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    portFor: (name) => {
      const offset = offsetOf.get(name);
      return offset === undefined ? undefined : block.portFor(offset);
    },
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
  await driver.up(inst);

  const shouldAttach = deps.attach ?? Boolean(process.stdout.isTTY);
  if (shouldAttach) await driver.attach(inst);

  return { worktreeId: anchor.worktreeId, socketPath: paths.socketPath, env: derived.env };
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

/** Stop this worktree's instance. Leaves the shared instance untouched. */
export async function runDown(deps: CommandDeps = {}): Promise<void> {
  const { anchor } = resolve(deps);
  const paths = instancePaths(anchor.anchor, anchor.worktreeId);
  const driver = createDriver(deps.driver);
  await driver.down({ configPath: paths.configPath, socketPath: paths.socketPath });
}

// --- default I/O implementations -------------------------------------------

function defaultGit(cwd: string): GitProbe {
  return (args) => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const defaultWithRegistryLock: WithRegistryLock = (anchor, mutate) =>
  withRegistryLock(anchor, mutate);

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
