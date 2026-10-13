/**
 * Instance discovery.
 *
 * Enumerates every devtrees instance — each worktree's and the shared one —
 * across the repo by listing control sockets under the repo's run dir
 * (`<runtime-base>/devtrees-<uid>/<anchor-hash>/*.sock` since #156, ADR-0007).
 * There is no central daemon and no PID registry: the on-disk socket is the
 * only authoritative liveness marker, so
 * discovery is the same primitive `devtrees ls` reads to render its table and
 * `devtrees prune` (#9) walks to reconcile against `git worktree list`.
 *
 * Status comes from probing the socket itself — a connectable UDS means
 * `running`, a leftover file with no listener means `stale`, and a probe that
 * cannot tell (a timeout, a busy listener) means `unknown` (#186). The allocation
 * registry contributes the port block base; the per-instance derived config
 * (already on disk under `<anchor>/devtrees/<id>.yaml`) contributes the
 * human-meaningful named-port mapping so `ls` can print `WEB_PORT=20512`
 * rather than just a range.
 *
 * Pure-modulo-I/O: the only side effects are fs reads and one UDS connect
 * attempt per socket. No registry write, no spawn.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEVTREES_METADATA_KEY } from "./deriver.js";
import type { ServiceStatus } from "./driver.js";
import { readRegistry } from "./registry.js";
import { readPendingReload } from "./reload-pending.js";
import { resolveRunningSelection, serviceNamespaces } from "./selection.js";
import { classifyService, type ServiceVerdict } from "./service-state.js";
import type { Namespace } from "./stack.js";
import {
  SHARED_INSTANCE_ID,
  SHARED_REGISTRY_KEY,
  instancePaths,
  legacyRunDir,
  runDir,
} from "./paths.js";

/** Whether an instance hosts the shared services or one worktree's isolated ones. */
export type InstanceKind = "worktree" | "shared";

/**
 * Whether the control socket is currently held by a live process-compose
 * (running), is an orphaned file no one is listening on (stale), or could not
 * be told apart from a live-but-busy instance (unknown, issue #186): the
 * connect timed out or failed in a way that does not prove the listener is
 * gone. Only `stale` licenses unlinking the socket file.
 */
export type InstanceStatus = "running" | "stale" | "unknown";

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
   * Named-port → allocated-number map for the ports this service *declares*,
   * read from the derived config's `x-devtrees.ports_by_service` metadata
   * (issue #110). The process's `environment:` list is no use here — it
   * carries the whole instance's port map as flat connection-info injection.
   * `{}` for a portless service, and for instances whose derived config
   * predates the metadata (the honest "unknown" answer).
   */
  readonly ports: Readonly<Record<string, number>>;
}

/**
 * One service as `ls` lists it (#226): the runtime row plus what acting on
 * one service needs to see (ADR-0009).
 */
export interface ListedService extends Service {
  /**
   * The namespaces the service belongs to (#226): its declared ones from the
   * derived config, `default` when it declares none, or what process-compose
   * reports when the derived config is not on disk.
   */
  readonly namespaces: ReadonlyArray<string>;
  /** The instance's tier: a worktree instance runs isolated services, the shared one shared. */
  readonly tier: "isolated" | "shared";
  /** Dead versus done (ADR-0008, `classifyService`): `active`, `dead` or `done`. */
  readonly state: ServiceVerdict;
  /**
   * The process's pid, only while process-compose reports it running
   * (`is_running`). A dead or done row, and a `Restarting` one waiting out its
   * backoff, keep the pid of the run that ended, which may since have been
   * reused by an unrelated process, so it is not published.
   */
  readonly pid?: number;
}

/**
 * Whether `ls` could read an instance's services (#226): `ok` (the read
 * answered), `unresponsive` (a running instance whose `process list` did not
 * answer within the bound, or failed), or `skipped` (no read was attempted:
 * the instance is stale, or found gone by the read, or its liveness unknown,
 * or no reader was given).
 * Only `ok` makes `services` and `namespaces` authoritative.
 */
