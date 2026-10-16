/**
 * Real-binary smoke test for the canonical agent surface (issue #60).
 *
 * Complements (does not replace) the stub-based `e2e.test.ts`: drives the
 * built devtrees CLI (`dist/cli.mjs`) against the real `process-compose`
 * binary so behaviour only the real binary exhibits — probe convergence,
 * OS port binding, hot-reload, real EADDRINUSE — is exercised in CI.
 *
 * Gating:
 *   - Skipped entirely unless `DEVTREES_REAL_PC_E2E=1` AND `process-compose`
 *     is on PATH. Local `vp test run` is unaffected; CI flips the env var
 *     in `.github/workflows/smoke-real-pc.yml`.
 *
 * Hermeticity:
 *   - Every scenario builds a fresh tmp repo + worktrees, writes its own
 *     `devtrees.yaml`, and reaps every process it spawned in `afterEach`.
 *     Each scenario uses a uniquely-prefixed tmp dir so the PID assertion
 *     can match descendants by argv substring without false positives from
 *     parallel test runs.
 *
 * Fixtures:
 *   - JSON envelopes under `test/fixtures/agent-surface/` are matched with
 *     a `normaliseEnvelope` pass that zeroes allocation-dependent fields
 *     (ports, block_base, worktree_id) so the goldens are stable across
 *     runs and OSs. To regenerate after an intentional envelope change,
 *     read README "Smoke testing against real process-compose".
 */
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorktreeId } from "./anchor.js";
import { instancePaths, sharedInstancePaths } from "./paths.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readPendingReload } from "./reload-pending.js";

// ---------------------------------------------------------------------------
// Gating: skip the whole file unless the env var is set AND the binary works.
// ---------------------------------------------------------------------------
const ENABLED = process.env.DEVTREES_REAL_PC_E2E === "1" && hasProcessCompose();
const SKIP_REASON = !ENABLED
  ? `[real-pc.smoke] skipped: set DEVTREES_REAL_PC_E2E=1 and install process-compose to run`
  : "";

function hasProcessCompose(): boolean {
  const out = spawnSync("process-compose", ["version"], { stdio: "ignore" });
  return out.status === 0;
}

/**
 * Env var naming a pre-installed `devtrees@0.4.0` `dist/cli.mjs`, for
 * scenario 133. The smoke workflow installs it in a setup step, with retries
 * and a cache, so the test itself never depends on the npm registry in CI.
 */
const LEGACY_CLI_ENV = "DEVTREES_LEGACY_CLI";
const LEGACY_INSTALL_DELAYS_MS = [0, 2_000, 8_000];

/**
 * The published devtrees@0.4.0 CLI for scenario 133. `DEVTREES_LEGACY_CLI`
 * wins (it must exist). Otherwise it is installed from npm into a throwaway
 * dir, `--prefer-offline` and retried. When every attempt fails, it throws in
 * CI (`CI` set): a scenario that cannot run must not pass. Locally it warns
 * on stderr and returns the note the caller skips with.
 */
async function legacyCli040(): Promise<string | { readonly skipped: string }> {
  const preset = process.env[LEGACY_CLI_ENV] ?? "";
  if (preset !== "") {
    if (!existsSync(preset)) throw new Error(`${LEGACY_CLI_ENV}=${preset} does not exist`);
    return preset;
  }
  const installed = await installLegacyCli();
  if (installed.cli !== undefined) return installed.cli;
  const why =
    `could not install devtrees@0.4.0 from npm after ${LEGACY_INSTALL_DELAYS_MS.length} ` +
    `attempts: ${installed.error.trim()}`;
  if ((process.env.CI ?? "") !== "") {
    throw new Error(`[real-pc.smoke] scenario 133 ${why} (set ${LEGACY_CLI_ENV} to skip npm)`);
  }
  // Loud: on stderr now, and as the skip's note in the reporter.
  process.stderr.write(`\n[real-pc.smoke] SKIPPING scenario 133: ${why}\n`);
  return { skipped: `SKIPPED: ${why}` };
}

/** `npm install devtrees@0.4.0` into a throwaway dir, retried; the CLI path, or the last error. */
async function installLegacyCli(): Promise<
  | { readonly cli: string; readonly error?: never }
  | { readonly cli?: never; readonly error: string }
> {
  const dir = mkdtempSync(join(TMP_BASE, "dt-rpc133-legacy-"));
  cleanupStack.push(() => rmSync(dir, { recursive: true, force: true }));
  const args = ["install", "--loglevel=error", "--no-save", "--no-audit", "--no-fund"];
  let error = "";
  for (const delay of LEGACY_INSTALL_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      execFileSync("npm", [...args, "--prefer-offline", "--prefix", dir, "devtrees@0.4.0"], {
        stdio: "pipe",
        timeout: 120_000,
      });
      return { cli: join(dir, "node_modules", "devtrees", "dist", "cli.mjs") };
    } catch (err) {
      error = (err as { stderr?: Buffer | string }).stderr?.toString() ?? (err as Error).message;
    }
  }
  return { error };
}

// `dist/cli.mjs` is a build artifact, not a source module — we spawn it as
// a subprocess, never import it. The path is assembled with `join` (not a
// URL literal) so static analysis (e.g. fallow's unresolved-import check)
// does not treat the not-yet-built file at audit time as a regression.
const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.mjs");

// UDS budget (~104B macOS) — see src/e2e.test.ts for the full rationale.
const TMP_BASE = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

function execGit(cwd: string, argv: ReadonlyArray<string>): string {
  return execFileSync("git", argv, { cwd, encoding: "utf8" }).trim();
}

interface SmokeRepo {
  readonly root: string;
  readonly worktrees: Readonly<Record<string, string>>;
}

/**
 * Smoke-suite-specific tmp repo: init `main/`, seed it, then add the given
 * worktrees by branch. Each worktree dir is keyed by name in `.worktrees`.
 *
 * Stays inline rather than shared with `src/e2e.test.ts` so the line-offset
 * baseline fallow tracks against `main` stays stable when this file lands.
 */
function buildSmokeRepo(prefix: string, branches: ReadonlyArray<string>): SmokeRepo {
  const root = mkdtempSync(join(TMP_BASE, prefix));
  const seed = join(root, "main");
  mkdirSync(seed, { recursive: true });
  for (const cmd of [
    ["init", "-q"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
  ]) {
    execGit(seed, cmd);
  }
  writeFileSync(join(seed, "README.md"), "x");
  execGit(seed, ["add", "."]);
  execGit(seed, ["commit", "-qm", "init"]);
  const wts: Record<string, string> = {};
  for (const branch of branches) {
    const dest = join(root, branch);
    execGit(seed, ["worktree", "add", "-q", dest, "-b", branch]);
    wts[branch] = dest;
  }
  return { root, worktrees: wts };
}
const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/agent-surface/", import.meta.url));

/**
 * Minimal stack: one `isolated` web service + one `shared` db service. Mirrors
 * the `devtrees-example` shape but inlined here so the test is hermetic —
 * matches issue #60's "synthesised tmp fixture" decision.
 */
function writeMinimalStack(worktreeRoot: string, opts: { withProbe?: boolean } = {}): void {
  const webProbe = opts.withProbe
    ? [
        "    readiness_probe:",
        "      exec:",
        '        command: "echo ok"',
        "      initial_delay_seconds: 0",
        "      period_seconds: 1",
        "      timeout_seconds: 1",
        "      success_threshold: 1",
      ].join("\n")
    : "";

  const yaml = [
    "services:",
    "  db:",
    "    tier: shared",
    // Long-running noop so process-compose keeps the process Running.
    '    command: "sleep 300"',
    "    ports: [DB_PORT]",
    "  web:",
    "    tier: isolated",
    '    command: "sleep 300"',
    "    ports: [WEB_PORT]",
    ...(opts.withProbe ? [webProbe] : []),
    "",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "devtrees.yaml"), yaml);
}

/**
 * A stack whose **shared** service is a daemon-launch process (#134): its
 * `command` writes a marker and returns, `is_daemon: true` tells
 * process-compose the launch is the readiness boundary, and `shutdown.command`
 * writes a second marker so the test can prove the teardown hook fired on
 * `down --shared`. The marker paths are passed in so the caller can assert on
 * them after teardown.
 */
function writeShutdownHookStack(
  worktreeRoot: string,
  markers: { readonly up: string; readonly down: string },
): void {
  const yaml = [
    "services:",
    "  daemon:",
    "    tier: shared",
    // Launches "work" (here just a marker) and returns immediately.
    `    command: "touch ${markers.up}"`,
    "    is_daemon: true",
    "    launch_timeout_seconds: 30",
    "    shutdown:",
    `      command: "touch ${markers.down}"`,
    "      timeout_seconds: 10",
    "",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "devtrees.yaml"), yaml);
}

/**
 * A stack whose **isolated** `web` service declares a per-process `log_location`
 * (issue #136) and emits a distinctive marker line on a tight loop, so the test
 * can prove process-compose wrote the log to disk at the templated per-instance
 * path and that an external process can tail it while the stack runs. The
 * authored value is a plain relative filename — devtrees roots it under
 * `<anchor>/devtrees/logs/<worktreeId>/`. High emit volume forces
 * process-compose to flush its log buffer within the test window.
 */
function writeLogLocationStack(worktreeRoot: string, opts: { marker: string }): void {
  const yaml = [
    "services:",
    "  web:",
    "    tier: isolated",
    // Emit the marker on a fast loop forever (the stack is `down`ed by cleanup).
    // The volume forces process-compose's log buffer to flush to disk promptly.
    `    command: "sh -c 'while true; do echo ${opts.marker}; done'"`,
    "    ports: [WEB_PORT]",
    "    log_location: web.log",
    "",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "devtrees.yaml"), yaml);
}

/**
 * A one-service isolated stack for the hot-reload scenarios. `web` tails a
 * per-scenario file (`hold`), so its argv names that file. The test can tell
 * the old and the new incarnation apart by PID needle and kill exactly one
 * of them. `shutdownCommand`, when set, is a `shutdown.command` that exits 0
 * without stopping the process.
 */
function writeReloadStack(
  worktreeRoot: string,
  opts: { readonly hold: string; readonly shutdownCommand?: string; readonly command?: string },
): void {
  writeFileSync(opts.hold, "");
  const yaml = [
    "services:",
    "  web:",
    "    tier: isolated",
    `    command: "${opts.command ?? `tail -f ${opts.hold}`}"`,
    "    ports: [WEB_PORT]",
    ...(opts.shutdownCommand ? ["    shutdown:", `      command: "${opts.shutdownCommand}"`] : []),
    "",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "devtrees.yaml"), yaml);
}

/** Poll until some live process's argv contains `needle`. */
async function waitForPid(needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsMatching(needle).length > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly doc?: unknown;
}

/** Invoke the built CLI from inside a worktree. Captures stdout/stderr. */
function devtrees(
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): CliResult {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    // Be defensive: cap wall time per CLI call so a hung process-compose
    // shows up as a test failure rather than a vitest timeout.
    timeout: 60_000,
  });
  let doc: unknown;
  if (args.includes("--json")) {
    try {
      doc = JSON.parse(out.stdout);
    } catch {
      doc = undefined;
    }
  }
  return {
    code: out.status ?? -1,
    stdout: out.stdout,
    stderr: out.stderr,
    doc,
  };
}

/**
 * Allocation-dependent fields zeroed out so fixtures are stable. The list is
 * explicit so a reviewer can see exactly what's normalised — adding a new
 * non-deterministic field is a conscious decision, not a silent drift.
 */
// `port` is a shared port map entry's number (`ls.shared_ports`, #238).
const NORMALISED_NUMBER_FIELDS = new Set(["WEB_PORT", "DB_PORT", "block_base", "port"]);

/** Rewrite an `env` map: port entries to `0`, worktree-id injection to `<WT>`. */
function normaliseEnv(env: Record<string, string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (NORMALISED_NUMBER_FIELDS.has(k)) out[k] = 0;
    else if (k === "DEVTREES_WORKTREE_ID") out[k] = "<WT>";
    else out[k] = v;
  }
  return out;
}

/** Zero every value in a `ports` map (we only care about which keys exist). */
function normalisePorts(ports: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(ports)) out[k] = 0;
  return out;
}

/** Sentinel returned by field handlers that decline to normalise a value. */
const PASS = Symbol("normalise-pass");
type FieldHandler = (value: unknown, worktreeId: string) => unknown;

function handleIdField(value: unknown, worktreeId: string): unknown {
  return value === worktreeId ? "<WT>" : PASS;
}

function handleEnvField(value: unknown): unknown {
  if (!value || typeof value !== "object") return PASS;
  return normaliseEnv(value as Record<string, string>);
}

function handlePortsField(value: unknown): unknown {
  if (!value || typeof value !== "object") return PASS;
  return normalisePorts(value as Record<string, number>);
}

const FIELD_HANDLERS: Readonly<Record<string, FieldHandler>> = {
  worktree_id: handleIdField,
  worktreeId: handleIdField,
  id: handleIdField,
  env: (v) => handleEnvField(v),
  ports: (v) => handlePortsField(v),
  block_base: () => 0,
  // A service's live pid (#226) — which one it is changes every run.
  pid: (v) => (typeof v === "number" ? 0 : PASS),
};

function normaliseField(key: string, value: unknown, worktreeId: string): unknown {
  const handler = FIELD_HANDLERS[key];
  if (handler !== undefined) return handler(value, worktreeId);
  if (typeof value === "number" && NORMALISED_NUMBER_FIELDS.has(key)) return 0;
  return PASS;
}

function normaliseEnvelope(value: unknown, worktreeId: string): unknown {
  if (Array.isArray(value)) return value.map((v) => normaliseEnvelope(v, worktreeId));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const handled = normaliseField(k, v, worktreeId);
    out[k] = handled === PASS ? normaliseEnvelope(v, worktreeId) : handled;
  }
  return out;
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

// ---------------------------------------------------------------------------
// PID tracking — every scenario records every process it spawned (by tmp-dir
// argv match) and asserts none survive teardown. This is the cleanup
// discipline the smoke test exists partly to enforce (#41, #58).
// ---------------------------------------------------------------------------

/**
 * Return every live PID whose argv contains `needle` (typically the
 * scenario's tmp-dir path). Used post-down to assert no process-compose
 * children leaked.
 */
function pidsMatching(needle: string): number[] {
  const out = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  if (out.status !== 0) return [];
  const pids: number[] = [];
  for (const line of out.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[2] ?? "";
    if (!Number.isFinite(pid)) continue;
    if (pid === process.pid) continue;
    if (args.includes(needle)) pids.push(pid);
  }
  return pids;
}

/** Wait up to `timeoutMs` for any matching PID to disappear. */
async function waitForNoPids(needle: string, timeoutMs = 5000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = pidsMatching(needle);
    if (live.length === 0) return [];
    await new Promise((r) => setTimeout(r, 100));
  }
  return pidsMatching(needle);
}

// ---------------------------------------------------------------------------
// Per-test cleanups. `afterEach` runs them in LIFO and asserts PID hygiene.
// ---------------------------------------------------------------------------
interface CleanupCtx {
  readonly pidNeedle: string;
  readonly root: string;
}

const cleanupStack: Array<() => unknown> = [];
let currentCtx: CleanupCtx | undefined;

async function drainCleanups(): Promise<void> {
  while (cleanupStack.length) {
    const fn = cleanupStack.pop();
    if (!fn) continue;
    try {
      await fn();
    } catch {
      // best-effort — never block subsequent cleanup
    }
  }
}

function reapPids(pids: ReadonlyArray<number>): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function rmRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// Cleanup runs `devtrees down` per scenario and waits for PIDs to exit; under
// heavy machine load that outlasts vitest's 10s default hook timeout.
const CLEANUP_HOOK_TIMEOUT_MS = 30_000;

afterEach(async () => {
  await drainCleanups();
  const ctx = currentCtx;
  currentCtx = undefined;
  if (!ctx) return;
  const survivors = await waitForNoPids(ctx.pidNeedle);
  if (survivors.length > 0) reapPids(survivors);
  rmRoot(ctx.root);
  expect(
    survivors,
    `process-compose-spawned PIDs survived teardown: ${survivors.join(", ")}`,
  ).toEqual([]);
}, CLEANUP_HOOK_TIMEOUT_MS);

beforeAll(() => {
  if (!ENABLED) {
    // Print once so a CI log makes the skip obvious to a reader.
    // eslint-disable-next-line no-console
    console.log(SKIP_REASON);
  }
});

/**
 * A namespaced stack (#176): `api` in `local-backend` with a readiness probe,
 * plus — when `withDefault` — an un-namespaced `web` in the implicit
 * `default` namespace.
 */
function writeNamespacedStack(worktreeRoot: string, opts: { withDefault: boolean }): void {
  const yaml = [
    "services:",
    ...(opts.withDefault
      ? ["  web:", "    tier: isolated", '    command: "sleep 300"', "    ports: [WEB_PORT]"]
      : []),
    "  api:",
    "    tier: isolated",
    "    namespace: local-backend",
    '    command: "sleep 300"',
    "    ports: [API_PORT]",
    "    readiness_probe:",
    "      exec:",
    '        command: "echo ok"',
    "      initial_delay_seconds: 0",
    "      period_seconds: 1",
    "",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "devtrees.yaml"), yaml);
}

/**
 * Per-scenario tmp-repo + worktree builder. Wires up:
 *   - a fresh git repo with one worktree (`login` by default)
 *   - the minimal devtrees.yaml (optionally with a readiness_probe)
 *   - `currentCtx` for the `afterEach` PID-hygiene assertion
 *   - default cleanups that down --shared then down --worktree
 *
 * Keeps each scenario focused on the assertion that differentiates it from
 * its peers — fallow flagged scenarios 1-4 / 6 / 8 as a clone family otherwise.
 */
function setupScenario(
  prefix: string,
  opts: {
    readonly worktrees?: ReadonlyArray<string>;
    readonly withProbe?: boolean;
    /** Skip the default `down` cleanups (caller registers its own). */
    readonly noDefaultCleanups?: boolean;
  } = {},
): { wt: string; root: string; worktrees: Readonly<Record<string, string>> } {
  const names = opts.worktrees ?? ["login"];
  const repo = buildSmokeRepo(prefix, names);
  currentCtx = { pidNeedle: repo.root, root: repo.root };
  for (const name of names) writeMinimalStack(repo.worktrees[name]!, { withProbe: opts.withProbe });
  const wt = repo.worktrees[names[0]!]!;
  if (!opts.noDefaultCleanups) {
    cleanupStack.push(() => devtrees(wt, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(wt, ["down"]));
  }
  return { wt, root: repo.root, worktrees: repo.worktrees };
}

/** Wrap `devtrees up --json` so scenarios share the same wait-timeout choice. */
function up(wt: string): CliResult {
  return devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
}

/**
 * The id devtrees derives for a worktree (#82): slug of the basename plus a
 * path-hash suffix. Derived from the same `--show-toplevel` answer the anchor
 * resolver sees so the test and the binary agree byte-for-byte.
 */
function wtId(wt: string): string {
  return deriveWorktreeId(execGit(wt, ["rev-parse", "--show-toplevel"]));
}

interface UpDoc {
  readonly up: {
    readonly block_base: number;
    readonly env: Record<string, string>;
    readonly shared_started: boolean;
    readonly services: ReadonlyArray<{
      readonly name: string;
      readonly ports: Readonly<Record<string, number>>;
    }>;
  };
}

interface LsServiceRow {
  readonly name: string;
  readonly status: string;
  readonly health: string;
  readonly ports: Readonly<Record<string, number>>;
}

interface LsDoc {
  readonly ls: {
    readonly instances: Array<{
      readonly id: string;
      readonly services: ReadonlyArray<LsServiceRow>;
    }>;
  };
}

/**
 * Write `<root>/<name>.py`, a long-running process whose argv carries the
 * scenario root (so `pidsMatching` finds exactly it), and return its path.
 * With `exitIf`, it exits 4 at start whenever that file exists, so a
 * restarted run dies straight away.
 */
function sleeper(root: string, name: string, exitIf?: string): string {
  const path = join(root, `${name}.py`);
  const guard =
    exitIf === undefined ? "" : `if os.path.exists(${JSON.stringify(exitIf)}):\n    sys.exit(4)\n`;
  writeFileSync(path, `import os, sys, time\n${guard}time.sleep(300)\n`);
  return path;
}

/** `devtrees(...)`, but asynchronous: resolves once the CLI exits. */
function devtreesAsync(cwd: string, args: ReadonlyArray<string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("exit", (code) => {
      let doc: unknown;
      try {
        doc = JSON.parse(stdout);
      } catch {
        doc = undefined;
      }
      resolve({ code: code ?? -1, stdout, stderr, doc });
    });
  });
}

/**
 * Service processes under `root` that were reparented to PID 1: orphans no
 * supervisor will stop. process-compose itself is excluded — devtrees starts
 * it detached, so its parent is always 1.
 */
function orphanedServices(root: string): string[] {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
  return out.stdout
    .split("\n")
    .filter((line) => line.includes(root) && !line.includes("process-compose"))
    .filter((line) => line.trim().split(/\s+/)[1] === "1");
}

/**
 * HTTP status of `GET http://127.0.0.1:<port>/`, or 0 when nothing answers.
 */
async function httpStatus(port: number): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * `httpStatus`, retried until it is 200 or `timeoutMs` passes; returns the
 * last status. For a check right after a readiness wait, where one GET on a
 * loaded runner can miss (a 3s timeout, a refused connect) though the server
 * is serving.
 */
async function httpStatusWithin(port: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let status = await httpStatus(port);
  while (status !== 200 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    status = await httpStatus(port);
  }
  return status;
}

/**
 * Poll `ls --json` until a given service row reports `health: "ready"`, or
 * until `timeoutMs` elapses. Returns the last-observed row (possibly
 * `undefined` if the instance never appeared) so the caller can assert.
 */
