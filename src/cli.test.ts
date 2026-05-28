import { describe, expect, it, vi } from "vite-plus/test";
import { execute, run } from "./cli.js";

describe("devtrees CLI", () => {
  it("prints the version with --version", () => {
    const result = run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("aliases -v to --version", () => {
    expect(run(["-v"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists the commands with --help", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("devtrees");
    expect(result.stdout).toContain("Usage");
    // the stubbed command surface from the PRD
    for (const cmd of ["up", "down", "ls", "attach", "generate"]) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it("aliases -h to --help", () => {
    expect(run(["-h"]).stdout).toContain("Usage");
  });

  it("prints help and exits 0 when given no arguments", () => {
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage");
  });

  it("errors on an unknown command", () => {
    const result = run(["frobnicate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("frobnicate");
  });
});

describe("devtrees CLI — execute (effectful dispatch)", () => {
  it("routes `up` to the up command and reports the resolved port", async () => {
    const up = vi.fn().mockResolvedValue({
      worktreeId: "login",
      socketPath: "/x.sock",
      env: { WEB_PORT: "20512" },
    });
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(up).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("login");
    expect(result.stdout).toContain("WEB_PORT");
  });

  it("routes `down` to the down command with shared=false by default", async () => {
    const down = vi.fn().mockResolvedValue(undefined);
    const result = await execute(["down"], { up: vi.fn(), down });
    expect(down).toHaveBeenCalledWith({ shared: false });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("worktree instance stopped");
  });

  it("passes shared=true through when --shared is given", async () => {
    const down = vi.fn().mockResolvedValue(undefined);
    const result = await execute(["down", "--shared"], { up: vi.fn(), down });
    expect(down).toHaveBeenCalledWith({ shared: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("shared instance stopped");
  });

  it("notes when up triggered a shared lazy start", async () => {
    const up = vi.fn().mockResolvedValue({
      worktreeId: "login",
      socketPath: "/x.sock",
      env: { WEB_PORT: "20512", DB_PORT: "19000" },
      sharedStarted: true,
    });
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(result.stdout).toContain("shared instance started");
  });

  it("turns a missing process-compose binary into a clear, non-zero error", async () => {
    const up = vi.fn().mockRejectedValue(new Error("process-compose not found. ... install"));
    const result = await execute(["up"], { up, down: vi.fn() });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/process-compose/);
  });

  it("delegates non-effectful commands to the pure run()", async () => {
    const result = await execute(["--version"], { up: vi.fn(), down: vi.fn() });
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
