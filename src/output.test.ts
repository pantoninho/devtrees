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
  SCHEMA_VERSION,
  formatDown,
  formatEnv,
  formatError,
  formatLogLine,
  formatLs,
  formatPrune,
  formatUp,
  type DownPayload,
  type ErrorCode,
  type LsInstanceRow,
  type LsServiceRow,
  type UpPayload,
} from "./output.js";

describe("output formatter — constants", () => {
  it("declares a schema_version string", () => {
    expect(typeof SCHEMA_VERSION).toBe("string");
    expect(SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it("includes the error codes the foundation slice promises (PRD §error envelope)", () => {
    // Slice #1 must define at least these two; later slices add HEALTH_TIMEOUT,
    // CONFIG_DRIFT, LOCK_CONTENTION, CONFIG_INVALID per ADR-0005.
    expect(ERROR_CODES).toContain("PROCESS_COMPOSE_NOT_FOUND");
    expect(ERROR_CODES).toContain("INSTANCE_NOT_FOUND");
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

  it("in human mode with no instances, prints the existing 'no instances' line", () => {
    const result = formatLs([], "human");
    expect(result.stdout).toMatch(/no devtrees instances/i);
  });

  it("in JSON mode, emits one document with schema_version and an instances array", () => {
    const result = formatLs(rows, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      instances: ReadonlyArray<{
        id: string;
        kind: string;
        status: string;
        ports: Record<string, number>;
        block_base?: number;
      }>;
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.instances).toHaveLength(2);
    expect(parsed.instances[0]).toEqual({
      id: "alpha",
      kind: "shared",
      status: "running",
      ports: { CACHE: 40001 },
      services: [],
      block_base: 40001,
    });
    expect(parsed.instances[1]).toEqual({
      id: "beta",
      kind: "worktree",
      status: "stale",
      ports: { API: 40097 },
      services: [],
      block_base: 40097,
    });
  });

  it("in JSON mode with no instances, emits an empty array (not 'no instances' text)", () => {
    const result = formatLs([], "json");
    const parsed = JSON.parse(result.stdout) as { instances: unknown[] };
    expect(parsed.instances).toEqual([]);
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
      instances: ReadonlyArray<Record<string, unknown>>;
    };
    expect(parsed.instances[0]).not.toHaveProperty("block_base");
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
          },
          {
            name: "worker",
            status: "Running",
            health: "not_ready",
            ports: { WORKER_PORT: 20001 },
          },
        ],
      },
    ];

    it("emits one services[] row per service with name, status, health and ports", () => {
      const result = formatLs(rowsWithServices, "json");
      const parsed = JSON.parse(result.stdout) as {
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
      expect(parsed.instances[0]?.services).toEqual([
        { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20000 } },
        { name: "worker", status: "Running", health: "not_ready", ports: { WORKER_PORT: 20001 } },
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
        instances: ReadonlyArray<{ services: unknown[] }>;
      };
      expect(parsed.instances[0]?.services).toEqual([]);
    });

    it("defaults services to [] when the row doesn't carry one (back-compat: optional in the row type)", () => {
      // Older callers (and the human path) hand the formatter rows without
      // services. JSON output must still include the field — the schema
      // promise is `services[] on every instance entry`.
      const result = formatLs(rows, "json");
      const parsed = JSON.parse(result.stdout) as {
        instances: ReadonlyArray<{ services?: unknown }>;
      };
      for (const inst of parsed.instances) expect(inst.services).toEqual([]);
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
    const parsed = JSON.parse(result.stdout) as { up: { services: unknown[] } };
    expect(parsed.up.services).toEqual([]);
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatUp(payload, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });
});

/**
 * `formatPrune` — `devtrees prune --json` envelope (issue #34).
 *
 * The JSON document lists every orphan the sweep reconciled away under an
 * `orphans` key, each row carrying the same shape `ls --json` publishes so a
 * downstream agent can re-use the parser. Human output is unchanged.
 */
describe("output formatter — formatPrune", () => {
  const rows: ReadonlyArray<LsInstanceRow> = [
    {
      id: "removed",
      kind: "worktree",
      status: "running",
      ports: { WEB_PORT: 20032 },
      blockBase: 20032,
    },
    {
      id: "gone",
      kind: "worktree",
      status: "stale",
      ports: {},
      blockBase: 20064,
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

  it("in human mode with no orphans, prints the existing 'no orphans' line", () => {
    const result = formatPrune([], "human");
    expect(result.stdout).toMatch(/no orphan/i);
  });

  it("in JSON mode, emits {schema_version, orphans:[...]} with the slice-#29 row shape", () => {
    const result = formatPrune(rows, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      orphans: ReadonlyArray<{
        id: string;
        kind: string;
        status: string;
        ports: Record<string, number>;
        services: ReadonlyArray<unknown>;
        block_base?: number;
      }>;
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.orphans).toHaveLength(2);
    expect(parsed.orphans[0]).toEqual({
      id: "removed",
      kind: "worktree",
      status: "running",
      ports: { WEB_PORT: 20032 },
      services: [],
      block_base: 20032,
    });
    expect(parsed.orphans[1]).toEqual({
      id: "gone",
      kind: "worktree",
      status: "stale",
      ports: {},
      services: [],
      block_base: 20064,
    });
  });

  it("in JSON mode with no orphans, emits {orphans:[]} (not 'no orphans' text)", () => {
    const result = formatPrune([], "json");
    const parsed = JSON.parse(result.stdout) as { orphans: unknown[] };
    expect(parsed.orphans).toEqual([]);
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatPrune(rows, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });
});

/**
 * `formatDown` — `devtrees down --json` envelope (issue #34).
 *
 * On success, the payload carries the prior state of the instance it stopped
 * (mirroring `up --json`'s success envelope from slice #30) so an agent has a
 * record of what was torn down. The human path is unchanged.
 */
describe("output formatter — formatDown", () => {
  const services: ReadonlyArray<LsServiceRow> = [
    { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20512 } },
  ];
  const payload: DownPayload = {
    shared: false,
    worktreeId: "login",
    blockBase: 20512,
    env: { DEVTREES_WORKTREE_ID: "login", WEB_PORT: "20512", DB_PORT: "30000" },
    services,
  };

  it("in human mode for a worktree down, emits today's 'worktree instance stopped' line", () => {
    const result = formatDown(payload, "human");
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("devtrees down: worktree instance stopped.\n");
  });

  it("in human mode for a shared down, emits today's 'shared instance stopped' line", () => {
    const result = formatDown({ shared: true }, "human");
    expect(result.stdout).toBe("devtrees down: shared instance stopped.\n");
  });

  it("in JSON mode, emits the prior-state envelope: {schema_version, down:{worktree_id, block_base, env, services, shared}}", () => {
    const result = formatDown(payload, "json");
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      schema_version: string;
      down: {
        worktree_id: string;
        block_base: number;
        env: Record<string, string>;
        services: ReadonlyArray<{
          name: string;
          status: string;
          health: string;
          ports: Record<string, number>;
        }>;
        shared: boolean;
      };
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.down.worktree_id).toBe("login");
    expect(parsed.down.block_base).toBe(20512);
    expect(parsed.down.shared).toBe(false);
    expect(parsed.down.env).toEqual({
      DEVTREES_WORKTREE_ID: "login",
      WEB_PORT: "20512",
      DB_PORT: "30000",
    });
    expect(parsed.down.services).toEqual([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20512 } },
    ]);
  });

  it("in JSON mode for a shared down, omits worktree_id (the shared instance is not keyed by a worktree)", () => {
    const sharedPayload: DownPayload = {
      shared: true,
      blockBase: 30000,
      env: { DB_PORT: "30000" },
      services: [
        { name: "postgres", status: "Running", health: "ready", ports: { DB_PORT: 30000 } },
      ],
    };
    const result = formatDown(sharedPayload, "json");
    const parsed = JSON.parse(result.stdout) as {
      down: Record<string, unknown> & { shared: boolean };
    };
    expect(parsed.down.shared).toBe(true);
    expect(parsed.down).not.toHaveProperty("worktree_id");
    expect(parsed.down.block_base).toBe(30000);
  });

  it("in JSON mode, defaults services to [] and env to {} when the caller didn't populate them", () => {
    const result = formatDown({ shared: false, worktreeId: "login" }, "json");
    const parsed = JSON.parse(result.stdout) as {
      down: { services: unknown[]; env: Record<string, string> };
    };
    expect(parsed.down.services).toEqual([]);
    expect(parsed.down.env).toEqual({});
  });

  it("in JSON mode, omits block_base when the registry had no entry for the instance", () => {
    const result = formatDown(
      { shared: false, worktreeId: "login", env: {}, services: [] },
      "json",
    );
    const parsed = JSON.parse(result.stdout) as { down: Record<string, unknown> };
    expect(parsed.down).not.toHaveProperty("block_base");
  });

  it("JSON output ends with a single trailing newline (line-friendly for shell consumers)", () => {
    const result = formatDown(payload, "json");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
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
