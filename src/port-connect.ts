/**
 * Does anything accept TCP connections on a local port? (issue #155)
 *
 * The bind probe (`port-probe.ts`) answers "is the port taken"; this answers
 * "is something serving it". The two differ for a holder that keeps the port
 * but refuses every connection, such as a container runtime's stale port
 * forward (OrbStack's helper after its container stopped). Such a holder is
 * one process proxying every instance's containers, so it must never be
 * reported as an orphan to kill; and it cannot silently answer the new
 * service's traffic, which is the failure `STALE_PORT_BLOCK` exists for.
 *
 * Kept separate from `port-probe.ts` so it never changes which addresses the
 * bind probe uses.
 */

import { connect } from "node:net";

/** Per-address connect cap. Loopback answers at once; this only bounds a wedged stack. */
const CONNECT_TIMEOUT_MS = 500;

/**
 * Loopback addresses a local listener can be reached on: IPv4, then IPv6.
 * Together they reach every holder the bind probe can see (#163): one on
 * 127.0.0.1 or 0.0.0.0 answers on 127.0.0.1, one on ::1 or `::` (dual-stack
 * or IPv6-only) on ::1. So a holder is called refusing only when it refuses
 * on both, never because the probe saw it on an address this does not try.
 */
const LOOPBACKS = ["127.0.0.1", "::1"] as const;

/** Resolve whether a TCP connect to `host:port` is accepted. */
function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    // No answer at all: fail closed, as a holder that may well be serving.
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * True when a TCP connect to `port` on either loopback address is accepted
 * (or never answered, which is treated as accepted so a wedged listener is
 * never waved through). False only when every address refuses.
 */
export async function acceptsConnections(
  port: number,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  for (const host of LOOPBACKS) {
    if (await connects(host, port, timeoutMs)) return true;
  }
  return false;
}

/**
 * Process names of container runtimes' port forwarders: one process that
 * publishes every container's ports (OrbStack, Docker Desktop, Podman,
 * Rancher/Lima, rootless Docker). Killing one takes down every instance's
 * containers, so a message naming one says to stop the container instead.
 * Advice only: it never changes what devtrees does. Matched as a prefix,
 * since the kernel may truncate a long process name (`com.docker.backend`).
 */
const PORT_FORWARDERS =
  /^(OrbStack Helper|com\.docker\.|vpnkit|gvproxy|docker-proxy|rootlessport|rootlesskit|limactl)/;

/** Is `command` (as `lsof` names a port's holder) a container runtime's port forwarder? */
export function isPortForwarder(command: string | null): boolean {
  return command !== null && PORT_FORWARDERS.test(command.trim());
}

/** What a message says about a port held by a container runtime's port forwarder. */
export function forwarderLabel(port: number): string {
  return (
    "a container runtime's port forwarder, serving every instance's containers: stop the " +
    `container that publishes the port (\`docker ps --filter publish=${port}\`), never this process`
  );
}
