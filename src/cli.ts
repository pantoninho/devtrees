#!/usr/bin/env node

/**
 * devtrees CLI entrypoint.
 *
 * `run` is a pure function: argv in, a result out. The process-level shell at
 * the bottom of this file is the only impure part, so the command surface stays
 * unit-testable.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
    "",
  ].join("\n");
}

/**
 * Resolve a command line into output and an exit code without touching the
 * process. No arguments, `--help`, or `-h` print help; `--version`/`-v` print
 * the version; an unknown command is an error.
 */
export function run(argv: ReadonlyArray<string>): RunResult {
  const [first] = argv;

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

/** One row in the `ls` table — kept loose so it doesn't pin the CLI to `InstanceInfo`. */
export interface LsInstanceRow {
  readonly id: string;
  readonly kind: "worktree" | "shared";
  readonly status: "running" | "stale";
  readonly ports: Readonly<Record<string, number>>;
  readonly blockBase?: number;
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
 * Render the `ls` result as a small fixed-column table — id, kind, status, and
 * one named-port=value pair per cell. Sized off the longest id/kind/status so
 * the columns stay aligned without pulling in a formatter dependency.
 */
function formatLs(instances: ReadonlyArray<LsInstanceRow>): string {
  if (instances.length === 0) {
    return "devtrees ls: no devtrees instances running.\n";
  }

  const idWidth = Math.max(2, ...instances.map((i) => i.id.length));
  const kindWidth = Math.max(4, ...instances.map((i) => i.kind.length));
  const statusWidth = Math.max(6, ...instances.map((i) => i.status.length));

  const formatPorts = (ports: Readonly<Record<string, number>>): string =>
    Object.entries(ports)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

  const header = `${"ID".padEnd(idWidth)}  ${"KIND".padEnd(kindWidth)}  ${"STATUS".padEnd(
    statusWidth,
  )}  PORTS`;

  const rows = instances.map((i) => {
    const ports =
      formatPorts(i.ports) || (i.blockBase !== undefined ? `(block ${i.blockBase})` : "-");
    return `${i.id.padEnd(idWidth)}  ${i.kind.padEnd(kindWidth)}  ${i.status.padEnd(statusWidth)}  ${ports}`;
  });

  return `${[header, ...rows].join("\n")}\n`;
}

/**
 * Render the `prune` result: one line per cleaned orphan with its id, kind,
 * and the status it had at discovery time (so the operator can see whether
 * the orphan was caught running or already stale).
 */
function formatPrune(pruned: ReadonlyArray<LsInstanceRow>): string {
  if (pruned.length === 0) {
    return "devtrees prune: no orphans to clean up.\n";
  }
  const lines = pruned.map((p) => `  ${p.id} (${p.kind}, was ${p.status})`);
  return `devtrees prune: cleaned ${pruned.length} orphan${pruned.length === 1 ? "" : "s"}:\n${lines.join(
    "\n",
  )}\n`;
}

/**
 * A single command's effectful behaviour. Returns the rendered `RunResult` on
 * success, or `undefined` to defer to the stubbed `run` — used when the deps
 * object lacks the optional collaborator for that command (e.g. an `up`/`down`-
 * only test stub that doesn't pass a `prune`).
 */
type Handler = (rest: ReadonlyArray<string>, deps: ExecuteDeps) => Promise<RunResult | undefined>;

async function handleUp(_rest: ReadonlyArray<string>, deps: ExecuteDeps): Promise<RunResult> {
  const result = await deps.up();
  const ports = Object.entries(result.env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join("\n");
  const sharedNote = result.sharedStarted ? "devtrees up: shared instance started.\n" : "";
  return {
    code: 0,
    stdout: `${sharedNote}devtrees up: '${result.worktreeId}' is up.\n${ports}\n`,
    stderr: "",
  };
}

async function handleDown(rest: ReadonlyArray<string>, deps: ExecuteDeps): Promise<RunResult> {
  const shared = rest.includes("--shared");
  await deps.down({ shared });
  return {
    code: 0,
    stdout: shared
      ? "devtrees down: shared instance stopped.\n"
      : "devtrees down: worktree instance stopped.\n",
    stderr: "",
  };
}

async function handleGenerate(
  _rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
): Promise<RunResult | undefined> {
  if (!deps.generate) return undefined;
  const result = await deps.generate();
  const lines = [
    `devtrees generate: wrote ${result.worktreePath}`,
    ...(result.sharedPath ? [`devtrees generate: wrote ${result.sharedPath}`] : []),
    "",
  ];
  return { code: 0, stdout: lines.join("\n"), stderr: "" };
}

async function handleLs(
  _rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
): Promise<RunResult | undefined> {
  if (deps.ls === undefined) return undefined;
  const result = await deps.ls();
  return { code: 0, stdout: formatLs(result.instances), stderr: "" };
}

async function handleAttach(
  rest: ReadonlyArray<string>,
  deps: ExecuteDeps,
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
): Promise<RunResult | undefined> {
  if (deps.prune === undefined) return undefined;
  const result = await deps.prune();
  return { code: 0, stdout: formatPrune(result.pruned), stderr: "" };
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
  const [first, ...rest] = argv;
  const handler = first !== undefined ? HANDLERS.get(first) : undefined;
  if (handler !== undefined) {
    try {
      const result = await handler(rest, deps);
      if (result !== undefined) return result;
    } catch (err) {
      return { code: 1, stdout: "", stderr: `devtrees: ${(err as Error).message}\n` };
    }
  }
  return run(argv);
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
