/**
 * Config deriver.
 *
 * Transforms a `ResolvedStack` plus an allocation into clean process-compose
 * configs and the matching env injection, one per instance topology:
 *
 *  - **Worktree instance** (`deriveWorktreeConfig`): only `isolated` services.
 *    The author's named ports resolve to this worktree's allocated numbers, and
 *    the shared services' named ports — identical in every worktree — are
 *    injected as connection info so isolated services can reach shared ones
 *    with no hardcoding (CONTEXT.md "Injected value", ADR-0001).
 *  - **Shared instance** (`deriveSharedConfig`): only `shared` services. The
 *    shared services' named ports resolve to the repo-wide shared block.
 *
 * Both strip the devtrees-only `tier` key, pin `working_dir` (the worktree root
 * for isolated processes; the anchor for shared ones — ADR-0002 filesystem
 * isolation does not apply to shared services), and inject each named port as
 * exactly its declared env-var name. Commands are never rewritten.
 *
 * Pure data transforms, no I/O. Per-named-port numbers arrive via injected
 * `portFor` lookups so the deriver stays decoupled from the allocator.
 */

import type { ResolvedStack } from "./stack.js";

/** Env-var name devtrees injects the stable worktree id under. */
const WORKTREE_ID_ENV = "DEVTREES_WORKTREE_ID";

/** A single derived process-compose process entry (tier-free). */
export interface DerivedProcess {
  readonly command: string;
  readonly working_dir: string;
  readonly environment: ReadonlyArray<string>;
  readonly depends_on?: Readonly<Record<string, { condition: string }>>;
}

/** The clean process-compose config for one instance. */
export interface DerivedConfig {
  readonly processes: Record<string, DerivedProcess>;
}

/** Resolves a declared named port to its allocated number, or undefined. */
export type PortResolver = (portName: string) => number | undefined;

export interface DeriveContext {
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  /** Resolve a declared isolated named port to its allocated number for this worktree. */
  readonly portFor: PortResolver;
  /**
   * Resolve a declared shared named port to its repo-wide allocated number.
   * Injected so the worktree instance gets the shared services' connection
   * info — identical in every worktree (CONTEXT.md "Injected value"). Optional:
   * a stack with no shared services may omit it.
   */
  readonly sharedPortFor?: PortResolver;
}

export interface DerivedWorktree {
  readonly config: DerivedConfig;
  /**
   * Flat env injection for the worktree instance: this worktree's own named
   * ports + the shared services' named ports + the worktree id. Identical for
   * every isolated process; an isolated service reaches a shared one through
   * the shared-port entry.
   */
  readonly env: Record<string, string>;
}

/**
 * For each named port a service in `services` declares, look it up via `resolve`
 * and accumulate the resolved entries into `target`. Missing resolutions are
 * skipped — the deriver does not invent numbers it was not given.
 */
function collectPortEnv(
  services: ReadonlyArray<{ readonly ports: ReadonlyArray<string> }>,
  resolve: (portName: string) => number | undefined,
  target: Record<string, string>,
): void {
  for (const service of services) {
    for (const portName of service.ports) {
      const port = resolve(portName);
      if (port !== undefined) target[portName] = String(port);
    }
  }
}

/**
 * Derive the worktree instance's config + env injection from the stack and this
 * worktree's allocation. Only `isolated` services land in the worktree instance;
 * shared services' named ports are still injected as connection info.
 */
export function deriveWorktreeConfig(stack: ResolvedStack, ctx: DeriveContext): DerivedWorktree {
  const isolated = stack.services.filter((s) => s.tier === "isolated");
  const shared = stack.services.filter((s) => s.tier === "shared");

  // The injection identical for every isolated process in this worktree:
  //  - the worktree id (for de-colliding global names)
  //  - this worktree's own named ports (allocated per-worktree)
  //  - the shared services' named ports (allocated repo-wide; identical in every worktree)
  const env: Record<string, string> = { [WORKTREE_ID_ENV]: ctx.worktreeId };
  collectPortEnv(isolated, ctx.portFor, env);
  if (ctx.sharedPortFor) collectPortEnv(shared, ctx.sharedPortFor, env);

  const injection = Object.entries(env).map(([k, v]) => `${k}=${v}`);

  const processes: Record<string, DerivedProcess> = {};
  for (const service of isolated) {
    processes[service.name] = {
      command: service.command,
      working_dir: ctx.worktreeRoot,
      // Author-declared env first, then devtrees injection (injection wins on dups
      // because process-compose takes the last occurrence).
      environment: [...service.environment, ...injection],
    };
  }

  return { config: { processes }, env };
}

/** Context for the shared instance: the anchor (working dir) and the repo-wide port resolver. */
export interface SharedDeriveContext {
  /**
   * Absolute path the shared processes run in. Anchor (git common dir) by
   * default — shared services have no working tree of their own (ADR-0001).
   */
  readonly workingDir: string;
  /** Resolve a declared shared named port to its repo-wide allocated number. */
  readonly portFor: PortResolver;
}

export interface DerivedShared {
  readonly config: DerivedConfig;
  /** Flat env injection for the shared instance: the shared services' named ports. */
  readonly env: Record<string, string>;
}

/**
 * Derive the shared instance's config + env injection. Only `shared` services
 * land here. Each shared service's named ports are injected as exactly their
 * env-var names with the repo-wide allocated numbers, so the same value reaches
 * every worktree instance and the shared process itself.
 */
export function deriveSharedConfig(stack: ResolvedStack, ctx: SharedDeriveContext): DerivedShared {
  const shared = stack.services.filter((s) => s.tier === "shared");

  const env: Record<string, string> = {};
  collectPortEnv(shared, ctx.portFor, env);

  const injection = Object.entries(env).map(([k, v]) => `${k}=${v}`);

  const processes: Record<string, DerivedProcess> = {};
  for (const service of shared) {
    processes[service.name] = {
      command: service.command,
      working_dir: ctx.workingDir,
      environment: [...service.environment, ...injection],
    };
  }

  return { config: { processes }, env };
}
