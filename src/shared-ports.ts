/**
 * Stable shared ports (#238, ADR-0011).
 *
 * The shared port map — `<anchor>/devtrees/shared-ports.json` — records, per
 * shared named port, the number devtrees handed out the first time any `up`
 * predicted or bound it. From then on every branch reads that number, so two
 * worktrees whose `devtrees.yaml` lay out the shared services differently
 * still agree on each name's port, and activating a namespaced shared service
 * never moves a port some consumer was already given.
 *
 * The map is anchor state, like the shared state (`shared-state.json`) and
 * the allocation registry, and outlives the shared instance: `down --shared`
 * keeps it, exactly as it keeps the `__shared__` registry block (#51). It is
 * written only by `up`, under the shared lifecycle lock; `env` and
 * `up --dry-run` read it and never write it.
 *
 * Separate from `shared-state.json` on purpose: that file describes what the
 * RUNNING instance was started with and is rewritten at every lazy start; the
 * map is a repo-wide reservation that must survive those rewrites.
 *
 * The pure part reconciles the persisted map with what a running instance
 * already handed out (its bound ports and the env its processes got), so a
 * shared instance started before #238 seeds the map from its live numbers on
 * first contact, and anything that would hand one port to two names comes
 * back as a conflict instead of being resolved silently.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The repo-wide shared port block: its base and size. */
export interface SharedBlock {
  readonly base: number;
  readonly size: number;
}

/** Where a shared port's number comes from, as `env --json` and `ls --json` report it. */
export type SharedPortOrigin = "active" | "recorded" | "predicted";

/** One shared named port with its number and origin. */
export interface SharedPortEntry {
  readonly port: number;
  readonly origin: SharedPortOrigin;
}

/** Name → port, the persisted stable map. */
export type SharedPortMap = Readonly<Record<string, number>>;

/** Path of the persisted shared port map. */
export function sharedPortMapFile(anchor: string): string {
  return join(anchor, "devtrees", "shared-ports.json");
}

/**
 * Read the persisted map, or `undefined` when it is absent or unreadable. A
 * corrupt file degrades to "no map": the next `up` seeds it again from the
 * running instance, so nothing it handed out moves.
 */
