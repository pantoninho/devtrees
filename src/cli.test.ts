import { describe, expect, it } from "vitest";
import { run } from "./cli.js";

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
