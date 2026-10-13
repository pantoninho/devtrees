/**
 * process-compose driver (adapter).
 *
 * The thin shell-out boundary between devtrees and the external `process-compose`
 * binary. Each instance is controlled over its own unix domain socket under the
 * anchor's run dir (ADR-0001). The argv builders are pure and unit-tested; the
 * spawning side effects and the binary locator are injected so the orchestration
 * can be exercised against a stub `process-compose` in e2e tests.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";

/** Identifies one process-compose instance: its derived config and control socket. */
export interface InstanceRef {
  readonly configPath: string;
  readonly socketPath: string;
}

/** Raised when the `process-compose` binary cannot be found on PATH. */
export class MissingProcessComposeError extends Error {
  constructor(binary: string) {
    super(
      `${binary} not found. devtrees shells out to process-compose and does not embed it. ` +
        `Install it and ensure it is on your PATH: https://f1bonacc1.github.io/process-compose/installation/`,
    );
    this.name = "MissingProcessComposeError";
  }
}

/**
 * The oldest process-compose devtrees supports. v1.122.0 is the first release
 * that accepts a list-valued `namespace` (issue #173), which namespace
 * selection builds on.
 */
const MIN_PROCESS_COMPOSE_VERSION = "1.122.0";

const PROCESS_COMPOSE_UPGRADE_URL = "https://f1bonacc1.github.io/process-compose/installation/";

/** Raised when the installed process-compose is older than the supported minimum. */
class ProcessComposeTooOldError extends Error {
  readonly code = "PROCESS_COMPOSE_TOO_OLD" as const;
  readonly details: {
    readonly installed_version: string | null;
    readonly minimum_version: string;
    readonly upgrade_url: string;
  };
  constructor(installed: string | null) {
    super(
      // No `devtrees:` prefix — the CLI's human formatter adds one (output.ts).
      `${
        installed === null
          ? "could not determine the installed process-compose version"
          : `process-compose v${installed} is installed`
      }, but devtrees requires v${MIN_PROCESS_COMPOSE_VERSION} or newer. ` +
        `Upgrade process-compose (e.g. \`brew upgrade process-compose\`) and retry: ` +
        PROCESS_COMPOSE_UPGRADE_URL,
    );
    this.name = "ProcessComposeTooOldError";
    this.details = {
      installed_version: installed,
      minimum_version: MIN_PROCESS_COMPOSE_VERSION,
      upgrade_url: PROCESS_COMPOSE_UPGRADE_URL,
    };
  }
}

/** Extract `major.minor.patch` from `process-compose version --short` output. */
export function parseProcessComposeVersion(output: string): string | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** True when `version` (`major.minor.patch`) is at least `minimum`. */
export function isAtLeastVersion(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/**
 * Start the instance's server detached, over its UDS, with the TUI disabled.
 *
 * `namespaces` is forwarded verbatim as process-compose's repeatable
 * `-n/--namespace` flag (a `stringArray`) — one `-n <ns>` token per value
 * (issue #128). Empty / omitted means no flag, which is process-compose's
 * "run all namespaces" default. `runUp` never relies on that: a bare fresh
 * `up` resolves to `-n default` first (namespaces are opt-in, #176).
 */
export function buildUpArgs(inst: InstanceRef, namespaces: ReadonlyArray<string> = []): string[] {
  const args = ["up", "-f", inst.configPath, "-U", "-u", inst.socketPath, "-t=false"];
  for (const ns of namespaces) args.push("-n", ns);
  return args;
}

/** Stop the running instance by talking to its UDS. */
export function buildDownArgs(inst: InstanceRef): string[] {
  return ["down", "-U", "-u", inst.socketPath];
}

/** Attach a TUI to the running instance over its UDS. */
export function buildAttachArgs(inst: InstanceRef): string[] {
  return ["attach", "-U", "-u", inst.socketPath];
}

/**
 * process-compose's REST route that makes the server re-read its own config
 * files (the `-f` paths it was booted with) and apply the difference.
 *
 * devtrees hot-reloads through this route and not through the
 * `project update -f <file>` CLI (issue #194). The CLI loads the file
 * client-side and sends the project to the server as JSON. The loader sets
 * every process's `vars.PC_REPLICA_NUM` to a Go `int`, and the JSON round
 * trip turns it into a `float64`. process-compose compares old and new
 * process configs with `reflect.DeepEqual`, so on the first CLI update after
 * boot every process looks changed and the whole selected stack restarts.
 * This route loads the file inside the server, so both sides hold an `int`
 * and only processes that really changed restart. Never mix the two: after
 * one CLI update the server holds `float64`s, and the next reload through
 * this route would restart everything again.
 *
 * The server's loader expands `${VAR}` references with the server's own
 * environment, the one `devtrees up` booted it with, not the caller's.
 */
export const RELOAD_CONFIG_ROUTE = "/project/configuration";

/**
 * Outcome of a `reloadConfig` call. `ok:true` means process-compose swapped
 * the running graph in-place; `ok:false` means it did not: the running build
 * has no reload route (`not_supported`), the control socket could not be
 * reached or the new config could not be applied (`error`), or the reload
 * did not finish within its budget (`timeout`). Every failure routes through
 * `runUp` to the `CONFIG_DRIFT` envelope, with the reason in its details.
 */
type ReloadResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_supported" | "error" | "timeout";
      readonly message?: string;
    };

