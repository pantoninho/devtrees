import { describe, expect, it } from "vite-plus/test";
import { parseStack } from "./stack.js";

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
