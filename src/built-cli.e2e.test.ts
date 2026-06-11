/**
 * Built-CLI e2e: the argv→commands wiring through `dist/cli.mjs` (issue #93).
 *
 * Closes the seam nothing in the default suite exercised: `e2e.test.ts`
 * imports the command functions directly and `cli.test.ts` injects mock deps,
 * so the entrypoint block at the bottom of `src/cli.ts` — where parsed flags
 * are threaded into the REAL `runUp`/`runDown`/... — was only covered by the
 * env-gated real-binary smoke. A wiring bug (e.g. dropping `waitTimeoutMs` in
 * the deps adapter) passed every default-suite test.
 *
 * These scenarios spawn the built bundle as a subprocess against the stub
 * `process-compose` (`test/stub-process-compose.mjs`), resolved through a
 * PATH shim because the entrypoint constructs the driver with its default
 * binary name. They run UNGATED on every `vp test run`:
 *
 *   - up/ls/env/down `--json` round-trip, asserting the envelopes the agent
 *     surface documents (ADR-0005) and that allocations survive into `env`.
 *   - `--wait-timeout` must reach the health poller: a never-ready stub plus
 *     `--wait-timeout 1` must produce HEALTH_TIMEOUT mentioning 1000ms in
 *     about a second — not the 120s default.
 *   - `logs --tail N` must reach the driver's `-n N` argv.
 *   - invalid flag values must come back as the documented INVALID_ARGS
 *     envelope, through the real entrypoint's error routing.
 *
 * `dist/cli.mjs` is a build artifact: when missing (fresh checkout, CI's test
 * step runs before its build step) the suite builds it once in `beforeAll`
 * via the project's own `vp run build`. An existing bundle is reused as-is.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorktreeId } from "./anchor.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Assembled with `join` (not a URL literal) so static analysis doesn't treat
// the not-yet-built artifact as an unresolved import — same trick as the
// real-binary smoke.
const CLI = join(REPO_ROOT, "dist", "cli.mjs");
const STUB = join(REPO_ROOT, "test", "stub-process-compose.mjs");

// UDS path budget (~104B on macOS) — see src/e2e.test.ts for the rationale.
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

/**
 * Env var the PATH shim understands: when set to `1`, `process list` reports
 * an empty service set, so health waits can never converge. This is how the
 * `--wait-timeout` scenario distinguishes "the flag reached the poller"
 * (HEALTH_TIMEOUT after ~1s) from "the flag was dropped" (120s default).
 */
const NEVER_READY = "DEVTREES_STUB_NEVER_READY";

let shimDir = "";

beforeAll(() => {
  if (!existsSync(CLI)) {
    execFileSync("vp", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe", timeout: 180_000 });
  }
  shimDir = mkdtempSync(join(SHORT_TMP, "dt-shim-"));
  const shim = join(shimDir, "process-compose");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `# devtrees test shim: the built CLI resolves \`process-compose\` from PATH.`,
      `if [ "\${${NEVER_READY}:-}" = "1" ] && [ "$1" = "process" ] && [ "$2" = "list" ]; then`,
      "  printf '[]'",
      "  exit 0",
      "fi",
      `exec "${process.execPath}" "${STUB}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
}, 240_000);

afterAll(() => {
  if (shimDir !== "") rmSync(shimDir, { recursive: true, force: true });
});

// LIFO cleanups, awaited to completion before vitest reports the test done —
// a worktree's `down` must run before the tmp dir housing its socket is
// unlinked (#41).
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()?.();
    } catch {
      // best-effort; one failure must not block the next cleanup
    }
  }
});

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed stdout when `--json` was passed and stdout is one JSON document. */
  readonly doc?: unknown;
}

/** Spawn the built CLI with the shim directory prepended to PATH. */
function devtrees(
  cwd: string,
  args: ReadonlyArray<string>,
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): CliResult {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}`, ...opts.env },
  });
  let doc: unknown;
  if (args.includes("--json")) {
    try {
      doc = JSON.parse(out.stdout);
    } catch {
      doc = undefined; // multi-line output (NDJSON) or non-JSON failure mode
    }
  }
  return { code: out.status ?? -1, stdout: out.stdout, stderr: out.stderr, doc };
}

