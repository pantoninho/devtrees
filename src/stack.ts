/**
 * Stack model.
 *
 * Loads a `devtrees.yaml` and normalizes it into a `ResolvedStack`: services
 * with a `tier`, a list of verbatim named-port env-var names, `depends_on`,
 * command, and environment. The only addition to the process-compose schema is
 * the per-service `tier` field (CONTEXT.md, ADR-0003).
 *
 * Two authoring modes are supported and may be mixed in one file:
 *  - **inline**: services defined entirely under `services:` in `devtrees.yaml`.
 *  - **extend**: `extends: ./process-compose.yaml` points at a hand-authored
 *    base config; the base's `processes` contribute the service body and the
 *    `services:` overlay attaches devtrees metadata or overrides per-service
 *    fields. The base file is read-only — devtrees never edits it, and the
 *    base remains a valid, independently-runnable process-compose file.
 *
 * Cross-service validation (tier values, `shared → isolated` rejection,
 * dangling deps) is deepened in a later slice; this one establishes the
 * normalized shape every other module consumes.
 *
 * Pure: `parseStack` parses already-read YAML text and never touches the
 * filesystem, so it stays unit-testable. `loadStack(dir)` is the thin I/O
 * seam layered on top and is the only place that opens the base file.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

/** Per-repo allocator overrides, partial — unspecified fields fall back to defaults. */
export interface AllocatorOverrides {
  readonly portBase?: number;
  readonly blockSize?: number;
}

/** The validated, normalized stack. */
export interface ResolvedStack {
  readonly services: ReadonlyArray<ResolvedService>;
  /** Per-repo allocator overrides parsed from `devtrees.yaml`, or `undefined` for defaults. */
  readonly allocator?: AllocatorOverrides;
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
 * Normalize a `depends_on` field into a list of dependency names. Accepts:
 *  - the array shorthand `[a, b]`
 *  - the canonical process-compose map form `{ a: { condition: ... }, b: ... }`
 * Conditions are not surfaced here — same-tier edges flow through to process-compose
 * unchanged (deriver re-emits them), and cross-tier edges are dropped (ADR-0003).
 */
function asDependencyList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((n) => n !== "");
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/** Optional inputs to `parseStack`, currently the extend-mode base config. */
export interface ParseStackOptions {
  /**
   * Raw YAML of the `process-compose.yaml` referenced by `extends:` in
   * `devtrees.yaml`. Read by the I/O seam (`loadStack`) and passed in; the
   * parser itself never touches the filesystem so the base file stays
   * read-only.
   */
  readonly baseYaml?: string;
}

/** Coerce a YAML scalar to a positive integer, or `undefined` if absent / unusable. */
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}

/** Pull the per-repo allocator overrides out of the raw doc, or `undefined` if none. */
function parseAllocator(doc: {
  port_base?: unknown;
  block_size?: unknown;
}): AllocatorOverrides | undefined {
  const portBase = asPositiveInt(doc.port_base);
  const blockSize = asPositiveInt(doc.block_size);
  if (portBase === undefined && blockSize === undefined) return undefined;
  const out: { portBase?: number; blockSize?: number } = {};
  if (portBase !== undefined) out.portBase = portBase;
  if (blockSize !== undefined) out.blockSize = blockSize;
  return out;
}

/**
 * Parse and normalize already-read `devtrees.yaml` text into a `ResolvedStack`.
 * Supports two authoring modes that may be mixed in one file:
 *
 *  - **inline**: services defined entirely under `services:` in `devtrees.yaml`.
 *  - **extend**: `extends: ./process-compose.yaml` points at a hand-authored
 *    base config; the base's `processes` block contributes the service body
 *    (command, environment, depends_on, ...) and the `services:` overlay
 *    attaches devtrees metadata (`tier`, named `ports`, ...).
 *
 * Pure — no I/O. The caller hands the base YAML in via `options.baseYaml`,
 * leaving the base file untouched on disk.
 */
export function parseStack(yamlText: string, options: ParseStackOptions = {}): ResolvedStack {
  const doc = (parseYaml(yamlText) ?? {}) as {
    services?: Record<string, RawService>;
    port_base?: unknown;
    block_size?: unknown;
  };
  const overlay = doc.services ?? {};

  const baseProcesses: Record<string, RawService> = options.baseYaml
    ? (((parseYaml(options.baseYaml) ?? {}) as { processes?: Record<string, RawService> })
        .processes ?? {})
    : {};

  // Union of names: base contributes the process body, overlay contributes
  // devtrees metadata and may override individual fields.
  const names = Array.from(new Set([...Object.keys(baseProcesses), ...Object.keys(overlay)]));

  const services: ResolvedService[] = names.map((name) => {
    const base = baseProcesses[name] ?? {};
    const over = overlay[name] ?? {};
    return {
      name,
      tier: ((over.tier ?? base.tier) as Tier | undefined) ?? DEFAULT_TIER,
      command: asString(over.command ?? base.command),
      ports: asStringArray(over.ports ?? base.ports),
      dependsOn: asDependencyList(over.depends_on ?? base.depends_on),
      environment: asStringArray(over.environment ?? base.environment),
    };
  });

  const allocator = parseAllocator(doc);
  const stack: ResolvedStack = allocator ? { services, allocator } : { services };
  validateStack(stack);
  return stack;
}

/**
 * Raised when `devtrees.yaml` declares a structurally-impossible dependency,
 * e.g. a shared service depending on an isolated one (ADR-0003).
 */
export class StackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackConfigError";
  }
}

/**
 * Cross-service validation pass over a resolved stack. Currently checks the
 * ADR-0003 rule: a `shared` service may not `depends_on` an `isolated` service
 * — that would mean depending on N per-worktree copies of one process and is
 * undefined. Rejected at load time so the developer hears about it before the
 * stack ever tries to start.
 */
export function validateStack(stack: ResolvedStack): void {
  const tierOf = new Map(stack.services.map((s) => [s.name, s.tier]));
  for (const service of stack.services) {
    if (service.tier !== "shared") continue;
    for (const dep of service.dependsOn) {
      if (tierOf.get(dep) === "isolated") {
        throw new StackConfigError(
          `shared service '${service.name}' cannot depends_on isolated service '${dep}': ` +
            `a shared service is a single instance and an isolated service has one copy per worktree, ` +
            `so the dependency is undefined. Either move '${dep}' to the shared tier or drop the edge.`,
        );
      }
    }
  }
}

/**
 * I/O seam: read `devtrees.yaml` from a directory and normalize it. If the
 * file declares `extends: <path>`, the base process-compose file is read
 * (relative to the devtrees.yaml directory, or absolute) and passed through to
 * the pure parser. The base file is opened read-only — devtrees never edits it.
 */
export function loadStack(dir: string): ResolvedStack {
  const path = join(dir, "devtrees.yaml");
  const text = readFileSync(path, "utf8");
  const extendsPath = readExtendsPath(text);
  const baseYaml =
    extendsPath !== undefined
      ? readFileSync(isAbsolute(extendsPath) ? extendsPath : join(dir, extendsPath), "utf8")
      : undefined;
  return parseStack(text, { baseYaml });
}

/** Peek at `extends:` without committing to a full parse contract. */
function readExtendsPath(yamlText: string): string | undefined {
  const doc = (parseYaml(yamlText) ?? {}) as { extends?: unknown };
  return typeof doc.extends === "string" ? doc.extends : undefined;
}
