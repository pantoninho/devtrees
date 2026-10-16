import { describe, expect, it } from "vite-plus/test";
import { DEVTREES_METADATA_KEY, type DerivedConfig } from "./deriver.js";
import type { ServiceStatus } from "./driver.js";
import {
  namespacedRecoveryRemedy,
  planSharedDown,
  recordedSharedEdges,
  removesLastRunning,
  stackSharedEdges,
  withoutProcesses,
  withoutServiceRecords,
  worktreeDependants,
} from "./shared-down.js";
import type { ResolvedService } from "./stack.js";

const proc = (extra: Record<string, unknown> = {}) => ({
  command: "sleep 300",
  working_dir: "/anchor",
  environment: [],
  ...extra,
});

/** A shared derived config: always-on `pg`, `sa` in `a`, `sb` in `b`, `both` in `a` and `c`. */
const config: DerivedConfig = {
  processes: {
    pg: proc(),
    sa: proc({ namespace: "a" }),
    sb: proc({ namespace: "b", depends_on: { pg: { condition: "process_started" } } }),
    both: proc({ namespace: ["a", "c"] }),
  },
  [DEVTREES_METADATA_KEY]: {
    ports_by_service: { pg: { PG_PORT: 1 }, sa: { SA_PORT: 2 }, sb: { SB_PORT: 3 }, both: {} },
  },
};

const row = (name: string, extra: Partial<ServiceStatus> = {}): ServiceStatus => ({
  name,
  status: "Running",
  health: "unknown",
  running: true,
  ...extra,
});

describe("planSharedDown (#239)", () => {
  it("targets the namespaced shared services of the named namespaces, a list-valued one if any matches", () => {
    const plan = planSharedDown(config, ["a"]);
    expect(plan.targets).toEqual(["sa", "both"]);
    expect(plan.remaining).toEqual(["pg", "sb"]);
    expect(plan.inactiveNamespaces).toEqual([]);
    expect(plan.sharedDependants).toEqual([]);
  });

  it("never targets an always-on shared service, not even with -n default", () => {
    const plan = planSharedDown(config, ["default"]);
    expect(plan.targets).toEqual([]);
    expect(plan.inactiveNamespaces).toEqual(["default"]);
  });

  it("reports named namespaces with no shared service as inactive, once each", () => {
    const plan = planSharedDown(config, ["b", "nope", "nope"]);
    expect(plan.targets).toEqual(["sb"]);
    expect(plan.inactiveNamespaces).toEqual(["nope"]);
  });

  it("a namespace only a list-valued target also declares is not inactive", () => {
    expect(planSharedDown(config, ["c"]).inactiveNamespaces).toEqual([]);
  });

  it("with no config every named namespace is inactive", () => {
    const plan = planSharedDown(undefined, ["a"]);
    expect(plan).toEqual({
      targets: [],
      inactiveNamespaces: ["a"],
      remaining: [],
      sharedDependants: [],
    });
  });

  it("names a kept shared service that depends_on a target as a shared dependant", () => {
    const withPgNs: DerivedConfig = {
      ...config,
      processes: { ...config.processes, pg: proc({ namespace: "core" }) },
    };
    expect(planSharedDown(withPgNs, ["core"]).sharedDependants).toEqual([
      { instance: "shared", service: "sb", depends_on: ["pg"], source: "shared_config" },
    ]);
  });
});

describe("removesLastRunning (#239)", () => {
  it("is false while a kept service runs", () => {
    expect(removesLastRunning([row("pg"), row("sa")], ["pg"])).toBe(false);
  });

  it("is true when no kept service is running now: a done one-shot or a Pending one does not count", () => {
    const rows = [
      row("sa"),
      row("migrate", { status: "Completed", exitCode: 0, running: false }),
      row("waiter", { status: "Pending", running: false }),
    ];
    expect(removesLastRunning(rows, ["migrate", "waiter"])).toBe(true);
    expect(removesLastRunning(rows, [])).toBe(true);
  });
});

describe("worktreeDependants (#239)", () => {
  const edges = { worker: ["sa"], web: ["pg"], both: ["sa", "pg"] };

  it("lists each booted isolated service that depends on a target, with the targets it depends on", () => {
    const found = worktreeDependants(
      [
        {
          instance: "login-1",
          edges,
          source: "derived_config",
          booted: new Set(["worker", "web", "both"]),
        },
      ],
      ["sa"],
    );
    expect(found).toEqual([
      { instance: "login-1", service: "worker", depends_on: ["sa"], source: "derived_config" },
      { instance: "login-1", service: "both", depends_on: ["sa"], source: "derived_config" },
    ]);
  });

  it("skips a service the instance did not boot, but counts every edge when the booted set is unknown", () => {
    const booted = worktreeDependants(
      [{ instance: "w", edges, source: "devtrees_yaml", booted: new Set(["web"]) }],
      ["sa"],
    );
    expect(booted).toEqual([]);
    const unknown = worktreeDependants(
      [{ instance: "w", edges, source: "devtrees_yaml", booted: undefined }],
      ["sa"],
    );
    expect(unknown.map((d) => d.service)).toEqual(["worker", "both"]);
  });

  it("an instance whose edges could not be read is itself a dependant", () => {
    expect(
      worktreeDependants(
        [{ instance: "w", edges: undefined, source: "devtrees_yaml", booted: undefined }],
        ["sa"],
      ),
    ).toEqual([{ instance: "w", service: null, depends_on: [], source: "unknown" }]);
  });
});

