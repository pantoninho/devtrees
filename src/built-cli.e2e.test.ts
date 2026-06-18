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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
 * Env vars the stub `process-compose` understands (see
 * `test/stub-process-compose.mjs`): `DEVTREES_STUB_NEVER_READY=1` pins every
 * probed service to `Running` + `is_ready: "Not Ready"` — the
 * Running-but-not-ready state issue #108's regression class lives in —
 * and `DEVTREES_STUB_READY_AFTER_MS=<n>` flips probed services to Ready only
 * once the instance is `n` ms old. Unprobed services always report
 * `is_ready: "-"` (health `unknown`), like the real binary.
 */
const NEVER_READY = "DEVTREES_STUB_NEVER_READY";
const READY_AFTER_MS = "DEVTREES_STUB_READY_AFTER_MS";

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
 * (shared `db` + isolated `web`, both long-running noops). `web` declares a
 * readiness probe by default — the agent-surface dogfooding shape issue #108
 * regressed on — so health gating is exercised end-to-end; pass
 * `webProbe: false` for a probe-free stack. Registers rm + `down`/`down
 * --shared` cleanups, and returns the derived worktree id and control-socket
 * path so scenarios can assert against runtime state on disk.
 */
function setupScenario(
  prefix: string,
  opts: { webProbe?: boolean } = {},
): { wt: string; id: string; sock: string } {
  const webProbe = opts.webProbe ?? true;
  const scenario = setupRepoWithStack(
    prefix,
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
      ...(webProbe
        ? [
            "    readiness_probe:",
            "      exec:",
            '        command: "echo ok"',
            "      period_seconds: 1",
          ]
        : []),
      "",
    ].join("\n"),
  );
  // This stack has a shared tier, so its teardown also stops the shared instance.
  cleanups.push(() => devtrees(scenario.wt, ["down", "--shared"]));
  return scenario;
}

/**
 * Multi-namespace scenario (#128): a worktree with two isolated services in
 * distinct namespaces — `web` in the implicit `default` namespace, and `api`
 * (carrying a readiness probe) in `local-backend`. Selecting `-n default`
 * must start only `web` and must NOT HEALTH_TIMEOUT on the probed `api`,
 * which is excluded and never started. Returns the worktree id + socket path.
 */
function setupNamespaceScenario(prefix: string): { wt: string; id: string; sock: string } {
  return setupRepoWithStack(
    prefix,
    [
      "services:",
      "  web:",
      "    tier: isolated",
      '    command: "sleep 300"',
      "    ports: [WEB_PORT]",
      "  api:",
      "    tier: isolated",
      "    namespace: local-backend",
      '    command: "sleep 300"',
      "    ports: [API_PORT]",
      // A probe on the EXCLUDED service: if its namespace weren't filtered out
      // of the health-wait's expected set, `up -n default` would HEALTH_TIMEOUT.
      "    readiness_probe:",
      "      exec:",
      '        command: "echo ok"',
      "      period_seconds: 1",
      "",
    ].join("\n"),
  );
}

/**
 * The shared scaffold both built-CLI scenarios sit on: a fresh tmp git repo
 * with one `login` worktree carrying the given `devtrees.yaml` body. Registers
 * the rm + worktree `down` cleanups (callers add `down --shared` when their
 * stack has a shared tier) and returns the derived worktree id + control-socket
 * path so scenarios can assert against on-disk runtime state.
 */
function setupRepoWithStack(
  prefix: string,
  devtreesYaml: string,
): { wt: string; id: string; sock: string } {
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
  writeFileSync(join(wt, "devtrees.yaml"), devtreesYaml);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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
    readonly services: Array<{
      readonly name: string;
      readonly status: string;
      readonly health: string;
    }>;
  };
}

interface DryRunDoc {
  readonly schema_version: string;
  readonly up_dry_run: {
    readonly worktree_id: string;
    readonly env: Record<string, string>;
    readonly config: { readonly processes: Record<string, unknown> };
    readonly shared_env?: Record<string, string>;
    readonly shared_config?: { readonly processes: Record<string, unknown> };
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
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: { readonly service?: string; readonly valid_services?: string[] };
  };
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
    // #108 acceptance: the success envelope reports health:ready for the
    // probed service — readiness was consulted, not just process state.
    const webRow = upDoc.up.services.find((s) => s.name === "web");
    expect(webRow?.status).toBe("Running");
    expect(webRow?.health).toBe("ready");

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

