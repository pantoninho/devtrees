/**
 * Selection: which services a request targets, in which tier (ADR-0008,
 * ADR-0009, ADR-0010, ADR-0012).
 *
 * The one place that answers "what does this request target". Every entry
 * point takes the stack (or, for a running instance, the derived config it
 * booted), the request (`-n` namespaces, named services) and, when an
 * instance is running, its `process list` rows. It returns the targets for
 * each tier — or throws the typed selection error, with the code, message
 * and `details` the CLI reports:
 *
 *   - **Fresh `up`** (`selectFreshUp`, #176): `-n` is exact and forwarded to
 *     process-compose verbatim; a bare `up` selects `default` alone. Zero
 *     isolated services selected is `NO_SERVICES_SELECTED` (#203).
 *   - **Running `up`** (`selectRunningUp`, #177): the selection was fixed at
 *     boot, so it is read back from the project. A bare `up` targets the
 *     namespaces whose declared services are all present; `-n` is exact and
 *     must name booted namespaces, else `NAMESPACE_NOT_RUNNING` (#170).
 *   - **The shared closure** (`selectSharedServices`, #236, ADR-0010): every
 *     always-on shared service, the namespaced ones the selection covers, and
 *     their shared dependencies, transitively.
 *   - **Named services** (`selectNamedServices`, `assertNamedTargetsBooted`,
 *     ADR-0009, #222, #224): `restart <service...>` and `restart -n <ns>`
 *     against the running instance's derived config. A shared service is
 *     `SHARED_SERVICE_REFUSED`, an unknown name `SERVICE_NOT_FOUND`, a
 *     namespace with no isolated service `NO_SERVICES_SELECTED`, and a
 *     service the instance did not boot `NAMESPACE_NOT_RUNNING`.
 *   - **`down --shared -n`** (`selectSharedDown`, ADR-0012): the shared
 *     services that declare one of the named namespaces; an always-on one is
 *     never a target.
 *
 * Pure: no I/O. Callers read the stack, the derived configs and the rows,
 * and hand them in.
 */

import type { ServiceStatus } from "./driver.js";
import { dependencyOrder } from "./service-state.js";
import type { Namespace, ResolvedService, ResolvedStack } from "./stack.js";

