import { describe, expect, it } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  createWaitForHealth,
  createWaitForSharedHealth,
  type ServiceStatusSource,
} from "./health.js";
import {
  createDriver,
  parseServiceStatuses,
  type ServiceStatus,
  type SpawnedProcess,
} from "./driver.js";

/** Build a status source from a queue of canned responses (last one repeats). */
function sourceFromQueue(
  queue: Array<ServiceStatus[] | Error>,
  calls?: { count: number },
): ServiceStatusSource {
  return {
    getServiceStatuses: () => {
      if (calls) calls.count += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? []);
    },
  };
}

function row(
  name: string,
  status: string,
  health: ServiceStatus["health"] = "unknown",
): ServiceStatus {
  return { name, status, health };
}

describe("health — createWaitForHealth (worktree instance gate)", () => {
  it("resolves once every named service reports a healthy state", async () => {
    const source = sourceFromQueue([
      [row("web", "Pending"), row("worker", "Running")],
      [row("web", "Running"), row("worker", "Running")],
    ]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web", "worker"],
        probedServiceNames: [],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats Ready and Completed as healthy alongside Running", async () => {
    const source = sourceFromQueue([
      [row("web", "Ready"), row("migrate", "Completed"), row("worker", "Running")],
    ]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web", "migrate", "worker"],
        probedServiceNames: [],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes a finished exit-0 one-shot parsed from real process-compose output (#174)", async () => {
    // A one-shot has no probe: is_ready "-" -> health unknown, so the wait
    // gates on status `Completed`. The #174 not-running override must not
    // turn it into a failure or a hang.
    const source: ServiceStatusSource = {
      getServiceStatuses: () =>
        Promise.resolve(
          parseServiceStatuses(
            JSON.stringify([
              {
                name: "migrate",
                status: "Completed",
                is_ready: "-",
                exit_code: 0,
                is_running: false,
              },
              { name: "web", status: "Running", is_ready: "Ready", is_running: true },
            ]),
          ),
        ),
    };
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["migrate", "web"],
        probedServiceNames: ["web"],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps polling through status-read failures (socket not up yet)", async () => {
    const source = sourceFromQueue([
      new Error("connect ENOENT /run/x.sock"),
      [row("web", "Running")],
    ]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web"],
        probedServiceNames: [],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws HealthTimeoutError (code HEALTH_TIMEOUT) when the deadline passes", async () => {
    const source = sourceFromQueue([[row("web", "Pending")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    const err = await wait({
      socketPath: "/run/x.sock",
      serviceNames: ["web"],
      probedServiceNames: [],
      timeoutMs: 10,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // The CLI's classifyError reads `code` by duck-typing (ADR-0005); assert
    // the same surface instead of the module-private class identity.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("HealthTimeoutError");
    expect((err as Error & { code?: string }).code).toBe("HEALTH_TIMEOUT");
  });

  it("a zero-service wait returns immediately without touching the instance", async () => {
    const calls = { count: 0 };
    const source = sourceFromQueue([[]], calls);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await wait({
      socketPath: "/run/x.sock",
      serviceNames: [],
      probedServiceNames: [],
      timeoutMs: 10,
    });
    expect(calls.count).toBe(0);
  });

  it("an unknown service name keeps the wait unhealthy until timeout", async () => {
    const source = sourceFromQueue([[row("web", "Running")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web", "ghost"],
        probedServiceNames: [],
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
  });

  // Issue #108: process-compose keeps a probed service's status at "Running"
  // while readiness arrives in the separate is_ready field. A Running-but-not-
  // ready probed service must NOT satisfy the gate, or `up` exits 0 before the
  // first probe can fire.
  it("a probed service that is Running but not ready keeps the wait unhealthy until timeout", async () => {
    const source = sourceFromQueue([[row("web", "Running", "not_ready")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web"],
        probedServiceNames: ["web"],
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
  });

  it("resolves once a probed service reports health:ready (status stays Running)", async () => {
    const source = sourceFromQueue([
      [row("web", "Running", "not_ready")],
      [row("web", "Running", "ready")],
    ]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web"],
        probedServiceNames: ["web"],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("mixed stack: unprobed services pass on Running while a probed sibling still gates", async () => {
    const source = sourceFromQueue([
      [row("web", "Running", "not_ready"), row("worker", "Running")],
      [row("web", "Running", "ready"), row("worker", "Running")],
    ]);
    const calls = { count: 0 };
    const counted: ServiceStatusSource = {
      getServiceStatuses: (s) => {
        calls.count += 1;
        return source.getServiceStatuses(s);
      },
    };
    const wait = createWaitForHealth(counted, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web", "worker"],
        probedServiceNames: ["web"],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
    // The first poll (web not ready) must not have satisfied the gate.
    expect(calls.count).toBeGreaterThan(1);
  });

  it("a probed service with health:unknown does not satisfy the gate", async () => {
    // e.g. process-compose returned a row before the probe machinery
    // initialised — readiness has not been observed, so keep waiting.
    const source = sourceFromQueue([[row("web", "Running", "unknown")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web"],
        probedServiceNames: ["web"],
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
  });
});

describe("health — createWaitForHealth fails fast on a dead service (ADR-0008, #177)", () => {
  const dead = (name: string, exitCode: number): ServiceStatus => ({
    name,
    status: "Completed",
    health: "unknown",
    exitCode,
  });

  it("a killed unprobed service (Completed, exit -1) fails with HEALTH_TIMEOUT long before the deadline, naming it and the remedy", async () => {
    // #162: health is `unknown` for an unprobed service, so only the exit
    // code tells the corpse apart from a finished one-shot.
    const source = sourceFromQueue([[dead("toy", -1), row("keeper", "Running")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    const started = Date.now();
    const err = await wait({
      socketPath: "/run/x.sock",
      serviceNames: ["toy", "keeper"],
      probedServiceNames: [],
      timeoutMs: 60_000,
      remedy: "devtrees down && devtrees up -n test",
    }).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err?.code).toBe("HEALTH_TIMEOUT");
    expect(err?.message).toContain("toy (Completed, exit -1)");
    expect(err?.message).toContain("devtrees down && devtrees up -n test");
    expect(err?.message).not.toContain("keeper");
    expect(err?.details).toEqual({
      dead_services: [{ name: "toy", status: "Completed", exit_code: -1 }],
      remedy: "devtrees down && devtrees up -n test",
    });
  });

  it("Failed and Error count as dead too", async () => {
    const source = sourceFromQueue([[row("a", "Failed"), row("b", "Error")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/s",
        serviceNames: ["a", "b"],
        probedServiceNames: [],
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "HEALTH_TIMEOUT",
      message: expect.stringContaining("a (Failed), b (Error)"),
    });
  });

  it("a Completed exit-0 one-shot is done, not dead", async () => {
    const source = sourceFromQueue([[dead("migrate", 0), row("web", "Running")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/s",
        serviceNames: ["migrate", "web"],
        probedServiceNames: [],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("a single dead read that recovers (crash → Restarting) does not fail the wait", async () => {
    // The instant between a crash and process-compose flipping a restartable
    // process to Restarting must not be read as final: fail-fast needs the
    // same dead set on two consecutive polls.
    const source = sourceFromQueue([
      [dead("web", 1)],
      [row("web", "Restarting")],
      [row("web", "Running")],
    ]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({ socketPath: "/s", serviceNames: ["web"], probedServiceNames: [], timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("a dead service that is not waited on does not fail the wait", async () => {
    const source = sourceFromQueue([[dead("other", -1), row("web", "Running")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({ socketPath: "/s", serviceNames: ["web"], probedServiceNames: [], timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("a probed service whose process died is dead, not merely not-ready", async () => {
    const source = sourceFromQueue([
      [{ name: "web", status: "Completed", health: "not_ready", exitCode: -1 }],
    ]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/s",
        serviceNames: ["web"],
        probedServiceNames: ["web"],
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "HEALTH_TIMEOUT",
      details: { dead_services: [{ name: "web" }] },
    });
  });
});

describe("health — createWaitForSharedHealth (cross-tier gate)", () => {
  it("resolves once every shared service is healthy", async () => {
    const source = sourceFromQueue([[row("db", "Pending")], [row("db", "Running")]]);
    const wait = createWaitForSharedHealth(source, { pollMs: 1 });
    await expect(
      wait({
        anchor: "/a",
        socketPath: "/run/shared.sock",
        sharedServiceNames: ["db"],
        probedServiceNames: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("a zero-service wait returns immediately without touching the instance", async () => {
    const calls = { count: 0 };
    const source = sourceFromQueue([[]], calls);
    const wait = createWaitForSharedHealth(source, { pollMs: 1 });
    await wait({
      anchor: "/a",
      socketPath: "/run/shared.sock",
      sharedServiceNames: [],
      probedServiceNames: [],
    });
    expect(calls.count).toBe(0);
  });

  it("times out with a plain Error pointing at the shared instance's logs", async () => {
    const source = sourceFromQueue([[row("db", "Restarting")]]);
    const wait = createWaitForSharedHealth(source, { pollMs: 1, timeoutMs: 10 });
    const err = await wait({
      anchor: "/a",
      socketPath: "/run/shared.sock",
      sharedServiceNames: ["db"],
      probedServiceNames: [],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("db");
    expect((err as { code?: string }).code).toBeUndefined();
  });

  // Issue #108: the shared gate has the same probed-service semantics as the
  // worktree gate — a Running-but-not-ready probed shared service must hold
  // back dependent worktree starts until its probe passes.
  it("a probed shared service gates on readiness, not on Running", async () => {
    const source = sourceFromQueue([
      [row("db", "Running", "not_ready")],
      [row("db", "Running", "ready")],
    ]);
    const calls = { count: 0 };
    const counted: ServiceStatusSource = {
      getServiceStatuses: (s) => {
        calls.count += 1;
        return source.getServiceStatuses(s);
      },
    };
    const wait = createWaitForSharedHealth(counted, { pollMs: 1 });
    await expect(
      wait({
        anchor: "/a",
        socketPath: "/run/shared.sock",
        sharedServiceNames: ["db"],
        probedServiceNames: ["db"],
      }),
    ).resolves.toBeUndefined();
    expect(calls.count).toBeGreaterThan(1);
  });
});

describe("health — default waits go through the driver (issue #87)", () => {
  /**
   * Acceptance: health waits use the same binary/prefix args the instance was
   * spawned with. A driver bound to a custom binary must be the thing the
   * poller shells through — no hardcoded `process-compose` on PATH.
   */
  it("polls via the injected driver binary and prefix args", async () => {
    const spawnedWith: Array<{ binary: string; args: ReadonlyArray<string> }> = [];
    const driver = createDriver({
      binary: "/opt/custom/process-compose",
      prefixArgs: ["--flavor", "fork"],
      exists: () => Promise.resolve(true),
      spawner: (binary, args): SpawnedProcess => {
        spawnedWith.push({ binary, args });
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
        };
        child.stdout = Readable.from([
          JSON.stringify([{ name: "web", status: "Running", is_ready: "Ready" }]),
        ]);
        child.stderr = Readable.from([]);
        queueMicrotask(() => {
          // Let the stdout data flush before signalling exit.
          setImmediate(() => child.emit("exit", 0));
        });
        return child as unknown as SpawnedProcess;
      },
    });

    const wait = createWaitForHealth(driver, { pollMs: 1 });
    await expect(
      wait({
        socketPath: "/run/x.sock",
        serviceNames: ["web"],
        probedServiceNames: [],
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();

    expect(spawnedWith.length).toBeGreaterThan(0);
    const call = spawnedWith[0];
    expect(call?.binary).toBe("/opt/custom/process-compose");
    expect(call?.args.slice(0, 2)).toEqual(["--flavor", "fork"]);
    expect(call?.args).toContain("list");
  });
});
