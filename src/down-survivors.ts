/**
 * What a worktree `down` checks after process-compose has stopped (#155).
 *
 * `process-compose down` exiting 0 does not mean everything the instance
 * started is gone:
 *
 *  - process-compose runs a `shutdown.command` only for a process it still
 *    considers running. A daemon (`is_daemon: true`) whose launch exited
 *    non-zero is `Completed`, so its hook is skipped, although the launch may
 *    well have started containers before it failed (a `supabase start` that
 *    times out on a health check). `daemonHooksSkipped` picks those hooks so
 *    `down` runs them itself, as the dead-supervisor reap does (#148).
 *  - A listener can outlive the stop: a container whose hook was skipped or
 *    killed at its `shutdown.timeout_seconds`, or a process outside every
 *    service's process tree. `findPortSurvivors` connects to each port the
 *    booted services declare; one that still accepts is a survivor.
 *
 * A survivor fails `down` with `DOWN_INCOMPLETE` instead of the old
 * "worktree instance stopped" and exit 0: the instance's socket is gone, so
 * nothing else would ever point at what it left behind.
 */

import type { ForceKilled, ServiceProcess } from "./bounded-down.js";
import { DEVTREES_METADATA_KEY, type DerivedConfig } from "./deriver.js";
import { forwarderLabel, isPortForwarder } from "./port-connect.js";
import type { ServiceStatus } from "./driver.js";

/** process-compose statuses of a process that ran and has exited. */
const EXITED_STATUSES: ReadonlySet<string> = new Set(["Completed", "Error"]);

/**
 * The slice of `config` whose `shutdown.command`s process-compose skipped:
 * the daemons whose launch had already exited when the stop began
 * (`statuses`, read before it). `undefined` when there are none.
 */
export function daemonHooksSkipped(
  config: DerivedConfig,
  statuses: ReadonlyArray<ServiceStatus>,
): DerivedConfig | undefined {
  const exited = new Set(statuses.filter((s) => EXITED_STATUSES.has(s.status)).map((s) => s.name));
  const processes = Object.fromEntries(
    Object.entries(config.processes).filter(
      ([name, proc]) => proc.is_daemon === true && exited.has(name) && proc.shutdown !== undefined,
    ),
  );
  if (Object.keys(processes).length === 0) return undefined;
  return { ...config, processes };
}

/** Something the instance owned that is still alive after `down`. */
export interface DownSurvivor {
  readonly service: string;
  readonly pid: number | null;
  readonly command: string | null;
  /** Set for a listener found on one of the service's named ports. */
  readonly port_name?: string;
  readonly port?: number;
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
 * The named ports of the services the instance had booted (those in the
 * pre-stop `process list`) that still accept connections once a short
 * settle window has passed, each with its holder. Unbooted services are
 * left out: their ports were never this instance's.
 */
export async function findPortSurvivors(
  config: DerivedConfig,
  statuses: ReadonlyArray<ServiceStatus>,
  seams: PortSurvivorSeams,
): Promise<DownSurvivor[]> {
  const byService = config[DEVTREES_METADATA_KEY]?.ports_by_service ?? {};
  let open = statuses.flatMap((s) =>
    Object.entries(byService[s.name] ?? {}).map(([portName, port]) => ({
      service: s.name,
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
  return open.map((p) => ({
    service: p.service,
    ...seams.identify(p.port),
    port_name: p.portName,
    port: p.port,
  }));
}

/** A process from the stop's tree sweep that survived its SIGKILL, as a survivor row. */
export function processSurvivor(proc: ServiceProcess): DownSurvivor {
  return { service: proc.service, pid: proc.pid, command: proc.command };
}

/** The `details` a `DOWN_INCOMPLETE` carries. */
interface DownIncompleteDetails {
  readonly instance: string;
  readonly survivors: ReadonlyArray<DownSurvivor>;
  readonly force_killed: ReadonlyArray<ForceKilled>;
  readonly remedy: string;
}

/**
 * Raised when `down` stopped the instance's process-compose but something
 * the instance owned is still alive (#155). Unlike `DOWN_TIMEOUT`, the stop
 * itself finished: the socket is gone, the derived config and the port
 * block are kept, so a retried `down` runs every shutdown hook directly.
 */
class DownIncompleteError extends Error {
  readonly code = "DOWN_INCOMPLETE" as const;
  readonly details: DownIncompleteDetails;
  constructor(
    instance: string,
    survivors: ReadonlyArray<DownSurvivor>,
    forceKilled: ReadonlyArray<ForceKilled>,
  ) {
    const remedy = downIncompleteRemedy(survivors);
    super(
      `devtrees down: the '${instance}' instance stopped, but some of what it started is ` +
        `still alive:\n${survivors.map(describeSurvivor).join("\n")}\n${remedy}`,
    );
    this.name = "DownIncompleteError";
    this.details = { instance, survivors, force_killed: forceKilled, remedy };
  }
}

/** The `DOWN_INCOMPLETE` error for `instance`'s survivors (#155). */
export function downIncomplete(
  instance: string,
  survivors: ReadonlyArray<DownSurvivor>,
  forceKilled: ReadonlyArray<ForceKilled>,
): Error {
  return new DownIncompleteError(instance, survivors, forceKilled);
}

/** `  app-db APP_DB_PORT 59073: pid 60274 (OrbStack Helper) accepts connections`. */
function describeSurvivor(s: DownSurvivor): string {
  const who =
    s.pid === null
      ? `holder not identified (try \`lsof -nP -iTCP:${s.port ?? ""}\`)`
      : `pid ${s.pid} (${s.command ?? "unknown command"})`;
  if (s.port === undefined) return `  ${s.service}: ${who} survived SIGKILL`;
  const label = isPortForwarder(s.command) ? ` — ${forwarderLabel(s.port)}` : "";
  return `  ${s.service} ${s.port_name ?? ""} ${s.port}: ${who} still accepts connections${label}`;
}

function downIncompleteRemedy(survivors: ReadonlyArray<DownSurvivor>): string {
  const forwarded = survivors.some((s) => s.port !== undefined && isPortForwarder(s.command));
  return (
    "Run `devtrees down` again: with process-compose gone it runs every shutdown hook " +
    "itself. Then stop whatever is still listed by hand before `devtrees up`" +
    (forwarded ? ", stopping the container behind a port forwarder, never the forwarder." : ".")
  );
}
