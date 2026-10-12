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
import { stringify as stringifyYaml } from "yaml";
import type { BracedEnvVar, DerivedConfig, DroppedEdge } from "./deriver.js";
import type { DroppedNamespaceEdge } from "./selection.js";
import type { SharedFieldChange } from "./shared-state.js";

export const SCHEMA_VERSION = "1";

/**
 * The error-code enum the JSON error envelope carries (ADR-0005). Every code
 * listed here has a real throw site as of issue #84 (`CONFIG_INVALID` from
 * the stack loader, `LOCK_CONTENTION` from the registry locks closed the
 * formerly-reserved set); new codes are additive, renames are breaking.
 */
export const ERROR_CODES = [
  "PROCESS_COMPOSE_NOT_FOUND",
  "PROCESS_COMPOSE_TOO_OLD",
  "INSTANCE_NOT_FOUND",
  "INSTANCE_UNRESPONSIVE",
  "DOWN_TIMEOUT",
  "SERVICE_NOT_FOUND",
  "HEALTH_TIMEOUT",
  "NAMESPACE_NOT_RUNNING",
  "SHARED_SERVICE_DEAD",
  "SERVICE_START_FAILED",
  "CONFIG_DRIFT",
  "SHARED_DRIFT",
  "SHARED_START_FAILED",
  "WORKTREE_START_FAILED",
  "NO_SERVICES_SELECTED",
  "SOCKET_PATH_TOO_LONG",
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
  PROCESS_COMPOSE_TOO_OLD:
    "The installed `process-compose` is older than the minimum devtrees supports; `details` carries the installed and minimum versions.",
  INSTANCE_NOT_FOUND: "No worktree (or shared) instance is running for this anchor.",
  INSTANCE_UNRESPONSIVE:
    "The instance's control socket exists but did not answer repeated probes (process-compose busy or frozen); nothing was started or stopped, the socket was kept, `details.remedy` says what to do.",
  DOWN_TIMEOUT:
    "The stop did not finish within its budget and process-compose was still running after devtrees force-killed the stuck services; the socket and config were kept, `details` names the stuck services, their pids and the process-compose pid, `details.remedy` says what to do.",
  SERVICE_NOT_FOUND:
    "The named service does not exist in the target instance; `details.valid_services` lists the known ones.",
  HEALTH_TIMEOUT:
    "Stack started but services did not report healthy before the wait window expired, or a selected service is dead, including one `up` restarted (`details.dead_services`).",
  NAMESPACE_NOT_RUNNING:
    "`up -n` named a namespace the running instance was not booted with; `details.remedy` is the `down` + `up` that boots it.",
  SHARED_SERVICE_DEAD:
    "A shared service in the running shared instance is dead; it is not restarted from a worktree, run `details.remedy` (`devtrees down --shared && devtrees up`).",
  SERVICE_START_FAILED:
    "`up` tried to restart a dead service on the running instance and process-compose refused; `details.services` names each one, `details.remedy` is the `down` + `up` that restarts the stack.",
  CONFIG_DRIFT:
    "Running config differs from devtrees.yaml and hot-reload failed, or an earlier reload is still pending; `details.reason` is `timeout`, `not_supported`, `error`, or `reload_pending` (nothing was reloaded: kill `details.pids`, then retry; empty `pids` means the old process is gone and process-compose is still starting the new one, so retry shortly).",
  SHARED_DRIFT:
    "This worktree's shared services diverge from the running shared instance; bring shared down and up again.",
  SHARED_START_FAILED:
    "The lazy-started shared instance died before binding its control socket; `details.config_path` is the config to run by hand.",
  WORKTREE_START_FAILED:
    "This worktree's instance died before binding its control socket; `details.config_path` is the config to run by hand.",
  NO_SERVICES_SELECTED:
    "A bare `up` starts only the `default` namespace and it has no services; `details.namespaces` lists the namespaces to pass with `-n`.",
  SOCKET_PATH_TOO_LONG:
    "The control socket path exceeds the platform's unix-socket limit; set DEVTREES_RUNTIME_DIR to a shorter directory.",
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
  readonly status: "running" | "stale" | "unknown";
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
  readonly status: "running" | "stale" | "unknown";
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
  readonly status: "running" | "stale" | "unknown";
  /**
   * Absolute path of the worktree the orphan was anchored at. Used by both
   * renderers: human output shows it for context, JSON output emits it as the
   * sole non-identity field per #48.
   */
  readonly worktreePath: string;
  /**
   * Service processes devtrees had to SIGKILL to stop the orphan (#190).
   * JSON mode always emits `force_killed` (possibly empty).
   */
  readonly forceKilled?: ReadonlyArray<ForceKilledRow>;
}

