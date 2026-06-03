import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { execute, isEntrypoint, parseLogsArgs, run } from "./cli.js";

async function* fromArray<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}

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
          kind: "worktree" as const,
          status: "running" as const,
          worktreePath: "/abs/path/.../devtrees-example-removed",
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
      ls: { instances: ReadonlyArray<{ id: string; ports: Record<string, number> }> };
    };
    expect(parsed.schema_version).toBeDefined();
    expect(parsed.ls.instances).toHaveLength(2);
    expect(parsed.ls.instances.find((i) => i.id === "login")?.ports).toEqual({ WEB_PORT: 20512 });
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

  it("`ls --json` with no instances emits {ls:{instances:[]}} (not the 'no instances' string)", async () => {
    const ls = vi.fn().mockResolvedValue({ anchor: "/repo/.git", instances: [] });
    const result = await execute(["ls", "--json"], { up: vi.fn(), down: vi.fn(), ls });
    const parsed = JSON.parse(result.stdout) as { ls: { instances: unknown[] } };
    expect(parsed.ls.instances).toEqual([]);
  });

  /**
   * Issue #29 — `ls --json` carries a per-service nesting so an agent can ask
   * 'is `worker` healthy in my worktree instance?' with one call.
   */
  it("`ls --json` nests services[] (name/status/health/ports) on every instance entry", async () => {
    const ls = vi.fn().mockResolvedValue({
      anchor: "/repo/.git",
      instances: [
        {
          id: "login",
          kind: "worktree" as const,
          status: "running" as const,
          socketPath: "/repo/.git/devtrees/run/login.sock",
          ports: { WEB_PORT: 20000, WORKER_PORT: 20001 },
          blockBase: 20000,
          services: [
            { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20000 } },
            {
              name: "worker",
              status: "Running",
              health: "not_ready",
              ports: { WORKER_PORT: 20001 },
            },
          ],
        },
      ],
    });
    const result = await execute(["ls", "--json"], { up: vi.fn(), down: vi.fn(), ls });
    const parsed = JSON.parse(result.stdout) as {
      ls: {
        instances: ReadonlyArray<{
          id: string;
          services: ReadonlyArray<{
            name: string;
            status: string;
            health: string;
            ports: Record<string, number>;
          }>;
        }>;
      };
    };
    const login = parsed.ls.instances.find((i) => i.id === "login");
    expect(login?.services).toEqual([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20000 } },
      { name: "worker", status: "Running", health: "not_ready", ports: { WORKER_PORT: 20001 } },
    ]);
  });
});