/**
 * Fresh tmp git repo with one `login` worktree carrying a two-tier stack
 * (shared `db` + isolated `web`, both long-running noops). Registers rm +
 * `down`/`down --shared` cleanups, and returns the derived worktree id and
 * control-socket path so scenarios can assert against runtime state on disk.
 */
function setupScenario(prefix: string): { wt: string; id: string; sock: string } {
  const root = mkdtempSync(join(SHORT_TMP, prefix));
  const seed = join(root, "main");
  mkdirSync(seed, { recursive: true });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(seed, "init", "-q");
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "README.md"), "x");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  const wt = join(root, "login");
  git(seed, "worktree", "add", "-q", wt, "-b", "login");
  writeFileSync(
    join(wt, "devtrees.yaml"),
    [
      "services:",
      "  db:",
      "    tier: shared",
      '    command: "sleep 300"',
      "    ports: [DB_PORT]",
      "  web:",
      "    tier: isolated",
      '    command: "sleep 300"',
      "    ports: [WEB_PORT]",
      "",
    ].join("\n"),
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => devtrees(wt, ["down", "--shared"]));
  cleanups.push(() => devtrees(wt, ["down"]));

  const id = deriveWorktreeId(git(wt, "rev-parse", "--show-toplevel"));
  const common = git(wt, "rev-parse", "--git-common-dir");
  const absCommon = common.startsWith("/") ? common : join(wt, common);
  return { wt, id, sock: join(absCommon, "devtrees", "run", `${id}.sock`) };
}

interface UpDoc {
  readonly schema_version: string;
  readonly up: {
    readonly worktree_id: string;
    readonly env: Record<string, string>;
    readonly shared_started: boolean;
    readonly block_base: number;
  };
}

interface LsDoc {
  readonly ls: {
    readonly instances: Array<{
      readonly id: string;
      readonly kind: string;
      readonly services: Array<{
        readonly name: string;
        readonly health: string;
        readonly ports: Record<string, number>;
      }>;
    }>;
  };
}

interface ErrorDoc {
  readonly error?: { readonly code?: string; readonly message?: string };
}

