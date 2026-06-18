#!/usr/bin/env node

/**
 * devtrees CLI entrypoint.
 *
 * Argv parsing is delegated to clipanion (spec-driven, per-subcommand `--help`
 * auto-generated). Each subcommand is a `Command` subclass below; they share a
 * `DevtreesCommand` base that owns the `--json` flag and the shared error
 * routing (ADR-0005: `--json` errors land on stdout as `{schema_version, error:
 * {code, message, details?}}`, human errors land on stderr).
 *
 * The orchestration in `src/commands.ts` (`runUp`, `runDown`, ...) is untouched
 * — this file is purely an argv → call-site bridge. Test seams are unchanged:
 * `execute(argv, deps)` returns a `RunResult` so the existing test suite can
 * inject mock `runUp` / `runDown` / ... without spinning a real driver.
 */

import { realpathSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { Cli, Command, Option, Builtins, type BaseContext } from "clipanion";
import type { LogEvent } from "./driver.js";
import type { DerivedConfig } from "./deriver.js";
import { maybeInitHint } from "./init-hint.js";
import {
  classifyError,
  ERROR_CODE_DESCRIPTIONS,
  formatDown,
  formatEnv,
  formatError,
  formatInit,
  formatLogLine,
  formatLs,
  formatPrune,
  formatUp,
  formatUpDryRun,
  type ErrorCode,
  type FormatMode,
  type LsInstanceRow,
  type LsServiceRow,
  type PrunedRow,
} from "./output.js";

/**
 * The published version, read once from the package.json that ships with the
 * binary. Resolved relative to this module's URL so it works in both the
 * source tree (during tests) and the bundled `dist/cli.mjs` (where rolldown
 * copies `package.json` next to the entry — same layout in both cases since
 * `package.json` is one directory up from `src/` and one up from `dist/`).
 */
function readVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version: string };
  return pkg.version;
}

export const VERSION = readVersion();

/**
 * The command surface devtrees exposes. Kept exported so external introspection
 * (e.g. the doc-generation pass) doesn't have to import the clipanion classes
 * directly. Each name matches a registered `Command.paths` entry below.
 */
export const COMMANDS: ReadonlyArray<{ name: string; summary: string }> = [
  { name: "up", summary: "Bring up this worktree's stack" },
  { name: "down", summary: "Stop this worktree's stack (--shared tears down the shared instance)" },
  { name: "ls", summary: "List every instance across the repo with status and ports" },
  {
    name: "attach",
    summary: "Attach a TUI to this worktree's instance (--shared for the shared one)",
  },
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
  {
    name: "init",
    summary: "Write the coding-agent onboarding block into AGENTS.md/CLAUDE.md (--agents)",
  },
];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
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
  /**
   * process-compose namespaces to start (`-n/--namespace`, issue #128),
   * repeatable and forwarded verbatim. Omitted when no `-n` flag is given, so
   * `runUp`'s default (all namespaces) applies.
   */
  readonly namespaces?: ReadonlyArray<string>;
}

/** The effectful commands, injected so dispatch stays unit-testable. */
export interface ExecuteDeps {
  up: (options?: UpOptions) => Promise<{
    worktreeId: string;
    socketPath: string;
    env: Record<string, string>;
    sharedStarted?: boolean;
    blockBase?: number;
    services?: ReadonlyArray<LsServiceRow>;
  }>;
  /**
   * Dry-run derivation (#124): runs the full pipeline `up` would run and
   * returns the derived config(s) + the resolved env, with no side effects.
   * Optional so dispatch paths that don't wire it fall through to a no-op
   * `return 0` (same convention as the other optional commands). The env
   * carries the allocated worktree ports (and injected shared ports) a sibling
   * reads off the `--json` envelope (#125).
   */
  upDryRun?: () => Promise<{
    worktreeId: string;
    env: Record<string, string>;
    config: DerivedConfig;
    sharedEnv?: Record<string, string>;
    sharedConfig?: DerivedConfig;
  }>;
  down: (options: {
    shared: boolean;
  }) => Promise<{ worktreeId?: string; stopped?: boolean } | void>;
  ls?: () => Promise<{ anchor: string; instances: ReadonlyArray<LsInstanceRow> }>;
  attach?: (options: { shared: boolean }) => Promise<void>;
  prune?: () => Promise<{ anchor: string; pruned: ReadonlyArray<PrunedRow> }>;
  env?: () => Promise<{ worktreeId: string; env: Record<string, string> }>;
  logs?: (options: LogsCliOptions) => Promise<{
    services: ReadonlyArray<string>;
    events: AsyncIterable<LogEvent>;
  }>;
  init?: () => Promise<{
    target: string;
    path: string;
    action: "created" | "updated";
  }>;
  /**
   * The agent-onboarding hint `up` surfaces on stderr (issue #119): a one-line,
   * non-fatal pointer at `devtrees init --agents`, returned only when the
   * gating predicate fires (agent context + no agent-doc references devtrees)
   * and `undefined` otherwise. Injected as a thunk so the gating decision is
   * made by the caller — the entrypoint with real cwd + TTY detection, tests
   * with a stub — and `UpCommand` only has to write the line it's handed.
   * Optional so dispatch paths that don't wire it simply never hint.
   */
  initHint?: () => string | undefined;
}

