/**
 * The control-socket liveness gate (issues #80, #186), shared by every
 * command that is about to start or stop processes: a socket file is not proof
 * of a live instance, so its listener is probed, a definitively stale file is
 * unlinked, and an answer that stays unknown fails `INSTANCE_UNRESPONSIVE`.
 */

import { existsSync, rmSync } from "node:fs";
import { probeUntilDefinitive, type InstanceStatus } from "./instances.js";
import { SHARED_INSTANCE_ID } from "./paths.js";
import type { NamedServiceCommand } from "./selection.js";

/**
 * Thrown when a control socket still exists but repeated probes could not
 * tell whether process-compose behind it is alive (issue #186): every connect
 * timed out, or was refused while a process still held the socket. `up` and
 * `down` refuse to guess. Treating the instance as gone would unlink its
 * socket and orphan a possibly live process-compose and its services, which
 * keep their ports, so a fresh `up` would then collide on them. The socket is
 * kept and nothing is started or stopped. `details.instance` is the worktree
 * id, or `shared` for the shared instance.
 */
export class InstanceUnresponsiveError extends Error {
  readonly code = "INSTANCE_UNRESPONSIVE" as const;
  constructor(
    command: string,
    readonly details: {
      readonly instance: string;
      readonly socket_path: string;
      readonly attempts: number;
      readonly remedy: string;
    },
  ) {
    super(
      `devtrees ${command}: the ${details.instance === SHARED_INSTANCE_ID ? "shared" : `'${details.instance}'`} ` +
        `instance's control socket did not answer after ${details.attempts} ` +
        `probe${details.attempts === 1 ? "" : "s"} ` +
        `(${details.socket_path}); process-compose may be busy or frozen. Nothing was ` +
        `started or stopped and the socket was kept. ${details.remedy}`,
    );
    this.name = "InstanceUnresponsiveError";
  }
}

/** A socket-liveness probe plus its retry backoff for `unknown` (#80, #186). */
export interface LivenessProbe {
  readonly probe: (socketPath: string) => Promise<InstanceStatus>;
  readonly retryDelaysMs: ReadonlyArray<number>;
}

/** Which command is asking, and about which instance — for the #186 envelope. */
export interface LivenessContext {
  readonly command: "up" | "down" | NamedServiceCommand;
  /** The exact command to retry, when it is more than the verb (`devtrees restart web`). */
  readonly retry?: string;
  /** Worktree id, or `SHARED_INSTANCE_ID` for the shared instance. */
  readonly instance: string;
}

/**
 * Liveness gate for the write paths (issue #80). A control-socket *file* is
 * not proof of a live instance — it lives in anchor state, which survives
 * `kill -9` and reboots, so after a crash the file points at nothing. Probe
 * the UDS (retrying while the answer is `unknown`):
 *
 *  - a listener means live (`true`);
 *  - a definitive "nothing listening" means the file is an orphan, so unlink
 *    it and report "not live" (`false`) — the caller then falls through to
 *    its fresh-start (or idempotent no-op) path;
 *  - still `unknown` after the retries (#186) throws `INSTANCE_UNRESPONSIVE`
 *    and keeps the socket. Every caller is about to start or stop processes,
 *    and guessing either way is worse than failing: "not live" would orphan
 *    a live process-compose (and a fresh start would collide on its ports),
 *    "live" would hand the driver a socket that does not answer.
 */
export async function socketIsLive(
  socketPath: string,
  liveness: LivenessProbe,
  context: LivenessContext,
  /** `up --dry-run` (#210): answer the same question, but leave a stale file. */
  opts: { readonly readOnly?: boolean } = {},
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  const status = await probeUntilDefinitive(socketPath, liveness.probe, liveness.retryDelaysMs);
  if (status === "running") return true;
  if (status === "stale") {
    if (opts.readOnly !== true) rmSync(socketPath, { force: true });
    return false;
  }
  throw new InstanceUnresponsiveError(context.command, {
    instance: context.instance,
    socket_path: socketPath,
    attempts: liveness.retryDelaysMs.length + 1,
    remedy: unresponsiveRemedy(socketPath, context),
  });
}

/** The `details.remedy` an `INSTANCE_UNRESPONSIVE` envelope carries (#186). */
export function unresponsiveRemedy(socketPath: string, context: LivenessContext): string {
  const down = context.instance === SHARED_INSTANCE_ID ? "devtrees down --shared" : "devtrees down";
  const retry =
    context.retry ?? (context.command === "down" ? down : `devtrees ${context.command}`);
  return (
    `Retry \`${retry}\` in a moment. If it keeps failing, find the process-compose ` +
    `holding the socket with \`lsof -U -a ${socketPath}\`: resume it if it is stopped ` +
    `(\`kill -CONT <pid>\`), or kill it, then run \`${down}\` to clean up.`
  );
}

/**
 * The deadline both post-spawn socket waits run on. Kept as one constant so
 * the worktree and shared waits can't drift apart: #156 established there is
 * no timing component to the failures they report (a bind that can't succeed
 * never succeeds), so this is a fail-fast bound, not a tuning knob.
 */
export const SOCKET_WAIT_TIMEOUT_MS = 3000;

/**
 * Poll until `socketPath` shows up on disk; `true` if it did, `false` on
 * deadline. The worktree and shared socket waits turn `false` into their own
 * envelope — this is deliberately the only shared part, because attributing
 * the failure to the wrong instance is exactly the bug #157 fixed.
 */
export async function pollForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