describe("built CLI e2e — argv→commands wiring over the stub process-compose (#93)", () => {
  it("up → ls → env → down --json round-trip through dist/cli.mjs", () => {
    const { wt, id, sock } = setupScenario("dt-bc1-");

    const up = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(up.code, `up failed: stderr=${up.stderr} stdout=${up.stdout}`).toBe(0);
    const upDoc = up.doc as UpDoc;
    expect(upDoc.schema_version).toBe("1");
    expect(id).toMatch(/^login-[0-9a-f]{8}$/);
    expect(upDoc.up.worktree_id).toBe(id);
    expect(upDoc.up.shared_started).toBe(true);
    expect(upDoc.up.env.DEVTREES_WORKTREE_ID).toBe(id);
    const webPort = Number(upDoc.up.env.WEB_PORT);
    const dbPort = Number(upDoc.up.env.DB_PORT);
    expect(webPort).toBeGreaterThan(0);
    expect(dbPort).toBeGreaterThan(0);
    // The instance is really up: its control socket exists on disk.
    expect(existsSync(sock)).toBe(true);

    // ls --json sees the instance, with per-service health from the stub.
    const ls = devtrees(wt, ["ls", "--json"]);
    expect(ls.code, `ls failed: ${ls.stderr}`).toBe(0);
    const inst = (ls.doc as LsDoc).ls.instances.find((i) => i.id === id);
    expect(inst).toBeDefined();
    const web = inst?.services.find((s) => s.name === "web");
    expect(web?.health).toBe("ready");
    expect(web?.ports.WEB_PORT).toBe(webPort);

    // env --json round-trips the exact allocation `up` reported.
    const env = devtrees(wt, ["env", "--json"]);
    expect(env.code, `env failed: ${env.stderr}`).toBe(0);
    expect((env.doc as { env: Record<string, string> }).env).toEqual(upDoc.up.env);

    // Without --json the same command emits KEY=value lines, not an envelope.
    const human = devtrees(wt, ["env"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`WEB_PORT=${webPort}`);
    expect(human.stdout.startsWith("{")).toBe(false);

    // down --json: documented operation-output-only envelope; socket reaped.
    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code, `down failed: ${down.stderr}`).toBe(0);
    expect(down.doc).toEqual({ schema_version: "1", down: { worktreeId: id, stopped: true } });
    expect(existsSync(sock)).toBe(false);

    const downShared = devtrees(wt, ["down", "--shared", "--json"]);
    expect(downShared.code, `down --shared failed: ${downShared.stderr}`).toBe(0);
    expect(downShared.doc).toEqual({
      schema_version: "1",
      down: { shared: true, stopped: true },
    });
  }, 60_000);

  it("--wait-timeout reaches the health gate: never-ready stub times out at 1s, not 120s", () => {
    const { wt } = setupScenario("dt-bc2-");

    const started = Date.now();
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "1"], {
      env: { [NEVER_READY]: "1" },
      timeoutMs: 60_000,
    });
    const elapsed = Date.now() - started;

    expect(r.code, `expected HEALTH_TIMEOUT failure, got: ${r.stdout} ${r.stderr}`).toBe(1);
    const doc = r.doc as ErrorDoc;
    expect(doc.error?.code).toBe("HEALTH_TIMEOUT");
    // The seconds→ms coercion must survive into the poller's deadline. If the
    // deps adapter dropped waitTimeoutMs, the 120s default would apply and
    // both assertions below would fail.
    expect(doc.error?.message).toContain("after 1000ms");
    expect(elapsed).toBeLessThan(30_000);
  }, 90_000);

  it("logs --tail N reaches the driver argv (stub trims to the last N lines)", () => {
    const { wt, sock } = setupScenario("dt-bc3-");

    const up = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(up.code, `up failed: ${up.stderr}`).toBe(0);
    // Seed the stub's canned log fixture for the `web` service.
    writeFileSync(`${sock}.web.log`, ["one", "two", "three", "four", "five"].join("\n"));

    const json = devtrees(wt, ["logs", "web", "--tail", "2", "--json"]);
    expect(json.code, `logs --json failed: ${json.stderr}`).toBe(0);
    const events = json.stdout
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { service: string; line: string });
    expect(events.map((e) => e.line)).toEqual(["four", "five"]);
    expect(events.every((e) => e.service === "web")).toBe(true);

    // Human mode: the same tail as raw lines, no NDJSON wrapping.
    const human = devtrees(wt, ["logs", "web", "--tail", "2"]);
    expect(human.code, `logs failed: ${human.stderr}`).toBe(0);
    expect(human.stdout).toBe("four\nfive\n");
  }, 60_000);

  it("invalid flag values come back as the documented INVALID_ARGS envelope", () => {
    const dir = mkdtempSync(join(SHORT_TMP, "dt-bc4-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const cases: ReadonlyArray<{ args: string[]; needle: string }> = [
      { args: ["up", "--json", "--wait-timeout", "0"], needle: "--wait-timeout" },
      { args: ["logs", "web", "--json", "--tail", "2.5"], needle: "--tail" },
      { args: ["logs", "web", "--json", "--since", "banana"], needle: "--since" },
      // No service and no --all: the in-band INVALID_ARGS path.
      { args: ["logs", "--json"], needle: "--all" },
    ];
    for (const c of cases) {
      const r = devtrees(dir, c.args);
      const label = `devtrees ${c.args.join(" ")}`;
      expect(r.code, label).toBe(1);
      const doc = r.doc as ErrorDoc;
      expect(doc.error?.code, label).toBe("INVALID_ARGS");
      expect(doc.error?.message, label).toContain(c.needle);
    }
  }, 30_000);
});
