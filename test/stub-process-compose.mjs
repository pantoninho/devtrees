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
 *        socket as a liveness marker. Backgrounds itself and returns.
 *   down -U -u <socket>
 *        Signals the running instance to stop and removes the control socket.
 *   version
 *        Prints a version so the binary-presence probe succeeds.
 *
 * The processes here are expected to be simple shell commands; the e2e uses a
 * tiny HTTP server that binds ${PORT} and writes a relative file, so the test
 * can assert reachability and working-directory isolation.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";

function flag(name, short) {
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name || argv[i] === short) return argv[i + 1];
  }
  return undefined;
}

const cmd = process.argv[2];

if (cmd === "version") {
  process.stdout.write("stub-process-compose 0.0.0\n");
  process.exit(0);
}

const socketPath = flag("--unix-socket", "-u");

if (cmd === "up") {
  const configPath = flag("-f", "-f");
  const config = parseYaml(readFileSync(configPath, "utf8"));
  const pids = [];
  for (const proc of Object.values(config.processes ?? {})) {
    const env = { ...process.env };
    for (const entry of proc.environment ?? []) {
      const eq = entry.indexOf("=");
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const child = spawn("/bin/sh", ["-c", proc.command], {
      cwd: proc.working_dir,
      env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    pids.push(child.pid);
  }
  // The control socket doubles as the liveness marker and a record of child pids.
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer();
  server.listen(socketPath, () => {
    writeFileSync(`${socketPath}.pids`, JSON.stringify(pids));
    // Remember the derived config alongside the socket so `process list` can
    // recover the service set without re-resolving the original path.
    writeFileSync(`${socketPath}.config`, readFileSync(configPath, "utf8"));
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
    // wrote to disk, alongside the pids file (under <socket>.config). Each
    // service reports a stable Running/Ready pair so tests can assert against
    // a deterministic snapshot.
    const cfgPath = `${socketPath}.config`;
    if (!existsSync(cfgPath)) {
      process.stderr.write(`stub-process-compose: no instance at ${socketPath}\n`);
      process.exit(1);
    }
    const config = parseYaml(readFileSync(cfgPath, "utf8"));
    const procs = Object.keys(config.processes ?? {}).map((name) => ({
      name,
      status: "Running",
      is_ready: "Ready",
    }));
    process.stdout.write(JSON.stringify(procs));
    process.exit(0);
  }
  process.stderr.write(`stub-process-compose: unknown subcommand 'process ${sub}'\n`);
  process.exit(1);
} else if (cmd === "project") {
  const sub = process.argv[3];
  if (sub === "update") {
    // `project update -U -u <socket> -f <config>` — hot-reload the running
    // instance with a new derived config (issue #31). Setting
    // STUB_RELOAD_UNSUPPORTED=1 emulates an older process-compose that
    // doesn't implement this subcommand: exit non-zero with a clear stderr
    // so the driver classifies the failure as `not_supported`.
    if (process.env.STUB_RELOAD_UNSUPPORTED === "1") {
      process.stderr.write(
        `stub-process-compose: 'project update' is not supported by this build\n`,
      );
      process.exit(1);
    }
    const configPath = flag("-f", "-f");
    if (!configPath || !existsSync(configPath)) {
      process.stderr.write(`stub-process-compose: missing config at ${configPath}\n`);
      process.exit(1);
    }
    if (!existsSync(socketPath)) {
      process.stderr.write(`stub-process-compose: no instance at ${socketPath}\n`);
      process.exit(1);
    }
    // Persist the swapped config alongside the socket so a follow-up `process
    // list` reflects the new service set.
    writeFileSync(`${socketPath}.config`, readFileSync(configPath, "utf8"));
    process.exit(0);
  }
  process.stderr.write(`stub-process-compose: unknown subcommand 'project ${sub}'\n`);
  process.exit(1);
} else if (cmd === "down") {
  if (existsSync(`${socketPath}.pids`)) {
    const pids = JSON.parse(readFileSync(`${socketPath}.pids`, "utf8"));
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    rmSync(`${socketPath}.pids`, { force: true });
  }
  rmSync(`${socketPath}.config`, { force: true });
  rmSync(socketPath, { force: true });
  process.exit(0);
} else {
  process.stderr.write(`stub-process-compose: unknown command '${cmd}'\n`);
  process.exit(1);
}
