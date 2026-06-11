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
import type { ResolvedService, ResolvedStack } from "./stack.js";

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

function canonicalService(s: ResolvedService): unknown {
  return {
    name: s.name,
    tier: s.tier,
    command: s.command,
    ports: [...s.ports],
    dependsOn: [...s.dependsOn],
    environment: [...s.environment],
    // Opaque passthrough blocks flow into the derived config, so an edit to
    // any of them must register as drift (#86). Absent blocks hash as null.
    readinessProbe: canonicalValue(s.readinessProbe ?? null),
    livenessProbe: canonicalValue(s.livenessProbe ?? null),
    availability: canonicalValue(s.availability ?? null),
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
 */
export function sharedStackHash(stack: ResolvedStack): string {
  const services = stack.services
    .filter((s) => s.tier === "shared")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(canonicalService);
  return createHash("sha256").update(JSON.stringify({ services })).digest("hex");
}
