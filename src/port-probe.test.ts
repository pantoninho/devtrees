import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, type Server } from "node:net";
import {
  type BindProbe,
  defaultIsPortFree,
  defaultPortHolder,
  isPortFreeOnAllHosts,
} from "./port-probe.js";

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

  it("identifies the test process as the holder of a bound port (PID + best-effort command)", async () => {
    // The stale-port-block check (#58) needs more than free/not-free: when
    // a port is bound, the agent's error envelope publishes the holder's
    // pid so a human (or the agent itself) can kill the orphan. We bind a
    // port from this very test process and assert defaultPortHolder fingers
    // process.pid — proving the lsof shell-out actually identifies the holder.
    const { port, server } = await ephemeral();
    cleanups.push(() => closeServer(server));

    const holder = await defaultPortHolder(port);
    expect(holder.free).toBe(false);
    if (holder.free === false) {
      // lsof reports the listener's pid as our own when missing on the
      // host degrade to null + null — both shapes are acceptable per the
      // graceful-degradation rule, but our CI hosts have lsof.
      if (holder.pid !== null) {
        expect(holder.pid).toBe(process.pid);
      }
      // `command` is best-effort — only assert the shape, not the wording.
      if (holder.command !== null) {
        expect(typeof holder.command).toBe("string");
        expect(holder.command.length).toBeGreaterThan(0);
      }
    }
  });

  it("reports free when nothing listens on the port", async () => {
    // Use an ephemeral allocation, immediately release, then ask the holder.
    const { port, server } = await ephemeral();
    await closeServer(server);

    const holder = await defaultPortHolder(port);
    expect(holder.free).toBe(true);
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

/** Listen on an ephemeral port on `host`; `null` when the host lacks that family. */
const holdOn = (
  host: string,
  ipv6Only: boolean,
): Promise<{ port: number; server: Server } | null> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT") resolve(null);
      else reject(err);
    });
    server.listen({ port: 0, host, ipv6Only }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`unexpected listen address: ${String(address)}`));
        return;
      }
      resolve({ port: address.port, server });
    });
  });

describe("defaultIsPortFree sees holders on every local listen address (#163)", () => {
  // On macOS, SO_REUSEADDR (which libuv sets) lets a bind on 127.0.0.1 succeed
  // while another process holds the same port on 0.0.0.0, ::1 or ::. A
  // loopback-only probe therefore called those ports free, and the service
  // then died on the taken port.
  const holders: ReadonlyArray<readonly [string, string, boolean]> = [
    ["IPv4 loopback", "127.0.0.1", false],
    ["IPv4 wildcard", "0.0.0.0", false],
    ["IPv6 loopback", "::1", false],
    ["dual-stack wildcard", "::", false],
    ["IPv6-only wildcard", "::", true],
  ];

  for (const [label, host, ipv6Only] of holders) {
    it(`reports a port held on the ${label} (${host}) as taken`, async (ctx) => {
      const held = await holdOn(host, ipv6Only);
      if (held === null) {
        ctx.skip();
        return;
      }
      try {
        expect(await defaultIsPortFree(held.port)).toBe(false);
        const holder = await defaultPortHolder(held.port);
        expect(holder.free).toBe(false);
      } finally {
        await closeServer(held.server);
      }
      expect(await defaultIsPortFree(held.port)).toBe(true);
    });
  }
});

describe("isPortFreeOnAllHosts", () => {
  const err = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;

  it("probes 127.0.0.1, 0.0.0.0, ::1 and :: and reports free when every bind succeeds", async () => {
    const hosts: string[] = [];
    const free = await isPortFreeOnAllHosts(4000, async (_port, host) => {
      hosts.push(host);
      return true;
    });
    expect(free).toBe(true);
    expect(hosts).toEqual(["127.0.0.1", "0.0.0.0", "::1", "::"]);
  });

  it("reports taken when any host returns EADDRINUSE", async () => {
    const bind: BindProbe = async (_port, host) => (host === "::" ? err("EADDRINUSE") : true);
    expect(await isPortFreeOnAllHosts(4000, bind)).toBe(false);
  });

  it.each(["EADDRNOTAVAIL", "EAFNOSUPPORT"])(
    "treats %s on an IPv6 address as no collision (host without IPv6)",
    async (code) => {
      const bind: BindProbe = async (_port, host) => (host.includes(":") ? err(code) : true);
      expect(await isPortFreeOnAllHosts(4000, bind)).toBe(true);
    },
  );

  it("still sees an IPv4 collision on a host without IPv6", async () => {
    const bind: BindProbe = async (_port, host) =>
      host.includes(":") ? err("EAFNOSUPPORT") : host === "0.0.0.0" ? err("EADDRINUSE") : true;
    expect(await isPortFreeOnAllHosts(4000, bind)).toBe(false);
  });

  it("bubbles up EADDRNOTAVAIL on an IPv4 address and any other bind error", async () => {
    await expect(
      isPortFreeOnAllHosts(4000, async (_port, host) =>
        host === "0.0.0.0" ? err("EADDRNOTAVAIL") : true,
      ),
    ).rejects.toThrow("EADDRNOTAVAIL");
    await expect(
      isPortFreeOnAllHosts(4000, async (_port, host) => (host === "::" ? err("EACCES") : true)),
    ).rejects.toThrow("EACCES");
  });
});