export type ServicesRead = "ok" | "unresponsive" | "skipped";

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
  readonly services: ReadonlyArray<ListedService>;
  /**
   * The namespaces the instance booted (#226), read back from the project as
   * a running `up` does (ADR-0008, `resolveRunningSelection`). `null` when
   * they are not known: the read did not answer, the instance's liveness is
   * unknown, or its derived config (which declares the namespaces) is gone.
   * `[]` for a stale instance: nothing is booted. Discovery always sets it;
   * absent reads as `[]`.
   */
  readonly namespaces?: ReadonlyArray<string> | null;
  /**
   * Whether `services` and `namespaces` come from a successful read (#226).
   * Discovery always sets it; absent reads as `skipped`.
   */
  readonly servicesRead?: ServicesRead;
  /**
   * A timed-out hot-reload of this instance is still pending (#191, #226):
   * its marker is on disk. The marker's services count as booted while it is
   * there, since their old runs may still be alive though process-compose no
   * longer lists them.
   */
  readonly reloadPending?: boolean;
}

/**
 * How long to wait for one UDS connect attempt. A live process-compose
 * accepts at once, but on a loaded machine the event loop can wake with the
 * timer already due before it services the connect (#186). A timeout is
 * therefore never read as "stale": it is `unknown`, and callers retry
 * (`probeUntilDefinitive`) rather than wait longer on one attempt.
 */
const CONNECT_TIMEOUT_MS = 250;

/**
 * Backoff between probe attempts while the answer is `unknown` (#186): four
 * attempts over roughly 2.3s in the worst case. Short enough that a frozen
 * instance fails `up`/`down` promptly, long enough to ride out a scheduling
 * stall on a loaded machine.
 */
export const PROBE_RETRY_DELAYS_MS: ReadonlyArray<number> = [100, 300, 900];

/** What a single UDS connect attempt observed, before any interpretation. */
export type ProbeOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly code: string | undefined };

/**
 * Connect errors that prove nothing is listening at the path: the file is
 * gone (`ENOENT`), no socket is bound to it (`ECONNREFUSED`), or it is not a
 * socket at all (`ENOTSOCK`, a plain file left at the path).
 */
const NOTHING_LISTENING: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/**
 * Classify one probe outcome (#186). Pure. A connect means `running`; only
 * `ENOENT`/`ECONNREFUSED`/`ENOTSOCK` mean `stale`; a timeout or any other
 * error is `unknown`, because a live process-compose on a loaded machine can
 * produce either, and treating it as stale deletes a live instance's socket.
 */
export function classifyProbe(outcome: ProbeOutcome): InstanceStatus {
  if (outcome.kind === "connected") return "running";
  if (outcome.kind === "error" && NOTHING_LISTENING.has(outcome.code ?? "")) return "stale";
  return "unknown";
}

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

/** One control socket found on disk: its filename stem and where it actually is. */
interface DiscoveredSocket {
  readonly stem: string;
  readonly socketPath: string;
}

/** Read every `*.sock` filename stem in `dir`, or `[]` when the dir is absent. */
function readSocketStems(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".sock"))
    .map((entry) => entry.slice(0, -".sock".length));
}

/**
 * Find every control socket for `anchor`, canonical location first.
 *
 * Since #156 devtrees binds sockets under a short runtime dir (ADR-0007); the
 * pre-#156 location (`<anchor>/devtrees/run`) is still *read* so an instance
 * started by an older devtrees stays visible to `ls` and reclaimable by
 * `prune` across the upgrade instead of turning into an invisible orphan.
 * Nothing is ever written there again, and a stem present in both places
 * resolves to the canonical path — the legacy file is then a leftover, not a
 * live instance.
 */
