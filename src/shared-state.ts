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
}

function sharedStateFile(anchor: string): string {
  return join(anchor, "devtrees", "shared-state.json");
}

/** Narrow an unknown parse result to a `SharedState`, or `undefined`. */
function asSharedState(parsed: unknown): SharedState | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { hash, ports } = parsed as { hash?: unknown; ports?: unknown };
  if (typeof hash !== "string") return undefined;
  if (ports === null || typeof ports !== "object" || Array.isArray(ports)) return undefined;
  for (const value of Object.values(ports)) {
    if (typeof value !== "number") return undefined;
  }
  return { hash, ports: ports as Readonly<Record<string, number>> };
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
