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
    server.unref();
  });
  // Stay alive holding the socket; `down` will terminate us.
  setInterval(() => {}, 1 << 30);
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
  rmSync(socketPath, { force: true });
  process.exit(0);
} else {
  process.stderr.write(`stub-process-compose: unknown command '${cmd}'\n`);
  process.exit(1);
}
