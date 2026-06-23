/**
 * Anchor state paths.
 *
 * All devtrees runtime state — derived configs, control sockets, the allocation
 * registry — lives in `<git-common-dir>/devtrees/`. Because that directory is
 * inside the git dir, it is never part of the working tree: no `.gitignore`
 * entry is needed and the same layout works for normal and bare repos
 * (CONTEXT.md "Anchor state", ADR-0001).
 *
 * The shared instance has a fixed identity at the anchor: its derived config
 * lives at `<anchor>/devtrees/shared.yaml` and its control socket at
 * `<anchor>/devtrees/run/shared.sock`. It is registered in the allocation
 * registry under the well-known key `__shared__` (CONTEXT.md "Allocation
 * registry") so a worktree can read the registry and discover the shared
 * services' ports without any other coordination.
 */

import { join } from "node:path";

/** Well-known registry key for the shared instance's port block. */
export const SHARED_REGISTRY_KEY = "__shared__";

/**
 * Filename stem used for the shared instance's derived config + control socket
 * (`shared.yaml`, `shared.sock`). Distinct from the registry key so the
 * on-disk filename stays human-readable.
 */
export const SHARED_INSTANCE_ID = "shared";

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

/**
 * Per-instance on-disk logs dir — `<anchor>/devtrees/logs/<instanceId>/` (issue
 * #136). devtrees templates an authored `log_location` under this dir and emits
 * the resolved absolute path as process-compose `log_location`, so the same
 * authored filename in two worktrees lands in different files (no cross-worktree
 * collision). `instanceId` is the worktree id for isolated services and
 * `SHARED_INSTANCE_ID` (`shared`) for the shared tier.
 */
export function logsDir(anchor: string, instanceId: string): string {
  return join(stateDir(anchor), "logs", instanceId);
}

/**
 * Paths for the shared instance — fixed at `<anchor>/devtrees/shared.yaml`
 * and `<anchor>/devtrees/run/shared.sock`. There is only ever one shared
 * instance per repo, so its filenames are constant rather than keyed.
 */
export function sharedInstancePaths(anchor: string): InstancePaths {
  return instancePaths(anchor, SHARED_INSTANCE_ID);
}
