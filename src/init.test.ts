/**
 * `runInit` — target-file detection + idempotent fenced-block write (#118).
 *
 * Unit-level coverage of the orchestration `devtrees init --agents` performs in
 * a consuming repo: pick the target file (existing `AGENTS.md` wins, else
 * `CLAUDE.md`, else create `AGENTS.md`), write the canonical onboarding block
 * between its markers, and report created-vs-updated so the CLI's `--json`
 * envelope can name what happened. Re-running must replace the block in place,
 * never duplicate it.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./commands.js";
import { MARKER_END, MARKER_START, ONBOARDING_BLOCK } from "./onboarding.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dt-init-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("runInit target detection", () => {
  it("creates AGENTS.md when neither file exists", async () => {
    const cwd = tmp();
    const result = await runInit({ cwd });
    expect(result.target).toBe("AGENTS.md");
    expect(result.action).toBe("created");
    expect(result.path).toBe(join(cwd, "AGENTS.md"));
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(body).toContain(MARKER_START);
    expect(body).toContain(MARKER_END);
    expect(body).toContain(ONBOARDING_BLOCK);
  });

  it("prefers an existing AGENTS.md", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "# Existing\n");
    const result = await runInit({ cwd });
    expect(result.target).toBe("AGENTS.md");
    expect(result.action).toBe("updated");
    const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(body.startsWith("# Existing\n")).toBe(true);
    expect(body).toContain(ONBOARDING_BLOCK);
  });

  it("falls back to an existing CLAUDE.md when AGENTS.md is absent", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.md"), "# Claude rules\n");
    const result = await runInit({ cwd });
    expect(result.target).toBe("CLAUDE.md");
    expect(result.action).toBe("updated");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    const body = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(body.startsWith("# Claude rules\n")).toBe(true);
    expect(body).toContain(ONBOARDING_BLOCK);
  });

  it("prefers AGENTS.md over CLAUDE.md when both exist", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "# Claude\n");
    const result = await runInit({ cwd });
    expect(result.target).toBe("AGENTS.md");
    const claude = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toBe("# Claude\n"); // untouched
  });
});

describe("runInit idempotency", () => {
  it("replaces the block in place on re-run — no duplication", async () => {
    const cwd = tmp();
    const first = await runInit({ cwd });
    expect(first.action).toBe("created");
    const afterFirst = readFileSync(join(cwd, "AGENTS.md"), "utf8");

    const second = await runInit({ cwd });
    expect(second.action).toBe("updated");
    const afterSecond = readFileSync(join(cwd, "AGENTS.md"), "utf8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.split(MARKER_START).length - 1).toBe(1);
    expect(afterSecond.split(MARKER_END).length - 1).toBe(1);
  });

  it("keeps surrounding content when re-running against an edited file", async () => {
    const cwd = tmp();
    await runInit({ cwd });
    const path = join(cwd, "AGENTS.md");
    writeFileSync(path, `# House rules\n\n${readFileSync(path, "utf8")}\n## Footer\n`);
    await runInit({ cwd });
    const body = readFileSync(path, "utf8");
    expect(body.startsWith("# House rules\n")).toBe(true);
    expect(body.includes("## Footer")).toBe(true);
    expect(body.split(MARKER_START).length - 1).toBe(1);
  });
});
