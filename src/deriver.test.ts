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

describe("config deriver — probe / availability passthrough", () => {
  function probeStack(): ResolvedStack {
    return {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: ["WEB_PORT"],
          dependsOn: [],
          environment: [],
          readinessProbe: {
            exec: { command: "/bin/true" },
            initial_delay_seconds: 1,
            future_field: { nested: true },
          },
          livenessProbe: { exec: { command: "/bin/true" }, failure_threshold: 2 },
          availability: { restart: "on_failure", backoff_seconds: 5 },
        },
      ],
    };
  }

  it("copies readiness_probe verbatim onto the derived isolated process", () => {
    const derived = deriveWorktreeConfig(probeStack(), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const web = derived.config.processes.web;
    if (!web) throw new Error("expected web");
    expect(web.readiness_probe).toEqual({
      exec: { command: "/bin/true" },
      initial_delay_seconds: 1,
      future_field: { nested: true },
    });
  });

  it("copies liveness_probe verbatim onto the derived isolated process", () => {
    const derived = deriveWorktreeConfig(probeStack(), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    expect(derived.config.processes.web?.liveness_probe).toEqual({
      exec: { command: "/bin/true" },
      failure_threshold: 2,
    });
  });

  it("copies availability verbatim onto the derived isolated process", () => {
    const derived = deriveWorktreeConfig(probeStack(), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    expect(derived.config.processes.web?.availability).toEqual({
      restart: "on_failure",
      backoff_seconds: 5,
    });
  });

  it("omits each probe / availability field when the service didn't declare one", () => {
    // No leaking `readiness_probe: undefined` into the derived YAML.
    const plain: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: [],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const derived = deriveWorktreeConfig(plain, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const web = derived.config.processes.web;
    if (!web) throw new Error("expected web");
    expect("readiness_probe" in web).toBe(false);
    expect("liveness_probe" in web).toBe(false);
    expect("availability" in web).toBe(false);
    const yaml = stringifyYaml(derived.config);
    expect(yaml).not.toMatch(/readiness_probe/);
    expect(yaml).not.toMatch(/liveness_probe/);
    expect(yaml).not.toMatch(/availability/);
  });

  it("copies the same three fields onto a shared derived process", () => {
    const stack: ResolvedStack = {
      services: [
        {
          name: "postgres",
          tier: "shared",
          command: "postgres",
          ports: ["DB_PORT"],
          dependsOn: [],
          environment: [],
          readinessProbe: { exec: { command: "pg_isready" } },
          livenessProbe: { exec: { command: "pg_isready" } },
          availability: { restart: "always" },
        },
      ],
    };
    const out = deriveSharedConfig(stack, {
      workingDir: "/anchor",
      portFor: () => 19000,
    });
    const pg = out.config.processes.postgres;
    if (!pg) throw new Error("expected postgres");
    expect(pg.readiness_probe).toEqual({ exec: { command: "pg_isready" } });
    expect(pg.liveness_probe).toEqual({ exec: { command: "pg_isready" } });
    expect(pg.availability).toEqual({ restart: "always" });
  });

  it("serializes the probe block to YAML round-trip without normalization", () => {
    const derived = deriveWorktreeConfig(probeStack(), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const yaml = stringifyYaml(derived.config);
    expect(yaml).toMatch(/readiness_probe:/);
    expect(yaml).toMatch(/future_field:/);
    expect(yaml).toMatch(/initial_delay_seconds: 1/);
  });
});

describe("config deriver — namespace passthrough (#128)", () => {
  it("copies a service's namespace verbatim onto the derived isolated process", () => {
    const stack: ResolvedStack = {
      services: [
        {
          name: "api",
          tier: "isolated",
          command: "node api.js",
          ports: [],
          dependsOn: [],
          environment: [],
          namespace: "local-backend",
        },
      ],
    };
    const derived = deriveWorktreeConfig(stack, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    expect(derived.config.processes.api?.namespace).toBe("local-backend");
  });

  it("omits the namespace key when the service didn't declare one", () => {
    const stack: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: [],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const derived = deriveWorktreeConfig(stack, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const web = derived.config.processes.web;
    if (!web) throw new Error("expected web");
    expect("namespace" in web).toBe(false);
    expect(stringifyYaml(derived.config)).not.toMatch(/namespace/);
  });

  it("copies namespace onto a shared derived process too", () => {
    const stack: ResolvedStack = {
      services: [
        {
          name: "postgres",
          tier: "shared",
          command: "postgres",
          ports: ["DB_PORT"],
          dependsOn: [],
          environment: [],
          namespace: "data",
        },
      ],
    };
    const out = deriveSharedConfig(stack, { workingDir: "/anchor", portFor: () => 19000 });
    expect(out.config.processes.postgres?.namespace).toBe("data");
  });
});

describe("config deriver — shutdown / daemon-launch passthrough (#134)", () => {
  function daemonStack(tier: "isolated" | "shared"): ResolvedStack {
    return {
      services: [
        {
          name: "data",
          tier,
          command: "supabase start",
          ports: [],
          dependsOn: [],
          environment: [],
          shutdown: { command: "supabase stop", timeout_seconds: 60, parent_only: false },
          isDaemon: true,
          launchTimeoutSeconds: 5,
        },
      ],
    };
  }

  it("copies shutdown / is_daemon / launch_timeout_seconds verbatim onto an isolated process", () => {
    const derived = deriveWorktreeConfig(daemonStack("isolated"), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const data = derived.config.processes.data;
    if (!data) throw new Error("expected data");
    expect(data.shutdown).toEqual({
      command: "supabase stop",
      timeout_seconds: 60,
      parent_only: false,
    });
    expect(data.is_daemon).toBe(true);
    expect(data.launch_timeout_seconds).toBe(5);
  });

  it("copies the same three keys onto a shared process", () => {
    const out = deriveSharedConfig(daemonStack("shared"), {
      workingDir: "/anchor",
      portFor: () => 19000,
    });
    const data = out.config.processes.data;
    if (!data) throw new Error("expected data");
    expect(data.shutdown).toEqual({
      command: "supabase stop",
      timeout_seconds: 60,
      parent_only: false,
    });
    expect(data.is_daemon).toBe(true);
    expect(data.launch_timeout_seconds).toBe(5);
  });

  it("omits all three keys when the service didn't declare them (no undefined leak)", () => {
    const plain: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: [],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const derived = deriveWorktreeConfig(plain, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const web = derived.config.processes.web;
    if (!web) throw new Error("expected web");
    expect("shutdown" in web).toBe(false);
    expect("is_daemon" in web).toBe(false);
    expect("launch_timeout_seconds" in web).toBe(false);
    const yaml = stringifyYaml(derived.config);
    expect(yaml).not.toMatch(/shutdown/);
    expect(yaml).not.toMatch(/is_daemon/);
    expect(yaml).not.toMatch(/launch_timeout_seconds/);
  });

  it("preserves a declared is_daemon: false (false is not absence)", () => {
    const stack: ResolvedStack = {
      services: [
        {
          name: "data",
          tier: "isolated",
          command: "supabase start",
          ports: [],
          dependsOn: [],
          environment: [],
          isDaemon: false,
          launchTimeoutSeconds: 0,
        },
      ],
    };
    const derived = deriveWorktreeConfig(stack, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const data = derived.config.processes.data;
    if (!data) throw new Error("expected data");
    expect("is_daemon" in data).toBe(true);
    expect(data.is_daemon).toBe(false);
    expect("launch_timeout_seconds" in data).toBe(true);
    expect(data.launch_timeout_seconds).toBe(0);
  });

  it("serializes shutdown to YAML round-trip without normalization", () => {
    const derived = deriveWorktreeConfig(daemonStack("isolated"), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const yaml = stringifyYaml(derived.config);
    expect(yaml).toMatch(/shutdown:/);
    expect(yaml).toMatch(/command: supabase stop/);
    expect(yaml).toMatch(/is_daemon: true/);
    expect(yaml).toMatch(/launch_timeout_seconds: 5/);
  });
});

describe("config deriver — log persistence passthrough (#136)", () => {
  function logStack(tier: "isolated" | "shared"): ResolvedStack {
    return {
      services: [
        {
          name: "api",
          tier,
          command: "node api.js",
          ports: [],
          dependsOn: [],
          environment: [],
          logLocation: "api.log",
          logConfiguration: { rotation: { max_size_mb: 10 }, disable_json: true },
        },
      ],
    };
  }

  it("templates an isolated log_location to the absolute per-worktree logs path", () => {
    const derived = deriveWorktreeConfig(logStack("isolated"), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      anchor: "/repo/.git",
      portFor: () => 20512,
    });
    const api = derived.config.processes.api;
    if (!api) throw new Error("expected api");
    expect(api.log_location).toBe("/repo/.git/devtrees/logs/login/api.log");
  });

  it("templates a shared log_location under the shared instance logs dir", () => {
    const out = deriveSharedConfig(logStack("shared"), {
      workingDir: "/repo/.git",
      anchor: "/repo/.git",
      portFor: () => 19000,
    });
    const api = out.config.processes.api;
    if (!api) throw new Error("expected api");
    expect(api.log_location).toBe("/repo/.git/devtrees/logs/shared/api.log");
  });

  it("lands the same authored log_location in different files across worktrees (no collision)", () => {
    const login = deriveWorktreeConfig(logStack("isolated"), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      anchor: "/repo/.git",
      portFor: () => 20512,
    });
    const billing = deriveWorktreeConfig(logStack("isolated"), {
      worktreeId: "billing",
      worktreeRoot: "/wt/billing",
      anchor: "/repo/.git",
      portFor: () => 20512,
    });
    expect(login.config.processes.api?.log_location).toBe(
      "/repo/.git/devtrees/logs/login/api.log",
    );
    expect(billing.config.processes.api?.log_location).toBe(
      "/repo/.git/devtrees/logs/billing/api.log",
    );
    expect(login.config.processes.api?.log_location).not.toBe(
      billing.config.processes.api?.log_location,
    );
  });

  it("resolves a nested relative log_location under the logs dir", () => {
    const stack: ResolvedStack = {
      services: [
        {
          name: "api",
          tier: "isolated",
          command: "node api.js",
          ports: [],
          dependsOn: [],
          environment: [],
          logLocation: "sub/api.log",
        },
      ],
    };
    const derived = deriveWorktreeConfig(stack, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      anchor: "/repo/.git",
      portFor: () => 20512,
    });
    expect(derived.config.processes.api?.log_location).toBe(
      "/repo/.git/devtrees/logs/login/sub/api.log",
    );
  });

  it("copies log_configuration verbatim with no templating", () => {
    const derived = deriveWorktreeConfig(logStack("isolated"), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      anchor: "/repo/.git",
      portFor: () => 20512,
    });
    expect(derived.config.processes.api?.log_configuration).toEqual({
      rotation: { max_size_mb: 10 },
      disable_json: true,
    });
  });

  it("omits log_location / log_configuration when the service declared neither (no undefined leak)", () => {
    const plain: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: [],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const derived = deriveWorktreeConfig(plain, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      anchor: "/repo/.git",
      portFor: () => 20512,
    });
    const web = derived.config.processes.web;
    if (!web) throw new Error("expected web");
    expect("log_location" in web).toBe(false);
    expect("log_configuration" in web).toBe(false);
    const yaml = stringifyYaml(derived.config);
    expect(yaml).not.toMatch(/log_location/);
    expect(yaml).not.toMatch(/log_configuration/);
    expect(yaml).not.toMatch(/logs/);
  });

  it("emits a log_configuration even when log_location is absent (object passthrough is independent)", () => {
    const stack: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: [],
          dependsOn: [],
          environment: [],
          logConfiguration: { disable_json: true },
        },
      ],
    };
    const derived = deriveWorktreeConfig(stack, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      anchor: "/repo/.git",
      portFor: () => 20512,
    });
    const web = derived.config.processes.web;
    if (!web) throw new Error("expected web");
    expect("log_location" in web).toBe(false);
    expect(web.log_configuration).toEqual({ disable_json: true });
  });
});

