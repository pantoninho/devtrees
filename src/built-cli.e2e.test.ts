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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { deriveWorktreeId } from "./anchor.js";
import { instancePaths, runDir, sharedInstancePaths } from "./paths.js";

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

/**
 * What a scenario hands back: the worktree, its derived id, and the on-disk
 * locations the assertions poke at. `anchor`/`stateDir` and `sock` are two
 * different places since #156 — durable state stays in the git dir, the
 * control socket lives in the short runtime run dir.
 */
interface Scenario {
  readonly wt: string;
  readonly id: string;
  readonly anchor: string;
  readonly sock: string;
  readonly stateDir: string;
}

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
function setupScenario(prefix: string, opts: { webProbe?: boolean } = {}): Scenario {
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
function setupNamespaceScenario(prefix: string): Scenario {
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
 * Every isolated service namespaced (#176): nothing is in `default`, so a bare
 * fresh `up` selects zero services and must fail NO_SERVICES_SELECTED rather
 * than start an empty instance and report it healthy.
 */
function setupAllNamespacedScenario(prefix: string): Scenario {
  return setupRepoWithStack(
    prefix,
    [
      "services:",
      "  web:",
      "    tier: isolated",
      "    namespace: app",
      '    command: "sleep 300"',
      "    ports: [WEB_PORT]",
      "  api:",
      "    tier: isolated",
      "    namespace: local-backend",
      '    command: "sleep 300"',
      "    ports: [API_PORT]",
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
function setupRepoWithStack(prefix: string, devtreesYaml: string): Scenario {
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
  const paths = instancePaths(absCommon, id);
  return { wt, id, anchor: absCommon, sock: paths.socketPath, stateDir: paths.stateDir };
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
    readonly details?: {
      readonly service?: string;
      readonly valid_services?: string[];
      readonly namespaces?: string[];
    };
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
    expect(down.doc).toEqual({
      schema_version: "1",
      down: { worktreeId: id, stopped: true, force_killed: [] },
    });
    expect(existsSync(sock)).toBe(false);

    const downShared = devtrees(wt, ["down", "--shared", "--json"]);
    expect(downShared.code, `down --shared failed: ${downShared.stderr}`).toBe(0);
    expect(downShared.doc).toEqual({
      schema_version: "1",
      down: { shared: true, stopped: true, force_killed: [] },
    });
  }, 60_000);

  it("up --dry-run --json previews the config(s) + env with NO side effects (#124)", () => {
    const { wt, id, anchor, sock, stateDir: devtreesDir } = setupScenario("dt-bcdry-");
    // <absCommon>/devtrees holds the per-instance configs and the registry;
    // the control socket lives in the short runtime run dir (#156).
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
    // The run dir lives outside the git dir since #156; if it exists at all
    // (another instance of this repo), it holds no socket for this dry run.
    const runDirPath = runDir(anchor);
    if (existsSync(runDirPath)) {
      expect(readdirSync(runDirPath)).not.toContain(`${id}.sock`);
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

  it("previews a namespaced shared service only for an up that selects its namespace (#236)", () => {
    // #130 used to reject `namespace` on a shared service; since #236 it
    // decides which `up`s use the service (ADR-0010). Exercised through
    // `up --dry-run --json`, a resolve-only path with no side effects.
    const {
      wt,
      id,
      sock,
      stateDir: devtreesDir,
    } = setupRepoWithStack(
      "dt-bcns-",
      [
        "services:",
        "  db:",
        "    tier: shared",
        '    command: "sleep 300"',
        "    namespace: local-backend",
        "",
      ].join("\n"),
    );
    type SharedDry = {
      up_dry_run: {
        selected_shared_services: string[];
        shared_config: { processes: Record<string, unknown> };
      };
    };
    const bare = devtrees(wt, ["up", "--dry-run", "--json"]);
    expect(bare.code, `dry-run failed: ${bare.stderr}`).toBe(0);
    expect((bare.doc as SharedDry).up_dry_run.selected_shared_services).toEqual([]);
    expect(Object.keys((bare.doc as SharedDry).up_dry_run.shared_config.processes)).toEqual([]);

    const selected = devtrees(wt, ["up", "--dry-run", "--json", "-n", "local-backend"]);
    expect(selected.code, `dry-run failed: ${selected.stderr}`).toBe(0);
    expect((selected.doc as SharedDry).up_dry_run.selected_shared_services).toEqual(["db"]);
    expect(Object.keys((selected.doc as SharedDry).up_dry_run.shared_config.processes)).toEqual([
      "db",
    ]);

    // No side effects: no derived config and no control socket were written.
    expect(existsSync(join(devtreesDir, `${id}.yaml`)), "no worktree config").toBe(false);
    expect(existsSync(join(devtreesDir, "shared.yaml")), "no shared config").toBe(false);
    expect(existsSync(sock), "no control socket").toBe(false);
  }, 60_000);

  it("two branches with different shared layouts agree on shared ports; a conflict fails SHARED_PORT_CONFLICT (#238)", () => {
    // Branch `login` declares pg + x; branch `billing` declares pg + y + x.
    // By position, login's X_PORT and billing's Y_PORT share a slot.
    const sharedSvc = (name: string, ns: string | undefined, port: string): string[] => [
      `  ${name}:`,
      "    tier: shared",
      ...(ns === undefined ? [] : [`    namespace: ${ns}`]),
      '    command: "sleep 300"',
      `    ports: [${port}]`,
    ];
    const api = [
      "  api:",
      "    namespace: app",
      '    command: "sleep 300"',
      "    ports: [API_PORT]",
    ];
    const login = setupRepoWithStack(
      "dt-bc238-",
      [
        "services:",
        ...sharedSvc("pg", undefined, "PG_PORT"),
        ...sharedSvc("x", "xs", "X_PORT"),
        ...api,
        "",
      ].join("\n"),
    );
    cleanups.push(() => devtrees(login.wt, ["down", "--shared"]));
    const billingWt = join(login.wt, "..", "billing");
    execFileSync("git", ["worktree", "add", "-q", billingWt, "-b", "billing"], {
      cwd: join(login.wt, "..", "main"),
    });
    writeFileSync(
      join(billingWt, "devtrees.yaml"),
      [
        "services:",
        ...sharedSvc("pg", undefined, "PG_PORT"),
        ...sharedSvc("y", "ys", "Y_PORT"),
        ...sharedSvc("x", "xs", "X_PORT"),
        ...api,
        "",
      ].join("\n"),
    );
    cleanups.push(() => devtrees(billingWt, ["down"]));
    type EnvDoc = {
      env: Record<string, string>;
      shared_ports: Record<string, { port: number; origin: string }>;
    };

    const a = devtrees(login.wt, ["up", "--json", "--wait-timeout", "30", "-n", "app"]);
    expect(a.code, `login up: ${a.stderr}`).toBe(0);
    const xPort = Number((a.doc as UpDoc).up.env.X_PORT);

    // billing reads login's recorded X_PORT; Y_PORT is only predicted, and
    // `env` wrote nothing, so the prediction is not recorded yet.
    const env = devtrees(billingWt, ["env", "--json"]);
    expect(env.code, `billing env: ${env.stderr}`).toBe(0);
    const ports = (env.doc as EnvDoc).shared_ports;
    expect(ports.X_PORT).toEqual({ port: xPort, origin: "recorded" });
    expect(ports.PG_PORT?.origin).toBe("active");
    expect(ports.Y_PORT?.origin).toBe("predicted");
    expect(ports.Y_PORT?.port).not.toBe(xPort);
    const mapPath = join(login.anchor, "devtrees", "shared-ports.json");
    expect(Object.keys(JSON.parse(readFileSync(mapPath, "utf8")).ports)).toEqual([
      "PG_PORT",
      "X_PORT",
    ]);

    const b = devtrees(billingWt, [
      "up",
      "--json",
      "--wait-timeout",
      "30",
      "-n",
      "app",
      "-n",
      "ys",
    ]);
    expect(b.code, `billing up: ${b.stderr}`).toBe(0);
    const bEnv = (b.doc as UpDoc).up.env;
    expect(Number(bEnv.X_PORT)).toBe(xPort);
    expect(bEnv.Y_PORT).toBe(String(ports.Y_PORT?.port));

    const ls = devtrees(login.wt, ["ls", "--json"]);
    expect(ls.code, `ls: ${ls.stderr}`).toBe(0);
    const lsPorts = (ls.doc as { ls: { shared_ports: EnvDoc["shared_ports"] } }).ls.shared_ports;
    expect(lsPorts.Y_PORT?.origin).toBe("active");
    expect(lsPorts.X_PORT).toEqual({ port: xPort, origin: "recorded" });

    // A map that gives X_PORT the number y binds: adding x would hand one
    // port to two names, so `up` refuses and records nothing.
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { ports: Record<string, number> };
    map.ports.X_PORT = Number(bEnv.Y_PORT);
    writeFileSync(mapPath, JSON.stringify(map));
    const blocked = devtrees(login.wt, [
      "up",
      "--json",
      "--wait-timeout",
      "30",
      "-n",
      "app",
      "-n",
      "xs",
    ]);
    expect(blocked.code).not.toBe(0);
    const err = (blocked.doc as ErrorDoc).error as { code?: string; details?: { remedy?: string } };
    expect(err.code).toBe("SHARED_PORT_CONFLICT");
    expect(err.details?.remedy).toContain("devtrees down --shared && devtrees up");
    expect(JSON.parse(readFileSync(mapPath, "utf8"))).toEqual(map);

    // prune --shared-ports drops only names nothing holds: an unused one goes,
    // every name a running instance's derived config carries stays.
    writeFileSync(mapPath, JSON.stringify({ ...map, ports: { ...map.ports, GONE_PORT: 1 } }));
    const pruned = devtrees(login.wt, ["prune", "--shared-ports", "--json"]);
    expect(pruned.code, `prune --shared-ports: ${pruned.stderr}`).toBe(0);
    const prunedDoc = (pruned.doc as { prune_shared_ports: { dropped: string[]; kept: string[] } })
      .prune_shared_ports;
    expect(prunedDoc.dropped).toEqual(["GONE_PORT"]);
    expect(prunedDoc.kept).toEqual(Object.keys(map.ports).sort());
  }, 90_000);

  it("up refuses a process-compose older than v1.122.0 before starting anything (#173)", () => {
    const { wt, id, sock, stateDir: devtreesDir } = setupScenario("dt-bcold-", { webProbe: false });
    const env = { STUB_PC_VERSION: "v1.110.0" };

    const human = devtrees(wt, ["up"], { env });
    expect(human.code).not.toBe(0);
    expect(human.stderr).toContain("v1.110.0");
    expect(human.stderr).toContain("v1.122.0");

    const json = devtrees(wt, ["up", "--json"], { env });
    expect(json.code).not.toBe(0);
    const err = (json.doc as { error?: { code?: string; details?: Record<string, unknown> } })
      .error;
    expect(err?.code).toBe("PROCESS_COMPOSE_TOO_OLD");
    expect(err?.details).toMatchObject({
      installed_version: "1.110.0",
      minimum_version: "1.122.0",
    });

    // Nothing was allocated, written or spawned.
    expect(existsSync(join(devtreesDir, `${id}.yaml`)), "no worktree config").toBe(false);
    expect(existsSync(sock), "no control socket").toBe(false);
    expect(existsSync(join(devtreesDir, "registry.json")), "no allocation").toBe(false);
  }, 60_000);

  it("up is unaffected by a process-compose at exactly v1.122.0 (#173)", () => {
    const { wt } = setupScenario("dt-bmin-", { webProbe: false });
    const up = devtrees(wt, ["up", "--json"], { env: { STUB_PC_VERSION: "v1.122.0" } });
    expect(up.code, `stdout=${up.stdout} stderr=${up.stderr}`).toBe(0);
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

  it("ls --json never reports health ready for a dead probed service (#174)", () => {
    const { wt } = setupScenario("dt-bc7-");

    const up = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(up.code, `up failed: stderr=${up.stderr} stdout=${up.stdout}`).toBe(0);

    // The stub now models a killed probed process: Completed, is_running
    // false, with the stale `is_ready: "Ready"` the real binary keeps.
    const ls = devtrees(wt, ["ls", "--json"], { env: { DEVTREES_STUB_DEAD_PROBED: "1" } });
    expect(ls.code, `ls failed: ${ls.stderr}`).toBe(0);
    const inst = (ls.doc as LsDoc).ls.instances.find((i) => i.kind === "worktree");
    const web = inst?.services.find((s) => s.name === "web");
    expect(web?.health).toBe("not_ready");
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

  it("a bare fresh up starts only the default namespace (namespaces are opt-in, #176)", () => {
    const { wt, id } = setupNamespaceScenario("dt-bcns0-");

    // The probed `api` is in `local-backend`: a bare `up` must neither start
    // nor wait on it, so the short wait-timeout cannot lapse on it.
    const up = devtrees(wt, ["up", "--json", "--wait-timeout", "10"]);
    expect(up.code, `bare up failed: stderr=${up.stderr} stdout=${up.stdout}`).toBe(0);
    expect((up.doc as UpDoc).up.services.map((s) => s.name)).toEqual(["web"]);

    const names = (devtrees(wt, ["ls", "--json"]).doc as LsDoc).ls.instances
      .find((i) => i.id === id)
      ?.services.map((s) => s.name)
      .sort();
    expect(names).toEqual(["web"]);
  }, 60_000);

  it("a bare fresh up with no default services fails NO_SERVICES_SELECTED, human and --json (#176)", () => {
    const { wt, sock } = setupAllNamespacedScenario("dt-bcns3-");

    const json = devtrees(wt, ["up", "--json"]);
    expect(json.code).not.toBe(0);
    const err = (json.doc as ErrorDoc).error;
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
    expect(err?.details?.namespaces).toEqual(["app", "local-backend"]);
    expect(err?.message).toContain("devtrees up -n app");

    const human = devtrees(wt, ["up", "--no-attach"]);
    expect(human.code).not.toBe(0);
    expect(human.stderr).toContain("NO_SERVICES_SELECTED");
    expect(human.stderr).toContain("Available namespaces: app, local-backend");

    // Nothing was started.
    expect(existsSync(sock)).toBe(false);
  }, 60_000);

  it("`-n` naming only an empty namespace fails NO_SERVICES_SELECTED, real and dry-run (#203)", () => {
    const { wt, sock } = setupAllNamespacedScenario("dt-bcns6-");

    const json = devtrees(wt, ["up", "--json", "-n", "nope"]);
    expect(json.code).not.toBe(0);
    const err = (json.doc as ErrorDoc).error;
    expect(err?.code).toBe("NO_SERVICES_SELECTED");
    expect(err?.details?.namespaces).toEqual(["app", "local-backend"]);

    const human = devtrees(wt, ["up", "--no-attach", "-n", "nope"]);
    expect(human.code).not.toBe(0);
    expect(human.stderr).toContain("NO_SERVICES_SELECTED");

    const dry = devtrees(wt, ["up", "--dry-run", "--json", "-n", "nope"]);
    expect(dry.code).not.toBe(0);
    expect((dry.doc as ErrorDoc).error?.code).toBe("NO_SERVICES_SELECTED");
    expect(existsSync(sock)).toBe(false);
  }, 60_000);

  it("up --dry-run previews the same selection and the same NO_SERVICES_SELECTED failure (#176)", () => {
    const mixed = setupNamespaceScenario("dt-bcns4-");
    const dry = devtrees(mixed.wt, ["up", "--dry-run", "--json"]);
    expect(dry.code, `dry-run failed: ${dry.stderr}`).toBe(0);
    const preview = (dry.doc as { up_dry_run: Record<string, unknown> }).up_dry_run;
    expect(preview.namespaces).toEqual(["default"]);
    expect(preview.selected_services).toEqual(["web"]);

    const scoped = devtrees(mixed.wt, ["up", "--dry-run", "--json", "-n", "local-backend"]);
    const scopedPreview = (scoped.doc as { up_dry_run: Record<string, unknown> }).up_dry_run;
    expect(scopedPreview.namespaces).toEqual(["local-backend"]);
    expect(scopedPreview.selected_services).toEqual(["api"]);

    const none = setupAllNamespacedScenario("dt-bcns5-");
    const failed = devtrees(none.wt, ["up", "--dry-run", "--json"]);
    expect(failed.code).not.toBe(0);
    expect((failed.doc as ErrorDoc).error?.code).toBe("NO_SERVICES_SELECTED");
    expect(existsSync(none.sock)).toBe(false);
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

/**
 * `up` on an already-running instance (ADR-0008, issue #177), through
 * `dist/cli.mjs` and the stub. Each scenario boots once, then re-runs `up`
 * against the live instance. `DEVTREES_STUB_DEAD` / `DEVTREES_STUB_DONE` make
 * the stub's `process list` report named services as killed (`Completed`,
 * exit -1) or as a finished one-shot (`Completed`, exit 0).
 */
describe("built CLI e2e — up verifies a running instance (#177)", () => {
  interface VerifyErrorDoc {
    readonly error?: {
      readonly code?: string;
      readonly message?: string;
      readonly details?: Record<string, unknown>;
    };
  }

  /** #170's stack: `a` in `one`, `b` in `two`. */
  function twoNamespaceScenario(prefix: string): Scenario {
    return setupRepoWithStack(
      prefix,
      [
        "services:",
        "  a:",
        "    tier: isolated",
        "    namespace: one",
        '    command: "sleep 300"',
        "  b:",
        "    tier: isolated",
        "    namespace: two",
        '    command: "sleep 300"',
        "    ports: [B_PORT]",
        "",
      ].join("\n"),
    );
  }

  it("#170: up -n one, then up -n one -n two fails with NAMESPACE_NOT_RUNNING naming `two`", () => {
    const { wt, id } = twoNamespaceScenario("dt-bcv1-");
    const first = devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "10"]);
    expect(first.code, `first up failed: ${first.stderr} ${first.stdout}`).toBe(0);

    const json = devtrees(wt, ["up", "-n", "one", "-n", "two", "--json", "--wait-timeout", "10"]);
    expect(json.code).toBe(1);
    const err = (json.doc as VerifyErrorDoc).error;
    expect(err?.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err?.details).toEqual({
      worktree_id: id,
      namespaces: ["two"],
      services: ["b"],
      remedy: "devtrees down && devtrees up -n one -n two",
    });

    const human = devtrees(wt, ["up", "-n", "one", "-n", "two", "--no-attach"]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("'two'");
    expect(human.stderr).toContain("devtrees down && devtrees up -n one -n two");
    expect(human.stdout).not.toContain("is up");

    // Nothing was stopped: `a` is still the running set.
    const ls = devtrees(wt, ["ls", "--json"]).doc as LsDoc;
    const names = ls.ls.instances.find((i) => i.id === id)?.services.map((s) => s.name);
    expect(names).toEqual(["a"]);
  }, 60_000);

  it("bare up on an instance booted with -n one targets `one` only and exits 0", () => {
    const { wt } = twoNamespaceScenario("dt-bcv2-");
    expect(devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const again = devtrees(wt, ["up", "--json", "--wait-timeout", "10"]);
    expect(again.code, `bare re-up failed: ${again.stderr} ${again.stdout}`).toBe(0);
    expect((again.doc as UpDoc).up.services.map((s) => s.name)).toEqual(["a"]);
  }, 60_000);

  it("a narrower -n leaves the other namespace running and does not fail", () => {
    const { wt, id } = twoNamespaceScenario("dt-bcv3-");
    expect(devtrees(wt, ["up", "-n", "one", "-n", "two", "--json"]).code).toBe(0);
    const narrow = devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "10"]);
    expect(narrow.code, `narrow re-up failed: ${narrow.stderr} ${narrow.stdout}`).toBe(0);
    const names = (devtrees(wt, ["ls", "--json"]).doc as LsDoc).ls.instances
      .find((i) => i.id === id)
      ?.services.map((s) => s.name)
      .sort();
    expect(names).toEqual(["a", "b"]);
  }, 60_000);

  it("#162/#178: a killed service is restarted by the re-up, which exits 0 and reports it", () => {
    const { wt } = setupScenario("dt-bcv4-");
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);

    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "30"], {
      env: { DEVTREES_STUB_DEAD: "web" },
    });
    expect(r.code, `re-up failed: ${r.stderr} ${r.stdout}`).toBe(0);
    const doc = r.doc as UpDoc & { up: { restarted: string[] } };
    expect(doc.up.restarted).toEqual(["web"]);
    expect(doc.up.services.find((s) => s.name === "web")?.health).toBe("ready");

    // Converged: the next re-up restarts nothing, and the human summary says
    // nothing about restarts.
    const human = devtrees(wt, ["up", "--no-attach", "--wait-timeout", "10"], {
      env: { DEVTREES_STUB_DEAD: "web" },
    });
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain("restarted");
  }, 90_000);

  it("the human summary names the services the re-up restarted", () => {
    const { wt } = setupScenario("dt-bcva-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const r = devtrees(wt, ["up", "--no-attach", "--wait-timeout", "10"], {
      env: { DEVTREES_STUB_DEAD: "web" },
    });
    expect(r.code, `re-up failed: ${r.stderr} ${r.stdout}`).toBe(0);
    expect(r.stdout).toContain("devtrees up: restarted dead service(s): web.");
    expect(r.stdout).toContain("is up.");
  }, 60_000);

  it("a refused restart fails with SERVICE_START_FAILED in --json and human output", () => {
    const { wt, id } = setupScenario("dt-bcvb-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const env = { DEVTREES_STUB_DEAD: "web", DEVTREES_STUB_START_FAIL: "web" };

    const json = devtrees(wt, ["up", "--json", "--wait-timeout", "10"], { env });
    expect(json.code).toBe(1);
    const err = (json.doc as VerifyErrorDoc).error;
    expect(err?.code).toBe("SERVICE_START_FAILED");
    expect(err?.details).toEqual({
      worktree_id: id,
      services: [
        {
          name: "web",
          message: 'FTL failed to start process web error="stub refused to start web"',
        },
      ],
      remedy: "devtrees down && devtrees up",
    });

    const human = devtrees(wt, ["up", "--no-attach", "--wait-timeout", "10"], { env });
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("web");
    expect(human.stderr).toContain("devtrees down && devtrees up");
    expect(human.stdout).not.toContain("is up");
  }, 60_000);

  it("a restarted service that dies again fails fast with HEALTH_TIMEOUT naming it", () => {
    const { wt } = setupScenario("dt-bcvc-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);

    const started = Date.now();
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "60"], {
      env: { DEVTREES_STUB_DEAD: "web", DEVTREES_STUB_DIES_AGAIN: "web" },
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.code).toBe(1);
    const err = (r.doc as VerifyErrorDoc).error;
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("web (Completed, exit 1)");
    expect(err?.message).toContain("died again");
    expect(err?.details).toMatchObject({
      dead_services: [{ name: "web", status: "Completed", exit_code: 1 }],
    });
  }, 90_000);

  it("a restarted service that never becomes healthy fails HEALTH_TIMEOUT naming it, instance left running", () => {
    const { wt, sock } = setupScenario("dt-bcvd-");
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "2"], {
      env: { DEVTREES_STUB_DEAD: "web", [NEVER_READY]: "1" },
    });
    expect(r.code).toBe(1);
    const err = (r.doc as VerifyErrorDoc).error;
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("healthy [web] after 2000ms");
    expect(existsSync(sock)).toBe(true);
  }, 60_000);

  it("a healthy running instance re-ups with exit 0 quickly", () => {
    const { wt } = setupScenario("dt-bcv5-");
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "30"]).code).toBe(0);
    const started = Date.now();
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "30"]);
    expect(r.code, `re-up failed: ${r.stderr} ${r.stdout}`).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((r.doc as UpDoc).up.services.find((s) => s.name === "web")?.health).toBe("ready");
  }, 90_000);

  it("a finished exit-0 one-shot does not fail the re-up", () => {
    const { wt } = setupScenario("dt-bcv6-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "10"], {
      env: { DEVTREES_STUB_DONE: "web" },
    });
    expect(r.code, `re-up failed: ${r.stderr} ${r.stdout}`).toBe(0);
    // Done, not dead: never restarted (#178).
    expect((r.doc as { up: { restarted: string[] } }).up.restarted).toEqual([]);
  }, 60_000);

  interface SharedRestartDoc {
    readonly up?: { readonly shared_restarted?: string[]; readonly restarted?: string[] };
    readonly up_dry_run?: { readonly would_restart_shared?: string[] };
  }

  it("#240: a dead shared service is restarted by the re-up, which exits 0 and names it", () => {
    const { wt } = setupScenario("dt-bcv7-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "10"], {
      env: { DEVTREES_STUB_DEAD: "db" },
    });
    expect(r.code, `re-up failed: ${r.stdout} ${r.stderr}`).toBe(0);
    expect((r.doc as SharedRestartDoc).up?.shared_restarted).toEqual(["db"]);
    expect((r.doc as SharedRestartDoc).up?.restarted).toEqual([]);
    expect(r.stderr).toContain("restarted dead shared service(s): db");
  }, 60_000);

  it("#240: a FRESH up against a running shared instance with a dead service restarts it, then starts the worktree", () => {
    // After `down`, the worktree's next up is a fresh start over an
    // already-running shared instance carrying a dead service.
    const { wt, sock } = setupScenario("dt-bcv8-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    expect(devtrees(wt, ["down"]).code).toBe(0);

    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "10"], {
      env: { DEVTREES_STUB_DEAD: "db" },
    });
    expect(r.code, `fresh up failed: ${r.stdout} ${r.stderr}`).toBe(0);
    expect((r.doc as SharedRestartDoc).up?.shared_restarted).toEqual(["db"]);
    expect(existsSync(sock)).toBe(true);
  }, 60_000);

  it("#240: up --dry-run previews the dead shared service up would restart (would_restart_shared)", () => {
    const { wt } = setupScenario("dt-bcva-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const env = { DEVTREES_STUB_DEAD: "db" };
    const dry = devtrees(wt, ["up", "--dry-run", "--json"], { env });
    expect(dry.code, `dry run failed: ${dry.stdout} ${dry.stderr}`).toBe(0);
    expect((dry.doc as SharedRestartDoc).up_dry_run?.would_restart_shared).toEqual(["db"]);
    // Read-only: the real up still finds db dead and restarts it.
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "10"], { env });
    expect((r.doc as SharedRestartDoc).up?.shared_restarted).toEqual(["db"]);
  }, 60_000);

  it("#240: a refused shared restart fails SHARED_SERVICE_DEAD start_refused", () => {
    const { wt } = setupScenario("dt-bcvb-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "10"], {
      env: { DEVTREES_STUB_DEAD: "db", DEVTREES_STUB_START_FAIL: "db" },
    });
    expect(r.code).toBe(1);
    const err = (r.doc as VerifyErrorDoc).error;
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.details).toMatchObject({
      dead_services: [{ name: "db", status: "Completed", exit_code: -1 }],
      reason: "start_refused",
      start_failures: [{ name: "db" }],
      remedy: "devtrees down --shared && devtrees up",
    });
  }, 60_000);

  it("#240: a restarted shared service that dies again fails fast with SHARED_SERVICE_DEAD died_again", () => {
    const { wt } = setupScenario("dt-bcvc-", { webProbe: false });
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const started = Date.now();
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "60"], {
      env: { DEVTREES_STUB_DEAD: "db", DEVTREES_STUB_DIES_AGAIN: "db" },
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.code).toBe(1);
    const err = (r.doc as VerifyErrorDoc).error;
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.message).toContain("died again");
    expect(err?.details).toMatchObject({
      dead_services: [{ name: "db", status: "Completed", exit_code: 1 }],
      reason: "died_again",
      remedy: "devtrees down --shared && devtrees up",
    });
  }, 90_000);

  it("a shared service dead right after this up lazy-started it fails fast with SHARED_SERVICE_DEAD (cross-tier wait)", () => {
    // Review repro (b): with a cross-tier edge the shared pre-wait used to sit
    // out 30s inside the lifecycle lock and fail with UNKNOWN and no remedy.
    const { wt, sock } = setupRepoWithStack(
      "dt-bcv9-",
      [
        "services:",
        "  db:",
        "    tier: shared",
        '    command: "sleep 300"',
        "    ports: [DB_PORT]",
        "  web:",
        "    tier: isolated",
        '    command: "sleep 300"',
        "    depends_on: [db]",
        "",
      ].join("\n"),
    );
    cleanups.push(() => devtrees(wt, ["down", "--shared"]));

    const started = Date.now();
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "10"], {
      env: { DEVTREES_STUB_DEAD: "db" },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.code, `up should fail: ${r.stdout} ${r.stderr}`).toBe(1);
    const err = (r.doc as VerifyErrorDoc).error;
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.details).toEqual({
      dead_services: [{ name: "db", status: "Completed", exit_code: -1 }],
      reason: "died_while_waiting",
      remedy: "devtrees down --shared && devtrees up",
    });
    expect(existsSync(sock)).toBe(false);
  }, 60_000);
});