/** Parsed `devtrees logs` options threaded into `deps.logs`. */
export interface LogsCliOptions {
  readonly service?: string;
  readonly all: boolean;
  readonly shared: boolean;
  readonly follow: boolean;
  readonly tail?: number;
  /** `--since` window, already coerced from a duration string (e.g. `5m`) to ms. */
  readonly sinceMs?: number;
}

// --- error-code footers for per-command --help -----------------------------
//
// ADR-0005 lists the error-code enum the `--json` error envelope can carry.
// Each command lists the subset it can actually emit (verified against
// `src/commands.ts` throw sites + `classifyError` in `src/output.ts`), so an
// agent reading `devtrees <cmd> --help` knows what to branch on without
// bouncing through the ADR. Descriptions live in `output.ts`'s
// `ERROR_CODE_DESCRIPTIONS` map so adding a new code without a one-liner
// fails the type check.
//
// `UNKNOWN` is always the last row — every command can hit it (any non-typed
// thrown error falls through `classifyError` to `UNKNOWN`), and rendering it
// last keeps the more interesting codes at the top.

function errorCodeFooter(codes: ReadonlyArray<ErrorCode>): string {
  // clipanion's `formatMarkdownish` collapses single newlines into spaces but
  // preserves markdown list items (`- ...`) on their own line. Use a list so
  // each code-description pair survives the markdown reflow as its own row.
  // Double-newline separators are required between paragraphs (the intro
  // line and the first list item) — single newlines would re-flow them.
  const items = codes.map((code) => `- \`${code}\` — ${ERROR_CODE_DESCRIPTIONS[code]}`);
  return [
    "Under `--json`, this command can emit one of these error codes (see ADR-0005):",
    ...items,
  ].join("\n\n");
}

// --- context ----------------------------------------------------------------

/**
 * Per-invocation context clipanion passes into each command. Carries the
 * injected `deps` and a `FormatMode` derived from `--json`. Output is written
 * through the standard `BaseContext.stdout`/`stderr` writables — the entry
 * shell at the bottom of this file plumbs them to `process.std{out,err}`;
 * tests plumb them to in-memory buffers.
 */
interface DevtreesContext extends BaseContext {
  deps: ExecuteDeps;
}

// --- base command -----------------------------------------------------------

/**
 * Base class for every devtrees subcommand. Owns the global `--json` flag
 * (ADR-0005) and the shared error-routing path: a thrown core error becomes
 * a `formatError(...)` envelope on stdout when `--json` is set, a human
 * diagnostic on stderr otherwise. Per-command `execute()` overrides write
 * their successful output through `writeFormatted` so the format-mode branch
 * lives in exactly one place.
 *
 * Subclasses MUST call `dispatch(...)` to execute their body. `dispatch`
 * wraps the body in the error router; subclasses never need a try/catch.
 */
abstract class DevtreesCommand extends Command<DevtreesContext> {
  json = Option.Boolean("--json", false, {
    description: "Emit a structured JSON envelope on stdout (see ADR-0005 for the contract).",
  });

  protected get mode(): FormatMode {
    return this.json ? "json" : "human";
  }

  /**
   * Run a command body with the documented error envelope. The body returns
   * an exit code (0 for success, non-zero for in-band failure modes such as
   * `logs` without a service or `--all`); a thrown error is classified and
   * rendered as the `--json` (or human) error envelope.
   */
  protected async dispatch(body: () => Promise<number>): Promise<number> {
    try {
      return await body();
    } catch (err) {
      const payload = classifyError(err as Error);
      const out = formatError(payload, this.mode);
      if (out.stdout) this.context.stdout.write(out.stdout);
      if (out.stderr) this.context.stderr.write(out.stderr);
      return 1;
    }
  }

