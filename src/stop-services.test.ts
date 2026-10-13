/**
 * The pure half of `devtrees stop` (ADR-0009, #223): name resolution, the
 * running/not-running split, the last-running refusal and the incomplete-stop
 * error.
 */
import { describe, expect, it } from "vite-plus/test";
import { resolveNamedServices } from "./commands.js";
import type { ServiceStatus } from "./driver.js";
import { assertNotLastRunning, partitionRunning, serviceStopIncomplete } from "./stop-services.js";

type Coded = Error & { code?: string; details?: Record<string, unknown> };

function row(name: string, status: string, exitCode?: number): ServiceStatus {
  return { name, status, health: "unknown", ...(exitCode !== undefined ? { exitCode } : {}) };
}

function thrown(fn: () => unknown): Coded {
  try {
    fn();
  } catch (err) {
    return err as Coded;
  }
  throw new Error("expected a throw");
}

describe("resolveNamedServices", () => {
  const services = { isolated: ["web", "api"], shared: ["db"] };

  it("returns the isolated names once each, in the order given", () => {
    expect(resolveNamedServices("stop", ["api", "web", "api"], services)).toEqual(["api", "web"]);
  });

  it("refuses a shared service with SHARED_SERVICE_REFUSED, before any unknown name", () => {
    const err = thrown(() => resolveNamedServices("stop", ["nope", "db"], services));
    expect(err.code).toBe("SHARED_SERVICE_REFUSED");
    expect(err.details).toEqual({ services: ["db"] });
    expect(err.message).toContain("devtrees down --shared");
  });

  it("fails SERVICE_NOT_FOUND with the logs details shape for an unknown name", () => {
    const err = thrown(() => resolveNamedServices("stop", ["web", "nope"], services));
    expect(err.code).toBe("SERVICE_NOT_FOUND");
    expect(err.details).toEqual({ service: "nope", valid_services: ["web", "api"] });
  });
});

describe("partitionRunning", () => {
  it("acts on running and stopping services; skips stopped, done, dead and unbooted ones", () => {
    const rows = [
      row("web", "Running"),
      row("hook", "Terminating"),
      row("gone", "Completed", -1),
      row("seed", "Completed", 0),
      row("bad", "Error"),
    ];
    expect(partitionRunning(rows, ["web", "hook", "gone", "seed", "bad", "unbooted"])).toEqual({
      running: ["web", "hook"],
      notRunning: ["gone", "seed", "bad", "unbooted"],
    });
  });
});

describe("assertNotLastRunning", () => {
  it("allows a stop that leaves another process running", () => {
    expect(() =>
      assertNotLastRunning([row("web", "Running"), row("api", "Running")], ["web"], "login"),
    ).not.toThrow();
  });

  it("refuses with LAST_SERVICES_RUNNING when only done, stopped or idle services would remain", () => {
    const rows = [
      row("web", "Running"),
      row("seed", "Completed", 0),
      row("api", "Completed", -1),
      row("off", "Disabled"),
      row("skip", "Skipped"),
    ];
    const err = thrown(() => assertNotLastRunning(rows, ["web"], "login"));
    expect(err.code).toBe("LAST_SERVICES_RUNNING");
    expect(err.details).toEqual({
      worktree_id: "login",
      services: ["web"],
      remedy: "devtrees down",
    });
  });

  it("never refuses when nothing is being stopped (a repeated stop)", () => {
    expect(() => assertNotLastRunning([row("web", "Completed", -1)], [], "login")).not.toThrow();
  });
});

describe("serviceStopIncomplete", () => {
  it("names each survivor and carries force_killed and the remedy, like DOWN_INCOMPLETE", () => {
    const err = serviceStopIncomplete(
      "login",
      ["web"],
      [
        {
          service: "web",
          pid: 42,
          command: "python3 listener.py",
          port_name: "WEB_PORT",
          port: 4000,
        },
        { service: "web", pid: null, command: null },
      ],
      [{ service: "web", pid: 7 }],
    ) as Coded;
    expect(err.code).toBe("SERVICE_STOP_INCOMPLETE");
    expect(err.message).toContain("web WEB_PORT 4000: pid 42 (python3 listener.py)");
    expect(err.message).toContain("web: process-compose still reports it running");
    expect(err.details).toMatchObject({
      worktree_id: "login",
      services: ["web"],
      force_killed: [{ service: "web", pid: 7 }],
    });
    expect(String(err.details?.remedy)).toContain("devtrees stop web");
  });
});
