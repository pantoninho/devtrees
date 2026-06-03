/**
 * Default port-free probe. Binds an ephemeral listener on `127.0.0.1:port` and
 * uses the bind outcome as the answer: `EADDRINUSE` → port taken; any other bind
 * error bubbles up (we don't want `EACCES` etc. to be silently reported as "free").
 *
 * Stateless and dependency-free — the allocator injects this seam (`PortFreeProbe`),
 * and tests stub it. Replaces an older `lsof` shell-out so probes are sub-millisecond
 * and the tool no longer needs `lsof` on PATH (see issue #42).
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

export function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (result: boolean | Error) => {
      if (settled) return;
      settled = true;
      server.close(() => {
        if (result instanceof Error) reject(result);
        else resolve(result);
      });
    };
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") finish(false);
      else finish(err);
    });
    server.once("listening", () => finish(true));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Holder report for a concrete port. The free branch carries nothing; the
 * not-free branch carries best-effort `pid` and `command` identifying the
 * listener.
 *
 * `pid` and `command` are nullable on purpose: on hosts where `lsof` is
 * missing, broken, or returns a degenerate record, we still want to surface
 * the collision (so the agent's `STALE_PORT_BLOCK` envelope is useful) — we
 * just lose the identity bits. The empty-identity branch must never be
 * converted to "free": that would re-introduce the silent-failure mode #58
 * exists to close.
 */
export type PortHolderReport =
  | { readonly free: true }
  | { readonly free: false; readonly pid: number | null; readonly command: string | null };

/**
 * Identify the process listening on `port`, if any.
 *
 * Strategy: piggy-back on the EADDRINUSE bind-probe to learn whether the port
 * is taken at all (sub-millisecond, no shell-out for the common "free" case),
 * then shell out to `lsof -iTCP:<port> -sTCP:LISTEN -nP -F pcL` only when we
 * already know something is bound. The `-F` option emits one field per line
 * (`p<pid>`, `c<command>`, `L<login>`), which we parse on prefix — cheap and
 * stable across macOS / Linux lsof builds.
 *
 * Graceful degradation: if `lsof` is missing, exits non-zero, or produces no
 * parseable rows, return `{ free: false, pid: null, command: null }`. The
 * collision is still surfaced; only the identity bits are lost. This keeps
 * the stale-port-block check usable in containers / minimal CI images.
 */
export async function defaultPortHolder(port: number): Promise<PortHolderReport> {
  const free = await defaultIsPortFree(port);
  if (free) return { free: true };
  return { free: false, ...identifyHolderViaLsof(port) };
}

/**
 * Best-effort lsof shell-out that returns `{pid, command}` for the listener
 * on `port`, or `{pid: null, command: null}` on any failure. The 1s timeout
 * is generous for a local lsof call but bounds the worst case if the binary
 * hangs on a slow filesystem.
 */
function identifyHolderViaLsof(port: number): {
  readonly pid: number | null;
  readonly command: string | null;
} {
  try {
    const result = spawnSync(
      "lsof",
      ["-iTCP:" + String(port), "-sTCP:LISTEN", "-nP", "-F", "pcL"],
      { encoding: "utf8", timeout: 1000 },
    );
    if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
      return { pid: null, command: null };
    }
    return parseLsofFields(result.stdout);
  } catch {
    return { pid: null, command: null };
  }
}

/**
 * Parse `lsof -F pcL` output: one field per line, prefixed by the field code
 * (`p<pid>`, `c<command>`, `L<user>`). lsof emits a record per matching FD;
 * we take the first `p`/`c` pair, which is sufficient for the
 * "name the listener" goal of the error envelope.
 */
function parseLsofFields(stdout: string): {
  readonly pid: number | null;
  readonly command: string | null;
} {
  const pidMatch = /^p(\d+)$/m.exec(stdout);
  const commandMatch = /^c(.+)$/m.exec(stdout);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    command: commandMatch ? (commandMatch[1] ?? null) : null,
  };
}