  /**
   * Override clipanion's default error handler (which writes the stack trace
   * to stdout). We catch in `dispatch` already; this swallow exists so a
   * stray throw from a flag-parsing path doesn't leak a stack trace to the
   * user. Stack traces in JSON mode would also break the envelope contract.
   */
  override async catch(error: unknown): Promise<void> {
    const payload = classifyError(error as Error);
    const out = formatError(payload, this.mode);
    if (out.stdout) this.context.stdout.write(out.stdout);
    if (out.stderr) this.context.stderr.write(out.stderr);
  }
}

// --- per-command classes ----------------------------------------------------

class UpCommand extends DevtreesCommand {
  static override paths = [["up"]];
  static override usage = Command.Usage({
    description: "Bring up this worktree's stack with collision-free ports.",
    // `--dry-run` runs only the derivation pipeline (load devtrees.yaml →
    // CONFIG_INVALID; allocate ports under the registry lock → LOCK_CONTENTION)
    // and stops before any side effect, so it can only emit the allocation
    // subset of the codes below (#124).
    details: errorCodeFooter([
      "STALE_PORT_BLOCK",
      "CONFIG_DRIFT",
      "SHARED_DRIFT",
      "SHARED_START_FAILED",
      "CONFIG_INVALID",
      "LOCK_CONTENTION",
      "HEALTH_TIMEOUT",
      "PROCESS_COMPOSE_NOT_FOUND",
      "INVALID_ARGS",
      "UNKNOWN",
    ]),
    examples: [
      ["Bring up the stack", "devtrees up"],
      ["Bring up + emit JSON envelope", "devtrees up --json"],
      ["Bring up with a 30s health-wait window", "devtrees up --wait-timeout 30"],
      ["Preview the derived config(s) + env without side effects", "devtrees up --dry-run --json"],
    ],
  });

