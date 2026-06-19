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
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorktreeId } from "./anchor.js";

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

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly doc?: unknown;
}

/** Invoke the built CLI from inside a worktree. Captures stdout/stderr. */
function devtrees(cwd: string, args: ReadonlyArray<string>): CliResult {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
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
const NORMALISED_NUMBER_FIELDS = new Set(["WEB_PORT", "DB_PORT", "block_base"]);

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
});

beforeAll(() => {
  if (!ENABLED) {
    // Print once so a CI log makes the skip obvious to a reader.
    // eslint-disable-next-line no-console
    console.log(SKIP_REASON);
  }
});

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
    expect(existsSync(join(absCommon, "devtrees", "run", `${wtId(wt)}.sock`))).toBe(true);
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
      down: { shared: true, stopped: true },
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
      down: { worktreeId: "<WT>", stopped: false },
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
});

// Without the gate, log once so a developer running `vp test run` locally
// knows why no scenarios fired.
if (!ENABLED) {
  describe("real-pc smoke — gated", () => {
    it.skip(SKIP_REASON, () => {});
  });
}
