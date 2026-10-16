/**
 * The pure half of `devtrees down --shared -n <namespace>` (#239, ADR-0012):
 * which shared services a namespaced shared teardown removes, who still
 * depends on them, and what it leaves of the shared derived config and the
 * shared state. The orchestration (the shared lock, the bounded stop, the
 * config reload) is `runSharedNamespaceDown` in src/commands.ts.
 *
 * Pure: no I/O. The caller reads the shared derived config, the shared
 * instance's `process list`, every live worktree instance's derived config
 * and the shared state, and hands them in.
 */

import { DEVTREES_METADATA_KEY, type DerivedConfig } from "./deriver.js";
import type { ServiceStatus } from "./driver.js";
import {
  DEFAULT_NAMESPACE,
  formatUpCommand,
  namespaceSelected,
  serviceNamespaces,
} from "./selection.js";
import { keepsInstanceAlive } from "./service-state.js";
import type { SharedState } from "./shared-state.js";
import { isAlwaysOnShared, sharedServicesOf } from "./shared-selection.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

/**
 * Something that still depends on a shared service the teardown would
 * remove. `instance` is a worktree id, or `shared` for a shared service the
 * teardown would keep.
 */
export interface SharedDependant {
  readonly instance: string;
  /** The dependent service; `null` when devtrees could not tell which. */
  readonly service: string | null;
  /** The targeted shared services it depends on (empty when not known). */
  readonly depends_on: ReadonlyArray<string>;
  /**
   * Where the edge was read: the shared derived config (`shared_config`),
   * a worktree's derived config (`derived_config`), its `devtrees.yaml`, for
   * an instance started before #239 (`devtrees_yaml`), or nowhere, so the
   * instance is counted as a dependant to be safe (`unknown`). A worktree
   * whose lifecycle lock is held (an `up`, `down` or `restart` in flight) is
   * one too, since what it is about to start cannot be read yet
   * (`lifecycle_in_progress`).
   */
  readonly source:
    | "shared_config"
    | "derived_config"
    | "devtrees_yaml"
    | "unknown"
    | "lifecycle_in_progress";
}

/** What a namespaced shared teardown would do to the shared instance's config. */
export interface SharedDownPlan {
  /** The shared services in the named namespaces, in config order. */
  readonly targets: ReadonlyArray<string>;
  /** Named namespaces with no shared service in the shared instance. */
  readonly inactiveNamespaces: ReadonlyArray<string>;
  /** The shared services the teardown keeps. */
  readonly remaining: ReadonlyArray<string>;
  /** Kept shared services that `depends_on` a target: never overridable. */
  readonly sharedDependants: ReadonlyArray<SharedDependant>;
}

/**
 * Pick the shared services `down --shared -n` removes: every process of the
 * shared derived config that declares a `namespace:` and has one of
 * `namespaces` among them (a list-valued one counts if any matches, as for
 * `up`). An always-on shared service (no `namespace:`) is in no namespace, so
 * it is never a target, not even of `-n default`: only a full
 * `down --shared` stops it.
 */
export function planSharedDown(
  config: Pick<DerivedConfig, "processes"> | undefined,
  namespaces: ReadonlyArray<string>,
): SharedDownPlan {
  const processes = Object.entries(config?.processes ?? {});
  const targets = processes
    .filter(([, proc]) => proc.namespace !== undefined && namespaceSelected(proc, namespaces))
    .map(([name]) => name);
  const targeted = new Set(targets);
  const active = new Set(
    processes.filter(([name]) => targeted.has(name)).flatMap(([, proc]) => serviceNamespaces(proc)),
  );
  const sharedDependants = processes.flatMap(([name, proc]) => {
    if (targeted.has(name)) return [];
    const on = Object.keys(proc.depends_on ?? {}).filter((dep) => targeted.has(dep));
    return on.length === 0
      ? []
      : [{ instance: "shared", service: name, depends_on: on, source: "shared_config" as const }];
  });
  return {
    targets,
    inactiveNamespaces: [...new Set(namespaces)].filter((ns) => !active.has(ns)),
    remaining: processes.map(([name]) => name).filter((name) => !targeted.has(name)),
    sharedDependants,
  };
}

