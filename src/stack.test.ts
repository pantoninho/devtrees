import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStack, parseStack } from "./stack.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dt-stack-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("stack model — loadStack with extends", () => {
  it("resolves the extends path relative to devtrees.yaml and leaves the base file unmodified", () => {
    const dir = makeDir();
    const baseText = ["processes:", "  web:", '    command: "node server.js"', ""].join("\n");
    writeFileSync(join(dir, "process-compose.yaml"), baseText);
    writeFileSync(
      join(dir, "devtrees.yaml"),
      [
        "extends: ./process-compose.yaml",
        "services:",
        "  web:",
        "    tier: isolated",
        "    ports: [WEB_PORT]",
        "",
      ].join("\n"),
    );
    const baseMtimeBefore = statSync(join(dir, "process-compose.yaml")).mtimeMs;

    const stack = loadStack(dir);
    expect(stack.services).toEqual([
      {
        name: "web",
        tier: "isolated",
        command: "node server.js",
        ports: ["WEB_PORT"],
        dependsOn: [],
        environment: [],
      },
    ]);

    // The base file is read-only as far as devtrees is concerned: its contents
    // and mtime must not change.
    expect(readFileSync(join(dir, "process-compose.yaml"), "utf8")).toBe(baseText);
    expect(statSync(join(dir, "process-compose.yaml")).mtimeMs).toBe(baseMtimeBefore);
  });
});