/**
 * Base budget for a config reload. process-compose's update stops
 * every changed or removed process, one after another, and returns only once
 * each old process has exited. It escalates to SIGKILL only on the plain
 * SIGTERM path, and only when `shutdown.timeout_seconds` is set explicitly.
 * Two shapes therefore never finish:
 *  - a process that ignores SIGTERM and declares no `shutdown.timeout_seconds`;
 *  - a `shutdown.command` that exits 0 without stopping the process. Here
 *    `shutdown.timeout_seconds` only bounds the command itself, and there is
 *    no SIGKILL fallback whatever its value.
 * In those cases the update (and every later `down`) blocks forever. The
 * budget turns that wait into a bounded `CONFIG_DRIFT`.
 */
const RELOAD_BASE_TIMEOUT_MS = 30_000;

/**
 * Reload budget for a derived config: the base budget plus every explicit
 * `shutdown.timeout_seconds`. That value bounds a legitimately slow stop:
 * on the SIGTERM path, process-compose waits up to that long before SIGKILL;
 * with a `shutdown.command`, it is the command's own timeout. Each changed
 * process is stopped in turn, so the values add up, and a reload that is
 * merely slow is never cut short.
 */
export function reloadTimeoutMs(config: ShutdownBudgetConfig): number {
  return shutdownBudgetMs(config, RELOAD_BASE_TIMEOUT_MS);
}

/** The slice of a derived config the stop budgets read. */
type ShutdownBudgetConfig = {
  readonly processes: Readonly<
    Record<string, { readonly shutdown?: Readonly<Record<string, unknown>> }>
  >;
};

/** `baseMs` plus every explicit, positive `shutdown.timeout_seconds` in `config`. */
function shutdownBudgetMs(config: ShutdownBudgetConfig, baseMs: number): number {
  let total = baseMs;
  for (const proc of Object.values(config.processes)) {
    const seconds = proc.shutdown?.timeout_seconds;
    if (typeof seconds === "number" && seconds > 0) total += seconds * 1000;
  }
  return total;
}

/**
 * Base budget for `process-compose down` (issue #190). The stop hangs on the
 * same two shapes the reload does (see `RELOAD_BASE_TIMEOUT_MS`):
 * process-compose waits with no timeout for a process that a
 * `shutdown.command` did not stop, or that ignores SIGTERM and declares no
 * `shutdown.timeout_seconds`. The budget turns that wait into a bounded
 * escalation (`boundedDown` in src/bounded-down.ts).
 */
const DOWN_BASE_TIMEOUT_MS = 30_000;

/**
 * `down` budget for a derived config: `baseMs` (default
 * `DOWN_BASE_TIMEOUT_MS`) plus every explicit `shutdown.timeout_seconds`,
 * mirroring `reloadTimeoutMs`. A missing config gets the base alone.
 */
export function downTimeoutMs(
  config: ShutdownBudgetConfig | undefined,
  baseMs: number = DOWN_BASE_TIMEOUT_MS,
): number {
  return config === undefined ? baseMs : shutdownBudgetMs(config, baseMs);
}

/**
 * Outcome of a bounded `down` call. `stopped` means `process-compose down`
 * returned 0. `timeout` means it was still waiting when the budget ran out;
 * the client was killed, but process-compose keeps shutting down server-side.
 */
export type DownOutcome =
  | { readonly stopped: true }
  | { readonly stopped: false; readonly reason: "timeout" };

/**
 * List the running processes of an instance over its UDS, in JSON. devtrees
 * always asks for JSON — the human table is for operators driving
 * process-compose directly; the driver parses the response.
 */
export function buildProcessListArgs(socketPath: string): string[] {
  return ["process", "list", "-U", "-u", socketPath, "-o", "json"];
}

/**
 * Start one process of a running instance over its UDS (issue #178). On
 * v1.122.0 this brings a dead process (killed, crashed, failed) back to
 * `Running`, and refuses a process that is already running.
 */
