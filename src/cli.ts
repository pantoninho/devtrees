#!/usr/bin/env node

/**
 * devtrees CLI entrypoint.
 *
 * `run` is a pure function: argv in, a result out. The process-level shell at
 * the bottom of this file is the only impure part, so the command surface stays
 * unit-testable.
 */

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

/** The effectful commands, injected so `execute` stays unit-testable. */
export interface ExecuteDeps {
  up: () => Promise<{
    worktreeId: string;
    socketPath: string;
    env: Record<string, string>;
    sharedStarted?: boolean;
  }>;
  down: (options: { shared: boolean }) => Promise<void>;
}

/**
 * Resolve a command line, performing effects for `up`/`down` and delegating
 * everything else to the pure `run`. Errors (e.g. a missing process-compose
 * binary) become a clear, non-zero result rather than an unhandled rejection.
 *
 * `down --shared` tears down the shared instance (ADR-0001): an explicit,
 * opt-in flag because the shared instance is decoupled from any single
 * worktree's lifecycle.
 */
export async function execute(argv: ReadonlyArray<string>, deps: ExecuteDeps): Promise<RunResult> {
  const [first, ...rest] = argv;

  try {
    if (first === "up") {
      const result = await deps.up();
      const ports = Object.entries(result.env)
        .map(([k, v]) => `  ${k}=${v}`)
        .join("\n");
      const sharedNote = result.sharedStarted
        ? "devtrees up: shared instance started.\n"
        : "";
      return {
        code: 0,
        stdout: `${sharedNote}devtrees up: '${result.worktreeId}' is up.\n${ports}\n`,
        stderr: "",
      };
    }
    if (first === "down") {
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
  } catch (err) {
    return { code: 1, stdout: "", stderr: `devtrees: ${(err as Error).message}\n` };
  }

  return run(argv);
}

// Run only when invoked as the program, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { runUp, runDown } = await import("./commands.js");
  const result = await execute(process.argv.slice(2), {
    up: () => runUp(),
    down: ({ shared }) => runDown({}, { shared }),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