describe("edges of a worktree instance (#239)", () => {
  const svc = (
    name: string,
    tier: "isolated" | "shared",
    deps: string[] = [],
  ): ResolvedService => ({
    name,
    tier,
    command: "x",
    ports: [],
    environment: [],
    dependsOn: deps.map((d) => ({ name: d })),
  });

  it("reads the isolated → shared edges of a devtrees.yaml, ignoring isolated → isolated ones", () => {
    const stack = {
      services: [
        svc("pg", "shared"),
        svc("api", "isolated", ["pg"]),
        svc("web", "isolated", ["api"]),
      ],
    };
    expect(stackSharedEdges(stack)).toEqual({ api: ["pg"] });
  });

  it("reads the recorded edges from a derived config, undefined when it has none", () => {
    expect(recordedSharedEdges(config)).toBeUndefined();
    const recorded: DerivedConfig = {
      ...config,
      [DEVTREES_METADATA_KEY]: { ports_by_service: {}, shared_depends_on: { api: ["pg"] } },
    };
    expect(recordedSharedEdges(recorded)).toEqual({ api: ["pg"] });
    expect(recordedSharedEdges(undefined)).toBeUndefined();
  });
});

describe("withoutProcesses (#239)", () => {
  it("drops the named processes and their ports, keeping every other process as it is", () => {
    const next = withoutProcesses(config, ["sa", "both"]);
    expect(Object.keys(next.processes)).toEqual(["pg", "sb"]);
    expect(next.processes.sb).toBe(config.processes.sb);
    expect(next[DEVTREES_METADATA_KEY].ports_by_service).toEqual({
      pg: { PG_PORT: 1 },
      sb: { SB_PORT: 3 },
    });
  });
});

describe("withoutServiceRecords (#239)", () => {
  const state = {
    hash: "whole",
    ports: { PG_PORT: 1, SA_PORT: 2, SB_PORT: 3 },
    extended: { pg: {}, sa: { availability: { restart: "always" } }, sb: {} },
    services: {
      pg: { hash: "h-pg", ports: ["PG_PORT"] },
      sa: { hash: "h-sa", ports: ["SA_PORT"] },
      sb: { hash: "h-sb", ports: ["SB_PORT"] },
    },
  };

  it("drops the revision records, extended fields and bound ports, and keeps the hash", () => {
    expect(withoutServiceRecords(state, ["sa"])).toEqual({
      hash: "whole",
      ports: { PG_PORT: 1, SB_PORT: 3 },
      extended: { pg: {}, sb: {} },
      services: {
        pg: { hash: "h-pg", ports: ["PG_PORT"] },
        sb: { hash: "h-sb", ports: ["SB_PORT"] },
      },
    });
  });

  it("keeps a port a kept service also owns", () => {
    const shared = {
      ...state,
      services: { ...state.services, sb: { hash: "h-sb", ports: ["SB_PORT", "SA_PORT"] } },
    };
    expect(withoutServiceRecords(shared, ["sa"]).ports).toEqual({
      PG_PORT: 1,
      SA_PORT: 2,
      SB_PORT: 3,
    });
  });

  it("leaves a pre-#236 state (no records) without records", () => {
    expect(withoutServiceRecords({ hash: "h", ports: { A: 1 } }, ["sa"])).toEqual({
      hash: "h",
      ports: { A: 1 },
    });
  });
});

describe("namespacedRecoveryRemedy (#239)", () => {
  const svc = (
    name: string,
    namespace: string | undefined,
    deps: string[] = [],
    tier: "shared" | "isolated" = "shared",
  ): ResolvedService => ({
    name,
    tier,
    command: "x",
    ports: [],
    environment: [],
    dependsOn: deps.map((d) => ({ name: d })),
    ...(namespace !== undefined ? { namespace } : {}),
  });

  it("forces the namespaced teardown, then the same up, so the caller and other users do not block it", () => {
    const stack = {
      services: [svc("pg", undefined), svc("sa", "a"), svc("web", "app", [], "isolated")],
    };
    expect(namespacedRecoveryRemedy(stack, ["app", "a"], ["sa"])).toBe(
      "devtrees down --shared -n a --force && devtrees up -n app -n a",
    );
  });

  it("adds the namespaces of shared services that depend on them, transitively", () => {
    const stack = {
      services: [svc("sa", "a"), svc("sb", "b", ["sa"]), svc("sc", "c", ["sb"]), svc("sd", "d")],
    };
    expect(namespacedRecoveryRemedy(stack, ["a"], ["sa"])).toBe(
      "devtrees down --shared -n a -n b -n c --force && devtrees up -n a",
    );
  });

  it("is undefined (the full teardown) for an always-on service, or when one depends on them", () => {
    expect(namespacedRecoveryRemedy({ services: [svc("pg", undefined)] }, [], ["pg"])).toBe(
      undefined,
    );
    const stack = { services: [svc("sa", "a"), svc("pg", undefined, ["sa"])] };
    expect(namespacedRecoveryRemedy(stack, ["a"], ["sa"])).toBe(undefined);
  });
});
