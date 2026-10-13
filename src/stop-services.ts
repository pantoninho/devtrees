/**
 * The pure half of `devtrees stop <service...>` (ADR-0009, #223): which
 * named services are running, whether stopping them would end the
 * instance, and the errors it raises. The orchestration (`runStop`) and the
 * name resolution (`resolveNamedServices`) are in src/commands.ts; the
 * bounded stop is `boundedStopServices` in src/bounded-stop.ts.
 */

import type { ForceKilled } from "./bounded-down.js";
import { describeSurvivor, type DownSurvivor } from "./down-survivors.js";
import type { ServiceStatus } from "./driver.js";
import { isRunning } from "./service-state.js";

/** An error tagged with a stable `code` and `details` for the `--json` envelope. */
export function codedError(code: string, message: string, details: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { code?: string; details?: Record<string, unknown> };
  err.code = code;
  err.details = details;
  return err;
}

/** `INSTANCE_NOT_FOUND` for a per-service command with no instance running. */
export function instanceNotRunningError(command: string, worktreeId: string): Error {
  return codedError(
    "INSTANCE_NOT_FOUND",
    `devtrees ${command}: no worktree instance is running for '${worktreeId}'. ` +
      "Nothing was touched. Run `devtrees up` to bring it up first.",
    { worktree_id: worktreeId },
  );
}

/**
 * Split the named services into those still running, which the stop acts
 * on, and the rest: already stopped, done, dead, or not booted at all (a
 * namespace the instance was not started with). Order of `names` is kept.
 */
export function partitionRunning(
  rows: ReadonlyArray<ServiceStatus>,
  names: ReadonlyArray<string>,
): { readonly running: string[]; readonly notRunning: string[] } {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const running = names.filter((n) => {
    const row = byName.get(n);
    return row !== undefined && isRunning(row);
  });
  return { running, notRunning: names.filter((n) => !running.includes(n)) };
}

/**
 * Refuse a stop that would leave the instance with no running process
 * (ADR-0009): process-compose v1.122.0 then exits ("Project completed"),
 * silently tearing the instance down under a command that promised only a
 * service. Done one-shots and already-stopped services do not count.
 */
export function assertNotLastRunning(
  rows: ReadonlyArray<ServiceStatus>,
  stopping: ReadonlyArray<string>,
  worktreeId: string,
): void {
  if (stopping.length === 0) return;
  const leaving = new Set(stopping);
  if (rows.some((r) => !leaving.has(r.name) && isRunning(r))) return;
  throw codedError(
    "LAST_SERVICES_RUNNING",
    `devtrees stop: ${stopping.join(", ")} ${stopping.length === 1 ? "is" : "are"} the last ` +
      `running process(es) of '${worktreeId}'. process-compose exits once nothing runs, which ` +
      "would take the whole instance down, so nothing was stopped. Run `devtrees down` to " +
      "stop the instance.",
    { worktree_id: worktreeId, services: [...stopping], remedy: "devtrees down" },
  );
}

/**
 * `SERVICE_STOP_INCOMPLETE` (ADR-0009): something a stopped service started
 * is still alive after the bounded stop and the force-kill. Mirrors
 * `DOWN_INCOMPLETE`: `details.survivors` lists each, `details.force_killed`
 * what devtrees signalled.
 */
export function serviceStopIncomplete(
  worktreeId: string,
  services: ReadonlyArray<string>,
  survivors: ReadonlyArray<DownSurvivor>,
  forceKilled: ReadonlyArray<ForceKilled>,
): Error {
  const forwarded = survivors.some((s) => s.port_forwarder === true);
  const remedy =
    `Stop what is listed by hand, then run \`devtrees stop ${services.join(" ")}\` again: ` +
    "it checks the same ports and succeeds once they are free. " +
    (forwarded
      ? "A port held by a container runtime's port forwarder means a container still " +
        "publishes it: stop that container, never the forwarder."
      : "Never kill a container runtime's port forwarder: stop the container instead.");
  return codedError(
    "SERVICE_STOP_INCOMPLETE",
    `devtrees stop: ${services.join(", ")} did not stop cleanly in '${worktreeId}'; some of ` +
      `what ${services.length === 1 ? "it" : "they"} started is still alive:\n` +
      `${survivors.map(describeSurvivor).join("\n")}\n${remedy}`,
    {
      worktree_id: worktreeId,
      services: [...services],
      survivors: [...survivors],
      force_killed: [...forceKilled],
      remedy,
    },
  );
}
