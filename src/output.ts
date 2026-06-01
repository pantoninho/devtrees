/**
 * Output formatter — the only place command paths produce stdout content.
 *
 * Two surfaces:
 *
 *   - `human` mode renders the text/tables developers see today.
 *   - `json` mode emits a single JSON document on stdout carrying a top-level
 *     `schema_version`; on failure it emits `{schema_version, error: {code,
 *     message, details}}` on stdout and the caller signals a non-zero exit.
 *     Stderr stays untouched in `--json` success cases (ADR-0005).
 *
 * Every command pipes through here. The CLI entrypoint is the only place that
 * actually writes to `process.stdout` / `process.stderr`; everything else
 * produces strings.
 */

import type { InstanceInfo } from "./instances.js";

/**
 * Stable contract: present on every `--json` payload. Field additions are
 * non-breaking; renames and removals bump this. New error codes are additive.
 */
export const SCHEMA_VERSION = "1";

/**
 * The error-code enum the JSON error envelope carries. Slice #1 (this issue)
 * promises at least `PROCESS_COMPOSE_NOT_FOUND` and `INSTANCE_NOT_FOUND`; the
 * remaining codes are reserved here so later slices add cases without breaking
 * the type's exhaustiveness.
 */
export const ERROR_CODES = [
  "PROCESS_COMPOSE_NOT_FOUND",
  "INSTANCE_NOT_FOUND",
  "HEALTH_TIMEOUT",
  "CONFIG_DRIFT",
  "LOCK_CONTENTION",
  "CONFIG_INVALID",
  "UNKNOWN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type FormatMode = "human" | "json";

export interface OutputResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One row in the `ls` table. Kept loose so it doesn't pin the formatter to
 * `InstanceInfo` — `cli.ts` adapts both the test-injected stub shape and the
 * real discovery output into this row before calling `formatLs`.
 */
export interface LsInstanceRow {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  readonly status: "running" | "stale";
  readonly ports: Readonly<Record<string, number>>;
  readonly blockBase?: number;
}

/** Adapt an `InstanceInfo` from discovery into the row the formatter consumes. */
export function instanceRow(info: InstanceInfo): LsInstanceRow {
  return {
    id: info.id,
    kind: info.kind,
    status: info.status,
    ports: info.ports,
    blockBase: info.blockBase,
  };
}

// --- ls ---------------------------------------------------------------------

function formatPortsHuman(ports: Readonly<Record<string, number>>): string {
  return Object.entries(ports)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function formatLsHuman(instances: ReadonlyArray<LsInstanceRow>): string {
  if (instances.length === 0) {
    return "devtrees ls: no devtrees instances running.\n";
  }

  const idWidth = Math.max(2, ...instances.map((i) => i.id.length));
  const kindWidth = Math.max(4, ...instances.map((i) => i.kind.length));
  const statusWidth = Math.max(6, ...instances.map((i) => i.status.length));

  const header = `${"ID".padEnd(idWidth)}  ${"KIND".padEnd(kindWidth)}  ${"STATUS".padEnd(
    statusWidth,
  )}  PORTS`;
  const rows = instances.map((i) => {
    const ports =
      formatPortsHuman(i.ports) || (i.blockBase !== undefined ? `(block ${i.blockBase})` : "-");
    return `${i.id.padEnd(idWidth)}  ${i.kind.padEnd(kindWidth)}  ${i.status.padEnd(
      statusWidth,
    )}  ${ports}`;
  });
  return `${[header, ...rows].join("\n")}\n`;
}

interface LsInstanceJson {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  readonly status: "running" | "stale";
  readonly ports: Readonly<Record<string, number>>;
  readonly block_base?: number;
}

function lsInstanceJson(row: LsInstanceRow): LsInstanceJson {
  const base: LsInstanceJson = {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ports: row.ports,
  };
  return row.blockBase === undefined ? base : { ...base, block_base: row.blockBase };
}

export function formatLs(
  instances: ReadonlyArray<LsInstanceRow>,
  mode: FormatMode,
): OutputResult {
  if (mode === "json") {
    const doc = {
      schema_version: SCHEMA_VERSION,
      instances: instances.map(lsInstanceJson),
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  return { stdout: formatLsHuman(instances), stderr: "" };
}

// --- prune ------------------------------------------------------------------

function formatPruneHuman(pruned: ReadonlyArray<LsInstanceRow>): string {
  if (pruned.length === 0) {
    return "devtrees prune: no orphans to clean up.\n";
  }
  const lines = pruned.map((p) => `  ${p.id} (${p.kind}, was ${p.status})`);
  const noun = pruned.length === 1 ? "orphan" : "orphans";
  return `devtrees prune: cleaned ${pruned.length} ${noun}:\n${lines.join("\n")}\n`;
}

export function formatPrune(
  pruned: ReadonlyArray<LsInstanceRow>,
  mode: FormatMode,
): OutputResult {
  if (mode === "json") {
    const doc = {
      schema_version: SCHEMA_VERSION,
      pruned: pruned.map(lsInstanceJson),
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  return { stdout: formatPruneHuman(pruned), stderr: "" };
}

// --- up / down / generate (human path only for now) -------------------------

export interface UpPayload {
  readonly worktreeId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sharedStarted: boolean;
}

function formatUpHuman(payload: UpPayload): string {
  const ports = Object.entries(payload.env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join("\n");
  const sharedNote = payload.sharedStarted ? "devtrees up: shared instance started.\n" : "";
  return `${sharedNote}devtrees up: '${payload.worktreeId}' is up.\n${ports}\n`;
}

export function formatUp(payload: UpPayload, mode: FormatMode): OutputResult {
  if (mode === "json") {
    // Slice #4 lands the full state envelope; until then, JSON mode emits a
    // minimal acknowledgement so the seam exists and agents can detect success.
    const doc = {
      schema_version: SCHEMA_VERSION,
      up: {
        worktree_id: payload.worktreeId,
        env: payload.env,
        shared_started: payload.sharedStarted,
      },
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  return { stdout: formatUpHuman(payload), stderr: "" };
}

export function formatDown(args: { shared: boolean }, mode: FormatMode): OutputResult {
  if (mode === "json") {
    // Slice #8 lands the full prior-state envelope; minimal ack for now.
    const doc = {
      schema_version: SCHEMA_VERSION,
      down: { shared: args.shared },
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const text = args.shared
    ? "devtrees down: shared instance stopped.\n"
    : "devtrees down: worktree instance stopped.\n";
  return { stdout: text, stderr: "" };
}

export interface GeneratePayload {
  readonly worktreePath: string;
  readonly sharedPath?: string;
}

export function formatGenerate(payload: GeneratePayload, mode: FormatMode): OutputResult {
  if (mode === "json") {
    const doc = {
      schema_version: SCHEMA_VERSION,
      generate: {
        worktree_path: payload.worktreePath,
        ...(payload.sharedPath ? { shared_path: payload.sharedPath } : {}),
      },
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const lines = [
    `devtrees generate: wrote ${payload.worktreePath}`,
    ...(payload.sharedPath ? [`devtrees generate: wrote ${payload.sharedPath}`] : []),
    "",
  ];
  return { stdout: lines.join("\n"), stderr: "" };
}

// --- error envelope ---------------------------------------------------------

/**
 * Render an error.
 *
 * In `--json` mode: `{schema_version, error: {code, message, details?}}` to
 * stdout, nothing to stderr — the agent reads one stream and branches on
 * `error.code`.
 *
 * In human mode: `devtrees: <message>` to stderr — today's diagnostic.
 *
 * The caller is responsible for the exit code (non-zero) — `formatError`
 * produces output strings only.
 */
export function formatError(err: ErrorPayload, mode: FormatMode): OutputResult {
  if (mode === "json") {
    const error: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    const doc = { schema_version: SCHEMA_VERSION, error };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  return { stdout: "", stderr: `devtrees: ${err.message}\n` };
}

/**
 * Classify an unknown error caught at the CLI entrypoint into the documented
 * code enum. Pattern-based on the error message because the underlying error
 * sites (driver, commands) raise plain `Error`s today; later slices may attach
 * a `.code` field directly, which would short-circuit this.
 */
export function classifyError(err: Error): ErrorPayload {
  const message = err.message;
  if (/process-compose.*not found|not found.*process-compose/i.test(message)) {
    return { code: "PROCESS_COMPOSE_NOT_FOUND", message };
  }
  if (/no (worktree|shared) instance is running/i.test(message)) {
    return { code: "INSTANCE_NOT_FOUND", message };
  }
  return { code: "UNKNOWN", message };
}
