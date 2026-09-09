/**
 * Vitest global setup — sandbox the control-socket runtime dir (issue #156).
 *
 * Control sockets live under a short, per-user runtime dir outside the git dir
 * (ADR-0007), which defaults to `$XDG_RUNTIME_DIR` or `/tmp`. Tests spawn
 * process-compose instances (the stub, and the real binary in the gated smoke
 * suites), so without a sandbox every run would litter the developer's actual
 * runtime dir — and would behave differently on a machine that sets
 * `XDG_RUNTIME_DIR`.
 *
 * Point `DEVTREES_RUNTIME_DIR` at one temp dir per test run instead, and remove
 * it in `teardown`. This runs in the main process *before* any worker starts,
 * so every worker inherits the variable, and the e2e suites spawn
 * `dist/cli.mjs` with `{...process.env}`, so it reaches the CLI under test too.
 *
 * The dir has to stay short: the whole point of the relocation is fitting
 * inside `sun_path`, so `/tmp/dt-test-<pid>` — not `os.tmpdir()`, which is a
 * ~49-byte `/var/folders/...` path on macOS.
 */

import { mkdirSync, rmSync } from "node:fs";

const dir = `/tmp/dt-test-${process.pid}`;

export function setup(): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env["DEVTREES_RUNTIME_DIR"] = dir;
}

export function teardown(): void {
  rmSync(dir, { recursive: true, force: true });
}