describe("config deriver — cross-tier depends_on handling (ADR-0003)", () => {
  function mixedDepsStack(): ResolvedStack {
    return {
      services: [
        {
          name: "api",
          tier: "isolated",
          command: "node api.js",
          ports: ["API_PORT"],
          dependsOn: [],
          environment: [],
        },
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: ["WEB_PORT"],
          // api (isolated → same tier), postgres + cache (isolated → shared, cross-tier)
          dependsOn: ["api", "postgres", "cache"],
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
        {
          name: "cache",
          tier: "shared",
          command: "redis",
          ports: ["CACHE_PORT"],
          // shared → shared, same tier
          dependsOn: ["postgres"],
          environment: [],
        },
      ],
    };
  }

  it("emits same-tier (isolated→isolated) depends_on into derived worktree processes", () => {
    const derived = deriveWorktreeConfig(mixedDepsStack(), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
      sharedPortFor: () => 19000,
    });
    const web = derived.config.processes.web;
    if (web === undefined) throw new Error("expected 'web'");
    // Map form, keyed by dependency name, with the default condition.
    expect(web.depends_on).toEqual({ api: { condition: "process_started" } });
  });

  it("drops cross-tier (isolated→shared) edges from the derived worktree config", () => {
    const derived = deriveWorktreeConfig(mixedDepsStack(), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
      sharedPortFor: () => 19000,
    });
    const web = derived.config.processes.web;
    if (web === undefined) throw new Error("expected 'web'");
    // The shared deps must not appear under the worktree process — process-compose
    // would error on an unknown process otherwise.
    expect(web.depends_on?.postgres).toBeUndefined();
    expect(web.depends_on?.cache).toBeUndefined();
  });

  it("reports each dropped cross-tier edge so the behavior is observable", () => {
    const derived = deriveWorktreeConfig(mixedDepsStack(), {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
      sharedPortFor: () => 19000,
    });
    // Each cross-tier edge from this worktree's isolated services becomes a
    // dropped-edge record so commands.runUp can surface it to the user.
    expect(derived.droppedEdges).toEqual(
      expect.arrayContaining([
        { from: "web", to: "postgres", fromTier: "isolated", toTier: "shared" },
        { from: "web", to: "cache", fromTier: "isolated", toTier: "shared" },
      ]),
    );
    expect(derived.droppedEdges).toHaveLength(2);
  });

  it("emits same-tier (shared→shared) depends_on into derived shared processes", () => {
    const derived = deriveSharedConfig(mixedDepsStack(), {
      workingDir: "/anchor",
      portFor: () => 19000,
    });
    const cache = derived.config.processes.cache;
    if (cache === undefined) throw new Error("expected 'cache'");
    expect(cache.depends_on).toEqual({ postgres: { condition: "process_started" } });
  });

  it("omits depends_on entirely when a process has no surviving edges", () => {
    // Stripping all of `web`'s deps (all of them shared) would leave it
    // with an empty depends_on map. Omit the field instead — cleaner derived YAML.
    const onlyCrossTier: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: [],
          dependsOn: ["postgres"],
          environment: [],
        },
        {
          name: "postgres",
          tier: "shared",
          command: "postgres",
          ports: [],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const derived = deriveWorktreeConfig(onlyCrossTier, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
      sharedPortFor: () => 19000,
    });
    const web = derived.config.processes.web;
    if (web === undefined) throw new Error("expected 'web'");
    expect("depends_on" in web).toBe(false);
  });

  it("silently skips depends_on edges that target an unknown service", () => {
    // Same as process-compose would — but we drop it rather than emit a dangling
    // dep into the derived config (process-compose would then error on it). A
    // deeper "dangling deps" pass is left for a later slice; for now don't
    // crash the deriver.
    const dangling: ResolvedStack = {
      services: [
        {
          name: "web",
          tier: "isolated",
          command: "node server.js",
          ports: [],
          dependsOn: ["does-not-exist"],
          environment: [],
        },
      ],
    };
    const derived = deriveWorktreeConfig(dangling, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => 20512,
    });
    const web = derived.config.processes.web;
    if (web === undefined) throw new Error("expected 'web'");
    expect("depends_on" in web).toBe(false);
  });
});

