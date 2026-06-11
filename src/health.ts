/**
 * Health waits (driver-backed pollers).
 *
 * The default implementations of the orchestration layer's two health gates:
 * the shared-tier wait that stands in for the cross-tier `depends_on` edge
 * process-compose cannot express (ADR-0003), and the worktree-instance wait
 * that keeps `up` from returning 0 before the stack can serve traffic
 * (PRD #26, ADR-0005).
 *
 * Both poll the driver's async `getServiceStatuses` — the documented shell-out
 * boundary — so they honor whatever binary/prefix args the instance was
 * spawned with (issue #87). They never shell out themselves, and never block
 * the event loop.
 */

import type { ServiceStatus } from "./driver.js";

/**
 * The slice of the driver the pollers need: one async read of an instance's
 * per-service runtime state over its UDS. Structural, so tests can hand in a
 * canned source and `createDriver(...)` satisfies it as-is.
 */
export interface ServiceStatusSource {
  getServiceStatuses(socketPath: string): Promise<ServiceStatus[]>;
}

/**
 * Wait until every shared service is healthy enough that an isolated service
 * depending on it can be started. Called between starting the shared instance
 * and starting the worktree instance whenever the worktree has cross-tier
 * `depends_on` edges (ADR-0003). The default polls the driver over the shared
 * instance's UDS; tests stub it.
 */
export type WaitForSharedHealth = (args: {
  readonly anchor: string;
  readonly socketPath: string;
  readonly sharedServiceNames: ReadonlyArray<string>;
}) => Promise<void>;

/**
 * Wait until every named service in an instance is healthy. Called after the
 * worktree instance starts so `up` only returns 0 when the stack can actually
 * serve traffic (PRD #26, ADR-0005). On timeout, implementations must throw a
 * `HealthTimeoutError` — left running, not torn down, so the agent can inspect
 * the failure with `devtrees logs <service>` afterwards.
 */
export type WaitForHealth = (args: {
  readonly socketPath: string;
  readonly serviceNames: ReadonlyArray<string>;
  readonly timeoutMs: number;
}) => Promise<void>;

/**
 * Throw on health-wait timeout; carries the `HEALTH_TIMEOUT` error code so the
 * CLI's error classifier (`classifyError` in output.ts) routes it to the
 * documented `--json` envelope without pattern-matching on the message. The
 * classifier reads `code` by duck-typing, so the class stays module-private —
 * callers branch on `err.code`/`err.name`, never on the class identity.
 */
class HealthTimeoutError extends Error {
  readonly code = "HEALTH_TIMEOUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "HealthTimeoutError";
  }
}

/**
 * "Healthy enough to start a depender" = the process is up. Services with a
 * readiness probe report `Ready`; services without one report `Running`;
 * one-shot jobs may have already moved to `Completed` — all three are fine to
 * depend on. Anything else (`Pending`, `Restarting`, `Failed`) means we keep
 * waiting.
 */
const HEALTHY_STATES = new Set(["running", "ready", "completed"]);

const SHARED_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 200;

/** Test seams for the poll cadence and (shared wait only) the deadline. */
export interface PollerTuning {
  /** Delay between polls. Default: 200ms. */
  readonly pollMs?: number;
  /** Shared-wait deadline. Default: 30s. The worktree wait takes its deadline per call. */
  readonly timeoutMs?: number;
}

/**
 * One poll: read the instance's per-service state through the driver and
 * report whether every named service is healthy. A failed read (socket not
 * reachable yet — the instance is still starting) is "not ready, keep polling",
 * never an error.
 */
async function allHealthy(
  source: ServiceStatusSource,
  socketPath: string,
  serviceNames: ReadonlyArray<string>,
): Promise<boolean> {
  let statuses: ServiceStatus[];
  try {
    statuses = await source.getServiceStatuses(socketPath);
  } catch {
    return false;
  }
  const states = new Map(statuses.map((s) => [s.name, s.status.toLowerCase()]));
  return serviceNames.every((name) => {
    const status = states.get(name);
    return status !== undefined && HEALTHY_STATES.has(status);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Default shared-health wait: polls the driver over the shared instance's UDS
 * until every shared service reports a healthy state or the timeout expires.
 * A zero-service wait returns immediately.
 */
export function createWaitForSharedHealth(
  source: ServiceStatusSource,
  tuning: PollerTuning = {},
): WaitForSharedHealth {
  const pollMs = tuning.pollMs ?? HEALTH_POLL_MS;
  const timeoutMs = tuning.timeoutMs ?? SHARED_HEALTH_TIMEOUT_MS;
  return async ({ socketPath, sharedServiceNames }) => {
    if (sharedServiceNames.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await allHealthy(source, socketPath, sharedServiceNames)) return;
      await sleep(pollMs);
    }
    throw new Error(
      `timed out waiting for shared services to be healthy [${sharedServiceNames.join(", ")}] ` +
        `after ${timeoutMs}ms. Check the shared instance's logs (\`devtrees attach --shared\`).`,
    );
  };
}

/**
 * Default worktree health-wait: same poll loop as the shared variant — only
 * the service set, deadline source, and timeout error differ. On timeout,
 * throws `HealthTimeoutError` so the CLI maps it to the documented
 * `HEALTH_TIMEOUT` envelope without pattern-matching on the message
 * (ADR-0005). A zero-service wait returns immediately so a stack with no
 * isolated services does not synthesize a timeout out of thin air.
 */
export function createWaitForHealth(
  source: ServiceStatusSource,
  tuning: PollerTuning = {},
): WaitForHealth {
  const pollMs = tuning.pollMs ?? HEALTH_POLL_MS;
  return async ({ socketPath, serviceNames, timeoutMs }) => {
    if (serviceNames.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await allHealthy(source, socketPath, serviceNames)) return;
      await sleep(pollMs);
    }
    throw new HealthTimeoutError(
      `timed out waiting for services to be healthy [${serviceNames.join(", ")}] ` +
        `after ${timeoutMs}ms. The worktree instance is still running — ` +
        `inspect it with \`devtrees logs <service>\` or \`devtrees ls --json\`.`,
    );
  };
}
