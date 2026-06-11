import { describe, expect, it } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  HealthTimeoutError,
  createWaitForHealth,
  createWaitForSharedHealth,
  type ServiceStatusSource,
} from "./health.js";
import { createDriver, type ServiceStatus, type SpawnedProcess } from "./driver.js";

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

function row(name: string, status: string): ServiceStatus {
  return { name, status, health: "unknown" };
}

describe("health — createWaitForHealth (worktree instance gate)", () => {
  it("resolves once every named service reports a healthy state", async () => {
    const source = sourceFromQueue([
      [row("web", "Pending"), row("worker", "Running")],
      [row("web", "Running"), row("worker", "Running")],
    ]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({ socketPath: "/run/x.sock", serviceNames: ["web", "worker"], timeoutMs: 1000 }),
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
      wait({ socketPath: "/run/x.sock", serviceNames: ["web"], timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("throws HealthTimeoutError (code HEALTH_TIMEOUT) when the deadline passes", async () => {
    const source = sourceFromQueue([[row("web", "Pending")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    const err = await wait({
      socketPath: "/run/x.sock",
      serviceNames: ["web"],
      timeoutMs: 10,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HealthTimeoutError);
    expect((err as HealthTimeoutError).code).toBe("HEALTH_TIMEOUT");
  });

  it("a zero-service wait returns immediately without touching the instance", async () => {
    const calls = { count: 0 };
    const source = sourceFromQueue([[]], calls);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await wait({ socketPath: "/run/x.sock", serviceNames: [], timeoutMs: 10 });
    expect(calls.count).toBe(0);
  });

  it("an unknown service name keeps the wait unhealthy until timeout", async () => {
    const source = sourceFromQueue([[row("web", "Running")]]);
    const wait = createWaitForHealth(source, { pollMs: 1 });
    await expect(
      wait({ socketPath: "/run/x.sock", serviceNames: ["web", "ghost"], timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(HealthTimeoutError);
  });
});

describe("health — createWaitForSharedHealth (cross-tier gate)", () => {
  it("resolves once every shared service is healthy", async () => {
    const source = sourceFromQueue([
      [row("db", "Pending")],
      [row("db", "Running")],
    ]);
    const wait = createWaitForSharedHealth(source, { pollMs: 1 });
    await expect(
      wait({ anchor: "/a", socketPath: "/run/shared.sock", sharedServiceNames: ["db"] }),
    ).resolves.toBeUndefined();
  });

  it("a zero-service wait returns immediately without touching the instance", async () => {
    const calls = { count: 0 };
    const source = sourceFromQueue([[]], calls);
    const wait = createWaitForSharedHealth(source, { pollMs: 1 });
    await wait({ anchor: "/a", socketPath: "/run/shared.sock", sharedServiceNames: [] });
    expect(calls.count).toBe(0);
  });

  it("times out with a plain Error pointing at the shared instance's logs", async () => {
    const source = sourceFromQueue([[row("db", "Restarting")]]);
    const wait = createWaitForSharedHealth(source, { pollMs: 1, timeoutMs: 10 });
    const err = await wait({
      anchor: "/a",
      socketPath: "/run/shared.sock",
      sharedServiceNames: ["db"],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("db");
    expect((err as { code?: string }).code).toBeUndefined();
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
      wait({ socketPath: "/run/x.sock", serviceNames: ["web"], timeoutMs: 1000 }),
    ).resolves.toBeUndefined();

    expect(spawnedWith.length).toBeGreaterThan(0);
    const call = spawnedWith[0];
    expect(call?.binary).toBe("/opt/custom/process-compose");
    expect(call?.args.slice(0, 2)).toEqual(["--flavor", "fork"]);
    expect(call?.args).toContain("list");
  });
});