  // Clipanion auto-handles the `--no-attach` negation for any `--attach`
  // boolean: `--attach` → true, `--no-attach` → false, omitted → undefined
  // (TTY auto-detection in runUp). Documented in the description so the
  // help block flags the negated form even though clipanion only renders
  // the positive variant in the options table.
  attach = Option.Boolean("--attach", {
    description:
      "Force-attach the TUI; pass `--no-attach` to force-skip (default: only when stdout & stderr are TTYs).",
  });
  waitTimeout = Option.String("--wait-timeout", {
    description: "Health-wait timeout in seconds. Default 120.",
  });
  // process-compose `-n/--namespace` (issue #128): a repeatable string-array
  // selecting which namespace subset to start. Repeat the flag to pass more
  // than one (`-n a -n b`); omitted starts every namespace (the default). The
  // selection also narrows the health-wait's expected set so `up -n default`
  // never waits on a probed service in an excluded namespace.
  namespaces = Option.Array("--namespace,-n", {
    description:
      "Start only the given process-compose namespace(s). Repeatable (`-n a -n b`); " +
      "omitted starts all namespaces (the default).",
  });
  dryRun = Option.Boolean("--dry-run", false, {
    description:
      "Derive and print the config(s) + allocated env to stdout WITHOUT side effects: " +
      "no process-compose spawn, no config file written, no socket, no instance registered, " +
      "no health wait. With `--json`, emits the `up_dry_run` envelope so an agent reads the " +
      "allocated ports and the full process-compose document off stdout. (Port allocation may " +
      "briefly take the registry lock to pick a non-colliding block.)",
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      if (this.dryRun) return this.executeDryRun();
      const result = await this.context.deps.up(this.buildUpOptions());
      const out = formatUp(
        {
          worktreeId: result.worktreeId,
          env: result.env,
          sharedStarted: result.sharedStarted ?? false,
          ...(result.blockBase !== undefined ? { blockBase: result.blockBase } : {}),
          ...(result.services !== undefined ? { services: result.services } : {}),
        },
        this.mode,
      );
      if (out.stdout) this.context.stdout.write(out.stdout);
      if (out.stderr) this.context.stderr.write(out.stderr);
      this.emitInitHint();
      return 0;
    });
  }

  /**
   * Collect the parsed `up` flags into `UpOptions`, omitting each absent one so
   * `runUp`'s own defaults apply (TTY-based attach, 120s wait, all namespaces).
   * Extracted from `execute` so the dispatch body stays a flat sequence and its
   * cyclomatic complexity doesn't grow per optional flag.
   */
  private buildUpOptions(): UpOptions {
    return {
      ...(this.attach !== undefined ? { attach: this.attach } : {}),
      ...(this.waitTimeout !== undefined
        ? { waitTimeoutMs: parseWaitTimeoutSecondsToMs(this.waitTimeout) }
        : {}),
      ...(this.namespaces !== undefined && this.namespaces.length > 0
        ? { namespaces: this.namespaces }
        : {}),
    };
  }

  /**
   * Agent-onboarding hint (issue #119): emitted on `up` only, at most once, to
   * STDERR — never the `--json` stdout envelope (the stdout document is already
   * written by the time we get here and stays byte-for-byte unaffected). The
   * gating decision (agent context + no agent-doc referencing devtrees) lives
   * in the injected `initHint` thunk; this only forwards the line it hands
   * back, so a hint never changes the exit code or blocks. Extracted from
   * `execute` so the dispatch body stays a flat sequence.
   */
  private emitInitHint(): void {
    const hint = this.context.deps.initHint?.();
    if (hint) this.context.stderr.write(`${hint}\n`);
  }

  /**
   * `up --dry-run` (#124): run the derivation pipeline through the injected
   * `upDryRun` and print the result via `formatUpDryRun` — the derived
   * config(s) + allocated env on stdout, no side effects. NOT the `up` path:
   * no spawn, no socket, no registry instance, no health wait, and (crucially)
   * no init-hint on stderr — the `--json` stdout stays a single byte-clean
   * document. When `upDryRun` is unwired (a test stub omitting it), this
   * no-ops to exit 0, matching the convention the other optional commands use.
   */
  private async executeDryRun(): Promise<number> {
    if (!this.context.deps.upDryRun) return 0;
    const result = await this.context.deps.upDryRun();
    const out = formatUpDryRun(
      {
        worktreeId: result.worktreeId,
        env: result.env,
        config: result.config,
        ...(result.sharedEnv !== undefined ? { sharedEnv: result.sharedEnv } : {}),
        ...(result.sharedConfig !== undefined ? { sharedConfig: result.sharedConfig } : {}),
      },
      this.mode,
    );
    if (out.stdout) this.context.stdout.write(out.stdout);
    if (out.stderr) this.context.stderr.write(out.stderr);
    return 0;
  }
}

class DownCommand extends DevtreesCommand {
  static override paths = [["down"]];
  static override usage = Command.Usage({
    description: "Stop this worktree's stack (`--shared` tears down the shared instance).",
    // `--shared` serializes on the shared lifecycle lock → LOCK_CONTENTION.
    details: errorCodeFooter(["PROCESS_COMPOSE_NOT_FOUND", "LOCK_CONTENTION", "UNKNOWN"]),
  });

  shared = Option.Boolean("--shared", false, {
    description: "Tear down the shared instance instead of this worktree's.",
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      const result = (await this.context.deps.down({ shared: this.shared })) ?? {};
      // Issue #48: the action envelope carries exactly one of `shared: true`
      // or `worktreeId: "<id>"`. Empty string preserves the discriminated-
      // union shape when the runner couldn't supply an id. `stopped` (#92)
      // defaults to true so runner stubs that don't thread it keep today's
      // "instance stopped" output; `runDown` reports `false` on the
      // idempotent no-op and the formatter renders the notice.
      const stopped = result.stopped ?? true;
      const out = formatDown(
        this.shared ? { shared: true, stopped } : { worktreeId: result.worktreeId ?? "", stopped },
        this.mode,
      );
      if (out.stdout) this.context.stdout.write(out.stdout);
      if (out.stderr) this.context.stderr.write(out.stderr);
      return 0;
    });
  }
}

class LsCommand extends DevtreesCommand {
  static override paths = [["ls"]];
  static override usage = Command.Usage({
    description: "List every devtrees instance across the repo with status and ports.",
    details: errorCodeFooter(["UNKNOWN"]),
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      if (!this.context.deps.ls) return 0;
      const result = await this.context.deps.ls();
      const out = formatLs(result.instances, this.mode);
      if (out.stdout) this.context.stdout.write(out.stdout);
      if (out.stderr) this.context.stderr.write(out.stderr);
      return 0;
    });
  }
}

