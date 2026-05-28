import { describe, expect, it } from "vite-plus/test";
import { stringify as stringifyYaml } from "yaml";
import { deriveSharedConfig, deriveWorktreeConfig } from "./deriver.js";
import { parseStack, type ResolvedStack } from "./stack.js";

const stack: ResolvedStack = {
  services: [
    {
      name: "web",
      tier: "isolated",
      command: "node server.js",
      ports: ["WEB_PORT"],
      dependsOn: [],
      environment: ["LOG_LEVEL=debug"],
    },
  ],
};

describe("config deriver — isolated worktree instance", () => {
  const derived = deriveWorktreeConfig(stack, {
    worktreeId: "login",
    worktreeRoot: "/home/me/wt/login",
    portFor: (name) => (name === "WEB_PORT" ? 20512 : undefined),
  });
  const web = derived.config.processes.web;
  if (web === undefined) throw new Error("expected a derived 'web' process");

  it("injects each named port as exactly its env-var name (no mangling)", () => {
    expect(derived.env.WEB_PORT).toBe("20512");
  });

  it("injects the worktree id for de-colliding global names", () => {
    expect(derived.env.DEVTREES_WORKTREE_ID).toBe("login");
  });

  it("partitions in only isolated services and strips the tier key", () => {
    expect("tier" in web).toBe(false);
  });

  it("sets working_dir to the worktree root so relative paths stay worktree-local", () => {
    expect(web.working_dir).toBe("/home/me/wt/login");
  });

  it("carries the injected port and worktree id into the process environment", () => {
    expect(web.environment).toContain("WEB_PORT=20512");
    expect(web.environment).toContain("DEVTREES_WORKTREE_ID=login");
    // author-declared env survives untouched
    expect(web.environment).toContain("LOG_LEVEL=debug");
  });

  it("references the port verbatim as ${NAME} in the command, leaving it for the env", () => {
    // the deriver never rewrites the command (ADR-0002)
    expect(web.command).toBe("node server.js");
  });

  it("emits a derived config with no `tier` key anywhere — strict-safe under is_strict: true", () => {
    // Extend mode: the base contributes the bodies; the overlay attaches tiers.
    // The deriver must never leak `tier` into the process-compose config, or
    // process-compose would reject it when run with `is_strict: true`.
    const devtrees = `
extends: ./process-compose.yaml
services:
  postgres:
    tier: shared
  web:
    tier: isolated
    ports: [WEB_PORT]
`;
    const base = `
processes:
  postgres:
    command: "postgres -D ./pgdata"
  web:
    command: "node server.js"
`;
    const merged = parseStack(devtrees, { baseYaml: base });
    const derived = deriveWorktreeConfig(merged, {
      worktreeId: "login",
      worktreeRoot: "/home/me/wt/login",
      portFor: () => 20512,
    });

    // No process in the derived config carries a tier key.
    for (const proc of Object.values(derived.config.processes)) {
      expect("tier" in proc).toBe(false);
    }
    // And the serialized YAML — what actually reaches process-compose — has
    // no `tier:` line at all.
    const yaml = stringifyYaml(derived.config);
    expect(yaml).not.toMatch(/^\s*tier:/m);
  });

  it("excludes shared services from the worktree instance", () => {
    const mixed: ResolvedStack = {
      services: [
        ...stack.services,
        {
          name: "postgres",
          tier: "shared",
          command: "postgres",
          ports: ["DB_PORT"],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const out = deriveWorktreeConfig(mixed, {
      worktreeId: "login",
      worktreeRoot: "/home/me/wt/login",
      portFor: () => 20512,
    });
    expect(Object.keys(out.config.processes)).toEqual(["web"]);
  });
});

describe("config deriver — shared-port injection into the worktree instance", () => {
  const mixed: ResolvedStack = {
    services: [
      {
        name: "web",
        tier: "isolated",
        command: "node server.js",
        ports: ["WEB_PORT"],
        dependsOn: [],
        environment: [],
      },
      {
        name: "postgres",
        tier: "shared",
        command: "postgres",
        ports: ["DB_PORT"],
        dependsOn: [],
        environment: [],
      },
    ],
  };

  it("injects the shared service's named port into the worktree env (connection info)", () => {
    const derived = deriveWorktreeConfig(mixed, {
      worktreeId: "login",
      worktreeRoot: "/home/me/wt/login",
      portFor: (n) => (n === "WEB_PORT" ? 20512 : undefined),
      sharedPortFor: (n) => (n === "DB_PORT" ? 19000 : undefined),
    });
    expect(derived.env.DB_PORT).toBe("19000");
    expect(derived.env.WEB_PORT).toBe("20512");
  });

  it("carries the shared-service port into every isolated process's environment", () => {
    const derived = deriveWorktreeConfig(mixed, {
      worktreeId: "login",
      worktreeRoot: "/home/me/wt/login",
      portFor: () => 20512,
      sharedPortFor: (n) => (n === "DB_PORT" ? 19000 : undefined),
    });
    const web = derived.config.processes.web;
    if (web === undefined) throw new Error("expected 'web'");
    expect(web.environment).toContain("DB_PORT=19000");
  });

  it("produces identical shared-port env in two worktrees (repo-wide injection)", () => {
    const login = deriveWorktreeConfig(mixed, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: (n) => (n === "WEB_PORT" ? 20512 : undefined),
      sharedPortFor: (n) => (n === "DB_PORT" ? 19000 : undefined),
    });
    const billing = deriveWorktreeConfig(mixed, {
      worktreeId: "billing",
      worktreeRoot: "/wt/billing",
      portFor: (n) => (n === "WEB_PORT" ? 20544 : undefined),
      sharedPortFor: (n) => (n === "DB_PORT" ? 19000 : undefined),
    });
    // Isolated ports differ; the shared port is identical.
    expect(login.env.WEB_PORT).not.toBe(billing.env.WEB_PORT);
    expect(login.env.DB_PORT).toBe(billing.env.DB_PORT);
  });

  it("omits the shared-port injection when no resolver is provided (degenerate context)", () => {
    const derived = deriveWorktreeConfig(mixed, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: (n) => (n === "WEB_PORT" ? 20512 : undefined),
    });
    expect(derived.env.DB_PORT).toBeUndefined();
  });
});

describe("config deriver — shared instance", () => {
  const stack: ResolvedStack = {
    services: [
      {
        name: "postgres",
        tier: "shared",
        command: "postgres -D ./pgdata",
        ports: ["DB_PORT"],
        dependsOn: [],
        environment: ["LOG_LEVEL=info"],
      },
      {
        name: "web",
        tier: "isolated",
        command: "node server.js",
        ports: ["WEB_PORT"],
        dependsOn: [],
        environment: [],
      },
    ],
  };

  it("partitions in only shared services and strips the tier key", () => {
    const out = deriveSharedConfig(stack, {
      workingDir: "/anchor",
      portFor: (n) => (n === "DB_PORT" ? 19000 : undefined),
    });
    expect(Object.keys(out.config.processes)).toEqual(["postgres"]);
    const pg = out.config.processes.postgres;
    if (pg === undefined) throw new Error("expected 'postgres'");
    expect("tier" in pg).toBe(false);
  });

  it("injects each shared named port as its env-var name (no mangling)", () => {
    const out = deriveSharedConfig(stack, {
      workingDir: "/anchor",
      portFor: (n) => (n === "DB_PORT" ? 19000 : undefined),
    });
    expect(out.env.DB_PORT).toBe("19000");
    const pg = out.config.processes.postgres;
    if (pg === undefined) throw new Error("expected 'postgres'");
    expect(pg.environment).toContain("DB_PORT=19000");
  });

  it("pins working_dir to the anchor — shared services have no worktree of their own", () => {
    const out = deriveSharedConfig(stack, {
      workingDir: "/anchor",
      portFor: () => 19000,
    });
    expect(out.config.processes.postgres?.working_dir).toBe("/anchor");
  });

  it("preserves author-declared environment alongside the injection", () => {
    const out = deriveSharedConfig(stack, {
      workingDir: "/anchor",
      portFor: () => 19000,
    });
    expect(out.config.processes.postgres?.environment).toContain("LOG_LEVEL=info");
  });

  it("emits a tier-free shared config (strict-safe)", () => {
    const out = deriveSharedConfig(stack, {
      workingDir: "/anchor",
      portFor: () => 19000,
    });
    const yaml = stringifyYaml(out.config);
    expect(yaml).not.toMatch(/^\s*tier:/m);
  });

  it("returns an empty config when the stack has no shared services", () => {
    const onlyIsolated: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node x",
          ports: [],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const out = deriveSharedConfig(onlyIsolated, {
      workingDir: "/anchor",
      portFor: () => undefined,
    });
    expect(out.config.processes).toEqual({});
    expect(out.env).toEqual({});
  });
});