  it("up --dry-run --json previews the config(s) + env with NO side effects (#124)", () => {
    const { wt, id, sock } = setupScenario("dt-bcdry-");
    // <absCommon>/devtrees holds the per-instance configs, registry, and the
    // `run/` socket dir. sock = <devtreesDir>/run/<id>.sock.
    const devtreesDir = dirname(dirname(sock));
    const wtConfig = join(devtreesDir, `${id}.yaml`);
    const sharedConfig = join(devtreesDir, "shared.yaml");

    const dry = devtrees(wt, ["up", "--dry-run", "--json"]);
    expect(dry.code, `dry-run failed: stderr=${dry.stderr} stdout=${dry.stdout}`).toBe(0);

    // Stdout is one byte-clean JSON document; no log/hint bleed.
    expect(dry.stdout.startsWith("{")).toBe(true);
    const doc = dry.doc as DryRunDoc;
    expect(doc.schema_version).toBe("1");
    expect(doc.up_dry_run.worktree_id).toBe(id);
    // A sibling reads the allocated ports straight off the envelope (#125).
    const webPort = Number(doc.up_dry_run.env.WEB_PORT);
    const dbPort = Number(doc.up_dry_run.env.DB_PORT);
    expect(webPort).toBeGreaterThan(0);
    expect(dbPort).toBeGreaterThan(0);
    expect(doc.up_dry_run.env.DEVTREES_WORKTREE_ID).toBe(id);
    // The derived configs are present in-envelope.
    expect(doc.up_dry_run.config.processes.web).toBeDefined();
    expect(doc.up_dry_run.shared_config?.processes.db).toBeDefined();
    // The injected shared port matches between worktree env and shared env.
    expect(doc.up_dry_run.shared_env?.DB_PORT).toBe(doc.up_dry_run.env.DB_PORT);

    // NO side effects: no config files were written, and no control socket
    // was created. (Allocation may have written the registry to reserve the
    // block — that is the documented, acceptable touch; the derived configs
    // and the instance socket are what `dry-run` must not produce.)
    expect(existsSync(wtConfig), "no worktree config written").toBe(false);
    expect(existsSync(sharedConfig), "no shared config written").toBe(false);
    expect(existsSync(sock), "no control socket created").toBe(false);
    // If devtrees/ exists at all (the allocation registry), it has no
    // per-instance run sockets in it.
    if (existsSync(join(devtreesDir, "run"))) {
      expect(readdirSync(join(devtreesDir, "run"))).toEqual([]);
    }

    // ls still shows nothing — the dry run registered no instance.
    const ls = devtrees(wt, ["ls", "--json"]);
    expect(ls.code, `ls failed: ${ls.stderr}`).toBe(0);
    const instances = (ls.doc as LsDoc).ls.instances;
    expect(instances.find((i) => i.id === id)).toBeUndefined();

    // Human mode prints the derived YAML to stdout (not a JSON envelope).
    const human = devtrees(wt, ["up", "--dry-run"]);
    expect(human.code, `dry-run human failed: ${human.stderr}`).toBe(0);
    expect(human.stdout).toContain("processes:");
    expect(human.stdout.startsWith("{")).toBe(false);
    // Still no side effects after the human run.
    expect(existsSync(sock)).toBe(false);
  }, 60_000);

  it("--wait-timeout reaches the health gate: never-ready probed service times out at 1s, not 120s", () => {
    const { wt, sock } = setupScenario("dt-bc2-");

    // #108: the stub's probed `web` stays Running with is_ready "Not Ready" —
    // the exact state the old status-only gate sailed straight through.
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
    // ADR-0005 / #108 acceptance: the timeout leaves the instance running so
    // the agent can inspect it — its control socket is still on disk.
    expect(existsSync(sock)).toBe(true);
  }, 90_000);

  it("a probed service gates up until its probe passes (ready arrives late)", () => {
    // #108 acceptance: fresh `up` must not exit before the probed service
    // reports ready. The stub flips is_ready to "Ready" only once the
    // instance is 1.5s old, so a gate that consulted readiness takes ≥1.5s
    // while the regressed status-only gate returned on the first poll.
    const { wt } = setupScenario("dt-bc5-");

    const started = Date.now();
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "30"], {
      env: { [READY_AFTER_MS]: "1500" },
      timeoutMs: 60_000,
    });
    const elapsed = Date.now() - started;

