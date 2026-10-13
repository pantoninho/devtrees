/**
 * Named-service targets (ADR-0009): the declared services read from a
 * derived config, the shared refusal, unknown names, `depends_on` order and
 * the unbooted namespaces.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  declaredServices,
  expandNamespaces,
  notBootedNamespaces,
  orderedTargets,
  sharedAmong,
  unbootedServices,
  unknownService,
} from "./service-targets.js";

const processes = {
  app: { command: "a", namespace: "mobile", depends_on: { api: { condition: "process_healthy" } } },
  api: { command: "b", namespace: ["backend", "mobile"] },
  web: { command: "c" },
};
const declared = declaredServices(processes);

describe("declaredServices", () => {
  it("reads each process's name, namespaces and depends_on from the derived config", () => {
    expect(declared).toEqual([
      { name: "app", namespace: "mobile", dependsOn: [{ name: "api" }] },
      { name: "api", namespace: ["backend", "mobile"], dependsOn: [] },
      { name: "web", dependsOn: [] },
    ]);
    expect(declaredServices(undefined)).toEqual([]);
  });
});

describe("sharedAmong", () => {
  it("names the shared services among the names, once each", () => {
    expect(sharedAmong(["db", "cache"], declared, ["db", "web", "db", "cache"])).toEqual([
      "db",
      "cache",
    ]);
  });

  it("does not refuse a name this instance runs as isolated, even if a shared one shares it", () => {
    // devtrees.yaml was edited (web moved to shared) since the instance booted.
    expect(sharedAmong(["web"], declared, ["web"])).toEqual([]);
  });
});

describe("unknownService / orderedTargets", () => {
  it("finds the first undeclared name", () => {
    expect(unknownService(declared, ["web", "nope", "also"])).toBe("nope");
    expect(unknownService(declared, ["web"])).toBeUndefined();
  });

  it("orders the targets by depends_on, each once", () => {
    expect(orderedTargets(declared, ["app", "api", "app"]).map((s) => s.name)).toEqual([
      "api",
      "app",
    ]);
  });
});

describe("unbootedServices / notBootedNamespaces", () => {
  it("names each missing service and every namespace it declares", () => {
    const missing = unbootedServices(declared, new Set(["web"]));
    expect(missing.map((s) => s.name)).toEqual(["app", "api"]);
    expect(notBootedNamespaces(missing)).toEqual([
      { namespace: "mobile", missingServices: ["app", "api"] },
      { namespace: "backend", missingServices: ["api"] },
    ]);
  });
});

describe("expandNamespaces (#224)", () => {
  // Shared services cannot declare a namespace, so they are in `default`.
  const sharedServices = [
    { name: "db" },
    { name: "cache" },
    // A name this instance declares is its own service, never a skipped shared one.
    { name: "web" },
  ];

  it("expands to every isolated service in any namespace (list-valued included), in declared order", () => {
    expect(expandNamespaces(declared, sharedServices, ["backend"])).toEqual({
      services: ["api"],
      empty: [],
      skippedShared: [],
    });
    expect(expandNamespaces(declared, sharedServices, ["mobile", "default", "mobile"])).toEqual({
      services: ["app", "api", "web"],
      empty: [],
      skippedShared: ["db", "cache"],
    });
  });

  it("reports each namespace with no isolated service as empty", () => {
    expect(expandNamespaces(declared, sharedServices, ["nope", "mobile"])).toEqual({
      services: ["app", "api"],
      empty: ["nope"],
      skippedShared: [],
    });
  });

  it("expands nothing for no namespaces", () => {
    expect(expandNamespaces(declared, sharedServices, [])).toEqual({
      services: [],
      empty: [],
      skippedShared: [],
    });
  });
});