function listSockets(anchor: string): DiscoveredSocket[] {
  const found = new Map<string, string>();
  for (const dir of [runDir(anchor), legacyRunDir(anchor)]) {
    for (const stem of readSocketStems(dir)) {
      if (!found.has(stem)) found.set(stem, join(dir, `${stem}.sock`));
    }
  }
  return [...found].map(([stem, socketPath]) => ({ stem, socketPath }));
}

/** One UDS connect attempt, reported raw. Never rejects. */
function connectOnce(socketPath: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const settle = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => settle({ kind: "connected" }));
    socket.once("error", (err: NodeJS.ErrnoException) => settle({ kind: "error", code: err.code }));
  });
}

/**
 * Does any process hold a unix socket bound at `socketPath`? `true`/`false`
 * from `lsof`; `true` too when `lsof` times out (treated as busy, never as
 * proof of death); `undefined` when `lsof` is missing or fails some other way
 * (the answer is then not known, and the caller keeps the connect error's
 * verdict). `lsofPath`/`timeoutMs` are test seams.
 *
 * Needed because `ECONNREFUSED` is not proof of death on macOS (#186): a
 * listener whose accept backlog is full, such as a frozen or wedged
 * process-compose with clients queued behind it, refuses new connects exactly
 * as a socket file with no listener does.
 */
export function socketHeldByProcess(
  socketPath: string,
  options: { readonly lsofPath?: string; readonly timeoutMs?: number } = {},
): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    execFile(
      options.lsofPath ?? "lsof",
      ["-t", "-U", "-a", socketPath],
      { timeout: options.timeoutMs ?? 1000 },
      (err, stdout) => {
        if (err === null) {
          resolve(stdout.trim().length > 0);
          return;
        }
        // An lsof that ran out of time says nothing about the socket, and on a
        // loaded machine it is exactly when a live instance is also slow to
        // answer: report it as held (so the probe stays `unknown`) rather than
        // letting the refusal unlink a possibly-live socket.
        if ((err as { killed?: unknown }).killed === true) {
          resolve(true);
          return;
        }
        // lsof exits 1 with no output when nothing matches: a definitive "no".
        // Anything else (lsof not installed, spawn failure) is "not known", so
        // the refusal's verdict stands and a crashed instance still recovers.
        const noMatch = (err as { code?: unknown }).code === 1 && stdout.trim() === "";
        resolve(noMatch ? false : undefined);
      },
    );
  });
}

/** Seams for `probeSocket`; tests inject them, production uses the defaults. */
export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly heldByProcess?: (socketPath: string) => Promise<boolean | undefined>;
}

/**
 * Probe the socket: attempt one UDS connect with a short timeout and classify
 * it (`classifyProbe`). The socket is the same UDS process-compose serves its
 * API on, so anything that accepts the connection — even before reading a
 * byte — is a live instance. `ENOENT`/`ENOTSOCK` mean stale. `ECONNREFUSED` means stale
 * unless a process still holds the socket (a full backlog, see
 * `socketHeldByProcess`), which makes it `unknown`. A timeout or any other
 * error is `unknown` (#186).
 *
 * Exported because liveness is a repo-wide concern, not just `ls`'s: the
 * write paths (`up`, the shared lazy-start, `down --shared`) must not trust
 * socket-file existence — the file lives in anchor state and survives
 * `kill -9` and reboots (issue #80).
 */
export async function probeSocket(
  socketPath: string,
  options: ProbeOptions = {},
): Promise<InstanceStatus> {
  const outcome = await connectOnce(socketPath, options.timeoutMs ?? CONNECT_TIMEOUT_MS);
  const status = classifyProbe(outcome);
  if (outcome.kind !== "error" || outcome.code !== "ECONNREFUSED") return status;
  const held = await (options.heldByProcess ?? socketHeldByProcess)(socketPath);
  return held === true ? "unknown" : status;
}

/**
 * Probe until the answer is definitive (`running` or `stale`), backing off
 * between attempts per `delaysMs`; `unknown` if every attempt was (#186).
 * A busy instance gets a few chances to answer before a caller has to choose
 * between failing and guessing.
 */
