/**
 * What a worktree `down` checks after process-compose has stopped (#155).
 *
 * `process-compose down` exiting 0 does not mean everything the instance
 * started is gone:
 *
 *  - process-compose runs a `shutdown.command` only for a process it still
 *    considers running. A daemon (`is_daemon: true`) whose launch failed is
 *    `Error`, or `Completed` with a non-zero exit code, so its hook is
 *    skipped, although the launch may well have started containers before it
 *    failed (a `supabase start` that times out on a health check).
 *    `daemonHooksSkipped` picks those hooks so `down` runs them itself, as
 *    the dead-supervisor reap does (#148). A daemon that is `Completed` with
 *    exit 0 was stopped earlier (`process stop`, the TUI), and its hook ran
 *    then: it is left alone, so no hook runs twice.
 *  - A listener can outlive the stop: a container whose hook was skipped or
 *    killed at its timeout, or a process that left its service's process
 *    group (devtrees never kills those: they may be daemons other instances
 *    share). `findPortSurvivors` connects to each port the booted services
 *    declare; one that still accepts is a survivor.
 *
 * A survivor fails `down` with `DOWN_INCOMPLETE` instead of the old
 * "worktree instance stopped" and exit 0: the instance's socket is gone, so
 * nothing else would point at what it left behind. The booted services are
 * recorded in a marker, so the next `down` (with process-compose gone, it
 * re-runs every hook directly) checks the same ports again and only succeeds
 * once they are free.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ForceKilled, ServiceProcess } from "./bounded-down.js";
import { DEVTREES_METADATA_KEY, type DerivedConfig } from "./deriver.js";
import type { ServiceStatus } from "./driver.js";
import { stateDir } from "./paths.js";
import { forwarderLabel, isPortForwarder } from "./port-connect.js";
import type { HookFailure } from "./reaper.js";
import { writeAtomic } from "./registry.js";

/**
 * Did this daemon's launch fail, as the pre-stop `process list` shows it?
 * `Error` (it could not start), or `Completed` with a non-zero exit code.
 * An unknown exit code is not a failure: running a hook twice is the worse
 * mistake.
 */
function launchFailed(status: ServiceStatus): boolean {
  if (status.status === "Error") return true;
  return status.status === "Completed" && status.exitCode !== undefined && status.exitCode !== 0;
}

/**
 * The slice of `config` whose `shutdown.command`s process-compose skipped:
 * the daemons whose launch had failed when the stop began (`statuses`, read
 * before it). `undefined` when there are none.
 */
export function daemonHooksSkipped(
  config: DerivedConfig,
  statuses: ReadonlyArray<ServiceStatus>,
): DerivedConfig | undefined {
  const failed = new Set(statuses.filter(launchFailed).map((s) => s.name));
  const processes = Object.fromEntries(
    Object.entries(config.processes).filter(
      ([name, proc]) => proc.is_daemon === true && failed.has(name) && proc.shutdown !== undefined,
    ),
  );
  if (Object.keys(processes).length === 0) return undefined;
  return { ...config, processes };
}

/**
 * The services whose process group process-compose does not signal on the
 * stop (#155): it runs a `shutdown.command` instead, or `shutdown.parent_only`
 * limits the signal to the service process itself.
 */
export function unsignalledServices(config: DerivedConfig | undefined): Set<string> {
  const names = Object.entries(config?.processes ?? {}).flatMap(([name, proc]) => {
    const shutdown = proc.shutdown;
    const hook = typeof shutdown?.command === "string" && shutdown.command !== "";
    return hook || shutdown?.parent_only === true ? [name] : [];
  });
  return new Set(names);
}