async function pollWorktreeService(
  wt: string,
  worktreeId: string,
  service: string,
  timeoutMs: number,
): Promise<LsServiceRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: LsServiceRow | undefined;
  while (Date.now() < deadline) {
    const ls = devtrees(wt, ["ls", "--json"]);
    const doc = ls.doc as LsDoc | undefined;
    last = doc?.ls.instances
      .find((i) => i.id === worktreeId)
      ?.services.find((s) => s.name === service);
    if (last?.health === "ready") return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

// ---------------------------------------------------------------------------
// Scenarios.
//
// We use `describe.skipIf(!ENABLED)` so the file is parsed (and types are
// checked) on every `vp test run`, but no scenario fires unless gated in.
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)("real-pc smoke — canonical agent surface", () => {
  // -- Scenarios 1-4, 6, 7: single-worktree happy paths. ------------------
  it("scenario 1: up --json starts shared + worktree, envelope matches golden", async () => {
    const { wt } = setupScenario("dt-rpc1-");

    const r = up(wt);
    expect(r.code, `up failed: stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(r.doc).toBeDefined();
    expect(normaliseEnvelope(r.doc, wtId(wt))).toEqual(readFixture("01-up-first.json"));

    // Real-binary assertion: the worktree socket exists on disk.
    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const absCommon = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    expect(existsSync(instancePaths(absCommon, wtId(wt)).socketPath)).toBe(true);
  }, 90_000);

  it("scenario 2: re-up is idempotent — shared_started:false, same block_base", async () => {
    const { wt } = setupScenario("dt-rpc2-");

    const first = up(wt);
    expect(first.code).toBe(0);
    const second = up(wt);
    expect(second.code).toBe(0);

    expect(normaliseEnvelope(second.doc, wtId(wt))).toEqual(readFixture("02-up-idempotent.json"));

    // Stability: block_base and named ports unchanged across the re-up.
    const firstDoc = first.doc as UpDoc;
    const secondDoc = second.doc as UpDoc;
    expect(secondDoc.up.block_base).toBe(firstDoc.up.block_base);
    expect(secondDoc.up.env.WEB_PORT).toBe(firstDoc.up.env.WEB_PORT);
  }, 90_000);

  it("scenario 3: down --shared then up preserves the __shared__ block (#51)", async () => {
    const { wt } = setupScenario("dt-rpc3-");

    const first = up(wt);
    expect(first.code).toBe(0);
    const firstEnv = (first.doc as UpDoc).up.env;

    const downShared = devtrees(wt, ["down", "--shared", "--json"]);
    expect(downShared.code).toBe(0);
    expect(downShared.doc).toEqual({
      schema_version: "1",
      down: { shared: true, stopped: true, force_killed: [] },
    });

    const second = up(wt);
    expect(second.code).toBe(0);
    // #51 regression: DB_PORT (the shared port) is preserved across the cycle.
    expect((second.doc as UpDoc).up.env.DB_PORT).toBe(firstEnv.DB_PORT);
  }, 120_000);

  it("scenario 4: up → down --shared → up reports shared_started:true on the second up (#56)", async () => {
    const { wt } = setupScenario("dt-rpc4-");

    const first = up(wt);
    expect(first.code).toBe(0);
    expect((first.doc as UpDoc).up.shared_started).toBe(true);

    expect(devtrees(wt, ["down", "--shared", "--json"]).code).toBe(0);

    const second = up(wt);
    expect(second.code).toBe(0);
    // #56 regression: shared is lazy-restarted on the next `up`.
    expect((second.doc as UpDoc).up.shared_started).toBe(true);
  }, 120_000);

  it("scenario 5: readiness_probe converges and ls --json reports health:ready (#50); envelope matches golden, ports agree with up (#110)", async () => {
    const { wt } = setupScenario("dt-rpc5-", { withProbe: true });
    const r = up(wt);
    expect(r.code, `up failed: stderr=${r.stderr}`).toBe(0);

    // Poll ls --json until the worktree row reports ready (probes need
    // multiple seconds to converge in the real binary).
    const web = await pollWorktreeService(wt, wtId(wt), "web", 30_000);
    expect(web?.health).toBe("ready");

    // #110: the whole ls envelope is golden — each services[] row carries
    // only the ports that service declares (db has DB_PORT, web has
    // WEB_PORT), never the full cross-tier injection map.
    const ls = devtrees(wt, ["ls", "--json"]);
    expect(ls.code).toBe(0);
    expect(normaliseEnvelope(ls.doc, wtId(wt))).toEqual(readFixture("05-ls-ready.json"));

    // #110 agreement: for the same running instance, ls reports the exact
    // per-service ports up reported (unnormalised — real port numbers).
    const upServices = (r.doc as UpDoc).up.services;
    expect(upServices.length).toBeGreaterThan(0);
    const lsWorktree = (ls.doc as LsDoc).ls.instances.find((i) => i.id === wtId(wt));
    for (const svc of upServices) {
      const row = lsWorktree?.services.find((s) => s.name === svc.name);
      expect(row?.ports, `ls ports for service ${svc.name}`).toEqual(svc.ports);
    }
  }, 90_000);

  it("scenario 6a: down --json (worktree) envelope is operation-output-only (#48)", async () => {
    const { wt } = setupScenario("dt-rpc6a-", { noDefaultCleanups: true });
    cleanupStack.push(() => devtrees(wt, ["down", "--shared"]));

    expect(up(wt).code).toBe(0);

    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code).toBe(0);
    expect(normaliseEnvelope(down.doc, wtId(wt))).toEqual(readFixture("06-down-worktree.json"));
  }, 90_000);

  it("scenario 6b: down --shared --json envelope (#48)", async () => {
    const { wt } = setupScenario("dt-rpc6b-", { noDefaultCleanups: true });
    cleanupStack.push(() => devtrees(wt, ["down"]));

    expect(up(wt).code).toBe(0);

    const down = devtrees(wt, ["down", "--shared", "--json"]);
    expect(down.code).toBe(0);
    expect(down.doc).toEqual(readFixture("06-down-shared.json"));
  }, 90_000);

  it("scenario 6c: down --json with nothing running is an idempotent no-op (#92)", async () => {
    // No `up` here — `down` on a clean repo used to surface the raw
    // "process-compose down exited with code N" as UNKNOWN with exit 1.
    const { wt } = setupScenario("dt-rpc6c-", { noDefaultCleanups: true });
    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code).toBe(0);
    expect(normaliseEnvelope(down.doc, wtId(wt))).toEqual({
      schema_version: "1",
      down: { worktreeId: "<WT>", stopped: false, force_killed: [] },
    });
  }, 90_000);

  it("scenario 7: prune --json with no orphans returns an empty list", async () => {
    // No `up` here — prune over a clean repo, no default down cleanups.
    const { wt } = setupScenario("dt-rpc7-", { noDefaultCleanups: true });
    const prune = devtrees(wt, ["prune", "--json"]);
    expect(prune.code).toBe(0);
    expect(prune.doc).toEqual(readFixture("07-prune-empty.json"));
  }, 30_000);

  it("scenario 8: two worktrees up concurrently get distinct isolated blocks + same shared", async () => {
    const { worktrees } = setupScenario("dt-rpc8-", {
      worktrees: ["alpha", "beta"],
      noDefaultCleanups: true,
    });
    const a = worktrees.alpha!;
    const b = worktrees.beta!;
    cleanupStack.push(() => devtrees(a, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(b, ["down"]));
    cleanupStack.push(() => devtrees(a, ["down"]));

    const upA = up(a);
    expect(upA.code, `alpha up failed: ${upA.stderr}`).toBe(0);
    const upB = up(b);
    expect(upB.code, `beta up failed: ${upB.stderr}`).toBe(0);

    const docA = upA.doc as UpDoc;
    const docB = upB.doc as UpDoc;

    // Distinct isolated blocks for distinct worktrees.
    expect(docA.up.block_base).not.toBe(docB.up.block_base);
    expect(docA.up.env.WEB_PORT).not.toBe(docB.up.env.WEB_PORT);
    // Same shared block — DB_PORT comes from the __shared__ key.
    expect(docA.up.env.DB_PORT).toBe(docB.up.env.DB_PORT);
  }, 120_000);

  it("scenario 9: STALE_PORT_BLOCK envelope when a port in the block is already bound (#58)", async () => {
    const { wt, root } = setupScenario("dt-rpc9-", { noDefaultCleanups: true });

    // First, allocate without spawning so we know which ports are in the
    // block. `up --dry-run` runs the full derivation pipeline and prints the
    // allocated env to stdout with no side effects (#124) — read the WEB_PORT
    // this worktree owns off the dry-run JSON envelope (#125).
    const dryRun = devtrees(wt, ["up", "--dry-run", "--json"]);
    expect(dryRun.code, `up --dry-run failed: ${dryRun.stderr}`).toBe(0);
    const dryDoc = dryRun.doc as { up_dry_run?: { env?: { WEB_PORT?: string } } } | undefined;
    const webPort = dryDoc?.up_dry_run?.env?.WEB_PORT;
    if (!webPort) {
      throw new Error(`could not find WEB_PORT in dry-run envelope: ${dryRun.stdout}`);
    }
    const port = Number(webPort);
    void root;

    // Bind that port externally so the up-time port-probe sees a stale holder.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", () => resolve());
    });
    cleanupStack.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        }),
    );
    cleanupStack.push(() => devtrees(wt, ["down", "--shared"]));

    const r = up(wt);
    expect(r.code).not.toBe(0);
    const doc = r.doc as { error?: { code?: string } } | undefined;
    expect(doc?.error?.code).toBe("STALE_PORT_BLOCK");
  }, 90_000);

  // Scenario 10 (the PID-hygiene assertion) runs as part of `afterEach` on
  // every scenario above. A dedicated test just exercises down's reaper one
  // more time so the report shows a green "no leaked PIDs after teardown".
  it("scenario 10: down reaps every process-compose-spawned PID", async () => {
    const { wt, root } = setupScenario("dt-rpc10-", { noDefaultCleanups: true });

    expect(up(wt).code).toBe(0);
    // Sanity: there ARE process-compose-spawned processes alive right now.
    expect(pidsMatching(root).length).toBeGreaterThan(0);

    expect(devtrees(wt, ["down", "--json"]).code).toBe(0);
    expect(devtrees(wt, ["down", "--shared", "--json"]).code).toBe(0);

    // The `afterEach` will assert no PIDs survive — but assert it here too
    // for an explicit, scenario-named signal in the report.
    const survivors = await waitForNoPids(root, 5000);
    expect(survivors).toEqual([]);
  }, 90_000);

  it("scenario 11: a shared service's shutdown.command runs on down --shared (#134)", async () => {
    // The strongest acceptance criterion for #134: prove against the real
    // binary that a declared `shutdown.command` actually fires on a graceful
    // `down`, so a daemon-launch service can clean up out-of-band resources
    // before SIGKILL. We assert via two marker files the service touches.
    const repo = buildSmokeRepo("dt-rpc11-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const upMarker = join(repo.root, "daemon-up.marker");
    const downMarker = join(repo.root, "daemon-down.marker");
    writeShutdownHookStack(wt, { up: upMarker, down: downMarker });
    cleanupStack.push(() => devtrees(wt, ["down"]));

    expect(up(wt).code, "up should start the shared daemon").toBe(0);
    // The daemon-launch command ran (touched its marker) and the shutdown hook
    // has NOT fired yet — the service is still up.
    expect(existsSync(upMarker), "daemon launch command should have run").toBe(true);
    expect(existsSync(downMarker), "shutdown hook must not fire before down").toBe(false);

    const down = devtrees(wt, ["down", "--shared", "--json"]);
    expect(down.code, `down --shared failed: ${down.stderr}`).toBe(0);

    // #134: process-compose runs `shutdown.command` first on a graceful down,
    // so the marker exists. Allow a brief settle for the hook + file write.
    const deadline = Date.now() + 10_000;
    while (!existsSync(downMarker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      existsSync(downMarker),
      "shutdown.command should have run on down --shared, touching its marker",
    ).toBe(true);
  }, 120_000);

  it("scenario 12: a service's log_location is written to disk at the per-instance path and is tail-able (#136)", async () => {
    // The strongest acceptance criterion for #136: prove against the real binary
    // that a declared `log_location` causes process-compose to persist the
    // process's logs to a file on disk at the templated per-instance path
    // (<anchor>/devtrees/logs/<worktreeId>/web.log), and that an external
    // process can tail that file while the stack runs.
    const repo = buildSmokeRepo("dt-rpc12-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const marker = "DEVTREES_LOG_MARKER_12";
    writeLogLocationStack(wt, { marker });
    cleanupStack.push(() => devtrees(wt, ["down"]));

    expect(up(wt).code, "up should start the worktree instance").toBe(0);

    // Templated per-instance path: the authored `web.log` is rooted under the
    // anchor's per-worktree logs dir, so the same filename in another worktree
    // would land elsewhere (no cross-worktree collision).
    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const absCommon = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    const logFile = join(absCommon, "devtrees", "logs", wtId(wt), "web.log");

    // Tail-ability: poll the file (as an external reader would) until the
    // marker shows up, proving process-compose wrote and flushed the log to
    // disk while the stack is still running.
    const deadline = Date.now() + 30_000;
    let contents = "";
    while (Date.now() < deadline) {
      if (existsSync(logFile)) {
        contents = readFileSync(logFile, "utf8");
        if (contents.includes(marker)) break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(existsSync(logFile), `log file should exist at ${logFile}`).toBe(true);
    expect(
      contents.includes(marker),
      `external tail of ${logFile} should observe the marker while the stack runs`,
    ).toBe(true);
  }, 120_000);

  it("scenario 13a: a bare fresh up starts only the default namespace; -n stays exact (#176)", () => {
    // Against the real binary: `-n default` (what a bare `up` now passes)
    // omits the `local-backend` service from the project entirely, and the
    // health wait does not hang on its excluded readiness probe.
    const repo = buildSmokeRepo("dt-rpc13-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeNamespacedStack(wt, { withDefault: true });
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const bare = up(wt);
    expect(bare.code, `bare up failed: ${bare.stderr}`).toBe(0);
    expect((bare.doc as UpDoc).up.services.map((s) => s.name)).toEqual(["web"]);
    expect(devtrees(wt, ["down"]).code).toBe(0);

    const scoped = devtrees(wt, ["up", "--json", "--wait-timeout", "30", "-n", "local-backend"]);
    expect(scoped.code, `up -n local-backend failed: ${scoped.stderr}`).toBe(0);
    expect((scoped.doc as UpDoc).up.services.map((s) => s.name)).toEqual(["api"]);
  }, 120_000);

  it("scenario 13b: a bare fresh up with no default services fails NO_SERVICES_SELECTED (#176)", () => {
    const repo = buildSmokeRepo("dt-rpc13b-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeNamespacedStack(wt, { withDefault: false });
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const bare = up(wt);
    expect(bare.code).not.toBe(0);
    const err = (bare.doc as { error?: { code?: string; details?: { namespaces?: string[] } } })
      .error;
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
    expect(err?.details?.namespaces).toEqual(["local-backend"]);
  }, 120_000);

  it("scenario 14: editing a service's command on a running instance hot-reloads it", async () => {
    const repo = buildSmokeRepo("dt-rpc14-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const [holdA, holdB] = [join(repo.root, "hold-a"), join(repo.root, "hold-b")];
    writeReloadStack(wt, { hold: holdA });
    cleanupStack.push(() => devtrees(wt, ["down"]));

    expect(up(wt).code).toBe(0);
    expect(await waitForPid(holdA, 10_000), "old command should be running").toBe(true);

    writeReloadStack(wt, { hold: holdB });
    const reload = up(wt);
    expect(reload.code, `drifted up should hot-reload: ${reload.stderr}`).toBe(0);
    expect(await waitForPid(holdB, 10_000), "new command should be running").toBe(true);
    expect(await waitForNoPids(holdA, 10_000), "old command should be stopped").toEqual([]);
  }, 120_000);

  it("scenario 15: a reload whose old process never stops is bounded to CONFIG_DRIFT, not a hang", async () => {
    // process-compose v1.122.0's `project update` waits for each changed
    // process's old incarnation to exit, and a `shutdown.command` that exits 0
    // without stopping the process never escalates to SIGKILL. `up` used to
    // block on that forever (and `down` with it).
    const repo = buildSmokeRepo("dt-rpc15-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const [holdA, holdB] = [join(repo.root, "hold-a"), join(repo.root, "hold-b")];
    writeReloadStack(wt, { hold: holdA, shutdownCommand: "echo bye" });
    // The scenario kills the old process by hand; tear down by killing
    // everything it spawned (scenario 60 covers `down` in this state).
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));

    expect(up(wt).code).toBe(0);
    expect(await waitForPid(holdA, 10_000), "old command should be running").toBe(true);

    writeReloadStack(wt, { hold: holdB, shutdownCommand: "echo bye" });
    const started = Date.now();
    const reload = up(wt);
    const elapsed = Date.now() - started;
    expect(reload.code, `drifted up should fail, not hang: ${reload.stderr}`).not.toBe(-1);
    expect(reload.code).not.toBe(0);
    const doc = reload.doc as
      | { error?: { code?: string; message?: string; details?: { reason?: string } } }
      | undefined;
    expect(doc?.error?.code).toBe("CONFIG_DRIFT");
    expect(doc?.error?.details?.reason).toBe("timeout");
    expect(doc?.error?.message).toMatch(/did not finish within/);
    expect(elapsed).toBeLessThan(50_000);

    // An immediate retry must not reload again (#191): process-compose would
    // start a second copy now and a third when the old process exits,
    // orphaning one. It refuses, naming the stuck service, and starts nothing.
    const retry = up(wt);
    expect(retry.code, `retry should be refused: ${retry.stderr}`).not.toBe(0);
    const retryErr = (
      retry.doc as
        | { error?: { code?: string; details?: { reason?: string; services?: string[] } } }
        | undefined
    )?.error;
    expect(retryErr?.code).toBe("CONFIG_DRIFT");
    expect(retryErr?.details?.reason).toBe("reload_pending");
    expect(retryErr?.details?.services).toEqual(["web"]);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(pidsMatching(holdA), "the old process is still the only copy").toHaveLength(1);
    expect(pidsMatching(holdB), "the refused retry started no new copy").toEqual([]);

    // The documented remediation: killing the old process lets process-compose
    // finish the pending update and start the new command.
    reapPids(pidsMatching(holdA));
    expect(await waitForPid(holdB, 15_000), "update should finish once the old process dies").toBe(
      true,
    );

    // ...and the documented final step, a further `up`, converges: it resyncs
    // the on-disk config and stored hash without starting a second copy.
    const resync = up(wt);
    expect(resync.code, `resync up should succeed: ${resync.stderr}`).toBe(0);
    expect(pidsMatching(holdB), "exactly one copy of the new command").toHaveLength(1);
  }, 120_000);

  it("scenario 16: re-up after one of two services is killed restarts it; its port answers again (#162, #178)", async () => {
    // #162's two-service shape: `keeper` keeps the instance alive after `toy`
    // is killed, so the re-up takes the already-running path. Before #177 it
    // printed `is up.` and exited 0 over the corpse; since #178 it restarts
    // the dead service and waits for it to be healthy.
    const repo = buildSmokeRepo("dt-rpc16-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  toy:",
        "    tier: isolated",
        "    namespace: test",
        // `--directory <root>` puts the scenario root in argv so the kill
        // below (and the PID-hygiene check) can find exactly this process.
        `    command: "python3 -m http.server $TOY_PORT --bind 127.0.0.1 --directory ${repo.root}"`,
        "    ports: [TOY_PORT]",
        "    readiness_probe:",
        "      exec:",
        `        command: "sh -c 'curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$TOY_PORT/'"`,
        "      initial_delay_seconds: 1",
        "      period_seconds: 1",
        "      timeout_seconds: 3",
        "      success_threshold: 1",
        "      failure_threshold: 30",
        "  keeper:",
        "    tier: isolated",
        "    namespace: test",
        `    command: "python3 ${sleeper(repo.root, "keeper")}"`,
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const first = devtrees(wt, ["up", "-n", "test", "--json", "--wait-timeout", "60"]);
    expect(first.code, `first up failed: ${first.stderr} ${first.stdout}`).toBe(0);
    const port = Number((first.doc as UpDoc).up.env.TOY_PORT);
    expect(await httpStatus(port)).toBe(200);

    // Match on the server's own argv, not the bare root: process-compose's
    // argv carries the root too (its `-f` config path), and killing it would
    // take the whole instance down — not #162's shape.
    const toyNeedle = `--directory ${repo.root}`;
    const keeperNeedle = join(repo.root, "keeper.py");
    const keeperPids = pidsMatching(keeperNeedle);
    expect(keeperPids.length, "keeper should be running").toBeGreaterThan(0);
    const toyPids = pidsMatching(toyNeedle);
    expect(toyPids.length, "toy should be running").toBeGreaterThan(0);
    reapPids(toyPids);
    expect(await waitForNoPids(toyNeedle, 5000)).toEqual([]);
    expect(await httpStatus(port)).toBe(0);

    const again = devtrees(wt, ["up", "-n", "test", "--json", "--wait-timeout", "60"]);
    expect(again.code, `re-up should restart toy: ${again.stderr} ${again.stdout}`).toBe(0);
    const doc = again.doc as UpDoc & { up: { restarted: string[] } };
    expect(doc.up.restarted).toEqual(["toy"]);
    expect(await httpStatus(port)).toBe(200);
    expect(pidsMatching(toyNeedle).length, "toy is running again").toBeGreaterThan(0);
    // Nothing was stopped: the surviving service is the same process.
    expect(pidsMatching(keeperNeedle)).toEqual(keeperPids);
  }, 180_000);

  it("scenario 17: up -n one, then up -n one -n two fails with NAMESPACE_NOT_RUNNING (#170, #177)", async () => {
    const repo = buildSmokeRepo("dt-rpc17-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  a:",
        "    tier: isolated",
        "    namespace: one",
        '    command: "sleep 300"',
        "  b:",
        "    tier: isolated",
        "    namespace: two",
        `    command: "python3 -m http.server $B_PORT --bind 127.0.0.1 --directory ${repo.root}"`,
        "    ports: [B_PORT]",
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const first = devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "30"]);
    expect(first.code, `first up failed: ${first.stderr} ${first.stdout}`).toBe(0);

    const widen = devtrees(wt, ["up", "-n", "one", "-n", "two", "--json", "--wait-timeout", "20"]);
    expect(widen.code).toBe(1);
    const err = (widen.doc as { error?: { code?: string; details?: unknown } }).error;
    expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err?.details).toMatchObject({
      namespaces: ["two"],
      services: ["b"],
      remedy: "devtrees down && devtrees up -n one -n two",
    });
    // Nothing was started: `b` never ran.
    expect(pidsMatching(`--directory ${repo.root}`)).toEqual([]);

    // A bare re-up reads the boot-time selection back and targets `one` only.
    const bare = devtrees(wt, ["up", "--json", "--wait-timeout", "20"]);
    expect(bare.code, `bare re-up failed: ${bare.stderr} ${bare.stdout}`).toBe(0);
    expect((bare.doc as UpDoc).up.services.map((s) => s.name)).toEqual(["a"]);
  }, 120_000);

  it("scenario 18: a failed one-shot is restarted by the re-up; an exit-0 one-shot is not (#178)", async () => {
    const repo = buildSmokeRepo("dt-rpc18-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const ran = join(repo.root, "flaky-ran");
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  keeper:",
        "    tier: isolated",
        `    command: "python3 ${sleeper(repo.root, "keeper")}"`,
        // Exits 0 once: a finished one-shot, never restarted.
        "  seed:",
        "    tier: isolated",
        '    command: "true"',
        // Fails on its first run, succeeds on its second.
        "  flaky:",
        "    tier: isolated",
        `    command: "sh -c 'test -f ${ran} || { touch ${ran}; exit 3; }'"`,
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"]));

    // The first up may pass (flaky read Running) or fail fast (flaky read
    // dead); either way the instance is left running with flaky dead.
    devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(existsSync(ran), "flaky should have run once").toBe(true);

    const again = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(again.code, `re-up should restart flaky: ${again.stderr} ${again.stdout}`).toBe(0);
    expect((again.doc as { up: { restarted: string[] } }).up.restarted).toEqual(["flaky"]);

    // Converged: both one-shots are done, nothing left to restart.
    const third = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(third.code, `third up: ${third.stderr} ${third.stdout}`).toBe(0);
    expect((third.doc as { up: { restarted: string[] } }).up.restarted).toEqual([]);
  }, 120_000);

  it("scenario 19: a restarted service that dies straight away fails fast with HEALTH_TIMEOUT (#178)", async () => {
    // The restarted run exits before any poll can read it running, so only
    // its new pid tells its corpse from the pre-restart one.
    const repo = buildSmokeRepo("dt-rpc19-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const armed = join(repo.root, "crash-armed");
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  keeper:",
        "    tier: isolated",
        `    command: "python3 ${sleeper(repo.root, "keeper")}"`,
        "  crasher:",
        "    tier: isolated",
        `    command: "python3 ${sleeper(repo.root, "crasher", armed)}"`,
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const first = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(first.code, `first up failed: ${first.stderr} ${first.stdout}`).toBe(0);

    writeFileSync(armed, "");
    const crasherNeedle = join(repo.root, "crasher.py");
    reapPids(pidsMatching(crasherNeedle));
    expect(await waitForNoPids(crasherNeedle, 5000)).toEqual([]);

    const started = Date.now();
    const again = devtrees(wt, ["up", "--json", "--wait-timeout", "60"]);
    const elapsed = Date.now() - started;
    expect(again.code, `re-up should fail: ${again.stdout}`).toBe(1);
    const err = (again.doc as { error?: { code?: string; message?: string; details?: unknown } })
      .error;
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("crasher (Completed, exit 4)");
    expect(err?.message).toContain("died again");
    expect(err?.details).toMatchObject({ dead_services: [{ name: "crasher", exit_code: 4 }] });
    // Fail-fast: the restarted corpse is not waited on for the full window.
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it("scenario 20: a down racing an up that restarts a dead service leaves no orphan (#178)", async () => {
    // `slowstop` ignores SIGTERM, so `down` holds the instance for ~3s before
    // process-compose SIGKILLs it. `up` starts first (victim is dead, so it
    // will restart it) and `down` follows. Whichever takes the lifecycle lock
    // first, no service process may outlive its supervisor, and `up` must not
    // report HEALTH_TIMEOUT on an instance that is gone.
    const repo = buildSmokeRepo("dt-rpc20-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const slowstop = join(repo.root, "slowstop.py");
    writeFileSync(
      slowstop,
      "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(300)\n",
    );
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  victim:",
        "    tier: isolated",
        `    command: "python3 ${sleeper(repo.root, "victim")}"`,
        "  slowstop:",
        "    tier: isolated",
        `    command: "python3 ${slowstop}"`,
        "    shutdown:",
        "      timeout_seconds: 3",
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const first = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(first.code, `first up failed: ${first.stderr} ${first.stdout}`).toBe(0);
    const victim = join(repo.root, "victim.py");
    reapPids(pidsMatching(victim));
    expect(await waitForNoPids(victim, 5000)).toEqual([]);

    const upRun = devtreesAsync(wt, ["up", "--json", "--wait-timeout", "30"]);
    await new Promise((r) => setTimeout(r, 600));
    const down = await devtreesAsync(wt, ["down"]);
    const again = await upRun;

    expect(down.code, `down failed: ${down.stderr}`).toBe(0);
    const code = (again.doc as { error?: { code?: string } } | undefined)?.error?.code;
    // Up either ran before/after down (exit 0), found the instance gone under
    // the lock or mid-health-wait (#205), or lost the lock race. HEALTH_TIMEOUT is
    // deliberately absent: a dead instance must never read as a slow one.
    expect([undefined, "INSTANCE_NOT_FOUND", "LOCK_CONTENTION"]).toContain(code);
    expect(orphanedServices(repo.root)).toEqual([]);
  }, 120_000);

  /**
   * #179's list-valued stack: `db` in [one, two], `api` (two) depends on `db`,
   * `web` (one) depends on `api`. Each command carries `<role> <root>` in its
   * argv so `pidsMatching` can tell exactly which services run.
   */
  function writeListNamespaceStack(wt: string, root: string): void {
    const cmd = (role: string) =>
      `    command: "python3 -c 'import time; time.sleep(300)' rpc179-${role} ${root}"`;
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  db:",
        "    namespace: [one, two]",
        cmd("db"),
        "  api:",
        "    namespace: two",
        cmd("api"),
        "    depends_on: [db]",
        "  web:",
        "    namespace: one",
        cmd("web"),
        "    depends_on: [api]",
        "",
      ].join("\n"),
    );
  }

  it("scenario 30: a list-valued namespace — up -n two starts db and api, not web (#179)", async () => {
    const repo = buildSmokeRepo("dt-rpc30-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeListNamespaceStack(wt, repo.root);
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const first = devtrees(wt, ["up", "-n", "two", "--json", "--wait-timeout", "30"]);
    expect(first.code, `up -n two failed: ${first.stderr} ${first.stdout}`).toBe(0);
    expect(pidsMatching(`rpc179-db ${repo.root}`).length).toBeGreaterThan(0);
    expect(pidsMatching(`rpc179-api ${repo.root}`).length).toBeGreaterThan(0);
    expect(pidsMatching(`rpc179-web ${repo.root}`)).toEqual([]);
    const ls = devtrees(wt, ["ls", "--json"]).doc as LsDoc;
    const names = ls.ls.instances.find((i) => i.id === wtId(wt))?.services.map((s) => s.name);
    expect(names?.sort()).toEqual(["api", "db"]);

    // A bare re-up targets `two` only: `one` is not counted as running even
    // though db (in [one, two]) is present, because web is absent.
    const bare = devtrees(wt, ["up", "--json", "--wait-timeout", "20"]);
    expect(bare.code, `bare re-up failed: ${bare.stderr} ${bare.stdout}`).toBe(0);
    expect((bare.doc as UpDoc).up.services.map((s) => s.name).sort()).toEqual(["api", "db"]);
    const one = devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "20"]);
    expect(one.code).toBe(1);
    const err = (one.doc as { error?: { code?: string; details?: unknown } }).error;
    expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err?.details).toMatchObject({ namespaces: ["one"], services: ["web"] });
  }, 120_000);

  it("scenario 31: up -n one warns about the dropped cross-namespace web -> api edge (#179)", async () => {
    const repo = buildSmokeRepo("dt-rpc31-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeListNamespaceStack(wt, repo.root);
    cleanupStack.push(() => devtrees(wt, ["down"]));
    const edge = { from: "web", to: "api", to_namespaces: ["two"] };

    const dry = devtrees(wt, ["up", "-n", "one", "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    expect(
      (dry.doc as { up_dry_run: { dropped_namespace_edges: unknown } }).up_dry_run
        .dropped_namespace_edges,
    ).toEqual([edge]);

    const up = devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "30"]);
    expect(up.code, `up -n one failed: ${up.stderr} ${up.stdout}`).toBe(0);
    expect(
      (up.doc as { up: { dropped_namespace_edges: unknown } }).up.dropped_namespace_edges,
    ).toEqual([edge]);
    expect(up.stderr).toContain("dropped cross-namespace depends_on 'web' -> 'api'");
    // process-compose really dropped the edge: web runs although api never started.
    expect(pidsMatching(`rpc179-web ${repo.root}`).length).toBeGreaterThan(0);
    expect(pidsMatching(`rpc179-api ${repo.root}`)).toEqual([]);
  }, 120_000);

  it("scenario 40: the first hot-reload after boot restarts only the edited service (#194)", async () => {
    // process-compose v1.122.0's `project update` CLI restarted every process
    // on the first update after boot, even an unchanged one: its JSON round
    // trip turns `vars.PC_REPLICA_NUM` from an int into a float64, and the
    // server's reflect.DeepEqual then sees every process as changed.
    const repo = buildSmokeRepo("dt-rpc40-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const [holdWeb, holdApiA, holdApiB] = ["hold-web", "hold-api-a", "hold-api-b"].map((n) =>
      join(repo.root, n),
    );
    for (const hold of [holdWeb, holdApiA, holdApiB]) writeFileSync(hold!, "");
    const writeStack = (apiHold: string): void =>
      writeFileSync(
        join(wt, "devtrees.yaml"),
        [
          "services:",
          "  web:",
          "    tier: isolated",
          `    command: "tail -f ${holdWeb}"`,
          "  api:",
          "    tier: isolated",
          `    command: "tail -f ${apiHold}"`,
          "",
        ].join("\n"),
      );
    writeStack(holdApiA!);
    cleanupStack.push(() => devtrees(wt, ["down"]));

    expect(up(wt).code).toBe(0);
    expect(await waitForPid(holdWeb!, 10_000), "web should be running").toBe(true);
    expect(await waitForPid(holdApiA!, 10_000), "api should be running").toBe(true);
    const webPids = pidsMatching(holdWeb!);

    writeStack(holdApiB!);
    const reload = up(wt);
    expect(reload.code, `drifted up should hot-reload: ${reload.stderr}`).toBe(0);
    expect(await waitForPid(holdApiB!, 10_000), "edited api should run its new command").toBe(true);
    expect(await waitForNoPids(holdApiA!, 10_000), "old api should be stopped").toEqual([]);
    // The unchanged service was not restarted: the same process still runs.
    expect(pidsMatching(holdWeb!)).toEqual(webPids);
  }, 120_000);

  // Issue #190: process-compose v1.122.0 never escalates to SIGKILL for these
  // two shapes, so its `down` (and `devtrees down`) used to block forever.
  // The base budget is shrunk to 3s through the test seam so each scenario
  // stays fast; `shutdown.timeout_seconds` still adds on top.
  const STOP_BUDGET_ENV = { DEVTREES_DOWN_BASE_TIMEOUT_MS: "3000" };

  /**
   * Bring up `web` (the stuck service, `webLines`) next to `api`, a service
   * that stops normally, then `down --json` and check the bounded stop:
   * within budget, only `web` force-killed, nothing left behind.
   */
  async function expectBoundedDown(prefix: string, webLines: (root: string) => string[]) {
    const repo = buildSmokeRepo(prefix, ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const api = sleeper(repo.root, "api");
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        ...webLines(repo.root),
        "  api:",
        "    tier: isolated",
        `    command: "python3 ${api}"`,
        "",
      ].join("\n"),
    );
    // If the bound regressed, `down` would hang: kill what we started.
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));

    expect(up(wt).code).toBe(0);
    const needle = join(repo.root, "web");
    expect(await waitForPid(needle, 10_000), "web should be running").toBe(true);
    expect(await waitForPid(api, 10_000), "api should be running").toBe(true);
    const webPids = pidsMatching(needle);
    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const absCommon = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    const socketPath = instancePaths(absCommon, wtId(wt)).socketPath;
    expect(existsSync(socketPath)).toBe(true);

    const started = Date.now();
    const down = devtrees(wt, ["down", "--json"], STOP_BUDGET_ENV);
    const elapsed = Date.now() - started;
    expect(down.code, `down should finish, not hang: ${down.stderr}`).toBe(0);
    const doc = down.doc as { down: { stopped: boolean; force_killed: unknown[] } };
    expect(doc.down.stopped).toBe(true);
    expect(doc.down.force_killed).toHaveLength(1);
    expect(doc.down.force_killed[0]).toMatchObject({ service: "web" });
    expect(webPids).toContain((doc.down.force_killed[0] as { pid: number }).pid);
    // Budget (3s + timeouts) plus the grace and process-compose's own work.
    expect(elapsed).toBeLessThan(30_000);
    expect(await waitForNoPids(repo.root, 10_000), "nothing should survive down").toEqual([]);
    expect(orphanedServices(repo.root)).toEqual([]);
    expect(existsSync(socketPath)).toBe(false);
  }

  it("scenario 50: a shutdown.command that does not stop its service no longer hangs down (#190)", async () => {
    await expectBoundedDown("dt-rpc50-", (root) => {
      const hold = join(root, "web");
      writeFileSync(hold, "");
      return [
        "  web:",
        "    tier: isolated",
        `    command: "tail -f ${hold}"`,
        "    shutdown:",
        '      command: "echo bye"',
        "      timeout_seconds: 1",
      ];
    });
  }, 120_000);

  it("scenario 51: a SIGTERM-ignoring service with no shutdown timeout no longer hangs down (#190)", async () => {
    await expectBoundedDown("dt-rpc51-", (root) => {
      const script = join(root, "web.py");
      writeFileSync(
        script,
        "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(300)\n",
      );
      return ["  web:", "    tier: isolated", `    command: "python3 ${script}"`];
    });
  }, 120_000);
});

// Issue #206: after a hot-reload times out (#188), process-compose no longer
// lists the changed service's old process, yet its `down` waits on it. The
// bounded `down` (#190) now force-kills that old run, which the
// pending-reload marker (#191) recorded, before it stops the instance, and
// waits for the pending update to start the new copy, so it finishes within
// budget and the new copy is stopped too.
describe.skipIf(!ENABLED)("real-pc smoke — down after a timed-out reload (#206)", () => {
  it("scenario 60: down force-kills the old process a timed-out reload left behind (#206)", async () => {
    const repo = buildSmokeRepo("dt-rpc60-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const [holdA, holdB] = [join(repo.root, "hold-a"), join(repo.root, "hold-b")];
    writeReloadStack(wt, { hold: holdA, shutdownCommand: "echo bye" });
    // If the escalation regressed, `down` would fail: kill what we started.
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));

    expect(up(wt).code).toBe(0);
    expect(await waitForPid(holdA, 10_000), "old command should be running").toBe(true);
    const oldPids = pidsMatching(holdA);

    // The #188 hang shape: the edited service's old process never stops.
    // The new command logs each start, so a copy started by the pending
    // update is seen even if it is gone again by the time we look.
    const starts = join(repo.root, "newstarts");
    writeReloadStack(wt, {
      hold: holdB,
      shutdownCommand: "echo bye",
      command: `sh -c 'echo started >> ${starts}; exec tail -f ${holdB}'`,
    });
    const reload = up(wt);
    const reloadErr = (
      reload.doc as { error?: { code?: string; details?: { reason?: string } } } | undefined
    )?.error;
    expect(reloadErr?.code, `drifted up should time out: ${reload.stderr}`).toBe("CONFIG_DRIFT");
    expect(reloadErr?.details?.reason).toBe("timeout");

    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const anchor = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    const marker = readPendingReload(anchor, wtId(wt));
    const oldRun = marker?.oldRuns.find((r) => r.name === "web");
    expect(oldRuns(marker), "the marker records the old run's identity").toEqual(["web"]);
    expect(oldPids).toContain(oldRun?.pid);
    expect(oldRun?.identity?.command).toContain(holdA);

    const started = Date.now();
    const down = devtrees(wt, ["down", "--json"], { DEVTREES_DOWN_BASE_TIMEOUT_MS: "3000" });
    const elapsed = Date.now() - started;
    expect(
      down.code,
      `down should finish, not fail DOWN_TIMEOUT: ${down.stdout}${down.stderr}`,
    ).toBe(0);
    const doc = down.doc as { down: { stopped: boolean; force_killed: unknown[] } };
    expect(doc.down.stopped).toBe(true);
    expect(doc.down.force_killed).toContainEqual({ service: "web", pid: oldRun?.pid });
    // Budget (3s) plus the grace and process-compose's own work.
    expect(elapsed).toBeLessThan(30_000);
    expect(await waitForNoPids(repo.root, 10_000), "nothing should survive down").toEqual([]);
    expect(orphanedServices(repo.root)).toEqual([]);
    // The old run is killed before the stop, and the stop waits for the
    // pending update to start the new copy, so `down` stops that copy too,
    // never leaving it behind with PPID 1.
    const startCount = existsSync(starts)
      ? readFileSync(starts, "utf8").split("\n").filter(Boolean).length
      : 0;
    expect(
      startCount,
      "the pending update started the new copy before the stop",
    ).toBeGreaterThanOrEqual(1);
    expect(pidsMatching(holdB), "no copy of the new command survives").toEqual([]);
    expect(
      orphanedServices(repo.root).filter((line) => line.includes(holdB)),
      "no PPID-1 copy of the new command",
    ).toEqual([]);
    expect(readPendingReload(anchor, wtId(wt)), "down clears the marker").toBeUndefined();
    expect(existsSync(instancePaths(anchor, wtId(wt)).socketPath)).toBe(false);
  }, 120_000);
});

describe.skipIf(!ENABLED)("real-pc smoke — up --dry-run on a running instance (#210)", () => {
  it("scenario 70: a bare up --dry-run on a running instance with no default services previews what the bare up does (#210)", () => {
    const repo = buildSmokeRepo("dt-rpc70-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeNamespacedStack(wt, { withDefault: false });
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const booted = devtrees(wt, ["up", "-n", "local-backend", "--json", "--wait-timeout", "30"]);
    expect(booted.code, `up -n local-backend failed: ${booted.stderr}`).toBe(0);

    // Before #210 this previewed a fresh start and failed NO_SERVICES_SELECTED.
    const dry = devtrees(wt, ["up", "--dry-run", "--json"]);
    expect(dry.code, `bare dry run failed: ${dry.stderr} ${dry.stdout}`).toBe(0);
    const preview = (dry.doc as { up_dry_run: Record<string, unknown> }).up_dry_run;
    expect(preview).toMatchObject({
      instance: "running",
      namespaces: ["local-backend"],
      selected_services: ["api"],
      would_reload: false,
      would_restart: [],
    });

    // The real bare `up` gives the same answer.
    const bare = up(wt);
    expect(bare.code, `bare up failed: ${bare.stderr} ${bare.stdout}`).toBe(0);
    expect((bare.doc as UpDoc).up.services.map((s) => s.name)).toEqual(preview.selected_services);
  }, 120_000);

  it("scenario 71: up --dry-run names a dead service without restarting it, and an unbooted -n fails like the real up (#210)", async () => {
    const repo = buildSmokeRepo("dt-rpc71-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const api = sleeper(repo.root, "api");
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  api:",
        "    tier: isolated",
        "    namespace: local-backend",
        `    command: "python3 ${api}"`,
        // Keeps the project alive once api is killed: process-compose exits
        // when every process has finished.
        "  db:",
        "    tier: isolated",
        "    namespace: local-backend",
        '    command: "sleep 300"',
        "  worker:",
        "    tier: isolated",
        "    namespace: jobs",
        '    command: "sleep 300"',
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const booted = devtrees(wt, ["up", "-n", "local-backend", "--json", "--wait-timeout", "30"]);
    expect(booted.code, `up -n local-backend failed: ${booted.stderr}`).toBe(0);

    // An unbooted namespace: the dry run fails exactly as the real `up` does.
    const widenDry = devtrees(wt, ["up", "--dry-run", "--json", "-n", "jobs"]);
    const widenReal = devtrees(wt, ["up", "--json", "--wait-timeout", "20", "-n", "jobs"]);
    const errOf = (r: CliResult) =>
      (r.doc as { error?: { code?: string; details?: unknown } }).error;
    expect(widenDry.code).toBe(1);
    expect(errOf(widenDry)?.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(errOf(widenDry)?.details).toEqual(errOf(widenReal)?.details);

    // Kill api; process-compose (no restart policy) reports it dead.
    reapPids(pidsMatching(api));
    let preview: Record<string, unknown> = {};
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const dry = devtrees(wt, ["up", "--dry-run", "--json"]);
      expect(dry.code, `dry run failed: ${dry.stderr} ${dry.stdout}`).toBe(0);
      preview = (dry.doc as { up_dry_run: Record<string, unknown> }).up_dry_run;
      if ((preview.would_restart as string[]).length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(preview).toMatchObject({ instance: "running", would_restart: ["api"] });
    // The dry run restarted nothing.
    expect(pidsMatching(api)).toEqual([]);

    // The real bare `up` restarts exactly what the preview named.
    const real = up(wt);
    expect(real.code, `bare up failed: ${real.stderr} ${real.stdout}`).toBe(0);
    expect((real.doc as { up: { restarted: string[] } }).up.restarted).toEqual(
      preview.would_restart,
    );
    expect(await waitForPid(api, 10_000), "api should be running again").toBe(true);
  }, 120_000);

  it("scenario 72: a service added to a booted namespace — the dry run previews the reload's outcome, as the real up does (#210)", () => {
    const repo = buildSmokeRepo("dt-rpc72-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const stack = (withCache: boolean) =>
      writeFileSync(
        join(wt, "devtrees.yaml"),
        [
          "services:",
          ...["api", "db", ...(withCache ? ["cache"] : [])].flatMap((name, i) => [
            `  ${name}:`,
            "    tier: isolated",
            "    namespace: local-backend",
            `    command: "sleep 30${i}"`,
          ]),
          "  worker:",
          "    tier: isolated",
          "    namespace: jobs",
          '    command: "sleep 309"',
          "",
        ].join("\n"),
      );
    stack(false);
    cleanupStack.push(() => devtrees(wt, ["down"]));

    const booted = devtrees(wt, ["up", "-n", "local-backend", "--json", "--wait-timeout", "30"]);
    expect(booted.code, `up -n local-backend failed: ${booted.stderr}`).toBe(0);

    stack(true);
    const previewOf = (r: CliResult) => {
      expect(r.code, `dry run failed: ${r.stderr} ${r.stdout}`).toBe(0);
      return (r.doc as { up_dry_run: Record<string, unknown> }).up_dry_run;
    };
    const expected = {
      instance: "running",
      namespaces: ["local-backend"],
      would_reload: true,
      would_restart: [],
    };
    const dryBare = previewOf(devtrees(wt, ["up", "--dry-run", "--json"]));
    const dryScoped = previewOf(devtrees(wt, ["up", "--dry-run", "--json", "-n", "local-backend"]));
    expect(dryBare).toMatchObject(expected);
    expect(dryScoped).toMatchObject(expected);
    // `selected_services` is in devtrees.yaml order, `up.services` in
    // process-compose's: compare them as sets.
    const sorted = (names: unknown) => [...(names as string[])].sort();
    expect(sorted(dryBare.selected_services)).toEqual(["api", "cache", "db"]);
    expect(dryScoped.selected_services).toEqual(dryBare.selected_services);

    // The real `up` reloads, then checks the same services.
    const real = devtrees(wt, ["up", "-n", "local-backend", "--json", "--wait-timeout", "30"]);
    expect(real.code, `real up failed: ${real.stderr} ${real.stdout}`).toBe(0);
    expect(sorted((real.doc as UpDoc).up.services.map((s) => s.name))).toEqual(
      sorted(dryScoped.selected_services),
    );
    const bare = up(wt);
    expect(bare.code, `bare up failed: ${bare.stderr} ${bare.stdout}`).toBe(0);
    expect(sorted((bare.doc as UpDoc).up.services.map((s) => s.name))).toEqual(
      sorted(dryBare.selected_services),
    );
  }, 120_000);

  // -- Scenarios 95-96: `ls` shows namespaces and services (#226, ADR-0009). --
  interface LsServicesDoc {
    readonly ls: {
      readonly instances: ReadonlyArray<{
        readonly id: string;
        readonly kind: string;
        readonly namespaces: ReadonlyArray<string> | null;
        readonly services_read: string;
        readonly services: ReadonlyArray<{
          readonly name: string;
          readonly status: string;
          readonly namespaces: ReadonlyArray<string>;
          readonly tier: string;
          readonly state: string;
          readonly pid: number | null;
        }>;
      }>;
    };
  }

  /**
   * A stack with two isolated namespaces (`backend`: api + worker, `ios`:
   * sim) and a shared `db`. Every command carries the scenario root in argv
   * so the PID-hygiene check sees all of it.
   */
  function writeTwoNamespaceStack(wt: string, root: string): Record<string, string> {
    const scripts = Object.fromEntries(
      ["db", "api", "worker", "sim"].map((n) => [n, sleeper(root, n)]),
    );
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  db:",
        "    tier: shared",
        `    command: "python3 ${scripts.db}"`,
        "  api:",
        "    tier: isolated",
        "    namespace: backend",
        `    command: "python3 ${scripts.api}"`,
        "  worker:",
        "    tier: isolated",
        "    namespace: backend",
        `    command: "python3 ${scripts.worker}"`,
        "  sim:",
        "    tier: isolated",
        "    namespace: ios",
        `    command: "python3 ${scripts.sim}"`,
        "",
      ].join("\n"),
    );
    return scripts;
  }

  /** The worktree's control socket and derived config, as devtrees lays them out. */
  function worktreeInstance(wt: string): { socketPath: string; configPath: string } {
    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const absCommon = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    return instancePaths(absCommon, wtId(wt));
  }

  /**
   * A fresh repo running the two-namespace stack booted with `-n backend`,
   * with the scenario's cleanups registered.
   */
  function bootBackendOnly(prefix: string): {
    wt: string;
    id: string;
    scripts: Record<string, string>;
  } {
    const repo = buildSmokeRepo(prefix, ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const scripts = writeTwoNamespaceStack(wt, repo.root);
    cleanupStack.push(() => devtrees(wt, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(wt, ["down"]));
    const booted = devtrees(wt, ["up", "-n", "backend", "--json", "--wait-timeout", "30"]);
    expect(booted.code, `up -n backend failed: ${booted.stderr} ${booted.stdout}`).toBe(0);
    return { wt, id: wtId(wt), scripts };
  }

  type LsServiceJsonRow = LsServicesDoc["ls"]["instances"][number]["services"][number];

  /** Poll `ls --json` until `service` in instance `id` `matches`; the last document. */
  async function pollServiceState(
    wt: string,
    id: string,
    service: string,
    matches: (row: LsServiceJsonRow) => boolean,
  ): Promise<LsServicesDoc> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const ls = devtrees(wt, ["ls", "--json"]);
      expect(ls.code, `ls failed: ${ls.stderr}`).toBe(0);
      const doc = ls.doc as LsServicesDoc;
      const row = doc.ls.instances
        .find((i) => i.id === id)
        ?.services.find((s) => s.name === service);
      if ((row !== undefined && matches(row)) || Date.now() >= deadline) return doc;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it("scenario 95: ls shows the booted namespace and each service, a stopped one as dead, shared included (#226)", async () => {
    const { wt, id, scripts } = bootBackendOnly("dt-rpc95-");
    expect(await waitForPid(scripts.worker!, 10_000), "worker should be running").toBe(true);

    const { socketPath } = worktreeInstance(wt);
    const stop = spawnSync("process-compose", ["process", "stop", "worker", "-u", socketPath], {
      encoding: "utf8",
    });
    expect(stop.status, stop.stderr).toBe(0);
    expect(await waitForNoPids(scripts.worker!, 10_000)).toEqual([]);

    // process-compose reports the stop like a crash (`Completed`, exit -1):
    // `ls` classifies it `dead`, as ADR-0009 says it will.
    const doc = await pollServiceState(wt, id, "worker", (s) => s.state === "dead");
    const worktree = doc.ls.instances.find((i) => i.id === id)!;
    // `ios` was not booted: its `sim` is not in the project.
    expect(worktree).toMatchObject({ services_read: "ok", namespaces: ["backend"] });
    const byName = new Map(worktree.services.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(["api", "worker"]);
    const isolated = { namespaces: ["backend"], tier: "isolated" };
    expect(byName.get("api")).toMatchObject({ ...isolated, state: "active", status: "Running" });
    expect(byName.get("worker")).toMatchObject({
      ...isolated,
      state: "dead",
      status: "Completed",
      pid: null,
    });
    // The pid is the live service process.
    const apiPid = byName.get("api")!.pid!;
    expect(() => process.kill(apiPid, 0)).not.toThrow();
    expect(doc.ls.instances.find((i) => i.kind === "shared")).toMatchObject({
      services_read: "ok",
      namespaces: ["default"],
      services: [{ name: "db", namespaces: ["default"], tier: "shared", state: "active" }],
    });

    // Human output: the NAMESPACES column, and one row per service.
    const table = devtrees(wt, ["ls"]).stdout;
    expect(table).toMatch(/^ID\s+KIND\s+STATUS\s+NAMESPACES\s+PORTS$/m);
    expect(table).toMatch(new RegExp(`^${id}\\s+worktree\\s+running\\s+backend\\s`, "m"));
    const rows = devtrees(wt, ["ls", "--services"]).stdout;
    expect(rows).toMatch(/^INSTANCE\s+SERVICE\s+NAMESPACES\s+TIER\s+STATE\s+PID$/m);
    expect(rows).toMatch(new RegExp(`^${id}\\s+worker\\s+backend\\s+isolated\\s+dead\\s+-$`, "m"));
    expect(rows).toMatch(
      new RegExp(`^${id}\\s+api\\s+backend\\s+isolated\\s+active\\s+${apiPid}$`, "m"),
    );
    expect(rows).toMatch(/^shared\s+db\s+default\s+shared\s+active\s+\d+$/m);
    expect(rows).not.toMatch(/\bsim\b/);
  }, 120_000);

  it("scenario 96: ls lists a frozen instance as unresponsive within its read budget, and the others in full (#226)", async () => {
    const { wt, id } = bootBackendOnly("dt-rpc96-");

    // Freeze the worktree's process-compose: its socket still accepts
    // connections, but `process list` never answers.
    const { configPath } = worktreeInstance(wt);
    const ps = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
    const pcPids = ps.stdout
      .split("\n")
      .filter((l) => l.includes("process-compose") && l.includes(configPath))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
    expect(pcPids.length, "the worktree's process-compose should be running").toBe(1);
    process.kill(pcPids[0]!, "SIGSTOP");
    // Runs before the `down`s (LIFO), so they find it answering.
    cleanupStack.push(() => process.kill(pcPids[0]!, "SIGCONT"));

    const started = Date.now();
    const ls = await devtreesAsync(wt, ["ls", "--json"]);
    const elapsed = Date.now() - started;
    expect(ls.code, `ls failed: ${ls.stderr} ${ls.stdout}`).toBe(0);
    // One 5s read budget (plus the CLI's own start-up), not a hang.
    expect(elapsed).toBeLessThan(15_000);
    const doc = ls.doc as LsServicesDoc;
    expect(doc.ls.instances.find((i) => i.id === id)).toMatchObject({
      status: "running",
      services_read: "unresponsive",
      namespaces: null,
      services: [],
    });
    expect(doc.ls.instances.find((i) => i.kind === "shared")).toMatchObject({
      services_read: "ok",
      services: [{ name: "db", state: "active" }],
    });

    const human = await devtreesAsync(wt, ["ls", "--services"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(
      new RegExp(`^${id}\\s+\\(unresponsive\\)\\s+\\?\\s+isolated\\s+\\?\\s+-$`, "m"),
    );
    expect(human.stderr).toMatch(/did not answer/);
  }, 120_000);

  it("scenario 97: a service in its restart backoff reads active with no pid, not the dead run's (#226)", async () => {
    const repo = buildSmokeRepo("dt-rpc97-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    const keeper = sleeper(repo.root, "keeper");
    const flaky = join(repo.root, "flaky.py");
    writeFileSync(flaky, "import sys, time\ntime.sleep(1)\nsys.exit(3)\n");
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  keeper:",
        "    tier: isolated",
        `    command: "python3 ${keeper}"`,
        "  flaky:",
        "    tier: isolated",
        `    command: "python3 ${flaky}"`,
        "    availability:",
        "      restart: always",
        "      backoff_seconds: 20",
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"]));
    // `up` may or may not call flaky healthy; only `ls` is under test here.
    devtrees(wt, ["up", "--json", "--wait-timeout", "5"]);
    const id = wtId(wt);

    const doc = await pollServiceState(wt, id, "flaky", (s) => s.status === "Restarting");
    const row = doc.ls.instances.find((i) => i.id === id)?.services.find((s) => s.name === "flaky");
    expect(row).toMatchObject({ status: "Restarting", state: "active", pid: null });
    expect(pidsMatching(flaky)).toEqual([]);
    const rows = devtrees(wt, ["ls", "--services"]).stdout;
    expect(rows).toMatch(new RegExp(`^${id}\\s+flaky\\s+default\\s+isolated\\s+active\\s+-$`, "m"));
  }, 120_000);
});

/** Names of the marker's old runs that carry a recorded identity. */
function oldRuns(marker: ReturnType<typeof readPendingReload>): string[] {
  return (marker?.oldRuns ?? []).filter((r) => r.identity).map((r) => r.name);
}

// Without the gate, log once so a developer running `vp test run` locally
// knows why no scenarios fired.
/**
 * A stack whose `web` binds `WEB_PORT` with `python3 -m http.server` (which
 * listens on the dual-stack `::` wildcard), plus a `keeper` so process-compose
 * keeps the project alive if `web` dies. Returns the allocated `WEB_PORT`.
 */
function writeHttpServerStack(wt: string): number {
  writeFileSync(
    join(wt, "devtrees.yaml"),
    [
      "services:",
      "  web:",
      "    tier: isolated",
      '    command: "python3 -m http.server $WEB_PORT"',
      "    ports: [WEB_PORT]",
      "  keeper:",
      "    tier: isolated",
      '    command: "sleep 300"',
      "",
    ].join("\n"),
  );
  const dry = devtrees(wt, ["up", "--dry-run", "--json"]);
  expect(dry.code, `up --dry-run failed: ${dry.stderr}`).toBe(0);
  const port = Number(
    (dry.doc as { up_dry_run: { env: { WEB_PORT: string } } }).up_dry_run.env.WEB_PORT,
  );
  expect(port).toBeGreaterThan(0);
  return port;
}

/** Poll until something accepts TCP connections on `127.0.0.1:port`. */
async function waitForListener(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

type Collision = { port_name: string; port: number; pid: number | null };

/** The `STALE_PORT_BLOCK` collisions of a failed `up --json`. */
function staleCollisions(r: CliResult): Collision[] {
  expect(r.code, `up should fail: ${r.stdout}`).toBe(1);
  const error = (r.doc as { error?: { code?: string; details?: { collisions?: Collision[] } } })
    .error;
  expect(error?.code).toBe("STALE_PORT_BLOCK");
  return error?.details?.collisions ?? [];
}

describe.skipIf(!ENABLED)(
  "real-pc smoke — stale-port preflight on every local address (#163)",
  () => {
    it("scenario 75: a python3 -m http.server holder on the dual-stack wildcard fails STALE_PORT_BLOCK, before anything starts (#163)", async () => {
      const repo = buildSmokeRepo("dt-rpc75-", ["login"]);
      currentCtx = { pidNeedle: repo.root, root: repo.root };
      const wt = repo.worktrees.login!;
      const port = writeHttpServerStack(wt);
      cleanupStack.push(() => devtrees(wt, ["down"]));

      // Before #163 the preflight bound 127.0.0.1 only, missed this holder,
      // and `web` died on the taken port after boot.
      const holder = spawn("python3", ["-m", "http.server", String(port)], { stdio: "ignore" });
      cleanupStack.push(() => reapPids(holder.pid === undefined ? [] : [holder.pid]));
      expect(await waitForListener(port, 10_000), "python holder never listened").toBe(true);

      const collisions = staleCollisions(up(wt));
      expect(collisions).toMatchObject([{ port_name: "WEB_PORT", port }]);
      const pid = collisions[0]?.pid ?? null;
      if (pid !== null) expect(pid).toBe(holder.pid);
      // The preflight runs before process-compose is spawned: no instance.
      const ls = devtrees(wt, ["ls", "--json"]);
      expect((ls.doc as { ls: { instances: unknown[] } }).ls.instances).toEqual([]);
    }, 90_000);

    it("scenario 76: holders on 0.0.0.0, ::1 and an IPv6-only :: each fail STALE_PORT_BLOCK (#163)", async () => {
      const repo = buildSmokeRepo("dt-rpc76-", ["login"]);
      currentCtx = { pidNeedle: repo.root, root: repo.root };
      const wt = repo.worktrees.login!;
      const port = writeHttpServerStack(wt);
      cleanupStack.push(() => devtrees(wt, ["down"]));

      const holders: ReadonlyArray<readonly [string, boolean]> = [
        ["0.0.0.0", false],
        ["::1", false],
        ["::", true],
      ];
      for (const [host, ipv6Only] of holders) {
        const server: Server | null = await new Promise((resolve, reject) => {
          const s = createServer();
          s.once("error", (err: NodeJS.ErrnoException) =>
            // A runner without IPv6 cannot host this holder; nothing to test.
            err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT"
              ? resolve(null)
              : reject(err),
          );
          s.listen({ port, host, ipv6Only }, () => resolve(s));
        });
        if (server === null) continue;
        try {
          const collisions = staleCollisions(up(wt));
          expect(collisions, `holder on ${host}`).toMatchObject([{ port_name: "WEB_PORT", port }]);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }

      // With every holder gone, the same stack comes up and `web` serves.
      const ok = up(wt);
      expect(ok.code, `up failed once the port was free: ${ok.stderr} ${ok.stdout}`).toBe(0);
      expect(await waitForListener(port, 10_000), "web never listened").toBe(true);
    }, 120_000);
  },
);

// Issue #155: `down` said "worktree instance stopped" and exited 0 while a
// SIGTERM-ignoring grandchild behind a wrapper chain, or a daemon's
// out-of-band resources, outlived it; the next `up` then failed
// STALE_PORT_BLOCK without naming the holder.
describe.skipIf(!ENABLED)("real-pc smoke — down leaves nothing behind (#155)", () => {
  /**
   * `<root>/listener.py`: listens on argv[1] (127.0.0.1) and ignores
   * SIGTERM, like the uvicorn grandchild in #155. With `detach`, it first
   * double-forks into a session of its own, so its launcher returns at once
   * and it is outside every service's process tree (a daemon's resource).
   */
  function listenerScript(root: string): string {
    const path = join(root, "listener.py");
    writeFileSync(
      path,
      [
        "import os, signal, socket, sys",
        "if len(sys.argv) > 2 and sys.argv[2] == 'detach':",
        "    if os.fork() > 0: sys.exit(0)",
        "    os.setsid()",
        "    if os.fork() > 0: sys.exit(0)",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        "s = socket.socket()",
        "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
        "s.bind(('127.0.0.1', int(sys.argv[1])))",
        "s.listen(5)",
        "while True:",
        "    c, _ = s.accept()",
        "    c.close()",
        "",
      ].join("\n"),
    );
    return path;
  }

  function scenarioRepo(prefix: string): { wt: string; root: string } {
    const repo = buildSmokeRepo(prefix, ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    // Whatever happens, kill what the scenario started.
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));
    return { wt: repo.worktrees.login!, root: repo.root };
  }

  it("scenario 80: down stops a SIGTERM-ignoring grandchild behind an exec'd wrapper chain, and the next up starts (#155)", async () => {
    const { wt, root } = scenarioRepo("dt-rpc80-");
    const listener = listenerScript(root);
    // `exec sh wrapper.sh` -> python3: the shape of `exec pnpm exec keyshelf
    // run ... -- uv run ... uvicorn`, where the listener is a grandchild.
    const wrapper = join(root, "wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\npython3 ${listener} "$1"\n`);
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  web:",
        "    tier: isolated",
        "    ports: [WEB_PORT]",
        `    command: "exec sh ${wrapper} $WEB_PORT"`,
        "",
      ].join("\n"),
    );
    const first = up(wt);
    expect(first.code, first.stdout).toBe(0);
    const port = Number((first.doc as UpDoc).up.env.WEB_PORT);
    expect(await waitForListener(port, 10_000), "listener should serve").toBe(true);

    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code, `down should succeed: ${down.stdout}`).toBe(0);
    const doc = down.doc as { down: { force_killed: Array<{ service: string; pid: number }> } };
    expect(doc.down.force_killed).toMatchObject([{ service: "web" }]);
    expect(await waitForNoPids(listener, 5_000), "the grandchild should be gone").toEqual([]);
    expect(orphanedServices(root)).toEqual([]);

    // The block is free again: the next up does not fail STALE_PORT_BLOCK.
    const second = up(wt);
    expect(second.code, `up after down: ${second.stdout}`).toBe(0);
    expect(devtrees(wt, ["down", "--json"]).code).toBe(0);
  }, 120_000);

  it("scenario 81: down runs each skipped daemon hook once, bounded, and never re-runs one that already ran (#155)", async () => {
    const { wt, root } = scenarioRepo("dt-rpc81-");
    // Each daemon "starts a container" (a resource file), and its hook
    // removes it and logs that it ran. `app`'s launch then fails, as a
    // `supabase start` that times out on a health check does. `slow`'s
    // launch fails too, and its hook never finishes and declares no
    // timeout. `data` launches fine and is stopped by hand before `down`
    // (its hook runs then, and it shows Completed, exit 0).
    const hookLog = join(root, "hooks.log");
    const daemon = (name: string, ns: string, exit: number, hookTail = "") => [
      `  ${name}:`,
      "    tier: isolated",
      `    namespace: ${ns}`,
      "    is_daemon: true",
      `    command: "sh -c 'touch ${join(root, `res-${name}`)}; exit ${exit}'"`,
      "    availability:",
      '      restart: "no"',
      "    shutdown:",
      `      command: "sh -c 'rm -f ${join(root, `res-${name}`)}; echo ${name} >> ${hookLog}${hookTail}'"`,
    ];
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        ...daemon("data", "backoffice", 0),
        ...daemon("app", "app", 1),
        ...daemon("slow", "app", 1, "; sleep 600"),
        // Keeps process-compose running once `data` is stopped: it exits when
        // nothing runs, and then `down` takes the dead-supervisor path.
        "  web:",
        "    tier: isolated",
        "    namespace: app",
        '    command: "sleep 300"',
        "",
      ].join("\n"),
    );
    // The failed launches make this up fail HEALTH_TIMEOUT; the instance stays up.
    devtrees(wt, ["up", "--json", "--wait-timeout", "5", "-n", "backoffice", "-n", "app"]);
    expect(existsSync(join(root, "res-app")), "app's launch should have run").toBe(true);
    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const absCommon = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    const socketPath = instancePaths(absCommon, wtId(wt)).socketPath;
    const stop = spawnSync("process-compose", ["process", "stop", "data", "-u", socketPath], {
      encoding: "utf8",
    });
    expect(stop.status, stop.stderr).toBe(0);
    expect(readFileSync(hookLog, "utf8")).toBe("data\n");

    const started = Date.now();
    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code, `down should succeed: ${down.stdout}`).toBe(0);
    // `slow`'s hook is cut off at process-compose's default 10s, not left to
    // hold the lifecycle lock forever.
    expect(Date.now() - started).toBeLessThan(45_000);
    const doc = down.doc as { down: { warning?: { failures: Array<{ process: string }> } } };
    expect(doc.down.warning?.failures).toMatchObject([{ process: "slow", reason: "timeout" }]);
    expect(existsSync(join(root, "res-app")), "devtrees runs app's skipped hook").toBe(false);
    // Each hook ran exactly once: data's by the stop, the two failed ones by devtrees.
    expect(readFileSync(hookLog, "utf8").trim().split("\n").sort()).toEqual([
      "app",
      "data",
      "slow",
    ]);
  }, 120_000);

  it("scenario 82: down fails DOWN_INCOMPLETE naming a listener that outlived the stop (#155)", async () => {
    const { wt, root } = scenarioRepo("dt-rpc82-");
    const listener = listenerScript(root);
    // A daemon whose resource keeps its port, and whose hook does not stop it.
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  db:",
        "    tier: isolated",
        "    ports: [DB_PORT]",
        "    is_daemon: true",
        `    command: "python3 ${listener} $DB_PORT detach"`,
        "    readiness_probe:",
        "      exec:",
        '        command: "echo ok"',
        "      period_seconds: 1",
        "    shutdown:",
        '      command: "echo bye"',
        "",
      ].join("\n"),
    );
    const first = up(wt);
    expect(first.code, first.stdout).toBe(0);
    const port = Number((first.doc as UpDoc).up.env.DB_PORT);
    expect(await waitForListener(port, 10_000), "the daemon's listener should serve").toBe(true);
    const [pid] = pidsMatching(listener);

    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code, "down must not report success").toBe(1);
    const error = (down.doc as { error: { code: string; details: Record<string, unknown> } }).error;
    expect(error.code).toBe("DOWN_INCOMPLETE");
    expect(error.details.survivors).toMatchObject([
      { service: "db", port_name: "DB_PORT", port, pid },
    ]);
    // The human message names it too.
    expect(down.stderr).toContain(`db DB_PORT ${port}: pid ${pid}`);

    // The remedy converges: a second `down` re-checks the port and fails
    // the same way while the listener lives, then succeeds once it is gone.
    const again = devtrees(wt, ["down", "--json"]);
    expect(again.code).toBe(1);
    expect((again.doc as { error: { code: string } }).error.code).toBe("DOWN_INCOMPLETE");
    process.kill(pid!, "SIGKILL");
    expect(await waitForNoPids(listener, 5_000)).toEqual([]);
    const last = devtrees(wt, ["down", "--json"]);
    expect(last.code, last.stdout).toBe(0);
  }, 120_000);

  it("scenario 84: down never signals a daemon a service detached from its process group (#155)", async () => {
    const { wt, root } = scenarioRepo("dt-rpc84-");
    const listener = listenerScript(root);
    // A launcher that starts (or would reuse) a per-user daemon in a session
    // of its own, on a fixed port outside the block, then keeps running:
    // the Gradle-daemon / Node `detached: true` + `unref()` shape.
    const shared = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        srv.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  web:",
        "    tier: isolated",
        `    command: "sh -c 'python3 ${listener} ${shared} detach; exec sleep 300'"`,
        "",
      ].join("\n"),
    );
    expect(up(wt).code).toBe(0);
    expect(await waitForListener(shared, 10_000), "the shared daemon should serve").toBe(true);
    const [daemonPid] = pidsMatching(listener);

    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code, down.stdout).toBe(0);
    expect((down.doc as { down: { force_killed: unknown[] } }).down.force_killed).toEqual([]);
    // Still alive and serving: other instances may be using it.
    expect(pidsMatching(listener)).toEqual([daemonPid]);
    expect(await waitForListener(shared, 2_000)).toBe(true);
  }, 120_000);

  it("scenario 83: STALE_PORT_BLOCK lists each held port with its pid and command in human output (#155)", async () => {
    const { wt, root } = scenarioRepo("dt-rpc83-");
    const listener = listenerScript(root);
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  web:",
        "    tier: isolated",
        "    ports: [WEB_PORT]",
        '    command: "sleep 300"',
        "",
      ].join("\n"),
    );
    // Learn the block, then squat WEB_PORT with an orphan-like listener.
    const first = up(wt);
    expect(first.code, first.stdout).toBe(0);
    const port = Number((first.doc as UpDoc).up.env.WEB_PORT);
    expect(devtrees(wt, ["down", "--json"]).code).toBe(0);
    const squatter = spawn("python3", [listener, String(port)], { stdio: "ignore" });
    cleanupStack.push(() => squatter.kill("SIGKILL"));
    expect(await waitForListener(port, 10_000)).toBe(true);

    const human = devtrees(wt, ["up", "--no-attach", "--wait-timeout", "10"]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain(`WEB_PORT ${port}: pid ${squatter.pid}`);
    const json = staleCollisions(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]));
    expect(json).toMatchObject([
      {
        port_name: "WEB_PORT",
        port,
        pid: squatter.pid,
        accepts_connections: true,
        port_forwarder: false,
      },
    ]);
  }, 120_000);
});