describe("built CLI e2e — list-valued namespaces and dropped cross-namespace edges (#179)", () => {
  interface NsEdgeDoc {
    readonly up?: { readonly dropped_namespace_edges?: unknown };
    readonly up_dry_run?: {
      readonly dropped_namespace_edges?: unknown;
      readonly selected_services?: string[];
    };
    readonly error?: { readonly code?: string; readonly message?: string };
  }

  /** `db` in [one, two]; `api` (two) depends on `db`; `web` (one) depends on `api`. */
  function listScenario(prefix: string): Scenario {
    return setupRepoWithStack(
      prefix,
      [
        "services:",
        "  db:",
        "    namespace: [one, two]",
        '    command: "sleep 300"',
        "  api:",
        "    namespace: two",
        '    command: "sleep 300"',
        "    depends_on: [db]",
        "  web:",
        "    namespace: one",
        '    command: "sleep 300"',
        "    depends_on: [api]",
        "",
      ].join("\n"),
    );
  }

  const names = (wt: string, id: string): string[] | undefined =>
    (devtrees(wt, ["ls", "--json"]).doc as LsDoc).ls.instances
      .find((i) => i.id === id)
      ?.services.map((s) => s.name)
      .sort();

  it("up -n two starts db and api, not web, and a bare re-up targets `two` only", () => {
    const { wt, id } = listScenario("dt-bcl1-");
    const up = devtrees(wt, ["up", "-n", "two", "--json", "--wait-timeout", "10"]);
    expect(up.code, `up failed: ${up.stderr} ${up.stdout}`).toBe(0);
    expect((up.doc as NsEdgeDoc).up?.dropped_namespace_edges).toEqual([]);
    expect(names(wt, id)).toEqual(["api", "db"]);

    const again = devtrees(wt, ["up", "--json", "--wait-timeout", "10"]);
    expect(again.code, `bare re-up failed: ${again.stderr} ${again.stdout}`).toBe(0);
    expect((again.doc as UpDoc).up.services.map((s) => s.name).sort()).toEqual(["api", "db"]);

    // `one` is not running even though db (in [one, two]) is present.
    const one = devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "10"]);
    expect(one.code).toBe(1);
    expect((one.doc as NsEdgeDoc).error?.code).toBe("NAMESPACE_NOT_RUNNING");
  }, 60_000);

  it("up -n one warns about the dropped web -> api edge in human, --json and --dry-run output", () => {
    const { wt, id } = listScenario("dt-bcl2-");
    const edge = { from: "web", to: "api", to_namespaces: ["two"] };

    const dryJson = devtrees(wt, ["up", "-n", "one", "--dry-run", "--json"]);
    expect(dryJson.code).toBe(0);
    expect((dryJson.doc as NsEdgeDoc).up_dry_run?.dropped_namespace_edges).toEqual([edge]);
    expect((dryJson.doc as NsEdgeDoc).up_dry_run?.selected_services).toEqual(["db", "web"]);
    const dryHuman = devtrees(wt, ["up", "-n", "one", "--dry-run"]);
    expect(dryHuman.stderr).toContain("dropped cross-namespace depends_on 'web' -> 'api'");

    const human = devtrees(wt, ["up", "-n", "one", "--no-attach", "--wait-timeout", "10"]);
    expect(human.code, `up failed: ${human.stderr}`).toBe(0);
    expect(human.stderr).toContain("dropped cross-namespace depends_on 'web' -> 'api'");
    expect(names(wt, id)).toEqual(["db", "web"]);

    // A bare re-up uses the effective (booted) selection: still `one`.
    const json = devtrees(wt, ["up", "--json", "--wait-timeout", "10"]);
    expect(json.code, `re-up failed: ${json.stderr} ${json.stdout}`).toBe(0);
    expect((json.doc as NsEdgeDoc).up?.dropped_namespace_edges).toEqual([edge]);
  }, 60_000);

  it("a narrower -n on an instance booted with both namespaces reports no dropped edge", () => {
    const { wt } = listScenario("dt-bcl4-");
    const boot = devtrees(wt, ["up", "-n", "one", "-n", "two", "--json", "--wait-timeout", "10"]);
    expect(boot.code, `boot failed: ${boot.stderr} ${boot.stdout}`).toBe(0);
    const narrow = devtrees(wt, ["up", "-n", "one", "--json", "--wait-timeout", "10"]);
    expect(narrow.code, `narrow re-up failed: ${narrow.stderr} ${narrow.stdout}`).toBe(0);
    expect((narrow.doc as NsEdgeDoc).up?.dropped_namespace_edges).toEqual([]);
    expect(narrow.stderr).not.toContain("cross-namespace");
  }, 60_000);

  it("rejects an empty namespace list as CONFIG_INVALID", () => {
    const { wt } = setupRepoWithStack(
      "dt-bcl3-",
      ["services:", "  db:", "    namespace: []", '    command: "sleep 300"', ""].join("\n"),
    );
    const r = devtrees(wt, ["up", "--json"]);
    expect(r.code).toBe(1);
    expect((r.doc as NsEdgeDoc).error?.code).toBe("CONFIG_INVALID");
    expect((r.doc as NsEdgeDoc).error?.message).toContain("namespace list is empty");
  }, 30_000);
});