    expect(r.code, `up failed: stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    const webRow = (r.doc as UpDoc).up.services.find((s) => s.name === "web");
    expect(webRow?.health).toBe("ready");
  }, 90_000);

  it("services without probes do not block up: health stays unknown, exit 0", () => {
    // #108 acceptance: NEVER_READY only pins *probed* services; a probe-free
    // stack keeps the Running/Completed semantics and must come up fine.
    const { wt } = setupScenario("dt-bc6-", { webProbe: false });

    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "30"], {
      env: { [NEVER_READY]: "1" },
      timeoutMs: 60_000,
    });

    expect(r.code, `up failed: stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    const webRow = (r.doc as UpDoc).up.services.find((s) => s.name === "web");
    expect(webRow?.status).toBe("Running");
    expect(webRow?.health).toBe("unknown");
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

  it("logs with an unknown service fails fast with SERVICE_NOT_FOUND — no hang (#109)", () => {
    const { wt } = setupScenario("dt-bc5-");

    const up = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(up.code, `up failed: ${up.stderr}`).toBe(0);

    // --json: one error envelope on stdout, naming the unknown service and
    // listing the valid ones, exiting non-zero promptly (the real
    // process-compose would block forever on an unknown name).
    const started = Date.now();
    const json = devtrees(wt, ["logs", "nosuchservice", "--json"], { timeoutMs: 15_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(json.code, `expected SERVICE_NOT_FOUND failure, got: ${json.stdout}`).toBe(1);
    const doc = json.doc as ErrorDoc;
    expect(doc.error?.code).toBe("SERVICE_NOT_FOUND");
    expect(doc.error?.message).toContain("nosuchservice");
    expect(doc.error?.details?.service).toBe("nosuchservice");
    expect(doc.error?.details?.valid_services).toContain("web");

    // Human mode: diagnostic on stderr, nothing on stdout, non-zero exit.
    const human = devtrees(wt, ["logs", "nosuchservice"], { timeoutMs: 15_000 });
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toMatch(/devtrees: unknown service 'nosuchservice'/);

    // --shared validates against the shared instance's own service set.
    const shared = devtrees(wt, ["logs", "nosuchservice", "--shared", "--json"], {
      timeoutMs: 15_000,
    });
    expect(shared.code).toBe(1);
    const sharedDoc = shared.doc as ErrorDoc;
    expect(sharedDoc.error?.code).toBe("SERVICE_NOT_FOUND");
    expect(sharedDoc.error?.details?.valid_services).toContain("db");
    expect(sharedDoc.error?.details?.valid_services).not.toContain("web");
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

  describe("up init-hint over dist/cli.mjs (#119)", () => {
    it("non-TTY up with no agent-doc referencing devtrees writes the hint to stderr; --json stdout unaffected", () => {
      // setupScenario's worktree has no AGENTS.md/CLAUDE.md, so onboarding
      // looks absent; a spawned subprocess has piped (non-TTY) stdio, so the
      // agent-context gate is satisfied — the hint must fire on stderr.
      const { wt } = setupScenario("dt-hint1-");

      const up = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
      expect(up.code, `up failed: stderr=${up.stderr} stdout=${up.stdout}`).toBe(0);
      // The hint lands on stderr, naming the command to run.
      expect(up.stderr).toContain("devtrees init --agents");
      // ...and exactly once.
      expect(up.stderr.split("devtrees init --agents").length - 1).toBe(1);
      // The stdout document is still a single clean JSON envelope — the hint
      // added no field and no stray bytes (acceptance: schema stays clean).
      expect(up.stdout.startsWith("{")).toBe(true);
      const doc = JSON.parse(up.stdout) as UpDoc;
      expect(doc.schema_version).toBe("1");
      expect("hint" in doc).toBe(false);
      expect("hint" in doc.up).toBe(false);
    }, 60_000);

    it("stays silent in a TTY (human) context", () => {
      const { wt } = setupScenario("dt-hint2-");

      const up = devtrees(wt, ["up", "--json", "--wait-timeout", "30"], {
        env: { DEVTREES_ASSUME_TTY: "1" },
      });
      expect(up.code, `up failed: ${up.stderr}`).toBe(0);
      expect(up.stderr).not.toContain("init --agents");
    }, 60_000);

    it("stays silent when an agent-doc already carries the devtrees block", () => {
      const { wt } = setupScenario("dt-hint3-");
      // Onboard the repo first; the marker mentions devtrees, so the gate's
      // "no agent-doc references devtrees" condition is now false.
      const init = devtrees(wt, ["init", "--agents", "--json"]);
      expect(init.code, `init failed: ${init.stderr}`).toBe(0);

      const up = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
      expect(up.code, `up failed: ${up.stderr}`).toBe(0);
      expect(up.stderr).not.toContain("init --agents");
    }, 60_000);
  });

  it("init --agents creates AGENTS.md, then re-runs idempotently through dist/cli.mjs (#118)", () => {
    const dir = mkdtempSync(join(SHORT_TMP, "dt-bc5-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // The spawned CLI resolves `process.cwd()`, which is the realpath — on
    // macOS `/tmp` is a symlink to `/private/tmp`, so the envelope's `path`
    // reflects the resolved location, not the raw mkdtemp path.
    const realDir = realpathSync(dir);

    // First run: neither file exists → AGENTS.md is created.
    const created = devtrees(dir, ["init", "--agents", "--json"]);
    expect(created.code, `init failed: ${created.stderr}`).toBe(0);
    expect(created.doc).toEqual({
      schema_version: "1",
      init: { target: "AGENTS.md", path: join(realDir, "AGENTS.md"), action: "created" },
    });
    const firstBody = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(firstBody).toContain("<!-- devtrees:start -->");
    expect(firstBody).toContain("<!-- devtrees:end -->");
    expect(firstBody).toContain("## Running the stack with devtrees");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);

    // Second run: AGENTS.md now exists → updated in place, never duplicated.
    const updated = devtrees(dir, ["init", "--agents", "--json"]);
    expect(updated.code, `re-init failed: ${updated.stderr}`).toBe(0);
    expect((updated.doc as { init: { action: string } }).init.action).toBe("updated");
    const secondBody = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(secondBody).toBe(firstBody);
    expect(secondBody.split("<!-- devtrees:start -->").length - 1).toBe(1);
  }, 30_000);

  it("init --agents updates an existing CLAUDE.md when AGENTS.md is absent (#118)", () => {
    const dir = mkdtempSync(join(SHORT_TMP, "dt-bc6-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "CLAUDE.md"), "# House rules\n");

    const r = devtrees(dir, ["init", "--agents", "--json"]);
    expect(r.code, `init failed: ${r.stderr}`).toBe(0);
    expect((r.doc as { init: { target: string; action: string } }).init).toMatchObject({
      target: "CLAUDE.md",
      action: "updated",
    });
    const body = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(body.startsWith("# House rules\n")).toBe(true);
    expect(body).toContain("## Running the stack with devtrees");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  }, 30_000);

  it("init without --agents fails with the INVALID_ARGS envelope (#118)", () => {
    const dir = mkdtempSync(join(SHORT_TMP, "dt-bc7-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = devtrees(dir, ["init", "--json"]);
    expect(r.code).toBe(1);
    expect((r.doc as ErrorDoc).error?.code).toBe("INVALID_ARGS");
    // No file was written on the failure path.
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  }, 30_000);

  it("up -n default starts only the default-namespace subset and does not hang on an excluded probed service (#128)", () => {
    const { wt, id, sock } = setupNamespaceScenario("dt-bcns-");

    // `web` is in `default`; the probed `api` is in `local-backend`. A short
    // wait-timeout proves we don't burn the full window: if the excluded
    // probed service were still in the expected set this would HEALTH_TIMEOUT.
    const up = devtrees(wt, ["up", "-n", "default", "--json", "--wait-timeout", "10"]);
    expect(up.code, `up -n default failed: stderr=${up.stderr} stdout=${up.stdout}`).toBe(0);
    const upDoc = up.doc as UpDoc;
    expect(upDoc.up.worktree_id).toBe(id);
    expect(existsSync(sock)).toBe(true);

    // ls reflects the actually-running set: only `web` (default), not `api`.
    const names = (devtrees(wt, ["ls", "--json"]).doc as LsDoc).ls.instances
      .find((i) => i.id === id)
      ?.services.map((s) => s.name)
      .sort();
    expect(names).toEqual(["web"]);
  }, 60_000);

  it("up -n local-backend starts only that namespace and still gates on its probed service (#128)", () => {
    const { wt, id } = setupNamespaceScenario("dt-bcns2-");

    const up = devtrees(wt, ["up", "-n", "local-backend", "--json", "--wait-timeout", "30"]);
    expect(up.code, `up -n local-backend failed: stderr=${up.stderr} stdout=${up.stdout}`).toBe(0);
    const services = (up.doc as UpDoc).up.services;
    // Only `api` runs, and the readiness probe was consulted (health:ready) —
    // no #108 regression within the selected namespace.
    expect(services.map((s) => s.name).sort()).toEqual(["api"]);
    expect(services.find((s) => s.name === "api")?.health).toBe("ready");

    const names = (devtrees(wt, ["ls", "--json"]).doc as LsDoc).ls.instances
      .find((i) => i.id === id)
      ?.services.map((s) => s.name)
      .sort();
    expect(names).toEqual(["api"]);
  }, 60_000);
});
