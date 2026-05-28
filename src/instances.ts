/**
 * Instance discovery.
 *
 * Enumerates every devtrees instance — each worktree's and the shared one —
 * across the repo by listing control sockets under the anchor's run dir
 * (`<anchor>/devtrees/run/*.sock`). There is no central daemon and no PID
 * registry: the on-disk socket is the only authoritative liveness marker, so
 * discovery is the same primitive `devtrees ls` reads to render its table and
 * `devtrees prune` (#9) walks to reconcile against `git worktree list`.
 *
 * Status comes from probing the socket itself — a connectable UDS means
 * `running`, a leftover file with no listener means `stale`. The allocation
 * registry contributes the port block base; the per-instance derived config
 * (already on disk under `<anchor>/devtrees/<id>.yaml`) contributes the
 * human-meaningful named-port mapping so `ls` can print `WEB_PORT=20512`
 * rather than just a range.
 *
 * Pure-modulo-I/O: the only side effects are fs reads and one UDS connect
 * attempt per socket. No registry write, no spawn.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readRegistry } from "./registry.js";
import {
  SHARED_INSTANCE_ID,
  SHARED_REGISTRY_KEY,
  instancePaths,
  stateDir,
} from "./paths.js";

/** Whether an instance hosts the shared services or one worktree's isolated ones. */
export type InstanceKind = "worktree" | "shared";

/**
 * Whether the control socket is currently held by a live process-compose
 * (running) or is an orphaned file no one is listening on (stale).
 */
export type InstanceStatus = "running" | "stale";

export interface InstanceInfo {
  /** Worktree id, or the well-known shared id (`SHARED_INSTANCE_ID`). */
  readonly id: string;
  readonly kind: InstanceKind;
  readonly status: InstanceStatus;
  /** Absolute path of the control socket whose existence anchored this entry. */
  readonly socketPath: string;
  /**
   * Named-port → allocated-number map for this instance, recovered from its
   * derived config. Empty when the derived config is not on disk (e.g. the
   * instance was started by an older devtrees and the YAML has since been
   * pruned); the `blockBase` field still gives the caller the block.
   */
  readonly ports: Readonly<Record<string, number>>;
  /**
   * The base port of this instance's allocation block, taken from the
   * registry. Undefined when the socket exists but the registry has no entry
   * for this id (stale state worth surfacing to the operator).
   */
  readonly blockBase: number | undefined;
}

/**
 * How long to wait for a UDS connect attempt before declaring the socket
 * stale. Kept tiny — a live process-compose accepts immediately; anything
 * longer is almost certainly the kernel's "no one is listening" path.
 */
const CONNECT_TIMEOUT_MS = 250;

/**
 * Resolve the on-disk filename stem of a socket to its registry key. The
 * shared instance is filed under a fixed stem (`shared.sock`) but registered
 * under the well-known `__shared__` key so the two namespaces (filenames vs.
 * registry entries) stay separable.
 */
function registryKeyFor(socketStem: string): string {
  return socketStem === SHARED_INSTANCE_ID ? SHARED_REGISTRY_KEY : socketStem;
}

/** Map a socket stem to the kind of instance it represents. */
function kindFor(socketStem: string): InstanceKind {
  return socketStem === SHARED_INSTANCE_ID ? "shared" : "worktree";
}

/** Read every `*.sock` filename stem under the anchor's run dir, sorted. */
function listSocketStems(anchor: string): string[] {
  const runDir = join(stateDir(anchor), "run");
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((entry) => entry.endsWith(".sock"))
    .map((entry) => entry.slice(0, -".sock".length));
}

/**
 * Probe the socket: attempt a UDS connect with a short timeout. The socket is
 * the same UDS process-compose serves its API on, so anything that accepts the
 * connection — even before reading a byte — is a live instance. Anything else
 * (ENOENT, ECONNREFUSED, timeout) means the file is orphaned.
 */
async function probeSocket(socketPath: string): Promise<InstanceStatus> {
  return new Promise<InstanceStatus>((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const settle = (status: InstanceStatus): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => settle("stale"), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      settle("running");
    });
    socket.once("error", () => {
      clearTimeout(timer);
      settle("stale");
    });
  });
}

/**
 * Extract every `KEY=NUMBER` env entry that appears in any process's
 * `environment:` list of a derived config. devtrees' deriver writes named-port
 * allocations exactly that way (`WEB_PORT=20512`) and never rewrites commands,
 * so reading the derived config back recovers the same mapping the original
 * `up` injected — without re-running the allocator or the stack loader.
 */
function readPortsFromDerived(configPath: string): Record<string, number> {
  if (!existsSync(configPath)) return {};
  const text = readFileSync(configPath, "utf8");
  const doc = (parseYaml(text) ?? {}) as {
    processes?: Record<string, { environment?: ReadonlyArray<unknown> }>;
  };
  const ports: Record<string, number> = {};
  for (const proc of Object.values(doc.processes ?? {})) {
    for (const entry of proc.environment ?? []) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq);
      const raw = entry.slice(eq + 1);
      if (!/^\d+$/.test(raw)) continue;
      ports[key] = Number(raw);
    }
  }
  return ports;
}

/**
 * Sort instances for deterministic display: the shared instance first (it's
 * the repo-wide singleton, useful to see at a glance), then worktree
 * instances alphabetically by id.
 */
function compareInstances(a: InstanceInfo, b: InstanceInfo): number {
  if (a.kind === b.kind) return a.id.localeCompare(b.id);
  return a.kind === "shared" ? -1 : 1;
}

/**
 * Discover every running (and stale) devtrees instance at `anchor`. The result
 * is the same primitive `devtrees ls` renders and `devtrees prune` walks — no
 * caller has to enumerate sockets themselves.
 */
export async function discoverInstances(anchor: string): Promise<InstanceInfo[]> {
  const stems = listSocketStems(anchor);
  if (stems.length === 0) return [];

  const registry = readRegistry(anchor);

  const infos = await Promise.all(
    stems.map(async (stem): Promise<InstanceInfo> => {
      const paths = instancePaths(anchor, stem);
      const status = await probeSocket(paths.socketPath);
      const blockBase = registry[registryKeyFor(stem)];
      return {
        id: stem,
        kind: kindFor(stem),
        status,
        socketPath: paths.socketPath,
        ports: readPortsFromDerived(paths.configPath),
        blockBase,
      };
    }),
  );

  return infos.sort(compareInstances);
}
