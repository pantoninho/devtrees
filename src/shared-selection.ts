/**
 * Shared-service selection (#236, ADR-0010).
 *
 * Which shared services an `up` uses, and what the running shared instance
 * must do about them. A shared service with no `namespace:` is **always on**:
 * every `up` selects it, as before #236. A shared service with a `namespace:`
 * is selected only when the `up` selects one of its namespaces; it then joins
 * the one shared instance (ADR-0001) the first time some worktree selects it,
 * and stays there until `devtrees down --shared`.
 *
 * Drift is scoped the same way: a shared service whose definition differs
 * from the revision the running instance runs is `SHARED_DRIFT` only for an
 * `up` that selects it.
 *
 * Pure: no I/O. The caller hands in the stack, the selection and the
 * persisted shared state.
 */

import { sharedServiceHash, sharedStackHash } from "./hash.js";
import { namespaceSelected } from "./selection.js";
import type { SharedServiceRecord, SharedState } from "./shared-state.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

/** A shared service with no `namespace:` runs on every `up` (pre-#236 behaviour). */
export function isAlwaysOnShared(service: Pick<ResolvedService, "namespace">): boolean {
  return service.namespace === undefined;
}

/** The stack's shared services, in declaration order. */
export function sharedServicesOf(stack: ResolvedStack): ResolvedService[] {
  return stack.services.filter((s) => s.tier === "shared");
}

/** Does any shared service declare a namespace? Only then does selection matter. */
export function hasNamespacedShared(stack: ResolvedStack): boolean {
  return sharedServicesOf(stack).some((s) => !isAlwaysOnShared(s));
}

/**
 * The shared services an `up` selecting `namespaces` uses, in declaration
 * order: every always-on shared service, every namespaced one whose
 * namespaces intersect the selection, and — transitively — every shared
 * service those `depends_on`. A selected shared service's shared dependency
 * runs with it even when its own namespace is not selected: the shared
 * instance is repo-wide, so there is no "unselected" copy to fall back to,
 * and dropping the edge would start the dependent ungated.
 */
export function selectSharedServices(
  stack: ResolvedStack,
  namespaces: ReadonlyArray<string>,
): ResolvedService[] {
  const shared = sharedServicesOf(stack);
  const byName = new Map(shared.map((s) => [s.name, s]));
  const selected = new Set<string>();
  const visit = (service: ResolvedService): void => {
    if (selected.has(service.name)) return;
    selected.add(service.name);
    for (const dep of service.dependsOn) {
      const target = byName.get(dep.name);
      if (target !== undefined) visit(target);
    }
  };
  for (const service of shared) {
    if (isAlwaysOnShared(service) || namespaceSelected(service, namespaces)) visit(service);
  }
  return shared.filter((s) => selected.has(s.name));
}

/** Per-service records for services this worktree defines (revision + owned ports). */
export function sharedRecords(
  services: ReadonlyArray<ResolvedService>,
): Record<string, SharedServiceRecord> {
  return Object.fromEntries(
    services.map((s) => [s.name, { hash: sharedServiceHash(s), ports: [...s.ports] }]),
  );
}

/**
 * A revision marker for a running shared service whose definition the state
 * cannot attribute: the instance was started by a devtrees older than #236,
 * and this worktree's shared subset no longer matches its whole-subset hash.
 */
export const UNKNOWN_REVISION = "unknown";

/**
 * Give a pre-#236 shared state its per-service records. `running` is the
 * shared services the instance runs (the processes in its derived config).
 * When this worktree's definitions of exactly those services hash to the
 * persisted whole-subset `hash`, they ARE the running revisions and are
 * recorded as such. Otherwise the running revisions are unknown: each is
 * recorded as `UNKNOWN_REVISION`, so it drifts for an `up` that selects it —
 * the pre-#236 behaviour — and an `up` that does not select it is unaffected.
 */
export function withServiceRecords(
  state: SharedState,
  stack: ResolvedStack,
  running: ReadonlyArray<string>,
): SharedState {
  if (state.services !== undefined) return state;
  const runningSet = new Set(running);
  const mine = sharedServicesOf(stack).filter((s) => runningSet.has(s.name));
  const matches =
    mine.length === runningSet.size && sharedStackHash({ ...stack, services: mine }) === state.hash;
  if (matches) return { ...state, services: sharedRecords(mine) };
  const ports = new Map(mine.map((s) => [s.name, s.ports]));
  const services = Object.fromEntries(
    running.map((name) => [name, { hash: UNKNOWN_REVISION, ports: [...(ports.get(name) ?? [])] }]),
  );
  return { ...state, services };
}

/** One selected shared service whose definition differs from the running one. */
export interface SharedServiceDrift {
  readonly service: string;
  /** The revision the running shared instance runs (`UNKNOWN_REVISION` if unattributable). */
  readonly runningHash: string;
  /** This worktree's revision of the service. */
  readonly localHash: string;
}

/** A named port a not-yet-running shared service declares that a running one already owns. */
export interface SharedPortConflict {
  readonly service: string;
  readonly port: string;
  readonly owner: string;
}

/** What the running shared instance must do for one `up`'s selection. */
export interface SharedPlan {
  /** Selected services the instance runs at another revision: `SHARED_DRIFT`. */
  readonly drifted: ReadonlyArray<SharedServiceDrift>;
  /** Selected services the instance does not run yet: added to it (activated). */
  readonly missing: ReadonlyArray<ResolvedService>;
  /** Port names a missing service would take from a running one: also `SHARED_DRIFT`. */
  readonly portConflicts: ReadonlyArray<SharedPortConflict>;
}

/**
 * Decide, for the selected shared services, which drifted and which must be
 * added to the running instance. Services the `up` does not select are never
 * looked at: their drift is some other `up`'s business (#236).
 */
export function planSharedSelection(
  selected: ReadonlyArray<ResolvedService>,
  running: Readonly<Record<string, SharedServiceRecord>>,
): SharedPlan {
  const drifted: SharedServiceDrift[] = [];
  const missing: ResolvedService[] = [];
  for (const service of selected) {
    const record = running[service.name];
    if (record === undefined) {
      missing.push(service);
      continue;
    }
    const localHash = sharedServiceHash(service);
    if (record.hash !== localHash) {
      drifted.push({ service: service.name, runningHash: record.hash, localHash });
    }
  }
  const owners = new Map<string, string>();
  for (const [name, record] of Object.entries(running)) {
    for (const port of record.ports) owners.set(port, name);
  }
  const portConflicts = missing.flatMap((service) =>
    service.ports.flatMap((port) => {
      const owner = owners.get(port);
      return owner === undefined ? [] : [{ service: service.name, port, owner }];
    }),
  );
  return { drifted, missing, portConflicts };
}