/** Something the instance owned that is still alive after `down`. */
export interface DownSurvivor {
  readonly service: string;
  readonly pid: number | null;
  readonly command: string | null;
  /** Set for a listener found on one of the service's named ports. */
  readonly port_name?: string;
  readonly port?: number;
  /**
   * The holder is a container runtime's port forwarder (OrbStack Helper,
   * `com.docker.backend`, ...): one process serving every instance. Never
   * kill it; stop the container that publishes the port.
   */
  readonly port_forwarder?: boolean;
}

/** Seams for `findPortSurvivors`. */
export interface PortSurvivorSeams {
  /** Does anything accept a connection on the port? */
  readonly accepts: (port: number) => Promise<boolean>;
  /** Who holds the port (best-effort, `lsof`). */
  readonly identify: (port: number) => {
    readonly pid: number | null;
    readonly command: string | null;
  };
  /** How long a port may take to close after the stop. Default: 3s. */
  readonly waitMs?: number;
  /** Poll interval. Default: 200ms. */
  readonly pollMs?: number;
}

const PORT_SETTLE_MS = 3_000;
const PORT_POLL_MS = 200;

/**
 * The named ports of `services` (the ones the instance had booted) that
 * still accept connections once a short settle window has passed, each with
 * its holder. Unbooted services are left out: their ports were never this
 * instance's.
 */
export async function findPortSurvivors(
  config: DerivedConfig,
  services: ReadonlyArray<string>,
  seams: PortSurvivorSeams,
): Promise<DownSurvivor[]> {
  const byService = config[DEVTREES_METADATA_KEY]?.ports_by_service ?? {};
  let open = services.flatMap((service) =>
    Object.entries(byService[service] ?? {}).map(([portName, port]) => ({
      service,
      portName,
      port,
    })),
  );
  const deadline = Date.now() + (seams.waitMs ?? PORT_SETTLE_MS);
  for (;;) {
    const checks = await Promise.all(open.map((p) => seams.accepts(p.port)));
    open = open.filter((_, i) => checks[i] === true);
    if (open.length === 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, seams.pollMs ?? PORT_POLL_MS));
  }
  return open.map((p) => {
    const holder = seams.identify(p.port);
    return {
      service: p.service,
      ...holder,
      port_name: p.portName,
      port: p.port,
      port_forwarder: isPortForwarder(holder.command),
    };
  });
}

/** A process from the stop's sweep that survived its SIGKILL, as a survivor row. */
export function processSurvivor(proc: ServiceProcess): DownSurvivor {
  return { service: proc.service, pid: proc.pid, command: proc.command };
}

// ---------------------------------------------------------------------------
// The marker a `DOWN_INCOMPLETE` leaves for the next `down`.
// ---------------------------------------------------------------------------

function markerFile(anchor: string, worktreeId: string): string {
  return join(stateDir(anchor), `${worktreeId}.down-incomplete.json`);
}

/** Record which services the instance had booted, for the next `down` to re-check. */
export function writeDownIncomplete(
  anchor: string,
  worktreeId: string,
  services: ReadonlyArray<string>,
): void {
  writeServicesMarker(markerFile(anchor, worktreeId), services);
}

/** The services an earlier `DOWN_INCOMPLETE` recorded, or `undefined` when none did. */
export function readDownIncomplete(anchor: string, worktreeId: string): string[] | undefined {
  return readServicesMarker(markerFile(anchor, worktreeId));
}

/** Write a `{services}` re-check marker (`down`'s here, `stop`'s in src/stop-services.ts). */
export function writeServicesMarker(file: string, services: ReadonlyArray<string>): void {
  writeAtomic(file, `${JSON.stringify({ services }, null, 2)}\n`);
}

/**
 * The services a `{services}` re-check marker lists: `undefined` when there
 * is none, `[]` when it is unreadable.
 */
export function readServicesMarker(file: string): string[] | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { services?: unknown } | null;
    const services = parsed?.services;
    return Array.isArray(services) ? services.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Remove the marker. No-op when absent. */
export function clearDownIncomplete(anchor: string, worktreeId: string): void {
  rmSync(markerFile(anchor, worktreeId), { force: true });
}

