#!/usr/bin/env node
/**
 * Stub `process-compose` for devtrees e2e smoke tests.
 *
 * Stands in for the real binary (which CI does not install) and emulates just
 * enough of its contract to prove `devtrees up → down`:
 *
 *   up   -f <config> -U -u <socket> -t=false
 *        Reads the derived config, runs each process's `command` (with its
 *        `working_dir` and `environment` applied), and creates the control
 *        socket as a liveness marker. Backgrounds itself and returns. The
 *        socket answers `POST /project/configuration` (the hot-reload,
 *        issue #194) by re-reading the `-f` config, like the real server.
 *   down -U -u <socket>
 *        Signals the running instance to stop and removes the control socket.
 *   process start <name> -U -u <socket>
 *        Records <name> as restarted, so `process list` reports it running
 *        again (issue #178). See the `process list` notes for the env knobs.
 *   version
 *        Prints a version (`$STUB_PC_VERSION`, default v1.122.0; `--short`
 *        prints it bare) so the presence and minimum-version probes work.
 *
 * The processes here are expected to be simple shell commands; the e2e uses a
 * tiny HTTP server that binds ${PORT} and writes a relative file, so the test
 * can assert reachability and working-directory isolation.
 *
 * Teardown contract (see #41):
 *   - `up` writes `<socket>.parent-pid` so `down` (and any external reaper)
 *     can find the long-lived parent.
 *   - The `up` parent traps SIGTERM/SIGINT/exit and synchronously kills its
 *     spawned children before exiting, regardless of whether they were
 *     spawned `detached`. This is the only thing that prevents detached
 *     children from being reparented to PID 1 and outliving the suite.
 *   - `down` signals the parent (its trap does the work) and waits for it
 *     to exit, so callers observe a fully reaped state.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Faithfully model how the real process-compose launches a process's
 * `shutdown.command` on a graceful `down` (#148): it `chdir`s into the
 * process's `working_dir` FIRST, then runs the hook through the shell with the
 * process's `environment:` applied. Critically, if that `working_dir` no longer
 * exists (e.g. `git worktree remove` deleted it), the `chdir` fails and
 * process-compose **silently skips the hook** — it logs the chdir error at ERR
 * and still exits 0. We reproduce that exactly: `spawnSync` with a non-existent
 * `cwd` errors, and we swallow it. This is the leak the devtrees fix works
 * around by running the hook itself from a cwd that exists.
 */
function envFromLines(lines) {
  const env = { ...process.env };
  for (const entry of lines ?? []) {
    const eq = entry.indexOf("=");
    if (eq !== -1) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function runShutdownHooks(config) {
  for (const proc of Object.values(config?.processes ?? {})) {
    const command = proc?.shutdown?.command;
    if (typeof command !== "string" || command === "") continue;
    // cwd = the process's working_dir, exactly like process-compose. If it's
    // gone, spawnSync reports an error in `.error` and the hook never runs
    // (the real binary swallows it and still exits 0). We ignore the outcome.
    spawnSync("/bin/sh", ["-c", command], {
      cwd: proc.working_dir,
      env: envFromLines(proc.environment),
      stdio: "ignore",
    });
  }
}

function flag(name, short) {
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name || argv[i] === short) return argv[i + 1];
  }
  return undefined;
}

