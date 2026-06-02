import { describe, expect, it } from "vite-plus/test";
import { stackHash } from "./hash.js";
import type { ResolvedStack } from "./stack.js";

const svc = (
  name: string,
  command: string,
  ports: string[] = [],
  tier: "isolated" | "shared" = "isolated",
) => ({ name, tier, command, ports, dependsOn: [] as string[], environment: [] as string[] });

describe("stackHash", () => {
  it("is deterministic for the same stack", () => {
    const a: ResolvedStack = { services: [svc("web", "node x.js", ["WEB_PORT"])] };
    const b: ResolvedStack = { services: [svc("web", "node x.js", ["WEB_PORT"])] };
    expect(stackHash(a)).toBe(stackHash(b));
  });

  it("changes when a service's command changes", () => {
    const a: ResolvedStack = { services: [svc("web", "node x.js")] };
    const b: ResolvedStack = { services: [svc("web", "node y.js")] };
    expect(stackHash(a)).not.toBe(stackHash(b));
  });

  it("changes when a service is added", () => {
    const a: ResolvedStack = { services: [svc("web", "node x.js")] };
    const b: ResolvedStack = {
      services: [svc("web", "node x.js"), svc("worker", "node w.js")],
    };
    expect(stackHash(a)).not.toBe(stackHash(b));
  });

  it("changes when a service's tier flips", () => {
    const a: ResolvedStack = { services: [svc("postgres", "postgres", ["DB_PORT"], "shared")] };
    const b: ResolvedStack = { services: [svc("postgres", "postgres", ["DB_PORT"], "isolated")] };
    expect(stackHash(a)).not.toBe(stackHash(b));
  });

  it("changes when allocator overrides change", () => {
    const a: ResolvedStack = {
      services: [svc("web", "node x.js")],
      allocator: { portBase: 20000 },
    };
    const b: ResolvedStack = {
      services: [svc("web", "node x.js")],
      allocator: { portBase: 30000 },
    };
    expect(stackHash(a)).not.toBe(stackHash(b));
  });

  it("is hex-encoded SHA-256 (64 chars)", () => {
    const h = stackHash({ services: [svc("web", "node x.js")] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