// ---------------------------------------------------------------------------
// The error.
// ---------------------------------------------------------------------------

/** The `details` a `DOWN_INCOMPLETE` carries. */
interface DownIncompleteDetails {
  readonly instance: string;
  readonly survivors: ReadonlyArray<DownSurvivor>;
  readonly force_killed: ReadonlyArray<ForceKilled>;
  /** Shutdown hooks devtrees ran this time that failed (launch, exit or timeout). */
  readonly hook_failures?: ReadonlyArray<HookFailure>;
  readonly remedy: string;
}

/**
 * Raised when `down` stopped (or found stopped) the instance's
 * process-compose but something the instance owned is still alive (#155).
 * Unlike `DOWN_TIMEOUT`, the stop itself finished: the socket is gone, the
 * derived config and the port block are kept, and a marker records what to
 * re-check, so a retried `down` runs every shutdown hook directly and checks
 * the same ports again.
 */
class DownIncompleteError extends Error {
  readonly code = "DOWN_INCOMPLETE" as const;
  readonly details: DownIncompleteDetails;
  constructor(
    instance: string,
    survivors: ReadonlyArray<DownSurvivor>,
    forceKilled: ReadonlyArray<ForceKilled>,
    hookFailures: ReadonlyArray<HookFailure>,
  ) {
    const remedy = downIncompleteRemedy(survivors);
    const hooks = hookFailures.map(
      (f) =>
        `\n  shutdown hook of ${f.process} failed (${f.reason}${f.message ? `: ${f.message}` : ""})`,
    );
    super(
      `devtrees down: the '${instance}' instance stopped, but some of what it started is ` +
        `still alive:\n${survivors.map(describeSurvivor).join("\n")}${hooks.join("")}\n${remedy}`,
    );
    this.name = "DownIncompleteError";
    this.details = {
      instance,
      survivors,
      force_killed: forceKilled,
      ...(hookFailures.length > 0 ? { hook_failures: hookFailures } : {}),
      remedy,
    };
  }
}

/** The `DOWN_INCOMPLETE` error for `instance`'s survivors (#155). */
export function downIncomplete(
  instance: string,
  survivors: ReadonlyArray<DownSurvivor>,
  forceKilled: ReadonlyArray<ForceKilled>,
  hookFailures: ReadonlyArray<HookFailure> = [],
): Error {
  return new DownIncompleteError(instance, survivors, forceKilled, hookFailures);
}

/** `  app-db APP_DB_PORT 59073: pid 60274 (OrbStack Helper) accepts connections`. */
export function describeSurvivor(s: DownSurvivor): string {
  if (s.port === undefined && s.pid === null) {
    return `  ${s.service}: process-compose still reports it running`;
  }
  const who =
    s.pid === null
      ? `holder not identified (try \`lsof -nP -iTCP:${s.port ?? ""}\`)`
      : `pid ${s.pid} (${s.command ?? "unknown command"})`;
  if (s.port === undefined) return `  ${s.service}: ${who} survived SIGKILL`;
  const label = s.port_forwarder === true ? ` — ${forwarderLabel(s.port)}` : "";
  return `  ${s.service} ${s.port_name ?? ""} ${s.port}: ${who} still accepts connections${label}`;
}

function downIncompleteRemedy(survivors: ReadonlyArray<DownSurvivor>): string {
  const forwarded = survivors.some((s) => s.port_forwarder === true);
  return (
    "Run `devtrees down` again: with process-compose gone it runs every shutdown hook " +
    "itself, then checks these ports again, and succeeds once they are free. If it fails " +
    "the same way, stop what is listed by hand and retry. " +
    (forwarded
      ? "A port held by a container runtime's port forwarder means a container still " +
        "publishes it: stop that container, never the forwarder."
      : "Never kill a container runtime's port forwarder: stop the container instead.")
  );
}
