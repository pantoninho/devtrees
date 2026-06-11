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

/** Start the instance's server detached, over its UDS, with the TUI disabled. */
export function buildUpArgs(inst: InstanceRef): string[] {
  return ["up", "-f", inst.configPath, "-U", "-u", inst.socketPath, "-t=false"];
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
  | { readonly ok: false; readonly reason: "not_supported" | "error"; readonly message?: string };

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
}

function readHealth(raw: RawProc): HealthState {
  if (typeof raw.ready === "boolean") return raw.ready ? "ready" : "not_ready";
  if (raw.is_ready === "Ready") return "ready";
  if (raw.is_ready === "Not Ready") return "not_ready";
  return "unknown";
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
    /** Start the worktree instance's server in the background. */
    async up(inst: InstanceRef): Promise<void> {
      await ensureBinary({ binary, exists });
      const child = spawner(binary, [...prefix, ...buildUpArgs(inst)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref?.();
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
     * both `not_supported` and `error` map to `CONFIG_DRIFT` at the CLI.
     */
    reloadConfig(inst: InstanceRef): Promise<ReloadResult> {
      return reloadConfigImpl(inst, { binary, prefix, exists, spawner });
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
    child.on("error", (err) =>
      resolve({ ok: false, reason: "not_supported", message: err.message }),
    );
    child.on("exit", (code) => {
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