/** Collect every value of a repeatable flag (e.g. `-n a -n b`) into an array. */
function flagAll(name, short) {
  const argv = process.argv.slice(3);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name || argv[i] === short) {
      const v = argv[i + 1];
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

/**
 * process-compose's namespace model (issue #128): a process with no
 * `namespace` is in the implicit `default` namespace. `-n` selects a subset;
 * an empty selection means all namespaces. A list-valued `namespace` (#179,
 * v1.122.0+) is selected when ANY of its entries is.
 */
function selectedByNamespace(proc, namespaces) {
  if (namespaces.length === 0) return true;
  return namespacesOf(proc).some((ns) => namespaces.includes(ns));
}

/** A process's namespaces as a list — `default` when it declares none. */
function namespacesOf(proc) {
  const ns = proc?.namespace ?? "default";
  return Array.isArray(ns) ? ns : [ns];
}

/**
 * The `namespace` field `process list -o json` reports (#179): v1.122.0 echoes
 * the authored shape — a string, or a list for a service in several.
 */
function reportedNamespace(proc) {
  return proc?.namespace ?? "default";
}

function killChild(pid) {
  // detached children are process-group leaders; -pid kills the group.
  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    // group already gone or never existed — fall through.
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

const cmd = process.argv[2];

if (cmd === "version") {
  // Reported version is configurable so the too-old path is testable (#173).
  const version = process.env.STUB_PC_VERSION ?? "v1.122.0";
  process.stdout.write(
    process.argv.includes("--short") || process.argv.includes("-s")
      ? `${version}\n`
      : `Process Compose\nVersion:        ${version}\n`,
  );
  process.exit(0);
}

const socketPath = flag("--unix-socket", "-u");

if (cmd === "up") {
  const configPath = flag("-f", "-f");
  const config = parseYaml(readFileSync(configPath, "utf8"));
  // Namespace selection (#128): `-n/--namespace` is repeatable; an empty
  // selection starts every namespace (process-compose's default). Only the
  // selected subset is spawned, and `process list` reports only that subset.
  const namespaces = flagAll("--namespace", "-n");
  const pids = [];

  // Synchronous reaper: kills every recorded child. Safe to call from
  // signal handlers and the `exit` event (which only runs sync code).
  let reaped = false;
  function reapAndCleanup() {
    if (reaped) return;
    reaped = true;
    // Graceful-shutdown contract (#134/#148): process-compose runs each
    // process's `shutdown.command` from its `working_dir` BEFORE killing it.
    // We model that — including the real binary's silent skip when the
    // `working_dir` is gone (the #148 leak). The parent holds the original
    // config from `up` time in memory, exactly as the real supervisor does.
    runShutdownHooks(config);
    for (const pid of pids) killChild(pid);
    try {
      rmSync(`${socketPath}.pids`, { force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(`${socketPath}.parent-pid`, { force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(`${socketPath}.config`, { force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(`${socketPath}.namespaces`, { force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(`${socketPath}.started`, { force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // ignore
    }
  }

  // Signal-driven teardown — `down` SIGTERMs us; vitest may SIGINT us.
  process.on("SIGTERM", () => {
    reapAndCleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    reapAndCleanup();
    process.exit(0);
  });
  // Belt-and-suspenders for natural exit. SIGKILL bypasses this (unblockable),
  // which is why `down` prefers SIGTERM.
  process.on("exit", () => {
    reapAndCleanup();
  });

  // The control socket doubles as the liveness marker and a record of child pids.
  // Spawn children only AFTER the UDS is bound — otherwise a fast TCP probe in
  // a child can become observable before discovery can find this instance via
  // its socket on disk, and `runLs` races the bind.
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/project/configuration") {
      // Hot-reload: persist the re-read config alongside the socket so a
      // follow-up `process list` reflects the new service set.
      writeFileSync(`${socketPath}.config`, readFileSync(configPath, "utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(socketPath, () => {
    for (const proc of Object.values(config.processes ?? {})) {
      if (!selectedByNamespace(proc, namespaces)) continue;
      const env = envFromLines(proc.environment);
      const child = spawn("/bin/sh", ["-c", proc.command], {
        cwd: proc.working_dir,
        env,
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      pids.push(child.pid);
    }
    writeFileSync(`${socketPath}.pids`, JSON.stringify(pids));
    // Remember the derived config alongside the socket so `process list` can
    // recover the service set without re-resolving the original path.
    writeFileSync(`${socketPath}.config`, readFileSync(configPath, "utf8"));
    // Persist the namespace selection (#128) so `process list` reports only the
    // subset this `up` actually started — the real binary lists running
    // processes, not the whole config.
    writeFileSync(`${socketPath}.namespaces`, JSON.stringify(namespaces));
    writeFileSync(`${socketPath}.parent-pid`, String(process.pid));
    server.unref();
  });
  // Stay alive holding the socket; `down` will terminate us.
  setInterval(() => {}, 1 << 30);
} else if (cmd === "attach") {
  // The real `process-compose attach` opens an interactive TUI bound to the
  // instance's UDS. For the e2e we just need observable evidence the call
  // reached the right socket and then exit cleanly so the driver's
  // `attach` promise resolves. We touch a sibling marker file at
  // `<socket>.attached`; the test asserts the marker exists.
  if (existsSync(socketPath)) {
    writeFileSync(`${socketPath}.attached`, "");
    process.exit(0);
  } else {
    // Mirror the real binary's behaviour: a missing socket is an error. The
    // devtrees command layer should refuse to call us in this state, so seeing
    // this in the e2e logs would indicate a bug.
    process.stderr.write(`stub-process-compose: no instance at ${socketPath}\n`);
    process.exit(1);
  }
} else if (cmd === "process") {
  const sub = process.argv[3];
  if (sub === "logs") {
    // `process logs <service> -U -u <socket> --raw-log [-f] [-n N]`
    const service = process.argv[4];
    // The fixture file the integration test seeds:
    // `${socketPath}.<service>.log` — one line per log entry.
    const logPath = `${socketPath}.${service}.log`;
    if (!existsSync(logPath)) {
      process.exit(0);
    }
    const lines = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l !== "");
    // Honor -n N (tail) before emitting.
    const ni = process.argv.indexOf("-n");
    if (ni > -1) {
      const n = Number(process.argv[ni + 1]);
      if (Number.isFinite(n) && n >= 0) lines.splice(0, Math.max(0, lines.length - n));
    }
    for (const line of lines) process.stdout.write(`${line}\n`);
    process.exit(0);
  }
  if (sub === "list") {
    // `process list -U -u <socket> -o json` — devtrees driver reads each
    // running instance's per-service runtime state from here. The stub
    // recovers the service set from the derived config the matching `up` call
    // wrote to disk, alongside the pids file (under <socket>.config).
    //
    // Readiness mirrors the real binary's reporting (issue #108): a service's
    // `status` stays "Running" regardless of probes; the probe verdict lives
    // in the separate `is_ready` field. Services WITHOUT a `readiness_probe`
    // report `is_ready: "-"` (the driver normalises that to health
    // `unknown`). Services WITH one report "Ready", except:
    //
    //   DEVTREES_STUB_NEVER_READY=1     probed services stay "Not Ready"
    //                                   forever — the Running-but-not-ready
    //                                   state the #108 regression class
    //                                   slipped through.
    //   DEVTREES_STUB_READY_AFTER_MS=n  probed services report "Not Ready"
    //                                   until the instance is n ms old (aged
    //                                   off the `<socket>.config` mtime), then
    //                                   "Ready" — a converging probe.
    //
    //   DEVTREES_STUB_DEAD_PROBED=1     probed services model a process that
    //                                   was killed (issue #174): status
    //                                   "Completed", exit_code -1,
    //                                   is_running false, yet the STALE
    //                                   is_ready "Ready" the real binary keeps
    //                                   reporting. Unprobed services stay
    //                                   Running. Set it on the `ls` call, not
    //                                   `up` (the health wait would not pass).
    const cfgPath = `${socketPath}.config`;
    if (!existsSync(cfgPath)) {
      process.stderr.write(`stub-process-compose: no instance at ${socketPath}\n`);
      process.exit(1);
    }
    const config = parseYaml(readFileSync(cfgPath, "utf8"));
    // Only the namespaces the matching `up` started are "running" (#128); the
    // real binary lists running processes, not the whole config.
    let namespaces = [];
    try {
      namespaces = JSON.parse(readFileSync(`${socketPath}.namespaces`, "utf8"));
    } catch {
      namespaces = [];
    }
    const readyAfterMs = Number(process.env.DEVTREES_STUB_READY_AFTER_MS ?? "0");
    const instanceAgeMs = Date.now() - statSync(cfgPath).mtimeMs;
    const probedReady =
      process.env.DEVTREES_STUB_NEVER_READY !== "1" &&
      (!Number.isFinite(readyAfterMs) || instanceAgeMs >= readyAfterMs);
    //   DEVTREES_STUB_DEAD=a,b          the named services model a killed
    //                                   process (issue #162): "Completed",
    //                                   exit_code -1, is_running false. Any
    //                                   instance, shared or worktree.
    //   DEVTREES_STUB_DONE=a,b          the named services model a finished
    //                                   one-shot: "Completed", exit_code 0.
    //
    // `process start <name>` (issue #178) records the name in
    // `<socket>.started`. A started name no longer reads dead: it reads as a
    // fresh run (pid 2000), Running, with the usual readiness rules — so
    // DEVTREES_STUB_NEVER_READY=1 models a restart that never becomes
    // healthy. Except:
    //
    //   DEVTREES_STUB_DIES_AGAIN=a,b    the named services, once started,
    //                                   read as the restarted run dying:
    //                                   "Completed", exit_code 1, pid 2000.
    //
    // Dead rows carry pid 1000 — the run that died — so the restarted run is
    // told apart by pid, as on the real binary.
    const namesFrom = (v) => new Set((v ?? "").split(",").filter((n) => n !== ""));
    const deadNames = namesFrom(process.env.DEVTREES_STUB_DEAD);
    const doneNames = namesFrom(process.env.DEVTREES_STUB_DONE);
    const diesAgain = namesFrom(process.env.DEVTREES_STUB_DIES_AGAIN);
    let started = new Set();
    try {
      started = new Set(JSON.parse(readFileSync(`${socketPath}.started`, "utf8")));
    } catch {
      started = new Set();
    }
    /** The row of a process modelled as stopped (dead, done, died again), else undefined. */
    const stoppedRow = (name, proc) => {
      const stopped = (exit_code, pid) => ({
        name,
        namespace: reportedNamespace(proc),
        status: "Completed",
        is_ready: "-",
        exit_code,
        pid,
        is_running: false,
      });
      if (started.has(name)) return diesAgain.has(name) ? stopped(1, 2000) : undefined;
      if (deadNames.has(name)) return stopped(-1, 1000);
      if (doneNames.has(name)) return stopped(0, 1000);
      return undefined;
    };
    const procs = Object.entries(config.processes ?? {})
      .filter(([, proc]) => selectedByNamespace(proc, namespaces))
      .map(([name, proc]) => {
        const stopped = stoppedRow(name, proc);
        if (stopped !== undefined) return stopped;
        const probed = proc?.readiness_probe !== undefined;
        if (probed && process.env.DEVTREES_STUB_DEAD_PROBED === "1") {
          return {
            name,
            namespace: reportedNamespace(proc),
            status: "Completed",
            is_ready: "Ready",
            exit_code: -1,
            is_running: false,
          };
        }
        return {
          name,
          namespace: reportedNamespace(proc),
          status: "Running",
          is_ready: !probed ? "-" : probedReady ? "Ready" : "Not Ready",
          is_running: true,
        };
      });
    process.stdout.write(JSON.stringify(procs));
    process.exit(0);
  }
  if (sub === "start") {
    // `process start <name> -U -u <socket>` (issue #178): bring a dead
    // process back. The stub records the name so `process list` reports the
    // restarted run (see above). DEVTREES_STUB_START_FAIL=a,b makes the
    // named starts fail the way the real binary refuses one: a log line on
    // stderr and exit 1.
    const service = process.argv[4];
    if (!existsSync(`${socketPath}.config`)) {
      process.stderr.write(`stub-process-compose: no instance at ${socketPath}\n`);
      process.exit(1);
    }
    const refused = (process.env.DEVTREES_STUB_START_FAIL ?? "").split(",");
    if (refused.includes(service)) {
      process.stderr.write(
        `FTL failed to start process ${service} error="stub refused to start ${service}"\n`,
      );
      process.exit(1);
    }
    let started = [];
    try {
      started = JSON.parse(readFileSync(`${socketPath}.started`, "utf8"));
    } catch {
      started = [];
    }
    if (!started.includes(service)) started.push(service);
    writeFileSync(`${socketPath}.started`, JSON.stringify(started));
    process.stdout.write(`Process ${service} started\n`);
    process.exit(0);
  }
  process.stderr.write(`stub-process-compose: unknown subcommand 'process ${sub}'\n`);
  process.exit(1);
} else if (cmd === "down") {
  // Prefer signalling the parent: its trap reaps children and removes files
  // atomically. Fall back to the legacy path if no parent-pid is recorded
  // (e.g. an old run, or the parent died before writing it).
  let parentPid;
  try {
    parentPid = Number(readFileSync(`${socketPath}.parent-pid`, "utf8"));
  } catch {
    parentPid = undefined;
  }

  if (parentPid && Number.isFinite(parentPid)) {
    try {
      process.kill(parentPid, "SIGTERM");
    } catch {
      // already gone
    }
    // Wait for the parent to actually exit, so callers see a fully reaped
    // state (socket removed, pids dead). 3s is generous: the trap is
    // synchronous and only does sync kill/rm calls.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(parentPid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // Belt-and-suspenders: if no parent-pid file existed (legacy), kill the
  // recorded children directly. Also remove any files the parent missed
  // (e.g. if SIGKILLed before its trap could fire).
  if (existsSync(`${socketPath}.pids`)) {
    try {
      const pids = JSON.parse(readFileSync(`${socketPath}.pids`, "utf8"));
      for (const pid of pids) killChild(pid);
    } catch {
      // pids file unreadable — nothing we can do
    }
    rmSync(`${socketPath}.pids`, { force: true });
  }
  rmSync(`${socketPath}.parent-pid`, { force: true });
  rmSync(`${socketPath}.config`, { force: true });
  rmSync(`${socketPath}.namespaces`, { force: true });
  rmSync(`${socketPath}.started`, { force: true });
  rmSync(socketPath, { force: true });
  process.exit(0);
} else {
  process.stderr.write(`stub-process-compose: unknown command '${cmd}'\n`);
  process.exit(1);
}