/**
 * Does removing the targets end the shared instance? process-compose exits
 * once nothing runs, so when no kept service is running now
 * (`keepsInstanceAlive`), the namespaced teardown is a full `down --shared`.
 */
export function removesLastRunning(
  rows: ReadonlyArray<ServiceStatus>,
  remaining: ReadonlyArray<string>,
): boolean {
  const kept = new Set(remaining);
  return !rows.some((r) => kept.has(r.name) && keepsInstanceAlive(r));
}

/** One live worktree instance, as the dependant check reads it. */
export interface WorktreeEdges {
  readonly instance: string;
  /** Isolated service → the shared services it `depends_on`; `undefined` when unreadable. */
  readonly edges: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
  readonly source: "derived_config" | "devtrees_yaml";
  /** The services the instance booted; `undefined` when its `process list` could not be read. */
  readonly booted: ReadonlySet<string> | undefined;
}

/**
 * The isolated services of live worktree instances that `depends_on` a
 * target. Only a booted service counts (one in the instance's project:
 * running, starting or crashed, not one in a namespace the instance did not
 * boot). An instance whose services could not be read counts every edge,
 * and one whose edges could not be read is itself a dependant (`unknown`).
 */
export function worktreeDependants(
  instances: ReadonlyArray<WorktreeEdges>,
  targets: ReadonlyArray<string>,
): SharedDependant[] {
  const targeted = new Set(targets);
  return instances.flatMap((inst): SharedDependant[] => {
    if (inst.edges === undefined) {
      return [{ instance: inst.instance, service: null, depends_on: [], source: "unknown" }];
    }
    return Object.entries(inst.edges).flatMap(([service, on]) => {
      if (inst.booted !== undefined && !inst.booted.has(service)) return [];
      const hit = on.filter((dep) => targeted.has(dep));
      return hit.length === 0
        ? []
        : [{ instance: inst.instance, service, depends_on: hit, source: inst.source }];
    });
  });
}

/**
 * The worktrees with a lifecycle command in flight (`held`, their lock
 * holders alive), as dependants. Listed even when the worktree's instance
 * was already found by its edges: the command in flight may be changing
 * them, and it is what the teardown waits for.
 */
export function inProgressDependants(held: ReadonlyArray<string>): SharedDependant[] {
  return [...new Set(held)].map((id) => ({
    instance: id,
    service: null,
    depends_on: [],
    source: "lifecycle_in_progress" as const,
  }));
}

/** A worktree's isolated → shared edges from its `devtrees.yaml` (instances started before #239). */
export function stackSharedEdges(stack: ResolvedStack): Record<string, string[]> {
  const shared = new Set(stack.services.filter((s) => s.tier === "shared").map((s) => s.name));
  const edges: Record<string, string[]> = {};
  for (const service of stack.services) {
    if (service.tier !== "isolated") continue;
    const on = service.dependsOn.map((d) => d.name).filter((name) => shared.has(name));
    if (on.length > 0) edges[service.name] = on;
  }
  return edges;
}

/** A derived worktree config's recorded isolated → shared edges (#239), when it has them. */
export function recordedSharedEdges(
  config: DerivedConfig | undefined,
): Readonly<Record<string, ReadonlyArray<string>>> | undefined {
  return config?.[DEVTREES_METADATA_KEY]?.shared_depends_on;
}

/**
 * The shared derived config without `names`: their processes and their
 * `ports_by_service` entries. Every other process is kept exactly as it is,
 * so process-compose's reload leaves it running (ADR-0010).
 */
export function withoutProcesses(
  config: DerivedConfig,
  names: ReadonlyArray<string>,
): DerivedConfig {
  const drop = new Set(names);
  const keep = <V>(record: Readonly<Record<string, V>>): Record<string, V> =>
    Object.fromEntries(Object.entries(record).filter(([name]) => !drop.has(name)));
  const meta = config[DEVTREES_METADATA_KEY];
  return {
    ...config,
    processes: keep(config.processes),
    [DEVTREES_METADATA_KEY]: { ...meta, ports_by_service: keep(meta?.ports_by_service ?? {}) },
  };
}

