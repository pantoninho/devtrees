import { describe, expect, it } from "vite-plus/test";
import {
  classifyService,
  dependencyOrder,
  describeDeadServices,
  findDeadServices,
  isRunning,
} from "./service-state.js";
import type { ServiceStatus } from "./driver.js";

const row = (name: string, status: string, exitCode?: number): ServiceStatus =>
  exitCode === undefined
    ? { name, status, health: "unknown" }
    : { name, status, health: "unknown", exitCode };

describe("isRunning — what keeps process-compose alive (#223)", () => {
  it("is true for running, starting and stopping services", () => {
    for (const status of ["Running", "Pending", "Restarting", "Terminating", "Launched"]) {
      expect(isRunning(row("x", status)), status).toBe(true);
    }
  });

  it("is false for stopped, done, dead and idle services", () => {
    for (const r of [
      row("x", "Completed", -1),
      row("x", "Completed", 0),
      row("x", "Error"),
      row("x", "Disabled"),
      row("x", "Skipped"),
    ]) {
      expect(isRunning(r), r.status).toBe(false);
    }
  });
});

describe("classifyService — dead versus done (ADR-0008)", () => {
  it("Completed with exit 0 is a finished one-shot: done", () => {
    expect(classifyService(row("migrate", "Completed", 0))).toBe("done");
  });

  it("Completed with a non-zero exit is dead", () => {
    expect(classifyService(row("web", "Completed", 1))).toBe("dead");
  });

  it("Completed with a signal exit (-1, a killed process) is dead (#162)", () => {
    expect(classifyService(row("web", "Completed", -1))).toBe("dead");
  });

  it("Failed and Error are dead whatever the exit code", () => {
    expect(classifyService(row("a", "Failed"))).toBe("dead");
    expect(classifyService(row("b", "Error", 0))).toBe("dead");
  });

  it("Completed without an exit code (older row shape) is done — no evidence of a crash", () => {
    expect(classifyService(row("migrate", "Completed"))).toBe("done");
  });

  it("running and in-flight states are active", () => {
    for (const status of ["Running", "Pending", "Restarting", "Launching", "Ready"]) {
      expect(classifyService(row("x", status, 0))).toBe("active");
    }
  });

  it("is case-insensitive on the status string", () => {
    expect(classifyService(row("x", "completed", 2))).toBe("dead");
    expect(classifyService(row("x", "FAILED"))).toBe("dead");
  });
});

describe("findDeadServices", () => {
  it("returns only the named services that are dead, in the order asked for", () => {
    const rows = [
      row("a", "Completed", -1),
      row("b", "Running", 0),
      row("c", "Failed"),
      row("d", "Completed", 0),
    ];
    expect(findDeadServices(rows, ["c", "b", "a", "d"])).toEqual([
      { name: "c", status: "Failed" },
      { name: "a", status: "Completed", exitCode: -1 },
    ]);
  });

  it("an absent service is not dead", () => {
    expect(findDeadServices([], ["web"])).toEqual([]);
  });

  it("describes dead services for a human", () => {
    expect(
      describeDeadServices([
        { name: "toy", status: "Completed", exitCode: -1 },
        { name: "api", status: "Error" },
      ]),
    ).toBe("toy (Completed, exit -1), api (Error)");
  });
});

describe("dependencyOrder — restart order (#178)", () => {
  const svc = (name: string, ...deps: string[]) => ({
    name,
    dependsOn: deps.map((d) => ({ name: d })),
  });
  const services = [
    svc("web", "api"),
    svc("api", "db", "cache"),
    svc("db"),
    svc("cache"),
    svc("x"),
  ];

  it("puts each service after the services it depends on", () => {
    expect(dependencyOrder(services, ["web", "api", "db"])).toEqual(["db", "api", "web"]);
  });

  it("ignores dependencies that are not being started, and keeps the given order otherwise", () => {
    expect(dependencyOrder(services, ["x", "web", "db"])).toEqual(["x", "web", "db"]);
  });

  it("does not loop on a cycle", () => {
    const cyclic = [svc("a", "b"), svc("b", "a")];
    expect(dependencyOrder(cyclic, ["a", "b"])).toEqual(["b", "a"]);
  });
});
