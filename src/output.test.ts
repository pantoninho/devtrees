/**
 * Output formatter (the agent-facing seam, PRD #26 / issue #27).
 *
 * The formatter is the only place stdout content is produced for a command
 * path. Every test here pins down a public-interface behaviour — given this
 * payload + mode, this is the rendered output — so the seam stays unit-testable
 * without booting a command.
 */

import { describe, expect, it } from "vite-plus/test";
import {
  ERROR_CODES,
  ERROR_CODE_DESCRIPTIONS,
  SCHEMA_VERSION,
  classifyError,
  formatDown,
  formatEnv,
  formatError,
  formatInit,
  formatLogLine,
  formatLs,
  formatPrune,
  formatRestart,
  formatUp,
  formatDroppedEdgeWarning,
  formatUpDryRun,
  formatDroppedNamespaceEdgeWarning,
  formatBracedEnvVarWarning,
  type ErrorCode,
  type LsInstanceRow,
  type LsServiceRow,
  type PrunedRow,
  type UpDryRunPayload,
  type UpPayload,
} from "./output.js";
import type { DroppedEdge } from "./deriver.js";
import { parse as parseYaml } from "yaml";

describe("output formatter — constants", () => {
  it("declares a schema_version string", () => {
    expect(typeof SCHEMA_VERSION).toBe("string");
    expect(SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it("includes the error codes the foundation slice promises (PRD §error envelope)", () => {
    // Slice #1 must define at least these two; later slices add HEALTH_TIMEOUT,
    // CONFIG_DRIFT, LOCK_CONTENTION, CONFIG_INVALID, STALE_PORT_BLOCK per ADR-0005.
    expect(ERROR_CODES).toContain("PROCESS_COMPOSE_NOT_FOUND");
    expect(ERROR_CODES).toContain("INSTANCE_NOT_FOUND");
  });

  it("declares PROCESS_COMPOSE_TOO_OLD for the minimum-version pre-flight (#173)", () => {
    expect(ERROR_CODES).toContain("PROCESS_COMPOSE_TOO_OLD");
  });

  it("reserves STALE_PORT_BLOCK so #58 routes via classifyError's typed-code short-circuit", () => {
    expect(ERROR_CODES).toContain("STALE_PORT_BLOCK");
  });

  it("declares SHARED_DRIFT so #83's shared-subset drift routes via the typed-code short-circuit", () => {
    expect(ERROR_CODES).toContain("SHARED_DRIFT");
  });

  it("declares SOCKET_PATH_TOO_LONG so #156's over-long sun_path is discoverable, not silent", () => {
    expect(ERROR_CODES).toContain("SOCKET_PATH_TOO_LONG");
  });

  it("declares WORKTREE_START_FAILED alongside SHARED_START_FAILED so #157 can name the right instance", () => {
    // Two spawns, two instances, two codes: an agent branches on the code to
    // decide whether to `down` or `down --shared`, so the worktree failure
    // cannot keep borrowing the shared instance's envelope.
    expect(ERROR_CODES).toContain("SHARED_START_FAILED");
    expect(ERROR_CODES).toContain("WORKTREE_START_FAILED");
  });

  it("declares NO_SERVICES_SELECTED so a bare up with nothing in `default` fails loudly (#176)", () => {
    expect(ERROR_CODES).toContain("NO_SERVICES_SELECTED");
  });

  it("declares INSTANCE_UNRESPONSIVE so an unanswered probe fails instead of guessing (#186)", () => {
    expect(ERROR_CODES).toContain("INSTANCE_UNRESPONSIVE");
  });
});

describe("output formatter — classifyError", () => {
  it("propagates a typed error's .details object to the envelope (so STALE_PORT_BLOCK can publish its collisions)", () => {
    const err = Object.assign(new Error("stale block"), {
      code: "STALE_PORT_BLOCK",
      details: {
        block_base: 40256,
        worktree_id: "login",
        collisions: [
          { port_name: "WEB_PORT", port: 40256, pid: 76705, command: "node server.mjs" },
        ],
      },
    });
    const payload = classifyError(err);
    expect(payload.code).toBe("STALE_PORT_BLOCK");
    expect(payload.details).toEqual({
      block_base: 40256,
      worktree_id: "login",
      collisions: [{ port_name: "WEB_PORT", port: 40256, pid: 76705, command: "node server.mjs" }],
    });
  });

  it("routes WORKTREE_START_FAILED through the typed-code short-circuit with its config_path (#157)", () => {
    // `config_path` is the whole point of the separate code: it is the file an
    // agent runs by hand, and it is NOT the shared config the old
    // SHARED_START_FAILED envelope told it to reach for.
    const err = Object.assign(new Error("this worktree's instance (login-a1b2) was spawned but…"), {
      code: "WORKTREE_START_FAILED",
      details: {
        worktree_id: "login-a1b2",
        socket_path: "/tmp/devtrees-501/abc/login-a1b2.sock",
        config_path: "/repo/.git/devtrees/login-a1b2.yaml",
        timeout_ms: 3000,
      },
    });
    const payload = classifyError(err);
    expect(payload.code).toBe("WORKTREE_START_FAILED");
    expect(payload.details).toMatchObject({
      worktree_id: "login-a1b2",
      config_path: "/repo/.git/devtrees/login-a1b2.yaml",
    });
  });

  it("leaves .details undefined when the typed error doesn't carry one (CONFIG_DRIFT / HEALTH_TIMEOUT today)", () => {
    const err = Object.assign(new Error("drifted"), { code: "CONFIG_DRIFT" });
    const payload = classifyError(err);
    expect(payload.code).toBe("CONFIG_DRIFT");
    expect(payload.details).toBeUndefined();
  });
});

describe("output formatter — formatError", () => {
  it("in JSON mode, emits {error:{code,message,details}} on stdout and the human diagnostic on stderr (ADR-0005)", () => {
    const result = formatError(
      {
        code: "INSTANCE_NOT_FOUND",
        message: "no worktree instance is running for 'login'",
        details: { worktreeId: "login" },
      },
      "json",
    );
    // stderr keeps today's diagnostic so a captured log is still readable
    // without merging streams (ADR-0005 "JSON errors on stdout").
    expect(result.stderr).toContain("no worktree instance is running for 'login'");
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      schema_version: SCHEMA_VERSION,
      error: {
        code: "INSTANCE_NOT_FOUND",
        message: "no worktree instance is running for 'login'",
        details: { worktreeId: "login" },
      },
    });
  });

  it("in JSON mode, omits the details field when none was provided", () => {
    const result = formatError(
      { code: "PROCESS_COMPOSE_NOT_FOUND", message: "process-compose not found on PATH" },
      "json",
    );
    const parsed = JSON.parse(result.stdout) as { error: { details?: unknown } };
    expect(parsed.error.details).toBeUndefined();
  });

  it("in human mode, writes the message to stderr and leaves stdout empty (today's diagnostics)", () => {
    const result = formatError(
      { code: "PROCESS_COMPOSE_NOT_FOUND", message: "process-compose not found on PATH" },
      "human",
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("process-compose not found on PATH");
  });

  // #111: the formatter is the single seam that owns the `devtrees:` prefix.
  // A message must never reach `formatError` already carrying one, otherwise
  // stderr renders the doubled `devtrees: devtrees:` observed on SHARED_DRIFT.
  it("in human mode, prefixes stderr with `devtrees:` exactly once", () => {
    const result = formatError(
      { code: "SHARED_DRIFT", message: "this worktree's shared services diverge" },
      "human",
    );
    expect(result.stderr.match(/devtrees:/g)).toHaveLength(1);
    expect(result.stderr).toBe("devtrees: this worktree's shared services diverge\n");
  });

  it("in JSON mode, prefixes the stderr diagnostic with `devtrees:` exactly once", () => {
    const result = formatError(
      { code: "SHARED_DRIFT", message: "this worktree's shared services diverge" },
      "json",
    );
    expect(result.stderr.match(/devtrees:/g)).toHaveLength(1);
    expect(result.stderr).toBe("devtrees: this worktree's shared services diverge\n");
  });
});

describe("output formatter — formatLs", () => {
  // Distinct fixture from cli.test.ts so the two tests pin behaviour
  // independently — the formatter doesn't care which ids/ports the caller
  // hands it.
  const rows: ReadonlyArray<LsInstanceRow> = [
    { id: "alpha", kind: "shared", status: "running", ports: { CACHE: 40001 }, blockBase: 40001 },
    { id: "beta", kind: "worktree", status: "stale", ports: { API: 40097 }, blockBase: 40097 },
  ];

  it("in human mode, renders the existing table (id/kind/status/ports)", () => {
    const result = formatLs(rows, "human");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).toContain("beta");
    expect(result.stdout).toContain("CACHE=40001");
    expect(result.stdout).toContain("API=40097");
  });

  it("shows an instance whose liveness is unknown with that status, in both modes (#186)", () => {
    const unknown: LsInstanceRow = {
      id: "gamma",
      kind: "worktree",
      status: "unknown",
      ports: { WEB: 40129 },
      blockBase: 40129,
    };
    expect(formatLs([unknown], "human").stdout).toMatch(
      /gamma\s+worktree\s+unknown\s+\?\s+WEB=40129/,
    );
    const parsed = JSON.parse(formatLs([unknown], "json").stdout) as {
      ls: { instances: ReadonlyArray<{ id: string; status: string }> };
    };
    expect(parsed.ls.instances).toEqual([
      expect.objectContaining({ id: "gamma", status: "unknown" }),
    ]);
  });

  it("in human mode with no instances, prints the existing 'no instances' line", () => {
    const result = formatLs([], "human");
    expect(result.stdout).toMatch(/no devtrees instances/i);
  });

  it("in JSON mode, wraps the payload under {schema_version, ls:{instances:[...]}}", () => {
    const result = formatLs(rows, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      ls: {
        instances: ReadonlyArray<{
          id: string;
          kind: string;
          status: string;
          ports: Record<string, number>;
          block_base?: number;
        }>;
      };
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    // Top-level `instances` is gone — the payload is namespaced under `ls`.
    expect(parsed).not.toHaveProperty("instances");
    expect(parsed.ls.instances).toHaveLength(2);
    expect(parsed.ls.instances[0]).toEqual({
      id: "alpha",
      kind: "shared",
      status: "running",
      ports: { CACHE: 40001 },
      namespaces: [],
      services_read: "skipped",
      reload_pending: false,
      services: [],
      block_base: 40001,
    });
    expect(parsed.ls.instances[1]).toEqual({
      id: "beta",
      kind: "worktree",
      status: "stale",
      ports: { API: 40097 },
      namespaces: [],
      services_read: "skipped",
      reload_pending: false,
      services: [],
      block_base: 40097,
    });
  });

  it("in JSON mode with no instances, emits {ls:{instances:[]}} (not 'no instances' text)", () => {
    const result = formatLs([], "json");
    const parsed = JSON.parse(result.stdout) as { ls: { instances: unknown[] } };
    expect(parsed.ls.instances).toEqual([]);
  });

  it("in JSON mode, omits block_base when the registry has no entry for the socket", () => {
    const result = formatLs(
      [
        {
          id: "orphan",
          kind: "worktree",
          status: "stale",
          ports: {},
          blockBase: undefined,
        },
      ],
      "json",
    );
    const parsed = JSON.parse(result.stdout) as {
      ls: { instances: ReadonlyArray<Record<string, unknown>> };
    };
    expect(parsed.ls.instances[0]).not.toHaveProperty("block_base");
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatLs(rows, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    // exactly one trailing newline
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });

  /**
   * services[] nesting (issue #29) — `ls --json` carries per-service rows
   * (name/status/health/ports) so an agent can ask "is `worker` healthy in
   * my worktree instance?" with one call. The human path stays unchanged.
   */
  describe("formatLs — services[] nesting (issue #29)", () => {
    const rowsWithServices: ReadonlyArray<LsInstanceRow> = [
      {
        id: "login",
        kind: "worktree",
        status: "running",
        ports: { WEB_PORT: 20000, WORKER_PORT: 20001 },
        blockBase: 20000,
        services: [
          {
            name: "web",
            status: "Running",
            health: "ready",
            ports: { WEB_PORT: 20000 },
            namespaces: ["app"],
            tier: "isolated",
            state: "active",
            pid: 4242,
          },
          {
            name: "worker",
            status: "Running",
            health: "not_ready",
            ports: { WORKER_PORT: 20001 },
            namespaces: ["app", "jobs"],
            tier: "isolated",
            state: "active",
          },
        ],
      },
    ];

    it("emits one services[] row per service with name, status, health, ports and ADR-0009's fields (#226)", () => {
      const result = formatLs(rowsWithServices, "json");
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
      expect(parsed.ls.instances[0]?.services).toEqual([
        {
          name: "web",
          status: "Running",
          health: "ready",
          ports: { WEB_PORT: 20000 },
          namespaces: ["app"],
          tier: "isolated",
          state: "active",
          pid: 4242,
        },
        {
          name: "worker",
          status: "Running",
          health: "not_ready",
          ports: { WORKER_PORT: 20001 },
          namespaces: ["app", "jobs"],
          tier: "isolated",
          state: "active",
          pid: null,
        },
      ]);
    });

    it("emits services:[] when an instance has no service rows (stale / no driver call)", () => {
      const result = formatLs(
        [
          {
            id: "stale-one",
            kind: "worktree",
            status: "stale",
            ports: {},
            blockBase: 20000,
            services: [],
          },
        ],
        "json",
      );
      const parsed = JSON.parse(result.stdout) as {
        ls: { instances: ReadonlyArray<{ services: unknown[] }> };
      };
      expect(parsed.ls.instances[0]?.services).toEqual([]);
    });

    it("defaults services to [] when the row doesn't carry one (back-compat: optional in the row type)", () => {
      // Older callers (and the human path) hand the formatter rows without
      // services. JSON output must still include the field — the schema
      // promise is `services[] on every instance entry`.
      const result = formatLs(rows, "json");
      const parsed = JSON.parse(result.stdout) as {
        ls: { instances: ReadonlyArray<{ services?: unknown }> };
      };
      for (const inst of parsed.ls.instances) expect(inst.services).toEqual([]);
    });

    it("human-mode ls is byte-for-byte unchanged when services are present", () => {
      const withServices = formatLs(rowsWithServices, "human").stdout;
      const withoutServices = formatLs(
        rowsWithServices.map(({ services: _unused, ...rest }) => rest),
        "human",
      ).stdout;
      expect(withServices).toBe(withoutServices);
    });
  });

  /**
   * Issue #226 (ADR-0009): `ls` shows each instance's booted namespaces, and
   * `--services` one row per service, so acting on one service starts from
   * seeing it. An instance whose read did not answer is shown as unknown.
   */
  describe("formatLs — namespaces and --services (#226)", () => {
    const shared: LsInstanceRow = {
      id: "shared",
      kind: "shared",
      status: "running",
      ports: { DB_PORT: 30000 },
      namespaces: ["default"],
      servicesRead: "ok",
      services: [
        {
          name: "db",
          status: "Running",
          health: "unknown",
          ports: { DB_PORT: 30000 },
          namespaces: ["default"],
          tier: "shared",
          state: "active",
          pid: 100,
        },
      ],
    };
    const login: LsInstanceRow = {
      id: "login",
      kind: "worktree",
      status: "running",
      ports: { WEB_PORT: 20000 },
      namespaces: ["app", "ios"],
      servicesRead: "ok",
      services: [
        {
          name: "web",
          status: "Running",
          health: "ready",
          ports: { WEB_PORT: 20000 },
          namespaces: ["app"],
          tier: "isolated",
          state: "active",
          pid: 200,
        },
        {
          name: "sim",
          status: "Completed",
          health: "unknown",
          ports: {},
          namespaces: ["ios"],
          tier: "isolated",
          state: "dead",
        },
      ],
    };
    const wedged: LsInstanceRow = {
      id: "wedged",
      kind: "worktree",
      status: "running",
      ports: { WEB_PORT: 20032 },
      servicesRead: "unresponsive",
    };
    const stale: LsInstanceRow = {
      id: "gone",
      kind: "worktree",
      status: "stale",
      ports: {},
      blockBase: 20064,
      servicesRead: "skipped",
    };

    it("human ls has a NAMESPACES column: booted namespaces, `?` when unreadable, `-` when stale", () => {
      const out = formatLs([shared, login, wedged, stale], "human");
      expect(out.stdout.split("\n")).toEqual([
        "ID      KIND      STATUS   NAMESPACES  PORTS",
        "shared  shared    running  default     DB_PORT=30000",
        "login   worktree  running  app,ios     WEB_PORT=20000",
        "wedged  worktree  running  ?           WEB_PORT=20032",
        "gone    worktree  stale    -           (block 20064)",
        "",
      ]);
      expect(out.stderr).toMatch(/wedged did not answer/);
      expect(out.stderr).not.toMatch(/login|shared|gone/);
    });

    it("human ls --services prints one row per service, and says why an instance has none", () => {
      const unknown: LsInstanceRow = { id: "u", kind: "worktree", status: "unknown", ports: {} };
      const empty: LsInstanceRow = { ...login, id: "empty", services: [], namespaces: [] };
      const out = formatLs([shared, login, wedged, stale, unknown, empty], "human", {
        services: true,
      });
      expect(out.stdout.split("\n")).toEqual([
        "INSTANCE  SERVICE         NAMESPACES  TIER      STATE   PID",
        "shared    db              default     shared    active  100",
        "login     web             app         isolated  active  200",
        "login     sim             ios         isolated  dead    -",
        "wedged    (unresponsive)  ?           isolated  ?       -",
        "gone      (stale)         -           isolated  -       -",
        "u         (unknown)       ?           isolated  ?       -",
        "empty     (none)          -           isolated  -       -",
        "",
      ]);
      expect(out.stderr).toMatch(/wedged did not answer/);
    });

    it("an instance whose liveness is unknown shows `?`, not `-`", () => {
      const unknown: LsInstanceRow = { id: "u", kind: "worktree", status: "unknown", ports: {} };
      expect(formatLs([unknown], "human").stdout).toMatch(/^u\s+worktree\s+unknown\s+\?\s+-$/m);
    });

    it("namespaces not known (`null`) read `?` in the table and `null` in JSON", () => {
      const noConfig: LsInstanceRow = { ...login, id: "noconf", namespaces: null };
      expect(formatLs([noConfig], "human").stdout).toMatch(/^noconf\s+worktree\s+running\s+\?\s/m);
      const parsed = JSON.parse(formatLs([noConfig], "json").stdout) as {
        ls: { instances: ReadonlyArray<{ namespaces: unknown }> };
      };
      expect(parsed.ls.instances[0]?.namespaces).toBeNull();
    });

    it("a pending reload is flagged in JSON and noted on stderr", () => {
      const pending: LsInstanceRow = { ...login, reloadPending: true };
      const human = formatLs([pending], "human");
      expect(human.stderr).toMatch(/login has a config reload still pending/);
      const parsed = JSON.parse(formatLs([pending, stale], "json").stdout) as {
        ls: { instances: ReadonlyArray<{ reload_pending: unknown }> };
      };
      expect(parsed.ls.instances.map((i) => i.reload_pending)).toEqual([true, false]);
    });

    it("JSON carries namespaces and services_read per instance, whatever --services says", () => {
      const json = formatLs([login, wedged, stale], "json");
      expect(formatLs([login, wedged, stale], "json", { services: true }).stdout).toBe(json.stdout);
      const parsed = JSON.parse(json.stdout) as {
        ls: { instances: ReadonlyArray<Record<string, unknown>> };
      };
      expect(json.stderr).toBe("");
      expect(parsed.ls.instances.map((i) => [i.id, i.namespaces, i.services_read])).toEqual([
        ["login", ["app", "ios"], "ok"],
        ["wedged", null, "unresponsive"],
        ["gone", [], "skipped"],
      ]);
      expect(parsed.ls.instances[0]?.services).toContainEqual({
        name: "sim",
        status: "Completed",
        health: "unknown",
        ports: {},
        namespaces: ["ios"],
        tier: "isolated",
        state: "dead",
        pid: null,
      });
    });
  });
});

describe("output formatter — formatEnv", () => {
  const sample: Readonly<Record<string, string>> = {
    DEVTREES_WORKTREE_ID: "login",
    WEB_PORT: "20512",
    DB_PORT: "30000",
  };

  it("in human mode, emits one KEY=value line per entry, suitable for `eval $(devtrees env)`", () => {
    const result = formatEnv(sample, "human");
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toContain("DEVTREES_WORKTREE_ID=login");
    expect(lines).toContain("WEB_PORT=20512");
    expect(lines).toContain("DB_PORT=30000");
    expect(lines).toHaveLength(3);
    expect(result.stdout.endsWith("\n")).toBe(true);
  });

  it("in human mode with no entries, emits empty stdout (no trailing chatter)", () => {
    const result = formatEnv({}, "human");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("in JSON mode, wraps the map under {schema_version, env}", () => {
    const result = formatEnv(sample, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      env: Record<string, string>;
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.env).toEqual(sample);
  });

  it("in JSON mode with no entries, emits {env:{}} (not 'no env' text)", () => {
    const result = formatEnv({}, "json");
    const parsed = JSON.parse(result.stdout) as { env: Record<string, string> };
    expect(parsed.env).toEqual({});
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatEnv(sample, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });
});

/**
 * `formatUp` — `devtrees up` success envelope (issue #30).
 *
 * On `--json` success, an agent must read one document carrying everything it
 * would otherwise piece together from `ls --json` + `env --json`: the
 * allocated port block, the per-service runtime rows, and the injected-value
 * map. The human path stays byte-for-byte unchanged.
 */
describe("output formatter — formatUp", () => {
  const services: ReadonlyArray<LsServiceRow> = [
    { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20512 } },
    { name: "worker", status: "Running", health: "ready", ports: {} },
  ];
  const payload: UpPayload = {
    worktreeId: "login",
    env: { DEVTREES_WORKTREE_ID: "login", WEB_PORT: "20512", DB_PORT: "30000" },
    sharedStarted: true,
    blockBase: 20512,
    services,
  };

  it("in human mode, renders today's text (id + KEY=value lines + optional shared note)", () => {
    const result = formatUp(payload, "human");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("'login' is up");
    expect(result.stdout).toContain("WEB_PORT=20512");
    expect(result.stdout).toContain("DB_PORT=30000");
    expect(result.stdout).toContain("shared instance started");
  });

  it("in human mode, output is byte-for-byte unchanged when block_base/services are added", () => {
    const withFields = formatUp(payload, "human").stdout;
    const withoutFields = formatUp(
      {
        worktreeId: payload.worktreeId,
        env: payload.env,
        sharedStarted: payload.sharedStarted,
      } as UpPayload,
      "human",
    ).stdout;
    expect(withFields).toBe(withoutFields);
  });

  it("in JSON mode, emits the full state envelope: schema_version + worktree_id + block_base + env + services + shared_started", () => {
    const result = formatUp(payload, "json");
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
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.up.worktree_id).toBe("login");
    expect(parsed.up.block_base).toBe(20512);
    expect(parsed.up.shared_started).toBe(true);
    expect(parsed.up.env).toEqual({
      DEVTREES_WORKTREE_ID: "login",
      WEB_PORT: "20512",
      DB_PORT: "30000",
    });
    expect(parsed.up.services).toEqual([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20512 } },
      { name: "worker", status: "Running", health: "ready", ports: {} },
    ]);
  });

  it("in JSON mode, defaults services to [] when the caller didn't populate them", () => {
    const result = formatUp(
      {
        worktreeId: "login",
        env: { WEB_PORT: "20512" },
        sharedStarted: false,
        blockBase: 20512,
      } as UpPayload,
      "json",
    );
    const parsed = JSON.parse(result.stdout) as {
      up: { services: unknown[]; restarted: unknown[] };
    };
    expect(parsed.up.services).toEqual([]);
    expect(parsed.up.restarted).toEqual([]);
  });

  it("reports the dead services this up restarted (#178), in both modes", () => {
    const withRestart: UpPayload = { ...payload, restarted: ["toy", "seed"] };
    const json = JSON.parse(formatUp(withRestart, "json").stdout) as {
      up: { restarted: string[] };
    };
    expect(json.up.restarted).toEqual(["toy", "seed"]);
    const human = formatUp(withRestart, "human").stdout;
    expect(human).toContain("devtrees up: restarted dead service(s): toy, seed.\n");
    expect(human).toContain("'login' is up");
    // Nothing restarted: no note.
    expect(formatUp(payload, "human").stdout).not.toContain("restarted");
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatUp(payload, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });
});

/**
 * `formatUpDryRun` — `devtrees up --dry-run` envelope (#124). The agent-facing
 * preview of what `up` would run: the derived config(s) and the resolved env
 * (allocated worktree ports + injected shared ports), with no side effects.
 * A sibling reads the allocated `WEB_PORT`/`DB_PORT` off `up_dry_run.env`.
 */
describe("output formatter — formatUpDryRun (#124)", () => {
  const config = {
    processes: { web: { command: "node server.js", working_dir: "/wt", environment: [] } },
    "x-devtrees": { ports_by_service: { web: { WEB_PORT: 20512 } } },
  };
  const sharedConfig = {
    processes: { db: { command: "postgres", working_dir: "/anchor", environment: [] } },
    "x-devtrees": { ports_by_service: { db: { DB_PORT: 30000 } } },
  };
  const payload: UpDryRunPayload = {
    worktreeId: "login",
    env: { DEVTREES_WORKTREE_ID: "login", WEB_PORT: "20512", DB_PORT: "30000" },
    config,
    sharedEnv: { DB_PORT: "30000" },
    sharedConfig,
  };

  it("in JSON mode, emits schema_version + worktree_id + env + config + shared_config", () => {
    const result = formatUpDryRun(payload, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      up_dry_run: {
        worktree_id: string;
        env: Record<string, string>;
        config: unknown;
        shared_env?: Record<string, string>;
        shared_config?: unknown;
      };
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.up_dry_run.worktree_id).toBe("login");
    // A sibling reads the allocated ports straight off env (#125).
    expect(parsed.up_dry_run.env).toEqual({
      DEVTREES_WORKTREE_ID: "login",
      WEB_PORT: "20512",
      DB_PORT: "30000",
    });
    expect(parsed.up_dry_run.config).toEqual(config);
    expect(parsed.up_dry_run.shared_env).toEqual({ DB_PORT: "30000" });
    expect(parsed.up_dry_run.shared_config).toEqual(sharedConfig);
  });

  it("in JSON mode, omits shared_config/shared_env when the stack has no shared services", () => {
    const result = formatUpDryRun(
      { worktreeId: "login", env: { WEB_PORT: "20512" }, config },
      "json",
    );
    const parsed = JSON.parse(result.stdout) as {
      up_dry_run: Record<string, unknown>;
    };
    expect("shared_config" in parsed.up_dry_run).toBe(false);
    expect("shared_env" in parsed.up_dry_run).toBe(false);
  });

  it("JSON output is one byte-clean document with a single trailing newline", () => {
    const result = formatUpDryRun(payload, "json");
    expect(result.stdout.startsWith("{")).toBe(true);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
    // Exactly one JSON document on stdout, nothing else.
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("in human mode, prints the derived YAML (worktree, then shared), nothing on stderr", () => {
    const result = formatUpDryRun(payload, "human");
    expect(result.stderr).toBe("");
    // The worktree config round-trips through YAML.
    expect(result.stdout).toContain("node server.js");
    expect(result.stdout).toContain("postgres");
    // The emitted document parses back into the derived configs.
    const docs = result.stdout.split(/^---$/m).map((d) => parseYaml(d));
    expect(docs).toContainEqual(config);
    expect(docs).toContainEqual(sharedConfig);
  });

  it("in human mode with no shared services, prints only the worktree config", () => {
    const result = formatUpDryRun(
      { worktreeId: "login", env: { WEB_PORT: "20512" }, config },
      "human",
    );
    expect(result.stdout).toContain("node server.js");
    expect(result.stdout).not.toContain("postgres");
  });

  /**
   * Issue #168: the preview is the diagnostic surface, so it must explain the
   * cross-tier edges it drops — the same explanation the real `up` prints.
   */
  describe("dropped cross-tier depends_on edges (#168)", () => {
    const dropped = [
      { from: "web", to: "db", fromTier: "isolated", toTier: "shared" },
    ] as const satisfies ReadonlyArray<DroppedEdge>;

    it("in human mode, reports the drop on stderr", () => {
      const result = formatUpDryRun({ ...payload, droppedEdges: dropped }, "human");
      expect(result.stderr).toBe(`${formatDroppedEdgeWarning(dropped[0])}\n`);
      expect(result.stderr).toContain("dropped cross-tier depends_on 'web' (isolated) -> 'db'");
      expect(result.stderr).toContain("ADR-0003");
    });

    it("in human mode, leaves stdout byte-identical to the drop-free render", () => {
      // The invariant that lets `--dry-run > stack.yaml` (or a pipe into
      // `process-compose -f -`) keep working: the warning never touches stdout.
      const withDrops = formatUpDryRun({ ...payload, droppedEdges: dropped }, "human");
      const without = formatUpDryRun(payload, "human");
      expect(withDrops.stdout).toBe(without.stdout);
      expect(withDrops.stdout).not.toContain("dropped cross-tier");
    });

    it("in human mode, emits one line per dropped edge", () => {
      const two = [
        ...dropped,
        { from: "web", to: "cache", fromTier: "isolated", toTier: "shared" },
      ] as const satisfies ReadonlyArray<DroppedEdge>;
      const result = formatUpDryRun({ ...payload, droppedEdges: two }, "human");
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(2);
      expect(result.stderr).toContain("-> 'cache' (shared)");
    });

    it("in human mode with nothing dropped, stderr stays empty", () => {
      expect(formatUpDryRun({ ...payload, droppedEdges: [] }, "human").stderr).toBe("");
      expect(formatUpDryRun(payload, "human").stderr).toBe("");
    });

    it("in JSON mode, carries dropped_edges in the envelope with snake_case tiers", () => {
      const result = formatUpDryRun({ ...payload, droppedEdges: dropped }, "json");
      const parsed = JSON.parse(result.stdout) as {
        up_dry_run: { dropped_edges: ReadonlyArray<Record<string, string>> };
      };
      expect(parsed.up_dry_run.dropped_edges).toEqual([
        { from: "web", to: "db", from_tier: "isolated", to_tier: "shared" },
      ]);
    });

    it("in JSON mode, dropped_edges is always present — empty when nothing was dropped", () => {
      // Unlike `shared_*` (absent means "no shared tier at all"), an empty list
      // is a real answer, and always emitting it spares an agent from telling
      // "nothing dropped" apart from "this devtrees never reported drops".
      for (const p of [payload, { ...payload, droppedEdges: [] }]) {
        const parsed = JSON.parse(formatUpDryRun(p, "json").stdout) as {
          up_dry_run: Record<string, unknown>;
        };
        expect(parsed.up_dry_run.dropped_edges).toEqual([]);
      }
    });

    it("in JSON mode, keeps stderr silent — the drop is already in the envelope", () => {
      // ADR-0005: `--json` is a one-stream contract. Duplicating the prose on
      // stderr would corrupt a naive `2>&1` capture of the document.
      const result = formatUpDryRun({ ...payload, droppedEdges: dropped }, "json");
      expect(result.stderr).toBe("");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });
});

describe("output formatter — dropped cross-namespace depends_on edges (#179)", () => {
  const edge = { from: "api", to: "db", toNamespaces: ["one", "three"] };
  const dry: UpDryRunPayload = {
    worktreeId: "login",
    env: {},
    config: { processes: {} } as UpDryRunPayload["config"],
  };

  it("names both services and the target's namespaces", () => {
    const line = formatDroppedNamespaceEdgeWarning(edge);
    expect(line).toContain("cross-namespace depends_on 'api' -> 'db'");
    expect(line).toContain("[one, three]");
  });

  it("up --dry-run: human mode warns on stderr, stdout stays the document", () => {
    const withEdge = formatUpDryRun({ ...dry, droppedNamespaceEdges: [edge] }, "human");
    expect(withEdge.stderr).toContain(formatDroppedNamespaceEdgeWarning(edge));
    expect(withEdge.stdout).toBe(formatUpDryRun(dry, "human").stdout);
  });

  it("up --dry-run: JSON carries dropped_namespace_edges, always present, stderr silent", () => {
    const parse = (p: UpDryRunPayload) =>
      JSON.parse(formatUpDryRun(p, "json").stdout) as {
        up_dry_run: { dropped_namespace_edges: unknown };
      };
    expect(
      parse({ ...dry, droppedNamespaceEdges: [edge] }).up_dry_run.dropped_namespace_edges,
    ).toEqual([{ from: "api", to: "db", to_namespaces: ["one", "three"] }]);
    expect(parse(dry).up_dry_run.dropped_namespace_edges).toEqual([]);
    expect(formatUpDryRun({ ...dry, droppedNamespaceEdges: [edge] }, "json").stderr).toBe("");
  });

  it("up: JSON carries dropped_namespace_edges, always present; human output unchanged", () => {
    const up: UpPayload = { worktreeId: "login", env: {}, sharedStarted: false };
    const parse = (p: UpPayload) =>
      JSON.parse(formatUp(p, "json").stdout) as { up: { dropped_namespace_edges: unknown } };
    expect(parse({ ...up, droppedNamespaceEdges: [edge] }).up.dropped_namespace_edges).toEqual([
      { from: "api", to: "db", to_namespaces: ["one", "three"] },
    ]);
    expect(parse(up).up.dropped_namespace_edges).toEqual([]);
    expect(formatUp({ ...up, droppedNamespaceEdges: [edge] }, "human")).toEqual(
      formatUp(up, "human"),
    );
  });

  it("up: JSON carries shared_config_changes, always present; human output unchanged (#185)", () => {
    const up: UpPayload = { worktreeId: "login", env: {}, sharedStarted: false };
    const change = { service: "pg", field: "shutdown" };
    const parse = (p: UpPayload) =>
      JSON.parse(formatUp(p, "json").stdout) as { up: { shared_config_changes: unknown } };
    expect(parse({ ...up, sharedFieldChanges: [change] }).up.shared_config_changes).toEqual([
      change,
    ]);
    expect(parse(up).up.shared_config_changes).toEqual([]);
    expect(formatUp({ ...up, sharedFieldChanges: [change] }, "human")).toEqual(
      formatUp(up, "human"),
    );
  });

  it("up: JSON carries shared_activated, always present; human output names the added services (#236)", () => {
    const up: UpPayload = { worktreeId: "login", env: {}, sharedStarted: false };
    const parse = (p: UpPayload) =>
      JSON.parse(formatUp(p, "json").stdout) as { up: { shared_activated: unknown } };
    expect(parse({ ...up, sharedActivated: ["sb"] }).up.shared_activated).toEqual(["sb"]);
    expect(parse(up).up.shared_activated).toEqual([]);
    expect(formatUp({ ...up, sharedActivated: ["sb"] }, "human").stdout).toMatch(
      /added shared service\(s\) to the shared instance: sb\./,
    );
  });

  it("up --dry-run: JSON carries selected_shared_services, always present; human names them on stderr (#236)", () => {
    const parse = (p: UpDryRunPayload) =>
      JSON.parse(formatUpDryRun(p, "json").stdout) as {
        up_dry_run: { selected_shared_services: unknown };
      };
    expect(
      parse({ ...dry, selectedSharedServices: ["pg", "sb"] }).up_dry_run.selected_shared_services,
    ).toEqual(["pg", "sb"]);
    expect(parse(dry).up_dry_run.selected_shared_services).toEqual([]);
    expect(formatUpDryRun({ ...dry, selectedSharedServices: ["pg"] }, "human").stderr).toMatch(
      /up would use shared service\(s\): pg/,
    );
  });

  it("SHARED_ACTIVATION_FAILED is a documented error code (#236)", () => {
    expect(ERROR_CODES).toContain("SHARED_ACTIVATION_FAILED");
    expect(ERROR_CODE_DESCRIPTIONS.SHARED_ACTIVATION_FAILED).toMatch(/untouched/);
  });

  it("up: JSON carries shared_restarted, always present; human output names the restarted shared services (#240)", () => {
    const up: UpPayload = { worktreeId: "login", env: {}, sharedStarted: false };
    const parse = (p: UpPayload) =>
      JSON.parse(formatUp(p, "json").stdout) as { up: { shared_restarted: unknown } };
    expect(parse({ ...up, sharedRestarted: ["pg"] }).up.shared_restarted).toEqual(["pg"]);
    expect(parse(up).up.shared_restarted).toEqual([]);
    expect(formatUp({ ...up, sharedRestarted: ["pg"] }, "human").stdout).toMatch(
      /devtrees up: restarted dead shared service\(s\): pg\.\n/,
    );
    expect(formatUp(up, "human").stdout).not.toMatch(/restarted/);
  });

  it("up --dry-run: JSON carries would_restart_shared, always present; human names them on stderr (#240)", () => {
    const parse = (p: UpDryRunPayload) =>
      JSON.parse(formatUpDryRun(p, "json").stdout) as {
        up_dry_run: { would_restart_shared: unknown };
      };
    expect(parse({ ...dry, wouldRestartShared: ["pg"] }).up_dry_run.would_restart_shared).toEqual([
      "pg",
    ]);
    expect(parse(dry).up_dry_run.would_restart_shared).toEqual([]);
    expect(formatUpDryRun({ ...dry, wouldRestartShared: ["pg"] }, "human").stderr).toMatch(
      /up would restart dead shared service\(s\): pg/,
    );
  });

  it("SHARED_SERVICE_DEAD's description names the reasons up cannot repair (#240)", () => {
    expect(ERROR_CODE_DESCRIPTIONS.SHARED_SERVICE_DEAD).toMatch(
      /start_refused.*died_again.*died_while_waiting.*unknown_revision/,
    );
  });
});

/**
 * `formatPrune` — `devtrees prune --json` envelope (issue #48).
 *
 * The JSON document lists every orphan the sweep reconciled away under
 * `prune.pruned[]`. Each entry is identity-only: `{id, kind, worktreePath}` —
 * no status, no ports, no services, no block_base (all of which described
 * pre-prune state that no longer exists once the orphan is gone). The list
 * itself stays because `prune` is the only command that reconciles
 * devtrees-state vs `git worktree list` — the agent can't have learned it
 * otherwise. Human output is unchanged.
 */
describe("output formatter — formatPrune", () => {
  const rows: ReadonlyArray<PrunedRow> = [
    {
      id: "removed",
      kind: "worktree",
      status: "running",
      worktreePath: "/abs/path/.../devtrees-example-removed",
    },
    {
      id: "gone",
      kind: "worktree",
      status: "stale",
      worktreePath: "/abs/path/.../devtrees-example-gone",
    },
  ];

  it("in human mode, lists each cleaned orphan with its kind and prior status", () => {
    const result = formatPrune(rows, "human");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("removed");
    expect(result.stdout).toContain("gone");
    expect(result.stdout).toContain("worktree");
    expect(result.stdout).toMatch(/was running/);
    expect(result.stdout).toMatch(/was stale/);
  });

  it("reports an orphan stop that needed force: stderr (human), force_killed (JSON) (#190)", () => {
    const forced: ReadonlyArray<PrunedRow> = [
      { ...rows[0]!, forceKilled: [{ service: "web", pid: 4242 }] },
    ];
    const human = formatPrune(forced, "human");
    expect(human.stderr).toContain("orphan 'removed'");
    expect(human.stderr).toContain("force-killed (SIGKILL) web (pid 4242)");
    const json = JSON.parse(formatPrune(forced, "json").stdout) as {
      prune: { pruned: ReadonlyArray<Record<string, unknown>> };
    };
    expect(json.prune.pruned[0]?.force_killed).toEqual([{ service: "web", pid: 4242 }]);
  });

  it("in human mode with no orphans, prints the existing 'no orphans' line", () => {
    const result = formatPrune([], "human");
    expect(result.stdout).toMatch(/no orphan/i);
  });

  it("in JSON mode, emits {schema_version, prune:{pruned:[...]}} with identity-only entries", () => {
    const result = formatPrune(rows, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      prune: { pruned: ReadonlyArray<Record<string, unknown>> };
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.prune.pruned).toHaveLength(2);
    expect(parsed.prune.pruned[0]).toEqual({
      id: "removed",
      kind: "worktree",
      worktreePath: "/abs/path/.../devtrees-example-removed",
      force_killed: [],
    });
    expect(parsed.prune.pruned[1]).toEqual({
      id: "gone",
      kind: "worktree",
      worktreePath: "/abs/path/.../devtrees-example-gone",
      force_killed: [],
    });
  });

  it("in JSON mode, omits status / ports / services / block_base on each entry", () => {
    const result = formatPrune(rows, "json");
    const parsed = JSON.parse(result.stdout) as {
      prune: { pruned: ReadonlyArray<Record<string, unknown>> };
    };
    for (const entry of parsed.prune.pruned) {
      expect(entry).not.toHaveProperty("status");
      expect(entry).not.toHaveProperty("ports");
      expect(entry).not.toHaveProperty("services");
      expect(entry).not.toHaveProperty("block_base");
      expect(entry).not.toHaveProperty("blockBase");
    }
  });

  it("in JSON mode with no orphans, emits {prune:{pruned:[]}} (not 'no orphans' text, no top-level 'orphans')", () => {
    const result = formatPrune([], "json");
    const parsed = JSON.parse(result.stdout) as {
      prune: { pruned: unknown[] };
      orphans?: unknown;
    };
    expect(parsed.prune.pruned).toEqual([]);
    expect(parsed).not.toHaveProperty("orphans");
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatPrune(rows, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });

  /**
   * Issue #148 — a failed orphan reap must surface a warning (human: stderr;
   * JSON: a `warnings[]` array in the envelope), so prune does NOT silently
   * report a clean teardown when out-of-band resources may have survived.
   */
  const reapWarnings = [
    {
      orphanId: "removed",
      worktreePath: "/abs/path/removed",
      failures: [
        {
          process: "db",
          command: "reap.sh",
          reason: "exit" as const,
          message: "exited with code 1",
        },
      ],
    },
  ];

  it("in human mode, a reap warning lands on stderr naming the orphan + that resources may survive (#148)", () => {
    const result = formatPrune(rows, "human", reapWarnings);
    expect(result.stdout).toContain("removed");
    expect(result.stderr).toContain("removed");
    expect(result.stderr.toLowerCase()).toMatch(/out-of-band|may.*surviv|still.*running/);
  });

  it("in JSON mode, a reap failure populates prune.warnings[] (#148)", () => {
    const result = formatPrune(rows, "json", reapWarnings);
    const parsed = JSON.parse(result.stdout) as {
      prune: { pruned: unknown[]; warnings: Array<Record<string, unknown>> };
    };
    expect(parsed.prune.warnings).toHaveLength(1);
    expect(parsed.prune.warnings[0]?.orphanId).toBe("removed");
    const failures = parsed.prune.warnings[0]?.failures as Array<Record<string, unknown>>;
    expect(failures[0]?.process).toBe("db");
    expect(failures[0]?.reason).toBe("exit");
  });

  it("with no reap warnings, JSON emits an empty warnings[] and stderr stays clean (#148)", () => {
    const result = formatPrune(rows, "json", []);
    const parsed = JSON.parse(result.stdout) as { prune: { warnings: unknown[] } };
    expect(parsed.prune.warnings).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("surfaces an unreclaimed orphan: stderr warning in human mode, prune.unreclaimed[] in JSON (#186)", () => {
    const kept = [
      {
        id: "removed",
        kind: "worktree" as const,
        worktreePath: "/gone/removed",
        socketPath: "/run/removed.sock",
        message: "process-compose down exited with code 1",
      },
    ];
    const human = formatPrune([], "human", [], kept);
    expect(human.stderr).toContain("orphan 'removed'");
    expect(human.stderr).toContain("NOT reclaimed");
    expect(human.stderr).toContain("lsof -U -a /run/removed.sock");
    const json = formatPrune([], "json", [], kept);
    expect(json.stderr).toBe("");
    const parsed = JSON.parse(json.stdout) as { prune: { unreclaimed: unknown[] } };
    expect(parsed.prune.unreclaimed).toEqual([{ ...kept[0], force_killed: [] }]);
  });

  it("carries force_killed on an unreclaimed orphan whose stop timed out (#190)", () => {
    const kept = [
      {
        id: "removed",
        kind: "worktree" as const,
        worktreePath: "/gone/removed",
        socketPath: "/run/removed.sock",
        message: "DOWN_TIMEOUT",
        forceKilled: [{ service: "web", pid: 4242 }],
      },
    ];
    const parsed = JSON.parse(formatPrune([], "json", [], kept).stdout) as {
      prune: { unreclaimed: Array<Record<string, unknown>> };
    };
    expect(parsed.prune.unreclaimed[0]?.force_killed).toEqual([{ service: "web", pid: 4242 }]);
  });
});

/**
 * `formatDown` — `devtrees down --json` envelope (issue #48).
 *
 * The envelope is operation-output only: exactly one of `down.shared: true`
 * (shared teardown) or `down.worktreeId: "<id>"` (worktree teardown) — never
 * both, never neither. Agents that want pre- or post-teardown state should
 * call `ls --json` before/after `down`; the action envelope no longer
 * pre-bakes either snapshot. Human output is unchanged.
 */
describe("output formatter — formatRestart (#222)", () => {
  it("human mode names what was restarted, in `up`'s shape, with nothing on stderr", () => {
    const result = formatRestart({ worktreeId: "login", restarted: ["api", "mobile"] }, "human");
    expect(result).toEqual({
      stdout: "devtrees restart: restarted api, mobile in 'login'.\n",
      stderr: "",
    });
  });

  it("human mode warns on stderr about an old run devtrees had to force-kill", () => {
    const result = formatRestart(
      { worktreeId: "login", restarted: ["mobile"], forceKilled: [{ service: "mobile", pid: 7 }] },
      "human",
    );
    expect(result.stderr).toBe(
      "devtrees restart: WARNING — the old run outlived the restart; devtrees force-killed mobile (pid 7).\n",
    );
  });

  it("json mode always carries restarted, services and force_killed", () => {
    const result = formatRestart({ worktreeId: "login", restarted: ["mobile"] }, "json");
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: SCHEMA_VERSION,
      restart: {
        worktree_id: "login",
        restarted: ["mobile"],
        services: [],
        force_killed: [],
        skipped_shared: [],
      },
    });
  });
});

describe("output formatter — formatDown", () => {
  it("in human mode for a worktree down, emits today's 'worktree instance stopped' line", () => {
    const result = formatDown({ worktreeId: "login" }, "human");
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("devtrees down: worktree instance stopped.\n");
  });

  it("in human mode for a shared down, emits today's 'shared instance stopped' line", () => {
    const result = formatDown({ shared: true }, "human");
    expect(result.stdout).toBe("devtrees down: shared instance stopped.\n");
  });

  it("in JSON mode for a worktree down, emits {schema_version, down:{worktreeId}} and nothing else", () => {
    const result = formatDown({ worktreeId: "login" }, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      down: Record<string, unknown>;
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.down).toEqual({ worktreeId: "login", stopped: true, force_killed: [] });
    expect(parsed.down).not.toHaveProperty("shared");
    expect(parsed.down).not.toHaveProperty("env");
    expect(parsed.down).not.toHaveProperty("services");
    expect(parsed.down).not.toHaveProperty("block_base");
  });

  it("in JSON mode for a shared down, emits {schema_version, down:{shared:true}} and nothing else", () => {
    const result = formatDown({ shared: true }, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      down: Record<string, unknown>;
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.down).toEqual({ shared: true, stopped: true, force_killed: [] });
    expect(parsed.down).not.toHaveProperty("worktreeId");
    expect(parsed.down).not.toHaveProperty("env");
    expect(parsed.down).not.toHaveProperty("services");
    expect(parsed.down).not.toHaveProperty("block_base");
  });

  /**
   * Issue #92 — `down` with nothing running is an idempotent no-op. The
   * payload's `stopped: false` renders a "nothing to do" notice in human mode
   * and a `stopped: false` field in the JSON envelope; the exit stays 0 in
   * both modes (the caller owns the exit code and sees no error).
   */
  it("in human mode for a worktree no-op, emits the idempotent notice (#92)", () => {
    const result = formatDown({ worktreeId: "login", stopped: false }, "human");
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("devtrees down: no worktree instance running; nothing to do.\n");
  });

  it("in human mode for a shared no-op, emits the idempotent notice (#92)", () => {
    const result = formatDown({ shared: true, stopped: false }, "human");
    expect(result.stdout).toBe("devtrees down: shared instance not running; nothing to do.\n");
  });

  it("in JSON mode a no-op down carries stopped: false (#92)", () => {
    const result = formatDown({ worktreeId: "login", stopped: false }, "json");
    const parsed = JSON.parse(result.stdout) as { down: Record<string, unknown> };
    expect(parsed.down).toEqual({ worktreeId: "login", stopped: false, force_killed: [] });
  });

  /**
   * Issue #190 — a stop that needed force reports every SIGKILLed service:
   * a stderr warning (human), `down.force_killed` (JSON, always present).
   */
  it("in JSON mode reports force-killed services under down.force_killed (#190)", () => {
    const forceKilled = [{ service: "web", pid: 4242 }];
    const worktree = formatDown({ worktreeId: "login", stopped: true, forceKilled }, "json");
    expect(JSON.parse(worktree.stdout).down.force_killed).toEqual([{ service: "web", pid: 4242 }]);
    expect(worktree.stderr).toBe("");
    const shared = formatDown({ shared: true, stopped: true, forceKilled }, "json");
    expect(JSON.parse(shared.stdout).down.force_killed).toEqual([{ service: "web", pid: 4242 }]);
  });

  it("in human mode warns on stderr naming each force-killed service (#190)", () => {
    const result = formatDown(
      {
        worktreeId: "login",
        stopped: true,
        forceKilled: [
          { service: "web", pid: 4242 },
          { service: "api", pid: 4243 },
        ],
      },
      "human",
    );
    expect(result.stdout).toBe("devtrees down: worktree instance stopped.\n");
    expect(result.stderr).toContain("WARNING");
    expect(result.stderr).toContain("force-killed (SIGKILL) web (pid 4242), api (pid 4243)");
  });

  it("in human mode a clean stop has no force-kill warning (#190)", () => {
    expect(
      formatDown({ worktreeId: "login", stopped: true, forceKilled: [] }, "human").stderr,
    ).toBe("");
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatDown({ worktreeId: "login" }, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });

  /**
   * Issue #148 — a failed dead-supervisor reap on `down` must surface a warning
   * (human: stderr; JSON: a `down.warning` object), not a silent clean stop.
   */
  const downWarning = {
    orphanId: "login",
    worktreePath: "/abs/path/login",
    failures: [
      { process: "db", command: "reap.sh", reason: "timeout" as const, message: "timed out" },
    ],
  };

  it("in human mode, a down reap warning lands on stderr (#148)", () => {
    const result = formatDown(
      { worktreeId: "login", stopped: false, warning: downWarning },
      "human",
    );
    expect(result.stderr).toContain("login");
    expect(result.stderr.toLowerCase()).toMatch(/out-of-band|may.*surviv|still.*running/);
  });

  it("in JSON mode, a down reap warning populates down.warning (#148)", () => {
    const result = formatDown(
      { worktreeId: "login", stopped: false, warning: downWarning },
      "json",
    );
    const parsed = JSON.parse(result.stdout) as { down: Record<string, unknown> };
    const warning = parsed.down.warning as Record<string, unknown> | undefined;
    expect(warning?.orphanId).toBe("login");
    const failures = warning?.failures as Array<Record<string, unknown>>;
    expect(failures[0]?.reason).toBe("timeout");
  });

  it("a clean down omits down.warning and keeps stderr empty (#148)", () => {
    const result = formatDown({ worktreeId: "login", stopped: true }, "json");
    const parsed = JSON.parse(result.stdout) as { down: Record<string, unknown> };
    expect(parsed.down).not.toHaveProperty("warning");
    expect(result.stderr).toBe("");
  });
});

describe("output formatter — formatLogLine", () => {
  const event = {
    ts: "2026-06-01T22:00:00.000Z",
    service: "web",
    stream: "stdout" as const,
    line: 'listening on 3000 {"foo":"bar"}',
  };

  it("in human mode without prefix, emits the line verbatim with a trailing newline", () => {
    const result = formatLogLine(event, "human", { prefixService: false });
    expect(result.stdout).toBe('listening on 3000 {"foo":"bar"}\n');
    expect(result.stderr).toBe("");
  });

  it("in human mode with prefix, prefixes the line with [service]", () => {
    const result = formatLogLine(event, "human", { prefixService: true });
    expect(result.stdout).toBe('[web] listening on 3000 {"foo":"bar"}\n');
  });

  it("in JSON mode, emits one NDJSON line with {ts, service, stream, line}", () => {
    const result = formatLogLine(event, "json", { prefixService: false });
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
    const parsed = JSON.parse(result.stdout) as {
      ts: string;
      service: string;
      stream: string;
      line: string;
    };
    expect(parsed).toEqual({
      ts: "2026-06-01T22:00:00.000Z",
      service: "web",
      stream: "stdout",
      line: 'listening on 3000 {"foo":"bar"}',
    });
  });

  it("in JSON mode, NDJSON is one event per line regardless of prefixService (the field is human-only)", () => {
    const a = formatLogLine(event, "json", { prefixService: false });
    const b = formatLogLine(event, "json", { prefixService: true });
    expect(a.stdout).toBe(b.stdout);
  });
});

// Type-level: every code in ERROR_CODES is a valid ErrorCode (sanity check the
// const-as type alignment).
const _typeCheck: ErrorCode = ERROR_CODES[0];
void _typeCheck;

describe("output formatter — formatInit (issue #118)", () => {
  it("human: names the file and action for a created file", () => {
    const result = formatInit(
      { target: "AGENTS.md", path: "/p/AGENTS.md", action: "created" },
      "human",
    );
    expect(result.stdout).toBe(
      "devtrees init: created AGENTS.md with the agent onboarding block.\n",
    );
    expect(result.stderr).toBe("");
  });

  it("human: distinguishes an updated file", () => {
    const result = formatInit(
      { target: "CLAUDE.md", path: "/p/CLAUDE.md", action: "updated" },
      "human",
    );
    expect(result.stdout).toBe(
      "devtrees init: updated CLAUDE.md with the agent onboarding block.\n",
    );
  });

  it("json: emits {schema_version, init:{target, path, action}}", () => {
    const result = formatInit(
      { target: "AGENTS.md", path: "/p/AGENTS.md", action: "created" },
      "json",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: SCHEMA_VERSION,
      init: { target: "AGENTS.md", path: "/p/AGENTS.md", action: "created" },
    });
    expect(result.stderr).toBe("");
  });
});

describe("output formatter — braced injected variables (#200)", () => {
  const v = { service: "web", variable: "WEB_PORT" };
  const dry: UpDryRunPayload = {
    worktreeId: "login",
    env: {},
    config: { processes: {} } as UpDryRunPayload["config"],
  };
  const up: UpPayload = { worktreeId: "login", env: {}, sharedStarted: false };

  it("names the service and variable and gives the fix", () => {
    const line = formatBracedEnvVarWarning(v);
    expect(line).toContain("service 'web'");
    expect(line).toContain("'${WEB_PORT}'");
    expect(line).toContain("'$WEB_PORT'");
    expect(line).toContain("'$${WEB_PORT}'");
  });

  it("up --dry-run: human warns on stderr, stdout stays the document", () => {
    const out = formatUpDryRun({ ...dry, bracedEnvVars: [v] }, "human");
    expect(out.stderr).toContain(formatBracedEnvVarWarning(v));
    expect(out.stdout).toBe(formatUpDryRun(dry, "human").stdout);
  });

  it("up --dry-run: JSON carries braced_env_vars, always present, stderr silent", () => {
    const parse = (p: UpDryRunPayload) =>
      JSON.parse(formatUpDryRun(p, "json").stdout) as { up_dry_run: { braced_env_vars: unknown } };
    expect(parse({ ...dry, bracedEnvVars: [v] }).up_dry_run.braced_env_vars).toEqual([v]);
    expect(parse(dry).up_dry_run.braced_env_vars).toEqual([]);
    expect(formatUpDryRun({ ...dry, bracedEnvVars: [v] }, "json").stderr).toBe("");
  });

  it("up: JSON carries braced_env_vars, always present; human output unchanged", () => {
    const parse = (p: UpPayload) =>
      JSON.parse(formatUp(p, "json").stdout) as { up: { braced_env_vars: unknown } };
    expect(parse({ ...up, bracedEnvVars: [v] }).up.braced_env_vars).toEqual([v]);
    expect(parse(up).up.braced_env_vars).toEqual([]);
    expect(formatUp({ ...up, bracedEnvVars: [v] }, "human")).toEqual(formatUp(up, "human"));
  });
});
