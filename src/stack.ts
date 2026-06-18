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
import { DEFAULT_ALLOCATOR, MAX_PORT } from "./allocator.js";

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
  /**
   * process-compose `readiness_probe` block, passed through verbatim. devtrees
   * does not model the inner shape — process-compose owns it; whatever the
   * author writes lands here unchanged and reaches the derived YAML as-is.
   * Absent when the author (and the extends-base) declared no probe.
   */
  readonly readinessProbe?: Readonly<Record<string, unknown>>;
  /** process-compose `liveness_probe` block, opaque passthrough. See `readinessProbe`. */
  readonly livenessProbe?: Readonly<Record<string, unknown>>;
  /** process-compose `availability` block (restart policy etc.), opaque passthrough. */
  readonly availability?: Readonly<Record<string, unknown>>;
  /**
   * process-compose `namespace` the service belongs to, passed through verbatim
   * (issue #128). Selects which subset of the stack `up -n <ns>` starts; absent
   * when the author declared none, in which case process-compose places the
   * service in its implicit `default` namespace. Unlike `tier`, this is a
   * process-compose-native field — it is re-emitted into the derived config.
   */
  readonly namespace?: string;
  /**
   * process-compose `shutdown` block (issue #134), opaque object passthrough.
   * Holds the teardown hook (`command`, `timeout_seconds`, `signal`,
   * `parent_only`) process-compose runs first on `down`; absent when unauthored.
   * See `readinessProbe` — devtrees never models the inner shape.
   */
  readonly shutdown?: Readonly<Record<string, unknown>>;
  /**
   * process-compose `is_daemon` flag (issue #134), scalar passthrough. Marks a
   * process whose `command` launches work into the background and returns, so
   * process-compose treats the launch as the readiness boundary. Unlike the
   * object passthroughs this is a boolean, copied verbatim; absent when
   * unauthored, and a declared `false` is preserved (not treated as absence).
   */
  readonly isDaemon?: boolean;
  /**
   * process-compose `launch_timeout_seconds` (issue #134), scalar passthrough.
   * Number copied verbatim; absent when unauthored. Companion to `isDaemon`.
   */
  readonly launchTimeoutSeconds?: number;
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
  namespace?: unknown;
  /**
   * Pure passthrough surface — devtrees never validates the inner shape of
   * these process-compose blocks. They're typed as `unknown` here so the
   * parser can preserve any field process-compose accepts without coupling
   * devtrees to a specific process-compose version.
   */
  readiness_probe?: unknown;
  liveness_probe?: unknown;
  availability?: unknown;
  shutdown?: unknown;
  is_daemon?: unknown;
  launch_timeout_seconds?: unknown;
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
 * Coerce a YAML node into an opaque record passthrough. Returns `undefined`
 * when the field is absent or not an object (arrays / scalars are not valid
 * passthrough shapes for `readiness_probe` / `liveness_probe` / `availability`,
 * but we don't validate here — process-compose surfaces its own errors at
 * `up` time).
 *
 * The inner shape is intentionally unmodeled: whatever the author put under
 * the key reaches the derived YAML unchanged, including fields devtrees
 * doesn't know about.
 */
function asOpaqueRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Passthrough fields that devtrees forwards verbatim to process-compose
 * (CONTEXT.md: opaque passthrough). Encoded once as `[devtreesKey, yamlKey]`
 * pairs so `parseStack` can resolve them in a single loop without adding a
 * conditional branch per field.
 */
const PASSTHROUGH_FIELDS: ReadonlyArray<readonly [keyof ResolvedService, keyof RawService]> = [
  ["readinessProbe", "readiness_probe"],
  ["livenessProbe", "liveness_probe"],
  ["availability", "availability"],
  ["shutdown", "shutdown"],
];

/**
 * Resolve the opaque passthrough fields for one service. Overlay wins over
 * base; absent fields stay absent on the returned record so `"readinessProbe"
 * in svc` reflects authoring intent (no `undefined` leak in the spread).
 */
function resolvePassthrough(
  over: RawService,
  base: RawService,
): Partial<Pick<ResolvedService, "readinessProbe" | "livenessProbe" | "availability" | "shutdown">> {
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [outKey, rawKey] of PASSTHROUGH_FIELDS) {
    const value = asOpaqueRecord(over[rawKey] ?? base[rawKey]);
    if (value !== undefined) out[outKey] = value;
  }
  return out;
}