describe("stack model — extend a base process-compose.yaml", () => {
  it("merges a base process into the stack with tier defaulting to isolated", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  web:
    ports: [WEB_PORT]
`;
    const base = `
processes:
  web:
    command: "node server.js"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    expect(stack.services).toEqual([
      {
        name: "web",
        tier: "isolated",
        command: "node server.js",
        ports: ["WEB_PORT"],
        dependsOn: [],
        environment: [],
      },
    ]);
  });

  it("lets inline-defined and extend-defined services coexist in one devtrees.yaml", () => {
    // `web` is defined inline (no base entry); `postgres` is contributed by the
    // base config. Both should land in the resolved stack.
    const devtrees = `
extends: ./process-compose.yaml
services:
  postgres:
    tier: shared
  web:
    tier: isolated
    command: "node server.js"
    ports: [WEB_PORT]
`;
    const base = `
processes:
  postgres:
    command: "postgres -D ./pgdata"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    const names = stack.services.map((s) => s.name).sort();
    expect(names).toEqual(["postgres", "web"]);
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.web?.command).toBe("node server.js");
    expect(byName.postgres?.command).toBe("postgres -D ./pgdata");
  });

  it("lets the overlay override a base service field (command)", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  web:
    tier: isolated
    command: "node devtrees-override.js"
    ports: [WEB_PORT]
`;
    const base = `
processes:
  web:
    command: "node server.js"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    expect(stack.services[0]?.command).toBe("node devtrees-override.js");
  });

  it("lets the overlay attach a tier to a base-defined service", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  postgres:
    tier: shared
  web:
    tier: isolated
    ports: [WEB_PORT]
`;
    const base = `
processes:
  postgres:
    command: "postgres -D ./pgdata"
  web:
    command: "node server.js"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.postgres?.tier).toBe("shared");
    expect(byName.web?.tier).toBe("isolated");
  });
});

describe("stack model — inline load", () => {
  it("normalizes an inline service with explicit fields", () => {
    const yaml = `
services:
  web:
    tier: isolated
    command: "node server.js"
    ports: [WEB_PORT]
    environment:
      - LOG_LEVEL=debug
`;
    const stack = parseStack(yaml);
    expect(stack.services).toEqual([
      {
        name: "web",
        tier: "isolated",
        command: "node server.js",
        ports: ["WEB_PORT"],
        dependsOn: [],
        environment: ["LOG_LEVEL=debug"],
      },
    ]);
  });

  it("defaults tier to isolated when omitted", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
    ports: [WEB_PORT]
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.tier).toBe("isolated");
  });

  it("reads per-repo allocator config (port_base, block_size) from the top level", () => {
    const yaml = `
port_base: 30000
block_size: 64
services:
  web:
    command: "node server.js"
    ports: [WEB_PORT]
`;
    const stack = parseStack(yaml);
    expect(stack.allocator).toEqual({ portBase: 30000, blockSize: 64 });
  });

  it("omits the allocator section when neither port_base nor block_size is set", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    expect(stack.allocator).toBeUndefined();
  });

  it("accepts a partial allocator override (port_base only)", () => {
    const yaml = `
port_base: 25000
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    expect(stack.allocator).toEqual({ portBase: 25000 });
  });

  it("rejects a port_base too close to 65535 for one full block (default block_size)", () => {
    const yaml = `
port_base: 65530
services:
  web:
    command: "node server.js"
`;
    expect(() => parseStack(yaml)).toThrow(/port_base 65530.*65535/s);
  });

  it("rejects a port_base/block_size pair whose first block would cross 65535", () => {
    const yaml = `
port_base: 65000
block_size: 1000
services:
  web:
    command: "node server.js"
`;
    expect(() => parseStack(yaml)).toThrow(/65535/);
  });

  it("rejects a block_size too large for the default port_base", () => {
    const yaml = `
block_size: 50000
services:
  web:
    command: "node server.js"
`;
    expect(() => parseStack(yaml)).toThrow(/65535/);
  });

  it("accepts the exact-fit port_base whose single block ends at 65535", () => {
    const yaml = `
port_base: 65504
block_size: 32
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    expect(stack.allocator).toEqual({ portBase: 65504, blockSize: 32 });
  });
});

describe("stack model — process-compose probe / availability passthrough", () => {
  it("carries an inline readiness_probe through as an opaque record", () => {
    // devtrees never models the probe's inner shape — process-compose owns it.
    // Whatever the author writes under `readiness_probe:` must reach
    // ResolvedService verbatim, including exotic / unknown keys.
    const yaml = `
services:
  web:
    command: "node server.js"
    readiness_probe:
      exec:
        command: "/bin/true"
      initial_delay_seconds: 1
      period_seconds: 2
      future_field_devtrees_doesnt_know:
        nested: true
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.readinessProbe).toEqual({
      exec: { command: "/bin/true" },
      initial_delay_seconds: 1,
      period_seconds: 2,
      future_field_devtrees_doesnt_know: { nested: true },
    });
  });

  it("omits readiness_probe from ResolvedService when the author didn't declare one", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    const web = stack.services[0];
    if (!web) throw new Error("expected web");
    expect("readinessProbe" in web).toBe(false);
  });

  it("carries an inline namespace through verbatim", () => {
    const yaml = `
services:
  api:
    command: "node api.js"
    namespace: local-backend
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.namespace).toBe("local-backend");
  });

  it("omits namespace from ResolvedService when the author didn't declare one", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    const web = stack.services[0];
    if (!web) throw new Error("expected web");
    expect("namespace" in web).toBe(false);
  });

  it("lets the overlay attach a namespace to a base-defined service", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  api:
    namespace: local-backend
`;
    const base = `
processes:
  api:
    command: "node api.js"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    expect(stack.services[0]?.namespace).toBe("local-backend");
  });

  it("uses the base's readiness_probe when the overlay omits it", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  web:
    tier: isolated
    ports: [WEB_PORT]
`;
    const base = `
processes:
  web:
    command: "node server.js"
    readiness_probe:
      exec:
        command: "curl -sf http://localhost:8080/"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    expect(stack.services[0]?.readinessProbe).toEqual({
      exec: { command: "curl -sf http://localhost:8080/" },
    });
  });

  it("lets the overlay override the base's readiness_probe (overlay wins)", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  web:
    tier: isolated
    readiness_probe:
      exec:
        command: "/usr/local/bin/overlay-check"
`;
    const base = `
processes:
  web:
    command: "node server.js"
    readiness_probe:
      exec:
        command: "/base-check"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    expect(stack.services[0]?.readinessProbe).toEqual({
      exec: { command: "/usr/local/bin/overlay-check" },
    });
  });

  it("carries a liveness_probe through verbatim", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
    liveness_probe:
      exec:
        command: "/bin/true"
      failure_threshold: 3
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.livenessProbe).toEqual({
      exec: { command: "/bin/true" },
      failure_threshold: 3,
    });
  });

  it("uses the base's liveness_probe when the overlay omits it; overlay wins when both set", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  api:
    tier: isolated
  web:
    tier: isolated
    liveness_probe:
      exec:
        command: "/overlay-live"
`;
    const base = `
processes:
  api:
    command: "node api.js"
    liveness_probe:
      exec:
        command: "/base-api-live"
  web:
    command: "node server.js"
    liveness_probe:
      exec:
        command: "/base-web-live"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.api?.livenessProbe).toEqual({ exec: { command: "/base-api-live" } });
    expect(byName.web?.livenessProbe).toEqual({ exec: { command: "/overlay-live" } });
  });

  it("carries an availability block through verbatim", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
    availability:
      restart: on_failure
      backoff_seconds: 5
      max_restarts: 3
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.availability).toEqual({
      restart: "on_failure",
      backoff_seconds: 5,
      max_restarts: 3,
    });
  });

  it("uses the base's availability when the overlay omits it; overlay wins when both set", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  api:
    tier: isolated
  web:
    tier: isolated
    availability:
      restart: always
`;
    const base = `
processes:
  api:
    command: "node api.js"
    availability:
      restart: on_failure
  web:
    command: "node server.js"
    availability:
      restart: never
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.api?.availability).toEqual({ restart: "on_failure" });
    expect(byName.web?.availability).toEqual({ restart: "always" });
  });

  it("coexists with the existing five fields", () => {
    const yaml = `
services:
  web:
    tier: isolated
    command: "node server.js"
    ports: [WEB_PORT]
    depends_on: [api]
    environment:
      - LOG_LEVEL=debug
    readiness_probe:
      exec:
        command: "/r"
    liveness_probe:
      exec:
        command: "/l"
    availability:
      restart: on_failure
  api:
    tier: isolated
    command: "node api.js"
`;
    const stack = parseStack(yaml);
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.web).toEqual({
      name: "web",
      tier: "isolated",
      command: "node server.js",
      ports: ["WEB_PORT"],
      dependsOn: ["api"],
      environment: ["LOG_LEVEL=debug"],
      readinessProbe: { exec: { command: "/r" } },
      livenessProbe: { exec: { command: "/l" } },
      availability: { restart: "on_failure" },
    });
  });
});

describe("stack model — shutdown / daemon-launch passthrough (#134)", () => {
  it("carries an inline shutdown block through as an opaque record", () => {
    // shutdown is an object → rides the same opaque-record passthrough as the
    // probe blocks. devtrees never models its inner shape; process-compose owns it.
    const yaml = `
services:
  data:
    command: "supabase start"
    shutdown:
      command: "supabase stop"
      timeout_seconds: 60
      signal: 15
      parent_only: false
      future_field_devtrees_doesnt_know: 7
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.shutdown).toEqual({
      command: "supabase stop",
      timeout_seconds: 60,
      signal: 15,
      parent_only: false,
      future_field_devtrees_doesnt_know: 7,
    });
  });

  it("omits shutdown from ResolvedService when the author didn't declare one", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    const web = stack.services[0];
    if (!web) throw new Error("expected web");
    expect("shutdown" in web).toBe(false);
  });

  it("uses the base's shutdown when the overlay omits it; overlay wins when both set", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  api:
    tier: isolated
  web:
    tier: isolated
    shutdown:
      command: "/overlay-down"
`;
    const base = `
processes:
  api:
    command: "node api.js"
    shutdown:
      command: "/base-api-down"
  web:
    command: "node server.js"
    shutdown:
      command: "/base-web-down"
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.api?.shutdown).toEqual({ command: "/base-api-down" });
    expect(byName.web?.shutdown).toEqual({ command: "/overlay-down" });
  });

  it("carries is_daemon (boolean scalar) through verbatim", () => {
    const yaml = `
services:
  data:
    command: "supabase start"
    is_daemon: true
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.isDaemon).toBe(true);
  });

  it("carries is_daemon: false through verbatim (a declared false is not absence)", () => {
    const yaml = `
services:
  data:
    command: "supabase start"
    is_daemon: false
`;
    const stack = parseStack(yaml);
    const data = stack.services[0];
    if (!data) throw new Error("expected data");
    expect("isDaemon" in data).toBe(true);
    expect(data.isDaemon).toBe(false);
  });

  it("omits is_daemon when the author didn't declare one", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    const web = stack.services[0];
    if (!web) throw new Error("expected web");
    expect("isDaemon" in web).toBe(false);
  });

  it("rejects a non-boolean is_daemon as CONFIG_INVALID", () => {
    const yaml = `
services:
  data:
    command: "supabase start"
    is_daemon: "yes"
`;
    expect(() => parseStack(yaml)).toThrow(/is_daemon/);
  });

  it("carries launch_timeout_seconds (number scalar) through verbatim", () => {
    const yaml = `
services:
  data:
    command: "supabase start"
    launch_timeout_seconds: 5
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.launchTimeoutSeconds).toBe(5);
  });

  it("omits launch_timeout_seconds when the author didn't declare one", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    const web = stack.services[0];
    if (!web) throw new Error("expected web");
    expect("launchTimeoutSeconds" in web).toBe(false);
  });

  it("rejects a non-number launch_timeout_seconds as CONFIG_INVALID", () => {
    const yaml = `
services:
  data:
    command: "supabase start"
    launch_timeout_seconds: "soon"
`;
    expect(() => parseStack(yaml)).toThrow(/launch_timeout_seconds/);
  });

  it("uses the base's scalars when the overlay omits them; overlay wins when both set", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  api:
    tier: isolated
  web:
    tier: isolated
    is_daemon: false
    launch_timeout_seconds: 9
`;
    const base = `
processes:
  api:
    command: "node api.js"
    is_daemon: true
    launch_timeout_seconds: 3
  web:
    command: "node server.js"
    is_daemon: true
    launch_timeout_seconds: 1
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.api?.isDaemon).toBe(true);
    expect(byName.api?.launchTimeoutSeconds).toBe(3);
    expect(byName.web?.isDaemon).toBe(false);
    expect(byName.web?.launchTimeoutSeconds).toBe(9);
  });
});