describe("devtrees CLI — logs (#33)", () => {
  it("parses positional service name and default flags", () => {
    expect(parseLogsArgs(["web"])).toEqual({
      service: "web",
      all: false,
      shared: false,
      follow: false,
      tail: undefined,
      since: undefined,
    });
  });

  it("parses --follow / -f / --tail=N / --since=DUR / --all / --shared", () => {
    expect(parseLogsArgs(["web", "--follow", "--tail=25", "--since=5m"])).toMatchObject({
      service: "web",
      follow: true,
      tail: 25,
      since: "5m",
    });
    expect(parseLogsArgs(["-f", "--all", "--shared"])).toMatchObject({
      service: undefined,
      all: true,
      shared: true,
      follow: true,
    });
  });

  it("routes `logs <service>` to deps.logs and writes lines verbatim in human mode", async () => {
    const logs = vi.fn().mockResolvedValue({
      services: ["web"],
      events: fromArray([
        { ts: "T1", service: "web", stream: "stdout" as const, line: "alpha" },
        { ts: "T2", service: "web", stream: "stdout" as const, line: "beta" },
      ]),
    });
    const result = await execute(["logs", "web"], { up: vi.fn(), down: vi.fn(), logs });
    expect(result.code).toBe(0);
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({ service: "web", all: false, shared: false }),
    );
    expect(result.stdout).toBe("alpha\nbeta\n");
    expect(result.stderr).toBe("");
  });

  it("`logs <service> --json` emits NDJSON with one {ts,service,stream,line} per line", async () => {
    const logs = vi.fn().mockResolvedValue({
      services: ["web"],
      events: fromArray([
        { ts: "2026-06-01T22:00:00Z", service: "web", stream: "stdout" as const, line: "hello" },
        {
          ts: "2026-06-01T22:00:01Z",
          service: "web",
          stream: "stdout" as const,
          line: 'json: {"a":1}',
        },
      ]),
    });
    const result = await execute(["logs", "web", "--json"], {
      up: vi.fn(),
      down: vi.fn(),
      logs,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(first).toEqual({
      ts: "2026-06-01T22:00:00Z",
      service: "web",
      stream: "stdout",
      line: "hello",
    });
    const second = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
    expect(second).toEqual({
      ts: "2026-06-01T22:00:01Z",
      service: "web",
      stream: "stdout",
      line: 'json: {"a":1}',
    });
  });

  it("`logs --all` prefixes lines with [service] in human mode for attribution", async () => {
    const logs = vi.fn().mockResolvedValue({
      services: ["web", "worker"],
      events: fromArray([
        { ts: "T1", service: "web", stream: "stdout" as const, line: "w1" },
        { ts: "T2", service: "worker", stream: "stdout" as const, line: "k1" },
      ]),
    });
    const result = await execute(["logs", "--all"], { up: vi.fn(), down: vi.fn(), logs });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("[web] w1\n[worker] k1\n");
  });

  it("`logs --all --json` does NOT add the [service] prefix (the field is the attribution)", async () => {
    const logs = vi.fn().mockResolvedValue({
      services: ["web", "worker"],
      events: fromArray([{ ts: "T1", service: "web", stream: "stdout" as const, line: "raw" }]),
    });
    const result = await execute(["logs", "--all", "--json"], {
      up: vi.fn(),
      down: vi.fn(),
      logs,
    });
    const line = result.stdout.trimEnd();
    expect(line.startsWith("[")).toBe(false);
    const parsed = JSON.parse(line) as { line: string };
    expect(parsed.line).toBe("raw");
  });

  it("passes --shared and --follow through to deps.logs", async () => {
    const logs = vi.fn().mockResolvedValue({ services: ["postgres"], events: fromArray([]) });
    await execute(["logs", "postgres", "--shared", "--follow"], {
      up: vi.fn(),
      down: vi.fn(),
      logs,
    });
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({ service: "postgres", shared: true, follow: true }),
    );
  });

  it("errors with usage hint when no service and no --all is given (exit 1, stderr)", async () => {
    const logs = vi.fn();
    const result = await execute(["logs"], { up: vi.fn(), down: vi.fn(), logs });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/specify a service|--all/);
    expect(logs).not.toHaveBeenCalled();
  });

  it("`logs --json` failure (missing socket) → INSTANCE_NOT_FOUND envelope on stdout", async () => {
    const logs = vi
      .fn()
      .mockRejectedValue(new Error("no worktree instance is running for 'login'"));
    const result = await execute(["logs", "web", "--json"], {
      up: vi.fn(),
      down: vi.fn(),
      logs,
    });
    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("INSTANCE_NOT_FOUND");
    expect(result.stderr).toMatch(/no worktree instance is running/);
  });
});

/**
 * Issue #28: `devtrees up` must be usable from a non-TTY caller. The CLI
 * surface adds `--attach`/`--no-attach` to override the implicit TTY-based
 * decision, and `--wait-timeout` to bound the health-wait window. The
 * `HEALTH_TIMEOUT` error code joins the documented `--json` envelope.
 */
