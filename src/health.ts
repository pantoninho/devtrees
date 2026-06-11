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
  /**
   * The subset of `sharedServiceNames` that declares a readiness probe in the
   * resolved stack. These gate on `health === "ready"` instead of process
   * state (issue #108) — see `allHealthy`.
   */
  readonly probedServiceNames: ReadonlyArray<string>;
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
  /**
   * The subset of `serviceNames` that declares a readiness probe in the
   * resolved stack. These gate on `health === "ready"` instead of process
   * state (issue #108) — see `allHealthy`.
   */
  readonly probedServiceNames: ReadonlyArray<string>;
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
 * "Healthy enough" for a service WITHOUT a readiness probe = the process is
 * up: `Running`, or `Completed` for one-shot jobs (`Ready` is kept for
 * forward-compatibility with status vocabularies that fold readiness into the
 * status string). Anything else (`Pending`, `Restarting`, `Failed`) means we
 * keep waiting.
 *
 * Services WITH a readiness probe never gate on this set. Empirically
 * process-compose keeps their `status` at `Running` while the probe verdict
 * arrives in the separate `is_ready` field (the driver normalises it into
 * `ServiceStatus.health`), so a status-only gate would pass the instant the
 * process spawns — before the first probe can fire (issue #108). Probed
 * services are healthy only when `health === "ready"`.
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
 * report whether every named service is healthy. Probed services (those in
 * `probedServiceNames`) require `health === "ready"`; the rest gate on
 * process state (`HEALTHY_STATES`). A failed read (socket not reachable yet —
 * the instance is still starting) is "not ready, keep polling", never an
 * error.
 */
async function allHealthy(
  source: ServiceStatusSource,
  socketPath: string,
  serviceNames: ReadonlyArray<string>,
  probedServiceNames: ReadonlyArray<string>,
): Promise<boolean> {
  let statuses: ServiceStatus[];
  try {
    statuses = await source.getServiceStatuses(socketPath);
  } catch {
    return false;
  }
  const probed = new Set(probedServiceNames);
  const rows = new Map(statuses.map((s) => [s.name, s]));
  return serviceNames.every((name) => {
    const row = rows.get(name);
    if (row === undefined) return false;
    if (probed.has(name)) return row.health === "ready";
    return HEALTHY_STATES.has(row.status.toLowerCase());
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
  return async ({ socketPath, sharedServiceNames, probedServiceNames }) => {
    if (sharedServiceNames.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await allHealthy(source, socketPath, sharedServiceNames, probedServiceNames)) return;
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
  return async ({ socketPath, serviceNames, probedServiceNames, timeoutMs }) => {
    if (serviceNames.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await allHealthy(source, socketPath, serviceNames, probedServiceNames)) return;
      await sleep(pollMs);
    }
    throw new HealthTimeoutError(
      `timed out waiting for services to be healthy [${serviceNames.join(", ")}] ` +
        `after ${timeoutMs}ms. The worktree instance is still running — ` +
        `inspect it with \`devtrees logs <service>\` or \`devtrees ls --json\`.`,
    );
  };
}
