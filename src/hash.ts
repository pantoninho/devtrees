/**
 * Resolved-stack hashing — the input to drift detection (issue #31).
 *
 * `up` writes this hash alongside the worktree's allocation entry on first
 * successful start; a subsequent `up` compares the current stack's hash to the
 * stored one to decide between *noop* (same), *reload* (different but the
 * driver can hot-swap), and `CONFIG_DRIFT` (different and the driver can't
 * hot-swap). The hash is over the user-authored stack (services, ports,
 * allocator overrides) — never the post-allocation derived config — so
 * trivial port-block reshuffles do not register as drift.
 */

import { createHash } from "node:crypto";
import type { ResolvedService, ResolvedStack, ServiceDependency } from "./stack.js";

/**
 * Recursively sort object keys so the JSON form of an opaque passthrough
 * block is independent of authoring/insertion order — semantically identical
 * blocks must not register as drift (#86). Arrays keep their order (it is
 * meaningful, e.g. an exec command's argv); scalars pass through.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

/**
 * Canonical form of one `depends_on` edge. An edge with no authored condition
 * hashes as its bare name — exactly what it hashed as before conditions were
 * preserved (#158) — so every stack that never used a condition keeps the hash
 * it already has on disk and reports no spurious drift. An authored condition
 * hashes as `{name, condition}`: it reaches the derived config verbatim, so
 * editing it (`process_started` -> `process_healthy`) is a real config change
 * and must register as drift.
 */
function canonicalDependency(dep: ServiceDependency): unknown {
  return dep.condition === undefined ? dep.name : { name: dep.name, condition: dep.condition };
}

/**
 * The fields shared by both hashes: identity, wiring and the opaque
 * passthrough blocks that predate #175.
 */
function canonicalBase(s: ResolvedService): Record<string, unknown> {
  return {
    name: s.name,
    tier: s.tier,
    command: s.command,
    ports: [...s.ports],
    dependsOn: s.dependsOn.map(canonicalDependency),
    environment: [...s.environment],
    // Opaque passthrough blocks flow into the derived config, so an edit to
    // any of them must register as drift (#86). Absent blocks hash as null.
    readinessProbe: canonicalValue(s.readinessProbe ?? null),
    livenessProbe: canonicalValue(s.livenessProbe ?? null),
    availability: canonicalValue(s.availability ?? null),
  };
}

/**
 * Canonical `namespace` (#179). process-compose ignores the order of a
 * list-valued namespace and treats a one-element list as that name (a
 * reorder hot-reloads as "No processes were updated"), so neither may count
 * as drift: a list hashes sorted, and `[a]` hashes as the bare string `a`.
 * A plain string hashes exactly as it did before lists existed, so existing
 * stacks see no spurious drift. The derived config still carries the list in
 * written order.
 */
function canonicalNamespace(ns: ResolvedService["namespace"]): string | string[] | null {
  if (ns === undefined) return null;
  if (typeof ns === "string") return ns;
  return ns.length === 1 ? (ns[0] as string) : [...ns].sort();
}

/**
 * Every field devtrees forwards to process-compose, so editing any of them on
 * a running instance registers as drift and hot-reloads (#175). Absent fields
 * hash as null; object blocks are key-sorted by `canonicalValue`. `namespace`
 * goes through `canonicalNamespace`: list order is ignored, because
 * process-compose ignores it.
 */
function canonicalService(s: ResolvedService): unknown {
  if (s.tier === "shared") {
    // A shared service's five #183 fields land in the shared instance's
    // config, not this worktree's, so editing them must not hot-reload the
    // worktree (#185). They stay as constant nulls (not omitted) so a shared
    // service that never sets them hashes exactly as it did after #183.
    return {
      ...canonicalBase(s),
      namespace: canonicalNamespace(s.namespace),
      shutdown: null,
      isDaemon: null,
      launchTimeoutSeconds: null,
      logLocation: null,
      logConfiguration: null,
    };
  }
  return {
    ...canonicalBase(s),
    namespace: canonicalNamespace(s.namespace),
    shutdown: canonicalValue(s.shutdown ?? null),
    isDaemon: s.isDaemon ?? null,
    launchTimeoutSeconds: s.launchTimeoutSeconds ?? null,
    logLocation: s.logLocation ?? null,
    logConfiguration: canonicalValue(s.logConfiguration ?? null),
  };
}

function canonicalStack(stack: ResolvedStack): unknown {
  const services = [...stack.services]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(canonicalService);
  const allocator = stack.allocator
    ? {
        portBase: stack.allocator.portBase ?? null,
        blockSize: stack.allocator.blockSize ?? null,
      }
    : null;
  return { services, allocator };
}

/** SHA-256 hex digest of the canonical JSON form of a `ResolvedStack`. */
export function stackHash(stack: ResolvedStack): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalStack(stack)))
    .digest("hex");
}

/**
 * SHA-256 hex digest of the *shared subset* of a stack — the input to
 * shared-stack drift detection (issue #83).
 *
 * Hashes only the `shared`-tier services, sorted by name, so:
 *  - reordering services in `devtrees.yaml` does NOT register as drift
 *    (port numbers come from the persisted name→port map, not from
 *    positional offsets);
 *  - edits confined to isolated services do NOT register as drift;
 *  - adding/removing/editing a shared service (or flipping a tier) DOES.
 *
 * Allocator overrides are deliberately excluded: the running shared
 * instance's concrete port numbers are carried by the persisted map, so a
 * `port_base` change alone does not invalidate what is actually bound.
 *
 * It also deliberately omits the process-compose fields #175 added to
 * `stackHash` (namespace, shutdown, ...): a shared instance has no hot-reload
 * path, so a drifted shared hash is a hard `SHARED_DRIFT` that forces a manual
 * `down --shared`. Widening it would break every already-running shared
 * instance on upgrade for fields that never affect the injected port map.
 */
export function sharedStackHash(stack: ResolvedStack): string {
  const services = stack.services
    .filter((s) => s.tier === "shared")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(canonicalBase);
  return createHash("sha256").update(JSON.stringify({ services })).digest("hex");
}

/**
 * The five process-compose fields `sharedStackHash` deliberately leaves out
 * (#183), per shared service, keyed by service name with `devtrees.yaml`
 * field names. Absent fields are null, blocks key-sorted, so two equal
 * configs serialize identically. Persisted at shared start so a later `up` can
 * warn that an edit won't apply until shared restarts (#185).
 */
export function sharedExtendedFields(
  stack: ResolvedStack,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of stack.services) {
    if (s.tier !== "shared") continue;
    out[s.name] = {
      shutdown: canonicalValue(s.shutdown ?? null),
      is_daemon: s.isDaemon ?? null,
      launch_timeout_seconds: s.launchTimeoutSeconds ?? null,
      log_location: s.logLocation ?? null,
      log_configuration: canonicalValue(s.logConfiguration ?? null),
    };
  }
  return out;
}
