#!/usr/bin/env node

/**
 * devtrees CLI entrypoint.
 *
 * `run` is a pure function: argv in, a result out. The process-level shell at
 * the bottom of this file is the only impure part, so the command surface stays
 * unit-testable.
 *
 * The global `--json` flag (ADR-0005) is parsed once here and threaded into
 * every command handler. All stdout content is produced by `src/output.ts`
 * (the only seam that knows about format mode and the JSON schema); this file
 * routes commands and converts errors into the formatter's envelope.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  classifyError,
  formatDown,
  formatEnv,
  formatError,
  formatGenerate,
  formatLogLine,
  formatLs,
  formatPrune,
  formatUp,
  type FormatMode,
  type LsInstanceRow,
  type LsServiceRow,
} from "./output.js";
import type { LogEvent } from "./driver.js";

export const VERSION = "0.0.1";

/** The command surface devtrees will grow into (see PRD #1). Stubbed for now. */
export const COMMANDS: ReadonlyArray<{ name: string; summary: string }> = [
  { name: "up", summary: "Bring up this worktree's stack" },
  { name: "down", summary: "Stop this worktree's stack (--shared tears down the shared instance)" },
  { name: "ls", summary: "List every instance across the repo with status and ports" },
  {
    name: "attach",
    summary: "Attach a TUI to this worktree's instance (--shared for the shared one)",
  },
  { name: "generate", summary: "Write the derived process-compose config to disk" },
  {
    name: "prune",
    summary: "Reconcile against `git worktree list` and clean up orphaned instances",
  },
  {
    name: "env",
    summary: "Print this worktree's injected env (KEY=value, or --json for a map)",
  },
  {
    name: "logs",
    summary: "Stream a service's logs (--follow, --tail=N, --since=DUR, --all, --shared)",
  },
];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const commands = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n");
  return [
    "devtrees - parallel worktree stacks over process-compose",
    "",
    "Usage:",
    "  devtrees <command> [options]",
    "",
    "Commands:",
    commands,
    "",
    "Options:",
    "  -h, --help              Print this help text",
    "  -v, --version           Print the version",
    "      --json              Emit machine-readable output (see ADR-0005)",
    "",
    "`up` options:",
    "      --attach            Force-attach the TUI (default: only when stdout & stderr are TTYs)",
    "      --no-attach         Skip the TUI even when running interactively",
    "      --wait-timeout=N    Seconds to wait for services to become healthy (default: 120)",
    "",
  ].join("\n");
}

/**
 * Resolve a command line into output and an exit code without touching the
 * process. No arguments, `--help`, or `-h` print help; `--version`/`-v` print
 * the version; an unknown command is an error.
 */
export function run(argv: ReadonlyArray<string>): RunResult {
  const [first] = stripGlobalFlags(argv);

  if (first === undefined || first === "--help" || first === "-h") {
    return { code: 0, stdout: helpText(), stderr: "" };
  }

  if (first === "--version" || first === "-v") {
    return { code: 0, stdout: `${VERSION}\n`, stderr: "" };
  }

  if (COMMANDS.some((c) => c.name === first)) {
    return {
      code: 0,
      stdout: `devtrees ${first}: not implemented yet\n`,
      stderr: "",
    };
  }

  return {
    code: 1,
    stdout: "",
    stderr: `devtrees: unknown command '${first}'\nRun 'devtrees --help' for usage.\n`,
  };
}

/**
 * Options the `up` handler threads from CLI flags into the underlying `runUp`.
 * Optional everywhere: when omitted, runUp's own defaults apply (TTY detection
 * for `attach`, 120s for `waitTimeoutMs`).
 */
export interface UpOptions {
  /** Force-attach (`--attach`) or force-skip (`--no-attach`). */
  readonly attach?: boolean;
  /** Health-wait window in ms (`--wait-timeout=<seconds>`). */
  readonly waitTimeoutMs?: number;
}