/**
 * Resolve the `namespace` passthrough for one service (#128). Overlay wins over
 * base; the key is left off the returned record entirely when neither declares
 * a non-empty string, so `"namespace" in svc` reflects authoring intent and a
 * namespace-less service derives without a `namespace` key. Non-string scalars
 * coerce through `asString`; an empty result is treated as "no namespace".
 */
function resolveNamespace(
  over: RawService,
  base: RawService,
): Partial<Pick<ResolvedService, "namespace">> {
  const raw = over.namespace ?? base.namespace;
  if (raw === undefined || raw === null) return {};
  const ns = asString(raw);
  return ns === "" ? {} : { namespace: ns };
}

/**
 * Scalar passthrough fields (#134). Unlike the object passthroughs, these are a
 * boolean / number that process-compose reads as primitives, so they cannot go
 * through `asOpaqueRecord` (which rejects scalars). Each entry pairs the
 * resolved camelCase key with its snake_case YAML key and a type guard; a value
 * that fails the guard is rejected loudly as `CONFIG_INVALID` rather than
 * leaking a wrong-typed key into the derived config. Encoded once so
 * `resolveScalarPassthrough` resolves them in a single loop.
 */
const SCALAR_PASSTHROUGH_FIELDS: ReadonlyArray<{
  readonly outKey: "isDaemon" | "launchTimeoutSeconds";
  readonly rawKey: "is_daemon" | "launch_timeout_seconds";
  readonly check: (v: unknown) => boolean;
  readonly typeLabel: string;
}> = [
  {
    outKey: "isDaemon",
    rawKey: "is_daemon",
    check: (v) => typeof v === "boolean",
    typeLabel: "a boolean",
  },
  {
    outKey: "launchTimeoutSeconds",
    rawKey: "launch_timeout_seconds",
    check: (v) => typeof v === "number" && Number.isFinite(v),
    typeLabel: "a number",
  },
];

/**
 * Resolve the scalar passthrough fields (`is_daemon`, `launch_timeout_seconds`)
 * for one service. Overlay wins over base; a key absent from both is left off
 * the returned record so `"isDaemon" in svc` reflects authoring intent (and a
 * declared `false` / `0` is preserved, distinct from absence). A present value
 * of the wrong type is rejected as `CONFIG_INVALID` — process-compose would
 * otherwise silently misread it.
 */
function resolveScalarPassthrough(
  over: RawService,
  base: RawService,
): Partial<Pick<ResolvedService, "isDaemon" | "launchTimeoutSeconds">> {
  const out: { isDaemon?: boolean; launchTimeoutSeconds?: number } = {};
  for (const { outKey, rawKey, check, typeLabel } of SCALAR_PASSTHROUGH_FIELDS) {
    const raw = over[rawKey] ?? base[rawKey];
    if (raw === undefined || raw === null) continue;
    if (!check(raw)) {
      throw new StackConfigError(
        `${rawKey} must be ${typeLabel}, got ${typeof raw}. ` +
          `It is passed through to process-compose verbatim; fix the value in devtrees.yaml.`,
      );
    }
    if (outKey === "isDaemon") out.isDaemon = raw as boolean;
    else out.launchTimeoutSeconds = raw as number;
  }
  return out;
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
  const doc = (parseYamlConfig(yamlText, "devtrees.yaml") ?? {}) as {
    services?: Record<string, RawService>;
    port_base?: unknown;
    block_size?: unknown;
  };
  const overlay = doc.services ?? {};

  const baseProcesses: Record<string, RawService> = options.baseYaml
    ? ((
        (parseYamlConfig(options.baseYaml, "the extends base file") ?? {}) as {
          processes?: Record<string, RawService>;
        }
      ).processes ?? {})
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
      // process-compose `namespace` passthrough (#128). Overlay wins over base;
      // only set when authored, so `"namespace" in svc` reflects intent and a
      // namespace-less service is emitted without the key (lands in
      // process-compose's implicit `default` namespace — no behaviour change).
      ...resolveNamespace(over, base),
      // Opaque passthrough fields — only present when authored, so
      // `"readinessProbe" in svc` reflects intent (no `undefined` leak).
      ...resolvePassthrough(over, base),
      // Scalar passthrough fields (#134: is_daemon, launch_timeout_seconds) —
      // validated by type, copied verbatim, only present when authored.
      ...resolveScalarPassthrough(over, base),
    };
  });

  const allocator = parseAllocator(doc);
  validateAllocatorBounds(allocator);
  const stack: ResolvedStack = allocator ? { services, allocator } : { services };
  validateStack(stack);
  return stack;
}

