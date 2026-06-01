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
  formatError,
  formatLs,
  type ErrorCode,
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
  it("in JSON mode, emits {error:{code,message,details}} on stdout and leaves stderr empty", () => {
    const result = formatError(
      {
        code: "INSTANCE_NOT_FOUND",
        message: "no worktree instance is running for 'login'",
        details: { worktreeId: "login" },
      },
      "json",
    );
    expect(result.stderr).toBe("");
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
  const rows = [
    {
      id: "shared",
      kind: "shared" as const,
      status: "running" as const,
      ports: { DB_PORT: 30000 },
      blockBase: 30000,
    },
    {
      id: "login",
      kind: "worktree" as const,
      status: "running" as const,
      ports: { WEB_PORT: 20512 },
      blockBase: 20512,
    },
  ];

  it("in human mode, renders the existing table (id/kind/status/ports)", () => {
    const result = formatLs(rows, "human");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("shared");
    expect(result.stdout).toContain("login");
    expect(result.stdout).toContain("running");
    expect(result.stdout).toContain("WEB_PORT=20512");
    expect(result.stdout).toContain("DB_PORT=30000");
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
      instances: ReadonlyArray<{ id: string; kind: string; status: string; ports: Record<string, number>; block_base?: number }>;
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.instances).toHaveLength(2);
    expect(parsed.instances[0]).toEqual({
      id: "shared",
      kind: "shared",
      status: "running",
      ports: { DB_PORT: 30000 },
      block_base: 30000,
    });
    expect(parsed.instances[1]).toEqual({
      id: "login",
      kind: "worktree",
      status: "running",
      ports: { WEB_PORT: 20512 },
      block_base: 20512,
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
});

// Type-level: every code in ERROR_CODES is a valid ErrorCode (sanity check the
// const-as type alignment).
const _typeCheck: ErrorCode = ERROR_CODES[0];
void _typeCheck;
