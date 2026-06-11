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

/**
 * Stable contract: present on every `--json` payload. Field additions are
 * non-breaking; renames and removals bump this. New error codes are additive.
 */
export const SCHEMA_VERSION = "1";

/**
 * The error-code enum the JSON error envelope carries (ADR-0005). Every code
 * listed here has a real throw site as of issue #84 (`CONFIG_INVALID` from
 * the stack loader, `LOCK_CONTENTION` from the registry locks closed the
 * formerly-reserved set); new codes are additive, renames are breaking.
 */
export const ERROR_CODES = [
  "PROCESS_COMPOSE_NOT_FOUND",
  "INSTANCE_NOT_FOUND",
  "HEALTH_TIMEOUT",
  "CONFIG_DRIFT",
  "SHARED_DRIFT",
  "SHARED_START_FAILED",
  "STALE_PORT_BLOCK",
  "LOCK_CONTENTION",
  "CONFIG_INVALID",
  "INVALID_ARGS",
  "UNKNOWN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * One-line description per error code, used by the per-subcommand `--help`
 * footers in `src/cli.ts` so an agent reading the help block sees what each
 * code means without bouncing through ADR-0005. Kept here (rather than in
 * `cli.ts`) so the wording stays adjacent to `ERROR_CODES` itself — adding a
 * new code without a description fails the exhaustive type check.
 *
 * Wording mirrors the per-throw-site error messages and ADR-0005's
 * surrounding prose; the JSON envelope's `error.message` carries the long
 * form, this is the agent-facing summary.
 */
export const ERROR_CODE_DESCRIPTIONS: Readonly<Record<ErrorCode, string>> = {
  PROCESS_COMPOSE_NOT_FOUND: "The `process-compose` binary is not on PATH.",
  INSTANCE_NOT_FOUND: "No worktree (or shared) instance is running for this anchor.",
  HEALTH_TIMEOUT:
    "Stack started but services did not report healthy before the wait window expired.",
  CONFIG_DRIFT: "Running config differs from devtrees.yaml and hot-reload failed.",
  SHARED_DRIFT:
    "This worktree's shared services diverge from the running shared instance; bring shared down and up again.",
  SHARED_START_FAILED: "The lazy-started shared instance died before binding its control socket.",
  STALE_PORT_BLOCK:
    "Foreign listeners hold ports in this worktree's allocated block (likely orphans).",
  LOCK_CONTENTION:
    "Another devtrees process holds a devtrees lock (allocation registry or an instance's lifecycle lock).",
  CONFIG_INVALID: "devtrees.yaml is malformed or rejected by the deriver.",
  INVALID_ARGS: "A flag value or positional argument failed validation before any effect ran.",
  UNKNOWN: "Unclassified failure; consult the error envelope's `message` field.",
};

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
 * One service inside an `ls` row (issue #29). Mirrors `instances.Service`
 * structurally — kept duplicated so the formatter doesn't depend on the
 * discovery module (the same loose-coupling rule the row type follows).
 */
export interface LsServiceRow {
  readonly name: string;
  readonly status: string;
  readonly health: "ready" | "not_ready" | "unknown";
  readonly ports: Readonly<Record<string, number>>;
}

/**
 * One row in the `ls` table. Kept loose so it doesn't pin the formatter to
 * `InstanceInfo` — `cli.ts` adapts both the test-injected stub shape and the
 * real discovery output into this row before calling `formatLs`. `services`
 * is optional so callers that don't populate it (the human path, older
 * tests) keep working; JSON output defaults missing values to `[]`.
 */
export interface LsInstanceRow {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  readonly status: "running" | "stale";
  readonly ports: Readonly<Record<string, number>>;
  readonly blockBase?: number;
  readonly services?: ReadonlyArray<LsServiceRow>;
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

interface LsServiceJson {
  readonly name: string;
  readonly status: string;
  readonly health: "ready" | "not_ready" | "unknown";
  readonly ports: Readonly<Record<string, number>>;
}

interface LsInstanceJson {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  readonly status: "running" | "stale";
  readonly ports: Readonly<Record<string, number>>;
  readonly services: ReadonlyArray<LsServiceJson>;
  readonly block_base?: number;
}

function lsServiceJson(svc: LsServiceRow): LsServiceJson {
  return { name: svc.name, status: svc.status, health: svc.health, ports: svc.ports };
}

function lsInstanceJson(row: LsInstanceRow): LsInstanceJson {
  const base: LsInstanceJson = {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ports: row.ports,
    services: (row.services ?? []).map(lsServiceJson),
  };
  return row.blockBase === undefined ? base : { ...base, block_base: row.blockBase };
}

/**
 * Render `devtrees ls` output.
 *
 *   - `human`: today's `id/kind/status/ports` table, byte-for-byte unchanged.
 *   - `json`: `{schema_version, ls: {instances: [<lsInstanceJson>, ...]}}`.
 *     The payload is wrapped under an `ls` key so it matches the convention
 *     every other JSON-emitting command follows (`up`, `down`, `prune`, `env`):
 *     one top-level key named after the command, holding the payload (#48,
 *     #54). The inner `lsInstanceJson` row shape is unchanged. Empty results
 *     still emit `{ls: {instances: []}}` — never the human "no instances"
 *     string.
 */
export function formatLs(instances: ReadonlyArray<LsInstanceRow>, mode: FormatMode): OutputResult {
  if (mode === "json") {
    const doc = {
      schema_version: SCHEMA_VERSION,
      ls: { instances: instances.map(lsInstanceJson) },
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  return { stdout: formatLsHuman(instances), stderr: "" };
}

// --- prune ------------------------------------------------------------------

/**
 * One reconciled-away orphan, as `prune` reports it. The `status` (running vs
 * stale at discovery) and `worktreePath` (where the worktree used to live)
 * carry the prior-state context the human path renders; the JSON path emits
 * only identity-and-location: `{id, kind, worktreePath}` (issue #48).
 */
export interface PrunedRow {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  /** Prior status at discovery — used by the human renderer only. */
  readonly status: "running" | "stale";
  /**
   * Absolute path of the worktree the orphan was anchored at. Used by both
   * renderers: human output shows it for context, JSON output emits it as the
   * sole non-identity field per #48.
   */
  readonly worktreePath: string;
}

function formatPruneHuman(pruned: ReadonlyArray<PrunedRow>): string {
  if (pruned.length === 0) {
    return "devtrees prune: no orphans to clean up.\n";
  }
  const lines = pruned.map((p) => `  ${p.id} (${p.kind}, was ${p.status})`);
  const noun = pruned.length === 1 ? "orphan" : "orphans";
  return `devtrees prune: cleaned ${pruned.length} ${noun}:\n${lines.join("\n")}\n`;
}

/**
 * `devtrees prune --json` envelope (issue #48). Lists every orphan the sweep
 * reconciled away under `prune.pruned[]`. Each entry is identity-only —
 * `{id, kind, worktreePath}` — because `prune` is a sweep over state that no
 * longer exists by the time the envelope is read: ports / services / status
 * described pre-prune state and have no meaning once the orphan is gone. The
 * list itself stays because `prune` is the only command that reconciles
 * devtrees-state vs `git worktree list`. Human output is unchanged.
 */
export function formatPrune(pruned: ReadonlyArray<PrunedRow>, mode: FormatMode): OutputResult {
  if (mode === "json") {
    const doc = {
      schema_version: SCHEMA_VERSION,
      prune: {
        pruned: pruned.map((p) => ({
          id: p.id,
          kind: p.kind,
          worktreePath: p.worktreePath,
        })),
      },
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
  /**
   * Base port of this worktree's allocated block (issue #30). Present on every
   * successful `up`; absent on the older minimal-ack shape some tests still
   * exercise. JSON output omits the field when undefined so the schema stays
   * a faithful reflection of what was actually allocated.
   */
  readonly blockBase?: number;
  /**
   * Runtime per-service rows the driver observed after health was reached
   * (issue #30) — same shape `ls --json` emits (slice #29). Optional so older
   * call sites (and unit tests that don't care) keep working; JSON mode
   * defaults a missing value to `[]` so the field is always present.
   */
  readonly services?: ReadonlyArray<LsServiceRow>;
}

function formatUpHuman(payload: UpPayload): string {
  const ports = Object.entries(payload.env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join("\n");
  const sharedNote = payload.sharedStarted ? "devtrees up: shared instance started.\n" : "";
  return `${sharedNote}devtrees up: '${payload.worktreeId}' is up.\n${ports}\n`;
}

/**
 * Render `devtrees up` output.
 *
 *   - `human`: today's "is up + KEY=value lines" text, untouched by the
 *     issue-#30 envelope fields.
 *   - `json`: the full success-state envelope an agent reads in one call
 *     (PRD #26 / issue #30): the allocated port block, the per-service
 *     runtime rows (same shape as `ls --json`'s `services[]`), and the
 *     injected-value map. The `HEALTH_TIMEOUT` failure envelope is unchanged
 *     and routed through `formatError`.
 */
export function formatUp(payload: UpPayload, mode: FormatMode): OutputResult {
  if (mode === "json") {
    const up: Record<string, unknown> = {
      worktree_id: payload.worktreeId,
      env: payload.env,
      services: (payload.services ?? []).map(lsServiceJson),
      shared_started: payload.sharedStarted,
    };
    if (payload.blockBase !== undefined) up.block_base = payload.blockBase;
    const doc = { schema_version: SCHEMA_VERSION, up };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  return { stdout: formatUpHuman(payload), stderr: "" };
}

/**
 * `devtrees down --json` payload (issue #48). The teardown action carries only
 * operation-identity: exactly one of `shared: true` (shared teardown) or
 * `worktreeId: "<id>"` (worktree teardown) — never both, never neither, encoded
 * as a discriminated union so the type system enforces the constraint. Agents
 * that want pre- or post-teardown state should call `ls --json` before/after
 * `down`; the action envelope does not pre-bake either snapshot.
 */
export type DownPayload =
  | { readonly shared: true; readonly worktreeId?: undefined; readonly stopped?: boolean }
  | { readonly shared?: false; readonly worktreeId: string; readonly stopped?: boolean };

/**
 * Render `devtrees down` output.
 *
 *   - `human`: one-liner — `worktree instance stopped` / `shared instance
 *     stopped`, or — when `stopped: false` (issue #92, idempotent no-op) —
 *     the "nothing to do" notice. Exit stays 0 either way; the no-op is not
 *     an error (it matches the `--shared` branch's long-standing semantics).
 *   - `json`: an operation-output-only envelope (issue #48) — `{schema_version,
 *     down:{shared:true, stopped}}` for a shared teardown or `{schema_version,
 *     down:{worktreeId:"<id>", stopped}}` for a worktree teardown. `stopped`
 *     (issue #92) is `false` when nothing was running and the call no-opped;
 *     it defaults to `true` for older callers that don't thread it. No env /
 *     services / block_base — that pre-teardown state belongs to `ls --json`,
 *     called before or after the action.
 */
export function formatDown(payload: DownPayload, mode: FormatMode): OutputResult {
  const shared = payload.shared === true;
  const stopped = payload.stopped ?? true;
  if (mode === "json") {
    const down: Record<string, unknown> = shared
      ? { shared: true, stopped }
      : { worktreeId: payload.worktreeId, stopped };
    const doc = { schema_version: SCHEMA_VERSION, down };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const text = shared
    ? stopped
      ? "devtrees down: shared instance stopped.\n"
      : "devtrees down: shared instance not running; nothing to do.\n"
    : stopped
      ? "devtrees down: worktree instance stopped.\n"
      : "devtrees down: no worktree instance running; nothing to do.\n";
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

// --- env --------------------------------------------------------------------

/**
 * Render the injected-value map a worktree instance would receive.
 *
 *   - `human`: one `KEY=value` line per entry — suitable for
 *     `eval $(devtrees env)`. Empty map renders as empty stdout.
 *   - `json`: `{schema_version, env: { KEY: "value", ... }}`.
 */
export function formatEnv(env: Readonly<Record<string, string>>, mode: FormatMode): OutputResult {
  if (mode === "json") {
    const doc = { schema_version: SCHEMA_VERSION, env };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const entries = Object.entries(env);
  if (entries.length === 0) return { stdout: "", stderr: "" };
  const lines = entries.map(([k, v]) => `${k}=${v}`);
  return { stdout: `${lines.join("\n")}\n`, stderr: "" };
}

// --- logs (streaming) -------------------------------------------------------

/**
 * One line of a service's log output, as the driver emits it. The formatter
 * renders these one-at-a-time so the command path stays streaming — there is
 * no `formatLogs(events[])` that materializes the full buffer.
 */
export interface LogLine {
  readonly ts: string;
  readonly service: string;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

export interface LogLineOptions {
  /**
   * Prefix the rendered line with `[service]` in human mode. Used when
   * `--all` interleaves multiple services so the reader can attribute lines;
   * ignored in JSON mode (the `service` field is the structured attribution).
   */
  readonly prefixService: boolean;
}

/**
 * Render one log event.
 *
 *   - `human`: the raw line, optionally prefixed with `[service]`.
 *   - `json`: an NDJSON line `{ts, service, stream, line}`. Schema is per-line —
 *     no top-level `schema_version` wrapper because the consumer reads one
 *     object per line, not one document for the whole stream.
 */
export function formatLogLine(
  event: LogLine,
  mode: FormatMode,
  opts: LogLineOptions,
): OutputResult {
  if (mode === "json") {
    const doc = {
      ts: event.ts,
      service: event.service,
      stream: event.stream,
      line: event.line,
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const prefix = opts.prefixService ? `[${event.service}] ` : "";
  return { stdout: `${prefix}${event.line}\n`, stderr: "" };
}

// --- error envelope ---------------------------------------------------------

/**
 * Render an error.
 *
 * The caller is responsible for the exit code (non-zero) — `formatError`
 * produces output strings only.
 *
 * Mode behaviour (ADR-0005):
 *
 *   - `json`: stdout gets `{schema_version, error: {code, message, details?}}`
 *     so the agent reads one stream and branches on `error.code`. Stderr also
 *     gets the human diagnostic line `devtrees: <message>` — the agent's
 *     captured log still contains a readable failure cause without merging
 *     streams. (On success, stderr stays untouched.)
 *   - `human`: stdout is empty; stderr gets `devtrees: <message>` — today's
 *     diagnostic, unchanged.
 */
export function formatError(err: ErrorPayload, mode: FormatMode): OutputResult {
  const humanDiagnostic = `devtrees: ${err.message}\n`;
  if (mode === "json") {
    const error: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    const doc = { schema_version: SCHEMA_VERSION, error };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: humanDiagnostic };
  }
  return { stdout: "", stderr: humanDiagnostic };
}

/**
 * Classify an unknown error caught at the CLI entrypoint into the documented
 * code enum. An error that carries a `.code` field matching one of the known
 * codes short-circuits the message-based heuristics — that's how typed errors
 * (e.g. `HealthTimeoutError`) surface their code without depending on the
 * exact wording of their message.
 *
 * Typed errors may also carry a `.details` field — propagated verbatim to
 * the JSON envelope. `StalePortBlockError` (#58) uses this to publish the
 * `{block_base, worktree_id, collisions[]}` payload an agent needs to act
 * on the failure.
 */
export function classifyError(err: Error): ErrorPayload {
  const message = err.message;
  const tagged = (err as { code?: unknown }).code;
  const details = readDetails(err);
  if (typeof tagged === "string" && (ERROR_CODES as ReadonlyArray<string>).includes(tagged)) {
    return details === undefined
      ? { code: tagged as ErrorCode, message }
      : { code: tagged as ErrorCode, message, details };
  }
  if (/process-compose.*not found|not found.*process-compose/i.test(message)) {
    return { code: "PROCESS_COMPOSE_NOT_FOUND", message };
  }
  if (/no (worktree|shared) instance is running/i.test(message)) {
    return { code: "INSTANCE_NOT_FOUND", message };
  }
  return { code: "UNKNOWN", message };
}

/**
 * Extract a typed error's `.details` field as a plain object so the JSON
 * envelope can publish it verbatim. Returns `undefined` (not an empty
 * object) when no details are present, so `formatError` keeps omitting the
 * key — preserving the "details only when meaningful" contract tested in
 * `output.test.ts`.
 */
function readDetails(err: Error): Readonly<Record<string, unknown>> | undefined {
  const raw = (err as { details?: unknown }).details;
  if (raw === null || typeof raw !== "object") return undefined;
  return raw as Readonly<Record<string, unknown>>;
}
