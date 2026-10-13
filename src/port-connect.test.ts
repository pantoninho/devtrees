/**
 * The connect probe that tells a holder serving a port from one that refuses
 * connections (#155), against real loopback listeners.
 */
import { describe, expect, it } from "vite-plus/test";
import { createServer, type Server } from "node:net";
import { acceptsConnections, isPortForwarder } from "./port-connect.js";

function listen(host: string, opts: { ipv6Only?: boolean } = {}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ port: 0, host, ipv6Only: opts.ipv6Only ?? false }, () => resolve(server));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

describe("acceptsConnections", () => {
  it("is true for a listener on 127.0.0.1", async () => {
    const server = await listen("127.0.0.1");
    try {
      expect(await acceptsConnections(portOf(server))).toBe(true);
    } finally {
      await close(server);
    }
  });

  it("is true for an IPv6-only wildcard listener, which refuses 127.0.0.1 (#163)", async () => {
    const server = await listen("::", { ipv6Only: true }).catch(() => undefined);
    if (server === undefined) return; // host without IPv6
    try {
      expect(await acceptsConnections(portOf(server))).toBe(true);
    } finally {
      await close(server);
    }
  });

  it("is false once nothing listens on the port", async () => {
    const server = await listen("127.0.0.1");
    const port = portOf(server);
    await close(server);
    expect(await acceptsConnections(port)).toBe(false);
  });
});

describe("isPortForwarder", () => {
  it("names container runtimes' shared forwarders, even truncated", () => {
    expect(isPortForwarder("OrbStack Helper")).toBe(true);
    expect(isPortForwarder("com.docker.backen")).toBe(true);
    expect(isPortForwarder("gvproxy")).toBe(true);
  });

  it("does not name an ordinary process, or an unknown one", () => {
    expect(isPortForwarder("node")).toBe(false);
    expect(isPortForwarder("Python")).toBe(false);
    expect(isPortForwarder(null)).toBe(false);
  });
});
