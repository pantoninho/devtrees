/**
 * The pure half of stopping named services, the first half of
 * `devtrees restart <service...>` (ADR-0009, #222, #223): which named
 * services are running, whether stopping them would end the instance, its
 * budget, and the errors it raises. The orchestration (`runRestart`) and the
 * name resolution (`resolveNamedServices`) are in src/commands.ts; the
 * bounded stop is `boundedStopServices` in src/bounded-stop.ts.
 */

import type { DerivedConfig } from "./deriver.js";
import { downTimeoutMs, type ServiceStatus } from "./driver.js";
import { isRunning, keepsInstanceAlive } from "./service-state.js";

/** An error tagged with a stable `code` and `details` for the `--json` envelope. */
function codedError(code: string, message: string, details: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { code?: string; details?: Record<string, unknown> };
  err.code = code;
  err.details = details;
  return err;
}

/**
 * `INSTANCE_NOT_FOUND` when process-compose exited while `restart` (#222)
 * was stopping services: it exits once nothing runs, so something else
 * stopped meanwhile (a dependent that never started, a crash). The whole
 * instance is gone, so the restart must not report success; the next `up`
 * starts it again. Names what it had already restarted (`done`).
 */
export function instanceExitedError(
  worktreeId: string,
  services: ReadonlyArray<string>,
  done: ReadonlyArray<string> = [],
): Error {
  return codedError(
    "INSTANCE_NOT_FOUND",
    `devtrees restart: process-compose exited while ${services.join(", ")} ` +
      `${services.length === 1 ? "was" : "were"} stopping, so '${worktreeId}' is no longer ` +
      "running: no other process was left running (process-compose exits once nothing " +
      `runs).${alreadyRestarted(done)} Run \`devtrees up\` to start the instance again.`,
    { worktree_id: worktreeId, services: [...services] },
  );
}

/** " devtrees had already restarted api, mobile." when `done` is not empty. */
function alreadyRestarted(done: ReadonlyArray<string>): string {
  return done.length === 0 ? "" : ` devtrees had already restarted ${done.join(", ")}.`;
}

/**
 * `INSTANCE_NOT_FOUND` for a per-service command with no instance running.
 * A `restart` that had already restarted some services (`done`) found it
 * gone between two of its steps, most likely to a concurrent `down`.
 */
export function instanceNotRunningError(
  command: string,
  worktreeId: string,
  done: ReadonlyArray<string> = [],
): Error {
  const message =
    done.length === 0
      ? `devtrees ${command}: no worktree instance is running for '${worktreeId}'. ` +
        "Nothing was touched. Run `devtrees up` to bring it up first."
      : `devtrees ${command}: '${worktreeId}' stopped between two of this \`${command}\`'s ` +
        `steps (most likely a concurrent \`devtrees down\`).${alreadyRestarted(done)} ` +
        "Run `devtrees up` to start it again.";
  return codedError("INSTANCE_NOT_FOUND", message, { worktree_id: worktreeId });
}

/** Is the row a service still waiting on its dependencies, never started? */
function isPending(row: Pick<ServiceStatus, "status">): boolean {
  return row.status.toLowerCase() === "pending";
}

/**
 * Split the named services (each booted: the caller checked) into those
 * still running or stopping, which the stop acts on; those still `Pending`
 * (waiting on their dependencies, never started: `assertNotPending` refuses
 * them); and the rest: already stopped, done or dead. Order of `names` is
 * kept.
 */
export function partitionRunning(
  rows: ReadonlyArray<ServiceStatus>,
  names: ReadonlyArray<string>,
): {
  readonly running: string[];
  readonly pending: string[];
  readonly notRunning: string[];
} {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const pick = (test: (row: ServiceStatus) => boolean) =>
    names.filter((n) => {
      const row = byName.get(n);
      return row !== undefined && test(row);
    });
  const pending = pick(isPending);
  const running = pick((row) => isRunning(row) && !isPending(row));
  return {
    running,
    pending,
    notRunning: names.filter((n) => !running.includes(n) && !pending.includes(n)),
  };
}