/** A service process devtrees had to SIGKILL to finish a stop (issue #190). */
export interface ForceKilledRow {
  readonly service: string;
  readonly pid: number;
}

/**
 * The human stderr line for a stop that needed force (issue #190). Empty when
 * nothing was killed.
 */
function formatForceKilledStderr(
  command: string,
  what: string,
  killed: ReadonlyArray<ForceKilledRow>,
): string {
  if (killed.length === 0) return "";
  const list = killed.map((k) => `${k.service} (pid ${k.pid})`).join(", ");
  return (
    `devtrees ${command}: WARNING — ${what} did not stop within its budget; devtrees ` +
    `force-killed (SIGKILL) ${list} so process-compose could finish shutting down.\n`
  );
}

/**
 * A failed shutdown-hook reap, as the formatters render it (issue #148). The
 * reap is the author's `shutdown.command`; devtrees only knows the exit status
 * of the command it ran (ADR-0002), so it names the orphan + the failing
 * hook(s) and warns that out-of-band resources may survive.
 */
export interface ReapWarningRow {
  readonly orphanId: string;
  readonly worktreePath: string;
  readonly failures: ReadonlyArray<{
    readonly process: string;
    readonly command: string;
    readonly reason: "launch" | "exit" | "timeout";
    readonly message?: string;
  }>;
}

/**
 * Render a reap warning to a human-readable stderr block (issue #148). Names
 * the orphan, that out-of-band resources may survive, and each failing hook.
 */
function formatReapWarningStderr(w: ReapWarningRow): string {
  const where = w.worktreePath !== "" ? ` (was at ${w.worktreePath})` : "";
  const detail = w.failures
    .map(
      (f) => `  - ${f.process}: \`${f.command}\` ${f.reason}${f.message ? ` (${f.message})` : ""}`,
    )
    .join("\n");
  return (
    `devtrees: WARNING — orphan '${w.orphanId}'${where}: its shutdown hook did not complete ` +
    `cleanly, so out-of-band resources (e.g. containers/volumes) may still be running. ` +
    `Inspect and reap them manually:\n${detail}\n`
  );
}

/**
 * An orphan `prune` could not reclaim (issue #186): its process-compose did
 * not answer the liveness probe and `process-compose down` failed, so its
 * socket, config and registry entry were kept rather than orphaning a
 * possibly-live supervisor on its ports.
 */
export interface UnreclaimedRow {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  readonly worktreePath: string;
  readonly socketPath: string;
  readonly message: string;
  /** Service processes devtrees SIGKILLed before the stop timed out (#190). */
  readonly forceKilled?: ReadonlyArray<ForceKilledRow>;
}

function formatUnreclaimedStderr(u: UnreclaimedRow): string {
  const where = u.worktreePath !== "" ? ` (was at ${u.worktreePath})` : "";
  return (
    `devtrees: WARNING — orphan '${u.id}'${where} was NOT reclaimed: its process-compose could ` +
    `not be stopped (${u.message}). Its socket and state were ` +
    `kept. Find the holder with \`lsof -U -a ${u.socketPath}\`, stop it, then run ` +
    `\`devtrees prune\` again.\n`
  );
}

/** JSON shape for `force_killed` (#190): always an array, possibly empty. */
function forceKilledJson(
  killed: ReadonlyArray<ForceKilledRow> | undefined,
): Array<{ service: string; pid: number }> {
  return (killed ?? []).map((k) => ({ service: k.service, pid: k.pid }));
}

