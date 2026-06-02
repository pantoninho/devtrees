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

function canonicalService(s: ResolvedService): unknown {
  return {
    name: s.name,
    tier: s.tier,
    command: s.command,
    ports: [...s.ports],
    dependsOn: [...s.dependsOn],
    environment: [...s.environment],
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
  return createHash("sha256").update(JSON.stringify(canonicalStack(stack))).digest("hex");
}
