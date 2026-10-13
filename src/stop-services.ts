/**
 * The pure half of `devtrees stop <service...>` (ADR-0009, #223): which
 * named services are running, whether stopping them would end the
 * instance, its budget, and the errors it raises. The orchestration
 * (`runStop`) and the name resolution (`resolveNamedServices`) are in
 * src/commands.ts; the bounded stop is `boundedStopServices` in
 * src/bounded-stop.ts.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ForceKilled } from "./bounded-down.js";
import type { DerivedConfig } from "./deriver.js";
import { describeSurvivor, type DownSurvivor } from "./down-survivors.js";
import { downTimeoutMs, type ServiceStatus } from "./driver.js";
import { stateDir } from "./paths.js";
import { writeAtomic } from "./registry.js";
import { isRunning, keepsInstanceAlive } from "./service-state.js";

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
 * Split the named services (each booted: the caller checked) into those
 * still running or stopping, which the stop acts on, and the rest: already
 * stopped, done or dead. Order of `names` is kept.
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
 * service. Conservative (`keepsInstanceAlive`): only a process running now
 * counts. Done one-shots, stopped services, and a `Pending` dependent (it
 * may wait on the very service being stopped, and then never starts) do
 * not.
 */
export function assertNotLastRunning(
  rows: ReadonlyArray<ServiceStatus>,
  stopping: ReadonlyArray<string>,
  worktreeId: string,
): void {
  if (stopping.length === 0) return;
  const leaving = new Set(stopping);
  if (rows.some((r) => !leaving.has(r.name) && keepsInstanceAlive(r))) return;
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

/**
 * `SERVICE_STOP_INCOMPLETE` (ADR-0009): after the bounded stop and the
 * force-kill, something is still alive or still holds one of the checked
 * services' ports. Mirrors `DOWN_INCOMPLETE`: `details.survivors` lists
 * each, `details.force_killed` what devtrees signalled. A port holder is
 * not necessarily something the service started, so the wording stays
 * neutral.
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
    `devtrees stop: ${services.join(", ")} ${services.length === 1 ? "is" : "are"} stopped in ` +
      `'${worktreeId}', but these are still alive or still hold ` +
      `${services.length === 1 ? "its" : "their"} ports:\n` +
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

// ---------------------------------------------------------------------------
// The marker a `SERVICE_STOP_INCOMPLETE` leaves, so the retry its remedy
// names checks the same ports again even though the service is now stopped.
// ---------------------------------------------------------------------------

function markerFile(anchor: string, worktreeId: string): string {
  return join(stateDir(anchor), `${worktreeId}.stop-incomplete.json`);
}

/** The services an earlier `SERVICE_STOP_INCOMPLETE` left to re-check. */
export function readStopIncomplete(anchor: string, worktreeId: string): string[] {
  const file = markerFile(anchor, worktreeId);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { services?: unknown } | null;
    const services = parsed?.services;
    return Array.isArray(services) ? services.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Record the outcome of a stop's check: `failed` services are added to the
 * marker, `passed` ones removed from it. The file goes when it is empty.
 */
export function updateStopIncomplete(
  anchor: string,
  worktreeId: string,
  outcome: { readonly passed: ReadonlyArray<string>; readonly failed: ReadonlyArray<string> },
): void {
  const passed = new Set(outcome.passed);
  const left = [...new Set([...readStopIncomplete(anchor, worktreeId), ...outcome.failed])].filter(
    (s) => outcome.failed.includes(s) || !passed.has(s),
  );
  if (left.length === 0) {
    rmSync(markerFile(anchor, worktreeId), { force: true });
    return;
  }
  writeAtomic(markerFile(anchor, worktreeId), `${JSON.stringify({ services: left }, null, 2)}\n`);
}
