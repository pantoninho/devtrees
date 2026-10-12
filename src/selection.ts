/**
 * Namespace selection (ADR-0008, issues #128 / #170 / #177).
 *
 * Which of a stack's services an `up` targets. Two callers, one vocabulary:
 *
 *   - **Fresh start** (`resolveFreshSelection` in commands.ts, #176) narrows
 *     by the `-n` values it forwards to process-compose — `default` alone on
 *     a bare `up` — with `namespaceSelected`.
 *   - **Running instance** reads the boot-time selection back from the
 *     process-compose project (`resolveRunningSelection`): a bare `up`
 *     targets the namespaces whose declared services are all present, and an
 *     explicit `-n` is exact but must name namespaces the instance booted.
 *
 * Pure: no I/O. Callers hand in the declared services and, for a running
 * instance, the names process-compose reports.
 */

import type { ResolvedService } from "./stack.js";

/**
 * Process-compose's `default` namespace — where a service with no explicit
 * `namespace:` lands. `-n default` therefore selects exactly the unlabelled
 * services (issue #128).
 */
export const DEFAULT_NAMESPACE = "default";

/**
 * The namespaces a service belongs to — its declared one(s), or the implicit
 * `default`. A list-valued `namespace:` (ADR-0008, #179) contributes every
 * entry, so membership checks read "selected if ANY of its namespaces is".
 */
export function serviceNamespaces(service: Pick<ResolvedService, "namespace">): string[] {
  const ns = service.namespace;
  if (ns === undefined) return [DEFAULT_NAMESPACE];
  return typeof ns === "string" ? [ns] : [...ns];
}

/**
 * Is this service part of the selected namespace set (issue #128)? A service
 * is selected iff one of its namespaces — the implicit `default` when
 * unlabelled — is among the selected values. This mirrors what
 * process-compose's `-n` actually starts. Exact: the fresh path resolves a
 * bare `up` to `["default"]` first (`resolveFreshSelection`, #176), and the
 * running path to the booted namespaces, so there is no "empty means all"
 * case — an empty list selects nothing.
 */
export function namespaceSelected(
  service: Pick<ResolvedService, "namespace">,
  namespaces: ReadonlyArray<string>,
): boolean {
  return serviceNamespaces(service).some((ns) => namespaces.includes(ns));
}

/** Distinct namespaces the given services declare, sorted, `default` included when used. */
export function declaredNamespaces(
  services: ReadonlyArray<Pick<ResolvedService, "namespace">>,
): string[] {
  return [...new Set(services.flatMap(serviceNamespaces))].sort();
}

/** A requested namespace the running instance did not boot (ADR-0008). */
export interface NamespaceNotRunning {
  readonly namespace: string;
  /** Its declared services that are absent from the process-compose project. */
  readonly missingServices: ReadonlyArray<string>;
}

/** What an `up` on a running instance targets. */
export interface RunningSelection<S> {
  /** The namespaces the call targets. */
  readonly namespaces: ReadonlyArray<string>;
  /** The declared services in those namespaces — the set to health-wait on. */
  readonly services: ReadonlyArray<S>;
  /**
   * Requested namespaces whose services are not all in the project. Always
   * empty for a bare `up` (it only targets booted namespaces); non-empty is
   * the `NAMESPACE_NOT_RUNNING` case.
   */
  readonly notRunning: ReadonlyArray<NamespaceNotRunning>;
}

/**
 * Resolve the selection for an `up` against an already-running instance.
 *
 * `services` are the declared services that live in this instance (the
 * worktree's isolated tier); `present` is the set of names process-compose
 * reports in the project. process-compose omits `-n`-excluded services from
 * the project entirely (verified on v1.122.0), so "present" means "selected
 * at boot".
 *
 *   - **Bare** (`requested` empty / absent): target the namespaces whose
 *     declared services are ALL present. "All" keeps a service that also
 *     belongs to a booted namespace from making an unbooted one look booted.
 *   - **Explicit `-n`**: exact. A requested namespace with a declared service
 *     missing from the project is reported in `notRunning`. A requested
 *     namespace that declares no service here is not "not running" — there
 *     is nothing absent to name — so it simply selects nothing.
 *
 * Never widens or narrows what is running: the caller only waits on, and
 * reports, the selection.
 */