/**
 * Refuse to restart a service still `Pending` (#223, B3): it is waiting on
 * its dependencies and has not started, so there is nothing to restart.
 * process-compose v1.122.0 would accept the stop request and leave it
 * `Terminating` with no process for good: it never starts, not even once its
 * dependency is healthy, and `up` cannot bring it back. Nothing is touched.
 * `waitingOn` maps each pending service to what it `depends_on`.
 */
export function assertNotPending(
  pending: ReadonlyArray<string>,
  waitingOn: (service: string) => ReadonlyArray<string>,
  worktreeId: string,
): void {
  if (pending.length === 0) return;
  const deps = [...new Set(pending.flatMap(waitingOn))];
  const one = pending.length === 1;
  const remedy =
    deps.length === 0
      ? `Wait until ${one ? "it starts" : "they start"}.`
      : `Wait until ${one ? "it starts" : "they start"} (once ${deps.join(", ")} ` +
        `${deps.length === 1 ? "is" : "are"} ready), or restart what ${one ? "it waits" : "they wait"} ` +
        `on: \`devtrees restart ${deps.join(" ")}\`.`;
  throw codedError(
    "SERVICE_PENDING",
    `devtrees restart: ${pending.join(", ")} ${one ? "is" : "are"} still waiting on ` +
      `${one ? "its" : "their"} dependencies in '${worktreeId}' and ` +
      `${one ? "has" : "have"} not started, so there is nothing to restart. Nothing was ` +
      `touched. ${remedy}`,
    { services: [...pending], waiting_on: deps, remedy },
  );
}

/**
 * Refuse a restart that would stop the instance's last running process
 * (ADR-0009): `restart` stops a service before starting it again, and
 * process-compose v1.122.0 exits once nothing runs ("Project completed"),
 * silently tearing the instance down under a command that promised only a
 * service. Conservative (`keepsInstanceAlive`): only a process running now
 * counts. Done one-shots, stopped services, and a `Pending` dependent (it
 * may wait on the very service being stopped, and then never starts) do
 * not. `remedy` restarts the whole instance; `done` names the services
 * already restarted.
 */
export function assertNotLastRunning(
  rows: ReadonlyArray<ServiceStatus>,
  stopping: ReadonlyArray<string>,
  worktreeId: string,
  restart: { readonly remedy: string; readonly done: ReadonlyArray<string> },
): void {
  if (stopping.length === 0) return;
  const leaving = new Set(stopping);
  if (rows.some((r) => !leaving.has(r.name) && keepsInstanceAlive(r))) return;
  const outcome =
    restart.done.length === 0
      ? "nothing was restarted."
      : `devtrees did not restart ${stopping.join(", ")} (it had restarted ` +
        `${restart.done.join(", ")} before).`;
  const remedy = restart.remedy;
  throw codedError(
    "LAST_SERVICES_RUNNING",
    `devtrees restart: ${stopping.join(", ")} ${stopping.length === 1 ? "is" : "are"} the last ` +
      `running process(es) of '${worktreeId}'. process-compose exits once nothing runs, which ` +
      `would take the whole instance down, so ${outcome} Run \`${remedy}\` to ` +
      "restart the instance.",
    { worktree_id: worktreeId, services: [...stopping], remedy },
  );
}

/**
 * The stop budget: `down`'s base (`baseMs`, default 30s) plus the
 * `shutdown.timeout_seconds` of the services being stopped, and only those.
 */
export function stopTimeoutMs(
  config: DerivedConfig | undefined,
  names: ReadonlyArray<string>,
  baseMs?: number,
): number {
  const picked = Object.entries(config?.processes ?? {}).filter(([name]) => names.includes(name));
  return downTimeoutMs(
    config === undefined ? undefined : { processes: Object.fromEntries(picked) },
    baseMs,
  );
}