describe("stack model — log persistence passthrough (#136)", () => {
  it("carries a relative log_location through as the raw authored string", () => {
    // The raw authored value is preserved here — path templating (resolving it
    // under the per-instance logs dir) happens in the deriver, not the parser.
    const yaml = `
services:
  api:
    command: "node api.js"
    log_location: api.log
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.logLocation).toBe("api.log");
  });

  it("accepts a safe nested relative log_location (sub/api.log)", () => {
    const yaml = `
services:
  api:
    command: "node api.js"
    log_location: sub/api.log
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.logLocation).toBe("sub/api.log");
  });

  it("omits logLocation from ResolvedService when the author didn't declare one", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
`;
    const stack = parseStack(yaml);
    const web = stack.services[0];
    if (!web) throw new Error("expected web");
    expect("logLocation" in web).toBe(false);
  });

  it("rejects an absolute log_location as CONFIG_INVALID", () => {
    const yaml = `
services:
  api:
    command: "node api.js"
    log_location: /var/log/api.log
`;
    expect(() => parseStack(yaml)).toThrow(/log_location/);
  });

  it("rejects a log_location that escapes the logs dir (contains ..) as CONFIG_INVALID", () => {
    const yaml = `
services:
  api:
    command: "node api.js"
    log_location: ../escape.log
`;
    expect(() => parseStack(yaml)).toThrow(/log_location/);
  });

  it("carries an inline log_configuration block through as an opaque record (no templating)", () => {
    // log_configuration rides the same opaque-record passthrough as shutdown —
    // devtrees never models its inner shape and never templates anything inside.
    const yaml = `
services:
  api:
    command: "node api.js"
    log_location: api.log
    log_configuration:
      rotation:
        max_size_mb: 10
        max_backups: 3
      disable_json: true
      future_field_devtrees_doesnt_know: 7
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.logConfiguration).toEqual({
      rotation: { max_size_mb: 10, max_backups: 3 },
      disable_json: true,
      future_field_devtrees_doesnt_know: 7,
    });
  });

  it("omits logConfiguration when the author didn't declare one", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
    log_location: web.log
`;
    const stack = parseStack(yaml);
    const web = stack.services[0];
    if (!web) throw new Error("expected web");
    expect("logConfiguration" in web).toBe(false);
  });

  it("uses the base's log fields when the overlay omits them; overlay wins when both set", () => {
    const devtrees = `
extends: ./process-compose.yaml
services:
  api:
    tier: isolated
  web:
    tier: isolated
    log_location: overlay-web.log
`;
    const base = `
processes:
  api:
    command: "node api.js"
    log_location: base-api.log
    log_configuration:
      disable_json: true
  web:
    command: "node server.js"
    log_location: base-web.log
`;
    const stack = parseStack(devtrees, { baseYaml: base });
    const byName = Object.fromEntries(stack.services.map((s) => [s.name, s]));
    expect(byName.api?.logLocation).toBe("base-api.log");
    expect(byName.api?.logConfiguration).toEqual({ disable_json: true });
    expect(byName.web?.logLocation).toBe("overlay-web.log");
  });
});

describe("stack model — depends_on parsing (process-compose map form)", () => {
  it("parses depends_on map form (name -> { condition }) into a name list", () => {
    // The canonical process-compose form is a map. Tier-aware deriving needs the
    // dependency *names*; conditions are preserved through the derived config later.
    const yaml = `
services:
  web:
    command: "node server.js"
    depends_on:
      postgres:
        condition: process_healthy
      redis:
        condition: process_started
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.dependsOn).toEqual(["postgres", "redis"]);
  });

  it("still accepts the array shorthand", () => {
    const yaml = `
services:
  web:
    command: "node server.js"
    depends_on: [postgres, redis]
`;
    const stack = parseStack(yaml);
    expect(stack.services[0]?.dependsOn).toEqual(["postgres", "redis"]);
  });
});