// --- namespace vocabulary ---------------------------------------------------

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
 * bare `up` to `["default"]` first (`selectFreshUp`, #176), and the running
 * path to the booted namespaces, so there is no "empty means all" case — an
 * empty list selects nothing.
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

/** A derived config's `processes` map, as read back from disk (unvalidated). */
export type DerivedProcesses = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** A derived process entry's `namespace`, when it is a well-formed one. */
export function namespaceOf(entry: Readonly<Record<string, unknown>> | undefined): {
  readonly namespace?: Namespace;
} {
  const ns = entry?.namespace;
  if (typeof ns === "string") return { namespace: ns };
  if (Array.isArray(ns) && ns.every((n) => typeof n === "string")) return { namespace: ns };
  return {};
}

/**
 * The namespaces `rows` proves booted against the derived config `declared`:
 * those a present service declares as its only namespace.
 */
export function provenNamespaces(
  declared: DerivedProcesses,
  rows: ReadonlyArray<ServiceStatus>,
): string[] {
  const present = new Set(rows.map((r) => r.name));
  const proven = Object.keys(declared).flatMap((name) => {
    const ns = serviceNamespaces(namespaceOf(declared[name]));
    return present.has(name) && ns.length === 1 ? ns : [];
  });
  return [...new Set(proven)].sort();
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

// --- declared services (a running instance's derived config) ---------------

/** A service as the derived config declares it: its name, namespaces and dependencies. */
export interface DeclaredService extends Pick<ResolvedService, "name" | "namespace"> {
  readonly dependsOn: ReadonlyArray<{ readonly name: string }>;
}

/** The services a derived config's `processes` map declares, in its order. */
export function declaredServices(processes: DerivedProcesses | undefined): DeclaredService[] {
  return Object.entries(processes ?? {}).map(([name, entry]) => {
    const deps = entry.depends_on;
    const dependsOn =
      deps !== null && typeof deps === "object" ? Object.keys(deps).map((d) => ({ name: d })) : [];
    return { name, ...namespaceOf(entry), dependsOn };
  });
}

// --- the booted selection of a running instance -----------------------------

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
 * The namespaces a running instance booted, read back the way a bare `up`
 * reads them (ADR-0008): those whose `declared` services are all `present`.
 */
export function bootedNamespaces(
  declared: ReadonlyArray<Pick<ResolvedService, "name" | "namespace">>,
  present: ReadonlySet<string>,
): ReadonlyArray<string> {
  return resolveRunningSelection(declared, present, undefined).namespaces;
}

// --- dropped namespace edges ------------------------------------------------

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
 * instance. Edges to shared services are not namespace edges: they cross
 * into the shared instance and are the deriver's cross-tier drops (ADR-0003),
 * whether or not the `up` selects the shared target (ADR-0010).
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

// --- the shared tier (ADR-0010) ---------------------------------------------

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

// --- selection errors -------------------------------------------------------

/** The verbs that act on named services of this worktree's instance (ADR-0009). */
export type NamedServiceCommand = "restart";

/**
 * Thrown when an `up` selects zero isolated services (issues #176, #203,
 * ADR-0008): a bare fresh `up` whose implicit `default` namespace is empty,
 * or an explicit `-n` naming only namespaces with no services. Starting an
 * empty instance and reporting it healthy would be a lie, and process-compose
 * exits after hot-reloading an empty project (#203). `details.namespaces`
 * lists the namespaces the stack declares so an agent can retry with `-n`
 * without a second round-trip; `selected_namespaces` is what was asked for.
 */
export class NoServicesSelectedError extends Error {
  readonly code = "NO_SERVICES_SELECTED" as const;
  readonly details: {
    readonly worktree_id: string;
    readonly selected_namespaces: ReadonlyArray<string>;
    readonly namespaces: ReadonlyArray<string>;
  };
  constructor(
    worktreeId: string,
    available: ReadonlyArray<string>,
    selected: ReadonlyArray<string> = [DEFAULT_NAMESPACE],
    explicit = false,
    command: "up" | NamedServiceCommand = "up",
  ) {
    const example = available[0] ?? "<ns>";
    const why = explicit
      ? `\`-n ${selected.join(", ")}\` names no namespace with ${command === "up" ? "services in this stack" : "isolated services in this instance"}.`
      : `A bare \`devtrees up\` starts only the \`${DEFAULT_NAMESPACE}\` namespace ` +
        `(services with no \`namespace:\`), and this stack has none.`;
    // A per-service verb (#224) touched nothing; `up` says how to select.
    const next =
      command === "up"
        ? `Name the ones to start with -n, e.g. \`devtrees up -n ${example}\` ` +
          `(repeat -n for several).`
        : `Nothing was touched.`;
    super(
      `devtrees ${command}: no services selected (NO_SERVICES_SELECTED) for '${worktreeId}'. ${why} ` +
        `Available namespaces: ${available.join(", ")}. ${next}`,
    );
    this.name = "NoServicesSelectedError";
    this.details = {
      worktree_id: worktreeId,
      selected_namespaces: selected,
      namespaces: available,
    };
  }
}

/**
 * Thrown when `up -n` on a running instance names a namespace the instance
 * was not booted with (ADR-0008, issue #170). process-compose omits
 * `-n`-excluded services from the project and cannot add them at runtime, so
 * the only honest answer is to fail, name what is missing, and say how to
 * boot with it. Nothing is started or stopped; the instance keeps running.
 */
export class NamespaceNotRunningError extends Error {
  readonly code = "NAMESPACE_NOT_RUNNING" as const;
  constructor(
    message: string,
    readonly details: {
      readonly worktree_id: string;
      readonly namespaces: ReadonlyArray<string>;
      readonly services: ReadonlyArray<string>;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "NamespaceNotRunningError";
  }
}

export function namespaceNotRunningError(
  worktreeId: string,
  notRunning: ReadonlyArray<NamespaceNotRunning>,
  requested: ReadonlyArray<string>,
  command: "up" | NamedServiceCommand = "up",
  declared?: ReadonlyArray<Pick<ResolvedService, "namespace">>,
): NamespaceNotRunningError {
  const namespaces = notRunning.map((n) => n.namespace);
  const services = [...new Set(notRunning.flatMap((n) => n.missingServices))];
  const flags = [...new Set(requested)].map((ns) => `-n ${ns}`).join(" ");
  // A per-service verb (#223) spells the boot with `formatUpCommand`, as the
  // other remedies do; `up` keeps its own `-n` list.
  const remedy =
    declared === undefined
      ? `devtrees down && devtrees up ${flags}`
      : `devtrees down && ${formatUpCommand(declared, requested)}`;
  const quoted = namespaces.map((ns) => `'${ns}'`).join(", ");
  const one = namespaces.length === 1;
  return new NamespaceNotRunningError(
    `devtrees ${command}: namespace${one ? "" : "s"} ${quoted} ${one ? "is" : "are"} not running in ` +
      `'${worktreeId}' (not started: ${services.join(", ")}). A running instance keeps the ` +
      `namespaces it was booted with and cannot add more. Run \`${remedy}\` to boot with ` +
      `them. Nothing was started or stopped.`,
    { worktree_id: worktreeId, namespaces, services, remedy },
  );
}

/**
 * Thrown when a per-service verb names a shared service (ADR-0009). The
 * shared instance serves every worktree, so a worktree's command never stops
 * or restarts one of its processes (ADR-0001, ADR-0008). Nothing is touched;
 * `details.remedy` is the repo-wide way to bounce it, which affects every
 * worktree.
 */
export class SharedServiceRefusedError extends Error {
  readonly code = "SHARED_SERVICE_REFUSED" as const;
  constructor(
    message: string,
    readonly details: {
      readonly services: ReadonlyArray<string>;
      readonly remedy: string;
    },
  ) {
    super(message);
    this.name = "SharedServiceRefusedError";
  }
}

function sharedServiceRefusedError(
  services: ReadonlyArray<string>,
  command: NamedServiceCommand,
): SharedServiceRefusedError {
  const remedy = "devtrees down --shared && devtrees up";
  const quoted = services.map((s) => `'${s}'`).join(", ");
  const one = services.length === 1;
  return new SharedServiceRefusedError(
    `devtrees ${command}: ${quoted} ${one ? "is a shared service" : "are shared services"}. ` +
      `The shared instance serves every worktree, so devtrees does not ${command} its ` +
      `services from a worktree. Nothing was touched. \`${remedy}\` restarts the shared ` +
      `instance, for every worktree.`,
    { services, remedy },
  );
}

/**
 * Build the documented `SERVICE_NOT_FOUND` error (#109): tagged with the
 * stable code so `classifyError` routes it into the JSON envelope, and
 * carrying `{service, valid_services}` details so an agent can correct the
 * name without a second round-trip. Mirrors the `invalidArgsError` /
 * `StalePortBlockError` tagging convention. `logs` raises it too.
 */
export function serviceNotFoundError(
  service: string,
  validServices: ReadonlyArray<string>,
  shared: boolean,
  /** The per-service verb raising it (#223); `logs` keeps its historical text. */
  command?: NamedServiceCommand,
): Error {
  const where = shared ? "the shared instance" : "this worktree's instance";
  const valid =
    validServices.length > 0
      ? `Valid services: ${validServices.join(", ")}.`
      : "Its derived config lists no services.";
  const prefix = command === undefined ? "" : `devtrees ${command}: `;
  const err = new Error(`${prefix}unknown service '${service}' in ${where}. ${valid}`) as Error & {
    code?: string;
    details?: Readonly<Record<string, unknown>>;
  };
  err.code = "SERVICE_NOT_FOUND";
  err.details = { service, valid_services: [...validServices] };
  return err;
}

// --- `up` ------------------------------------------------------------------

/** What an `up` targets, in each tier. */
export interface UpSelection {
  /** The namespaces the `up` selects (a fresh start forwards them to process-compose). */
  readonly namespaces: ReadonlyArray<string>;
  /** The isolated services it targets: the ones to boot, or to verify and health-wait on. */
  readonly isolated: ReadonlyArray<ResolvedService>;
  /** The shared closure it uses (`selectSharedServices`). */
  readonly shared: ReadonlyArray<ResolvedService>;
  /** The `depends_on` edges the selection leaves dangling (#179). */
  readonly droppedNamespaceEdges: ReadonlyArray<DroppedNamespaceEdge>;
}

/**
 * The selection a **fresh** start applies (issue #176, ADR-0008).
 * Namespaces are opt-in: with no `-n`, only the implicit `default` namespace
 * starts; `-n` is exact and forwarded verbatim (it never implies `default`).
 * The returned `namespaces` is never empty, so the worktree up-spawn always
 * passes `-n` and process-compose never falls back to "every namespace".
 *
 * Throws `NoServicesSelectedError` when the selection resolves to zero
 * isolated services — bare or explicit `-n` (#203: an empty instance is
 * useless, and process-compose exits after reloading one). Only isolated
 * services are counted: the worktree instance holds only those, and one with
 * nothing selected is useless even when the selection includes namespaced
 * shared services (#236). A stack with no isolated services at all keeps
 * starting (shared only).
 */
export function selectFreshUp(
  stack: ResolvedStack,
  worktreeId: string,
  requested: ReadonlyArray<string> | undefined,
): UpSelection {
  const bare = requested === undefined || requested.length === 0;
  const namespaces = bare ? [DEFAULT_NAMESPACE] : requested;
  const isolatedTier = stack.services.filter((s) => s.tier === "isolated");
  const isolated = isolatedTier.filter((s) => namespaceSelected(s, namespaces));
  if (isolated.length === 0 && isolatedTier.length > 0) {
    throw new NoServicesSelectedError(
      worktreeId,
      declaredNamespaces(isolatedTier),
      namespaces,
      !bare,
    );
  }
  return {
    namespaces,
    isolated,
    shared: selectSharedServices(stack, namespaces),
    droppedNamespaceEdges: droppedNamespaceEdges(stack.services, isolated),
  };
}

/**
 * Pure pre-check for an explicit `-n` (#203): fail `NO_SERVICES_SELECTED` when
 * the namespaces select no isolated service in the stack, on a fresh and a
 * running instance alike, before any port allocation or state write. On a
 * running instance nothing is "missing" from such a selection, so this is
 * not `NAMESPACE_NOT_RUNNING`. A bare `up` is not checked here: its target
 * depends on whether the instance is running.
 */
export function assertExplicitSelectionNotEmpty(
  stack: ResolvedStack,
  worktreeId: string,
  requested: ReadonlyArray<string> | undefined,
): void {
  if (requested === undefined || requested.length === 0) return;
  selectFreshUp(stack, worktreeId, requested);
}

/**
 * The selection of an `up` on a **running** instance (ADR-0008, #177), from
 * one `process list` read (`rows`). A bare `up` targets the namespaces whose
 * declared services are all present (the boot-time selection); `-n` is exact,
 * and a requested namespace whose services are absent throws
 * `NAMESPACE_NOT_RUNNING` (#170). Dropped edges (#179) count a target as kept
 * when it is in the project, so a narrower `-n` than the boot selection does
 * not report edges to services still running.
 */
export function selectRunningUp(
  stack: ResolvedStack,
  worktreeId: string,
  rows: ReadonlyArray<Pick<ServiceStatus, "name">>,
  requested: ReadonlyArray<string> | undefined,
): UpSelection {
  const isolatedTier = stack.services.filter((s) => s.tier === "isolated");
  const present = new Set(rows.map((r) => r.name));
  const selection = resolveRunningSelection(isolatedTier, present, requested);
  if (selection.notRunning.length > 0) {
    throw namespaceNotRunningError(worktreeId, selection.notRunning, requested ?? []);
  }
  return {
    namespaces: selection.namespaces,
    isolated: selection.services,
    shared: selectSharedServices(stack, selection.namespaces),
    droppedNamespaceEdges: droppedNamespaceEdges(stack.services, selection.services, present),
  };
}

// --- named services (ADR-0009) ----------------------------------------------

/** The distinct names among `names` that are in `shared`, in the order named. */
function sharedAmong(
  shared: ReadonlyArray<string>,
  isolated: ReadonlyArray<DeclaredService>,
  names: ReadonlyArray<string>,
): string[] {
  const own = new Set(isolated.map((s) => s.name));
  const repo = new Set(shared);
  // A name this instance declares is this instance's service, whatever else
  // shares its name.
  return [...new Set(names.filter((name) => repo.has(name) && !own.has(name)))];
}

/** The first of `names` not in `declared`, if any. */
function unknownService(
  declared: ReadonlyArray<DeclaredService>,
  names: ReadonlyArray<string>,
): string | undefined {
  const known = new Set(declared.map((s) => s.name));
  return names.find((name) => !known.has(name));
}

/**
 * The declared services `names` refers to, each once, in `depends_on` order
 * (a dependency before its dependents). Check `unknownService` first.
 */
function orderedTargets(
  declared: ReadonlyArray<DeclaredService>,
  names: ReadonlyArray<string>,
): DeclaredService[] {
  const byName = new Map(declared.map((s) => [s.name, s]));
  return dependencyOrder(declared, [...new Set(names)]).flatMap((name) => byName.get(name) ?? []);
}

/** The targets absent from the running project (`present`), in order. */
function unbootedServices(
  targets: ReadonlyArray<DeclaredService>,
  present: ReadonlySet<string>,
): DeclaredService[] {
  return targets.filter((s) => !present.has(s.name));
}

/**
 * The namespaces `missing` services were not booted in, each with the
 * missing services it declares: every namespace of a missing service is
 * unbooted, since one booted namespace would have put it in the project.
 */
function notBootedNamespaces(missing: ReadonlyArray<DeclaredService>): NamespaceNotRunning[] {
  const namespaces = [...new Set(missing.flatMap((s) => serviceNamespaces(s)))];
  return namespaces.map((namespace) => ({
    namespace,
    missingServices: missing
      .filter((s) => serviceNamespaces(s).includes(namespace))
      .map((s) => s.name),
  }));
}

/** What a per-service verb's `-n` flags expand to (#224). */
interface NamespaceExpansion {
  /** The isolated services in any of the namespaces, in declared order. */
  readonly services: ReadonlyArray<string>;
  /** Requested namespaces with no isolated service: `NO_SERVICES_SELECTED`. */
  readonly empty: ReadonlyArray<string>;
  /** Shared services in any of the namespaces, skipped and reported. */
  readonly skippedShared: ReadonlyArray<string>;
}

/**
 * Expand `-n` namespaces (#224) to every isolated service of the running
 * instance's derived config in any of them (a list-valued `namespace:` puts a
 * service in each, as for `up`). Shared services in them are not expanded:
 * they are returned in `skippedShared` for the verb to report. A namespace
 * that selects no isolated service is returned in `empty`.
 */
function expandNamespaces(
  declared: ReadonlyArray<DeclaredService>,
  shared: ReadonlyArray<Pick<ResolvedService, "name" | "namespace">>,
  namespaces: ReadonlyArray<string>,
): NamespaceExpansion {
  const requested = [...new Set(namespaces)];
  const own = new Set(declared.map((s) => s.name));
  const services = declared.filter((s) => namespaceSelected(s, requested)).map((s) => s.name);
  const empty = requested.filter((ns) => !declared.some((s) => namespaceSelected(s, [ns])));
  const skippedShared = [
    ...new Set(
      shared.filter((s) => !own.has(s.name) && namespaceSelected(s, requested)).map((s) => s.name),
    ),
  ];
  return { services, empty, skippedShared };
}

/** A per-service verb's request (ADR-0009, #222, #224). */
export interface NamedRequest {
  readonly worktreeId: string;
  readonly command: NamedServiceCommand;
  /**
   * The isolated services the running instance's derived config declares
   * (`declaredServices`): the file process-compose was booted with (or last
   * reloaded from), not `devtrees.yaml`, which may have been edited since.
   */
  readonly declared: ReadonlyArray<DeclaredService>;
  /** The repo's shared services, from `devtrees.yaml` and the shared derived config. */
  readonly repoShared: ReadonlyArray<Pick<ResolvedService, "name" | "namespace">>;
  /** The services named on the command line. */
  readonly named: ReadonlyArray<string>;
  /** `-n` namespaces (#224). */
  readonly namespaces: ReadonlyArray<string>;
}

/** What a per-service verb targets. */
export interface NamedSelection {
  /** The named and `-n`-expanded isolated services, each once, in `depends_on` order. */
  readonly isolated: ReadonlyArray<DeclaredService>;
  /** Shared services in a `-n` namespace (#224): skipped, for the verb to report. */
  readonly skippedShared: ReadonlyArray<string>;
}

/**
 * The services a per-service verb targets, checked against the derived
 * config before anything is read from the instance, in this order:
 *
 *  1. a named shared service fails `SHARED_SERVICE_REFUSED`
 *     (`details: {services, remedy}`): a worktree-scoped command must not
 *     bounce a repo-wide process (ADR-0001, ADR-0008);
 *  2. an unknown name fails `SERVICE_NOT_FOUND` (`details: {service,
 *     valid_services[]}`, as for `logs`, listing the derived config's
 *     services);
 *  3. a `-n` namespace with no isolated service fails `NO_SERVICES_SELECTED`.
 *
 * Shared services in the namespaces are not added: they are `skippedShared`.
 * Whether each target was booted needs the project: `assertNamedTargetsBooted`.
 */
export function selectNamedServices(request: NamedRequest): NamedSelection {
  const { declared, named, namespaces, command } = request;
  const shared = sharedAmong(
    request.repoShared.map((s) => s.name),
    declared,
    named,
  );
  if (shared.length > 0) throw sharedServiceRefusedError(shared, command);
  const unknown = unknownService(declared, named);
  if (unknown !== undefined) {
    throw serviceNotFoundError(
      unknown,
      declared.map((s) => s.name),
      false,
      command,
    );
  }
  const expansion = expandNamespaces(declared, request.repoShared, namespaces);
  if (expansion.empty.length > 0) {
    throw new NoServicesSelectedError(
      request.worktreeId,
      declaredNamespaces(declared),
      expansion.empty,
      true,
      command,
    );
  }
  return {
    isolated: orderedTargets(declared, [...new Set([...named, ...expansion.services])]),
    skippedShared: expansion.skippedShared,
  };
}

/**
 * Fail `NAMESPACE_NOT_RUNNING` (ADR-0008, as `up -n` does) when a target of
 * `selection` is absent from the running project (`rows`): its namespace was
 * not selected at boot, so process-compose omitted it. `details: {worktree_id,
 * namespaces, services, remedy}`; the remedy boots the namespaces running now
 * plus the missing ones.
 */
export function assertNamedTargetsBooted(
  request: Pick<NamedRequest, "worktreeId" | "command" | "declared">,
  selection: NamedSelection,
  rows: ReadonlyArray<Pick<ServiceStatus, "name">>,
): void {
  const present = new Set(rows.map((r) => r.name));
  const missing = unbootedServices(selection.isolated, present);
  if (missing.length === 0) return;
  const booted = bootedNamespaces(request.declared, present);
  const notRunning = notBootedNamespaces(missing);
  throw namespaceNotRunningError(
    request.worktreeId,
    notRunning,
    [...booted, ...notRunning.map((n) => n.namespace)],
    request.command,
    request.declared,
  );
}

// --- `down --shared -n` (ADR-0012) ------------------------------------------

/** The shared services a namespaced shared teardown targets. */
export interface SharedDownSelection {
  /** The shared services in the named namespaces, in config order. */
  readonly targets: ReadonlyArray<string>;
  /** Named namespaces with no shared service in the shared instance. */
  readonly inactiveNamespaces: ReadonlyArray<string>;
}

/**
 * Pick the shared services `down --shared -n` removes: every process of the
 * shared derived config that declares a `namespace:` and has one of
 * `namespaces` among them (a list-valued one counts if any matches, as for
 * `up`). An always-on shared service (no `namespace:`) is in no namespace, so
 * it is never a target, not even of `-n default`: only a full
 * `down --shared` stops it.
 */
export function selectSharedDown(
  processes: Readonly<Record<string, Pick<ResolvedService, "namespace">>> | undefined,
  namespaces: ReadonlyArray<string>,
): SharedDownSelection {
  const entries = Object.entries(processes ?? {});
  const targets = entries
    .filter(([, proc]) => proc.namespace !== undefined && namespaceSelected(proc, namespaces))
    .map(([name]) => name);
  const targeted = new Set(targets);
  const active = new Set(
    entries.filter(([name]) => targeted.has(name)).flatMap(([, proc]) => serviceNamespaces(proc)),
  );
  return {
    targets,
    inactiveNamespaces: [...new Set(namespaces)].filter((ns) => !active.has(ns)),
  };
}
