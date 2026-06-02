/**
 * Default port-free probe. Binds an ephemeral listener on `127.0.0.1:port` and
 * uses the bind outcome as the answer: `EADDRINUSE` → port taken; any other bind
 * error bubbles up (we don't want `EACCES` etc. to be silently reported as "free").
 *
 * Stateless and dependency-free — the allocator injects this seam (`PortFreeProbe`),
 * and tests stub it. Replaces an older `lsof` shell-out so probes are sub-millisecond
 * and the tool no longer needs `lsof` on PATH (see issue #42).
 */

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
