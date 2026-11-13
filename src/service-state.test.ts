import { describe, expect, it } from "vite-plus/test";
import {
  classifyService,
  dependencyOrder,
  describeDeadServices,
  findDeadServices,
  isActiveOrIdle,
  isDead,
  idleState,
  isHealthyForWait,
  isPending,
  isRunning,
  keepsInstanceAlive,
  launchFailed,
  reportsRunning,
  type ServiceVerdict,
} from "./service-state.js";
import type { HealthState, ServiceStatus } from "./driver.js";

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

describe("idleState — a row that holds no process and waits on nothing (#263)", () => {
  it.each([
    ["Skipped", 1, "skipped"],
    ["skipped", undefined, "skipped"],
    ["Disabled", 0, "disabled"],
    ["DISABLED", undefined, "disabled"],
    ["Running", 0, undefined],
    ["Pending", undefined, undefined],
    ["Completed", -1, undefined],
    ["Error", 1, undefined],
  ] as const)("%s (exit %s) is %s", (status, exitCode, expected) => {
    expect(idleState(row("x", status, exitCode))).toBe(expected);
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

/**
 * Every verdict for every status process-compose emits (plus the `Failed` and
 * `Ready` the rules name, an unknown one, and the lower-case spellings where
 * case matters), at every exit code shape. The expected values are literal,
 * computed from the rules as each caller applied them inline before #251:
 * this table is what keeps the refactor behaviour-preserving.
 *
 * Columns: status, exit code, classifyService, isDead, isActiveOrIdle (the
 * restart rule, idle included: #263), isRunning, isPending,
 * keepsInstanceAlive (no `running` field), reportsRunning (bounded stop,
 * case-sensitive), launchFailed (down survivors, case-sensitive),
 * isHealthyForWait for an unprobed service.
 */
type VerdictRow = [
  status: string,
  exitCode: number | undefined,
  classified: ServiceVerdict,
  dead: boolean,
  activeOrIdle: boolean,
  running: boolean,
  pending: boolean,
  keepsAlive: boolean,
  reportsRunning: boolean,
  launchFailed: boolean,
  healthyUnprobed: boolean,
];

const VERDICTS: VerdictRow[] = [
  ["Running", undefined, "active", false, true, true, false, true, true, false, true],
  ["Running", 0, "active", false, true, true, false, true, true, false, true],
  ["Running", 1, "active", false, true, true, false, true, true, false, true],
  ["Running", -1, "active", false, true, true, false, true, true, false, true],
  ["Pending", undefined, "active", false, true, true, true, false, false, false, false],
  ["Pending", 0, "active", false, true, true, true, false, false, false, false],
  ["Pending", 1, "active", false, true, true, true, false, false, false, false],
  ["Pending", -1, "active", false, true, true, true, false, false, false, false],
  ["Launching", undefined, "active", false, true, true, false, true, false, false, false],
  ["Launching", 0, "active", false, true, true, false, true, false, false, false],
  ["Launching", 1, "active", false, true, true, false, true, false, false, false],
  ["Launching", -1, "active", false, true, true, false, true, false, false, false],
  ["Launched", undefined, "active", false, true, true, false, true, false, false, true],
  ["Launched", 0, "active", false, true, true, false, true, false, false, true],
  ["Launched", 1, "active", false, true, true, false, true, false, false, true],
  ["Launched", -1, "active", false, true, true, false, true, false, false, true],
  ["Restarting", undefined, "active", false, true, true, false, true, false, false, false],
  ["Restarting", 0, "active", false, true, true, false, true, false, false, false],
  ["Restarting", 1, "active", false, true, true, false, true, false, false, false],
  ["Restarting", -1, "active", false, true, true, false, true, false, false, false],
  ["Terminating", undefined, "active", false, true, true, false, false, false, false, false],
  ["Terminating", 0, "active", false, true, true, false, false, false, false, false],
  ["Terminating", 1, "active", false, true, true, false, false, false, false, false],
  ["Terminating", -1, "active", false, true, true, false, false, false, false, false],
  ["Completed", undefined, "done", false, false, false, false, false, false, false, true],
  ["Completed", 0, "done", false, false, false, false, false, false, false, true],
  ["Completed", 1, "dead", true, false, false, false, false, false, true, true],
  ["Completed", -1, "dead", true, false, false, false, false, false, true, true],
  ["Skipped", undefined, "active", false, true, false, false, false, false, false, false],
  ["Skipped", 0, "active", false, true, false, false, false, false, false, false],
  ["Skipped", 1, "active", false, true, false, false, false, false, false, false],
  ["Skipped", -1, "active", false, true, false, false, false, false, false, false],
  ["Disabled", undefined, "active", false, true, false, false, false, false, false, false],
  ["Disabled", 0, "active", false, true, false, false, false, false, false, false],
  ["Disabled", 1, "active", false, true, false, false, false, false, false, false],
  ["Disabled", -1, "active", false, true, false, false, false, false, false, false],
  ["Error", undefined, "dead", true, false, false, false, false, false, true, false],
  ["Error", 0, "dead", true, false, false, false, false, false, true, false],
  ["Error", 1, "dead", true, false, false, false, false, false, true, false],
  ["Error", -1, "dead", true, false, false, false, false, false, true, false],
  ["Failed", undefined, "dead", true, false, false, false, false, false, false, false],
  ["Failed", 0, "dead", true, false, false, false, false, false, false, false],
  ["Failed", 1, "dead", true, false, false, false, false, false, false, false],
  ["Failed", -1, "dead", true, false, false, false, false, false, false, false],
  ["Foreground", undefined, "active", false, true, true, false, true, false, false, false],
  ["Foreground", 0, "active", false, true, true, false, true, false, false, false],
  ["Foreground", 1, "active", false, true, true, false, true, false, false, false],
  ["Foreground", -1, "active", false, true, true, false, true, false, false, false],
  ["Ready", undefined, "active", false, true, true, false, true, false, false, true],
  ["Ready", 0, "active", false, true, true, false, true, false, false, true],
  ["Ready", 1, "active", false, true, true, false, true, false, false, true],
  ["Ready", -1, "active", false, true, true, false, true, false, false, true],
  ["Unknown", undefined, "active", false, true, true, false, true, false, false, false],
  ["Unknown", 0, "active", false, true, true, false, true, false, false, false],
  ["Unknown", 1, "active", false, true, true, false, true, false, false, false],
  ["Unknown", -1, "active", false, true, true, false, true, false, false, false],
  ["running", undefined, "active", false, true, true, false, true, false, false, true],
  ["running", 0, "active", false, true, true, false, true, false, false, true],
  ["running", 1, "active", false, true, true, false, true, false, false, true],
  ["running", -1, "active", false, true, true, false, true, false, false, true],
  ["pending", undefined, "active", false, true, true, true, false, false, false, false],
  ["pending", 0, "active", false, true, true, true, false, false, false, false],
  ["pending", 1, "active", false, true, true, true, false, false, false, false],
  ["pending", -1, "active", false, true, true, true, false, false, false, false],
  ["completed", undefined, "done", false, false, false, false, false, false, false, true],
  ["completed", 0, "done", false, false, false, false, false, false, false, true],
  ["completed", 1, "dead", true, false, false, false, false, false, false, true],
  ["completed", -1, "dead", true, false, false, false, false, false, false, true],
  ["error", undefined, "dead", true, false, false, false, false, false, false, false],
  ["error", 0, "dead", true, false, false, false, false, false, false, false],
  ["error", 1, "dead", true, false, false, false, false, false, false, false],
  ["error", -1, "dead", true, false, false, false, false, false, false, false],
  ["skipped", undefined, "active", false, true, false, false, false, false, false, false],
  ["skipped", 0, "active", false, true, false, false, false, false, false, false],
  ["skipped", 1, "active", false, true, false, false, false, false, false, false],
  ["skipped", -1, "active", false, true, false, false, false, false, false, false],
  ["disabled", undefined, "active", false, true, false, false, false, false, false, false],
  ["disabled", 0, "active", false, true, false, false, false, false, false, false],
  ["disabled", 1, "active", false, true, false, false, false, false, false, false],
  ["disabled", -1, "active", false, true, false, false, false, false, false, false],
  ["terminating", undefined, "active", false, true, true, false, false, false, false, false],
  ["terminating", 0, "active", false, true, true, false, false, false, false, false],
  ["terminating", 1, "active", false, true, true, false, false, false, false, false],
  ["terminating", -1, "active", false, true, true, false, false, false, false, false],
];

describe("service verdicts — every status × exit code (#251)", () => {
  it.each(VERDICTS)(
    "%s (exit %s)",
    (
      status,
      exitCode,
      classified,
      dead,
      activeOrIdle,
      running,
      pending,
      keepsAlive,
      reports,
      failed,
      healthyUnprobed,
    ) => {
      const r = row("x", status, exitCode);
      expect({
        classifyService: classifyService(r),
        isDead: isDead(r),
        isActiveOrIdle: isActiveOrIdle(r),
        isRunning: isRunning(r),
        isPending: isPending(r),
        keepsInstanceAlive: keepsInstanceAlive(r),
        reportsRunning: reportsRunning(r),
        launchFailed: launchFailed(r),
        isHealthyForWait: isHealthyForWait(r, false),
      }).toEqual({
        classifyService: classified,
        isDead: dead,
        isActiveOrIdle: activeOrIdle,
        isRunning: running,
        isPending: pending,
        keepsInstanceAlive: keepsAlive,
        reportsRunning: reports,
        launchFailed: failed,
        isHealthyForWait: healthyUnprobed,
      });
    },
  );
});

describe("keepsInstanceAlive — process-compose's is_running decides when it reports one", () => {
  it.each([
    ["Running", false, false],
    ["Pending", true, true],
    ["Terminating", true, true],
    ["Completed", true, true],
    ["Skipped", true, true],
    ["Running", true, true],
  ] as const)("%s with is_running %s keeps it alive: %s", (status, isRunningFlag, expected) => {
    expect(keepsInstanceAlive({ status, running: isRunningFlag })).toBe(expected);
  });
});

describe("isHealthyForWait — a probed service is healthy only on health ready (#108)", () => {
  const probedRow = (status: string, health: HealthState) => ({ status, health });

  it.each([
    ["Running", "ready", true],
    ["Running", "not_ready", false],
    ["Running", "unknown", false],
    ["Completed", "unknown", false],
    ["Pending", "ready", true],
    ["Error", "ready", true],
  ] as const)("%s with health %s: %s", (status, health, expected) => {
    expect(isHealthyForWait(probedRow(status, health), true)).toBe(expected);
  });

  it("an unprobed service ignores health", () => {
    expect(isHealthyForWait(probedRow("Running", "not_ready"), false)).toBe(true);
    expect(isHealthyForWait(probedRow("Pending", "ready"), false)).toBe(false);
  });
});
