/**
 * The in-memory process-compose: a second adapter of the `Driver` interface
 * (src/driver.ts), for tests.
 *
 * It models process-compose v1.122.0 itself, not devtrees: a server per
 * control socket, holding a process table it boots from the config file at
 * `inst.configPath`, filtered by the selected namespaces. It answers the
 * Driver's operations the way the binary does, and reports rows in the JSON
 * shape `process list -o json` prints, read back through the real driver's
 * own parser (`parseServiceStatuses`). It knows nothing of tiers,
 * classification or selection: those are devtrees' rules, and the commands
 * under test apply them.
 *
 * What it models:
 *  - `up` binds the control socket (an empty file at `inst.socketPath`) and
 *    starts every selected process `Running` with a fresh pid. A process with
 *    no `namespace` is in `default`; a list-valued one is selected when any
 *    entry is; no selection boots every namespace.
 *  - `process stop` leaves a process `Completed`, `exit_code -1`, not
 *    running, keeping its pid and its last probe verdict (process-compose
 *    keeps a stale `Ready`, #174). It refuses a process that is not running.
 *  - `process start` starts a process that is not running with a new pid; one
 *    that is running is refused as "already running".
 *  - process-compose exits once nothing runs ("Project completed",
 *    ADR-0009): when no process is running, pending or in a restart backoff,
 *    the server exits and removes its socket.
 *  - the config reload re-reads the file and applies the difference: added
 *    processes start, removed ones are dropped, changed ones restart with a
 *    new pid, unchanged ones are left as they are (stopped ones too, #239).
 *  - `down` stops everything and removes the socket.
 *
 * Not modelled: `depends_on` ordering (a dependent starts with everything
 * else; `hold` puts a process in `Pending`, and `idle` puts it in `Skipped`
 * or `Disabled`, which a `process start` then starts, as the binary does
 * once a skipped process's dependency has recovered, #263), restart policies
 * (`backoff` puts a process in its restart backoff), and probe timing (a
 * probed process is `Ready` at once; `setReady` changes the verdict).
 *
 * Tests drive what happens to processes with the event methods (`exit`,
 * `hold`, `idle`, `backoff`, `setReady`, `crash`, `freeze`, `refuse`, `log`) and
 * assert on state (`rows`, `isUp`), never on argv.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  assertSupportedVersionOutput,
  parseServiceStatuses,
  type DownOutcome,
  type Driver,
  type InstanceRef,
  type LogEvent,
  type ReloadResult,
  type ServiceStatus,
  type StartResult,
  type StopRequestResult,
  type StreamLogsOptions,
} from "./driver.js";
import type { InstanceStatus } from "./instances.js";

/** One request an in-memory instance received, in the order it arrived. */
export interface PcRequest {
  readonly op: "up" | "down" | "attach" | "list" | "start" | "stop" | "logs" | "reload";
  readonly socketPath: string;
  /** The processes a `start`, `stop` or `logs` request named. */
  readonly services?: ReadonlyArray<string>;
  /** The namespaces an `up` selected. */
  readonly namespaces?: ReadonlyArray<string>;
}

export interface InMemoryProcessComposeOptions {
  /** The version `assertSupportedVersion` sees. Default: `1.122.0`. */
  readonly version?: string;
  /** The first pid handed out; each new run takes the next. Default: 1000. */
  readonly firstPid?: number;
  /** Told about every request, as it arrives. */
  readonly onRequest?: (request: PcRequest) => void;
}

/** The in-memory process-compose: its `Driver`, plus the events and reads tests use. */
export interface InMemoryProcessCompose {
  /** The `Driver` to inject (`CommandDeps.processCompose`). */
  readonly driver: Driver;
  /** Every request the instances received, oldest first. */
  readonly requests: ReadonlyArray<PcRequest>;
  /**
   * A `probeSocket` that answers from the model: `running` while a server
   * holds the socket (a frozen one still accepts connections), else `stale`.
   */
  probeSocket(socketPath: string): Promise<InstanceStatus>;
  /** Whether a server is running on `socketPath` (frozen counts). */
  isUp(socketPath: string): boolean;
  /** The rows `process list` would report now, parsed. Throws when no server runs. */
  rows(socketPath: string): ServiceStatus[];
  /** The process's current pid, if it has one. */
  pidOf(socketPath: string, name: string): number | undefined;
  /** The process exits on its own with `exitCode` (`-1` for a signal, `0` for a finished one-shot). */
  exit(socketPath: string, name: string, exitCode: number): void;
  /** The process waits on its dependencies: `Pending`, no pid. */
  hold(socketPath: string, name: string): void;
  /**
   * The process holds no run and waits on nothing: `Skipped` (a dependency
   * failed: exit 1) or `Disabled` (exit 0), no pid, not running, as
   * process-compose v1.122.0 reports them (#263).
   */
  idle(socketPath: string, name: string, status: "Skipped" | "Disabled"): void;
  /** The process died and waits out its restart backoff: `Restarting`, not running, old pid. */
  backoff(socketPath: string, name: string): void;
  /** The probe verdict of a probed process. */
  setReady(socketPath: string, name: string, ready: boolean): void;
  /** The server dies without cleaning up (kill -9): its socket file stays behind, nothing answers. */
  crash(socketPath: string): void;
  /** The server stops answering (SIGSTOP): connections are accepted, requests never complete. */
  freeze(socketPath: string): void;
  /** process-compose refuses every later `op` of `name`, logging `message`. */
  refuse(op: "start" | "stop", name: string, message?: string): void;
  /** The process writes `line` to its log. */
  log(socketPath: string, name: string, line: string): void;
}