describe("stack model — cross-tier dependency validation (ADR-0003)", () => {
  it("rejects a shared service that depends_on an isolated service (load time)", () => {
    // A shared service is one instance; an isolated service is per-worktree. A
    // shared → isolated edge is undefined — which of N per-worktree copies?
    const yaml = `
services:
  postgres:
    tier: shared
    command: "postgres"
    depends_on: [web]
  web:
    tier: isolated
    command: "node server.js"
`;
    expect(() => parseStack(yaml)).toThrow(/shared.*depends_on.*isolated/i);
  });

  it("mentions both the offending service and the target in the error", () => {
    const yaml = `
services:
  cache:
    tier: shared
    command: "redis"
    depends_on: [api]
  api:
    tier: isolated
    command: "node api.js"
`;
    try {
      parseStack(yaml);
      throw new Error("expected parseStack to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("cache");
      expect(msg).toContain("api");
    }
  });

  it("allows shared → shared and isolated → shared edges", () => {
    const yaml = `
services:
  postgres:
    tier: shared
    command: "postgres"
  cache:
    tier: shared
    command: "redis"
    depends_on: [postgres]
  web:
    tier: isolated
    command: "node server.js"
    depends_on: [postgres, cache]
`;
    expect(() => parseStack(yaml)).not.toThrow();
  });

  it("allows isolated → isolated edges", () => {
    const yaml = `
services:
  api:
    tier: isolated
    command: "node api.js"
  web:
    tier: isolated
    command: "node server.js"
    depends_on: [api]
`;
    expect(() => parseStack(yaml)).not.toThrow();
  });
});

/**
 * Issue #130: namespace selection (`up -n`) is a launch-time filter on this
 * worktree's isolated instance; it cannot reach the shared singleton (a
 * repo-wide instance whose lifecycle is independent of any one worktree's
 * `up`, ADR-0001). A `namespace` on a shared service is therefore inert for
 * selection — the singleton runs it regardless — so it's rejected at
 * resolution time to surface the footgun loudly instead of silently.
 */
describe("stack model — shared-tier namespace rejection (issue #130)", () => {
  it("rejects a shared service that declares a namespace", () => {
    const yaml = `
services:
  postgres:
    tier: shared
    command: "postgres"
    namespace: local-backend
`;
    expect(() => parseStack(yaml)).toThrow(/namespace.*isolated/i);
  });

  it("rejects a shared service with an explicit namespace: default", () => {
    // No inert-but-allowed form: the rule is "no namespace key on a shared
    // service", with no special-casing for the implicit default namespace.
    const yaml = `
services:
  postgres:
    tier: shared
    command: "postgres"
    namespace: default
`;
    expect(() => parseStack(yaml)).toThrow(/namespace.*isolated/i);
  });

  it("names the offending service and points at the fix in the error", () => {
    const yaml = `
services:
  cache:
    tier: shared
    command: "redis"
    namespace: local-backend
`;
    try {
      parseStack(yaml);
      throw new Error("expected parseStack to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("cache");
      expect(msg).toMatch(/isolated/i);
    }
  });

  it("allows an isolated service with a namespace (no #128 regression)", () => {
    const yaml = `
services:
  api:
    tier: isolated
    command: "node api.js"
    namespace: local-backend
`;
    expect(() => parseStack(yaml)).not.toThrow();
    expect(parseStack(yaml).services[0]?.namespace).toBe("local-backend");
  });

  it("allows a shared service with no namespace", () => {
    const yaml = `
services:
  postgres:
    tier: shared
    command: "postgres"
`;
    expect(() => parseStack(yaml)).not.toThrow();
    const postgres = parseStack(yaml).services[0];
    if (!postgres) throw new Error("expected postgres");
    expect("namespace" in postgres).toBe(false);
  });
});

/**
 * Issue #84: CONFIG_INVALID must be reachable. Every config-rejection path —
 * cross-tier validation AND raw YAML parse failures — throws an error tagged
 * `code: "CONFIG_INVALID"`, so `classifyError` (src/output.ts) maps it into
 * the documented `--json` envelope instead of `UNKNOWN`.
 */
describe("stack model — CONFIG_INVALID error code (issue #84)", () => {
  function codeOf(fn: () => unknown): unknown {
    try {
      fn();
    } catch (err) {
      return (err as { code?: unknown }).code;
    }
    throw new Error("expected the callback to throw");
  }

  it("tags the cross-tier validation error with code CONFIG_INVALID", () => {
    const yaml = `
services:
  postgres:
    tier: shared
    command: "postgres"
    depends_on: [web]
  web:
    tier: isolated
    command: "node server.js"
`;
    expect(codeOf(() => parseStack(yaml))).toBe("CONFIG_INVALID");
  });

  it("tags the shared-namespace rejection (issue #130) with code CONFIG_INVALID", () => {
    const yaml = `
services:
  postgres:
    tier: shared
    command: "postgres"
    namespace: local-backend
`;
    expect(codeOf(() => parseStack(yaml))).toBe("CONFIG_INVALID");
  });

  it("tags a YAML parse failure with code CONFIG_INVALID and a message naming the parse error", () => {
    // Flow-sequence left unclosed — the yaml package raises YAMLParseError.
    const malformed = "services: [unclosed";
    expect(codeOf(() => parseStack(malformed))).toBe("CONFIG_INVALID");
    try {
      parseStack(malformed);
    } catch (err) {
      // The wrapped message must keep the underlying parser diagnostic so the
      // human/agent can locate the syntax error.
      expect((err as Error).message).toMatch(/devtrees\.yaml/i);
      expect((err as Error).message.length).toBeGreaterThan("CONFIG_INVALID".length);
    }
  });

  it("tags a parse failure in the extends base file with code CONFIG_INVALID", () => {
    const yaml = "services: {}";
    const badBase = "processes: [unclosed";
    expect(codeOf(() => parseStack(yaml, { baseYaml: badBase }))).toBe("CONFIG_INVALID");
  });

  it("loadStack: a malformed devtrees.yaml on disk throws code CONFIG_INVALID", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "devtrees.yaml"), "services:\n  web: [::bad\n");
    expect(codeOf(() => loadStack(dir))).toBe("CONFIG_INVALID");
  });
});