export function resolveRunningSelection<S extends Pick<ResolvedService, "name" | "namespace">>(
  services: ReadonlyArray<S>,
  present: ReadonlySet<string>,
  requested: ReadonlyArray<string> | undefined,
): RunningSelection<S> {
  const membersOf = (ns: string): S[] => services.filter((s) => namespaceSelected(s, [ns]));
  const missingIn = (ns: string): string[] =>
    membersOf(ns)
      .filter((s) => !present.has(s.name))
      .map((s) => s.name);

  if (requested === undefined || requested.length === 0) {
    const booted = declaredNamespaces(services).filter((ns) => missingIn(ns).length === 0);
    const selected = services.filter((s) => namespaceSelected(s, booted));
    return { namespaces: booted, services: selected, notRunning: [] };
  }

  const namespaces = [...new Set(requested)];
  const notRunning = namespaces
    .map((namespace) => ({ namespace, missingServices: missingIn(namespace) }))
    .filter((n) => n.missingServices.length > 0);
  const selected = services.filter((s) => namespaceSelected(s, namespaces));
  return { namespaces, services: selected, notRunning };
}

/**
 * The `devtrees up` invocation that reproduces a namespace selection, for
 * remedy text. Since #176 a bare `up` means exactly `-n default`, so that
 * selection needs no flag; any other is spelled out with one `-n` per
 * namespace. An empty selection (nothing booted) has no exact spelling, so it
 * falls back to every namespace the stack declares — the widest boot that
 * brings everything back.
 */
export function formatUpCommand(
  stackServices: ReadonlyArray<Pick<ResolvedService, "namespace">>,
  namespaces: ReadonlyArray<string>,
): string {
  const target =
    namespaces.length > 0 ? [...new Set(namespaces)] : declaredNamespaces(stackServices);
  if (target.length === 0 || (target.length === 1 && target[0] === DEFAULT_NAMESPACE)) {
    return "devtrees up";
  }
  return ["devtrees up", ...target.map((ns) => `-n ${ns}`)].join(" ");
}

/**
 * A `depends_on` edge process-compose drops at launch because its target is
 * not selected (ADR-0008, #179): none of the target's namespaces is among the
 * `-n` values, so process-compose (v1.120+) omits it and starts the dependent
 * ungated, warning only in its own log file. devtrees reports these the way
 * ADR-0003 asks it to report dropped cross-tier edges.
 */
export interface DroppedNamespaceEdge {
  readonly from: string;
  readonly to: string;
  /** The target's namespaces — selecting any of them would keep the edge. */
  readonly toNamespaces: ReadonlyArray<string>;
}

/**
 * Every `depends_on` edge from a selected isolated service to an isolated
 * service process-compose does not keep, in declaration order. `stackServices`
 * is the whole stack (to resolve each target), `selected` the services the
 * `up` targets — the fresh selection, or the effective one on a running
 * instance. Edges to shared services are not namespace edges (the shared
 * instance runs regardless of `-n`, #130); they are the deriver's cross-tier
 * drops.
 *
 * `kept` is the set of services process-compose actually has in the project;
 * an edge is dropped only when its target is absent from it. It defaults to
 * the selected names, which is exact for a fresh start. On a running instance
 * it must be the project's services: a narrower `-n` than the boot selection
 * leaves a booted target running, and that edge was never dropped.
 */
export function droppedNamespaceEdges(
  stackServices: ReadonlyArray<Pick<ResolvedService, "name" | "tier" | "namespace" | "dependsOn">>,
  selected: ReadonlyArray<Pick<ResolvedService, "name">>,
  kept: ReadonlySet<string> = new Set(selected.map((s) => s.name)),
): DroppedNamespaceEdge[] {
  const selectedNames = new Set(selected.map((s) => s.name));
  const byName = new Map(stackServices.map((s) => [s.name, s]));
  const edges: DroppedNamespaceEdge[] = [];
  for (const from of stackServices) {
    if (!selectedNames.has(from.name)) continue;
    for (const dep of from.dependsOn) {
      const to = byName.get(dep.name);
      if (to === undefined || to.tier !== "isolated" || kept.has(to.name)) continue;
      edges.push({ from: from.name, to: to.name, toNamespaces: serviceNamespaces(to) });
    }
  }
  return edges;
}
