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
import {
  deadServicesDetails,
  describeDeadServices,
  findDeadServices,
  type DeadService,
} from "./service-state.js";

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
  /**
   * The command that brings the stack back, named when a waited-on service
   * is dead (ADR-0008) — e.g. `devtrees down && devtrees up -n app`. Default:
   * `devtrees down && devtrees up`.
   */
  readonly remedy?: string;
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
  constructor(
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
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

/** One poll's verdict over the named services. */
interface PollVerdict {
  readonly healthy: boolean;
  /** Named services that are dead (`classifyService`), in `serviceNames` order. */
  readonly dead: ReadonlyArray<DeadService>;
}

/**
 * One poll: read the instance's per-service state through the driver and
 * report whether every named service is healthy, and which are dead. Probed
 * services (those in `probedServiceNames`) require `health === "ready"`; the
 * rest gate on process state (`HEALTHY_STATES`). A failed read (socket not
 * reachable yet — the instance is still starting) is "not ready, keep
 * polling", never an error.
 *
 * A dead service is never healthy, whatever its status string: a crashed
 * `Completed` (non-zero exit) would otherwise pass the status gate the same
 * way a finished one-shot does (ADR-0008).
 */
async function poll(
  source: ServiceStatusSource,
  socketPath: string,
  serviceNames: ReadonlyArray<string>,
  probedServiceNames: ReadonlyArray<string>,
): Promise<PollVerdict> {
  let statuses: ServiceStatus[];
  try {
    statuses = await source.getServiceStatuses(socketPath);
  } catch {
    return { healthy: false, dead: [] };
  }
  const dead = findDeadServices(statuses, serviceNames);
  if (dead.length > 0) return { healthy: false, dead };
  const probed = new Set(probedServiceNames);
  const rows = new Map(statuses.map((s) => [s.name, s]));
  const healthy = serviceNames.every((name) => {
    const row = rows.get(name);
    if (row === undefined) return false;
    if (probed.has(name)) return row.health === "ready";
    return HEALTHY_STATES.has(row.status.toLowerCase());
  });
  return { healthy, dead };
}

async function allHealthy(
  source: ServiceStatusSource,
  socketPath: string,
  serviceNames: ReadonlyArray<string>,
  probedServiceNames: ReadonlyArray<string>,
): Promise<boolean> {
  return (await poll(source, socketPath, serviceNames, probedServiceNames)).healthy;
}

/** Same names in the same order — a dead set that held still across two polls. */
function sameDead(a: ReadonlyArray<DeadService>, b: ReadonlyArray<DeadService>): boolean {
  return a.length === b.length && a.every((d, i) => d.name === b[i]?.name);
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
 *
 * Fails fast on a dead service (ADR-0008): a crashed process is not going to
 * become healthy by waiting, so once the same services read dead on two
 * consecutive polls the wait throws `HEALTH_TIMEOUT` straight away, naming
 * them and `remedy`. Two reads, not one, so the instant between a crash and
 * process-compose flipping a restartable process to `Restarting` is never
 * mistaken for a final state. Nothing is restarted here.
 */
export function createWaitForHealth(
  source: ServiceStatusSource,
  tuning: PollerTuning = {},
): WaitForHealth {
  const pollMs = tuning.pollMs ?? HEALTH_POLL_MS;
  return async ({ socketPath, serviceNames, probedServiceNames, timeoutMs, remedy }) => {
    if (serviceNames.length === 0) return;
    const fix = remedy ?? "devtrees down && devtrees up";
    const deadline = Date.now() + timeoutMs;
    let lastDead: ReadonlyArray<DeadService> = [];
    while (Date.now() < deadline) {
      const verdict = await poll(source, socketPath, serviceNames, probedServiceNames);
      if (verdict.healthy) return;
      if (verdict.dead.length > 0 && sameDead(verdict.dead, lastDead)) {
        throw deadServicesError(verdict.dead, fix);
      }
      lastDead = verdict.dead;
      await sleep(pollMs);
    }
    if (lastDead.length > 0) throw deadServicesError(lastDead, fix);
    throw new HealthTimeoutError(
      `timed out waiting for services to be healthy [${serviceNames.join(", ")}] ` +
        `after ${timeoutMs}ms. The worktree instance is still running — ` +
        `inspect it with \`devtrees logs <service>\` or \`devtrees ls --json\`.`,
    );
  };
}

/**
 * The `HEALTH_TIMEOUT` a dead service produces: names each dead service with
 * its status and exit code, and the `down` + `up` that brings it back. The
 * instance is left running (ADR-0005) so its logs stay readable.
 */
function deadServicesError(dead: ReadonlyArray<DeadService>, remedy: string): HealthTimeoutError {
  return new HealthTimeoutError(
    `service(s) not running: ${describeDeadServices(dead)}. devtrees does not restart ` +
      `them yet; run \`${remedy}\` to bring the stack back. The worktree instance is still ` +
      `running — read why with \`devtrees logs <service>\`.`,
    { dead_services: deadServicesDetails(dead), remedy },
  );
}