describe("built CLI e2e — hot-reload over the control socket (#194, #191)", () => {
  interface ReloadErrorDoc {
    readonly error?: { readonly code?: string; readonly details?: Record<string, unknown> };
  }

  /** `web` and `api` in the default namespace; `extra` lines are appended. */
  function reloadStack(extra: ReadonlyArray<string> = []): string {
    return [
      "services:",
      "  web:",
      "    tier: isolated",
      '    command: "sleep 300"',
      "    ports: [WEB_PORT]",
      "  api:",
      "    tier: isolated",
      '    command: "sleep 301"',
      ...extra,
      "",
    ].join("\n");
  }

  const names = (wt: string, id: string): string[] | undefined =>
    (devtrees(wt, ["ls", "--json"]).doc as LsDoc).ls.instances
      .find((i) => i.id === id)
      ?.services.map((s) => s.name)
      .sort();

  it("a drifted up reloads through POST /project/configuration and the project picks up the new service", () => {
    const { wt, id, stateDir } = setupRepoWithStack("dt-bcr1-", reloadStack());
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    expect(names(wt, id)).toEqual(["api", "web"]);

    writeFileSync(
      join(wt, "devtrees.yaml"),
      reloadStack(["  worker:", "    tier: isolated", '    command: "sleep 302"']),
    );
    const reload = devtrees(wt, ["up", "--json", "--wait-timeout", "10"]);
    expect(reload.code, `drifted up failed: ${reload.stderr} ${reload.stdout}`).toBe(0);
    // The stub's reload handler re-read the derived config: `process list`
    // now reports the added service, and the on-disk config carries it.
    expect(names(wt, id)).toEqual(["api", "web", "worker"]);
    expect(readFileSync(join(stateDir, `${id}.yaml`), "utf8")).toContain("sleep 302");
    // The new hash was stored: the next up is a noop that still exits 0.
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
  }, 60_000);

  it("a pending reload refuses with CONFIG_DRIFT reload_pending, then reloads once it converged (#191)", () => {
    const { wt, id, stateDir } = setupRepoWithStack("dt-bcr2-", reloadStack());
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    // What a timed-out reload leaves behind; this test process stands in for
    // the old `web` process that will not exit.
    const marker = join(stateDir, `${id}.reload-pending.json`);
    writeFileSync(
      marker,
      JSON.stringify({ services: ["web"], oldRuns: [{ name: "web", pid: process.pid }] }),
    );
    writeFileSync(join(wt, "devtrees.yaml"), reloadStack().replace("sleep 300", "sleep 303"));
    const configBefore = readFileSync(join(stateDir, `${id}.yaml`), "utf8");

    const refused = devtrees(wt, ["up", "--json", "--wait-timeout", "10"]);
    expect(refused.code).toBe(1);
    expect((refused.doc as ReloadErrorDoc).error).toMatchObject({
      code: "CONFIG_DRIFT",
      details: { reason: "reload_pending", services: ["web"], pids: [process.pid] },
    });
    // Nothing was reloaded.
    expect(readFileSync(join(stateDir, `${id}.yaml`), "utf8")).toBe(configBefore);

    const human = devtrees(wt, ["up", "--no-attach"]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain(`kill ${process.pid}`);

    // The old process is gone and `web` is in the project: the reload runs.
    writeFileSync(
      marker,
      JSON.stringify({ services: ["web"], oldRuns: [{ name: "web", pid: 2 ** 22 + 12345 }] }),
    );
    const resync = devtrees(wt, ["up", "--json", "--wait-timeout", "10"]);
    expect(resync.code, `resync failed: ${resync.stderr} ${resync.stdout}`).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(stateDir, `${id}.yaml`), "utf8")).toContain("sleep 303");
  }, 60_000);
});