/** process-compose's own JSON row for one process (`process list -o json`). */
interface Proc {
  readonly name: string;
  /** The process's definition, as the config file declares it. */
  definition: Record<string, unknown>;
  status: string;
  pid: number;
  exitCode: number;
  running: boolean;
  /** `Ready` / `Not Ready` for a probed process; `-` for an unprobed one. */
  isReady: string;
  logs: string[];
}

interface Server {
  readonly inst: InstanceRef;
  readonly namespaces: ReadonlyArray<string>;
  readonly procs: Map<string, Proc>;
  frozen: boolean;
  /** Wakes `streamLogs` followers when a line is logged or the server goes away. */
  readonly listeners: Set<() => void>;
}

const BINARY = "process-compose";

export function createInMemoryProcessCompose(
  opts: InMemoryProcessComposeOptions = {},
): InMemoryProcessCompose {
  const servers = new Map<string, Server>();
  /** Sockets whose server died without removing the file. */
  const crashed = new Set<string>();
  const refusals = new Map<string, string>();
  const requests: PcRequest[] = [];
  let nextPid = opts.firstPid ?? 1000;

  function record(request: PcRequest): void {
    requests.push(request);
    opts.onRequest?.(request);
  }

  function readConfig(configPath: string): Record<string, Record<string, unknown>> {
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as {
      processes?: Record<string, Record<string, unknown>>;
    } | null;
    return parsed?.processes ?? {};
  }

  function startRun(proc: Proc): void {
    proc.status = "Running";
    proc.pid = nextPid++;
    proc.exitCode = 0;
    proc.running = true;
    proc.isReady = probed(proc.definition) ? "Ready" : "-";
  }

  function newProc(name: string, definition: Record<string, unknown>): Proc {
    const proc: Proc = {
      name,
      definition,
      status: "Running",
      pid: 0,
      exitCode: 0,
      running: true,
      isReady: "-",
      logs: [],
    };
    startRun(proc);
    return proc;
  }

  function server(socketPath: string): Server | undefined {
    return servers.get(socketPath);
  }

  function proc(socketPath: string, name: string): Proc {
    const found = server(socketPath)?.procs.get(name);
    if (found === undefined) throw new Error(`no process '${name}' on ${socketPath}`);
    return found;
  }

  /** The server goes away. A graceful exit removes its socket; a crash leaves it. */
  function stopServer(srv: Server, how: { readonly removeSocket: boolean }): void {
    servers.delete(srv.inst.socketPath);
    if (how.removeSocket) rmSync(srv.inst.socketPath, { force: true });
    else crashed.add(srv.inst.socketPath);
    for (const wake of srv.listeners) wake();
  }

  /** process-compose exits once nothing runs, waits or backs off (ADR-0009). */
  function exitIfIdle(srv: Server): void {
    const alive = [...srv.procs.values()].some(
      (p) => p.running || p.status === "Pending" || p.status === "Restarting",
    );
    if (!alive) stopServer(srv, { removeSocket: true });
  }

  function toRow(p: Proc): Record<string, unknown> {
    return {
      name: p.name,
      namespace: p.definition.namespace ?? "default",
      status: p.status,
      is_ready: p.isReady,
      exit_code: p.exitCode,
      pid: p.pid,
      is_running: p.running,
    };
  }

  function rows(socketPath: string): ServiceStatus[] {
    const srv = server(socketPath);
    if (srv === undefined) throw new Error(`${BINARY} process list exited with code 1`);
    return parseServiceStatuses(JSON.stringify([...srv.procs.values()].map(toRow)));
  }

  /** The server on `socketPath` when it answers; `undefined` when there is none. */
  function answering(socketPath: string): Server | "frozen" | undefined {
    const srv = server(socketPath);
    if (srv === undefined) return undefined;
    return srv.frozen ? "frozen" : srv;
  }

  const noServer = (socketPath: string) =>
    `dial unix ${socketPath}: connect: no such file or directory`;

  const driver: Driver = {
    async up(inst, namespaces = []) {
      record({ op: "up", socketPath: inst.socketPath, namespaces: [...namespaces] });
      // A second server cannot bind a socket that is in use.
      if (servers.has(inst.socketPath)) return;
      const procs = new Map<string, Proc>();
      for (const [name, definition] of Object.entries(readConfig(inst.configPath))) {
        if (selected(definition, namespaces)) procs.set(name, newProc(name, definition));
      }
      mkdirSync(dirname(inst.socketPath), { recursive: true });
      writeFileSync(inst.socketPath, "");
      crashed.delete(inst.socketPath);
      servers.set(inst.socketPath, {
        inst,
        namespaces: [...namespaces],
        procs,
        frozen: false,
        listeners: new Set(),
      });
    },

    async assertSupportedVersion() {
      assertSupportedVersionOutput(opts.version ?? "v1.122.0");
    },

    async down(inst): Promise<DownOutcome> {
      record({ op: "down", socketPath: inst.socketPath });
      const srv = answering(inst.socketPath);
      if (srv === undefined) throw new Error(`${BINARY} down exited with code 1`);
      if (srv === "frozen") return { stopped: false, reason: "timeout" };
      stopServer(srv, { removeSocket: true });
      return { stopped: true };
    },

    async attach(inst) {
      record({ op: "attach", socketPath: inst.socketPath });
      if (answering(inst.socketPath) === undefined) {
        throw new Error(`${BINARY} attach exited with code 1`);
      }
    },

    async getServiceStatuses(socketPath, readOpts = {}) {
      record({ op: "list", socketPath });
      const srv = answering(socketPath);
      if (srv === "frozen") {
        const ms = readOpts.timeoutMs ?? 5_000;
        throw new Error(`${BINARY} process list did not answer within ${Math.round(ms / 1000)}s`);
      }
      return rows(socketPath);
    },

    async startProcess(socketPath, service): Promise<StartResult> {
      record({ op: "start", socketPath, services: [service] });
      const srv = answering(socketPath);
      if (srv === undefined) return { ok: false, message: noServer(socketPath) };
      if (srv === "frozen") {
        return {
          ok: false,
          message: `${BINARY} process start did not finish within 10s`,
          timedOut: true,
        };
      }
      const refused = refusals.get(`start ${service}`);
      if (refused !== undefined) return { ok: false, message: refused };
      const p = srv.procs.get(service);
      if (p === undefined) {
        return {
          ok: false,
          message: `FTL failed to start process ${service} error="no such process: ${service}"`,
        };
      }
      if (p.running) return { ok: true, alreadyRunning: true };
      startRun(p);
      return { ok: true, alreadyRunning: false };
    },

    async stopProcesses(socketPath, services): Promise<StopRequestResult> {
      record({ op: "stop", socketPath, services: [...services] });
      const srv = answering(socketPath);
      if (srv === undefined) return { ok: false, message: noServer(socketPath) };
      if (srv === "frozen") {
        return { ok: false, message: `${BINARY} process stop did not answer within 10s` };
      }
      for (const name of services) {
        const refused = refusals.get(`stop ${name}`);
        if (refused !== undefined) return { ok: false, message: refused };
        if (srv.procs.get(name)?.running !== true) {
          return { ok: false, message: `Failed to stop process ${name}` };
        }
      }
      for (const name of services) {
        const p = proc(socketPath, name);
        p.status = "Completed";
        p.exitCode = -1;
        p.running = false;
      }
      exitIfIdle(srv);
      return { ok: true };
    },

    streamLogs(socketPath, logOpts): AsyncIterable<LogEvent> {
      record({ op: "logs", socketPath, services: [logOpts.service] });
      return streamLogs(socketPath, logOpts);
    },

    async reloadConfig(inst): Promise<ReloadResult> {
      record({ op: "reload", socketPath: inst.socketPath });
      const srv = answering(inst.socketPath);
      if (srv === undefined) {
        return { ok: false, reason: "error", message: `connect ENOENT ${inst.socketPath}` };
      }
      if (srv === "frozen") {
        return {
          ok: false,
          reason: "timeout",
          message: "process-compose config reload did not finish within 30s",
        };
      }
      let config: Record<string, Record<string, unknown>>;
      try {
        config = readConfig(inst.configPath);
      } catch (err) {
        return {
          ok: false,
          reason: "error",
          message: `process-compose config reload answered HTTP 400: ${(err as Error).message}`,
        };
      }
      applyConfig(srv, config);
      exitIfIdle(srv);
      return { ok: true };
    },
  };

  /**
   * Apply a re-read config the way process-compose's reload does: drop what
   * is gone or no longer selected, start what is new, restart what changed,
   * and leave everything else as it is (stopped ones too, #239).
   */
  function applyConfig(srv: Server, config: Record<string, Record<string, unknown>>): void {
    for (const name of srv.procs.keys()) {
      const definition = config[name];
      if (definition === undefined || !selected(definition, srv.namespaces)) srv.procs.delete(name);
    }
    for (const [name, definition] of Object.entries(config)) {
      if (!selected(definition, srv.namespaces)) continue;
      const p = srv.procs.get(name);
      if (p === undefined) srv.procs.set(name, newProc(name, definition));
      else if (!isDeepStrictEqual(p.definition, definition)) {
        p.definition = definition;
        startRun(p);
      }
    }
  }

  /** The server and process `process logs` reads from; throws as the client exits 1 otherwise. */
  function logSource(socketPath: string, service: string): { srv: Server; p: Proc } {
    const srv = answering(socketPath);
    const p = srv === undefined || srv === "frozen" ? undefined : srv.procs.get(service);
    if (srv === undefined || srv === "frozen" || p === undefined) {
      throw new Error(`${BINARY} process logs exited with code 1`);
    }
    return { srv, p };
  }

  /** Resolves when the server logs a line or goes away. */
  function nextEvent(srv: Server): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        srv.listeners.delete(wake);
        resolve();
      };
      srv.listeners.add(wake);
    });
  }

  async function* streamLogs(
    socketPath: string,
    logOpts: StreamLogsOptions,
  ): AsyncGenerator<LogEvent> {
    const { srv, p } = logSource(socketPath, logOpts.service);
    let next = Math.max(0, p.logs.length - (logOpts.tail ?? p.logs.length));
    for (;;) {
      while (next < p.logs.length) {
        const line = p.logs[next++] ?? "";
        yield { ts: new Date().toISOString(), service: logOpts.service, stream: "stdout", line };
      }
      if (logOpts.follow !== true || servers.get(socketPath) !== srv) return;
      await nextEvent(srv);
    }
  }

  return {
    driver,
    requests,
    async probeSocket(socketPath) {
      return servers.has(socketPath) && existsSync(socketPath) ? "running" : "stale";
    },
    isUp: (socketPath) => servers.has(socketPath),
    rows,
    pidOf(socketPath, name) {
      const p = server(socketPath)?.procs.get(name);
      return p === undefined || p.pid === 0 ? undefined : p.pid;
    },
    exit(socketPath, name, exitCode) {
      const p = proc(socketPath, name);
      p.status = "Completed";
      p.exitCode = exitCode;
      p.running = false;
      const srv = server(socketPath);
      if (srv !== undefined) exitIfIdle(srv);
    },
    hold(socketPath, name) {
      const p = proc(socketPath, name);
      p.status = "Pending";
      p.pid = 0;
      p.running = false;
    },
    idle(socketPath, name, status) {
      const p = proc(socketPath, name);
      p.status = status;
      p.exitCode = status === "Skipped" ? 1 : 0;
      p.pid = 0;
      p.running = false;
      const srv = server(socketPath);
      if (srv !== undefined) exitIfIdle(srv);
    },
    backoff(socketPath, name) {
      const p = proc(socketPath, name);
      p.status = "Restarting";
      p.running = false;
    },
    setReady(socketPath, name, ready) {
      proc(socketPath, name).isReady = ready ? "Ready" : "Not Ready";
    },
    crash(socketPath) {
      const srv = server(socketPath);
      if (srv !== undefined) stopServer(srv, { removeSocket: false });
    },
    freeze(socketPath) {
      const srv = server(socketPath);
      if (srv !== undefined) srv.frozen = true;
    },
    refuse(op, name, message) {
      refusals.set(`${op} ${name}`, message ?? `FTL failed to ${op} process ${name}`);
    },
    log(socketPath, name, line) {
      proc(socketPath, name).logs.push(line);
      for (const wake of server(socketPath)?.listeners ?? []) wake();
    },
  };
}

/** Whether a process declares a readiness probe. */
function probed(definition: Record<string, unknown>): boolean {
  return definition.readiness_probe !== undefined;
}

/**
 * process-compose's namespace selection (#128): no selection boots every
 * namespace; a process with no `namespace` is in `default`; a list-valued
 * one is selected when any entry is.
 */
function selected(definition: Record<string, unknown>, namespaces: ReadonlyArray<string>): boolean {
  if (namespaces.length === 0) return true;
  const raw = definition.namespace ?? "default";
  const own = Array.isArray(raw) ? raw : [raw];
  return own.some((ns) => typeof ns === "string" && namespaces.includes(ns));
}