/**
 * The shared state once `names` are removed from the running instance: their
 * revision records (`services`) and their extended fields go, so the next
 * `up` that selects them adds them fresh with its own definition, and no
 * `SHARED_DRIFT` can come from the definition they ran.
 *
 * Their named ports go too: `ports` records what the running instance binds,
 * and nothing binds them any more. Keeping the number for a re-activation is
 * the stable shared port map's job (#238, `shared-ports.json`), not this
 * file's. A port a kept service also owns stays. The whole-subset `hash`
 * covers always-on services only, which a namespaced teardown never removes,
 * so it is unchanged.
 */
export function withoutServiceRecords(
  state: SharedState,
  names: ReadonlyArray<string>,
): SharedState {
  const drop = new Set(names);
  const keep = <V>(record: Readonly<Record<string, V>> | undefined) =>
    record === undefined
      ? undefined
      : Object.fromEntries(Object.entries(record).filter(([name]) => !drop.has(name)));
  const services = keep(state.services);
  const extended = keep(state.extended);
  const kept = new Set(Object.values(services ?? {}).flatMap((r) => r.ports));
  const freed = new Set(
    names.flatMap((name) => state.services?.[name]?.ports ?? []).filter((p) => !kept.has(p)),
  );
  const ports = Object.fromEntries(Object.entries(state.ports).filter(([p]) => !freed.has(p)));
  return {
    hash: state.hash,
    ports,
    ...(extended !== undefined ? { extended } : {}),
    ...(services !== undefined ? { services } : {}),
  };
}

/**
 * The namespaced recovery for drifted or dead shared services `names` (#239):
 * a forced `down --shared -n` for their namespaces, then the same `up`
 * (`upNamespaces`), which leaves the other shared services running.
 * `undefined` when only the full teardown can work: a named service is
 * always-on, or an always-on one depends on them. A service's namespace is
 * the one the `up` selects it by, or its own first one when it came in as a
 * dependency.
 *
 * `--force` is part of it on purpose. The service is already drifted or dead
 * for every worktree that uses it, and those worktrees, the caller's
 * included, are exactly the dependants that would otherwise refuse the
 * teardown (`SHARED_IN_USE`), so without it the remedy would fail on its
 * first run. Forcing interrupts them as the full `down --shared` would, but
 * stops only these namespaces' shared services, never more than it. A shared
 * service outside them that depends on one would still refuse (a shared
 * dependant is never forceable), so its namespaces are added.
 */
export function namespacedRecoveryRemedy(
  stack: ResolvedStack,
  upNamespaces: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
): string | undefined {
  const shared = sharedServicesOf(stack);
  const byName = new Map(shared.map((s) => [s.name, s]));
  const services = names.map((n) => byName.get(n));
  if (services.length === 0 || services.some((s) => s === undefined || isAlwaysOnShared(s))) {
    return undefined;
  }
  const ns = new Set(
    (services as ResolvedService[]).map((s) => {
      const own = serviceNamespaces(s);
      return own.find((n) => upNamespaces.includes(n)) ?? own[0] ?? DEFAULT_NAMESPACE;
    }),
  );
  const closed = closeOverSharedDependants(shared, ns);
  if (closed === undefined) return undefined;
  const down = ["devtrees down --shared", ...[...closed].map((n) => `-n ${n}`), "--force"];
  return `${down.join(" ")} && ${formatUpCommand(stack.services, upNamespaces)}`;
}

/**
 * Grow `namespaces` until no shared service outside them depends on one in
 * them (a teardown of them would refuse it, unforceably); `undefined` when
 * an always-on shared service does, which no namespaced teardown can take.
 */
function closeOverSharedDependants(
  shared: ReadonlyArray<ResolvedService>,
  namespaces: ReadonlySet<string>,
): Set<string> | undefined {
  const ns = new Set(namespaces);
  const inside = (s: ResolvedService) => !isAlwaysOnShared(s) && namespaceSelected(s, [...ns]);
  for (let grew = true; grew; ) {
    grew = false;
    const targets = new Set(shared.filter(inside).map((s) => s.name));
    for (const s of shared) {
      if (inside(s) || !s.dependsOn.some((d) => targets.has(d.name))) continue;
      if (isAlwaysOnShared(s)) return undefined;
      for (const n of serviceNamespaces(s)) ns.add(n);
      grew = true;
    }
  }
  return ns;
}