describe("devtrees CLI — up non-interactive (#28)", () => {
  const baseUpResult = {
    worktreeId: "login",
    socketPath: "/x.sock",
    env: { WEB_PORT: "20512" },
  };

  it("passes attach=true to `up` when --attach is given (force-attach)", async () => {
    const up = vi.fn().mockResolvedValue(baseUpResult);
    await execute(["up", "--attach"], { up, down: vi.fn() });
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ attach: true }));
  });

  it("passes attach=false to `up` when --no-attach is given (force-skip)", async () => {
    const up = vi.fn().mockResolvedValue(baseUpResult);
    await execute(["up", "--no-attach"], { up, down: vi.fn() });
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ attach: false }));
  });

  it("omits attach from `up` options when neither flag is given (TTY default applies)", async () => {
    const up = vi.fn().mockResolvedValue(baseUpResult);
    await execute(["up"], { up, down: vi.fn() });
    const call = up.mock.calls[0]?.[0] ?? {};
    expect(call.attach).toBeUndefined();
  });

  it("parses --wait-timeout=<seconds> into milliseconds for `up`", async () => {
    const up = vi.fn().mockResolvedValue(baseUpResult);
    await execute(["up", "--wait-timeout=30"], { up, down: vi.fn() });
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ waitTimeoutMs: 30_000 }));
  });

  it("parses --wait-timeout <seconds> (space-separated) for `up`", async () => {
    const up = vi.fn().mockResolvedValue(baseUpResult);
    await execute(["up", "--wait-timeout", "45"], { up, down: vi.fn() });
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ waitTimeoutMs: 45_000 }));
  });

  it("rejects --wait-timeout values that aren't a positive number", async () => {
    const up = vi.fn().mockResolvedValue(baseUpResult);
    const result = await execute(["up", "--wait-timeout=zero"], { up, down: vi.fn() });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--wait-timeout/);
    expect(up).not.toHaveBeenCalled();
  });

  it("`up --json` HEALTH_TIMEOUT failure → error envelope with code:HEALTH_TIMEOUT", async () => {
    const err = Object.assign(new Error("timed out waiting for services to be healthy [web]"), {
      code: "HEALTH_TIMEOUT" as const,
    });
    const up = vi.fn().mockRejectedValue(err);
    const result = await execute(["up", "--json"], { up, down: vi.fn() });
    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("HEALTH_TIMEOUT");
    expect(parsed.error.message).toMatch(/timed out/);
    expect(result.stderr).toMatch(/timed out/);
  });

  it("help text mentions --attach, --no-attach, and --wait-timeout", () => {
    const help = run(["--help"]).stdout;
    expect(help).toMatch(/--attach/);
    expect(help).toMatch(/--no-attach/);
    expect(help).toMatch(/--wait-timeout/);
  });
});

/**
 * Issue #48 — `devtrees down --json` and `devtrees prune --json` are trimmed
 * to operation-output only. `down --json` carries exactly one of
 * `down.shared: true` or `down.worktreeId: "<id>"`. `prune --json` lists
 * reconciled-away orphans as identity-only entries `{id, kind, worktreePath}`
 * under `prune.pruned[]`. Human output for both is unchanged.
 */
describe("devtrees CLI — down/prune --json envelopes (#48)", () => {
  it("`down --json` emits the worktree-teardown envelope: {down:{worktreeId}} and nothing else", async () => {
    const down = vi.fn().mockResolvedValue({ worktreeId: "login" });
    const result = await execute(["down", "--json"], { up: vi.fn(), down });
    expect(down).toHaveBeenCalledWith({ shared: false });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      down: Record<string, unknown>;
    };
    expect(parsed.schema_version).toBeDefined();
    expect(parsed.down).toEqual({ worktreeId: "login" });
    expect(parsed.down).not.toHaveProperty("shared");
    expect(parsed.down).not.toHaveProperty("env");
    expect(parsed.down).not.toHaveProperty("services");
    expect(parsed.down).not.toHaveProperty("block_base");
  });

  it("`down --shared --json` emits the shared-teardown envelope: {down:{shared:true}} and nothing else", async () => {
    const down = vi.fn().mockResolvedValue({});
    const result = await execute(["down", "--shared", "--json"], { up: vi.fn(), down });
    expect(down).toHaveBeenCalledWith({ shared: true });
    const parsed = JSON.parse(result.stdout) as {
      down: Record<string, unknown>;
    };
    expect(parsed.down).toEqual({ shared: true });
    expect(parsed.down).not.toHaveProperty("worktreeId");
    expect(parsed.down).not.toHaveProperty("env");
    expect(parsed.down).not.toHaveProperty("services");
    expect(parsed.down).not.toHaveProperty("block_base");
  });

  it("`down` without --json is byte-for-byte unchanged from today's text", async () => {
    const down = vi.fn().mockResolvedValue({ worktreeId: "login" });
    const result = await execute(["down"], { up: vi.fn(), down });
    expect(result.stdout).toBe("devtrees down: worktree instance stopped.\n");
  });

  it("`down --json` failure → INSTANCE_NOT_FOUND envelope on stdout, human diagnostic on stderr", async () => {
    const down = vi
      .fn()
      .mockRejectedValue(new Error("no worktree instance is running for 'login'"));
    const result = await execute(["down", "--json"], { up: vi.fn(), down });
    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("INSTANCE_NOT_FOUND");
    expect(result.stderr).toMatch(/no worktree instance is running/);
  });

  it("`prune --json` emits {schema_version, prune:{pruned:[...]}} with identity-only entries", async () => {
    const prune = vi.fn().mockResolvedValue({
      anchor: "/repo/.git",
      pruned: [
        {
          id: "removed",
          kind: "worktree" as const,
          status: "running" as const,
          worktreePath: "/abs/path/.../devtrees-example-removed",
        },
      ],
    });
    const result = await execute(["prune", "--json"], { up: vi.fn(), down: vi.fn(), prune });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      prune: { pruned: ReadonlyArray<Record<string, unknown>> };
    };
    expect(parsed.schema_version).toBeDefined();
    expect(parsed.prune.pruned).toHaveLength(1);
    expect(parsed.prune.pruned[0]).toEqual({
      id: "removed",
      kind: "worktree",
      worktreePath: "/abs/path/.../devtrees-example-removed",
    });
  });

  it("`prune --json` with no orphans emits {prune:{pruned:[]}} (not the 'no orphans' string)", async () => {
    const prune = vi.fn().mockResolvedValue({ anchor: "/repo/.git", pruned: [] });
    const result = await execute(["prune", "--json"], { up: vi.fn(), down: vi.fn(), prune });
    const parsed = JSON.parse(result.stdout) as { prune: { pruned: unknown[] } };
    expect(parsed.prune.pruned).toEqual([]);
  });

  it("`prune` without --json is byte-for-byte unchanged from today's text (no orphans case)", async () => {
    const prune = vi.fn().mockResolvedValue({ anchor: "/repo/.git", pruned: [] });
    const result = await execute(["prune"], { up: vi.fn(), down: vi.fn(), prune });
    expect(result.stdout).toBe("devtrees prune: no orphans to clean up.\n");
  });
});