/** The effectful commands, injected so `execute` stays unit-testable. */
export interface ExecuteDeps {
  up: (options?: UpOptions) => Promise<{
    worktreeId: string;
    socketPath: string;
    env: Record<string, string>;
    sharedStarted?: boolean;
    /**
     * Base port of this worktree's allocation block (issue #30). Optional so
     * older test stubs that don't supply it keep working — the JSON envelope
     * simply omits `block_base` when undefined.
     */
    blockBase?: number;
    /**
     * Per-service runtime rows the driver observed after the health-wait —
     * the slice-#29 `LsServiceRow` shape. Optional so the older up/down-only
     * test stubs continue to type-check; the JSON envelope defaults to `[]`.
     */
    services?: ReadonlyArray<LsServiceRow>;
  }>;
  down: (options: { shared: boolean }) => Promise<{
    /**
     * Id of the stopped instance — present for worktree teardown, absent for
     * shared (the shared instance is not keyed by a worktree). Optional so
     * older test stubs that resolved with `undefined` keep working.
     */
    worktreeId?: string;
    /**
     * Block base the instance was registered with at teardown time. Optional
     * so a tidy-no-op `down --shared` against an already-stopped instance
     * (no registry entry) still resolves to a valid envelope.
     */
    blockBase?: number;
    /**
     * The injected-value map the instance was running with — same shape `up`
     * returns. Optional so the older up/down-only test stubs that resolve
     * with `undefined` keep working; JSON output defaults to `{}`.
     */
    env?: Record<string, string>;
    /**
     * Per-service runtime rows snapshotted just before the teardown — same
     * shape `ls --json` (issue #29) publishes. Optional so callers that can't
     * gather them (driver hiccup, already-stopped instance) still produce a
     * valid envelope; JSON output defaults to `[]`.
     */
    services?: ReadonlyArray<LsServiceRow>;
  } | void>;
  /**
   * Emit the derived process-compose config(s) to disk without starting
   * anything. Optional on the deps so existing call sites (and tests that
   * only exercise `up`/`down`) keep working; routing through `execute` for
   * `generate` requires it.
   */
  generate?: () => Promise<{
    worktreeId: string;
    worktreeRoot: string;
    worktreePath: string;
    sharedPath?: string;
    env: Record<string, string>;
    sharedEnv?: Record<string, string>;
  }>;
  /**
   * List every devtrees instance across the repo. Optional so existing callers
   * (e.g. the up/down-only tests) don't have to pass a stub; defaults to
   * exiting with "not implemented" if a caller dispatches `ls` without it.
   */
  ls?: () => Promise<{ anchor: string; instances: ReadonlyArray<LsInstanceRow> }>;
  /**
   * Attach a TUI to a running instance — this worktree's by default, or the
   * shared one with `--shared`. Optional on the deps so existing call sites
   * (and tests that only exercise `up`/`down`) keep working; routing through
   * `execute` for `attach` requires it.
   */
  attach?: (options: { shared: boolean }) => Promise<void>;
  /**
   * Reconcile devtrees against `git worktree list` and clean up orphaned
   * instances. Optional for the same reason as `ls`: existing tests only
   * exercise `up`/`down` and don't have to stub `prune`.
   */
  prune?: () => Promise<{ anchor: string; pruned: ReadonlyArray<LsInstanceRow> }>;
  /**
   * Emit the injected-value map for this worktree (issue #32). Pure read — no
   * driver call, no allocation-registry write, no lock. Optional so existing
   * test stubs (up/down-only) keep working without supplying it.
   */
  env?: () => Promise<{ worktreeId: string; env: Record<string, string> }>;
  /**
   * Stream a service's logs over the instance's control socket (#33). Returns
   * the resolved service list (so the CLI knows whether to prefix in human
   * mode) plus an `AsyncIterable<LogEvent>` the CLI consumes one line at a
   * time. Optional so existing test stubs keep working without supplying it.
   */
  logs?: (options: LogsCliOptions) => Promise<{
    services: ReadonlyArray<string>;
    events: AsyncIterable<LogEvent>;
  }>;
}

/** Parsed `devtrees logs` options threaded into `deps.logs`. */
export interface LogsCliOptions {
  readonly service?: string;
  readonly all: boolean;
  readonly shared: boolean;
  readonly follow: boolean;
  readonly tail?: number;
  readonly since?: string;
}

/**
 * Strip `--json` (and any future global flags) from argv before per-command
 * parsing. Kept tiny: this is not a real flag parser, just a global-flag
 * splitter so a command's own argv is what `run`/handlers reason about.
 */
function stripGlobalFlags(argv: ReadonlyArray<string>): string[] {
  return argv.filter((a) => a !== "--json");
}

function modeFor(argv: ReadonlyArray<string>): FormatMode {
  return argv.includes("--json") ? "json" : "human";
}

/**
 * A single command's effectful behaviour. Returns the rendered `RunResult` on
 * success, or `undefined` to defer to the stubbed `run` — used when the deps
 * object lacks the optional collaborator for that command (e.g. an `up`/`down`-
 * only test stub that doesn't pass a `prune`).
 */
type Handler = (
  rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
) => Promise<RunResult | undefined>;