// ADR-0009: `devtrees stop` is removed (see the amendment "`stop` removed");
// `restart` keeps its bounded stop and its refusals.
describe.skipIf(!ENABLED)("real-pc smoke — stop removed, restart's stop refusals (#223)", () => {
  interface ErrorDoc {
    readonly error: { readonly code: string; readonly details?: Record<string, unknown> };
  }

  /**
   * A repo whose `devtrees.yaml` is `services` (lines under `services:`),
   * with a cleanup that kills whatever the scenario started.
   */
  function stopRepo(prefix: string, services: (root: string) => string[]) {
    const repo = buildSmokeRepo(prefix, ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    writeFileSync(join(wt, "devtrees.yaml"), ["services:", ...services(repo.root), ""].join("\n"));
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));
    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const absCommon = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    return { wt, root: repo.root, socketPath: instancePaths(absCommon, wtId(wt)).socketPath };
  }

  it("scenario 92c: restarting a Pending service fails SERVICE_PENDING, touches nothing, and it still starts later (B3, #222)", async () => {
    // `app` waits for `api` to be healthy; api becomes healthy only once
    // `ready` exists. process-compose would accept `process stop app` (the
    // first half of a restart) and leave it Terminating with no process for
    // good; devtrees refuses first.
    const { wt, root, socketPath } = stopRepo("dt-rpc92c-", (r) => [
      "  api:",
      "    tier: isolated",
      `    command: "python3 ${sleeper(r, "api")}"`,
      "    readiness_probe:",
      "      exec:",
      `        command: "test -f ${join(r, "ready")}"`,
      "      period_seconds: 1",
      "      failure_threshold: 100000",
      "  app:",
      "    tier: isolated",
      `    command: "python3 ${sleeper(r, "app")}"`,
      "    depends_on:",
      "      api:",
      "        condition: process_healthy",
    ]);
    devtrees(wt, ["up", "--json", "--wait-timeout", "5"]);
    expect(existsSync(socketPath), "the instance should be running").toBe(true);
    const apiPids = pidsMatching(join(root, "api.py"));
    expect(apiPids.length).toBeGreaterThan(0);

    // `restart` refuses it up front (#222): its stop would strand it.
    const restartStarted = Date.now();
    const restart = devtrees(wt, ["restart", "app", "--json"]);
    expect(Date.now() - restartStarted, "refused up front").toBeLessThan(15_000);
    expect(restart.code, restart.stdout).toBe(1);
    const restartError = (restart.doc as ErrorDoc).error;
    expect(restartError.code).toBe("SERVICE_PENDING");
    expect(restart.stderr).toMatch(/devtrees restart: app is still waiting/);
    expect(restartError.details).toMatchObject({ services: ["app"], waiting_on: ["api"] });
    expect(pidsMatching(join(root, "api.py"))).toEqual(apiPids);
    const after = (devtrees(wt, ["ls", "--json"]).doc as LsDoc).ls.instances
      .find((i) => i.id === wtId(wt))
      ?.services.find((s) => s.name === "app");
    expect(after?.status).toBe("Pending");

    // Once its dependency is healthy, app starts as if nothing had happened.
    writeFileSync(join(root, "ready"), "");
    expect(await waitForPid(join(root, "app.py"), 20_000), "app should start").toBe(true);
    expect(devtrees(wt, ["down", "--json"]).code).toBe(0);
  }, 120_000);

  it("scenario 112: restarting the only running service is refused LAST_SERVICES_RUNNING when its dependent is Pending (B1)", async () => {
    // `app` waits for `api` to be healthy, which it never is: process-compose
    // shows `app` Pending (is_running false). Restarting `api` stops it first,
    // which would leave nothing running; `app` would never start, and
    // process-compose would exit, taking the instance with it.
    const { wt, root, socketPath } = stopRepo("dt-rpc112-", (r) => [
      "  api:",
      "    tier: isolated",
      `    command: "python3 ${sleeper(r, "api")}"`,
      "    readiness_probe:",
      "      exec:",
      '        command: "false"',
      "      period_seconds: 1",
      "      failure_threshold: 100000",
      "  app:",
      "    tier: isolated",
      `    command: "python3 ${sleeper(r, "app")}"`,
      "    depends_on:",
      "      api:",
      "        condition: process_healthy",
    ]);
    // api never becomes healthy, so up fails HEALTH_TIMEOUT; the instance stays up.
    devtrees(wt, ["up", "--json", "--wait-timeout", "5"]);
    expect(existsSync(socketPath), "the instance should be running").toBe(true);
    const apiPids = pidsMatching(join(root, "api.py"));
    expect(apiPids.length).toBeGreaterThan(0);
    expect(pidsMatching(join(root, "app.py")), "app is still Pending").toEqual([]);

    const started = Date.now();
    const refused = devtrees(wt, ["restart", "api", "--json"]);
    expect(Date.now() - started, "refused up front").toBeLessThan(15_000);
    expect(refused.code, refused.stdout).toBe(1);
    const error = (refused.doc as ErrorDoc).error;
    expect(error.code).toBe("LAST_SERVICES_RUNNING");
    expect(error.details).toMatchObject({ worktree_id: wtId(wt), services: ["api"] });
    // Nothing was restarted, and the instance is still there.
    expect(pidsMatching(join(root, "api.py"))).toEqual(apiPids);
    expect(existsSync(socketPath)).toBe(true);
    expect(devtrees(wt, ["down", "--json"]).code).toBe(0);
  }, 120_000);

  it("scenario 110: `devtrees stop` is an unknown command and touches nothing", async () => {
    const { wt, root, socketPath } = stopRepo("dt-rpc110-", (r) => [
      "  web:",
      "    tier: isolated",
      `    command: "python3 ${sleeper(r, "web")}"`,
      "  api:",
      "    tier: isolated",
      `    command: "python3 ${sleeper(r, "api")}"`,
    ]);
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    expect(existsSync(socketPath), "the instance should be running").toBe(true);
    const webPids = pidsMatching(join(root, "web.py"));
    expect(webPids.length).toBeGreaterThan(0);

    const stop = devtrees(wt, ["stop", "web"]);
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain("stop");
    expect(devtrees(wt, ["--help"]).stdout).not.toMatch(/devtrees stop/);
    // Nothing was stopped: web is the same process, and the instance is up.
    expect(pidsMatching(join(root, "web.py"))).toEqual(webPids);
    expect(existsSync(socketPath)).toBe(true);
    expect(devtrees(wt, ["down", "--json"]).code).toBe(0);
  }, 120_000);
});