class AttachCommand extends DevtreesCommand {
  static override paths = [["attach"]];
  static override usage = Command.Usage({
    description: "Attach a TUI to this worktree's instance (`--shared` for the shared one).",
    details: errorCodeFooter(["INSTANCE_NOT_FOUND", "PROCESS_COMPOSE_NOT_FOUND", "UNKNOWN"]),
  });

  shared = Option.Boolean("--shared", false, {
    description: "Attach to the shared instance instead of this worktree's.",
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      if (!this.context.deps.attach) return 0;
      await this.context.deps.attach({ shared: this.shared });
      // `attach` runs the TUI in-process; on a clean exit there is nothing
      // to print (the TUI itself is the user-visible output).
      return 0;
    });
  }
}

class PruneCommand extends DevtreesCommand {
  static override paths = [["prune"]];
  static override usage = Command.Usage({
    description: "Reconcile against `git worktree list` and clean up orphaned instances.",
    // Drops orphan registry entries under the registry lock → LOCK_CONTENTION.
    details: errorCodeFooter(["LOCK_CONTENTION", "UNKNOWN"]),
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      if (!this.context.deps.prune) return 0;
      const result = await this.context.deps.prune();
      const out = formatPrune(result.pruned, this.mode);
      if (out.stdout) this.context.stdout.write(out.stdout);
      if (out.stderr) this.context.stderr.write(out.stderr);
      return 0;
    });
  }
}

class EnvCommand extends DevtreesCommand {
  static override paths = [["env"]];
  static override usage = Command.Usage({
    description: "Print this worktree's injected env (KEY=value, or `--json` for a map).",
    // Loads devtrees.yaml (CONFIG_INVALID) and reports shared-tier divergence
    // (SHARED_DRIFT, #83) but is lock-free — `runEnv` is a pure registry
    // read, so LOCK_CONTENTION cannot occur here.
    details: errorCodeFooter(["SHARED_DRIFT", "CONFIG_INVALID", "UNKNOWN"]),
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      if (!this.context.deps.env) return 0;
      const result = await this.context.deps.env();
      const out = formatEnv(result.env, this.mode);
      if (out.stdout) this.context.stdout.write(out.stdout);
      if (out.stderr) this.context.stderr.write(out.stderr);
      return 0;
    });
  }
}

class LogsCommand extends DevtreesCommand {
  static override paths = [["logs"]];
  static override usage = Command.Usage({
    description: "Stream a service's logs.",
    details: errorCodeFooter([
      "INSTANCE_NOT_FOUND",
      "SERVICE_NOT_FOUND",
      "INVALID_ARGS",
      "UNKNOWN",
    ]),
    examples: [
      ["Tail one service", "devtrees logs web"],
      ["Tail every service, interleaved", "devtrees logs --all"],
      ["Stream as NDJSON", "devtrees logs web --json"],
      ["Follow, keeping only the last 5 minutes of events", "devtrees logs web -f --since 5m"],
    ],
  });

  service = Option.String({ required: false });
  all = Option.Boolean("--all", false, { description: "Tail every service in the instance." });
  shared = Option.Boolean("--shared", false, {
    description: "Read from the shared instance instead of this worktree's.",
  });
  follow = Option.Boolean("--follow,-f", false, {
    description: "Follow the log stream (default: print the buffered tail and exit).",
  });
  tail = Option.String("--tail", {
    description: "Print the last N lines before following.",
  });
  since = Option.String("--since", {
    description:
      "Only show events newer than a duration ago (e.g. `30s`, `5m`, `1h`; units: ms, s, m, h, d). " +
      "Filters client-side on event timestamps, so it is most useful with --follow.",
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      if (!this.context.deps.logs) return 0;
      const opts: LogsCliOptions = {
        service: this.service,
        all: this.all,
        shared: this.shared,
        follow: this.follow,
        ...(this.tail !== undefined ? { tail: parseTailCount(this.tail) } : {}),
        ...(this.since !== undefined ? { sinceMs: parseSinceDurationMs(this.since) } : {}),
      };
      if (!opts.all && opts.service === undefined) {
        // Thrown (not hand-written to stderr) so `dispatch` routes it through
        // the documented envelope: `--json` gets `{error: {code: INVALID_ARGS}}`
        // on stdout (ADR-0005), human mode gets the diagnostic on stderr.
        throw invalidArgsError("specify a service (e.g. `devtrees logs web`) or pass `--all`.");
      }
      const { services, events } = await this.context.deps.logs(opts);
      const prefixService = this.mode === "human" && services.length > 1;
      for await (const event of events) {
        const out = formatLogLine(event, this.mode, { prefixService });
        if (out.stdout) this.context.stdout.write(out.stdout);
      }
      return 0;
    });
  }
}

