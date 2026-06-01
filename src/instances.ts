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
import type { ServiceStatus } from "./driver.js";
import { readRegistry } from "./registry.js";
import { SHARED_INSTANCE_ID, SHARED_REGISTRY_KEY, instancePaths, stateDir } from "./paths.js";

/** Whether an instance hosts the shared services or one worktree's isolated ones. */
export type InstanceKind = "worktree" | "shared";

/**
 * Whether the control socket is currently held by a live process-compose
 * (running) or is an orphaned file no one is listening on (stale).
 */
export type InstanceStatus = "running" | "stale";

/**
 * One service inside a worktree (or shared) instance, as exposed by `ls`.
 * Combines the runtime fields the driver reads from `process-compose process
 * list -o json` with the per-service named-port allocation devtrees injected
 * at `up` time. The two come from different sources so an agent asking "is
 * `worker` healthy and on what port?" gets one row per service with both
 * dimensions in hand.
 */
export interface Service {
  readonly name: string;
  /** process-compose's process-state string (e.g. "Running", "Completed"). */
  readonly status: string;
  /** Normalised readiness: ready | not_ready | unknown. */
  readonly health: ServiceStatus["health"];
  /**
   * Named-port → allocated-number map for this service, parsed from the
   * process's `environment:` list in the derived config (devtrees writes the
   * worktree's named ports there at `up` time).
   */
  readonly ports: Readonly<Record<string, number>>;
}

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
  /**
   * One row per service in the instance's derived config, combined with its
   * runtime state from `getServiceStatuses`. Empty when the socket is stale,
   * when no `getServiceStatuses` injector is provided, or when the single
   * driver call for this instance failed (we don't fail the whole `ls` for
   * one flaky instance).
   */
  readonly services: ReadonlyArray<Service>;
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
 * Parse one `KEY=NUMBER` entry from a derived config's `environment:` list, or
 * return `undefined` for anything else. Devtrees writes named-port allocations
 * exactly that way (`WEB_PORT=20512`); any other shape (object literals, env
 * entries that aren't ports) is ignored.
 */
function parsePortEnvEntry(entry: unknown): readonly [string, number] | undefined {
  if (typeof entry !== "string") return undefined;
  const eq = entry.indexOf("=");
  if (eq <= 0) return undefined;
  const raw = entry.slice(eq + 1);
  if (!/^\d+$/.test(raw)) return undefined;
  return [entry.slice(0, eq), Number(raw)];
}

/**
 * Read the derived config back into a per-process port map: for each process
 * declared, extract every `KEY=NUMBER` entry from its `environment:` list.
 * Devtrees never rewrites commands, so reading the derived config recovers the
 * same mapping the original `up` injected — without re-running the allocator
 * or the stack loader.
 */
function readPortsByProcess(configPath: string): Record<string, Record<string, number>> {
  if (!existsSync(configPath)) return {};
  const doc = (parseYaml(readFileSync(configPath, "utf8")) ?? {}) as {
    processes?: Record<string, { environment?: ReadonlyArray<unknown> }>;
  };
  const byProc: Record<string, Record<string, number>> = {};
  for (const [name, proc] of Object.entries(doc.processes ?? {})) {
    const ports: Record<string, number> = {};
    for (const entry of proc.environment ?? []) {
      const parsed = parsePortEnvEntry(entry);
      if (parsed) ports[parsed[0]] = parsed[1];
    }
    byProc[name] = ports;
  }
  return byProc;
}

/**
 * Flatten the per-process port map down to the instance-level
 * `{name → number}` projection — the shape `InstanceInfo.ports` has always
 * exposed.
 */
function flattenPorts(byProc: Record<string, Record<string, number>>): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const procPorts of Object.values(byProc)) {
    for (const [k, v] of Object.entries(procPorts)) ports[k] = v;
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
 * Knobs for the discovery walk. All optional: the default path stays
 * lock-free (no registry write) and makes zero driver calls — the per-service
 * `services[]` rows are only fetched when the caller injects a runtime
 * `getServiceStatuses` reader.
 */
export interface DiscoverDeps {
  /**
   * Read the per-service runtime state from a running instance — one call per
   * discovered running instance. Defaults to no-op: discovery is the
   * primitive `prune` and the old `ls` walk; only the agent-facing `ls --json`
   * path supplies this.
   */
  readonly getServiceStatuses?: (socketPath: string) => Promise<ServiceStatus[]>;
}

/**
 * Best-effort fetch of a single instance's runtime services. A driver error
 * for one instance must not abort the whole `ls` — agents and operators both
 * want a partial answer (the other instances) over a fatal exception.
 */
async function safeGetServiceStatuses(
  socketPath: string,
  fetch: (socketPath: string) => Promise<ServiceStatus[]>,
): Promise<ServiceStatus[]> {
  try {
    return await fetch(socketPath);
  } catch {
    return [];
  }
}

/**
 * Discover every running (and stale) devtrees instance at `anchor`. The result
 * is the same primitive `devtrees ls` renders and `devtrees prune` walks — no
 * caller has to enumerate sockets themselves. Lock-free: no allocation-registry
 * write happens here.
 *
 * When `deps.getServiceStatuses` is provided, each running instance is
 * enriched with one shell-out to the driver, populating `services[]`. Stale
 * instances never see a driver call.
 */
export async function discoverInstances(
  anchor: string,
  deps: DiscoverDeps = {},
): Promise<InstanceInfo[]> {
  const stems = listSocketStems(anchor);
  if (stems.length === 0) return [];

  const registry = readRegistry(anchor);

  const infos = await Promise.all(
    stems.map(async (stem): Promise<InstanceInfo> => {
      const paths = instancePaths(anchor, stem);
      const status = await probeSocket(paths.socketPath);
      const blockBase = registry[registryKeyFor(stem)];
      const portsByProc = readPortsByProcess(paths.configPath);
      const services =
        status === "running" && deps.getServiceStatuses
          ? buildServices(
              await safeGetServiceStatuses(paths.socketPath, deps.getServiceStatuses),
              portsByProc,
            )
          : [];
      return {
        id: stem,
        kind: kindFor(stem),
        status,
        socketPath: paths.socketPath,
        ports: flattenPorts(portsByProc),
        blockBase,
        services,
      };
    }),
  );

  return infos.sort(compareInstances);
}

/**
 * Zip a driver's `ServiceStatus[]` with the per-process port allocations from
 * the derived config. Ordering follows the driver's response — that's the
 * order an agent walking the array will naturally see services in. A service
 * the derived config has no port entry for keeps an empty `ports: {}`.
 */
function buildServices(
  statuses: ReadonlyArray<ServiceStatus>,
  portsByProc: Record<string, Record<string, number>>,
): Service[] {
  return statuses.map((s) => ({
    name: s.name,
    status: s.status,
    health: s.health,
    ports: portsByProc[s.name] ?? {},
  }));
}
