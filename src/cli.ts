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

// Run only when invoked as the program, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
