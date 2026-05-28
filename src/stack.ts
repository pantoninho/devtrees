/**
 * Stack model.
 *
 * Loads a `devtrees.yaml` (inline form for this slice) and normalizes it into a
 * `ResolvedStack`: services with a `tier`, a list of verbatim named-port env-var
 * names, `depends_on`, command, and environment. The only addition to the
 * process-compose schema is the per-service `tier` field (CONTEXT.md, ADR-0003).
 * Cross-service validation (tier values, `shared → isolated` rejection, dangling
 * deps) is deepened in a later slice; this one establishes the normalized shape.
 *
 * Pure: it parses already-read YAML text and never touches the filesystem, so it
 * stays unit-testable. `loadStack(dir)` is the thin I/O seam layered on top.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** A service's tier: where devtrees runs it. Defaults to `isolated`. */
export type Tier = "isolated" | "shared";

/** A single normalized service in the stack. */
export interface ResolvedService {
  readonly name: string;
  readonly tier: Tier;
  /** Verbatim env-var names this service exposes as named ports, e.g. `["WEB_PORT"]`. */
  readonly ports: ReadonlyArray<string>;
  readonly command: string;
  readonly dependsOn: ReadonlyArray<string>;
  /** Author-declared environment entries, `KEY=VALUE`, passed through untouched. */
  readonly environment: ReadonlyArray<string>;
}

/** The validated, normalized stack. */
export interface ResolvedStack {
  readonly services: ReadonlyArray<ResolvedService>;
}

/** Shape of a raw service block as authored in `devtrees.yaml` (inline form). */
interface RawService {
  tier?: unknown;
  command?: unknown;
  ports?: unknown;
  depends_on?: unknown;
  environment?: unknown;
}

const DEFAULT_TIER: Tier = "isolated";

/** Coerce a scalar YAML value to a string; objects/arrays become "". */
function asString(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      return "";
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString);
}

/**
 * Parse and normalize already-read `devtrees.yaml` text (inline form) into a
 * `ResolvedStack`. Pure — no I/O. Validation lands in a later slice; this slice
 * establishes the normalized shape every other module consumes.
 */
export function parseStack(yamlText: string): ResolvedStack {
  const doc = (parseYaml(yamlText) ?? {}) as { services?: Record<string, RawService> };
  const rawServices = doc.services ?? {};

  const services: ResolvedService[] = Object.entries(rawServices).map(([name, raw]) => ({
    name,
    tier: (raw.tier as Tier | undefined) ?? DEFAULT_TIER,
    command: asString(raw.command),
    ports: asStringArray(raw.ports),
    dependsOn: asStringArray(raw.depends_on),
    environment: asStringArray(raw.environment),
  }));

  return { services };
}

/** I/O seam: read `devtrees.yaml` from a directory and normalize it. */
export function loadStack(dir: string): ResolvedStack {
  return parseStack(readFileSync(join(dir, "devtrees.yaml"), "utf8"));
}