class InitCommand extends DevtreesCommand {
  static override paths = [["init"]];
  static override usage = Command.Usage({
    description:
      "Write the coding-agent onboarding block into this repo's agent-instructions file.",
    // Pure filesystem write: validates the required `--agents` flag
    // (INVALID_ARGS) and can surface a write error (UNKNOWN). No anchor
    // resolution, no lock, no spawn — so none of the lifecycle codes apply.
    details: errorCodeFooter(["INVALID_ARGS", "UNKNOWN"]),
    examples: [
      ["Write the onboarding block (creates AGENTS.md if absent)", "devtrees init --agents"],
      ["Write it + emit the created-vs-updated JSON envelope", "devtrees init --agents --json"],
    ],
  });

  // `--agents` selects the onboarding-block writer. It's the only mode `init`
  // supports today, but it is required (not defaulted) so the command's intent
  // is explicit at the call site and a bare `devtrees init` fails loudly with
  // INVALID_ARGS rather than silently doing something — leaving room for future
  // `init` modes without a behaviour change.
  agents = Option.Boolean("--agents", false, {
    description: "Write the canonical coding-agent onboarding block into AGENTS.md / CLAUDE.md.",
  });

  override async execute(): Promise<number> {
    return this.dispatch(async () => {
      if (!this.agents) {
        throw invalidArgsError("`devtrees init` requires `--agents` (the only mode today).");
      }
      if (!this.context.deps.init) return 0;
      const result = await this.context.deps.init();
      const out = formatInit(
        { target: result.target, path: result.path, action: result.action },
        this.mode,
      );
      if (out.stdout) this.context.stdout.write(out.stdout);
      if (out.stderr) this.context.stderr.write(out.stderr);
      return 0;
    });
  }
}

// --- flag-value coercions ---------------------------------------------------

/**
 * Build an argv-validation error tagged with the documented `INVALID_ARGS`
 * code, so `classifyError` routes it into the JSON envelope without falling
 * back to `UNKNOWN`. These fire before any effect runs — the stack is never
 * touched when one is thrown.
 */
function invalidArgsError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = "INVALID_ARGS";
  return err;
}

/**
 * Coerce a `--tail` argument value into a line count, or throw the documented
 * `INVALID_ARGS` error. Mirrors `parseWaitTimeoutSecondsToMs` below — every
 * numeric flag validates at the seam instead of letting `NaN` leak into the
 * driver (#81).
 */
function parseTailCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw invalidArgsError(`--tail expects a non-negative integer of lines, got '${raw}'.`);
  }
  return n;
}

/**
 * Unit multipliers for `--since` durations. Spelled-out map (not regex
 * arithmetic) so the accepted vocabulary is greppable next to the parser.
 */
const SINCE_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Coerce a `--since` argument value (`<number><unit>`, e.g. `30s`, `5m`,
 * `1.5h`) into milliseconds, or throw the documented `INVALID_ARGS` error.
 * The unit is mandatory — a bare number is ambiguous — and the value must be
 * non-negative with no whitespace, mirroring the strictness of `parseTailCount`
 * above (#88).
 */
function parseSinceDurationMs(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(raw);
  const unitMs = match === null ? undefined : SINCE_UNIT_MS[match[2] ?? ""];
  if (match === null || unitMs === undefined) {
    throw invalidArgsError(
      `--since expects a duration like '30s', '5m', or '1h' ` +
        `(a number followed by ms, s, m, h, or d), got '${raw}'.`,
    );
  }
  return Math.round(Number(match[1]) * unitMs);
}

/**
 * Coerce a `--wait-timeout` argument value into ms, or throw a clear error.
 * Kept here (rather than in the command) so the error path is exercised by
 * the existing test that pins the error text.
 */
function parseWaitTimeoutSecondsToMs(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw invalidArgsError(`--wait-timeout expects a positive number of seconds, got '${raw}'.`);
  }
  return Math.round(seconds * 1000);
}

// --- dispatch ---------------------------------------------------------------

