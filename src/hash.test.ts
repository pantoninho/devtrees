import { describe, expect, it } from "vite-plus/test";
import { sharedStackHash, stackHash } from "./hash.js";
import type { ResolvedStack, ServiceDependency } from "./stack.js";

const svc = (
  name: string,
  command: string,
  ports: string[] = [],
  tier: "isolated" | "shared" = "isolated",
) => ({
  name,
  tier,
  command,
  ports,
  dependsOn: [] as ServiceDependency[],
  environment: [] as string[],
});

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

  describe("forwarded process-compose fields (#175)", () => {
    const web = (extra: Record<string, unknown> = {}): ResolvedStack => ({
      services: [{ ...svc("web", "node x.js"), ...extra }],
    });

    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["namespace", { namespace: "a" }, { namespace: "b" }],
      ["shutdown", { shutdown: { command: "stop-a" } }, { shutdown: { command: "stop-b" } }],
      ["is_daemon", { isDaemon: true }, { isDaemon: false }],
      ["launch_timeout_seconds", { launchTimeoutSeconds: 5 }, { launchTimeoutSeconds: 10 }],
      ["log_location", { logLocation: "a.log" }, { logLocation: "b.log" }],
      [
        "log_configuration",
        { logConfiguration: { rotation: { max_size_mb: 1 } } },
        { logConfiguration: { rotation: { max_size_mb: 2 } } },
      ],
    ];

    for (const [field, before, after] of cases) {
      it(`changes when ${field} is edited`, () => {
        expect(stackHash(web(before))).not.toBe(stackHash(web(after)));
      });

      it(`changes when ${field} is added or removed`, () => {
        expect(stackHash(web())).not.toBe(stackHash(web(before)));
      });

      it(`is stable across runs for the same ${field}`, () => {
        expect(stackHash(web(before))).toBe(stackHash(web({ ...before })));
      });
    }

    it("ignores namespace list order, which process-compose ignores (#179)", () => {
      expect(stackHash(web({ namespace: ["a", "b"] }))).toBe(
        stackHash(web({ namespace: ["b", "a"] })),
      );
    });

    it("hashes a one-element namespace list as the bare string (#179)", () => {
      expect(stackHash(web({ namespace: ["a"] }))).toBe(stackHash(web({ namespace: "a" })));
    });

    it("changes when a namespace list gains or loses an entry (#179)", () => {
      expect(stackHash(web({ namespace: ["a", "b"] }))).not.toBe(
        stackHash(web({ namespace: "a" })),
      );
    });

    it("hashes a string namespace exactly as before lists existed (#179)", () => {
      // Pinned against the digest the pre-#179 code (main at 561eb6e) gives
      // this stack, so upgrading does not hot-reload string-namespace stacks.
      const stack: ResolvedStack = {
        services: [{ ...svc("api", "node api.js"), namespace: "local-backend" }],
      };
      expect(stackHash(stack)).toBe(
        "7482f2c13be4f02cf1a656bf1e43ea545f9b58306e9261fe3f843b49a2fb97ac",
      );
    });

    it("is independent of key order inside shutdown and log_configuration", () => {
      const a = web({
        shutdown: { command: "x", timeout_seconds: 3 },
        logConfiguration: { rotation: { max_size_mb: 1, max_age_days: 2 }, flush: true },
      });
      const b = web({
        shutdown: { timeout_seconds: 3, command: "x" },
        logConfiguration: { flush: true, rotation: { max_age_days: 2, max_size_mb: 1 } },
      });
      expect(stackHash(a)).toBe(stackHash(b));
    });
  });

  describe("depends_on conditions (#158)", () => {
    /** `web -> api`, with whatever condition the caller passes (none by default). */
    const stackWithEdge = (condition?: string): ResolvedStack => ({
      services: [
        {
          ...svc("web", "node web.js", ["WEB_PORT"]),
          dependsOn: [condition === undefined ? { name: "api" } : { name: "api", condition }],
        },
        svc("api", "node api.js"),
      ],
    });

    it("hashes a condition-free stack exactly as it did before conditions existed", () => {
      // Pinned against the digest produced by the pre-#158 code (`dependsOn`
      // was a bare `string[]`) for this same stack. Every user whose stack
      // never used a condition keeps the hash already stored next to their
      // allocation entry — no spurious CONFIG_DRIFT on upgrade.
      //
      // Re-pinned in #175: that change added six always-present (null when
      // absent) fields to the canonical form, so this digest moved once and
      // every instance hot-reloads once on upgrade. The pre-#175 digest was
      // fea226a76cf3e0dd1a2987264998d2093d3a54648307e6263db3837a7db5a28f.
      expect(stackHash(stackWithEdge())).toBe(
        "0effb4027cf6e581c53c8f4484d02820897dd41f9756c9b833b867190ea630a4",
      );
    });

    it("hashes an explicit condition differently from no condition", () => {
      // An authored condition reaches the derived config, so it is real config.
      expect(stackHash(stackWithEdge("process_healthy"))).not.toBe(stackHash(stackWithEdge()));
    });

    it("changes when a condition is edited (process_started -> process_healthy)", () => {
      expect(stackHash(stackWithEdge("process_healthy"))).not.toBe(
        stackHash(stackWithEdge("process_started")),
      );
    });

    it("is deterministic for the same conditioned stack", () => {
      expect(stackHash(stackWithEdge("process_healthy"))).toBe(
        stackHash(stackWithEdge("process_healthy")),
      );
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

describe("sharedStackHash vs forwarded fields (#175)", () => {
  it("ignores process-compose fields that never affect the shared port map", () => {
    const a: ResolvedStack = { services: [svc("pg", "postgres", ["DB_PORT"], "shared")] };
    const b: ResolvedStack = {
      services: [
        {
          ...svc("pg", "postgres", ["DB_PORT"], "shared"),
          shutdown: { command: "pg_ctl stop" },
          isDaemon: true,
          logLocation: "pg.log",
        },
      ],
    };
    expect(sharedStackHash(a)).toBe(sharedStackHash(b));
  });
});

describe("shared services' #183 fields vs stackHash (#185)", () => {
  const edits = {
    shutdown: { shutdown: { command: "x" } },
    isDaemon: { isDaemon: true },
    launchTimeoutSeconds: { launchTimeoutSeconds: 9 },
    logLocation: { logLocation: "pg.log" },
    logConfiguration: { logConfiguration: { rotation: { max_size_mb: 1 } } },
  } as const;

  for (const [field, edit] of Object.entries(edits)) {
    it(`editing a shared service's ${field} leaves stackHash unchanged`, () => {
      const base = svc("pg", "postgres", ["DB_PORT"], "shared");
      const a: ResolvedStack = { services: [base, svc("web", "node x.js")] };
      const b: ResolvedStack = { services: [{ ...base, ...edit }, svc("web", "node x.js")] };
      expect(stackHash(b)).toBe(stackHash(a));
    });

    it(`editing an isolated service's ${field} still changes stackHash`, () => {
      const base = svc("web", "node x.js");
      const a: ResolvedStack = { services: [base] };
      const b: ResolvedStack = { services: [{ ...base, ...edit }] };
      expect(stackHash(b)).not.toBe(stackHash(a));
    });
  }

  it("still covers what a shared service had hashed before #183", () => {
    const base = svc("pg", "postgres", ["DB_PORT"], "shared");
    const a: ResolvedStack = { services: [base] };
    expect(stackHash({ services: [{ ...base, command: "postgres -x" }] })).not.toBe(stackHash(a));
    expect(stackHash({ services: [{ ...base, namespace: "db" }] })).not.toBe(stackHash(a));
  });
});