/**
 * Reject allocator overrides that leave no room for one full port block at or
 * below 65535 (issue #89). The schema accepts any positive `port_base` /
 * `block_size`; without this check a base near the TCP ceiling would let the
 * allocator hand out ports past 65535. Effective values — override or PRD
 * default — are what must fit, so a lone `block_size: 50000` fails too.
 */
function validateAllocatorBounds(allocator: AllocatorOverrides | undefined): void {
  const portBase = allocator?.portBase ?? DEFAULT_ALLOCATOR.portBase;
  const blockSize = allocator?.blockSize ?? DEFAULT_ALLOCATOR.blockSize;
  const topPort = portBase + blockSize - 1;
  if (topPort > MAX_PORT) {
    throw new StackConfigError(
      `port_base ${portBase} with block_size ${blockSize} leaves no room for a full ` +
        `port block: the first block would span ${portBase}-${topPort}, past the highest ` +
        `valid TCP port ${MAX_PORT}. Lower port_base (or block_size) so that ` +
        `port_base + block_size - 1 <= ${MAX_PORT}.`,
    );
  }
}

/**
 * Raised when `devtrees.yaml` is rejected — either structurally impossible
 * (e.g. a shared service depending on an isolated one, ADR-0003) or not
 * parseable as YAML at all. The class is internal — callers match on the
 * message text, not the constructor — but the named subclass makes stack
 * traces and `instanceof` debugging clearer.
 *
 * Carries the documented `CONFIG_INVALID` code (issue #84) so the CLI's
 * `classifyError` (src/output.ts) maps it into the `--json` error envelope
 * instead of falling through to `UNKNOWN` — same pattern as
 * `HealthTimeoutError` / `StalePortBlockError` in src/commands.ts.
 */
class StackConfigError extends Error {
  readonly code = "CONFIG_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "StackConfigError";
  }
}

/**
 * Parse YAML text, rethrowing any parser failure as a `StackConfigError` so a
 * syntax error in `devtrees.yaml` (or its extends-base) classifies as
 * `CONFIG_INVALID` rather than `UNKNOWN` (issue #84). The underlying parser
 * diagnostic (line/column, what was expected) is preserved in the message —
 * that's what lets the author actually fix the file.
 */
function parseYamlConfig(yamlText: string, sourceLabel: string): unknown {
  try {
    return parseYaml(yamlText);
  } catch (err) {
    throw new StackConfigError(`${sourceLabel} is not valid YAML: ${(err as Error).message}`);
  }
}

/**
 * Cross-service validation pass over a resolved stack. Checks two load-time
 * rules, both rejected before the stack ever tries to start:
 *
 *  - ADR-0003: a `shared` service may not `depends_on` an `isolated` service
 *    — that would mean depending on N per-worktree copies of one process and
 *    is undefined.
 *  - Issue #130: a `shared` service may not declare a `namespace`. Namespace
 *    selection (`up -n`) is a launch-time filter on this worktree's isolated
 *    instance; the shared singleton (ADR-0001) runs regardless of any one
 *    worktree's `-n`, so a namespace on a shared service is inert for
 *    selection. Reject it loudly instead of letting it pass through silently.
 */
function validateStack(stack: ResolvedStack): void {
  const tierOf = new Map(stack.services.map((s) => [s.name, s.tier]));
  for (const service of stack.services) {
    if (service.tier !== "shared") continue;
    if (service.namespace !== undefined) {
      throw new StackConfigError(
        `service '${service.name}': namespace selection (up -n) applies only to isolated services; ` +
          `shared services are a repo-wide singleton and always run. ` +
          `Remove the namespace from '${service.name}', or make it isolated.`,
      );
    }
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

/**
 * Peek at `extends:` without committing to a full parse contract. Runs before
 * `parseStack` on the `loadStack` path, so it wraps parse failures the same
 * way — a malformed file fails here first and must still be CONFIG_INVALID.
 */
function readExtendsPath(yamlText: string): string | undefined {
  const doc = (parseYamlConfig(yamlText, "devtrees.yaml") ?? {}) as { extends?: unknown };
  return typeof doc.extends === "string" ? doc.extends : undefined;
}
