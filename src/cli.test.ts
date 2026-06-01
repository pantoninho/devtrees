import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { execute, isEntrypoint, run } from "./cli.js";

describe("devtrees CLI", () => {
  it("prints the version with --version", () => {
    const result = run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("aliases -v to --version", () => {
    expect(run(["-v"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists the commands with --help", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("devtrees");
    expect(result.stdout).toContain("Usage");
    // the stubbed command surface from the PRD
    for (const cmd of ["up", "down", "ls", "attach", "generate", "prune"]) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it("aliases -h to --help", () => {
    expect(run(["-h"]).stdout).toContain("Usage");
  });

  it("prints help and exits 0 when given no arguments", () => {
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage");
  });

  it("errors on an unknown command", () => {
    const result = run(["frobnicate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("frobnicate");
  });
});

describe("devtrees CLI — execute (effectful dispatch)", () => {
  it("routes `up` to the up command and reports the resolved port", async () => {
    const up = vi.fn().mockResolvedValue({
      worktreeId: "login",
      socketPath: "/x.sock",
      env: { WEB_PORT: "20512" },
    });
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(up).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("login");
    expect(result.stdout).toContain("WEB_PORT");
  });

  it("routes `down` to the down command with shared=false by default", async () => {
    const down = vi.fn().mockResolvedValue(undefined);
    const result = await execute(["down"], { up: vi.fn(), down });
    expect(down).toHaveBeenCalledWith({ shared: false });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("worktree instance stopped");
  });

  it("passes shared=true through when --shared is given", async () => {
    const down = vi.fn().mockResolvedValue(undefined);
    const result = await execute(["down", "--shared"], { up: vi.fn(), down });
    expect(down).toHaveBeenCalledWith({ shared: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("shared instance stopped");
  });

  it("notes when up triggered a shared lazy start", async () => {
    const up = vi.fn().mockResolvedValue({
      worktreeId: "login",
      socketPath: "/x.sock",
      env: { WEB_PORT: "20512", DB_PORT: "19000" },
      sharedStarted: true,
    });
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(result.stdout).toContain("shared instance started");
  });

  it("turns a missing process-compose binary into a clear, non-zero error", async () => {
    const up = vi.fn().mockRejectedValue(new Error("process-compose not found. ... install"));
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/process-compose/);
  });

  it("delegates non-effectful commands to the pure run()", async () => {
    const result = await execute(["--version"], { up: vi.fn(), down: vi.fn() });
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("routes `generate` to the generate command and reports the written paths", async () => {
    const generate = vi.fn().mockResolvedValue({
      worktreeId: "login",
      worktreeRoot: "/r/wt/login",
      worktreePath: "/r/.git/devtrees/login.yaml",
      env: { WEB_PORT: "20512" },
    });
    const result = await execute(["generate"], { up: vi.fn(), down: vi.fn(), generate });
    expect(generate).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("/r/.git/devtrees/login.yaml");
  });

  it("`generate` also prints the shared config path when one was written", async () => {
    const generate = vi.fn().mockResolvedValue({
      worktreeId: "login",
      worktreeRoot: "/r/wt/login",
      worktreePath: "/r/.git/devtrees/login.yaml",
      sharedPath: "/r/.git/devtrees/shared.yaml",
      env: { WEB_PORT: "20512", DB_PORT: "20000" },
      sharedEnv: { DB_PORT: "20000" },
    });
    const result = await execute(["generate"], { up: vi.fn(), down: vi.fn(), generate });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("/r/.git/devtrees/login.yaml");
    expect(result.stdout).toContain("/r/.git/devtrees/shared.yaml");
  });

  it("turns a generate failure into a clear, non-zero error", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("devtrees.yaml not found"));
    const result = await execute(["generate"], { up: vi.fn(), down: vi.fn(), generate });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/devtrees\.yaml not found/);
  });

  it("routes `ls` to the ls command and formats the table", async () => {
    const ls = vi.fn().mockResolvedValue({
      anchor: "/repo/.git",
      instances: [
        {
          id: "shared",
          kind: "shared",
          status: "running",
          socketPath: "/repo/.git/devtrees/run/shared.sock",
          ports: { DB_PORT: 30000 },
          blockBase: 30000,
        },
        {
          id: "login",
          kind: "worktree",
          status: "running",
          socketPath: "/repo/.git/devtrees/run/login.sock",
          ports: { WEB_PORT: 20512 },
          blockBase: 20512,
        },
      ],
    });
    const result = await execute(["ls"], { up: vi.fn(), down: vi.fn(), ls });
    expect(ls).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("shared");
    expect(result.stdout).toContain("login");
    expect(result.stdout).toContain("running");
    expect(result.stdout).toContain("WEB_PORT=20512");
    expect(result.stdout).toContain("DB_PORT=30000");
  });

  it("`ls` says 'no devtrees instances running' when none are discovered", async () => {
    const ls = vi.fn().mockResolvedValue({ anchor: "/repo/.git", instances: [] });
    const result = await execute(["ls"], { up: vi.fn(), down: vi.fn(), ls });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no devtrees instances/i);
  });

  it("routes `prune` to the prune command and lists the cleaned orphans", async () => {
    const prune = vi.fn().mockResolvedValue({
      anchor: "/repo/.git",
      pruned: [
        {
          id: "removed",
          kind: "worktree",
          status: "running",
          socketPath: "/repo/.git/devtrees/run/removed.sock",
          ports: {},
          blockBase: 20032,
        },
      ],
    });
    const result = await execute(["prune"], { up: vi.fn(), down: vi.fn(), prune });
    expect(prune).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("removed");
  });

  it("`prune` says 'no orphans' when reconciliation finds nothing to clean", async () => {
    const prune = vi.fn().mockResolvedValue({ anchor: "/repo/.git", pruned: [] });
    const result = await execute(["prune"], { up: vi.fn(), down: vi.fn(), prune });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no orphan|nothing to prune/i);
  });

  it("turns a prune failure into a clear, non-zero error", async () => {
    const prune = vi.fn().mockRejectedValue(new Error("could not list worktrees"));
    const result = await execute(["prune"], { up: vi.fn(), down: vi.fn(), prune });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/could not list worktrees/);
  });

  it("`ls` marks stale entries in its output so an operator can spot orphans", async () => {
    const ls = vi.fn().mockResolvedValue({
      anchor: "/repo/.git",
      instances: [
        {
          id: "login",
          kind: "worktree",
          status: "stale",
          socketPath: "/repo/.git/devtrees/run/login.sock",
          ports: {},
          blockBase: 20512,
        },
      ],
    });
    const result = await execute(["ls"], { up: vi.fn(), down: vi.fn(), ls });
    expect(result.stdout).toContain("stale");
  });

  it("routes `attach` to the attach command with shared=false by default", async () => {
    const attach = vi.fn().mockResolvedValue(undefined);
    const result = await execute(["attach"], { up: vi.fn(), down: vi.fn(), attach });
    expect(attach).toHaveBeenCalledWith({ shared: false });
    expect(result.code).toBe(0);
  });

  it("passes shared=true through to attach when --shared is given", async () => {
    const attach = vi.fn().mockResolvedValue(undefined);
    const result = await execute(["attach", "--shared"], { up: vi.fn(), down: vi.fn(), attach });
    expect(attach).toHaveBeenCalledWith({ shared: true });
    expect(result.code).toBe(0);
  });

  it("turns an attach failure (no running instance) into a clear, non-zero error", async () => {
    const attach = vi
      .fn()
      .mockRejectedValue(new Error("no worktree instance is running for 'login'"));
    const result = await execute(["attach"], { up: vi.fn(), down: vi.fn(), attach });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no worktree instance is running/);
  });

  it("routes `env` to the env command and prints KEY=value lines", async () => {
    const env = vi.fn().mockResolvedValue({
      worktreeId: "login",
      env: { DEVTREES_WORKTREE_ID: "login", WEB_PORT: "20512", DB_PORT: "30000" },
    });
    const result = await execute(["env"], { up: vi.fn(), down: vi.fn(), env });
    expect(env).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("DEVTREES_WORKTREE_ID=login");
    expect(result.stdout).toContain("WEB_PORT=20512");
    expect(result.stdout).toContain("DB_PORT=30000");
  });

  it("`env --json` emits {schema_version, env} on stdout", async () => {
    const env = vi.fn().mockResolvedValue({
      worktreeId: "login",
      env: { DEVTREES_WORKTREE_ID: "login", WEB_PORT: "20512" },
    });
    const result = await execute(["env", "--json"], { up: vi.fn(), down: vi.fn(), env });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      env: Record<string, string>;
    };
    expect(parsed.schema_version).toBeDefined();
    expect(parsed.env).toEqual({ DEVTREES_WORKTREE_ID: "login", WEB_PORT: "20512" });
  });

  it("turns an env failure (e.g. missing devtrees.yaml) into a clear, non-zero error", async () => {
    const env = vi.fn().mockRejectedValue(new Error("devtrees.yaml not found"));
    const result = await execute(["env"], { up: vi.fn(), down: vi.fn(), env });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/devtrees\.yaml not found/);
  });

  it("surfaces an attach-shared failure (no running shared instance) clearly", async () => {
    const attach = vi.fn().mockRejectedValue(new Error("no shared instance is running"));
    const result = await execute(["attach", "--shared"], {
      up: vi.fn(),
      down: vi.fn(),
      attach,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no shared instance is running/);
  });
});

/**
 * The agent-facing surface (issue #27): a global `--json` flag at the CLI
 * entrypoint, threaded into every command, routed through the output
 * formatter. The human surface stays byte-for-byte unchanged when `--json`
 * is absent.
 */
describe("devtrees CLI — --json (agent-facing surface)", () => {
  const lsRows = {
    anchor: "/repo/.git",
    instances: [
      {
        id: "shared",
        kind: "shared" as const,
        status: "running" as const,
        socketPath: "/repo/.git/devtrees/run/shared.sock",
        ports: { DB_PORT: 30000 },
        blockBase: 30000,
      },
      {
        id: "login",
        kind: "worktree" as const,
        status: "running" as const,
        socketPath: "/repo/.git/devtrees/run/login.sock",
        ports: { WEB_PORT: 20512 },
        blockBase: 20512,
      },
    ],
  };

  it("`ls --json` emits a single JSON document with schema_version on stdout", async () => {
    const ls = vi.fn().mockResolvedValue(lsRows);
    const result = await execute(["ls", "--json"], { up: vi.fn(), down: vi.fn(), ls });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      instances: ReadonlyArray<{ id: string; ports: Record<string, number> }>;
    };
    expect(parsed.schema_version).toBeDefined();
    expect(parsed.instances).toHaveLength(2);
    expect(parsed.instances.find((i) => i.id === "login")?.ports).toEqual({ WEB_PORT: 20512 });
  });

  it("`--json` is accepted before the command name too (global flag, any position)", async () => {
    const ls = vi.fn().mockResolvedValue(lsRows);
    const result = await execute(["--json", "ls"], { up: vi.fn(), down: vi.fn(), ls });
    expect(result.code).toBe(0);
    // Must still parse as JSON — the flag was honored even though it preceded `ls`.
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("`ls` without --json is byte-for-byte unchanged from today's table", async () => {
    // The exact pre-formatter output (from cli.ts at HEAD), captured here so a
    // regression in the human path is impossible to introduce silently.
    const ls = vi.fn().mockResolvedValue(lsRows);
    const result = await execute(["ls"], { up: vi.fn(), down: vi.fn(), ls });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "ID      KIND      STATUS   PORTS",
        "shared  shared    running  DB_PORT=30000",
        "login   worktree  running  WEB_PORT=20512",
        "",
      ].join("\n"),
    );
  });

  /**
   * One row per documented failure mode (ADR-0005's error-code enum). Each
   * row pins both halves of the envelope shape: the stdout JSON document and
   * the human diagnostic on stderr.
   */
  it.each([
    {
      cmd: "up",
      depKey: "up" as const,
      message: "process-compose not found on PATH",
      expectedCode: "PROCESS_COMPOSE_NOT_FOUND",
      stderrMatch: /process-compose/,
    },
    {
      cmd: "attach",
      depKey: "attach" as const,
      message: "no worktree instance is running for 'login'",
      expectedCode: "INSTANCE_NOT_FOUND",
      stderrMatch: /no worktree instance is running/,
    },
    {
      cmd: "prune",
      depKey: "prune" as const,
      message: "could not list worktrees",
      expectedCode: "UNKNOWN",
      stderrMatch: /could not list worktrees/,
    },
  ])(
    "`$cmd --json` failure → {error:{code:$expectedCode}} on stdout, human diagnostic on stderr, non-zero exit",
    async ({ cmd, depKey, message, expectedCode, stderrMatch }) => {
      const failing = vi.fn().mockRejectedValue(new Error(message));
      const deps = {
        up: vi.fn(),
        down: vi.fn(),
        [depKey]: failing,
      } as unknown as Parameters<typeof execute>[1];
      const result = await execute([cmd, "--json"], deps);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(stderrMatch);
      const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe(expectedCode);
      expect(parsed.error.message).toMatch(stderrMatch);
    },
  );

  it("`ls --json` success leaves stderr untouched (no diagnostics in success cases)", async () => {
    const ls = vi.fn().mockResolvedValue(lsRows);
    const result = await execute(["ls", "--json"], { up: vi.fn(), down: vi.fn(), ls });
    expect(result.stderr).toBe("");
  });

  it("error without --json continues today's behaviour — message on stderr, stdout empty", async () => {
    const up = vi.fn().mockRejectedValue(new Error("process-compose not found on PATH"));
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/process-compose/);
  });

  it("`ls --json` with no instances emits {instances:[]} (not the 'no instances' string)", async () => {
    const ls = vi.fn().mockResolvedValue({ anchor: "/repo/.git", instances: [] });
    const result = await execute(["ls", "--json"], { up: vi.fn(), down: vi.fn(), ls });
    const parsed = JSON.parse(result.stdout) as { instances: unknown[] };
    expect(parsed.instances).toEqual([]);
  });
});

describe("devtrees CLI — isEntrypoint", () => {
  // The published binary is invoked through a symlink (npm-link bin, pnpm
  // shim, Homebrew bin). `process.argv[1]` is the symlink path; `import.meta.url`
  // is the resolved target. A raw `argv[1] === fileURLToPath(import.meta.url)`
  // misses this case, leaving the CLI silently inert. Lock the symlink path in.
  let dir: string;

  function createDir(): string {
    return mkdtempSync(join(tmpdir(), "devtrees-cli-entry-"));
  }

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  // `tmpdir()` on macOS is itself a symlink (`/var/folders → /private/var/folders`),
  // so module URLs in this repo's tests use the realpathed path to match what
  // `import.meta.url` would produce for a real module.
  function moduleUrl(file: string): string {
    return pathToFileURL(realpathSync(file)).href;
  }

  it("recognizes the module as entrypoint when argv[1] is the same file", () => {
    dir = createDir();
    const file = join(dir, "real.mjs");
    writeFileSync(file, "");
    expect(isEntrypoint(moduleUrl(file), file)).toBe(true);
  });

  it("recognizes the module as entrypoint when argv[1] is a symlink to it", () => {
    dir = createDir();
    const real = join(dir, "real.mjs");
    const link = join(dir, "link.mjs");
    writeFileSync(real, "");
    symlinkSync(real, link);
    expect(isEntrypoint(moduleUrl(real), link)).toBe(true);
  });

  it("returns false when argv[1] is undefined (imported, not invoked)", () => {
    expect(isEntrypoint("file:///somewhere/cli.mjs", undefined)).toBe(false);
  });

  it("returns false when argv[1] points at a different file", () => {
    dir = createDir();
    const a = join(dir, "a.mjs");
    const b = join(dir, "b.mjs");
    writeFileSync(a, "");
    writeFileSync(b, "");
    expect(isEntrypoint(moduleUrl(a), b)).toBe(false);
  });

  it("returns false when argv[1] cannot be resolved", () => {
    expect(isEntrypoint("file:///somewhere/cli.mjs", "/nonexistent/file")).toBe(false);
  });
});
