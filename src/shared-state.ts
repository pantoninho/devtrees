/**
 * Shared-state store — the running shared instance's identity (issue #83).
 *
 * Persists, at `<anchor>/devtrees/shared-state.json`, what the shared
 * instance actually started with:
 *
 *  - `hash`: the shared-subset hash (`sharedStackHash`) of the stack the
 *    instance was derived from;
 *  - `ports`: the name→port map it bound (named port env var → concrete
 *    number).
 *
 * Written by the lazy-start path in `runUp` (the single place the shared
 * instance is spawned) and read by every subsequent `up`/`env` in any
 * worktree, making the *running instance* — not each worktree's local
 * `devtrees.yaml` ordering — the source of truth for shared connection
 * info. Worktrees on divergent branches therefore cannot silently inject
 * port numbers the shared instance never bound: matching subsets read the
 * map, diverging subsets fail with `SHARED_DRIFT`.
 *
 * Like the rest of the anchor state (CONTEXT.md "Anchor state") it lives
 * inside the git common dir, so it needs no `.gitignore` entry. Corrupt or
 * structurally-wrong content is treated as absent — the caller falls back
 * to the legacy positional computation rather than crashing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the running shared instance was started with. */
export interface SharedState {
  /** `sharedStackHash` of the stack the running shared instance was derived from. */
  readonly hash: string;
  /** Named port env var → the concrete number the shared instance bound. */
  readonly ports: Readonly<Record<string, number>>;
  /**
   * Per shared service, the process-compose fields `hash` does not cover
   * (`sharedExtendedFields`, #185). Optional: state files written before #185
   * lack it, and then no change can be detected.
   */
  readonly extended?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Per shared service the instance runs, its revision (`sharedServiceHash`)
   * and the named ports it owns (#236). This is what scopes `SHARED_DRIFT` to
   * the shared services an `up` selects, and what lets a later `up` add a
   * namespaced shared service to the running instance without touching the
   * others. Optional: state written before #236 lacks it, and the caller
   * reconstructs it from `hash` when that still matches.
   */
  readonly services?: Readonly<Record<string, SharedServiceRecord>>;
}

/** One shared service the running shared instance runs (#236). */
export interface SharedServiceRecord {
  /** `sharedServiceHash` of the definition the instance runs. */
  readonly hash: string;
  /** The named ports (env var names) this service owns in `SharedState.ports`. */
  readonly ports: ReadonlyArray<string>;
}

/** One extended field of a shared service that changed since shared started. */
export interface SharedFieldChange {
  readonly service: string;
  readonly field: string;
}

/**
 * Fields of `current` that differ from what the running shared instance
 * recorded. Empty when the state predates #185 (nothing to compare). Services
 * or fields missing on either side are skipped: add/remove is `SHARED_DRIFT`'s
 * business, not this warning's.
 */
export function sharedFieldChanges(
  state: SharedState,
  current: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): SharedFieldChange[] {
  if (state.extended === undefined) return [];
  const changes: SharedFieldChange[] = [];
  for (const [service, fields] of Object.entries(current)) {
    const recorded = state.extended[service];
    if (recorded === undefined) continue;
    for (const [field, value] of Object.entries(fields)) {
      if (!(field in recorded)) continue;
      if (JSON.stringify(recorded[field]) !== JSON.stringify(value)) {
        changes.push({ service, field });
      }
    }
  }
  return changes;
}

function sharedStateFile(anchor: string): string {
  return join(anchor, "devtrees", "shared-state.json");
}

/** Narrow an unknown parse result to a `SharedState`, or `undefined`. */
function asSharedState(parsed: unknown): SharedState | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { hash, ports, extended, services } = parsed as {
    hash?: unknown;
    ports?: unknown;
    extended?: unknown;
    services?: unknown;
  };
  if (typeof hash !== "string") return undefined;
  if (!isPlainObject(ports) || !Object.values(ports).every((v) => typeof v === "number")) {
    return undefined;
  }
  const parsedExtended = asExtended(extended);
  const parsedServices = asServices(services);
  return {
    hash,
    ports: ports as Readonly<Record<string, number>>,
    ...(parsedExtended !== undefined ? { extended: parsedExtended } : {}),
    ...(parsedServices !== undefined ? { services: parsedServices } : {}),
  };
}

const isServiceRecord = (v: unknown): v is SharedServiceRecord =>
  isPlainObject(v) &&
  typeof v.hash === "string" &&
  Array.isArray(v.ports) &&
  v.ports.every((p) => typeof p === "string");

/**
 * A malformed `services` map is dropped, not fatal: the caller then treats
 * the state as pre-#236 and falls back to the whole-subset `hash`.
 */
function asServices(value: unknown): SharedState["services"] {
  if (!isPlainObject(value)) return undefined;
  return Object.values(value).every(isServiceRecord)
    ? (value as NonNullable<SharedState["services"]>)
    : undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A malformed `extended` is dropped, not fatal: it only feeds a warning. */
function asExtended(value: unknown): SharedState["extended"] {
  if (!isPlainObject(value)) return undefined;
  return Object.values(value).every(isPlainObject)
    ? (value as NonNullable<SharedState["extended"]>)
    : undefined;
}

/**
 * Read the persisted shared state, or `undefined` when absent / unreadable.
 * Tolerant by design: a corrupt file must degrade to "no state" (legacy
 * fallback), never crash an `up`.
 */
export function readSharedState(anchor: string): SharedState | undefined {
  const file = sharedStateFile(anchor);
  if (!existsSync(file)) return undefined;
  try {
    return asSharedState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Persist (or overwrite) the shared state. Called only at shared start. */
export function writeSharedState(anchor: string, state: SharedState): void {
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  writeFileSync(sharedStateFile(anchor), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