/** JSON shape for a reap warning — flat identity + failures, no wrapper. */
function reapWarningJson(w: ReapWarningRow): Record<string, unknown> {
  return {
    orphanId: w.orphanId,
    worktreePath: w.worktreePath,
    failures: w.failures.map((f) => ({
      process: f.process,
      command: f.command,
      reason: f.reason,
      ...(f.message !== undefined ? { message: f.message } : {}),
    })),
  };
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
export function formatPrune(
  pruned: ReadonlyArray<PrunedRow>,
  mode: FormatMode,
  warnings: ReadonlyArray<ReapWarningRow> = [],
  unreclaimed: ReadonlyArray<UnreclaimedRow> = [],
): OutputResult {
  if (mode === "json") {
    const doc = {
      schema_version: SCHEMA_VERSION,
      prune: {
        pruned: pruned.map((p) => ({
          id: p.id,
          kind: p.kind,
          worktreePath: p.worktreePath,
          // Issue #190: service processes force-killed to stop the orphan.
          force_killed: forceKilledJson(p.forceKilled),
        })),
        // Issue #148: a failed shutdown-hook reap is reflected here so an agent
        // does not read a clean teardown when out-of-band resources may survive.
        warnings: warnings.map(reapWarningJson),
        // Issue #186: orphans left in place because they could not be stopped.
        unreclaimed: unreclaimed.map((u) => ({
          id: u.id,
          kind: u.kind,
          worktreePath: u.worktreePath,
          socketPath: u.socketPath,
          message: u.message,
          force_killed: forceKilledJson(u.forceKilled),
        })),
      },
    };
    // Keep `--json` stdout byte-clean (ADR-0005): the warning goes only into the
    // structured envelope, never to stderr, in JSON mode.
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const stderr =
    pruned
      .map((p) => formatForceKilledStderr("prune", `orphan '${p.id}'`, p.forceKilled ?? []))
      .join("") +
    warnings.map(formatReapWarningStderr).join("") +
    unreclaimed.map(formatUnreclaimedStderr).join("");
  return { stdout: formatPruneHuman(pruned), stderr };
}

// --- up / down (human path only for now) ------------------------------------

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
  /**
   * `depends_on` edges dropped because their target is in no selected
   * namespace (#179). Human mode does not repeat them — `up` warned on stderr
   * as it ran; JSON mode always emits `dropped_namespace_edges` (possibly empty).
   */
  readonly droppedNamespaceEdges?: ReadonlyArray<DroppedNamespaceEdge>;
  /**
   * `${NAME}` references to devtrees-injected variables in service commands
   * (#200). Human mode does not repeat them (`up` warned on stderr); JSON mode
   * always emits `braced_env_vars` (possibly empty).
   */
  readonly bracedEnvVars?: ReadonlyArray<BracedEnvVar>;
  /**
   * Shared-service fields edited since the running shared instance started
   * (#185). Human mode does not repeat them — `up` warned on stderr as it ran;
   * JSON mode always emits `shared_config_changes` (possibly empty).
   */
  readonly sharedFieldChanges?: ReadonlyArray<SharedFieldChange>;
  /**
   * Dead services this `up` restarted on a running instance (issue #178).
   * Optional like `services`; JSON mode defaults a missing value to `[]`.
   */
  readonly restarted?: ReadonlyArray<string>;
}

function formatUpHuman(payload: UpPayload): string {
  const ports = Object.entries(payload.env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join("\n");
  const sharedNote = payload.sharedStarted ? "devtrees up: shared instance started.\n" : "";
  const restarted = payload.restarted ?? [];
  const restartNote =
    restarted.length > 0
      ? `devtrees up: restarted dead service(s): ${restarted.join(", ")}.\n`
      : "";
  return `${sharedNote}${restartNote}devtrees up: '${payload.worktreeId}' is up.\n${ports}\n`;
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
      // Always present, even empty (#179) — the `up_dry_run.dropped_edges`
      // contract (#169): an empty list is the answer "nothing was dropped".
      dropped_namespace_edges: (payload.droppedNamespaceEdges ?? []).map(droppedNamespaceEdgeJson),
      // Always present, even empty (#200), same contract.
      braced_env_vars: (payload.bracedEnvVars ?? []).map(bracedEnvVarJson),
      // Always present, even empty (#185), same contract.
      shared_config_changes: (payload.sharedFieldChanges ?? []).map(sharedFieldChangeJson),
      restarted: payload.restarted ?? [],
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
  | {
      readonly shared: true;
      readonly worktreeId?: undefined;
      readonly stopped?: boolean;
      /** Service processes devtrees had to SIGKILL to finish the stop (#190). */
      readonly forceKilled?: ReadonlyArray<ForceKilledRow>;
    }
  | {
      readonly shared?: false;
      readonly worktreeId: string;
      readonly stopped?: boolean;
      /** Service processes devtrees had to SIGKILL to finish the stop (#190). */
      readonly forceKilled?: ReadonlyArray<ForceKilledRow>;
      /**
       * Present when the dead-supervisor reap failed for at least one shutdown
       * hook (issue #148) — out-of-band resources may have survived. Human mode
       * adds a stderr warning; JSON mode adds a `down.warning` object.
       */
      readonly warning?: ReapWarningRow;
    };

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
 *
 * Both modes report a stop that needed force (issue #190): JSON always carries
 * `down.force_killed` (`[{service, pid}]`, empty on a clean stop); human mode
 * adds a stderr warning naming each killed process.
 */
export function formatDown(payload: DownPayload, mode: FormatMode): OutputResult {
  const shared = payload.shared === true;
  const stopped = payload.stopped ?? true;
  // The reap warning lives on the worktree variant only (shared down runs from
  // the anchor, which never disappears — issue #148).
  const warning = !shared ? payload.warning : undefined;
  if (mode === "json") {
    const forceKilled = forceKilledJson(payload.forceKilled);
    const down: Record<string, unknown> = shared
      ? { shared: true, stopped, force_killed: forceKilled }
      : { worktreeId: payload.worktreeId, stopped, force_killed: forceKilled };
    if (warning !== undefined) down.warning = reapWarningJson(warning);
    const doc = { schema_version: SCHEMA_VERSION, down };
    // `--json` stdout stays byte-clean (ADR-0005): the warning is in the envelope.
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const text = shared
    ? stopped
      ? "devtrees down: shared instance stopped.\n"
      : "devtrees down: shared instance not running; nothing to do.\n"
    : stopped
      ? "devtrees down: worktree instance stopped.\n"
      : "devtrees down: no worktree instance running; nothing to do.\n";
  const what = shared ? "the shared instance" : "the worktree instance";
  const stderr =
    formatForceKilledStderr("down", what, payload.forceKilled ?? []) +
    (warning !== undefined ? formatReapWarningStderr(warning) : "");
  return { stdout: text, stderr };
}

// --- up --dry-run -----------------------------------------------------------

/**
 * `devtrees up --dry-run` payload (#124). The derivation pipeline's output with
 * no side effects: the derived worktree config + the resolved env (allocated
 * worktree ports + injected shared ports), and — when the stack declares shared
 * services — the derived shared config + its env. A sibling reads the allocated
 * `WEB_PORT` (and shared `DB_PORT`) straight off `env`, and the full
 * process-compose document off `config`, without touching the filesystem — the
 * preview-the-derived-config use case, served with no disk write (#125).
 */
export interface UpDryRunPayload {
  readonly worktreeId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly config: DerivedConfig;
  /** Present iff the stack declares shared services. */
  readonly sharedEnv?: Readonly<Record<string, string>>;
  /** Present iff the stack declares shared services. */
  readonly sharedConfig?: DerivedConfig;
  /**
   * Cross-tier `depends_on` edges the derivation stripped (ADR-0003). Defaults
   * to empty so a caller that has nothing to report can omit it (issue #168).
   */
  readonly droppedEdges?: ReadonlyArray<DroppedEdge>;
  /**
   * `depends_on` edges a fresh `up` would lose to namespace selection (#179).
   * Defaults to empty, like `droppedEdges`.
   */
  readonly droppedNamespaceEdges?: ReadonlyArray<DroppedNamespaceEdge>;
  /** `${NAME}` references to injected variables in service commands (#200). */
  readonly bracedEnvVars?: ReadonlyArray<BracedEnvVar>;
  /**
   * The namespace selection a fresh `up` would pass to process-compose and the
   * isolated services it starts (issue #176). Optional so a caller with no
   * selection to report can omit it; the real `runUpDryRun` always fills it.
   */
  readonly selection?: {
    readonly namespaces: ReadonlyArray<string>;
    readonly services: ReadonlyArray<string>;
  };
}

/** Stderr line naming what a fresh `up` would start (issue #176). */
function formatSelectionNotice(selection: NonNullable<UpDryRunPayload["selection"]>): string {
  const services = selection.services.length > 0 ? selection.services.join(", ") : "(none)";
  return (
    `devtrees: up would start namespace(s) [${selection.namespaces.join(", ")}]: ` + `${services}\n`
  );
}

/**
 * One human-readable line per dropped cross-tier edge. Tells the developer
 * which edge devtrees lifted out of the derived config and why — the
 * orchestration layer is now responsible for the equivalent gating.
 *
 * Lives here, not in `commands.ts`, because both the real `up` path (which
 * warns as it derives) and `up --dry-run` (which warns as it previews) render
 * it: one drop, one wording (issue #168).
 */
export function formatDroppedEdgeWarning(edge: DroppedEdge): string {
  return (
    `devtrees: dropped cross-tier depends_on '${edge.from}' (${edge.fromTier}) -> ` +
    `'${edge.to}' (${edge.toTier}). ` +
    `Process-compose cannot express a dependency across instances (ADR-0003); ` +
    `devtrees waits for shared services to be healthy before starting the worktree instance instead.`
  );
}

/**
 * One human-readable line per `depends_on` edge process-compose drops because
 * its target is in no selected namespace (ADR-0008, #179). Shared by `up`
 * (which warns as it starts or verifies) and `up --dry-run`: one drop, one
 * wording, as for cross-tier edges.
 */
export function formatDroppedNamespaceEdgeWarning(edge: DroppedNamespaceEdge): string {
  const namespaces = edge.toNamespaces.join(", ");
  return (
    `devtrees: dropped cross-namespace depends_on '${edge.from}' -> '${edge.to}': ` +
    `'${edge.to}' is in namespace(s) [${namespaces}], none of which is selected, so ` +
    `process-compose starts '${edge.from}' without waiting for it. ` +
    `Select one of [${namespaces}] with -n to start '${edge.to}' too.`
  );
}

/**
 * One warning line per `${NAME}` in a service command that names a
 * devtrees-injected variable (#200). process-compose expands it at config load
 * from its own environment, so it runs empty; devtrees does not rewrite the
 * author's command (ADR-0002), it says so.
 */
export function formatBracedEnvVarWarning(v: BracedEnvVar): string {
  return (
    `devtrees: service '${v.service}' command uses '\${${v.variable}}', which process-compose ` +
    `expands at config load from its own environment (empty), not the process's. ` +
    `Use '$${v.variable}' (the shell expands it at run time) or '$\${${v.variable}}' ` +
    `to escape the interpolation.`
  );
}

/** Snake_case row for a `braced_env_vars[]` envelope entry (#200). */
function bracedEnvVarJson(v: BracedEnvVar): Record<string, string> {
  return { service: v.service, variable: v.variable };
}

/**
 * One warning line per shared-service field edited since the running shared
 * instance started (#185). Shared has no hot-reload, so the edit sits unapplied
 * until shared is restarted.
 */
export function formatSharedFieldChangeWarning(change: SharedFieldChange): string {
  return (
    `devtrees: shared service '${change.service}' changed '${change.field}' since the shared ` +
    `instance started; the change won't apply until ` +
    `\`devtrees down --shared && devtrees up\`.`
  );
}

/** Snake_case row for a `shared_config_changes[]` envelope entry (#185). */
function sharedFieldChangeJson(change: SharedFieldChange): Record<string, string> {
  return { service: change.service, field: change.field };
}

/** Snake_case row for a `dropped_namespace_edges[]` envelope entry (#179). */
function droppedNamespaceEdgeJson(edge: DroppedNamespaceEdge): Record<string, unknown> {
  return { from: edge.from, to: edge.to, to_namespaces: edge.toNamespaces };
}

/** Snake_case row for the `up_dry_run.dropped_edges[]` envelope entry. */
function droppedEdgeJson(edge: DroppedEdge): Record<string, string> {
  return { from: edge.from, to: edge.to, from_tier: edge.fromTier, to_tier: edge.toTier };
}

/**
 * Render `devtrees up --dry-run` output.
 *
 *   - `json`: `{schema_version, up_dry_run: {worktree_id, env, config,
 *     dropped_edges, dropped_namespace_edges, braced_env_vars, namespaces?,
 *     selected_services?, shared_env?, shared_config?}}` — one byte-clean document
 *     on stdout, the agent-readable preview of what `up` would run. `shared_*`
 *     keys are omitted when the stack has no shared services; `dropped_edges`
 *     and `dropped_namespace_edges` (#179) are always present (possibly
 *     empty). Stderr stays untouched.
 *   - `human`: the derived YAML document(s) — the worktree config, then the
 *     shared config (separated by a `---` document marker) when present. The
 *     same derived config `up` writes to disk; here it goes to stdout so a
 *     developer can eyeball it or pipe it into `process-compose -f -`. Any
 *     dropped cross-tier `depends_on` edge is reported on **stderr** (issue
 *     #168) so stdout stays byte-identical to the document alone; so is the
 *     namespace selection a fresh `up` would start (issue #176), and each
 *     `depends_on` edge that selection would drop (issue #179).
 */
export function formatUpDryRun(payload: UpDryRunPayload, mode: FormatMode): OutputResult {
  const droppedEdges = payload.droppedEdges ?? [];
  const nsEdges = payload.droppedNamespaceEdges ?? [];
  const braced = payload.bracedEnvVars ?? [];
  if (mode === "json") {
    const dry: Record<string, unknown> = {
      worktree_id: payload.worktreeId,
      env: payload.env,
      config: payload.config,
      // Always present, even empty — unlike `shared_*`, whose absence means the
      // stack has no shared tier at all. An empty list is a real answer ("the
      // derivation dropped nothing"), and always emitting it spares an agent
      // from having to tell that apart from an older devtrees that never
      // reported drops. Same contract `prune.pruned[]` / `prune.warnings[]`
      // already offer.
      dropped_edges: droppedEdges.map(droppedEdgeJson),
      // Same always-present contract for edges lost to namespace selection (#179).
      dropped_namespace_edges: nsEdges.map(droppedNamespaceEdgeJson),
      // Same always-present contract for braced injected variables (#200).
      braced_env_vars: braced.map(bracedEnvVarJson),
    };
    if (payload.selection !== undefined) {
      // What a fresh `up` with the same flags would start (issue #176): the
      // `-n` values forwarded to process-compose (`["default"]` for a bare
      // `up`) and the isolated services they select. `config` still lists
      // every service — process-compose applies `-n` at launch.
      dry.namespaces = payload.selection.namespaces;
      dry.selected_services = payload.selection.services;
    }
    if (payload.sharedConfig !== undefined) {
      dry.shared_env = payload.sharedEnv ?? {};
      dry.shared_config = payload.sharedConfig;
    }
    const doc = { schema_version: SCHEMA_VERSION, up_dry_run: dry };
    // Keep `--json` stdout byte-clean AND stderr silent (ADR-0005): the drop is
    // already in the envelope, so duplicating it on stderr would only pollute a
    // naive `2>&1` capture of the document the agent is trying to parse.
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const worktreeYaml = stringifyYaml(payload.config);
  const sharedYaml =
    payload.sharedConfig !== undefined ? stringifyYaml(payload.sharedConfig) : undefined;
  const body = sharedYaml === undefined ? worktreeYaml : `${worktreeYaml}---\n${sharedYaml}`;
  // Warnings go to stderr so stdout stays the previewed document verbatim —
  // `devtrees up --dry-run > stack.yaml` (or a pipe into `process-compose -f -`)
  // must not pick up prose.
  const selection = payload.selection !== undefined ? formatSelectionNotice(payload.selection) : "";
  const stderr =
    selection +
    droppedEdges.map((e) => `${formatDroppedEdgeWarning(e)}\n`).join("") +
    nsEdges.map((e) => `${formatDroppedNamespaceEdgeWarning(e)}\n`).join("") +
    braced.map((v) => `${formatBracedEnvVarWarning(v)}\n`).join("");
  return { stdout: body, stderr };
}

// --- init -------------------------------------------------------------------

/**
 * `devtrees init --agents` payload (issue #118). Names the file the onboarding
 * block landed in and whether this run created that file or updated an existing
 * one — the created-vs-updated signal an agent (or human) reads to know whether
 * the file is new. `path` is the absolute location; `target` the bare filename.
 */
export interface InitPayload {
  readonly target: string;
  readonly path: string;
  readonly action: "created" | "updated";
}

/**
 * Render `devtrees init --agents` output.
 *
 *   - `human`: a one-liner naming the file and the action, e.g.
 *     `devtrees init: created AGENTS.md with the agent onboarding block.`
 *   - `json`: `{schema_version, init: {target, path, action}}` — one top-level
 *     key named after the command, matching every other JSON-emitting command.
 */
export function formatInit(payload: InitPayload, mode: FormatMode): OutputResult {
  if (mode === "json") {
    const doc = {
      schema_version: SCHEMA_VERSION,
      init: { target: payload.target, path: payload.path, action: payload.action },
    };
    return { stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
  }
  const verb = payload.action === "created" ? "created" : "updated";
  return {
    stdout: `devtrees init: ${verb} ${payload.target} with the agent onboarding block.\n`,
    stderr: "",
  };
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
