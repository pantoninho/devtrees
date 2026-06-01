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
  formatError,
  formatGenerate,
  formatLs,
  formatPrune,
  formatUp,
  type FormatMode,
  type LsInstanceRow,
} from "./output.js";

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
    "  -h, --help     Print this help text",
    "  -v, --version  Print the version",
    "      --json     Emit machine-readable output (see ADR-0005)",
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

/** The effectful commands, injected so `execute` stays unit-testable. */
export interface ExecuteDeps {
  up: () => Promise<{
    worktreeId: string;
    socketPath: string;
    env: Record<string, string>;
    sharedStarted?: boolean;
  }>;
  down: (options: { shared: boolean }) => Promise<void>;
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

async function handleUp(
  _rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
  mode: FormatMode,
): Promise<RunResult> {
  const result = await deps.up();
  const out = formatUp(
    {
      worktreeId: result.worktreeId,
      env: result.env,
      sharedStarted: result.sharedStarted ?? false,
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
  await deps.down({ shared });
  const out = formatDown({ shared }, mode);
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

const HANDLERS: ReadonlyMap<string, Handler> = new Map([
  ["up", handleUp],
  ["down", handleDown],
  ["generate", handleGenerate],
  ["ls", handleLs],
  ["attach", handleAttach],
  ["prune", handlePrune],
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
  const { runUp, runDown, runGenerate, runLs, runAttach, runPrune } = await import("./commands.js");
  const result = await execute(process.argv.slice(2), {
    up: () => runUp(),
    down: ({ shared }) => runDown({}, { shared }),
    generate: () => runGenerate(),
    ls: () => runLs(),
    attach: ({ shared }) => runAttach({}, { shared }),
    prune: () => runPrune(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