/**
 * Build the `Cli` instance, register every command + the built-in
 * `--help`/`--version` commands, and return it. Built per call so each
 * `execute`/`run` invocation has a fresh registration list (cheap; clipanion
 * setup is in-memory and microsecond-scale).
 */
function buildCli(): Cli<DevtreesContext> {
  const cli = new Cli<DevtreesContext>({
    binaryName: "devtrees",
    binaryLabel: "devtrees - parallel worktree stacks over process-compose",
    binaryVersion: VERSION,
    // Colors are decided per-invocation by the context's colorDepth; disable
    // the env-based color inference so a CI run with FORCE_COLOR set doesn't
    // sneak escape codes into the JSON envelope.
    enableColors: false,
  });
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);
  cli.register(UpCommand);
  cli.register(DownCommand);
  cli.register(LsCommand);
  cli.register(AttachCommand);
  cli.register(PruneCommand);
  cli.register(EnvCommand);
  cli.register(LogsCommand);
  cli.register(InitCommand);
  return cli;
}

/**
 * Buffered stdio so `execute`/`run` can return a `RunResult` instead of writing
 * straight to the process. Tests need byte-exact captures and the entrypoint
 * shell needs to flush in order — both go through this.
 */
function bufferedStream(): { write: Writable; readonly text: () => string } {
  let buf = "";
  const write = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      cb();
    },
  });
  return { write, text: () => buf };
}

/**
 * No-op deps stub used by `run()` for help/version paths and by tests that
 * exercise the pure parsing surface. A test that triggers an effectful
 * dispatch through this would get a clear `Function called but not provided`
 * failure, which is what we want.
 */
const NO_DEPS: ExecuteDeps = {
  up: () => {
    throw new Error("up: no deps provided");
  },
  down: () => {
    throw new Error("down: no deps provided");
  },
};

/**
 * True when a `cli.process(...)` throw means "no registered command matches
 * this argv" — as opposed to a syntax error inside a matched command (bad
 * flag, missing value), which clipanion reports through the same
 * `UnknownSyntaxError` class but with a non-null `reason` on every candidate.
 *
 * Detection keys off the parse-time error object (#81) — never off rendered
 * command output, so a legitimate runtime failure whose message happens to
 * contain "Command not found" keeps its envelope. The class is matched by
 * `name` + structure because clipanion doesn't export `UnknownSyntaxError`
 * from its top-level entry (and the published bundle inlines clipanion).
 */
function isUnknownCommandError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "UnknownSyntaxError") return false;
  const candidates = (error as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return false;
  // No candidates: clipanion has no idea what was meant — unknown command.
  // All-null reasons: every path failed on the command word itself.
  return candidates.every(
    (candidate) => (candidate as { reason?: unknown } | null)?.reason == null,
  );
}

/**
 * Render an unknown-command failure in the legacy shape pinned by tests:
 * `devtrees: unknown command '<name>'\nRun 'devtrees --help' for usage.\n` on
 * stderr, exit 1. Clipanion's own "Command not found" output is well-formed
 * but worded differently; reshape it here so we don't break the agent-
 * facing surface.
 */
function unknownCommandStderr(argv: ReadonlyArray<string>): string {
  // The first non-flag argument is the offending command name. Clipanion has
  // already validated argv at this point, so this is purely cosmetic.
  const first = argv.find((a) => !a.startsWith("-"));
  const name = first ?? argv[0] ?? "";
  return `devtrees: unknown command '${name}'\nRun 'devtrees --help' for usage.\n`;
}

/**
 * Resolve an argv list through clipanion into a `RunResult`. The single
 * entrypoint every other surface in this file (and the test suite) calls.
 *
 * `deps` is optional so help/version paths can run without wiring the
 * effectful commands; subcommands that need a missing dep dispatch to a
 * no-op `return 0` (preserving the pre-clipanion behaviour where a
 * test-stub omitting `ls` from `ExecuteDeps` returned the "not implemented"
 * stub output).
 */