export function readSharedPortMap(anchor: string): SharedPortMap | undefined {
  const file = sharedPortMapFile(anchor);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { ports?: unknown };
    const ports = parsed?.ports;
    if (ports === null || typeof ports !== "object" || Array.isArray(ports)) return undefined;
    const entries = Object.entries(ports as Record<string, unknown>);
    return entries.every(([, v]) => Number.isInteger(v))
      ? (Object.fromEntries(entries) as Record<string, number>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the map. Called only by `up`, under the shared lifecycle lock. */
export function writeSharedPortMap(anchor: string, ports: SharedPortMap): void {
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  const doc = { version: 1, ports };
  writeFileSync(sharedPortMapFile(anchor), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/**
 * What the shared instance already handed out: the named ports its services
 * bind (`shared-state.json`'s `ports`) and, per process in its derived config,
 * the shared port numbers that process's env holds.
 */
export interface LiveSharedPorts {
  readonly bound: SharedPortMap;
  readonly processEnv: Readonly<Record<string, SharedPortMap>>;
}

/**
 * Why a shared port cannot be resolved without handing one port to two names
 * or moving a number someone was given:
 *
 *  - `port_taken`: two names claim one number — the map records it twice, or
 *    a running service binds a number the map records for another name.
 *  - `bound_mismatch`: a running service binds a name at a number other than
 *    the recorded one.
 *  - `stale_env`: a running shared process was given a number for a name that
 *    is not the recorded one (or that belongs to another name).
 */
export type PortMapConflictReason = "port_taken" | "bound_mismatch" | "stale_env";

/** One shared port that cannot be resolved cleanly. */
export interface PortMapConflict {
  readonly reason: PortMapConflictReason;
  readonly portName: string;
  /** The contested number: the one claimed for `portName`. */
  readonly port: number;
  /** The number the map holds for `portName`, when it holds one. */
  readonly recordedPort?: number;
  /** The other name that holds `port`, for `port_taken`. */
  readonly holder?: string;
  /** The running shared process whose env holds `port`, for `stale_env`. */
  readonly process?: string;
}

/** The map reconciled with a running instance's numbers. */
export interface ReconciledPortMap {
  /** Recorded entries plus the live numbers seeded into it. */
  readonly map: Record<string, number>;
  /** Names this reconciliation added from live numbers (not yet persisted). */
  readonly seeded: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<PortMapConflict>;
}

/** One claim of `port` for `name`, and what to report if it is refused. */
interface Claim {
  readonly name: string;
  readonly port: number;
  readonly source: "recorded" | "bound" | "env";
  readonly process?: string;
}

/**
 * Reconcile the persisted map (`recorded`; `undefined` before #238) with what
 * a shared instance handed out (`live`). The first claim of a number wins, in
 * this order: recorded entries, bound ports, then the env of each process.
 * A claim that agrees with the map is a no-op; a claim for an unrecorded name
 * on a free number seeds it; anything else is a conflict and changes nothing.
 *
 * `isSharedEnvEntry` says which `KEY=NUMBER` env entries are shared ports
 * (the shared processes' env also carries the author's own `environment:`).
 */
export function reconcileSharedPortMap(
  recorded: SharedPortMap | undefined,
  live: LiveSharedPorts | undefined,
  isSharedEnvEntry: (name: string, port: number) => boolean,
): ReconciledPortMap {
  const map: Record<string, number> = {};
  const owner = new Map<number, string>();
  const seeded: string[] = [];
  const conflicts: PortMapConflict[] = [];
  const claim = (c: Claim): void => {
    const conflict = refusal(c, map[c.name], owner.get(c.port));
    if (conflict !== undefined) {
      conflicts.push(conflict);
      return;
    }
    if (map[c.name] !== undefined) return;
    map[c.name] = c.port;
    owner.set(c.port, c.name);
    if (c.source !== "recorded") seeded.push(c.name);
  };
  for (const [name, port] of Object.entries(recorded ?? {})) {
    claim({ name, port, source: "recorded" });
  }
  for (const [name, port] of Object.entries(live?.bound ?? {})) {
    claim({ name, port, source: "bound" });
  }
  for (const [process, env] of Object.entries(live?.processEnv ?? {})) {
    for (const [name, port] of Object.entries(env)) {
      if (isSharedEnvEntry(name, port)) claim({ name, port, source: "env", process });
    }
  }
  return { map, seeded, conflicts };
}

/** The conflict a claim raises against the map so far, or `undefined` if it is fine. */
function refusal(
  c: Claim,
  recordedPort: number | undefined,
  holder: string | undefined,
): PortMapConflict | undefined {
  if (recordedPort === c.port) return undefined;
  if (recordedPort === undefined && (holder === undefined || holder === c.name)) return undefined;
  const base = {
    portName: c.name,
    port: c.port,
    ...(recordedPort !== undefined ? { recordedPort } : {}),
  };
  if (c.source === "env") return { ...base, reason: "stale_env", process: c.process };
  if (recordedPort !== undefined) return { ...base, reason: "bound_mismatch" };
  return { ...base, reason: "port_taken", holder };
}

/** The ports for `names`, and which of them the map did not hold yet. */
export interface AssignedSharedPorts {
  readonly ports: Record<string, number>;
  /** Names newly given a number (to be recorded), in declaration order. */
  readonly assigned: ReadonlyArray<string>;
}

/**
 * Resolve every shared named port in `names` (declaration order). A recorded
 * name keeps its number, always. An unrecorded name takes its positional
 * number in the shared block when no recorded name holds it — the number a
 * fresh shared start always used, so a stack seen for the first time gets the
 * same ports as before #238 — and otherwise the lowest number in the block no
 * recorded or newly assigned name holds. Recorded names this stack does not
 * declare (another branch's) still reserve their numbers.
 */
export function assignSharedPorts(args: {
  readonly names: ReadonlyArray<string>;
  readonly map: SharedPortMap;
  readonly positional: (name: string) => number | undefined;
  readonly block: SharedBlock | undefined;
}): AssignedSharedPorts {
  const ports: Record<string, number> = {};
  const assigned: string[] = [];
  const taken = new Set(Object.values(args.map));
  for (const name of args.names) {
    const recorded = args.map[name];
    if (recorded !== undefined) {
      ports[name] = recorded;
      continue;
    }
    if (ports[name] !== undefined) continue;
    const positional = args.positional(name);
    const port =
      positional !== undefined && !taken.has(positional)
        ? positional
        : lowestFree(args.block, taken);
    if (port === undefined) continue;
    ports[name] = port;
    taken.add(port);
    assigned.push(name);
  }
  return { ports, assigned };
}

function lowestFree(block: SharedBlock | undefined, used: ReadonlySet<number>): number | undefined {
  if (block === undefined) return undefined;
  for (let port = block.base; port < block.base + block.size; port++) {
    if (!used.has(port)) return port;
  }
  return undefined;
}

/**
 * Each port's origin: `active` when a running shared service binds it,
 * `recorded` when the persisted map holds it at that number, else
 * `predicted` (this read computed it; the next `up` records it).
 */
export function sharedPortOrigins(
  ports: SharedPortMap,
  recorded: SharedPortMap | undefined,
  active: SharedPortMap,
): Record<string, SharedPortEntry> {
  const origin = (name: string, port: number): SharedPortOrigin => {
    if (active[name] === port) return "active";
    if (recorded?.[name] === port) return "recorded";
    return "predicted";
  };
  return Object.fromEntries(
    Object.entries(ports).map(([name, port]) => [name, { port, origin: origin(name, port) }]),
  );
}

/** The loose shape of a derived config's processes this module reads env from. */
type ProcessesWithEnv = Readonly<
  Record<string, { readonly environment?: ReadonlyArray<unknown> } | null | undefined>
>;

/**
 * The live numbers of a shared instance: `bound` (its state's `ports`) and the
 * `KEY=NUMBER` entries of each derived process's env, the last one winning per
 * key, as process-compose applies them.
 */
export function liveSharedPortsOf(
  bound: SharedPortMap | undefined,
  processes: ProcessesWithEnv | undefined,
): LiveSharedPorts {
  const processEnv: Record<string, Record<string, number>> = {};
  for (const [name, proc] of Object.entries(processes ?? {})) {
    const env: Record<string, number> = {};
    for (const entry of proc?.environment ?? []) {
      const match = typeof entry === "string" ? /^([^=]+)=(\d+)$/.exec(entry) : null;
      if (match?.[1] !== undefined) env[match[1]] = Number(match[2]);
    }
    processEnv[name] = env;
  }
  return { bound: bound ?? {}, processEnv };
}

/** The resolved shared ports for one stack, and what `up` must record. */
export interface SharedPortPlan {
  /** This stack's shared named ports → number. */
  readonly ports: Record<string, number>;
  /** The full map to persist: recorded, seeded and newly assigned names. */
  readonly map: Record<string, number>;
  /** Whether `map` differs from what is persisted (absent counts as different). */
  readonly changed: boolean;
  /**
   * Conflicts that matter: every one when the shared instance is running;
   * only those between recorded entries otherwise (a fresh start re-derives
   * every process from the map, so a dead instance's numbers cannot be stale).
   */
  readonly conflicts: ReadonlyArray<PortMapConflict>;
}

/**
 * Resolve the shared ports for a stack declaring `names` (declaration order):
 * reconcile the persisted map with the shared instance's live numbers, then
 * give each unrecorded name a number (`assignSharedPorts`). Pure; `up`
 * persists `map` when `changed`, `env` and `up --dry-run` only read it.
 */
export function planSharedPorts(input: {
  readonly names: ReadonlyArray<string>;
  readonly recorded: SharedPortMap | undefined;
  readonly live: LiveSharedPorts;
  /** The shared instance is running, so its live numbers are in use. */
  readonly running: boolean;
  readonly positional: (name: string) => number | undefined;
  readonly block: SharedBlock | undefined;
}): SharedPortPlan {
  const known = new Set([
    ...input.names,
    ...Object.keys(input.recorded ?? {}),
    ...Object.keys(input.live.bound),
  ]);
  const inBlock = (port: number): boolean =>
    input.block !== undefined &&
    port >= input.block.base &&
    port < input.block.base + input.block.size;
  const reconciled = reconcileSharedPortMap(
    input.recorded,
    input.live,
    (name, port) => known.has(name) || inBlock(port),
  );
  const { ports, assigned } = assignSharedPorts({ ...input, map: reconciled.map });
  const map = { ...reconciled.map, ...pickPorts(ports, assigned) };
  const changed =
    input.recorded === undefined || reconciled.seeded.length > 0 || assigned.length > 0;
  const conflicts = input.running
    ? reconciled.conflicts
    : reconciled.conflicts.filter((c) => betweenRecorded(c, input.recorded));
  return { ports, map, changed, conflicts };
}

/** A conflict between two recorded entries, which no restart can clear. */
function betweenRecorded(c: PortMapConflict, recorded: SharedPortMap | undefined): boolean {
  return (
    c.reason === "port_taken" &&
    c.holder !== undefined &&
    recorded?.[c.portName] === c.port &&
    recorded[c.holder] === c.port
  );
}

function pickPorts(ports: SharedPortMap, names: ReadonlyArray<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of names) {
    const port = ports[name];
    if (port !== undefined) out[name] = port;
  }
  return out;
}

/**
 * The conflicts that must fail this `up` (or `env`), given the shared named
 * ports its stack declares — every one is injected into its worktree — and
 * the ones it is about to bind by starting or adding their services:
 *
 *  - `port_taken` / `bound_mismatch` fail any `up` that declares one of the
 *    names involved: resolving it would inject one number under two names,
 *    or move a number someone was already given.
 *  - `stale_env` fails an `up` that would start the service owning the name:
 *    a running shared process holds another number for it, and devtrees
 *    never restarts a running shared service (ADR-0008). Otherwise it is a
 *    warning (`staleEnvWarning`): the stale number is already in that
 *    process's env, and nothing this `up` does changes it.
 */
export function blockingPortConflicts(
  conflicts: ReadonlyArray<PortMapConflict>,
  declared: ReadonlySet<string>,
  binding: ReadonlySet<string>,
): PortMapConflict[] {
  return conflicts.filter((c) =>
    c.reason === "stale_env"
      ? binding.has(c.portName)
      : declared.has(c.portName) || (c.holder !== undefined && declared.has(c.holder)),
  );
}

/** One line per stale env entry a running shared process holds (#238). */
export function staleEnvWarning(c: PortMapConflict): string {
  const recorded = c.recordedPort === undefined ? "" : ` (recorded: ${c.recordedPort})`;
  return (
    `devtrees up: running shared service '${c.process ?? "?"}' was started with ` +
    `${c.portName}=${c.port}${recorded}, which is not ${c.portName}'s recorded port; it keeps ` +
    `that env until \`devtrees down --shared\` (a running shared service is never restarted).`
  );
}