export function buildProcessStartArgs(socketPath: string, service: string): string[] {
  return ["process", "start", service, "-U", "-u", socketPath];
}

/**
 * Stop processes of a running instance over its UDS (`devtrees stop`, #223).
 * On v1.122.0 `process stop` takes several names, returns as soon as the
 * stop is requested (it does not wait for the exit), signals each process's
 * whole group, and fails ("Failed to stop") for a process that is not
 * running.
 */
export function buildProcessStopArgs(
  socketPath: string,
  services: ReadonlyArray<string>,
): string[] {
  return ["process", "stop", ...services, "-U", "-u", socketPath];
}

/**
 * Outcome of a `stopProcesses` call: `ok:false` carries process-compose's
 * own complaint (its output, the exit code, or the timeout).
 */
type StopRequestResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Budget for one `process stop` call: it returns once the stop is requested. */
const STOP_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Outcome of a `startProcess` call. `ok:true` with `alreadyRunning` means
 * process-compose refused only because the process was already running, so
 * this call started nothing. `ok:false` carries process-compose's own
 * complaint (its stderr, the exit code, or the timeout) for the
 * `SERVICE_START_FAILED` envelope.
 */
export type StartResult =
  | { readonly ok: true; readonly alreadyRunning: boolean }
  | {
      readonly ok: false;
      readonly message: string;
      /**
       * The client did not answer within its budget and was killed. Not a
       * refusal: process-compose may still be carrying the start out, so
       * `restart` re-reads the state before deciding (#222).
       */
      readonly timedOut?: true;
    };

/**
 * Budget for one `process start` call. On v1.122.0 it returns as soon as the
 * process is spawned, well under a second. `up` holds the worktree's
 * lifecycle lock while it restarts services, so a client that hangs must not
 * hold that lock for long.
 */
const START_TIMEOUT_MS = 10_000;

/**
 * Cap on one `process list` read. A healthy instance answers in tens of
 * milliseconds; a wedged one (SIGSTOP, deadlock) never does, and the client
 * has no timeout of its own. Health waits pass a smaller per-call value when
 * their remaining budget is below the cap.
 */
export const READ_TIMEOUT_MS = 5_000;

/**
 * process-compose's refusal to start a process that is already running. Not a
 * failure for `up`: another `up`, or the process's own restart policy, got
 * there first, and the health wait judges the result like any other run.
 */
const ALREADY_RUNNING = /already running/i;

/** Health-state surface devtrees exposes for a service in a running instance. */
export type HealthState = "ready" | "not_ready" | "unknown";

/**
 * One service's runtime state, as the driver reads it from
 * `process-compose process list -o json`. `status` is process-compose's own
 * string (e.g. "Running", "Completed", "Failed", "Pending"); `health`
 * normalises the orthogonal readiness signal so callers can branch on it
 * without sniffing the multiple shapes process-compose has emitted over its
 * history (`is_ready` strings vs. a boolean `ready` field).
 */
export interface ServiceStatus {
  readonly name: string;
  readonly status: string;
  readonly health: HealthState;
  /**
   * process-compose's `exit_code`, when the row carries one. Only meaningful
   * once the process has stopped: it is what tells a crashed `Completed`
   * (non-zero, `-1` for a signal) from a finished one-shot (`0`) — see
   * `classifyService` (ADR-0008). Never published in `ls`/`up --json` rows.
   */
  readonly exitCode?: number;
  /**
   * The namespaces process-compose reports for the process (#179). v1.122.0
   * emits `namespace` as a string, or as a list for a service declared in
   * several; both normalise to a list here. Absent when the row carries no
   * usable `namespace`. Not published in `ls`/`up --json` rows.
   */
  readonly namespaces?: ReadonlyArray<string>;
  /**
   * process-compose's `pid` for the row's latest run, when it reported one. A
   * dead row keeps the pid of the run that died, so after `up` restarts a
   * service (#178) a dead row with the OLD pid is the stale pre-restart
   * state, and one with a NEW pid is the restarted run dying again.
   */
  readonly pid?: number;
  /**
   * process-compose's `is_running`, when the row carries it (#226). `false`
   * while a service waits out a restart backoff (`Restarting`): its `pid` is
   * then the run that died. Not published in `ls`/`up --json` rows.
   */
  readonly running?: boolean;
}

interface RawProc {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly is_ready?: unknown;
  readonly ready?: unknown;
  readonly is_running?: unknown;
  readonly exit_code?: unknown;
  readonly namespace?: unknown;
  readonly pid?: unknown;
}

