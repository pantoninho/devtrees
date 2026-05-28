import { describe, expect, it } from "vite-plus/test";
import {
  MissingProcessComposeError,
  buildUpArgs,
  buildDownArgs,
  buildAttachArgs,
  createDriver,
} from "./driver.js";

describe("process-compose driver — argv construction", () => {
  const inst = {
    configPath: "/anchor/devtrees/login.yaml",
    socketPath: "/anchor/devtrees/run/login.sock",
  };

  it("starts an instance detached, over its UDS, with the TUI disabled", () => {
    const args = buildUpArgs(inst);
    expect(args).toContain("up");
    expect(args).toContain("-f");
    expect(args).toContain("/anchor/devtrees/login.yaml");
    // unix domain socket control plane (ADR-0001)
    expect(args).toContain("-U");
    expect(args).toContain("-u");
    expect(args).toContain("/anchor/devtrees/run/login.sock");
    // the background server must not grab the terminal
    expect(args).toContain("-t=false");
  });

  it("stops an instance by talking to its UDS", () => {
    const args = buildDownArgs(inst);
    expect(args).toContain("down");
    expect(args).toContain("-U");
    expect(args.join(" ")).toContain("/anchor/devtrees/run/login.sock");
  });

  it("attaches a TUI to an instance over its UDS", () => {
    const args = buildAttachArgs(inst);
    expect(args).toContain("attach");
    expect(args).toContain("-U");
    expect(args.join(" ")).toContain("/anchor/devtrees/run/login.sock");
  });
});

describe("process-compose driver — missing binary", () => {
  it("MissingProcessComposeError carries an actionable, named message", () => {
    const err = new MissingProcessComposeError("process-compose");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/process-compose/);
    expect(err.message).toMatch(/install|PATH/i);
  });

  it("up() refuses to spawn and surfaces the error when the binary is absent", async () => {
    let spawned = false;
    const driver = createDriver({
      exists: () => Promise.resolve(false),
      spawner: () => {
        spawned = true;
        return { on: () => {}, unref: () => {} };
      },
    });
    await expect(
      driver.up({ configPath: "/x.yaml", socketPath: "/x.sock" }),
    ).rejects.toBeInstanceOf(MissingProcessComposeError);
    expect(spawned).toBe(false);
  });
});
