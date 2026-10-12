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
 * Hot-reload the running instance's config from `inst.configPath` over its
 * UDS. Uses process-compose's `project update -f <file>` — present on
 * recent versions; older builds reject the subcommand, which the driver
 * surfaces as `not_supported` so `runUp` can fall back to `CONFIG_DRIFT`
 * (issue #31).
 */
export function buildReloadConfigArgs(inst: InstanceRef): string[] {
  return ["project", "update", "-U", "-u", inst.socketPath, "-f", inst.configPath];
}

/**
 * Outcome of a `reloadConfig` call. `ok:true` means process-compose swapped
 * the running graph in-place; `ok:false` means it refused — either because
 * the running build does not implement `project update` (`not_supported`)
 * or because the new config could not be applied (`error`). Both failure
 * branches route through `runUp` to the `CONFIG_DRIFT` envelope; the
 * `reason` is preserved for diagnostics only.
 */
type ReloadResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_supported" | "error" | "timeout";
      readonly message?: string;
    };

/**
 * Base budget for a `project update` call. process-compose's update stops
 * every changed or removed process, one after another, and returns only once
 * each old process has exited. It never escalates to SIGKILL when a
 * `shutdown.command` exits 0 without stopping the process, or when a process
 * ignores SIGTERM and declares no `shutdown.timeout_seconds`. In those cases
 * the update (and every later `down`) blocks forever. The budget turns that
 * wait into a bounded `CONFIG_DRIFT`.
 */
const RELOAD_BASE_TIMEOUT_MS = 30_000;

/**
 * Reload budget for a derived config: the base budget plus every explicit
 * `shutdown.timeout_seconds`. process-compose waits up to that long for each
 * changed process before SIGKILL, so a reload that is merely slow is never
 * cut short.
 */
export function reloadTimeoutMs(config: {
  readonly processes: Readonly<
    Record<string, { readonly shutdown?: Readonly<Record<string, unknown>> }>
  >;
}): number {
  let total = RELOAD_BASE_TIMEOUT_MS;
  for (const proc of Object.values(config.processes)) {
    const seconds = proc.shutdown?.timeout_seconds;
    if (typeof seconds === "number" && seconds > 0) total += seconds * 1000;
  }
  return total;
}

/**
 * List the running processes of an instance over its UDS, in JSON. devtrees
 * always asks for JSON — the human table is for operators driving
 * process-compose directly; the driver parses the response.
 */
export function buildProcessListArgs(socketPath: string): string[] {
  return ["process", "list", "-U", "-u", socketPath, "-o", "json"];
}

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
}

interface RawProc {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly is_ready?: unknown;
  readonly ready?: unknown;
  readonly is_running?: unknown;
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
    out.push({ name: raw.name, status: raw.status, health: readHealth(raw) });
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
  /**
   * Fixed `reloadConfig` budget in milliseconds, for tests. When set, it wins
   * over the per-call `timeoutMs`.
   */
  readonly reloadTimeoutMs?: number;
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
    /** Stop the running instance. */
    down(inst: InstanceRef): Promise<void> {
      return run(buildDownArgs(inst), { stdio: "inherit" });
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
    async getServiceStatuses(socketPath: string): Promise<ServiceStatus[]> {
      await ensureBinary({ binary, exists });
      return new Promise<ServiceStatus[]>((resolve, reject) => {
        const child = spawner(binary, [...prefix, ...buildProcessListArgs(socketPath)], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        child.on("error", (err) => reject(err));
        child.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            reject(new Error(`${binary} process list exited with code ${code}`));
            return;
          }
          try {
            resolve(parseServiceStatuses(stdout || "[]"));
          } catch (err) {
            reject(err as Error);
          }
        });
      });
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
     * Ask the running instance to swap its config in-place from
     * `inst.configPath`. Returns a structured `ReloadResult` — `ok:true` on a
     * clean exit, `ok:false` on any failure (missing subcommand, invalid
     * config, child crashed). Distinguishing the failure cause is best-effort;
     * `not_supported`, `error` and `timeout` all map to `CONFIG_DRIFT` at the CLI.
     *
     * Bounded by `timeoutMs` (default: the base reload budget). When the budget
     * runs out, the `project update` client is killed and `timeout` is returned.
     * process-compose keeps applying the update server-side.
     */
    reloadConfig(
      inst: InstanceRef,
      opts: { readonly timeoutMs?: number } = {},
    ): Promise<ReloadResult> {
      const timeoutMs = deps.reloadTimeoutMs ?? opts.timeoutMs ?? RELOAD_BASE_TIMEOUT_MS;
      return reloadConfigImpl(inst, { binary, prefix, exists, spawner, timeoutMs });
    },
  };
}

async function reloadConfigImpl(
  inst: InstanceRef,
  deps: {
    readonly binary: string;
    readonly prefix: ReadonlyArray<string>;
    readonly exists: (binary: string) => Promise<boolean>;
    readonly spawner: Spawner;
    readonly timeoutMs: number;
  },
): Promise<ReloadResult> {
  await ensureBinary({ binary: deps.binary, exists: deps.exists });
  return new Promise<ReloadResult>((resolve) => {
    const child = deps.spawner(deps.binary, [...deps.prefix, ...buildReloadConfigArgs(inst)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill?.("SIGTERM");
      resolve({
        ok: false,
        reason: "timeout",
        message:
          `${deps.binary} project update did not finish within ` +
          `${Math.round(deps.timeoutMs / 1000)}s; a changed service's old process has not stopped`,
      });
    }, deps.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "not_supported", message: err.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) {
        resolve({ ok: true });
        return;
      }
      const message = stderr.trim() || `${deps.binary} project update exited with code ${code}`;
      resolve({ ok: false, reason: "not_supported", message });
    });
  });
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
