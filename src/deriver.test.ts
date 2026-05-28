import { describe, expect, it } from "vite-plus/test";
import { deriveWorktreeConfig } from "./deriver.js";
import type { ResolvedStack } from "./stack.js";

const stack: ResolvedStack = {
  services: [
    {
      name: "web",
      tier: "isolated",
      command: "node server.js",
      ports: ["WEB_PORT"],
      dependsOn: [],
      environment: ["LOG_LEVEL=debug"],
    },
  ],
};

describe("config deriver — isolated worktree instance", () => {
  const derived = deriveWorktreeConfig(stack, {
    worktreeId: "login",
    worktreeRoot: "/home/me/wt/login",
    portFor: (name) => (name === "WEB_PORT" ? 20512 : undefined),
  });
  const web = derived.config.processes.web;
  if (web === undefined) throw new Error("expected a derived 'web' process");

  it("injects each named port as exactly its env-var name (no mangling)", () => {
    expect(derived.env.WEB_PORT).toBe("20512");
  });

  it("injects the worktree id for de-colliding global names", () => {
    expect(derived.env.DEVTREES_WORKTREE_ID).toBe("login");
  });

  it("partitions in only isolated services and strips the tier key", () => {
    expect("tier" in web).toBe(false);
  });

  it("sets working_dir to the worktree root so relative paths stay worktree-local", () => {
    expect(web.working_dir).toBe("/home/me/wt/login");
  });

  it("carries the injected port and worktree id into the process environment", () => {
    expect(web.environment).toContain("WEB_PORT=20512");
    expect(web.environment).toContain("DEVTREES_WORKTREE_ID=login");
    // author-declared env survives untouched
    expect(web.environment).toContain("LOG_LEVEL=debug");
  });

  it("references the port verbatim as ${NAME} in the command, leaving it for the env", () => {
    // the deriver never rewrites the command (ADR-0002)
    expect(web.command).toBe("node server.js");
  });

  it("excludes shared services from the worktree instance", () => {
    const mixed: ResolvedStack = {
      services: [
        ...stack.services,
        {
          name: "postgres",
          tier: "shared",
          command: "postgres",
          ports: ["DB_PORT"],
          dependsOn: [],
          environment: [],
        },
      ],
    };
    const out = deriveWorktreeConfig(mixed, {
      worktreeId: "login",
      worktreeRoot: "/home/me/wt/login",
      portFor: () => 20512,
    });
    expect(Object.keys(out.config.processes)).toEqual(["web"]);
  });
});