export async function probeUntilDefinitive(
  socketPath: string,
  probe: (socketPath: string) => Promise<InstanceStatus>,
  delaysMs: ReadonlyArray<number> = PROBE_RETRY_DELAYS_MS,
): Promise<InstanceStatus> {
  let status = await probe(socketPath);
  for (const delay of delaysMs) {
    if (status !== "unknown") return status;
    await new Promise((r) => setTimeout(r, delay));
    status = await probe(socketPath);
  }
  return status;
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
function readPortsByProcess(doc: DerivedConfigDoc): Record<string, Record<string, number>> {
  const byProc: Record<string, Record<string, number>> = {};
  for (const [name, proc] of Object.entries(doc.processes ?? {})) {
    const ports: Record<string, number> = {};
    for (const entry of proc?.environment ?? []) {
      const parsed = parsePortEnvEntry(entry);
      if (parsed) ports[parsed[0]] = parsed[1];
    }
    byProc[name] = ports;
  }
  return byProc;
}

/** The loose shape discovery reads a derived config back as. */
interface DerivedConfigDoc {
  readonly processes?: Record<
    string,
    { environment?: ReadonlyArray<unknown>; namespace?: unknown } | null
  >;
  readonly [DEVTREES_METADATA_KEY]?: { ports_by_service?: unknown };
}

/** Parse a derived config from disk, or `{}` when it isn't there / is empty. */
function readDerivedConfig(configPath: string): DerivedConfigDoc {
  if (!existsSync(configPath)) return {};
  return (parseYaml(readFileSync(configPath, "utf8")) ?? {}) as DerivedConfigDoc;
}

/**
 * Read the per-service *declared* port map from the derived config's
 * `x-devtrees.ports_by_service` metadata (issue #110). Returns `undefined`
 * when the metadata is absent or malformed — a derived config written before
 * the metadata existed — so callers can fall back to "unknown" rather than
 * misreporting the flat env injection as the service's own ports. Non-number
 * values inside an entry are skipped, same spirit as `parsePortEnvEntry`.
 */
function readPortsByService(
  doc: DerivedConfigDoc,
): Record<string, Record<string, number>> | undefined {
  const raw = doc[DEVTREES_METADATA_KEY]?.ports_by_service;
  if (!isPlainRecord(raw)) return undefined;
  const byService: Record<string, Record<string, number>> = {};
  for (const [name, entry] of Object.entries(raw)) {
    byService[name] = parseDeclaredPortMap(entry);
  }
  return byService;
}

/**
 * Each service's declared named ports, read from the derived config at
 * `configPath` (issue #110): the same `ports` an `ls --json` row carries.
 * `{}` when the config or its metadata is missing.
 */
export function readDeclaredPorts(configPath: string): Record<string, Record<string, number>> {
  try {
    return readPortsByService(readDerivedConfig(configPath)) ?? {};
  } catch {
    return {};
  }
}

/** True for a plain mapping (non-null, non-array object) — the YAML dict shape. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Coerce one `ports_by_service` entry into `{port name → number}`; junk → `{}`. */
function parseDeclaredPortMap(entry: unknown): Record<string, number> {
  const ports: Record<string, number> = {};
  if (!isPlainRecord(entry)) return ports;
  for (const [portName, value] of Object.entries(entry)) {
    if (typeof value === "number" && Number.isFinite(value)) ports[portName] = value;
  }
  return ports;
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
  /** Probe one control socket. Default: `probeSocket`. Injected by tests. */
  readonly probeSocket?: (socketPath: string) => Promise<InstanceStatus>;
  /** Backoff while a probe stays `unknown`. Default: `PROBE_RETRY_DELAYS_MS`. */
  readonly probeRetryDelaysMs?: ReadonlyArray<number>;
}

/** What one instance's `process list` read came back with (#226). */
type ReadOutcome =
  | { readonly kind: "ok"; readonly rows: ReadonlyArray<ServiceStatus> }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

/**
 * A failed read followed by a definitively stale probe: `readStatusesWithin`
 * throws `INSTANCE_NOT_FOUND` (#205). The instance stopped (a racing `down`,
 * or a start that did not come up); no time limit was hit.
 */
function isInstanceGone(err: unknown): boolean {
  return (err as { readonly code?: unknown } | null)?.code === "INSTANCE_NOT_FOUND";
}

/**
 * Best-effort fetch of a single instance's runtime services. A driver error
 * (or a read that ran out of time) for one instance must not abort the whole
 * `ls` — agents and operators both want a partial answer (the other
 * instances) over a fatal exception.
 */
async function safeGetServiceStatuses(
  socketPath: string,
  fetch: (socketPath: string) => Promise<ServiceStatus[]>,
): Promise<ReadOutcome> {
  try {
    return { kind: "ok", rows: await fetch(socketPath) };
  } catch (err) {
    return isInstanceGone(err) ? { kind: "gone" } : { kind: "failed" };
  }
}

/** What one instance's service read contributes to its `InstanceInfo`. */
type ServicesView = Pick<InstanceInfo, "status"> &
  Required<Pick<InstanceInfo, "services" | "namespaces" | "servicesRead">>;

/** Nothing read: nothing booted when stale, not known otherwise. */
function unreadView(status: InstanceStatus, servicesRead: ServicesRead): ServicesView {
  return { status, services: [], namespaces: status === "stale" ? [] : null, servicesRead };
}

/** Per-instance inputs to `readServicesView` beyond its socket. */
interface ViewInputs {
  readonly configDoc: DerivedConfigDoc;
  /** Services of a pending reload's marker, counted as booted (#226). */
  readonly pendingServices: ReadonlyArray<string>;
  readonly fetch: ((socketPath: string) => Promise<ServiceStatus[]>) | undefined;
}

/**
 * Read one instance's services and booted namespaces (#226), when it is
 * running and a reader was given. A failed or timed-out read is
 * `unresponsive`, never fatal; one that finds the instance gone lists it as
 * `stale`.
 */
async function readServicesView(
  stem: string,
  socketPath: string,
  status: InstanceStatus,
  inputs: ViewInputs,
): Promise<ServicesView> {
  if (status !== "running" || inputs.fetch === undefined) return unreadView(status, "skipped");
  const read = await safeGetServiceStatuses(socketPath, inputs.fetch);
  if (read.kind === "gone") return unreadView("stale", "skipped");
  if (read.kind === "failed") return unreadView(status, "unresponsive");
  const declared = readDeclaredNamespaces(inputs.configDoc);
  return {
    status,
    services: buildServices(
      read.rows,
      readPortsByService(inputs.configDoc),
      declared,
      kindFor(stem),
    ),
    namespaces: bootedNamespaces(read.rows, declared, inputs.pendingServices),
    servicesRead: "ok",
  };
}

/**
 * Discover every running, stale or unknown devtrees instance at `anchor`. The result
 * is the same primitive `devtrees ls` renders and `devtrees prune` walks — no
 * caller has to enumerate sockets themselves. Lock-free: no allocation-registry
 * write happens here.
 *
 * When `deps.getServiceStatuses` is provided, each running instance is
 * enriched with one shell-out to the driver, populating `services[]`. Stale
 * and unknown instances never see a driver call.
 */
export async function discoverInstances(
  anchor: string,
  deps: DiscoverDeps = {},
): Promise<InstanceInfo[]> {
  const sockets = listSockets(anchor);
  if (sockets.length === 0) return [];

  const registry = readRegistry(anchor);

  const infos = await Promise.all(
    sockets.map(async ({ stem, socketPath }): Promise<InstanceInfo> => {
      const paths = instancePaths(anchor, stem);
      // Read-only: discovery never unlinks a socket. An instance that stays
      // `unknown` after the retries is listed as such (#186) rather than
      // hidden, and gets no driver call, which would only hang on it.
      const status = await probeUntilDefinitive(
        socketPath,
        deps.probeSocket ?? ((path) => probeSocket(path)),
        deps.probeRetryDelaysMs,
      );
      const blockBase = registry[registryKeyFor(stem)];
      const configDoc = readDerivedConfig(paths.configPath);
      // Read-only, like the rest of discovery: `up` and `down` clear it.
      const pending = readPendingReload(anchor, stem);
      const view = await readServicesView(stem, socketPath, status, {
        configDoc,
        pendingServices: pending?.services ?? [],
        fetch: deps.getServiceStatuses,
      });
      return {
        id: stem,
        kind: kindFor(stem),
        socketPath,
        ports: flattenPorts(readPortsByProcess(configDoc)),
        blockBase,
        reloadPending: pending !== undefined,
        ...view,
      };
    }),
  );

  return infos.sort(compareInstances);
}

/**
 * Zip a driver's `ServiceStatus[]` with the per-service *declared* ports from
 * the derived config's `x-devtrees.ports_by_service` metadata (issue #110).
 * Ordering follows the driver's response — that's the order an agent walking
 * the array will naturally see services in. A service the metadata has no
 * entry for — and every service of a legacy instance whose config predates
 * the metadata (`portsByService === undefined`) — keeps an empty `ports: {}`.
 */
function buildServices(
  statuses: ReadonlyArray<ServiceStatus>,
  portsByService: Record<string, Record<string, number>> | undefined,
  declared: ReadonlyMap<string, DeclaredService> | undefined,
  kind: InstanceKind,
): ListedService[] {
  return statuses.map((s) => {
    const state = classifyService(s);
    const own = declared?.get(s.name);
    return {
      name: s.name,
      status: s.status,
      health: s.health,
      ports: portsByService?.[s.name] ?? {},
      namespaces: own !== undefined ? serviceNamespaces(own) : [...(s.namespaces ?? [])],
      tier: kind === "shared" ? "shared" : "isolated",
      state,
      ...(s.running === true && s.pid !== undefined ? { pid: s.pid } : {}),
    };
  });
}

/** One process of a derived config, as namespace selection reads it. */
interface DeclaredService {
  readonly name: string;
  readonly namespace?: Namespace;
}

/**
 * The derived config's processes with their declared `namespace` (#226), or
 * `undefined` when the config is not on disk. A malformed `namespace` reads
 * as none, i.e. `default`, as process-compose would place it.
 */
function readDeclaredNamespaces(
  doc: DerivedConfigDoc,
): ReadonlyMap<string, DeclaredService> | undefined {
  if (!isPlainRecord(doc.processes)) return undefined;
  const declared = new Map<string, DeclaredService>();
  for (const [name, proc] of Object.entries(doc.processes)) {
    const ns = proc?.namespace;
    const valid =
      typeof ns === "string" ||
      (Array.isArray(ns) && ns.length > 0 && ns.every((n) => typeof n === "string"));
    declared.set(name, valid ? { name, namespace: ns as Namespace } : { name });
  }
  return declared;
}

/**
 * The namespaces the instance booted (#226), read back the way a running `up`
 * reads them (ADR-0008): a namespace is booted when every service the derived
 * config declares in it is in the project. A pending reload's services count
 * as present (ADR-0005, #191): process-compose stops listing a service the
 * moment its update begins, while its old run may still be alive. Without a
 * derived config the namespaces are not known (`null`): what process-compose
 * reports per service cannot tell a booted namespace from one a multi-
 * namespace service only shares with it.
 */
function bootedNamespaces(
  rows: ReadonlyArray<ServiceStatus>,
  declared: ReadonlyMap<string, DeclaredService> | undefined,
  pendingServices: ReadonlyArray<string>,
): string[] | null {
  if (declared === undefined) return null;
  const present = new Set([...rows.map((r) => r.name), ...pendingServices]);
  return [...resolveRunningSelection([...declared.values()], present, undefined).namespaces];
}
