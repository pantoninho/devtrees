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
});
