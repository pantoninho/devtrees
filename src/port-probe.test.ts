import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, type Server } from "node:net";
import { defaultIsPortFree } from "./port-probe.js";

const ephemeral = (): Promise<{ port: number; server: Server }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`unexpected listen address: ${String(address)}`));
        return;
      }
      resolve({ port: address.port, server });
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

describe("defaultIsPortFree", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("returns false while a real listener holds the port, true once released", async () => {
    const { port, server } = await ephemeral();
    cleanups.push(() => closeServer(server));

    expect(await defaultIsPortFree(port)).toBe(false);

    await closeServer(server);
    cleanups.pop();

    expect(await defaultIsPortFree(port)).toBe(true);
  });

  it("bubbles up non-EADDRINUSE bind errors instead of reporting 'free'", async () => {
    // Negative ports trigger a synchronous range error from libuv (RangeError /
    // ERR_SOCKET_BAD_PORT) — not EADDRINUSE, so the probe must reject rather
    // than silently treating the port as available.
    await expect(defaultIsPortFree(-1)).rejects.toThrow();
  });

  it("closes the probe listener on every path — 10k probes don't exhaust FDs", async () => {
    // Default macOS soft FD limit is 256, so a single leaked FD per probe would
    // ENFILE/EMFILE long before we hit 10k. Run with a real bound port mixed in
    // to exercise both the success and the EADDRINUSE branch under load.
    const { port: heldPort, server } = await ephemeral();
    cleanups.push(() => closeServer(server));

    for (let i = 0; i < 10_000; i++) {
      const target = i % 2 === 0 ? 0 : heldPort;
      const free = await defaultIsPortFree(target);
      if (target === heldPort && free !== false) {
        throw new Error(`held port reported free at iteration ${i}`);
      }
    }
  }, 30_000);
});