/**
 * Normalise process-compose's `namespace` (#179): a string, or a list of
 * strings for a service in several namespaces. Anything else — absent, empty,
 * a list with no string entries — is `undefined` rather than a guess.
 */
function readNamespaces(raw: unknown): string[] | undefined {
  if (typeof raw === "string") return raw === "" ? undefined : [raw];
  if (!Array.isArray(raw)) return undefined;
  const names = raw.filter((ns): ns is string => typeof ns === "string" && ns !== "");
  return names.length > 0 ? names : undefined;
}

function readProbeVerdict(raw: RawProc): HealthState {
  if (typeof raw.ready === "boolean") return raw.ready ? "ready" : "not_ready";
  if (raw.is_ready === "Ready") return "ready";
  if (raw.is_ready === "Not Ready") return "not_ready";
  return "unknown";
}

/**
 * process-compose keeps reporting `is_ready: "Ready"` after a probed process
 * dies (issue #174), so a stale verdict must not outlive the process: a row
 * that says `is_running: false` is never `ready`. Only a `ready` verdict is
 * overridden — an unprobed one-shot that finished (`is_ready: "-"`) stays
 * `unknown`, which is what keeps the status-based health wait passing for it.
 * A row without `is_running` (older shape) keeps the probe verdict as-is.
 */
function readHealth(raw: RawProc): HealthState {
  const verdict = readProbeVerdict(raw);
  if (verdict === "ready" && raw.is_running === false) return "not_ready";
  return verdict;
}

/**
 * Parse `process-compose process list -o json` output into a `ServiceStatus[]`.
 *
 * process-compose has emitted both a bare array and a `{processes: [...]}`
 * envelope across versions, so this accepts either. Rows missing the
 * mandatory fields (name, status) are dropped — the driver only surfaces
 * well-formed runtime state, never partial guesses.
 */
export function parseServiceStatuses(stdout: string): ServiceStatus[] {
  const parsed: unknown = JSON.parse(stdout);
  const items: ReadonlyArray<RawProc> = Array.isArray(parsed)
    ? (parsed as ReadonlyArray<RawProc>)
    : (((parsed as { processes?: unknown }).processes ?? []) as ReadonlyArray<RawProc>);
  const out: ServiceStatus[] = [];
  for (const raw of items) {
    if (typeof raw.name !== "string" || typeof raw.status !== "string") continue;
    const namespaces = readNamespaces(raw.namespace);
    out.push({
      name: raw.name,
      status: raw.status,
      health: readHealth(raw),
      ...(typeof raw.exit_code === "number" ? { exitCode: raw.exit_code } : {}),
      ...(namespaces !== undefined ? { namespaces } : {}),
      ...(typeof raw.pid === "number" && raw.pid > 0 ? { pid: raw.pid } : {}),
      ...(typeof raw.is_running === "boolean" ? { running: raw.is_running } : {}),
    });
  }
  return out;
}

/** Tunable flags shared by `buildLogsArgs` and `streamLogs`. */
export interface LogsFlags {
  /** Keep streaming after the historical buffer drains (process-compose `-f`). */
  readonly follow?: boolean;
  /** Start at the last N lines (process-compose `-n N`). */
  readonly tail?: number;
}

/** Options for `streamLogs` — `LogsFlags` plus the single service to stream. */
export interface StreamLogsOptions extends LogsFlags {
  /** Name of the service to stream. One subprocess per service; `--all` is handled by the caller. */
  readonly service: string;
}

/**
 * Build the argv for `process-compose process logs <service>` over the
 * instance's UDS in raw-log mode (no per-line process-name prefix; the driver
 * attaches service attribution itself when emitting `LogEvent`s).
 */
export function buildLogsArgs(socketPath: string, service: string, opts: LogsFlags): string[] {
  const args = ["process", "logs", service, "-U", "-u", socketPath, "--raw-log"];
  if (opts.follow) args.push("-f");
  if (opts.tail !== undefined) args.push("-n", String(opts.tail));
  return args;
}

/** A single line of log output, normalized into the NDJSON shape `devtrees logs --json` emits. */
export interface LogEvent {
  /** ISO 8601 timestamp captured by the driver when the line was read. */
  readonly ts: string;
  /** Service name (matches the `process-compose` service this came from). */
  readonly service: string;
  /** Always "stdout" today — `process-compose process logs` does not split streams. */
  readonly stream: "stdout" | "stderr";
  /** The log line content, without trailing newline. */
  readonly line: string;
}