describe("config deriver — per-service port metadata (`x-devtrees`, issue #110)", () => {
  // The derived config flat-injects every named port into every process's
  // environment (connection info), so the env lines alone cannot tell `ls`
  // which ports a service *declares*. The deriver records that mapping under
  // a compose-spec-style `x-` extension key process-compose ignores (verified
  // against v1.110.0, including `is_strict: true`).
  const mixedStack: ResolvedStack = {
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
        name: "worker",
        tier: "isolated",
        command: "node worker.js",
        ports: [],
        dependsOn: [],
        environment: [],
      },
      {
        name: "db",
        tier: "shared",
        command: "postgres",
        ports: ["DB_PORT"],
        dependsOn: [],
        environment: [],
      },
    ],
  };

  const derived = deriveWorktreeConfig(mixedStack, {
    worktreeId: "login",
    worktreeRoot: "/wt/login",
    portFor: (name) => (name === "WEB_PORT" ? 20512 : undefined),
    sharedPortFor: (name) => (name === "DB_PORT" ? 30000 : undefined),
  });

  it("records each isolated service's declared ports, resolved, per service", () => {
    expect(derived.config["x-devtrees"]?.ports_by_service.web).toEqual({ WEB_PORT: 20512 });
  });

  it("records `{}` for a portless service — present, not omitted", () => {
    expect(derived.config["x-devtrees"]?.ports_by_service.worker).toEqual({});
  });

  it("never copies the instance-wide injection (shared DB_PORT) into a service's entry", () => {
    expect(derived.config["x-devtrees"]?.ports_by_service.web).not.toHaveProperty("DB_PORT");
  });

  it("excludes other-instance (shared) services from the worktree metadata", () => {
    expect(derived.config["x-devtrees"]?.ports_by_service).not.toHaveProperty("db");
  });

  it("skips declared ports the resolver cannot resolve — no invented numbers", () => {
    const noPorts = deriveWorktreeConfig(mixedStack, {
      worktreeId: "login",
      worktreeRoot: "/wt/login",
      portFor: () => undefined,
    });
    expect(noPorts.config["x-devtrees"]?.ports_by_service.web).toEqual({});
  });

  it("records the shared services' declared ports in the shared instance's config", () => {
    const shared = deriveSharedConfig(mixedStack, {
      workingDir: "/repo/.git",
      portFor: (name) => (name === "DB_PORT" ? 30000 : undefined),
    });
    expect(shared.config["x-devtrees"]?.ports_by_service).toEqual({ db: { DB_PORT: 30000 } });
  });

  it("survives a YAML round-trip under the `x-devtrees` key", () => {
    const yaml = stringifyYaml(derived.config);
    expect(yaml).toContain("x-devtrees:");
    expect(yaml).toContain("WEB_PORT: 20512");
  });
});