/**
 * Namespaced shared teardown (#239) through `dist/cli.mjs`: the flags reach
 * `runSharedNamespaceDown`, the dependant check reads the worktree's derived
 * config, and the removal is a reload the stub applies.
 */
describe("built CLI e2e — namespaced shared teardown (#239)", () => {
  /** Always-on shared `db`, shared `sa` in `a`, isolated `web` and `worker` (in `a`, on `sa`). */
  function setupNsShared(prefix: string): Scenario {
    const scenario = setupRepoWithStack(
      prefix,
      [
        "services:",
        "  db:",
        "    tier: shared",
        '    command: "sleep 300"',
        "    ports: [DB_PORT]",
        "  sa:",
        "    tier: shared",
        "    namespace: a",
        '    command: "sleep 301"',
        "    ports: [SA_PORT]",
        "  web:",
        "    tier: isolated",
        '    command: "sleep 302"',
        "  worker:",
        "    tier: isolated",
        "    namespace: a",
        '    command: "sleep 303"',
        "    depends_on:",
        "      sa:",
        "        condition: process_started",
        "",
      ].join("\n"),
    );
    cleanups.push(() => devtrees(scenario.wt, ["down", "--shared"]));
    return scenario;
  }

  type NsDown = {
    down?: { stopped: boolean; services: string[]; instance_stopped: boolean };
    down_dry_run?: { services: string[]; blocked: boolean; dependants: unknown[] };
    error?: { code: string; details: Record<string, unknown> };
  };
  const sharedProcs = (anchor: string): string[] =>
    Object.keys(
      (
        parseYaml(readFileSync(join(anchor, "devtrees", "shared.yaml"), "utf8")) as {
          processes: Record<string, unknown>;
        }
      ).processes,
    );
  const upNs = (wt: string): CliResult =>
    devtrees(wt, ["up", "--json", "--wait-timeout", "10", "-n", "default", "-n", "a"]);

  it("refuses SHARED_IN_USE while this worktree's worker depends on sa, then removes sa once it is down", () => {
    const { wt, id, anchor } = setupNsShared("dt-bcsd1-");
    const up = upNs(wt);
    expect(up.code, `up failed: ${up.stdout} ${up.stderr}`).toBe(0);
    expect(sharedProcs(anchor)).toEqual(["db", "sa"]);

    const dry = devtrees(wt, ["down", "--shared", "-n", "a", "--dry-run", "--json"]);
    expect(dry.code, dry.stdout).toBe(0);
    expect((dry.doc as NsDown).down_dry_run).toMatchObject({
      services: ["sa"],
      blocked: true,
      dependants: [{ instance: id, service: "worker", depends_on: ["sa"] }],
    });

    const refused = devtrees(wt, ["down", "--shared", "-n", "a", "--json"]);
    expect(refused.code).toBe(1);
    expect((refused.doc as NsDown).error?.code).toBe("SHARED_IN_USE");
    expect(sharedProcs(anchor)).toEqual(["db", "sa"]);

    expect(devtrees(wt, ["down"]).code).toBe(0);
    const down = devtrees(wt, ["down", "--shared", "-n", "a", "--json"]);
    expect(down.code, `down failed: ${down.stdout} ${down.stderr}`).toBe(0);
    expect((down.doc as NsDown).down).toMatchObject({
      stopped: true,
      services: ["sa"],
      instance_stopped: false,
    });
    expect(sharedProcs(anchor)).toEqual(["db"]);

    // `up -n a` adds it back, as it would any not-yet-running shared service.
    const back = upNs(wt);
    expect(back.code, `re-up failed: ${back.stdout} ${back.stderr}`).toBe(0);
    expect((back.doc as { up: { shared_activated: string[] } }).up.shared_activated).toEqual([
      "sa",
    ]);
    expect(sharedProcs(anchor)).toEqual(["db", "sa"]);
  }, 90_000);

  it("an up re-adding a service a timed-out removal left listed and stopped starts it again", () => {
    // What a removing reload that timed out and never landed leaves behind:
    // the process stopped and still listed, gone from the config and the state.
    const { wt, anchor } = setupNsShared("dt-bcsd3-");
    expect(upNs(wt).code).toBe(0);
    expect(devtrees(wt, ["down"]).code).toBe(0);
    const shared = sharedInstancePaths(anchor);
    const stop = spawnSync(
      join(shimDir, "process-compose"),
      ["process", "stop", "sa", "-U", "-u", shared.socketPath],
      { encoding: "utf8" },
    );
    expect(stop.status, stop.stderr).toBe(0);
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

    const back = upNs(wt);
    expect(back.code, `re-up failed: ${back.stdout} ${back.stderr}`).toBe(0);
    const doc = back.doc as { up: { shared_activated: string[]; shared_restarted: string[] } };
    expect(doc.up.shared_activated).toEqual(["sa"]);
    expect(doc.up.shared_restarted).toEqual(["sa"]);
    const ls = devtrees(wt, ["ls", "--json", "--services"]);
    const rows = (ls.doc as LsDoc).ls.instances.find((i) => i.kind === "shared")?.services ?? [];
    expect(rows.find((r) => r.name === "sa")).toMatchObject({ state: "active" });
  }, 90_000);

  it("a dead namespaced shared service's SHARED_SERVICE_DEAD names the namespaced teardown", () => {
    const { wt } = setupNsShared("dt-bcsd4-");
    expect(upNs(wt).code).toBe(0);
    const r = devtrees(wt, ["up", "--json", "--wait-timeout", "10", "-n", "default", "-n", "a"], {
      env: { DEVTREES_STUB_DEAD: "sa", DEVTREES_STUB_START_FAIL: "sa" },
    });
    expect(r.code).toBe(1);
    const err = (r.doc as NsDown).error;
    expect(err?.code).toBe("SHARED_SERVICE_DEAD");
    expect(err?.details).toMatchObject({
      reason: "start_refused",
      remedy: "devtrees down --shared -n a && devtrees up -n default -n a",
    });
    // An always-on one still gets the full teardown.
    const db = devtrees(wt, ["up", "--json", "--wait-timeout", "10", "-n", "default", "-n", "a"], {
      env: { DEVTREES_STUB_DEAD: "db", DEVTREES_STUB_START_FAIL: "db" },
    });
    expect((db.doc as NsDown).error?.details).toMatchObject({
      remedy: "devtrees down --shared && devtrees up",
    });
  }, 60_000);

  it("`down -n a` without --shared fails INVALID_ARGS and touches nothing", () => {
    const { wt, sock } = setupNsShared("dt-bcsd2-");
    expect(devtrees(wt, ["up", "--json", "--wait-timeout", "10"]).code).toBe(0);
    const r = devtrees(wt, ["down", "-n", "a", "--json"]);
    expect(r.code).toBe(1);
    expect((r.doc as NsDown).error?.code).toBe("INVALID_ARGS");
    expect(existsSync(sock)).toBe(true);
  }, 60_000);
});
