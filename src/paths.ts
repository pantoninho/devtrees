/**
 * Anchor state paths.
 *
 * All devtrees runtime state — derived configs, control sockets, the allocation
 * registry — lives in `<git-common-dir>/devtrees/`. Because that directory is
 * inside the git dir, it is never part of the working tree: no `.gitignore`
 * entry is needed and the same layout works for normal and bare repos
 * (CONTEXT.md "Anchor state", ADR-0001).
 */

import { join } from "node:path";

/** The `devtrees/` state directory inside the anchor (git common dir). */
export function stateDir(anchor: string): string {
  return join(anchor, "devtrees");
}

/** The run dir holding per-instance control sockets. */
function runDir(anchor: string): string {
  return join(stateDir(anchor), "run");
}

export interface InstancePaths {
  readonly stateDir: string;
  readonly runDir: string;
  readonly configPath: string;
  readonly socketPath: string;
}

/** Per-instance derived-config and control-socket paths, keyed by worktree id. */
export function instancePaths(anchor: string, worktreeId: string): InstancePaths {
  return {
    stateDir: stateDir(anchor),
    runDir: runDir(anchor),
    configPath: join(stateDir(anchor), `${worktreeId}.yaml`),
    socketPath: join(runDir(anchor), `${worktreeId}.sock`),
  };
}
