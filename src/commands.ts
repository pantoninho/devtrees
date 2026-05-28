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
import { loadStack } from "./stack.js";
import { createDriver, type DriverDeps } from "./driver.js";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

const DEFAULT_ALLOCATOR: AllocatorOptions = { portBase: 20000, blockSize: 32 };

export interface CommandDeps {
  /** Working directory to resolve the worktree from. Default: process.cwd(). */
  readonly cwd?: string;
  /** Inject git. Default: runs the real `git` in `cwd`. */
  readonly git?: GitProbe;
  /** Read the stack from a directory. Default: reads `devtrees.yaml` from disk. */
  readonly readStack?: (dir: string) => ReturnType<typeof loadStack>;
  /** Read the persisted allocation registry. Default: reads/creates it under the anchor. */
  readonly readRegistry?: (anchor: string) => RegistrySnapshot;
  readonly writeRegistry?: (anchor: string, snapshot: RegistrySnapshot) => void;
  /** Is a concrete port free to bind? Default: probes a real TCP bind. */
  readonly isPortFree?: (port: number) => boolean;
  readonly allocator?: AllocatorOptions;
  readonly driver?: DriverDeps;
  /** Attach the TUI after a successful up. Default: only when stdout is a TTY. */
  readonly attach?: boolean;
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

/** Bring up this worktree's isolated stack and (optionally) attach its TUI. */
export async function runUp(deps: CommandDeps = {}): Promise<UpResult> {
  const { anchor } = resolve(deps);
  const readStack = deps.readStack ?? loadStack;
  const readRegistry = deps.readRegistry ?? defaultReadRegistry;
  const writeRegistry = deps.writeRegistry ?? defaultWriteRegistry;
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  const options = deps.allocator ?? DEFAULT_ALLOCATOR;

  const stack = readStack(anchor.worktreeRoot);
  const snapshot = readRegistry(anchor.anchor);

  const block = allocateBlock(anchor.worktreeId, snapshot, options, isPortFree);
  if (snapshot[anchor.worktreeId] === undefined) {
    writeRegistry(anchor.anchor, { ...snapshot, [anchor.worktreeId]: block.base });
  }

  // Named ports map to fixed offsets within the block, in declaration order
  // across the isolated services.
  const portNames = stack.services.filter((s) => s.tier === "isolated").flatMap((s) => s.ports);
  const offsetOf = new Map(portNames.map((name, i) => [name, i]));

  const derived = deriveWorktreeConfig(stack, {
    worktreeId: anchor.worktreeId,
    worktreeRoot: anchor.worktreeRoot,
    portFor: (name) => {
      const offset = offsetOf.get(name);
      return offset === undefined ? undefined : block.portFor(offset);
    },
  });

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

function defaultReadRegistry(anchor: string): RegistrySnapshot {
  const file = join(anchor, "devtrees", "registry.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as RegistrySnapshot;
}

function defaultWriteRegistry(anchor: string, snapshot: RegistrySnapshot): void {
  const dir = join(anchor, "devtrees");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "registry.json"), JSON.stringify(snapshot, null, 2), "utf8");
}

function defaultIsPortFree(port: number): boolean {
  try {
    // Best-effort, synchronous: if lsof finds a listener, the port is busy.
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}