/** Minimal child-process surface the driver relies on. */
export interface SpawnedProcess {
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number | null) => void): void;
  unref?(): void;
  /** Stdout pipe — present when the caller asked for piped stdio (e.g. logs, getServiceStatuses). */
  readonly stdout?: NodeJS.ReadableStream | null;
  /** Stderr pipe — present when the caller asked for piped stdio. */
  readonly stderr?: NodeJS.ReadableStream | null;
  /** Send a signal to the child (e.g. on cancellation). */
  kill?(signal?: NodeJS.Signals | number): boolean;
}

/** Spawn a process-compose subprocess. Injected so tests can stub it. */
export type Spawner = (
  binary: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedProcess;

/** One HTTP request to an instance's REST API over its control socket. */
export interface ControlRequest {
  readonly socketPath: string;
  readonly method: "POST";
  readonly path: string;
  /** Aborts the request when the caller's budget runs out. */
  readonly signal: AbortSignal;
}

/** The status and body process-compose answered a `ControlRequest` with. */
export interface ControlResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Send a `ControlRequest`. Rejects when the socket cannot be reached or the
 * request is aborted. Injected so tests can stub the REST API.
 */
export type ControlRequester = (request: ControlRequest) => Promise<ControlResponse>;

/** Default `ControlRequester`: plain HTTP over the unix socket. */
function httpOverSocket(request: ControlRequest): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: request.socketPath,
        method: request.method,
        path: request.path,
        signal: request.signal,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export interface DriverDeps {
  /** Path/name of the process-compose binary. Default: "process-compose". */
  readonly binary?: string;
  /**
   * Args prepended before the process-compose subcommand. Lets a test run a stub
   * via an interpreter (e.g. `node stub.mjs <args>`); empty for the real binary.
   */
  readonly prefixArgs?: ReadonlyArray<string>;
  /** Resolve whether `binary` exists on PATH. Default: probes the real PATH. */
  readonly exists?: (binary: string) => Promise<boolean>;
  readonly spawner?: Spawner;
  /** Talks to an instance's REST API. Default: HTTP over the control socket. */
  readonly controlRequest?: ControlRequester;
  /**
   * Fixed `reloadConfig` budget in milliseconds, for tests. When set, it wins
   * over the per-call `timeoutMs`.
   */
  readonly reloadTimeoutMs?: number;
  /** Cap on one `getServiceStatuses` read in milliseconds, for tests. Default: 5s. */
  readonly readTimeoutMs?: number;
  /** Fixed `startProcess` budget in milliseconds, for tests. Default: 10s. */
  readonly startTimeoutMs?: number;
}

async function ensureBinary(deps: Required<Pick<DriverDeps, "binary" | "exists">>): Promise<void> {
  if (!(await deps.exists(deps.binary))) {
    throw new MissingProcessComposeError(deps.binary);
  }
}

/** Probe PATH for a binary by attempting to spawn it with `--version`. */
function defaultExists(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(true));
  });
}

/**
 * A driver bound to a binary + spawner. Operations start/stop a per-instance
 * server and attach a TUI, each over the instance's UDS.
 */
