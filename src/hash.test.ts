import { describe, expect, it } from "vite-plus/test";
import { sharedStackHash, stackHash } from "./hash.js";
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

  describe("passthrough blocks (#86)", () => {
    it("changes when a readiness_probe is edited", () => {
      const a: ResolvedStack = {
        services: [
          { ...svc("web", "node x.js"), readinessProbe: { http_get: { path: "/health" } } },
        ],
      };
      const b: ResolvedStack = {
        services: [
          { ...svc("web", "node x.js"), readinessProbe: { http_get: { path: "/ready" } } },
        ],
      };
      expect(stackHash(a)).not.toBe(stackHash(b));
    });

    it("changes when a readiness_probe is added", () => {
      const a: ResolvedStack = { services: [svc("web", "node x.js")] };
      const b: ResolvedStack = {
        services: [
          { ...svc("web", "node x.js"), readinessProbe: { http_get: { path: "/health" } } },
        ],
      };
      expect(stackHash(a)).not.toBe(stackHash(b));
    });

    it("changes when a liveness_probe is edited", () => {
      const a: ResolvedStack = {
        services: [{ ...svc("web", "node x.js"), livenessProbe: { exec: { command: "ok" } } }],
      };
      const b: ResolvedStack = {
        services: [{ ...svc("web", "node x.js"), livenessProbe: { exec: { command: "nope" } } }],
      };
      expect(stackHash(a)).not.toBe(stackHash(b));
    });

    it("is insensitive to key ordering inside a block — unchanged configs must not drift", () => {
      const a: ResolvedStack = {
        services: [
          {
            ...svc("web", "node x.js"),
            readinessProbe: {
              http_get: { path: "/health", port: 8080 },
              period_seconds: 5,
              failure_threshold: 3,
            },
          },
        ],
      };
      const b: ResolvedStack = {
        services: [
          {
            ...svc("web", "node x.js"),
            readinessProbe: {
              failure_threshold: 3,
              period_seconds: 5,
              http_get: { port: 8080, path: "/health" },
            },
          },
        ],
      };
      expect(stackHash(a)).toBe(stackHash(b));
    });

    it("changes when availability is edited", () => {
      const a: ResolvedStack = {
        services: [{ ...svc("web", "node x.js"), availability: { restart: "on_failure" } }],
      };
      const b: ResolvedStack = {
        services: [{ ...svc("web", "node x.js"), availability: { restart: "always" } }],
      };
      expect(stackHash(a)).not.toBe(stackHash(b));
    });
  });
});

describe("sharedStackHash (#83)", () => {
  const pg = svc("postgres", "postgres -D ./pg", ["DB_PORT"], "shared");
  const redis = svc("redis", "redis-server", ["CACHE_PORT"], "shared");
  const web = svc("web", "node server.js", ["WEB_PORT"], "isolated");

  it("is insensitive to service ordering — reordering must not register as drift", () => {
    const a: ResolvedStack = { services: [pg, redis, web] };
    const b: ResolvedStack = { services: [web, redis, pg] };
    expect(sharedStackHash(a)).toBe(sharedStackHash(b));
  });

  it("ignores isolated services entirely — a branch editing only isolated services must not drift shared", () => {
    const a: ResolvedStack = { services: [pg, web] };
    const b: ResolvedStack = {
      services: [pg, svc("web", "node other.js --flag", ["WEB_PORT", "EXTRA_PORT"], "isolated")],
    };
    expect(sharedStackHash(a)).toBe(sharedStackHash(b));
  });

  it("changes when a shared service is added", () => {
    const a: ResolvedStack = { services: [pg, web] };
    const b: ResolvedStack = { services: [pg, redis, web] };
    expect(sharedStackHash(a)).not.toBe(sharedStackHash(b));
  });

  it("changes when a shared service's command changes", () => {
    const a: ResolvedStack = { services: [pg] };
    const b: ResolvedStack = {
      services: [svc("postgres", "postgres -D ./other", ["DB_PORT"], "shared")],
    };
    expect(sharedStackHash(a)).not.toBe(sharedStackHash(b));
  });

  it("changes when a service's tier flips isolated -> shared", () => {
    const a: ResolvedStack = { services: [pg, web] };
    const b: ResolvedStack = {
      services: [pg, svc("web", "node server.js", ["WEB_PORT"], "shared")],
    };
    expect(sharedStackHash(a)).not.toBe(sharedStackHash(b));
  });

  it("ignores allocator overrides — port numbers come from the persisted map, not the hash", () => {
    const a: ResolvedStack = { services: [pg], allocator: { portBase: 20000 } };
    const b: ResolvedStack = { services: [pg], allocator: { portBase: 30000 } };
    expect(sharedStackHash(a)).toBe(sharedStackHash(b));
  });

  it("is hex-encoded SHA-256 (64 chars)", () => {
    expect(sharedStackHash({ services: [pg] })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a shared service's readiness_probe is edited (#86)", () => {
    const a: ResolvedStack = {
      services: [{ ...pg, readinessProbe: { exec: { command: "pg_isready" } } }],
    };
    const b: ResolvedStack = {
      services: [{ ...pg, readinessProbe: { exec: { command: "pg_isready -q" } } }],
    };
    expect(sharedStackHash(a)).not.toBe(sharedStackHash(b));
  });

  it("ignores probe edits on isolated services (#86)", () => {
    const a: ResolvedStack = {
      services: [pg, { ...web, livenessProbe: { exec: { command: "ok" } } }],
    };
    const b: ResolvedStack = {
      services: [pg, { ...web, livenessProbe: { exec: { command: "nope" } } }],
    };
    expect(sharedStackHash(a)).toBe(sharedStackHash(b));
  });
});