describe.skipIf(!ENABLED)("real-pc smoke — restart <service...> (#222)", () => {
  /** The `restart --json` success envelope. */
  interface RestartDoc {
    readonly restart: {
      readonly worktree_id: string;
      readonly restarted: ReadonlyArray<string>;
      readonly services: ReadonlyArray<LsServiceRow>;
      readonly force_killed: ReadonlyArray<{ service: string; pid: number }>;
    };
  }

  /** The `--json` error envelope's `error`, or `undefined`. */
  function errorOf(
    result: CliResult,
  ): { code?: string; message?: string; details?: unknown } | undefined {
    return (result.doc as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
  }

  /**
   * #160's shape. `api` is the backend `mobile` (Metro) depends on, `worker`
   * an unrelated service; `db` is shared, to be refused. Each server's argv
   * carries `--directory <root>/<name>`, so its pids are found exactly.
   * `mobileShutdown` / `apiShutdown`, when set, are `shutdown.command`s. `mobile`
   * exits 4 at start whenever `<root>/mobile-armed` exists.
   */
  function metroRepo(
    prefix: string,
    opts: { readonly mobileShutdown?: string; readonly apiShutdown?: string } = {},
  ): { wt: string; root: string; needle: (name: string) => string } {
    const repo = buildSmokeRepo(prefix, ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));
    const wt = repo.worktrees.login!;
    const needle = (name: string): string => `--directory ${join(repo.root, name)}`;
    const server = (name: string, port: string, guard = ""): string[] => {
      mkdirSync(join(repo.root, name));
      return [
        `  ${name}:`,
        "    tier: isolated",
        `    command: "${guard}exec python3 -m http.server $${port} --bind 127.0.0.1 ${needle(name)}"`,
        `    ports: [${port}]`,
        "    readiness_probe:",
        "      exec:",
        `        command: "curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$${port}/"`,
        "      initial_delay_seconds: 0",
        "      period_seconds: 1",
        "      timeout_seconds: 3",
        "      failure_threshold: 30",
      ];
    };
    const armed = join(repo.root, "mobile-armed");
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  db:",
        "    tier: shared",
        `    command: "python3 ${sleeper(repo.root, "db")}"`,
        ...server("api", "API_PORT"),
        ...(opts.apiShutdown === undefined
          ? []
          : ["    shutdown:", `      command: "${opts.apiShutdown}"`]),
        ...server("mobile", "MOBILE_PORT", `test -e ${armed} && exit 4; `),
        "    depends_on:",
        "      api:",
        "        condition: process_healthy",
        ...(opts.mobileShutdown === undefined
          ? []
          : ["    shutdown:", `      command: "${opts.mobileShutdown}"`]),
        "  worker:",
        "    tier: isolated",
        `    command: "python3 ${sleeper(repo.root, "worker")}"`,
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(wt, ["down"], { DEVTREES_DOWN_BASE_TIMEOUT_MS: "3000" }));
    return { wt, root: repo.root, needle };
  }

  /** `up --json` the Metro stack; returns its env. */
  async function bootMetro(wt: string): Promise<Record<string, string>> {
    const first = up(wt);
    expect(first.code, `up failed: ${first.stderr} ${first.stdout}`).toBe(0);
    const env = (first.doc as UpDoc).up.env;
    expect(await httpStatus(Number(env.MOBILE_PORT))).toBe(200);
    return env;
  }

  it("scenario 85: restart mobile keeps its port, the instance and the other services' pids; refusals touch nothing (#160, #222)", async () => {
    const { wt, root, needle } = metroRepo("dt-rpc85-");
    const none = devtrees(wt, ["restart", "mobile", "--json"]);
    expect(none.code).toBe(1);
    expect(errorOf(none)?.code).toBe("INSTANCE_NOT_FOUND");

    const env = await bootMetro(wt);
    const workerNeedle = join(root, "worker.py");
    const before = {
      api: pidsMatching(needle("api")),
      worker: pidsMatching(workerNeedle),
      db: pidsMatching(join(root, "db.py")),
      mobile: pidsMatching(needle("mobile")),
    };
    expect(before.mobile.length, "mobile should be running").toBeGreaterThan(0);

    // Refusals first: each one leaves every process as it was.
    const pids = pidsMatching(root).sort((a, b) => a - b);
    expect(errorOf(devtrees(wt, ["restart", "mobile", "nope", "--json"]))).toMatchObject({
      code: "SERVICE_NOT_FOUND",
      details: { service: "nope", valid_services: ["api", "mobile", "worker"] },
    });
    expect(errorOf(devtrees(wt, ["restart", "mobile", "db", "--json"]))).toMatchObject({
      code: "SHARED_SERVICE_REFUSED",
      details: { services: ["db"] },
    });
    expect(errorOf(devtrees(wt, ["restart", "--json"]))?.code).toBe("INVALID_ARGS");
    expect(pidsMatching(root).sort((a, b) => a - b)).toEqual(pids);

    const result = devtrees(wt, ["restart", "mobile", "--json", "--wait-timeout", "30"]);
    expect(result.code, `restart failed: ${result.stderr} ${result.stdout}`).toBe(0);
    const doc = (result.doc as RestartDoc).restart;
    expect(doc.worktree_id).toBe(wtId(wt));
    expect(doc.restarted).toEqual(["mobile"]);
    expect(doc.force_killed).toEqual([]);
    expect(doc.services).toMatchObject([
      { name: "mobile", health: "ready", ports: { MOBILE_PORT: Number(env.MOBILE_PORT) } },
    ]);

    // mobile is a new process on the same port; nothing else was touched.
    const mobileAfter = pidsMatching(needle("mobile"));
    expect(mobileAfter.length).toBeGreaterThan(0);
    expect(mobileAfter.some((pid) => before.mobile.includes(pid))).toBe(false);
    expect(await httpStatus(Number(env.MOBILE_PORT))).toBe(200);
    expect(pidsMatching(needle("api"))).toEqual(before.api);
    expect(pidsMatching(workerNeedle)).toEqual(before.worker);
    expect(pidsMatching(join(root, "db.py"))).toEqual(before.db);
    expect(await httpStatus(Number(env.API_PORT))).toBe(200);

    // Same instance: ls reports every service running under the same id.
    const ls = devtrees(wt, ["ls", "--json"]);
    const inst = (ls.doc as LsDoc).ls.instances.find((i) => i.id === wtId(wt));
    expect(inst?.services.map((s) => s.name).sort()).toEqual(["api", "mobile", "worker"]);
    expect(orphanedServices(root)).toEqual([]);

    // Human output, in `up`'s shape.
    const human = devtrees(wt, ["restart", "mobile", "--wait-timeout", "30"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toBe(`devtrees restart: restarted mobile in '${wtId(wt)}'.\n`);
  }, 180_000);

  it("scenario 86: shutdown.commands: one that leaves api running is bounded by a force-kill; a slow one with no timeout is no false SERVICE_START_FAILED (#222)", async () => {
    // `api`'s hook exits at once and leaves the server running; `mobile`'s
    // outlasts process-compose's own 10s hook limit.
    const { wt, root, needle } = metroRepo("dt-rpc86-", {
      apiShutdown: "true",
      mobileShutdown: "sleep 11",
    });
    const env = await bootMetro(wt);
    const oldApi = pidsMatching(needle("api"));

    const api = devtrees(wt, ["restart", "api", "--json", "--wait-timeout", "30"]);
    expect(api.code, `restart api failed: ${api.stderr} ${api.stdout}`).toBe(0);
    const apiDoc = (api.doc as RestartDoc).restart;
    expect(apiDoc.force_killed.map((k) => k.service)).toContain("api");
    expect(apiDoc.force_killed.map((k) => k.pid)).toEqual(expect.arrayContaining(oldApi));
    const nowApi = pidsMatching(needle("api"));
    expect(nowApi.some((pid) => oldApi.includes(pid))).toBe(false);
    expect(nowApi.length).toBeGreaterThan(0);
    expect(await httpStatusWithin(Number(env.API_PORT), 10_000)).toBe(200);

    const oldMobile = pidsMatching(needle("mobile"));
    const started = Date.now();
    const mobile = devtrees(wt, ["restart", "mobile", "--json", "--wait-timeout", "30"]);
    expect(mobile.code, `restart mobile failed: ${mobile.stderr} ${mobile.stdout}`).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
    expect((mobile.doc as RestartDoc).restart.restarted).toEqual(["mobile"]);
    const nowMobile = pidsMatching(needle("mobile"));
    expect(nowMobile.some((pid) => oldMobile.includes(pid))).toBe(false);
    // Ready was the new run's own probe (process-compose clears readiness on
    // stop), but one GET on a loaded runner can still miss (#231 CI): poll.
    expect(await httpStatusWithin(Number(env.MOBILE_PORT), 10_000)).toBe(200);
    expect(orphanedServices(root)).toEqual([]);
  }, 180_000);

  it("scenario 87: two names restart in depends_on order, a stopped one is simply started; one that dies fails HEALTH_TIMEOUT and is left running (#222)", async () => {
    const { wt, root, needle } = metroRepo("dt-rpc87-");
    const env = await bootMetro(wt);
    const worker = pidsMatching(join(root, "worker.py"));
    // Stop mobile behind devtrees' back: process-compose reports Completed/-1.
    reapPids(pidsMatching(needle("mobile")));
    expect(await waitForNoPids(needle("mobile"), 5000)).toEqual([]);

    const result = devtrees(wt, ["restart", "mobile", "api", "--json", "--wait-timeout", "30"]);
    expect(result.code, `restart failed: ${result.stderr} ${result.stdout}`).toBe(0);
    const doc = (result.doc as RestartDoc).restart;
    expect(doc.restarted).toEqual(["api", "mobile"]);
    expect(doc.services.map((s) => s.name)).toEqual(["api", "mobile"]);
    expect(await httpStatus(Number(env.MOBILE_PORT))).toBe(200);
    expect(await httpStatus(Number(env.API_PORT))).toBe(200);
    expect(pidsMatching(join(root, "worker.py"))).toEqual(worker);

    // A restart that dies straight away fails fast, naming the retry.
    const api = pidsMatching(needle("api"));
    writeFileSync(join(root, "mobile-armed"), "");
    const started = Date.now();
    const dies = devtrees(wt, ["restart", "mobile", "--json", "--wait-timeout", "60"]);
    expect(dies.code, dies.stdout).toBe(1);
    const err = errorOf(dies);
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("mobile (Completed, exit 4)");
    expect(err?.message).toContain("restarted mobile, and it died again");
    expect(err?.message).toContain("`devtrees restart mobile` restarts it again");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(pidsMatching(needle("api"))).toEqual(api);
    expect(await httpStatus(Number(env.API_PORT))).toBe(200);
    const ls = devtrees(wt, ["ls", "--json"]);
    expect((ls.doc as LsDoc).ls.instances.some((i) => i.id === wtId(wt))).toBe(true);
  }, 180_000);

  it("scenario 88: a one-service instance refuses LAST_SERVICES_RUNNING; restart during a pending hot-reload refuses with CONFIG_DRIFT reload_pending, and down still recovers (#191, #206, #222)", async () => {
    // Scenario 60's setup: the edited service's old process never stops.
    const repo = buildSmokeRepo("dt-rpc88-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));
    const [holdA, holdB] = [join(repo.root, "hold-a"), join(repo.root, "hold-b")];
    writeReloadStack(wt, { hold: holdA, shutdownCommand: "echo bye" });
    expect(up(wt).code).toBe(0);
    expect(await waitForPid(holdA, 10_000)).toBe(true);
    const oldPids = pidsMatching(holdA);

    // A one-service instance: its only process cannot be restarted in place,
    // as its stop would make process-compose exit. Refused, nothing touched.
    const last = devtrees(wt, ["restart", "web", "--json"]);
    expect(last.code).toBe(1);
    expect(errorOf(last)).toMatchObject({
      code: "LAST_SERVICES_RUNNING",
      details: { services: ["web"], remedy: "devtrees down && devtrees up" },
    });
    expect(pidsMatching(holdA)).toEqual(oldPids);
    expect(errorOf(devtrees(wt, ["ls", "--json"]))).toBeUndefined();

    writeReloadStack(wt, { hold: holdB, shutdownCommand: "echo bye" });
    expect(errorOf(up(wt))?.code).toBe("CONFIG_DRIFT");

    const restart = devtrees(wt, ["restart", "web", "--json"]);
    expect(restart.code).toBe(1);
    const err = errorOf(restart);
    expect(err?.code).toBe("CONFIG_DRIFT");
    expect(err?.message).toMatch(/^devtrees restart: a previous hot-reload/);
    expect(err?.details).toMatchObject({ reason: "reload_pending", services: ["web"] });
    const pids = (err?.details as { pids?: number[] } | undefined)?.pids ?? [];
    expect(pids.some((p) => oldPids.includes(p))).toBe(true);
    // Nothing was started: the old run is the only one, as before.
    expect(pidsMatching(holdA)).toEqual(oldPids);
    expect(pidsMatching(holdB)).toEqual([]);

    // The instance is still recoverable.
    const down = devtrees(wt, ["down", "--json"], { DEVTREES_DOWN_BASE_TIMEOUT_MS: "3000" });
    expect(down.code, `down should recover it: ${down.stdout}${down.stderr}`).toBe(0);
    expect(await waitForNoPids(repo.root, 10_000)).toEqual([]);
  }, 120_000);

  it("scenario 89: a server that drains for 3s on SIGTERM, still holding its port, restarts cleanly on the same port (#222)", async () => {
    const repo = buildSmokeRepo("dt-rpc89-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));
    const server = join(repo.root, "draining.py");
    writeFileSync(
      server,
      [
        "import signal, sys, time",
        "from http.server import HTTPServer, BaseHTTPRequestHandler",
        "class H(BaseHTTPRequestHandler):",
        "    def do_GET(self):",
        "        self.send_response(200); self.end_headers()",
        "    def log_message(self, *a): pass",
        "srv = HTTPServer(('127.0.0.1', int(sys.argv[1])), H)  # SO_REUSEADDR",
        "def drain(*_):",
        "    srv.timeout = 0.2",
        "    end = time.time() + 3",
        "    while time.time() < end: srv.handle_request()",
        "    sys.exit(0)",
        "signal.signal(signal.SIGTERM, drain)",
        "srv.serve_forever()",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  web:",
        "    tier: isolated",
        "    ports: [WEB_PORT]",
        `    command: "exec python3 ${server} $WEB_PORT"`,
        "    readiness_probe:",
        "      exec:",
        `        command: "curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$WEB_PORT/"`,
        "      initial_delay_seconds: 0",
        "      period_seconds: 1",
        "      timeout_seconds: 3",
        "      failure_threshold: 30",
        "  keeper:",
        "    tier: isolated",
        `    command: "python3 ${sleeper(repo.root, "keeper")}"`,
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"], { DEVTREES_DOWN_BASE_TIMEOUT_MS: "3000" }));
    const first = up(wt);
    expect(first.code, first.stdout).toBe(0);
    const port = Number((first.doc as UpDoc).up.env.WEB_PORT);
    expect(await httpStatus(port)).toBe(200);
    const old = pidsMatching(server);
    const keeper = pidsMatching(join(repo.root, "keeper.py"));

    const started = Date.now();
    const result = devtrees(wt, ["restart", "web", "--json", "--wait-timeout", "60"]);
    expect(result.code, `restart failed: ${result.stderr} ${result.stdout}`).toBe(0);
    // The drain ran its course: nothing had to be killed, and the new run
    // was started only after it, on the same port.
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    const doc = (result.doc as RestartDoc).restart;
    expect(doc.force_killed).toEqual([]);
    expect(doc.services).toMatchObject([
      { name: "web", health: "ready", ports: { WEB_PORT: port } },
    ]);
    const now = pidsMatching(server);
    expect(now.length).toBe(1);
    expect(old).not.toContain(now[0]);
    expect(await httpStatus(port)).toBe(200);
    expect(pidsMatching(join(repo.root, "keeper.py"))).toEqual(keeper);
    expect(orphanedServices(repo.root)).toEqual([]);
  }, 120_000);
});

// Issue #224 (ADR-0009): `restart -n` expands a namespace to its isolated
// services and goes through the per-service path; shared services in the
// namespace are skipped and reported.
describe.skipIf(!ENABLED)("real-pc smoke — restart -n (#224)", () => {
  interface VerbDoc {
    readonly restart?: {
      readonly restarted: string[];
      readonly skipped_shared: string[];
      readonly services: ReadonlyArray<LsServiceRow>;
    };
    readonly error?: { readonly code: string; readonly details?: Record<string, unknown> };
  }
  const docOf = (r: CliResult): VerbDoc => r.doc as VerbDoc;

  /**
   * `app` holds `api` and `web` (web waits on api being healthy); `ios`
   * holds `sim`; `default` holds `worker` and, as a shared service cannot
   * declare a namespace, the shared `db`. Each http server's argv carries
   * `--directory <root>/<name>`, so its pids are found exactly.
   */
  function nsRepo(prefix: string): {
    wt: string;
    root: string;
    pids: (name: string) => number[];
  } {
    const repo = buildSmokeRepo(prefix, ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));
    const wt = repo.worktrees.login!;
    const needles: Record<string, string> = {
      db: join(repo.root, "db.py"),
      sim: join(repo.root, "sim.py"),
      worker: join(repo.root, "worker.py"),
    };
    const server = (name: string, port: string): string[] => {
      mkdirSync(join(repo.root, name));
      needles[name] = `--directory ${join(repo.root, name)}`;
      return [
        `  ${name}:`,
        "    tier: isolated",
        "    namespace: app",
        `    command: "exec python3 -m http.server $${port} --bind 127.0.0.1 ${needles[name]}"`,
        `    ports: [${port}]`,
        "    readiness_probe:",
        "      exec:",
        `        command: "curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$${port}/"`,
        "      initial_delay_seconds: 0",
        "      period_seconds: 1",
        "      timeout_seconds: 3",
        "      failure_threshold: 30",
      ];
    };
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  db:",
        "    tier: shared",
        `    command: "python3 ${sleeper(repo.root, "db")}"`,
        ...server("api", "API_PORT"),
        ...server("web", "WEB_PORT"),
        "    depends_on:",
        "      api:",
        "        condition: process_healthy",
        "  sim:",
        "    tier: isolated",
        "    namespace: ios",
        `    command: "python3 ${sleeper(repo.root, "sim")}"`,
        "  worker:",
        "    tier: isolated",
        `    command: "python3 ${sleeper(repo.root, "worker")}"`,
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(wt, ["down"], { DEVTREES_DOWN_BASE_TIMEOUT_MS: "3000" }));
    return { wt, root: repo.root, pids: (name) => pidsMatching(needles[name]!) };
  }

  /** `up --json -n <ns>...`; returns its env. */
  function upNs(wt: string, namespaces: ReadonlyArray<string>): Record<string, string> {
    const flags = namespaces.flatMap((ns) => ["-n", ns]);
    const result = devtrees(wt, ["up", "--json", "--wait-timeout", "30", ...flags]);
    expect(result.code, `up failed: ${result.stderr} ${result.stdout}`).toBe(0);
    return (result.doc as UpDoc).up.env;
  }

  const snapshot = (pids: (name: string) => number[], names: ReadonlyArray<string>) =>
    Object.fromEntries(names.map((n) => [n, pids(n)]));

  it("scenario 101: restart -n app restarts api then web in depends_on order, on the same ports, touching nothing else", async () => {
    const { wt, root, pids } = nsRepo("dt-rpc101-");
    const env = upNs(wt, ["default", "app", "ios"]);
    const before = snapshot(pids, ["api", "web", "sim", "worker", "db"]);

    const result = devtrees(wt, ["restart", "-n", "app", "--json", "--wait-timeout", "30"]);
    expect(result.code, `restart failed: ${result.stderr} ${result.stdout}`).toBe(0);
    const doc = docOf(result).restart;
    expect(doc?.restarted).toEqual(["api", "web"]);
    expect(doc?.skipped_shared).toEqual([]);
    expect(doc?.services).toMatchObject([
      { name: "api", health: "ready", ports: { API_PORT: Number(env.API_PORT) } },
      { name: "web", health: "ready", ports: { WEB_PORT: Number(env.WEB_PORT) } },
    ]);
    for (const name of ["api", "web"]) {
      const now = pids(name);
      expect(now.length, `${name} should run`).toBeGreaterThan(0);
      expect(
        now.some((pid) => before[name]!.includes(pid)),
        `${name} is a new run`,
      ).toBe(false);
    }
    expect(await httpStatus(Number(env.API_PORT))).toBe(200);
    expect(await httpStatus(Number(env.WEB_PORT))).toBe(200);
    expect(snapshot(pids, ["sim", "worker", "db"])).toEqual({
      sim: before.sim,
      worker: before.worker,
      db: before.db,
    });
    expect(orphanedServices(root)).toEqual([]);
  }, 180_000);

  it("scenario 102: a namespace the instance did not boot fails NAMESPACE_NOT_RUNNING; one with no isolated service NO_SERVICES_SELECTED; nothing touched", async () => {
    const { wt, root } = nsRepo("dt-rpc102-");
    upNs(wt, ["default", "app"]);
    const pidsBefore = pidsMatching(root).sort((a, b) => a - b);

    const err = docOf(devtrees(wt, ["restart", "worker", "-n", "ios", "--json"])).error;
    expect(err).toMatchObject({
      code: "NAMESPACE_NOT_RUNNING",
      details: {
        worktree_id: wtId(wt),
        namespaces: ["ios"],
        services: ["sim"],
        remedy: "devtrees down && devtrees up -n app -n default -n ios",
      },
    });
    const none = docOf(devtrees(wt, ["restart", "-n", "nope", "--json"])).error;
    expect(none).toMatchObject({
      code: "NO_SERVICES_SELECTED",
      details: { selected_namespaces: ["nope"], namespaces: ["app", "default", "ios"] },
    });
    expect(pidsMatching(root).sort((a, b) => a - b)).toEqual(pidsBefore);
  }, 180_000);

  it("scenario 111: restart -n default restarts worker, skips and reports the shared db, leaving it running; naming db is still refused", async () => {
    const { wt, pids } = nsRepo("dt-rpc111-");
    upNs(wt, ["default", "app"]);
    const db = pids("db");
    expect(db.length, "db should run").toBeGreaterThan(0);
    const worker = pids("worker");
    expect(worker.length, "worker should run").toBeGreaterThan(0);
    const app = snapshot(pids, ["api", "web"]);

    const result = devtrees(wt, ["restart", "-n", "default", "--json", "--wait-timeout", "30"]);
    expect(result.code, `restart failed: ${result.stderr} ${result.stdout}`).toBe(0);
    expect(docOf(result).restart).toMatchObject({ restarted: ["worker"], skipped_shared: ["db"] });
    const now = pids("worker");
    expect(now.length, "worker should run again").toBeGreaterThan(0);
    expect(
      now.some((pid) => worker.includes(pid)),
      "worker is a new run",
    ).toBe(false);
    expect(pids("db")).toEqual(db);
    expect(snapshot(pids, ["api", "web"])).toEqual(app);

    // Human output reports the skip too.
    const human = devtrees(wt, ["restart", "-n", "default", "--wait-timeout", "30"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("skipped shared service db");

    const refused = docOf(devtrees(wt, ["restart", "db", "-n", "default", "--json"])).error;
    expect(refused).toMatchObject({
      code: "SHARED_SERVICE_REFUSED",
      details: { services: ["db"] },
    });
    expect(pids("db")).toEqual(db);
  }, 180_000);
});

describe.skipIf(!ENABLED)("real-pc smoke — bare restart (#225)", () => {
  // The cleanups `down` instances whose servers drain for seconds, each
  // `devtrees` call capped at 60s by spawnSync: run them here, before the
  // file-level hook, with a budget above that cap.
  afterEach(async () => {
    await drainCleanups();
  }, 150_000);

  /** The `--json` error envelope's `error`, or `undefined`. */
  function errorOf(
    result: CliResult,
  ): { code?: string; message?: string; details?: unknown } | undefined {
    return (result.doc as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
  }

  /**
   * A fresh repo whose `web` is an HTTP server that keeps serving, and so
   * keeps its port, for `drainSeconds` (3 by default) after SIGTERM (scenario 89's). `wrapped` runs it
   * under a shell that does not exec it, as `npm run dev` does, so the
   * process process-compose waits on exits before the server has drained.
   * `extra(root)` is appended to `devtrees.yaml`; `webNamespace` puts web in one.
   */
  function drainingRepo(
    prefix: string,
    opts: {
      readonly wrapped?: boolean;
      readonly drainSeconds?: number;
      readonly webNamespace?: string;
      readonly extra?: (root: string) => string[];
    } = {},
  ): { wt: string; root: string; server: string } {
    const repo = buildSmokeRepo(prefix, ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const wt = repo.worktrees.login!;
    cleanupStack.push(() => reapPids(pidsMatching(repo.root)));
    const server = join(repo.root, "draining.py");
    writeFileSync(
      server,
      [
        "import signal, sys, time",
        "from http.server import HTTPServer, BaseHTTPRequestHandler",
        "class H(BaseHTTPRequestHandler):",
        "    def do_GET(self):",
        "        self.send_response(200); self.end_headers()",
        "    def log_message(self, *a): pass",
        "srv = HTTPServer(('127.0.0.1', int(sys.argv[1])), H)  # SO_REUSEADDR",
        "def drain(*_):",
        "    srv.timeout = 0.2",
        `    end = time.time() + ${opts.drainSeconds ?? 3}`,
        "    while time.time() < end: srv.handle_request()",
        "    sys.exit(0)",
        "signal.signal(signal.SIGTERM, drain)",
        "srv.serve_forever()",
        "",
      ].join("\n"),
    );
    const command = opts.wrapped
      ? `python3 ${server} $WEB_PORT; echo web-exited`
      : `exec python3 ${server} $WEB_PORT`;
    writeFileSync(
      join(wt, "devtrees.yaml"),
      [
        "services:",
        "  web:",
        "    tier: isolated",
        ...(opts.webNamespace === undefined ? [] : [`    namespace: ${opts.webNamespace}`]),
        "    ports: [WEB_PORT]",
        `    command: "${command}"`,
        "    readiness_probe:",
        "      exec:",
        `        command: "curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$WEB_PORT/"`,
        "      initial_delay_seconds: 0",
        "      period_seconds: 1",
        "      timeout_seconds: 3",
        "      failure_threshold: 30",
        ...(opts.extra?.(repo.root) ?? []),
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(wt, ["down"], { DEVTREES_DOWN_BASE_TIMEOUT_MS: "3000" }));
    return { wt, root: repo.root, server };
  }

  /** Boot with `up --json` (plus `args`); returns web's port. */
  async function boot(wt: string, args: ReadonlyArray<string> = []): Promise<number> {
    const first = devtrees(wt, ["up", "--json", "--wait-timeout", "30", ...args]);
    expect(first.code, `up failed: ${first.stderr} ${first.stdout}`).toBe(0);
    const port = Number((first.doc as UpDoc).up.env.WEB_PORT);
    expect(await httpStatus(port)).toBe(200);
    return port;
  }

  /** The worktree instance's process-compose socket. */
  function socketOf(wt: string): string {
    const commonDir = execGit(wt, ["rev-parse", "--git-common-dir"]);
    const absCommon = commonDir.startsWith("/") ? commonDir : join(wt, commonDir);
    return instancePaths(absCommon, wtId(wt)).socketPath;
  }

  /** One process-compose REST call over its socket: the status and body. */
  function pcApi(
    socketPath: string,
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { socketPath, method, path, headers: { "Content-Type": "application/json" } },
        (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c.toString("utf8")));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("process-compose did not answer")));
      req.end(body);
    });
  }

  it("scenario 105: a bare restart of a multi-service instance fails INVALID_ARGS naming the booted namespaces' down + up, and touches nothing", async () => {
    const { wt, root, server } = drainingRepo("dt-rpc105-", {
      webNamespace: "app",
      extra: (root) => [
        "  worker:",
        "    tier: isolated",
        "    namespace: app",
        `    command: "python3 ${sleeper(root, "worker")}"`,
        "  sim:",
        "    tier: isolated",
        "    namespace: ios",
        `    command: "python3 ${sleeper(root, "sim")}"`,
      ],
    });
    const port = await boot(wt, ["-n", "app"]);
    const pids = pidsMatching(root).sort((a, b) => a - b);
    expect(pidsMatching(join(root, "sim.py"))).toEqual([]);

    const bare = devtrees(wt, ["restart", "--json"]);
    expect(bare.code).toBe(1);
    const err = errorOf(bare);
    expect(err).toMatchObject({
      code: "INVALID_ARGS",
      details: { remedy: "devtrees down && devtrees up -n app" },
    });
    expect(err?.message).toContain("`devtrees restart web`");
    expect(err?.message).toContain("`devtrees down && devtrees up -n app`");

    const human = devtrees(wt, ["restart"]);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("devtrees down && devtrees up -n app");

    // Nothing was touched: every process is the one booted, web still serves.
    expect(pidsMatching(root).sort((a, b) => a - b)).toEqual(pids);
    expect(await httpStatus(port)).toBe(200);

    // Naming the services is the in-place way: both restart, web on its port.
    const oldWeb = pidsMatching(server);
    const named = devtrees(wt, ["restart", "web", "worker", "--json", "--wait-timeout", "60"]);
    expect(named.code, `named restart failed: ${named.stderr} ${named.stdout}`).toBe(0);
    expect(pidsMatching(server).some((pid) => oldWeb.includes(pid))).toBe(false);
    expect(await httpStatus(port)).toBe(200);
    expect(orphanedServices(root)).toEqual([]);
  }, 180_000);

  it("scenario 106: a bare restart of a one-service instance fails INVALID_ARGS and touches nothing; its only service is LAST_SERVICES_RUNNING", async () => {
    const { wt, root, server } = drainingRepo("dt-rpc106-");
    const port = await boot(wt);
    const old = pidsMatching(server);

    const bare = devtrees(wt, ["restart", "--json"]);
    expect(bare.code).toBe(1);
    expect(errorOf(bare)).toMatchObject({
      code: "INVALID_ARGS",
      details: { remedy: "devtrees down && devtrees up" },
    });
    expect(errorOf(devtrees(wt, ["restart", "web", "--json"]))).toMatchObject({
      code: "LAST_SERVICES_RUNNING",
      details: { services: ["web"] },
    });
    expect(pidsMatching(server)).toEqual(old);
    expect(await httpStatus(port)).toBe(200);
    const ls = devtrees(wt, ["ls", "--json"]);
    expect((ls.doc as LsDoc).ls.instances.some((i) => i.id === wtId(wt))).toBe(true);

    // The printed remedy works: the instance comes back, on the same port.
    const down = devtrees(wt, ["down", "--json"]);
    expect(down.code, down.stdout).toBe(0);
    expect(await boot(wt)).toBe(port);
    expect(orphanedServices(root)).toEqual([]);
  }, 180_000);

  // Scenarios 107-109 pin the process-compose v1.122.0 behaviour that rules
  // out restarting an instance's last running process in place (#225,
  // ADR-0009). They assert on process-compose, not devtrees, and on timing:
  // the old run drains for 6s so the new run reliably starts while it still
  // holds the port. A failure means process-compose changed (revisit #225: a
  // bare restart may have become possible) or the machine is so overloaded
  // that the drain no longer outlasts the new run's start.
  it("scenario 107: process-compose `process restart` of a one-service instance starts the new run while the old one drains, and the instance dies", async () => {
    const { wt, server } = drainingRepo("dt-rpc107-", { drainSeconds: 6 });
    const port = await boot(wt);
    const socket = socketOf(wt);
    const old = pidsMatching(server);

    const restart = await pcApi(socket, "POST", "/process/restart/web");
    expect(restart.status, restart.body).toBe(200);
    // The new run fails to bind while the old one still serves; once the old
    // one exits, nothing runs and process-compose exits.
    expect(await waitForNoPids(socket, 20_000), "process-compose should exit").toEqual([]);
    // No run survives it: the old one finishes draining, and no new one serves.
    expect(await waitForNoPids(server, 15_000)).toEqual([]);
    expect(old.length).toBeGreaterThan(0);
    expect(await httpStatus(port)).toBe(0);
  }, 120_000);

  it("scenario 108: process-compose `POST /process` holds a one-service instance open for the update, but a wrapper that exits before its server drains still loses the port and the instance", async () => {
    const { wt, server } = drainingRepo("dt-rpc108-", { wrapped: true, drainSeconds: 6 });
    const port = await boot(wt);
    const socket = socketOf(wt);
    const info = await pcApi(socket, "GET", "/process/info/web");
    expect(info.status, info.body).toBe(200);

    // The update waits for the shell it started, not for the server under it.
    const update = await pcApi(socket, "POST", "/process", info.body);
    expect(update.status, update.body).toBe(200);
    expect(await waitForNoPids(socket, 20_000), "process-compose should exit").toEqual([]);
    // No run survives it: the old server finishes draining, and no new one serves.
    expect(await waitForNoPids(server, 15_000)).toEqual([]);
    expect(await httpStatus(port)).toBe(0);
  }, 120_000);

  it("scenario 109: process-compose `POST /process` restarts an exec'd server only because the JSON round trip changes its config, so the same request a second time restarts nothing", async () => {
    const { wt, server } = drainingRepo("dt-rpc109-");
    const port = await boot(wt);
    const socket = socketOf(wt);
    const old = pidsMatching(server);
    const update = async (): Promise<void> => {
      const info = await pcApi(socket, "GET", "/process/info/web");
      expect(info.status, info.body).toBe(200);
      const posted = await pcApi(socket, "POST", "/process", info.body);
      expect(posted.status, posted.body).toBe(200);
    };

    // The first update restarts web after the drain, on its port.
    await update();
    expect(await waitForPid(server, 10_000)).toBe(true);
    const first = pidsMatching(server);
    expect(first.some((pid) => old.includes(pid))).toBe(false);
    const ls = devtrees(wt, ["ls", "--json"]);
    expect((ls.doc as LsDoc).ls.instances.some((i) => i.id === wtId(wt))).toBe(true);
    expect(await httpStatus(port)).toBe(200);

    // The server now holds the round-tripped config: an identical update is a no-op.
    await update();
    await new Promise((r) => setTimeout(r, 1000));
    expect(pidsMatching(server)).toEqual(first);
  }, 120_000);
});

/**
 * Namespaced shared services (#236, ADR-0010) against the real binary: a
 * namespaced shared service joins the running shared instance through a
 * config reload that must leave the shared services already running alone,
 * and its drift fails only an `up` that selects it.
 */
describe.skipIf(!ENABLED)("real-pc smoke — namespaced shared services (#236)", () => {
  it("scenario 120: a later up adds a namespaced shared service without restarting the running ones; its drift fails only an up that selects it", async () => {
    const repo = buildSmokeRepo("dt-rpc120-", ["login", "billing"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const login = repo.worktrees.login!;
    const billing = repo.worktrees.billing!;
    const [holdPg, holdSb, holdSbEdited, holdApi] = [
      "hold-pg",
      "hold-sb",
      "hold-sb2",
      "hold-api",
    ].map((n) => join(repo.root, n));
    for (const hold of [holdPg, holdSb, holdSbEdited, holdApi]) writeFileSync(hold!, "");
    const writeStack = (wt: string, sbHold: string): void =>
      writeFileSync(
        join(wt, "devtrees.yaml"),
        [
          "services:",
          "  pg:",
          "    tier: shared",
          `    command: "tail -f ${holdPg}"`,
          "    ports: [PG_PORT]",
          "  sb:",
          "    tier: shared",
          "    namespace: db-shared",
          `    command: "tail -f ${sbHold}"`,
          "    ports: [SB_PORT]",
          "  api:",
          "    tier: isolated",
          "    namespace: app",
          `    command: "tail -f ${holdApi}"`,
          "    ports: [API_PORT]",
          "",
        ].join("\n"),
      );
    writeStack(login, holdSb!);
    writeStack(billing, holdSb!);
    cleanupStack.push(() => devtrees(login, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(login, ["down"]));
    cleanupStack.push(() => devtrees(billing, ["down"]));
    const upWith = (wt: string, ...ns: string[]): CliResult =>
      devtrees(wt, ["up", "--json", "--wait-timeout", "30", ...ns.flatMap((n) => ["-n", n])]);

    // login does not select db-shared: the shared instance runs pg only.
    const first = upWith(login, "app");
    expect(first.code, `login up: ${first.stderr}`).toBe(0);
    expect((first.doc as UpDoc).up.shared_started).toBe(true);
    expect(await waitForPid(holdPg!, 10_000), "pg should be running").toBe(true);
    expect(pidsMatching(holdSb!)).toEqual([]);
    const pgPids = pidsMatching(holdPg!);

    // billing selects it: it is added to the running shared instance, and pg
    // keeps running as the same process.
    const second = upWith(billing, "app", "db-shared");
    expect(second.code, `billing up: ${second.stderr}`).toBe(0);
    const secondUp = (second.doc as UpDoc & { up: { shared_activated: string[] } }).up;
    expect(secondUp.shared_started).toBe(false);
    expect(secondUp.shared_activated).toEqual(["sb"]);
    expect(await waitForPid(holdSb!, 10_000), "sb should be running").toBe(true);
    expect(pidsMatching(holdPg!)).toEqual(pgPids);
    expect(secondUp.env.SB_PORT).toBe((first.doc as UpDoc).up.env.SB_PORT);

    // A branch that edits sb: an up that does not select it is unaffected...
    writeStack(login, holdSbEdited!);
    const unaffected = upWith(login, "app");
    expect(unaffected.code, `scoped drift should not block: ${unaffected.stderr}`).toBe(0);

    // ...and one that selects it fails SHARED_DRIFT naming sb alone, touching nothing.
    writeStack(billing, holdSbEdited!);
    const blocked = upWith(billing, "app", "db-shared");
    expect(blocked.code).not.toBe(0);
    const err = (
      blocked.doc as { error: { code: string; details: { services: Array<{ service: string }> } } }
    ).error;
    expect(err.code).toBe("SHARED_DRIFT");
    expect(err.details.services.map((s) => s.service)).toEqual(["sb"]);
    expect(pidsMatching(holdPg!)).toEqual(pgPids);
  }, 120_000);
});

/**
 * Dead shared services are restarted by `up` (#240, ADR-0008) against the
 * real binary: `process start` on the shared socket, under the shared lock,
 * health-waited, and never touching a running shared service.
 */
describe.skipIf(!ENABLED)("real-pc smoke — restarting dead shared services (#240)", () => {
  interface SharedRestartUp {
    readonly up: { readonly env: Record<string, string>; readonly shared_restarted: string[] };
  }
  interface ErrorDoc {
    readonly error?: { code?: string; message?: string; details?: Record<string, unknown> };
  }

  /**
   * Two worktrees (`login`, `billing`) over one stack: shared `pg` (an HTTP
   * server with a readiness probe; argv `--directory <root>/pgdir`), shared
   * `cache` (a sleeper), shared `crasher` (a sleeper that exits 4 once
   * `<root>/crash-armed` exists) and an isolated `web`. Both worktrees are up.
   */
  function sharedStack(prefix: string) {
    const repo = buildSmokeRepo(prefix, ["login", "billing"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const login = repo.worktrees.login!;
    const billing = repo.worktrees.billing!;
    const pgDir = join(repo.root, "pgdir");
    mkdirSync(pgDir, { recursive: true });
    const armed = join(repo.root, "crash-armed");
    const yaml = [
      "services:",
      "  pg:",
      "    tier: shared",
      // Slow to serve (3s), like a database warming up: the window in which
      // pg runs but its probe has not passed is what scenario 122 races.
      `    command: "sh -c 'sleep 3; exec python3 -m http.server $PG_PORT --bind 127.0.0.1 --directory ${pgDir}'"`,
      "    ports: [PG_PORT]",
      "    readiness_probe:",
      "      exec:",
      `        command: "sh -c 'curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$PG_PORT/'"`,
      "      initial_delay_seconds: 1",
      "      period_seconds: 1",
      "      timeout_seconds: 3",
      "      failure_threshold: 30",
      "  cache:",
      "    tier: shared",
      `    command: "python3 ${sleeper(repo.root, "cache")}"`,
      "  crasher:",
      "    tier: shared",
      `    command: "python3 ${sleeper(repo.root, "crasher", armed)}"`,
      "  web:",
      "    tier: isolated",
      `    command: "python3 ${sleeper(repo.root, "web")}"`,
      "",
    ].join("\n");
    writeFileSync(join(login, "devtrees.yaml"), yaml);
    writeFileSync(join(billing, "devtrees.yaml"), yaml);
    cleanupStack.push(() => devtrees(login, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(login, ["down"]));
    cleanupStack.push(() => devtrees(billing, ["down"]));
    const needles = {
      pg: `--directory ${pgDir}`,
      cache: join(repo.root, "cache.py"),
      crasher: join(repo.root, "crasher.py"),
      web: join(repo.root, "web.py"),
    };
    return { repo, login, billing, armed, needles };
  }

  const upJson = (wt: string, timeout = "60"): CliResult =>
    devtrees(wt, ["up", "--json", "--wait-timeout", timeout]);

  async function bothUp(s: ReturnType<typeof sharedStack>): Promise<number> {
    const first = upJson(s.login);
    expect(first.code, `login up: ${first.stderr} ${first.stdout}`).toBe(0);
    const second = upJson(s.billing);
    expect(second.code, `billing up: ${second.stderr} ${second.stdout}`).toBe(0);
    const port = Number((first.doc as SharedRestartUp).up.env.PG_PORT);
    expect(await httpStatusWithin(port, 10_000)).toBe(200);
    return port;
  }

  async function kill(needle: string): Promise<void> {
    const pids = pidsMatching(needle);
    expect(pids.length, `${needle} should be running`).toBeGreaterThan(0);
    reapPids(pids);
    expect(await waitForNoPids(needle, 5000)).toEqual([]);
  }

  it("scenario 121: a killed shared service is restarted by another worktree's up; the other shared services keep their pids", async () => {
    const s = sharedStack("dt-rpc121-");
    const port = await bothUp(s);
    const cachePids = pidsMatching(s.needles.cache);
    const crasherPids = pidsMatching(s.needles.crasher);
    const webPids = pidsMatching(s.needles.web);

    await kill(s.needles.pg);
    expect(await httpStatus(port)).toBe(0);

    // billing restarts it and waits for its probe; nothing else is touched.
    const again = upJson(s.billing);
    expect(again.code, `billing re-up should restart pg: ${again.stderr} ${again.stdout}`).toBe(0);
    expect((again.doc as SharedRestartUp).up.shared_restarted).toEqual(["pg"]);
    expect(await httpStatusWithin(port, 5000)).toBe(200);
    expect(pidsMatching(s.needles.pg)).toHaveLength(1);
    expect(pidsMatching(s.needles.cache)).toEqual(cachePids);
    expect(pidsMatching(s.needles.crasher)).toEqual(crasherPids);
    expect(pidsMatching(s.needles.web)).toEqual(webPids);

    // Converged: login's up finds it running and restarts nothing.
    const login = upJson(s.login);
    expect(login.code, `login re-up: ${login.stderr}`).toBe(0);
    expect((login.doc as SharedRestartUp).up.shared_restarted).toEqual([]);
  }, 180_000);

  it("scenario 122: two concurrent ups from different worktrees restart the dead shared service once", async () => {
    const s = sharedStack("dt-rpc122-");
    const port = await bothUp(s);
    const cachePids = pidsMatching(s.needles.cache);
    await kill(s.needles.pg);

    // Each up, as soon as it exits 0, must find pg serving: the one that did
    // not restart it waits for its probe too, not just for it to run.
    const upThenProbe = async (wt: string) => {
      const r = await devtreesAsync(wt, ["up", "--json", "--wait-timeout", "60"]);
      return { r, status: await httpStatus(port) };
    };
    const results = await Promise.all([upThenProbe(s.login), upThenProbe(s.billing)]);
    for (const { r, status } of results) {
      expect(r.code, `concurrent up: ${r.stderr} ${r.stdout}`).toBe(0);
      expect(status, "pg must answer when up returns").toBe(200);
    }
    const restarted = results.map(({ r }) => (r.doc as SharedRestartUp).up.shared_restarted);
    expect(restarted.flat()).toEqual(["pg"]);
    expect(pidsMatching(s.needles.pg)).toHaveLength(1);
    expect(pidsMatching(s.needles.cache)).toEqual(cachePids);
  }, 180_000);

  it("scenario 123: a restarted shared service that dies straight away fails fast with SHARED_SERVICE_DEAD died_again", async () => {
    const s = sharedStack("dt-rpc123-");
    await bothUp(s);
    const cachePids = pidsMatching(s.needles.cache);
    writeFileSync(s.armed, "");
    await kill(s.needles.crasher);

    const started = Date.now();
    const again = upJson(s.billing);
    const elapsed = Date.now() - started;
    expect(again.code, `re-up should fail: ${again.stdout}`).toBe(1);
    const err = (again.doc as ErrorDoc).error;
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.message).toContain("crasher (Completed, exit 4)");
    expect(err?.message).toContain("died again");
    expect(err?.details).toMatchObject({
      dead_services: [{ name: "crasher", exit_code: 4 }],
      reason: "died_again",
      remedy: "devtrees down --shared && devtrees up",
    });
    // Fail-fast: the restarted corpse is not waited on for the full window.
    expect(elapsed).toBeLessThan(30_000);
    expect(pidsMatching(s.needles.cache)).toEqual(cachePids);
  }, 120_000);
});

/**
 * Stable shared ports (#238, ADR-0011) against the real binary: two branches
 * whose `devtrees.yaml` lay out the shared services differently — `login`
 * declares pg + x, `billing` pg + y + x, so by position login's X_PORT and
 * billing's Y_PORT share a slot — must agree on every shared port in either
 * activation order, and the numbers really are what gets bound.
 */
describe.skipIf(!ENABLED)("real-pc smoke — stable shared ports (#238)", () => {
  interface PortsUp {
    readonly up: {
      readonly env: Record<string, string>;
      readonly shared_activated: string[];
      readonly shared_started: boolean;
    };
  }

  /** A two-branch repo: `login` (pg + x) and `billing` (pg + y + x). */
  function crossBranchRepo(prefix: string) {
    const repo = buildSmokeRepo(prefix, ["login", "billing"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const login = repo.worktrees.login!;
    const billing = repo.worktrees.billing!;
    const holdPg = join(repo.root, "hold-pg");
    const holdApi = join(repo.root, "hold-api");
    writeFileSync(holdApi, "");
    writeFileSync(holdPg, "");
    const http = (port: string): string =>
      `    command: "python3 -m http.server $${port} --bind 127.0.0.1 --directory ${repo.root}"`;
    const svc = (name: string, ns: string, port: string): string[] => [
      `  ${name}:`,
      "    tier: shared",
      `    namespace: ${ns}`,
      http(port),
      `    ports: [${port}]`,
    ];
    const common = [
      "  pg:",
      "    tier: shared",
      `    command: "tail -f ${holdPg}"`,
      "    ports: [PG_PORT]",
    ];
    const api = [
      "  api:",
      "    namespace: app",
      `    command: "tail -f ${holdApi}"`,
      "    ports: [API_PORT]",
    ];
    const yaml = (lines: string[]) => ["services:", ...lines, ""].join("\n");
    writeFileSync(
      join(login, "devtrees.yaml"),
      yaml([...common, ...svc("x", "xs", "X_PORT"), ...api]),
    );
    writeFileSync(
      join(billing, "devtrees.yaml"),
      yaml([...common, ...svc("y", "ys", "Y_PORT"), ...svc("x", "xs", "X_PORT"), ...api]),
    );
    cleanupStack.push(() => devtrees(login, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(login, ["down"]));
    cleanupStack.push(() => devtrees(billing, ["down"]));
    const upWith = (wt: string, ...ns: string[]): CliResult =>
      devtrees(wt, ["up", "--json", "--wait-timeout", "30", ...ns.flatMap((n) => ["-n", n])]);
    return { repo, login, billing, holdPg, upWith };
  }

  const envOf = (r: CliResult): Record<string, string> => (r.doc as PortsUp).up.env;

  for (const order of ["login first", "billing first"] as const) {
    const n = order === "login first" ? "130a" : "130b";
    it(`scenario ${n}: different shared layouts agree on every shared port (${order})`, async () => {
      const { login, billing, upWith } = crossBranchRepo(`dt-rpc${n}-`);
      // login never selects xs, billing activates y: the issue's case 1.
      const steps =
        order === "login first"
          ? [() => upWith(login, "app"), () => upWith(billing, "app", "ys")]
          : [() => upWith(billing, "app", "ys"), () => upWith(login, "app")];
      const results = steps.map((step) => step());
      for (const r of results) expect(r.code, `up: ${r.stderr}`).toBe(0);
      const [loginUp, billingUp] = order === "login first" ? results : [results[1], results[0]];
      const loginEnv = envOf(loginUp!);
      const billingEnv = envOf(billingUp!);
      expect(loginEnv.X_PORT).toBe(billingEnv.X_PORT);
      expect(loginEnv.PG_PORT).toBe(billingEnv.PG_PORT);
      expect(billingEnv.Y_PORT).not.toBe(billingEnv.X_PORT);

      // y really binds Y_PORT, and nothing answers on the X_PORT login was given.
      expect(await waitForListener(Number(billingEnv.Y_PORT), 10_000), "y listens").toBe(true);
      expect(await waitForListener(Number(loginEnv.X_PORT), 500), "X_PORT still free").toBe(false);

      // Activating x from login binds exactly the number both branches injected.
      const activated = upWith(login, "app", "xs");
      expect(activated.code, `activate x: ${activated.stderr}`).toBe(0);
      expect((activated.doc as PortsUp).up.shared_activated).toEqual(["x"]);
      expect(envOf(activated).X_PORT).toBe(loginEnv.X_PORT);
      expect(await waitForListener(Number(loginEnv.X_PORT), 10_000), "x listens").toBe(true);

      // env --json from billing reports both as active now.
      const env = devtrees(billing, ["env", "--json"]);
      const origins = (env.doc as { shared_ports: Record<string, { origin: string }> })
        .shared_ports;
      expect(origins.X_PORT?.origin).toBe("active");
      expect(origins.Y_PORT?.origin).toBe("active");
    }, 120_000);
  }

  it("scenario 131: a shared instance with no map (0.4.0) is seeded from its live ports, with no restart and no drift", async () => {
    const { repo, login, billing, holdPg, upWith } = crossBranchRepo("dt-rpc131-");
    const first = upWith(login, "app");
    expect(first.code, `login up: ${first.stderr}`).toBe(0);
    expect(await waitForPid(holdPg, 10_000), "pg should be running").toBe(true);
    const pgPids = pidsMatching(`tail -f ${holdPg}`);
    // What a 0.4.0 instance leaves behind: shared state, but no map.
    const mapPath = join(repo.root, "main", ".git", "devtrees", "shared-ports.json");
    expect(existsSync(mapPath)).toBe(true);
    rmSync(mapPath);

    const second = upWith(billing, "app");
    expect(second.code, `billing up: ${second.stderr}`).toBe(0);
    expect((second.doc as PortsUp).up.shared_started).toBe(false);
    expect(pidsMatching(`tail -f ${holdPg}`)).toEqual(pgPids);
    expect(envOf(second).PG_PORT).toBe(envOf(first).PG_PORT);
    // login's X_PORT prediction was in pg's env, so it is the number kept.
    expect(envOf(second).X_PORT).toBe(envOf(first).X_PORT);
    const recorded = JSON.parse(readFileSync(mapPath, "utf8")) as { ports: Record<string, number> };
    expect(recorded.ports.PG_PORT).toBe(Number(envOf(first).PG_PORT));
    expect(recorded.ports.X_PORT).toBe(Number(envOf(first).X_PORT));
  }, 120_000);

  it("scenario 133: a shared instance the real devtrees@0.4.0 started is seeded by this build, with no restart", async (ctx) => {
    // The published 0.4.0: the real pre-#238 writer of the shared state, not
    // a simulation of it (`legacyCli040`: installed by CI's setup step, or
    // here with retries; a registry that never answers skips loudly locally
    // and fails in CI).
    const legacyCli = await legacyCli040();
    if (typeof legacyCli !== "string") {
      ctx.skip(legacyCli.skipped);
      return;
    }
    const legacy = (cwd: string, args: ReadonlyArray<string>): CliResult => {
      const out = spawnSync(process.execPath, [legacyCli, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
      });
      let doc: unknown;
      try {
        doc = JSON.parse(out.stdout);
      } catch {
        doc = undefined;
      }
      return { code: out.status ?? -1, stdout: out.stdout, stderr: out.stderr, doc };
    };
    const { repo, login, billing, holdPg, upWith } = crossBranchRepo("dt-rpc133-");

    // 0.4.0 boots login: pg only, with its positional X_PORT prediction in pg's env.
    const old = legacy(login, ["up", "--json", "--wait-timeout", "30", "-n", "app"]);
    expect(old.code, `0.4.0 up: ${old.stderr}`).toBe(0);
    expect(await waitForPid(holdPg, 10_000), "pg should be running").toBe(true);
    const pgPids = pidsMatching(`tail -f ${holdPg}`);
    const mapPath = join(repo.root, "main", ".git", "devtrees", "shared-ports.json");
    expect(existsSync(mapPath), "0.4.0 writes no map").toBe(false);
    const oldEnv = envOf(old);

    // This build, from billing (whose layout puts Y_PORT on that same slot):
    // it seeds the map from 0.4.0's live numbers and restarts nothing.
    const next = upWith(billing, "app", "ys");
    expect(next.code, `PR build up: ${next.stderr}`).toBe(0);
    expect((next.doc as PortsUp).up.shared_started).toBe(false);
    expect(pidsMatching(`tail -f ${holdPg}`)).toEqual(pgPids);
    const nextEnv = envOf(next);
    expect(nextEnv.PG_PORT).toBe(oldEnv.PG_PORT);
    expect(nextEnv.X_PORT).toBe(oldEnv.X_PORT);
    expect(nextEnv.Y_PORT).not.toBe(oldEnv.X_PORT);
    expect(await waitForListener(Number(nextEnv.Y_PORT), 10_000), "y listens").toBe(true);

    // Activating x from login binds the number 0.4.0 injected.
    const activated = upWith(login, "app", "xs");
    expect(activated.code, `activate x: ${activated.stderr}`).toBe(0);
    expect(envOf(activated).X_PORT).toBe(oldEnv.X_PORT);
    expect(await waitForListener(Number(oldEnv.X_PORT), 10_000), "x listens").toBe(true);
  }, 240_000);

  it("scenario 132: a recorded port another name holds fails SHARED_PORT_CONFLICT and starts nothing", async () => {
    const { repo, login, billing, upWith } = crossBranchRepo("dt-rpc132-");
    const first = upWith(billing, "app", "ys");
    expect(first.code, `billing up: ${first.stderr}`).toBe(0);
    const yPort = Number(envOf(first).Y_PORT);
    const mapPath = join(repo.root, "main", ".git", "devtrees", "shared-ports.json");
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { ports: Record<string, number> };
    map.ports.X_PORT = yPort;
    writeFileSync(mapPath, JSON.stringify(map));

    const blocked = upWith(login, "app", "xs");
    expect(blocked.code).not.toBe(0);
    const err = (blocked.doc as { error: { code: string; details: { conflicts: unknown[] } } })
      .error;
    expect(err.code).toBe("SHARED_PORT_CONFLICT");
    expect(err.details.conflicts).toContainEqual(
      expect.objectContaining({ reason: "port_taken", port: yPort }),
    );
    const ls = devtrees(login, ["ls", "--json", "--services"]);
    const sharedRow = (
      ls.doc as { ls: { instances: Array<{ kind: string; services: Array<{ name: string }> }> } }
    ).ls.instances.find((i) => i.kind === "shared");
    expect(sharedRow?.services.map((s) => s.name).sort()).toEqual(["pg", "y"]);
  }, 120_000);
});

/**
 * `down --shared -n` (#239, ADR-0012) against the real binary: the named
 * namespaces' shared services are stopped and removed by a config reload
 * that leaves the other shared services running, and a later `up -n`
 * adds them back fresh.
 */
describe.skipIf(!ENABLED)("real-pc smoke — namespaced shared teardown (#239)", () => {
  interface NsDownDoc {
    readonly down: {
      readonly stopped: boolean;
      readonly services: string[];
      readonly inactive_namespaces: string[];
      readonly instance_stopped: boolean;
      readonly forced_dependants: Array<{ instance: string; service: string | null }>;
    };
  }
  interface NsUpDoc {
    readonly up: {
      readonly env: Record<string, string>;
      readonly shared_started: boolean;
      readonly shared_activated: string[];
    };
  }
  interface ErrDoc {
    readonly error: { code: string; details: Record<string, unknown> };
  }

  /**
   * Two worktrees over one stack: always-on shared `pg`, shared `sa` in
   * namespace `a` and `sb` in `b`, an isolated `web` in `app`, and an
   * isolated `worker` in `a` that `depends_on: sa`. Every process is a
   * `tail -f <hold file>`, so its argv identifies it.
   */
  function nsStack(prefix: string) {
    const repo = buildSmokeRepo(prefix, ["login", "billing"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const hold = (n: string): string => {
      const path = join(repo.root, `hold-${n}`);
      writeFileSync(path, "");
      return path;
    };
    const holds = {
      pg: hold("pg"),
      sa: hold("sa"),
      sa2: hold("edited"),
      sb: hold("sb"),
      web: hold("web"),
      worker: hold("worker"),
    };
    const write = (wt: string, saHold: string): void =>
      writeFileSync(
        join(wt, "devtrees.yaml"),
        [
          "services:",
          "  pg:",
          "    tier: shared",
          `    command: "tail -f ${holds.pg}"`,
          "    ports: [PG_PORT]",
          "  sa:",
          "    tier: shared",
          "    namespace: a",
          `    command: "tail -f ${saHold}"`,
          "    ports: [SA_PORT]",
          "  sb:",
          "    tier: shared",
          "    namespace: b",
          `    command: "tail -f ${holds.sb}"`,
          "    ports: [SB_PORT]",
          "  web:",
          "    tier: isolated",
          "    namespace: app",
          `    command: "tail -f ${holds.web}"`,
          "    ports: [WEB_PORT]",
          "  worker:",
          "    tier: isolated",
          "    namespace: a",
          `    command: "tail -f ${holds.worker}"`,
          "    depends_on:",
          "      sa:",
          "        condition: process_started",
          "",
        ].join("\n"),
      );
    const login = repo.worktrees.login!;
    const billing = repo.worktrees.billing!;
    write(login, holds.sa);
    write(billing, holds.sa);
    cleanupStack.push(() => devtrees(login, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(login, ["down"]));
    cleanupStack.push(() => devtrees(billing, ["down"]));
    return { login, billing, holds, write };
  }

  const upWith = (wt: string, ...ns: string[]): CliResult =>
    devtrees(wt, ["up", "--json", "--wait-timeout", "30", ...ns.flatMap((n) => ["-n", n])]);
  const nsDown = (wt: string, ...args: string[]): CliResult =>
    devtrees(wt, ["down", "--shared", "--json", ...args]);
  const anchorOf = (wt: string): string =>
    execGit(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  it("scenario 124: down --shared -n a stops only a's shared services; b's keep their pids and ports, and up -n a adds a back fresh with no SHARED_DRIFT", async () => {
    const s = nsStack("dt-rpc124-");
    const first = upWith(s.billing, "app", "b");
    expect(first.code, `billing up: ${first.stderr}`).toBe(0);
    const second = upWith(s.login, "app", "a");
    expect(second.code, `login up: ${second.stderr}`).toBe(0);
    expect((second.doc as NsUpDoc).up.shared_activated).toEqual(["sa"]);
    for (const h of [s.holds.pg, s.holds.sa, s.holds.sb]) {
      expect(await waitForPid(h, 10_000), `${h} should run`).toBe(true);
    }
    // login's worker depends on sa: take login down first, so nothing does.
    expect(devtrees(s.login, ["down", "--json"]).code).toBe(0);

    // A worktree with a lifecycle command in flight (its lock held by a live
    // process, no socket yet) shows as blocking in the dry run, which does not wait.
    const inFlight = join(anchorOf(s.login), "devtrees", `${deriveWorktreeId("/x/racer")}.lock`);
    writeFileSync(inFlight, `${process.pid}\n`);
    const racing = nsDown(s.login, "-n", "a", "--dry-run");
    expect((racing.doc as { down_dry_run: unknown }).down_dry_run).toMatchObject({
      blocked: true,
      dependants: [{ source: "lifecycle_in_progress", service: null }],
    });
    rmSync(inFlight, { force: true });
    const pg = pidsMatching(s.holds.pg);
    const sb = pidsMatching(s.holds.sb);
    const saPort = (second.doc as NsUpDoc).up.env.SA_PORT;
    const sbPort = (first.doc as NsUpDoc).up.env.SB_PORT;

    // The dry run previews it and changes nothing.
    const dry = nsDown(s.login, "-n", "a", "-n", "nope", "--dry-run");
    expect(dry.code, dry.stdout).toBe(0);
    expect((dry.doc as { down_dry_run: unknown }).down_dry_run).toMatchObject({
      running: true,
      services: ["sa"],
      inactive_namespaces: ["nope"],
      would_stop_instance: false,
      dependants: [],
      blocked: false,
    });
    expect(pidsMatching(s.holds.sa)).toHaveLength(1);

    const down = nsDown(s.login, "-n", "a", "-n", "nope");
    expect(down.code, `down --shared -n a: ${down.stdout} ${down.stderr}`).toBe(0);
    expect((down.doc as NsDownDoc).down).toMatchObject({
      stopped: true,
      services: ["sa"],
      inactive_namespaces: ["nope"],
      instance_stopped: false,
      forced_dependants: [],
    });
    expect(await waitForNoPids(s.holds.sa)).toEqual([]);
    expect(pidsMatching(s.holds.pg)).toEqual(pg);
    expect(pidsMatching(s.holds.sb)).toEqual(sb);

    // b is untouched: billing's re-up adds nothing and injects the same port.
    const again = upWith(s.billing, "app", "b");
    expect(again.code, `billing re-up: ${again.stderr}`).toBe(0);
    expect((again.doc as NsUpDoc).up.shared_activated).toEqual([]);
    expect((again.doc as NsUpDoc).up.env.SB_PORT).toBe(sbPort);
    expect(pidsMatching(s.holds.sb)).toEqual(sb);

    // A retry is a no-op.
    const retry = nsDown(s.login, "-n", "a");
    expect(retry.code).toBe(0);
    expect((retry.doc as NsDownDoc).down).toMatchObject({ stopped: false, services: [] });

    // The stable port map (#238) still holds sa's number, but nothing binds it.
    type EnvDoc = { shared_ports: Record<string, { port: number; origin: string }> };
    const between = devtrees(s.login, ["env", "--json"]);
    expect(between.code, between.stdout).toBe(0);
    expect((between.doc as EnvDoc).shared_ports.SA_PORT).toEqual({
      port: Number(saPort),
      origin: "recorded",
    });

    // login now defines sa differently: the drift record went with it, so
    // up -n a adds the new definition, on the same port, with no SHARED_DRIFT.
    s.write(s.login, s.holds.sa2);
    const back = upWith(s.login, "app", "a");
    expect(back.code, `login up -n a: ${back.stdout} ${back.stderr}`).toBe(0);
    expect((back.doc as NsUpDoc).up.shared_activated).toEqual(["sa"]);
    expect((back.doc as NsUpDoc).up.env.SA_PORT).toBe(saPort);
    expect(await waitForPid(s.holds.sa2, 10_000), "the new sa should run").toBe(true);
    const after = devtrees(s.login, ["env", "--json"]);
    expect((after.doc as EnvDoc).shared_ports.SA_PORT).toEqual({
      port: Number(saPort),
      origin: "active",
    });
    expect(pidsMatching(s.holds.sa)).toEqual([]);
    expect(pidsMatching(s.holds.pg)).toEqual(pg);
    expect(pidsMatching(s.holds.sb)).toEqual(sb);
  }, 180_000);

  it("scenario 125: a running worktree that depends on a's shared service blocks it with SHARED_IN_USE; --force removes it anyway", async () => {
    const s = nsStack("dt-rpc125-");
    const up = upWith(s.login, "app", "a");
    expect(up.code, `login up: ${up.stderr}`).toBe(0);
    expect(await waitForPid(s.holds.worker, 10_000), "worker should run").toBe(true);
    const sa = pidsMatching(s.holds.sa);
    const worker = pidsMatching(s.holds.worker);
    const id = wtId(s.login);

    const dry = nsDown(s.billing, "-n", "a", "--dry-run");
    expect(dry.code, dry.stdout).toBe(0);
    expect((dry.doc as { down_dry_run: unknown }).down_dry_run).toMatchObject({
      services: ["sa"],
      dependants: [
        { instance: id, service: "worker", depends_on: ["sa"], source: "derived_config" },
      ],
      blocked: true,
    });

    const refused = nsDown(s.billing, "-n", "a");
    expect(refused.code).not.toBe(0);
    const err = (refused.doc as ErrDoc).error;
    expect(err.code).toBe("SHARED_IN_USE");
    expect(err.details).toMatchObject({
      services: ["sa"],
      dependants: [{ instance: id, service: "worker", depends_on: ["sa"] }],
      forceable: true,
    });
    expect(pidsMatching(s.holds.sa)).toEqual(sa);

    const forced = nsDown(s.billing, "-n", "a", "--force");
    expect(forced.code, `--force: ${forced.stdout}`).toBe(0);
    expect((forced.doc as NsDownDoc).down).toMatchObject({
      stopped: true,
      services: ["sa"],
      instance_stopped: false,
      forced_dependants: [{ instance: id, service: "worker" }],
    });
    expect(await waitForNoPids(s.holds.sa)).toEqual([]);
    // The dependant itself is not touched; pg keeps the shared instance up.
    expect(pidsMatching(s.holds.worker)).toEqual(worker);
    expect(pidsMatching(s.holds.pg)).toHaveLength(1);
  }, 180_000);

  it("scenario 127: an up re-adding a service a timed-out removal left stopped in process-compose starts it again", async () => {
    const s = nsStack("dt-rpc127-");
    expect(upWith(s.billing, "app", "b").code).toBe(0);
    expect(upWith(s.login, "app", "a").code).toBe(0);
    expect(await waitForPid(s.holds.sa, 10_000), "sa should run").toBe(true);
    expect(devtrees(s.login, ["down"]).code).toBe(0);
    const pg = pidsMatching(s.holds.pg);
    const sb = pidsMatching(s.holds.sb);

    // What a removing reload that timed out and never landed leaves: sa stopped
    // and still in the project, gone from the derived config and the state.
    const anchor = anchorOf(s.login);
    const shared = sharedInstancePaths(anchor);
    const stop = spawnSync("process-compose", [
      "process",
      "stop",
      "sa",
      "-U",
      "-u",
      shared.socketPath,
    ]);
    expect(stop.status, String(stop.stderr)).toBe(0);
    expect(await waitForNoPids(s.holds.sa)).toEqual([]);
    const config = parseYaml(readFileSync(shared.configPath, "utf8")) as {
      processes: Record<string, unknown>;
    };
    delete config.processes.sa;
    writeFileSync(shared.configPath, stringifyYaml(config));
    const statePath = join(anchor, "devtrees", "shared-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      services: Record<string, unknown>;
    };
    delete state.services.sa;
    writeFileSync(statePath, JSON.stringify(state));

    const back = upWith(s.login, "app", "a");
    expect(back.code, `re-up: ${back.stdout} ${back.stderr}`).toBe(0);
    const doc = back.doc as NsUpDoc & { up: { shared_restarted: string[] } };
    expect(doc.up.shared_activated).toEqual(["sa"]);
    expect(doc.up.shared_restarted).toEqual(["sa"]);
    expect(await waitForPid(s.holds.sa, 10_000), "sa should run again").toBe(true);
    expect(pidsMatching(s.holds.pg)).toEqual(pg);
    expect(pidsMatching(s.holds.sb)).toEqual(sb);
  }, 180_000);

  it("scenario 128: the teardown waits for a worktree's in-flight lifecycle command, then goes ahead", async () => {
    const s = nsStack("dt-rpc128-");
    expect(upWith(s.billing, "app", "b").code).toBe(0);
    expect(upWith(s.login, "app", "a").code).toBe(0);
    expect(devtrees(s.login, ["down"]).code).toBe(0);
    const lock = join(anchorOf(s.login), "devtrees", `${deriveWorktreeId("/x/racer")}.lock`);
    writeFileSync(lock, `${process.pid}\n`);
    const started = Date.now();
    const pending = devtreesAsync(s.login, ["down", "--shared", "--json", "-n", "a"]);
    setTimeout(() => rmSync(lock, { force: true }), 2000);
    const down = await pending;
    expect(down.code, `down: ${down.stdout} ${down.stderr}`).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect((down.doc as NsDownDoc).down).toMatchObject({ stopped: true, services: ["sa"] });
    expect(await waitForNoPids(s.holds.sa)).toEqual([]);
  }, 180_000);

  it("scenario 134: the teardown does not wait for an in-flight command whose shared-step marker names none of its targets", async () => {
    const s = nsStack("dt-rpc134-");
    expect(upWith(s.billing, "app", "b").code).toBe(0);
    expect(upWith(s.login, "app", "a").code).toBe(0);
    expect(devtrees(s.login, ["down"]).code).toBe(0);
    // A worktree mid-`up`, past its shared step, which selected only pg and sb.
    const dir = join(anchorOf(s.login), "devtrees");
    const racer = deriveWorktreeId("/x/racer");
    const lock = join(dir, `${racer}.lock`);
    writeFileSync(lock, `${process.pid}\n`);
    cleanupStack.push(() => rmSync(lock, { force: true }));
    const marker = join(dir, `${racer}.shared-step.json`);
    writeFileSync(
      marker,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        lock_ino: statSync(lock).ino,
        services: ["pg", "sb"],
        ports: ["PG_PORT", "SA_PORT", "SB_PORT"],
      }),
    );
    const down = nsDown(s.login, "-n", "a");
    expect(down.code, `down: ${down.stdout} ${down.stderr}`).toBe(0);
    expect((down.doc as NsDownDoc).down).toMatchObject({ stopped: true, services: ["sa"] });
    // It never waited for the lock, which is still held.
    expect(existsSync(lock)).toBe(true);
    expect(await waitForNoPids(s.holds.sa)).toEqual([]);
    // prune --shared-ports goes ahead beside it too, and keeps what it injects.
    const prune = devtrees(s.login, ["prune", "--shared-ports", "--json"]);
    expect(prune.code, `prune: ${prune.stderr}`).toBe(0);
    expect(
      (prune.doc as { prune_shared_ports: { kept: string[] } }).prune_shared_ports.kept,
    ).toEqual(expect.arrayContaining(["PG_PORT", "SA_PORT", "SB_PORT"]));
  }, 180_000);

  it("scenario 136: the teardown waits for an in-flight up whose isolated service depends on a target in a namespace it did not select", async () => {
    const s = nsStack("dt-rpc136-");
    // `api` (ns app) depends on `sa` (ns a): `-n app` never selects `sa`
    // (ADR-0010), but `api` starts against it.
    writeFileSync(
      join(s.login, "devtrees.yaml"),
      `${readFileSync(join(s.login, "devtrees.yaml"), "utf8")}  api:\n    tier: isolated\n` +
        `    namespace: app\n    command: "tail -f ${s.holds.web}-api"\n    depends_on:\n` +
        `      sa:\n        condition: process_started\n`,
    );
    writeFileSync(`${s.holds.web}-api`, "");
    expect(upWith(s.billing, "app", "b").code).toBe(0);
    expect(upWith(s.login, "app", "a").code).toBe(0);
    expect(devtrees(s.login, ["down"]).code).toBe(0);
    // A worktree mid-`up -n app` of this layout, holding its lock past its
    // shared step. Its marker is what that `up` writes: pg (selected) and sa
    // (api's cross-tier edge); the unit suite pins that content against
    // runUp. Here the real teardown must wait for it.
    const dir = join(anchorOf(s.login), "devtrees");
    const racer = deriveWorktreeId("/x/racer");
    const lock = join(dir, `${racer}.lock`);
    writeFileSync(lock, `${process.pid}\n`);
    cleanupStack.push(() => rmSync(lock, { force: true }));
    writeFileSync(
      join(dir, `${racer}.shared-step.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        lock_ino: statSync(lock).ino,
        services: ["pg", "sa"],
        ports: ["PG_PORT", "SA_PORT", "SB_PORT"],
      }),
    );
    const started = Date.now();
    const pending = devtreesAsync(s.login, ["down", "--shared", "--json", "-n", "a"]);
    setTimeout(() => rmSync(lock, { force: true }), 2000);
    const down = await pending;
    expect(down.code, `down: ${down.stdout} ${down.stderr}`).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect((down.doc as NsDownDoc).down).toMatchObject({ stopped: true, services: ["sa"] });
  }, 180_000);

  it("scenario 135: up repairs an invalid map entry; prune --shared-ports previews with --dry-run and drops a stopped name recorded outside the block", async () => {
    const s = nsStack("dt-rpc135-");
    expect(upWith(s.login, "app", "b").code).toBe(0);
    const mapPath = join(anchorOf(s.login), "devtrees", "shared-ports.json");
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
      version: 1;
      ports: Record<string, number>;
    };

    // An invalid entry: warned about once, and gone after the next `up`.
    writeFileSync(mapPath, JSON.stringify({ ...map, ports: { ...map.ports, BAD_PORT: "x" } }));
    const up = upWith(s.login, "app", "b");
    expect(up.code, `up: ${up.stderr}`).toBe(0);
    expect(up.stderr).toContain("ignoring invalid entry BAD_PORT");
    expect(JSON.parse(readFileSync(mapPath, "utf8"))).toEqual(map);
    expect(devtrees(s.login, ["env"]).stderr).not.toContain("BAD_PORT");

    // SA_PORT recorded outside the block (a `port_base` change, say), with
    // nothing running: the warning names its remedy, and the remedy works.
    expect(devtrees(s.login, ["down"]).code).toBe(0);
    expect(devtrees(s.login, ["down", "--shared"]).code).toBe(0);
    writeFileSync(mapPath, JSON.stringify({ ...map, ports: { ...map.ports, SA_PORT: 7 } }));
    const warned = devtrees(s.login, ["env"]);
    expect(warned.stderr).toContain("SA_PORT=7 is recorded outside the shared block");
    expect(warned.stderr).toContain("devtrees prune --shared-ports");

    const preview = devtrees(s.login, ["prune", "--shared-ports", "--dry-run", "--json"]);
    expect(preview.code, `dry run: ${preview.stderr}`).toBe(0);
    const previewed = (
      preview.doc as {
        prune_shared_ports: { dropped: string[]; out_of_block: string[]; dry_run: boolean };
      }
    ).prune_shared_ports;
    expect(previewed.dry_run).toBe(true);
    expect(previewed.out_of_block).toEqual(["SA_PORT"]);
    expect(previewed.dropped).toContain("SA_PORT");
    expect(JSON.parse(readFileSync(mapPath, "utf8")).ports.SA_PORT).toBe(7);

    const pruned = devtrees(s.login, ["prune", "--shared-ports", "--json"]);
    expect(pruned.code, `prune: ${pruned.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(mapPath, "utf8")).ports.SA_PORT).toBeUndefined();
    expect(devtrees(s.login, ["env"]).stderr).not.toContain("outside the shared block");
    const again = upWith(s.login, "app", "a");
    expect(again.code, `up: ${again.stderr}`).toBe(0);
    expect(again.stderr).not.toContain("outside the shared block");
    const sa = JSON.parse(readFileSync(mapPath, "utf8")).ports.SA_PORT as number;
    expect(sa).not.toBe(7);
    expect(await waitForPid(s.holds.sa, 10_000), "sa runs").toBe(true);
  }, 180_000);

  it("scenario 129: the namespaced SHARED_DRIFT remedy succeeds when followed literally, though every worktree depends on the service", async () => {
    const s = nsStack("dt-rpc129-");
    expect(upWith(s.billing, "app", "a").code).toBe(0);
    expect(upWith(s.login, "app", "a").code).toBe(0);
    const pg = pidsMatching(s.holds.pg);
    // login edits sa: its up fails SHARED_DRIFT with a namespaced remedy.
    s.write(s.login, s.holds.sa2);
    const drifted = upWith(s.login, "app", "a");
    expect(drifted.code).not.toBe(0);
    const err = (drifted.doc as ErrDoc).error;
    expect(err.code).toBe("SHARED_DRIFT");
    const remedy = String(err.details.remedy);
    expect(remedy).toBe("devtrees down --shared -n a --force && devtrees up -n app -n a");
    // Run it exactly as printed (with the built CLI standing in for `devtrees`).
    const cli = `'${process.execPath}' '${CLI}'`;
    const run = spawnSync("sh", ["-c", remedy.replaceAll("devtrees ", `${cli} `)], {
      cwd: s.login,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(run.status, `remedy: ${run.stdout} ${run.stderr}`).toBe(0);
    expect(await waitForPid(s.holds.sa2, 10_000), "the new sa should run").toBe(true);
    expect(pidsMatching(s.holds.sa)).toEqual([]);
    expect(pidsMatching(s.holds.pg)).toEqual(pg);
  }, 180_000);

  it("scenario 126: removing the last running shared services stops the shared instance, as down --shared does", async () => {
    const repo = buildSmokeRepo("dt-rpc126-", ["login"]);
    currentCtx = { pidNeedle: repo.root, root: repo.root };
    const login = repo.worktrees.login!;
    const holdSa = join(repo.root, "hold-sa");
    const holdWeb = join(repo.root, "hold-web");
    for (const h of [holdSa, holdWeb]) writeFileSync(h, "");
    writeFileSync(
      join(login, "devtrees.yaml"),
      [
        "services:",
        "  sa:",
        "    tier: shared",
        "    namespace: a",
        `    command: "tail -f ${holdSa}"`,
        "    ports: [SA_PORT]",
        "  web:",
        "    tier: isolated",
        `    command: "tail -f ${holdWeb}"`,
        "",
      ].join("\n"),
    );
    cleanupStack.push(() => devtrees(login, ["down", "--shared"]));
    cleanupStack.push(() => devtrees(login, ["down"]));
    const up = upWith(login, "default", "a");
    expect(up.code, `up: ${up.stderr}`).toBe(0);
    expect(await waitForPid(holdSa, 10_000)).toBe(true);

    const dry = nsDown(login, "-n", "a", "--dry-run");
    expect((dry.doc as { down_dry_run: unknown }).down_dry_run).toMatchObject({
      services: ["sa"],
      would_stop_instance: true,
    });

    const down = nsDown(login, "-n", "a");
    expect(down.code, `down: ${down.stdout} ${down.stderr}`).toBe(0);
    expect((down.doc as NsDownDoc).down).toMatchObject({
      stopped: true,
      services: ["sa"],
      instance_stopped: true,
    });
    expect(await waitForNoPids(holdSa)).toEqual([]);
    const ls = devtrees(login, ["ls", "--json"]);
    const listed = (ls.doc as { ls: { instances: Array<{ kind: string }> } }).ls.instances;
    const kinds = listed.map((i) => i.kind);
    expect(kinds).not.toContain("shared");
    expect(pidsMatching(holdWeb)).toHaveLength(1);

    // Nothing left: a retry, or any namespace, is a no-op.
    const again = nsDown(login, "-n", "a");
    expect(again.code).toBe(0);
    expect((again.doc as NsDownDoc).down).toMatchObject({ stopped: false, services: [] });

    // And the next up starts a fresh shared instance with it.
    const back = upWith(login, "default", "a");
    expect(back.code, `re-up: ${back.stderr}`).toBe(0);
    expect((back.doc as NsUpDoc).up.shared_started).toBe(true);
    expect(await waitForPid(holdSa, 10_000)).toBe(true);
  }, 180_000);
});

if (!ENABLED) {
  describe("real-pc smoke — gated", () => {
    it.skip(SKIP_REASON, () => {});
  });
}
