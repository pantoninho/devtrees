/**
 * Named-service targets for the per-service lifecycle verbs (ADR-0009).
 *
 * `devtrees restart <service...>` (#222) acts on services the caller names,
 * and checks the names before anything is touched. The declared services are the
 * running instance's derived config, the file process-compose was booted
 * with (or last reloaded from), not `devtrees.yaml`, which may have been
 * edited since. This module decides; the errors are built in
 * `resolveNamedServices` (src/commands.ts):
 *
 *   - a shared service (`sharedAmong`) fails `SHARED_SERVICE_REFUSED`: a
 *     worktree-scoped command must not bounce a repo-wide process (ADR-0001,
 *     ADR-0008);
 *   - a name the derived config does not declare (`unknownService`) fails
 *     `SERVICE_NOT_FOUND`, with the same `details` as `logs`;
 *   - a declared service the running instance did not boot
 *     (`unbootedServices`: its namespace was not selected, so process-compose
 *     omits it from the project) fails `NAMESPACE_NOT_RUNNING`, as `up -n`
 *     does (ADR-0008).
 *
 * Pure: no I/O.
 */

import { namespaceOf } from "./reload-pending.js";
import { namespaceSelected, serviceNamespaces, type NamespaceNotRunning } from "./selection.js";
import { dependencyOrder } from "./service-state.js";
import type { ResolvedService } from "./stack.js";

/** A service as the derived config declares it: its name, namespaces and dependencies. */
export interface DeclaredService extends Pick<ResolvedService, "name" | "namespace"> {
  readonly dependsOn: ReadonlyArray<{ readonly name: string }>;
}

/** The services a derived config's `processes` map declares, in its order. */
export function declaredServices(
  processes: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): DeclaredService[] {
  return Object.entries(processes ?? {}).map(([name, entry]) => {
    const deps = entry.depends_on;
    const dependsOn =
      deps !== null && typeof deps === "object" ? Object.keys(deps).map((d) => ({ name: d })) : [];
    return { name, ...namespaceOf(entry), dependsOn };
  });
}

/** The distinct names among `names` that are in `shared`, in the order named. */
export function sharedAmong(
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
export function unknownService(
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
export function orderedTargets(
  declared: ReadonlyArray<DeclaredService>,
  names: ReadonlyArray<string>,
): DeclaredService[] {
  const byName = new Map(declared.map((s) => [s.name, s]));
  return dependencyOrder(declared, [...new Set(names)]).flatMap((name) => byName.get(name) ?? []);
}

/** The targets absent from the running project (`present`), in order. */
export function unbootedServices(
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
export function notBootedNamespaces(
  missing: ReadonlyArray<DeclaredService>,
): NamespaceNotRunning[] {
  const namespaces = [...new Set(missing.flatMap((s) => serviceNamespaces(s)))];
  return namespaces.map((namespace) => ({
    namespace,
    missingServices: missing
      .filter((s) => serviceNamespaces(s).includes(namespace))
      .map((s) => s.name),
  }));
}

/** What a per-service verb's `-n` flags expand to (#224). */
export interface NamespaceExpansion {
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
export function expandNamespaces(
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
