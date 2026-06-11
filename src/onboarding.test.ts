/**
 * Single-source-of-truth pins for the coding-agent onboarding block (#118).
 *
 * The README "Using devtrees from a coding agent" section and the
 * `devtrees init --agents` generator must emit the SAME text — otherwise the
 * pasted-by-hand README block and the generated one drift, which is exactly the
 * failure issue #118 set out to kill. This suite pins the README's fenced block
 * to `ONBOARDING_BLOCK` so editing one without the other fails CI, and exercises
 * the pure fence-upsert surface `runInit` builds on.
 */
import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MARKER_END,
  MARKER_START,
  ONBOARDING_BLOCK,
  fencedBlock,
  upsertBlock,
} from "./onboarding.js";

const README = fileURLToPath(new URL("../README.md", import.meta.url));

/**
 * Pull the body of the first ````markdown … ```` fenced code block out of the
 * README. The onboarding section quotes the canonical block inside such a fence;
 * we compare its body, not the surrounding prose, to `ONBOARDING_BLOCK`.
 */
function readmeOnboardingBlock(): string {
  const readme = readFileSync(README, "utf8");
  const open = "````markdown\n";
  const startIdx = readme.indexOf(open);
  if (startIdx === -1) throw new Error("README: no ````markdown fenced block found");
  const bodyStart = startIdx + open.length;
  const closeIdx = readme.indexOf("\n````", bodyStart);
  if (closeIdx === -1) throw new Error("README: unterminated ````markdown fence");
  // Body is everything up to and including the newline before the closing fence.
  return readme.slice(bodyStart, closeIdx + 1);
}

describe("onboarding single source of truth", () => {
  it("README quotes ONBOARDING_BLOCK verbatim (no drift)", () => {
    expect(readmeOnboardingBlock()).toBe(ONBOARDING_BLOCK);
  });

  it("the canonical block ends with a single trailing newline", () => {
    expect(ONBOARDING_BLOCK.endsWith("\n")).toBe(true);
    expect(ONBOARDING_BLOCK.endsWith("\n\n")).toBe(false);
  });
});

describe("fence upsert", () => {
  it("wraps the block in start/end markers", () => {
    const fenced = fencedBlock();
    expect(fenced.startsWith(`${MARKER_START}\n`)).toBe(true);
    expect(fenced.endsWith(`${MARKER_END}\n`)).toBe(true);
    expect(fenced).toContain(ONBOARDING_BLOCK);
  });

  it("appends the block to existing content with one blank-line separator", () => {
    const out = upsertBlock("# My project\n", fencedBlock());
    expect(out).toBe(`# My project\n\n${fencedBlock()}`);
  });

  it("writes the block as the whole file when content is empty", () => {
    expect(upsertBlock("", fencedBlock())).toBe(fencedBlock());
  });

  it("replaces an existing managed region in place, never duplicating", () => {
    const initial = upsertBlock("# Project\n", fencedBlock());
    const reran = upsertBlock(initial, fencedBlock());
    expect(reran).toBe(initial);
    // Exactly one marker pair survives the re-run.
    expect(reran.split(MARKER_START).length - 1).toBe(1);
    expect(reran.split(MARKER_END).length - 1).toBe(1);
  });

  it("preserves surrounding content when replacing the region", () => {
    const withTail = `# Top\n\n${fencedBlock()}\n## Footer\n`;
    const reran = upsertBlock(withTail, fencedBlock());
    expect(reran.startsWith("# Top\n\n")).toBe(true);
    expect(reran.endsWith("## Footer\n")).toBe(true);
    expect(reran.split(MARKER_START).length - 1).toBe(1);
  });
});
