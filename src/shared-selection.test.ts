/**
 * Shared-service selection tests (#236, ADR-0010): which shared services an
 * `up` selects, what a running shared instance must add or reports as
 * drifted, how a pre-#236 shared state is attributed, and how shared ports
 * are resolved beside a running instance.
 */

import { describe, expect, it } from "vite-plus/test";
import { sharedServiceHash, sharedStackHash } from "./hash.js";
import {
  UNKNOWN_REVISION,
  hasNamespacedShared,
  planSharedSelection,
  resolveSharedPorts,
  selectSharedServices,
  sharedRecords,
  withServiceRecords,
} from "./shared-selection.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

function svc(
  name: string,
  tier: "shared" | "isolated",
  extra: Partial<ResolvedService> = {},
): ResolvedService {
  return {
    name,
    tier,
    command: `run ${name}`,
    ports: [],
    dependsOn: [],
    environment: [],
    ...extra,
  };
}

const pg = svc("pg", "shared", { ports: ["PG_PORT"] });
const sb = svc("sb", "shared", { ports: ["SB_PORT"], namespace: "db-shared" });
const cache = svc("cache", "shared", { ports: ["CACHE_PORT"], namespace: ["cache", "db-shared"] });
const api = svc("api", "isolated", { ports: ["API_PORT"], namespace: "app" });
const stack: ResolvedStack = { services: [pg, sb, cache, api] };
const names = (services: ReadonlyArray<ResolvedService>) => services.map((s) => s.name);

describe("selectSharedServices", () => {
  it("always selects the shared services with no namespace", () => {
    expect(names(selectSharedServices(stack, []))).toEqual(["pg"]);
    expect(names(selectSharedServices(stack, ["app"]))).toEqual(["pg"]);
  });

  it("selects a namespaced shared service when any of its namespaces is selected", () => {
    expect(names(selectSharedServices(stack, ["db-shared"]))).toEqual(["pg", "sb", "cache"]);
    expect(names(selectSharedServices(stack, ["cache"]))).toEqual(["pg", "cache"]);
  });

  it("selects a selected shared service's shared dependencies, transitively", () => {
    const a = svc("a", "shared", { namespace: "a", dependsOn: [{ name: "b" }] });
    const b = svc("b", "shared", { namespace: "b", dependsOn: [{ name: "c" }] });
    const c = svc("c", "shared", { namespace: "c" });
    expect(names(selectSharedServices({ services: [c, b, a] }, ["a"]))).toEqual(["c", "b", "a"]);
  });

  it("never selects isolated services", () => {
    expect(names(selectSharedServices(stack, ["app"]))).not.toContain("api");
  });

  it("hasNamespacedShared is false for a stack whose shared services have no namespace", () => {
    expect(hasNamespacedShared({ services: [pg, api] })).toBe(false);
    expect(hasNamespacedShared(stack)).toBe(true);
  });
});

describe("planSharedSelection", () => {
  it("reports a selected service the instance does not run as missing, and nothing drifted", () => {
    const plan = planSharedSelection([pg, sb], sharedRecords([pg]));
    expect(names(plan.missing)).toEqual(["sb"]);
    expect(plan.drifted).toEqual([]);
    expect(plan.portConflicts).toEqual([]);
  });

  it("reports drift only for selected services", () => {
    const running = sharedRecords([pg, { ...sb, command: "edited" }]);
    expect(planSharedSelection([pg], running).drifted).toEqual([]);
    expect(planSharedSelection([pg, sb], running).drifted).toEqual([
      {
        service: "sb",
        runningHash: sharedServiceHash({ ...sb, command: "edited" }),
        localHash: sharedServiceHash(sb),
      },
    ]);
  });

  it("does not count a namespace change as drift", () => {
    const running = sharedRecords([{ ...sb, namespace: "elsewhere" }]);
    expect(planSharedSelection([sb], running).drifted).toEqual([]);
  });

  it("reports a missing service's port that a running service owns", () => {
    const renamed = { ...sb, name: "supabase" };
    const plan = planSharedSelection([renamed], sharedRecords([sb]));
    expect(plan.portConflicts).toEqual([{ service: "supabase", port: "SB_PORT", owner: "sb" }]);
  });
});

describe("withServiceRecords (a pre-#236 shared state)", () => {
  const legacyHash = sharedStackHash({ services: [pg] });

  it("keeps a state that already has records", () => {
    const state = { hash: "x", ports: {}, services: sharedRecords([pg]) };
    expect(withServiceRecords(state, stack, ["pg"])).toBe(state);
  });

  it("attributes the running services to this stack when the whole-subset hash matches", () => {
    const state = withServiceRecords({ hash: legacyHash, ports: { PG_PORT: 1 } }, stack, ["pg"]);
    expect(state.services).toEqual(sharedRecords([pg]));
  });

  it("marks every running service's revision unknown when it does not match", () => {
    const state = withServiceRecords({ hash: "other", ports: {} }, stack, ["pg", "gone"]);
    expect(state.services).toEqual({
      pg: { hash: UNKNOWN_REVISION, ports: ["PG_PORT"] },
      gone: { hash: UNKNOWN_REVISION, ports: [] },
    });
  });
});

describe("resolveSharedPorts", () => {
  const block = { base: 20_000, size: 10 };
  const positional = (name: string) =>
    ({ PG_PORT: 20_000, SB_PORT: 20_001, CACHE_PORT: 20_002 })[name];
  const services = [pg, sb, cache];

  it("is the positional map when nothing is bound", () => {
    expect(resolveSharedPorts({ services, bound: {}, positional, block })).toEqual({
      PG_PORT: 20_000,
      SB_PORT: 20_001,
      CACHE_PORT: 20_002,
    });
  });

  it("keeps every bound port's number", () => {
    const bound = { PG_PORT: 20_005, SB_PORT: 20_001 };
    expect(resolveSharedPorts({ services, bound, positional, block })).toEqual({
      PG_PORT: 20_005,
      SB_PORT: 20_001,
      CACHE_PORT: 20_002,
    });
  });

  it("moves an unbound port off a number already taken, to the lowest free one", () => {
    // Another branch's running service bound 20_001 under another name. SB
    // moves to the lowest free number, which then pushes CACHE on as well:
    // every port the map hands out is distinct.
    const bound = { OTHER_PORT: 20_001, PG_PORT: 20_000 };
    expect(resolveSharedPorts({ services, bound, positional, block })).toEqual({
      PG_PORT: 20_000,
      SB_PORT: 20_002,
      CACHE_PORT: 20_003,
    });
  });
});
