/**
 * Config deriver.
 *
 * Transforms a `ResolvedStack` plus this worktree's allocation into a clean
 * process-compose config for the worktree instance, and the matching env
 * injection. For this slice it partitions in the isolated services, strips the
 * devtrees-only `tier` key, pins each process's `working_dir` to the worktree
 * root (filesystem isolation, ADR-0002), and injects each named port as exactly
 * its env-var name plus the worktree id — never rewriting commands.
 *
 * Pure data transform, no I/O. The worktree's per-named-port numbers arrive via
 * an injected `portFor` lookup so the deriver stays decoupled from the allocator.
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

export interface DeriveContext {
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  /** Resolve a declared named port to its allocated number for this worktree. */
  portFor(portName: string): number | undefined;
}

export interface DerivedWorktree {
  readonly config: DerivedConfig;
  /** Flat env injection for the instance: named ports + worktree id. */
  readonly env: Record<string, string>;
}

/**
 * Derive the worktree instance's config + env injection from the stack and this
 * worktree's allocation. Only `isolated` services land in the worktree instance.
 */
export function deriveWorktreeConfig(stack: ResolvedStack, ctx: DeriveContext): DerivedWorktree {
  const isolated = stack.services.filter((s) => s.tier === "isolated");

  // The injection identical for every isolated process in this worktree: its own
  // named ports resolved to numbers, plus the worktree id.
  const env: Record<string, string> = { [WORKTREE_ID_ENV]: ctx.worktreeId };
  for (const service of isolated) {
    for (const portName of service.ports) {
      const port = ctx.portFor(portName);
      if (port !== undefined) env[portName] = String(port);
    }
  }

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