export function createDriver(deps: DriverDeps = {}) {
  const binary = deps.binary ?? "process-compose";
  const prefix = deps.prefixArgs ?? [];
  const exists = deps.exists ?? defaultExists;
  const spawner = deps.spawner ?? (spawn as unknown as Spawner);

  async function run(args: string[], options: SpawnOptions): Promise<void> {
    await ensureBinary({ binary, exists });
    await new Promise<void>((resolve, reject) => {
      const child = spawner(binary, [...prefix, ...args], options);
      child.on("error", (err) => reject(err));
      child.on("exit", (code) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`${binary} ${args[0]} exited with code ${code}`));
      });
    });
  }

  return {
    /**
     * Start the instance's server in the background. `namespaces` (issue #128)
     * is forwarded verbatim as process-compose's repeatable `-n` flag; empty
     * means process-compose's all-namespaces default, which `runUp` never
     * passes on a fresh start (#176).
     */
    async up(inst: InstanceRef, namespaces: ReadonlyArray<string> = []): Promise<void> {
      await ensureBinary({ binary, exists });
      const child = spawner(binary, [...prefix, ...buildUpArgs(inst, namespaces)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref?.();
    },
    /**
     * Fail with `ProcessComposeTooOldError` unless the installed process-compose
     * is at least `MIN_PROCESS_COMPOSE_VERSION` (issue #173). One shell-out to
     * `process-compose version --short`, which prints just the version tag.
     */
    async assertSupportedVersion(): Promise<void> {
      await ensureBinary({ binary, exists });
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawner(binary, [...prefix, "version", "--short"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout?.on("data", (chunk: Buffer | string) => {
          out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        child.on("error", (err) => reject(err));
        // An unparseable result (older build rejecting `--short`, odd output)
        // is reported as an unknown version rather than a crash.
        child.on("exit", () => resolve(out));
      });
      const installed = parseProcessComposeVersion(stdout);
      if (installed === null || !isAtLeastVersion(installed, MIN_PROCESS_COMPOSE_VERSION)) {
        throw new ProcessComposeTooOldError(installed);
      }
    },
    /**
     * Stop the running instance, bounded by `timeoutMs` (default
     * `DOWN_BASE_TIMEOUT_MS`, issue #190). Rejects when `process-compose down`
     * exits non-zero. When the budget runs out the client is killed and the
     * call resolves `timeout`; the caller decides how to escalate.
     */
    async down(
      inst: InstanceRef,
      opts: { readonly timeoutMs?: number } = {},
    ): Promise<DownOutcome> {
      await ensureBinary({ binary, exists });
      const timeoutMs = opts.timeoutMs ?? DOWN_BASE_TIMEOUT_MS;
      return downImpl(inst, { binary, prefix, exists, spawner, timeoutMs });
    },
    /** Attach a TUI to the running instance. */
    attach(inst: InstanceRef): Promise<void> {
      return run(buildAttachArgs(inst), { stdio: "inherit" });
    },
    /**
     * Read every service's runtime state from a running instance: one shell-out
     * to `process-compose process list -o json` over the UDS, parsed into
     * `ServiceStatus[]`. Stays lock-free — this is a read against the
     * instance, never the allocation registry.
     */
    async getServiceStatuses(
      socketPath: string,
      opts: { readonly timeoutMs?: number } = {},
    ): Promise<ServiceStatus[]> {
      const cap = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
      const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? cap, cap));
      return getServiceStatusesImpl(socketPath, { binary, prefix, exists, spawner, timeoutMs });
    },
    /**
     * Start one process of the running instance at `socketPath`
     * (`process-compose process start <name>`, issue #178). Resolves
     * `ok:false` with process-compose's message when it refuses or errors,
     * or when it does not answer within the start budget (the client is then
     * killed). A refusal because the process is already running is `ok`,
     * flagged `alreadyRunning`.
     */
    startProcess(socketPath: string, service: string): Promise<StartResult> {
      const timeoutMs = deps.startTimeoutMs ?? START_TIMEOUT_MS;
      return startProcessImpl(socketPath, service, {
        binary,
        prefix,
        exists,
        spawner,
        timeoutMs,
      });
    },
    /**
     * Ask the running instance at `socketPath` to stop `services`
     * (`process-compose process stop <name...>`, #223). Resolves once
     * process-compose has accepted or refused the request, not when the
     * processes have exited: the caller waits for that itself.
     */
    async stopProcesses(
      socketPath: string,
      services: ReadonlyArray<string>,
    ): Promise<StopRequestResult> {
      await ensureBinary({ binary, exists });
      const args = [...prefix, ...buildProcessStopArgs(socketPath, services)];
      const child = spawner(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      const stdout = captureOutput(child.stdout);
      const stderr = captureOutput(child.stderr);
      const exit = await waitForExitWithin(child, STOP_REQUEST_TIMEOUT_MS).catch((err: Error) => ({
        timedOut: false as const,
        code: -1,
        error: err.message,
      }));
      if (exit.timedOut) {
        return { ok: false, message: `${binary} process stop did not answer within 10s` };
      }
      if (exit.code === 0 || exit.code === null) return { ok: true };
      const said = "error" in exit ? exit.error : plainText(`${stdout()}\n${stderr()}`);
      return { ok: false, message: said || `${binary} process stop exited with code ${exit.code}` };
    },
    /**
     * Stream a service's logs from the instance at `socketPath` as an async
     * iterable of `LogEvent`s. Spawns `process-compose process logs <service>`
     * with piped stdout, reads it line-by-line, and emits one event per line
     * tagged with the wall-clock time the line was read (process-compose's
     * `process logs` does not carry per-line timestamps).
     *
     * Lock-free — concurrent agents tailing sibling worktrees do not contend
     * on a shared lock (acceptance, #33).
     */
    streamLogs(socketPath: string, opts: StreamLogsOptions): AsyncIterable<LogEvent> {
      return streamLogsImpl(socketPath, opts, { binary, prefix, exists, spawner });
    },
    /**
     * Ask the running instance to re-read its config and swap it in-place,
     * over `RELOAD_CONFIG_ROUTE` (issue #194). The server re-reads the `-f`
     * path it was booted with, which is `inst.configPath`: write the new
     * config there first. Returns a structured `ReloadResult`: `ok:true`
     * on a 200, `ok:false` on any failure. `not_supported`, `error` and
     * `timeout` all map to `CONFIG_DRIFT` at the CLI.
     *
     * Bounded by `timeoutMs` (default: the base reload budget). When the budget
     * runs out, the request is aborted and `timeout` is returned.
     * process-compose keeps applying the update server-side.
     */
    reloadConfig(
      inst: InstanceRef,
      opts: { readonly timeoutMs?: number } = {},
    ): Promise<ReloadResult> {
      const timeoutMs = deps.reloadTimeoutMs ?? opts.timeoutMs ?? RELOAD_BASE_TIMEOUT_MS;
      return reloadConfigImpl(inst, { request: deps.controlRequest ?? httpOverSocket, timeoutMs });
    },
  };
}

/** The binary + spawner a one-shot driver call shells out through. */
interface ShellDeps {
  readonly binary: string;
  readonly prefix: ReadonlyArray<string>;
  readonly exists: (binary: string) => Promise<boolean>;
  readonly spawner: Spawner;
}

/** Accumulate everything written to `stream`; read it back with the returned getter. */
function captureOutput(stream: NodeJS.ReadableStream | null | undefined): () => string {
  let out = "";
  stream?.on("data", (chunk: Buffer | string) => {
    out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  return () => out;
}

async function getServiceStatusesImpl(
  socketPath: string,
  deps: ShellDeps & { readonly timeoutMs: number },
): Promise<ServiceStatus[]> {
  await ensureBinary({ binary: deps.binary, exists: deps.exists });
  const child = deps.spawner(deps.binary, [...deps.prefix, ...buildProcessListArgs(socketPath)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stdout = captureOutput(child.stdout);
  // A wedged process-compose accepts the connection and never answers, so
  // the client would wait forever. Kill it and fail the read.
  const exit = await waitForExitWithin(child, deps.timeoutMs);
  if (exit.timedOut) {
    throw new Error(
      `${deps.binary} process list did not answer within ${formatSeconds(deps.timeoutMs)}`,
    );
  }
  if (exit.code !== 0 && exit.code !== null) {
    throw new Error(`${deps.binary} process list exited with code ${exit.code}`);
  }
  return parseServiceStatuses(stdout() || "[]");
}

async function downImpl(
  inst: InstanceRef,
  deps: ShellDeps & { readonly timeoutMs: number },
): Promise<DownOutcome> {
  const child = deps.spawner(deps.binary, [...deps.prefix, ...buildDownArgs(inst)], {
    stdio: "inherit",
  });
  // process-compose's `down` client has no timeout of its own and blocks
  // while the server waits on a process that never stops. Kill the client
  // on expiry; the server's shutdown carries on without it.
  const exit = await waitForExitWithin(child, deps.timeoutMs);
  if (exit.timedOut) return { stopped: false, reason: "timeout" };
  if (exit.code === 0 || exit.code === null) return { stopped: true };
  throw new Error(`${deps.binary} down exited with code ${exit.code}`);
}

/**
 * Wait for a one-shot client to exit, at most `timeoutMs`. On expiry the
 * client is sent SIGTERM and `timedOut` is reported. Rejects on a spawn error.
 */
function waitForExitWithin(
  child: SpawnedProcess,
  timeoutMs: number,
): Promise<
  { readonly timedOut: true } | { readonly timedOut: false; readonly code: number | null }
> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill?.("SIGTERM");
      resolve({ timedOut: true });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code });
    });
  });
}

function formatSeconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

async function startProcessImpl(
  socketPath: string,
  service: string,
  deps: ShellDeps & { readonly timeoutMs: number },
): Promise<StartResult> {
  await ensureBinary({ binary: deps.binary, exists: deps.exists });
  const args = [...deps.prefix, ...buildProcessStartArgs(socketPath, service)];
  const child = deps.spawner(deps.binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = captureOutput(child.stderr);
  let exit: Awaited<ReturnType<typeof waitForExitWithin>>;
  try {
    exit = await waitForExitWithin(child, deps.timeoutMs);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (exit.timedOut) {
    return {
      ok: false,
      message: `${deps.binary} process start did not finish within ${Math.round(deps.timeoutMs / 1000)}s`,
      timedOut: true,
    };
  }
  return startOutcome(exit.code, stderr(), deps.binary);
}

/** Map a finished `process start` client to its `StartResult`. */
function startOutcome(code: number | null, stderr: string, binary: string): StartResult {
  if (code === 0 || code === null) return { ok: true, alreadyRunning: false };
  if (ALREADY_RUNNING.test(stderr)) return { ok: true, alreadyRunning: true };
  return { ok: false, message: describeStartFailure(stderr, binary, code) };
}

/**
 * process-compose logs a refusal as one colourised log line
 * (`FTL failed to start process x error="no such process: x"`). Strip the
 * ANSI escapes so the message reads cleanly in an error envelope.
 */
function describeStartFailure(stderr: string, binary: string, code: number): string {
  const plain = plainText(stderr);
  return plain === "" ? `${binary} process start exited with code ${code}` : plain;
}

/** process-compose output with its ANSI colour escapes stripped and trimmed. */
function plainText(output: string): string {
  // eslint-disable-next-line no-control-regex
  return output.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

/**
 * process-compose's complaint from a refused reload. A load failure answers
 * 400 with `{"error": "..."}`. A partial failure answers 207 with the
 * per-process status map. Anything else is passed through as-is.
 */
function describeReloadRefusal(response: ControlResponse): string {
  const prefix = `process-compose config reload answered HTTP ${response.status}`;
  const body = response.body.trim();
  if (body === "") return prefix;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
      return `${prefix}: ${String((parsed as { error: unknown }).error)}`;
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return `${prefix}: ${body}`;
}

async function reloadConfigImpl(
  inst: InstanceRef,
  deps: { readonly request: ControlRequester; readonly timeoutMs: number },
): Promise<ReloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const response = await deps.request({
      socketPath: inst.socketPath,
      method: "POST",
      path: RELOAD_CONFIG_ROUTE,
      signal: controller.signal,
    });
    if (response.status === 200) return { ok: true };
    return {
      ok: false,
      reason: response.status === 404 ? "not_supported" : "error",
      message: describeReloadRefusal(response),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        reason: "timeout",
        message:
          `process-compose config reload did not finish within ` +
          `${Math.round(deps.timeoutMs / 1000)}s; a changed service's old process has not stopped`,
      };
    }
    return { ok: false, reason: "error", message: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge N async iterables into one. Races each iterator's `next()` and yields
 * whichever event arrives first; finishes when every iterator is done. On
 * consumer break/throw, the `return()` calls cascade to each underlying
 * iterator so the spawned children are killed (the `streamLogs` `finally`
 * block). Lives next to `streamLogs` because its callers merge per-service
 * log streams (issue #87 moved it out of the orchestration module).
 */
export async function* mergeAsyncIterables<T>(
  iterables: ReadonlyArray<AsyncIterable<T>>,
): AsyncIterable<T> {
  if (iterables.length === 0) return;
  if (iterables.length === 1) {
    const only = iterables[0];
    if (only === undefined) return;
    yield* only;
    return;
  }
  type Live = {
    it: AsyncIterator<T>;
    pending: Promise<{ live: Live; result: IteratorResult<T> }>;
  };
  const lives: Live[] = [];
  for (const iterable of iterables) {
    const it = iterable[Symbol.asyncIterator]();
    const slot: Live = { it, pending: Promise.resolve() as unknown as Live["pending"] };
    slot.pending = it.next().then((result) => ({ live: slot, result }));
    lives.push(slot);
  }

  try {
    while (lives.length > 0) {
      const { live, result } = await Promise.race(lives.map((l) => l.pending));
      if (result.done) {
        const idx = lives.indexOf(live);
        if (idx >= 0) lives.splice(idx, 1);
        continue;
      }
      yield result.value;
      live.pending = live.it.next().then((r) => ({ live, result: r }));
    }
  } finally {
    await Promise.allSettled(lives.map((l) => Promise.resolve(l.it.return?.(undefined))));
  }
}

/**
 * Implementation of `streamLogs`. Kept as a top-level async generator so the
 * `createDriver` factory body stays a flat object literal — the closure over
 * `binary`/`prefix`/`exists`/`spawner` is threaded in explicitly.
 */
async function* streamLogsImpl(
  socketPath: string,
  opts: StreamLogsOptions,
  deps: {
    readonly binary: string;
    readonly prefix: ReadonlyArray<string>;
    readonly exists: (binary: string) => Promise<boolean>;
    readonly spawner: Spawner;
  },
): AsyncIterable<LogEvent> {
  await ensureBinary({ binary: deps.binary, exists: deps.exists });

  const args = [...deps.prefix, ...buildLogsArgs(socketPath, opts.service, opts)];
  const child = deps.spawner(deps.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error("process-compose child has no stdout — cannot stream logs");
  }

  const exitPromise = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`${deps.binary} process logs exited with code ${code}`));
    });
  });
  // Surface a spawn error even if no one awaits exitPromise.
  exitPromise.catch(() => {});

  try {
    const reader = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of reader) {
      yield {
        ts: new Date().toISOString(),
        service: opts.service,
        stream: "stdout",
        line,
      };
    }
    await exitPromise;
  } finally {
    child.kill?.();
  }
}