async function dispatchCli(argv: ReadonlyArray<string>, deps: ExecuteDeps): Promise<RunResult> {
  const cli = buildCli();
  const stdout = bufferedStream();
  const stderr = bufferedStream();
  const context = {
    stdin: process.stdin,
    stdout: stdout.write,
    stderr: stderr.write,
    env: process.env,
    colorDepth: 1,
    deps,
  };

  // Parse before running so unknown-command failures are detected from
  // clipanion's typed parse error (#81), not by regexing rendered output.
  // `cli.run` skips re-parsing when handed an already-processed command.
  let command: Command<DevtreesContext>;
  try {
    command = cli.process({ input: [...argv], context });
  } catch (error) {
    if (isUnknownCommandError(error)) {
      // Reshape clipanion's "Command not found" to devtrees' historical
      // error surface (#62: behavior preserved exactly across the migration).
      return { code: 1, stdout: "", stderr: unknownCommandStderr(argv) };
    }
    // Any other syntax error (bad flag, missing value, ambiguity) renders
    // exactly as `cli.run([...argv])` always rendered it: clipanion's own
    // formatting on stdout, exit 1.
    stdout.write.write(cli.error(error, { colored: false }));
    return { code: 1, stdout: stdout.text(), stderr: stderr.text() };
  }

  const code = await cli.run(command, context);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/**
 * Resolve a command line into output and an exit code without touching the
 * process. Public surface kept for compatibility with callers and tests that
 * predate the clipanion migration.
 *
 * For backwards compat with synchronous callers (the version test), `run`
 * synchronously returns a `RunResult` shape — but in practice it's now a
 * tiny shim that wraps `execute()` and blocks. Since clipanion's runtime is
 * fully synchronous for the `--help`/`--version` paths (no I/O), the
 * promise resolves on the next microtask; callers in the test suite that
 * `await` work as before. Callers that don't await get the result via
 * `Promise<RunResult>` — same as `execute`.
 */
export function run(argv: ReadonlyArray<string>): Promise<RunResult> {
  return dispatchCli(argv, NO_DEPS);
}

/**
 * Resolve a command line, performing effects for the commands in `deps`.
 * The test suite's primary dispatch point — every CLI test injects mock
 * `runUp`/`runDown`/... here and asserts on the returned `RunResult`.
 *
 * `down --shared` and `attach --shared` target the shared instance
 * (ADR-0001): explicit, opt-in flags because the shared instance is
 * decoupled from any single worktree's lifecycle.
 */
export function execute(argv: ReadonlyArray<string>, deps: ExecuteDeps): Promise<RunResult> {
  return dispatchCli(argv, deps);
}

// --- entrypoint -------------------------------------------------------------

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

/**
 * Is a human at a terminal watching this `devtrees` invocation? Both stdout AND
 * stderr must be TTYs (the same signal `runUp`'s attach auto-detect uses,
 * ADR-0005): if either is redirected, the caller asked for headless behaviour.
 * Mirrored here — rather than reused from `commands.ts` — because the #119 hint
 * is an entrypoint concern, decided once at the argv → call-site bridge.
 *
 * `DEVTREES_ASSUME_TTY=1` forces the TTY branch so a test harness spawning the
 * built CLI as a subprocess (whose stdio pipes are never TTYs) can still
 * exercise the human-context path where the hint stays silent.
 */
function entrypointIsTTY(): boolean {
  if (process.env.DEVTREES_ASSUME_TTY === "1") return true;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const { runUp, runUpDryRun, runDown, runEnv, runLs, runAttach, runPrune, runLogs, runInit } =
    await import("./commands.js");
  const deps: ExecuteDeps = {
    up: (options) =>
      runUp({
        ...(options?.attach !== undefined ? { attach: options.attach } : {}),
        ...(options?.waitTimeoutMs !== undefined ? { waitTimeoutMs: options.waitTimeoutMs } : {}),
        ...(options?.namespaces !== undefined ? { namespaces: options.namespaces } : {}),
      }),
    upDryRun: () => runUpDryRun(),
    down: ({ shared }) => runDown({}, { shared }),
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
          sinceMs: opts.sinceMs,
        },
      ),
    init: () => runInit(),
    // Issue #119: the agent-onboarding hint `up` may surface on stderr. The
    // gate is "agent context" (neither stdout nor stderr a TTY — the same
    // signal `up` uses to skip the TUI) plus "no agent-doc references
    // devtrees", evaluated against the real cwd at emit time.
    // `DEVTREES_ASSUME_TTY` forces the TTY branch so a subprocess (whose pipes
    // are never TTYs) can exercise the human-context silence path.
    initHint: () => maybeInitHint({ cwd: process.cwd(), isTTY: entrypointIsTTY() }),
  };
  const result = await dispatchCli(process.argv.slice(2), deps);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
