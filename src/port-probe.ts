/**
 * Default port-free probe. Binds an ephemeral listener on `port` once per
 * {@link PROBE_HOSTS} entry and uses the bind outcomes as the answer:
 * `EADDRINUSE` on any host → port taken; any other bind error bubbles up (we
 * don't want `EACCES` etc. to be silently reported as "free").
 *
 * Why several hosts (#163): libuv sets `SO_REUSEADDR` on listeners, and on macOS
 * that makes a bind collide only with a holder on the *same* address. A probe on
 * `127.0.0.1` alone reports a port held on `0.0.0.0`, `::1` or the dual-stack
 * `::` wildcard (`python3 -m http.server`, Docker/OrbStack published ports, most
 * dev servers left at their default host) as free. Probing each of the four
 * local listen addresses closes that gap; the dual-stack `::` probe also catches
 * an IPv6-only `::` holder. The probes run one after another because they would
 * collide with each other.
 *
 * A host with no IPv6 (`EADDRNOTAVAIL` / `EAFNOSUPPORT` on an IPv6 address) is
 * not a collision: nothing can hold a port on an address family the host lacks,
 * so that probe is skipped.
 *
 * Stateless and dependency-free — the allocator injects this seam (`PortFreeProbe`),
 * and tests stub it. Replaces an older `lsof` shell-out so probes are sub-millisecond
 * and the tool no longer needs `lsof` on PATH (see issue #42).
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

export function defaultIsPortFree(port: number): Promise<boolean> {
  return isPortFreeOnAllHosts(port, bindProbe);
}

/**
 * The local listen addresses a holder can occupy: IPv4 loopback and wildcard,
 * IPv6 loopback, and the (dual-stack) IPv6 wildcard.
 */
const PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

/** One bind attempt: resolves `true` when the bind succeeded, else the bind error. */
export type BindProbe = (port: number, host: string) => Promise<true | NodeJS.ErrnoException>;

/** Bind errors meaning "this host lacks the address family", not "taken". */
const ABSENT_FAMILY_CODES: ReadonlySet<string> = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/**
 * Probe `port` on every {@link PROBE_HOSTS} entry with `bind`, stopping at the
 * first collision. Exported with the bind seam so the no-IPv6 handling is
 * testable on a host that has IPv6.
 */
export async function isPortFreeOnAllHosts(port: number, bind: BindProbe): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    const outcome = await bind(port, host);
    if (outcome === true) continue;
    if (outcome.code === "EADDRINUSE") return false;
    if (host.includes(":") && ABSENT_FAMILY_CODES.has(outcome.code ?? "")) continue;
    throw outcome;
  }
  return true;
}

/**
 * Bind a throwaway listener on `host:port` and close it again, on every path.
 * `ipv6Only: false` makes the `::` probe dual-stack.
 */
function bindProbe(port: number, host: string): Promise<true | NodeJS.ErrnoException> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (result: true | NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(result));
    };
    server.once("error", (err: NodeJS.ErrnoException) => finish(err));
    server.once("listening", () => finish(true));
    try {
      server.listen({ port, host, ipv6Only: false });
    } catch (err) {
      finish(err as NodeJS.ErrnoException);
    }
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
 * on `port`, or `{pid: null, command: null}` on any failure. The 1s default
 * timeout is generous for a local lsof call but bounds the worst case if the
 * binary hangs on a slow filesystem; `down` (#155), which runs it while
 * shutdown hooks may still load the machine, passes a longer one.
 */
export function identifyHolderViaLsof(
  port: number,
  timeoutMs = 1000,
): {
  readonly pid: number | null;
  readonly command: string | null;
} {
  try {
    const result = spawnSync(
      "lsof",
      ["-iTCP:" + String(port), "-sTCP:LISTEN", "-nP", "-F", "pcL"],
      { encoding: "utf8", timeout: timeoutMs },
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