/**
 * Issue #30: `devtrees up --json` on success emits a single JSON document
 * with everything an agent would otherwise piece together from `ls --json`
 * + `env --json` — the allocated port block, per-service runtime rows, and
 * the injected-value map. The human path stays unchanged.
 */
describe("devtrees CLI — up --json state envelope (#30)", () => {
  it("emits {schema_version, up:{worktree_id, block_base, env, services, shared_started}} on success", async () => {
    const up = vi.fn().mockResolvedValue({
      worktreeId: "login",
      socketPath: "/x.sock",
      env: { DEVTREES_WORKTREE_ID: "login", WEB_PORT: "20512", DB_PORT: "30000" },
      sharedStarted: true,
      blockBase: 20512,
      services: [{ name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20512 } }],
    });
    const result = await execute(["up", "--json"], { up, down: vi.fn() });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      up: {
        worktree_id: string;
        block_base: number;
        env: Record<string, string>;
        services: ReadonlyArray<{
          name: string;
          status: string;
          health: string;
          ports: Record<string, number>;
        }>;
        shared_started: boolean;
      };
    };
    expect(parsed.schema_version).toBeDefined();
    expect(parsed.up.worktree_id).toBe("login");
    expect(parsed.up.block_base).toBe(20512);
    expect(parsed.up.env).toEqual({
      DEVTREES_WORKTREE_ID: "login",
      WEB_PORT: "20512",
      DB_PORT: "30000",
    });
    expect(parsed.up.services).toEqual([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20512 } },
    ]);
    expect(parsed.up.shared_started).toBe(true);
  });

  it("human `devtrees up` output is unchanged when runUp returns the new state envelope fields", async () => {
    const up = vi.fn().mockResolvedValue({
      worktreeId: "login",
      socketPath: "/x.sock",
      env: { WEB_PORT: "20512" },
      sharedStarted: false,
      blockBase: 20512,
      services: [{ name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20512 } }],
    });
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(result.code).toBe(0);
    // The human path renders the same "'<id>' is up" line and KEY=value
    // list as before — no JSON shape leaks into the human surface.
    expect(result.stdout).toContain("'login' is up");
    expect(result.stdout).toContain("WEB_PORT=20512");
    expect(result.stdout).not.toContain("block_base");
    expect(result.stdout).not.toContain("services");
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