/**
 * Parse `--attach` / `--no-attach` / `--wait-timeout` out of `up`'s argv.
 * Mutually-exclusive `--attach`/`--no-attach` aren't policed — the last one
 * wins, matching common Unix flag-parser behaviour. `--wait-timeout` accepts
 * both `--wait-timeout=30` and `--wait-timeout 30` forms; the value must
 * parse as a positive number of seconds.
 *
 * Throws on a malformed `--wait-timeout` so the user sees a clear error
 * rather than a silently-defaulted timeout that hides the typo.
 */
/** Coerce a `--wait-timeout` argument value into ms, or throw a clear error. */
function parseWaitTimeoutSecondsToMs(raw: string | undefined): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--wait-timeout expects a positive number of seconds, got '${raw ?? ""}'.`);
  }
  return Math.round(seconds * 1000);
}

function parseUpOptions(rest: ReadonlyArray<string>): UpOptions {
  const out: { attach?: boolean; waitTimeoutMs?: number } = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--attach") out.attach = true;
    else if (arg === "--no-attach") out.attach = false;
    else if (arg === "--wait-timeout") out.waitTimeoutMs = parseWaitTimeoutSecondsToMs(rest[++i]);
    else if (arg?.startsWith("--wait-timeout="))
      out.waitTimeoutMs = parseWaitTimeoutSecondsToMs(arg.slice("--wait-timeout=".length));
  }
  return out;
}

async function handleUp(
  rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult> {
  const options = parseUpOptions(rest);
  const result = await deps.up(options);
  const out = formatUp(
    {
      worktreeId: result.worktreeId,
      env: result.env,
      sharedStarted: result.sharedStarted ?? false,
      ...(result.blockBase !== undefined ? { blockBase: result.blockBase } : {}),
      ...(result.services !== undefined ? { services: result.services } : {}),
    },
    mode,
  );
  return { code: 0, stdout: out.stdout, stderr: out.stderr };
}

async function handleDown(
  rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult> {
  const shared = rest.includes("--shared");
  const result = (await deps.down({ shared })) ?? undefined;
  const out = formatDown(
    {
      shared,
      ...(result?.worktreeId !== undefined ? { worktreeId: result.worktreeId } : {}),
      ...(result?.blockBase !== undefined ? { blockBase: result.blockBase } : {}),
      ...(result?.env !== undefined ? { env: result.env } : {}),
      ...(result?.services !== undefined ? { services: result.services } : {}),
    },
    mode,
  );
  return { code: 0, stdout: out.stdout, stderr: out.stderr };
}

async function handleGenerate(
  _rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult | undefined> {
  if (!deps.generate) return undefined;
  const result = await deps.generate();
  const out = formatGenerate(
    { worktreePath: result.worktreePath, sharedPath: result.sharedPath },
    mode,
  );
  return { code: 0, stdout: out.stdout, stderr: out.stderr };
}

async function handleLs(
  _rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult | undefined> {
  if (deps.ls === undefined) return undefined;
  const result = await deps.ls();
  const out = formatLs(result.instances, mode);
  return { code: 0, stdout: out.stdout, stderr: out.stderr };
}

async function handleAttach(
  rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  _mode: FormatMode,
): Promise<RunResult | undefined> {
  if (!deps.attach) return undefined;
  const shared = rest.includes("--shared");
  await deps.attach({ shared });
  // `attach` runs the TUI in-process; on a clean exit there is nothing to
  // print (the TUI itself is the user-visible output).
  return { code: 0, stdout: "", stderr: "" };
}

async function handlePrune(
  _rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult | undefined> {
  if (deps.prune === undefined) return undefined;
  const result = await deps.prune();
  const out = formatPrune(result.pruned, mode);
  return { code: 0, stdout: out.stdout, stderr: out.stderr };
}

async function handleEnv(
  _rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult | undefined> {
  if (deps.env === undefined) return undefined;
  const result = await deps.env();
  const out = formatEnv(result.env, mode);
  return { code: 0, stdout: out.stdout, stderr: out.stderr };
}

/**
 * Parse `devtrees logs <service?>` argv into structured options.
 *
 * Flags: `--follow` (or `-f`), `--tail=N`, `--since=DUR`, `--all`, `--shared`.
 * The first non-flag positional is the service name; with `--all` it is
 * optional (and ignored if both are given — `--all` wins).
 */
export function parseLogsArgs(rest: ReadonlyArray<string>): LogsCliOptions {
  let service: string | undefined;
  let all = false;
  let shared = false;
  let follow = false;
  let tail: number | undefined;
  let since: string | undefined;
  for (const arg of rest) {
    if (arg === "--all") all = true;
    else if (arg === "--shared") shared = true;
    else if (arg === "--follow" || arg === "-f") follow = true;
    else if (arg.startsWith("--tail=")) {
      const n = Number(arg.slice("--tail=".length));
      if (Number.isFinite(n) && n >= 0) tail = n;
    } else if (arg.startsWith("--since=")) since = arg.slice("--since=".length);
    else if (!arg.startsWith("-") && service === undefined) service = arg;
  }
  return { service, all, shared, follow, tail, since };
}

async function handleLogs(
  rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult | undefined> {
  if (deps.logs === undefined) return undefined;
  const opts = parseLogsArgs(rest);
  if (!opts.all && opts.service === undefined) {
    return {
      code: 1,
      stdout: "",
      stderr: "devtrees logs: specify a service (e.g. `devtrees logs web`) or pass `--all`.\n",
    };
  }
  const { services, events } = await deps.logs(opts);
  // Stream lines one at a time. Human mode prefixes `[service]` when --all is
  // set or when more than one service is in play; JSON mode emits NDJSON.
  const prefixService = mode === "human" && services.length > 1;
  let stdout = "";
  for await (const event of events) {
    const out = formatLogLine(event, mode, { prefixService });
    stdout += out.stdout;
  }
  return { code: 0, stdout, stderr: "" };
}

const HANDLERS: ReadonlyMap<string, Handler> = new Map([
  ["up", handleUp],
  ["down", handleDown],
  ["generate", handleGenerate],
  ["ls", handleLs],
  ["attach", handleAttach],
  ["prune", handlePrune],
  ["env", handleEnv],
  ["logs", handleLogs],
]);

/**
 * Resolve a command line, performing effects for the commands wired into
 * `HANDLERS` and delegating everything else to the pure `run`. Errors (e.g. a
 * missing process-compose binary) become a clear, non-zero result rather than
 * an unhandled rejection.
 *
 * `down --shared` and `attach --shared` target the shared instance (ADR-0001):
 * explicit, opt-in flags because the shared instance is decoupled from any
 * single worktree's lifecycle.
 */
export async function execute(argv: ReadonlyArray<string>, deps: ExecuteDeps): Promise<RunResult> {
  const mode = modeFor(argv);
  const commandArgv = stripGlobalFlags(argv);
  const [first, ...rest] = commandArgv;
  const handler = first !== undefined ? HANDLERS.get(first) : undefined;
  if (handler !== undefined) {
    try {
      const result = await handler(rest, deps, mode);
      if (result !== undefined) return result;
    } catch (err) {
      const payload = classifyError(err as Error);
      const out = formatError(payload, mode);
      return { code: 1, stdout: out.stdout, stderr: out.stderr };
    }
  }
  return run(commandArgv);
}

/**
 * True when this module is the program's entrypoint, accounting for symlinks
 * (npm-link bin, pnpm shim, Homebrew bin). `process.argv[1]` is the path as
 * invoked — often a symlink — while `import.meta.url` is the resolved file
 * URL, so raw string equality misses the published-binary case. We compare
 * after `realpathSync` + `pathToFileURL` so both sides are normalized.
 */
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // argv1 didn't resolve (deleted file, permission issue) — can't be us.
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const { runUp, runDown, runEnv, runGenerate, runLs, runAttach, runPrune, runLogs } =
    await import("./commands.js");
  const result = await execute(process.argv.slice(2), {
    up: (options) =>
      runUp({
        ...(options?.attach !== undefined ? { attach: options.attach } : {}),
        ...(options?.waitTimeoutMs !== undefined ? { waitTimeoutMs: options.waitTimeoutMs } : {}),
      }),
    down: async ({ shared }) => {
      const r = await runDown({}, { shared });
      return {
        ...(r.worktreeId !== undefined ? { worktreeId: r.worktreeId } : {}),
        ...(r.blockBase !== undefined ? { blockBase: r.blockBase } : {}),
        env: r.env,
        services: r.services,
      };
    },
    generate: () => runGenerate(),
    ls: () => runLs(),
    attach: ({ shared }) => runAttach({}, { shared }),
    prune: () => runPrune(),
    env: () => runEnv(),
    logs: (opts) =>
      runLogs(
        {},
        {
          service: opts.service,
          all: opts.all,
          shared: opts.shared,
          follow: opts.follow,
          tail: opts.tail,
          since: opts.since,
        },
      ),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
