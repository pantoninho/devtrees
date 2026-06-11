/**
 * Unit coverage for the `up` init-hint gating (#119) — the predicate matrix and
 * the filesystem probe, exercised without booting a command.
 *
 * The hint fires only in an agent context (`isTTY: false`) when no
 * agent-instructions file references devtrees; every other cell of the TTY ×
 * doc-present/absent/with-devtrees matrix stays silent.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INIT_HINT_LINE,
  agentDocReferencesDevtrees,
  maybeInitHint,
  shouldHintInit,
} from "./init-hint.js";
import { fencedBlock } from "./onboarding.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dt-hint-"));
  dirs.push(dir);
  return dir;
}

describe("shouldHintInit — pure gating predicate (#119)", () => {
  it("fires only in a non-TTY context with no devtrees-referencing doc", () => {
    expect(shouldHintInit({ isTTY: false, agentDocReferencesDevtrees: false })).toBe(true);
  });

  it("stays silent in a TTY context regardless of the doc", () => {
    expect(shouldHintInit({ isTTY: true, agentDocReferencesDevtrees: false })).toBe(false);
    expect(shouldHintInit({ isTTY: true, agentDocReferencesDevtrees: true })).toBe(false);
  });

  it("stays silent when a doc already references devtrees, even non-TTY", () => {
    expect(shouldHintInit({ isTTY: false, agentDocReferencesDevtrees: true })).toBe(false);
  });
});

describe("agentDocReferencesDevtrees — filesystem probe (#119)", () => {
  it("returns false when no agent-instructions file exists", () => {
    expect(agentDocReferencesDevtrees(tmp())).toBe(false);
  });

  it("returns false for a doc that never mentions devtrees", () => {
    const dir = tmp();
    writeFileSync(join(dir, "CLAUDE.md"), "# House rules\n\nBe concise.\n");
    expect(agentDocReferencesDevtrees(dir)).toBe(false);
  });

  it("returns true when AGENTS.md carries the managed devtrees block", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), `# Top\n\n${fencedBlock()}`);
    expect(agentDocReferencesDevtrees(dir)).toBe(true);
  });

  it("returns true for a hand-written devtrees mention (no marker)", () => {
    const dir = tmp();
    writeFileSync(join(dir, "CLAUDE.md"), "We use Devtrees to run the stack.\n");
    expect(agentDocReferencesDevtrees(dir)).toBe(true);
  });

  it("checks CLAUDE.md when AGENTS.md is absent", () => {
    const dir = tmp();
    writeFileSync(join(dir, "CLAUDE.md"), `${fencedBlock()}`);
    expect(agentDocReferencesDevtrees(dir)).toBe(true);
  });
});

describe("maybeInitHint — composed decision (#119)", () => {
  it("emits the hint line in an agent context with no devtrees doc", () => {
    expect(maybeInitHint({ cwd: tmp(), isTTY: false })).toBe(INIT_HINT_LINE);
    expect(INIT_HINT_LINE).toContain("devtrees init --agents");
  });

  it("stays silent in a TTY context", () => {
    expect(maybeInitHint({ cwd: tmp(), isTTY: true })).toBeUndefined();
  });

  it("stays silent when a doc already references devtrees", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), `# Top\n\n${fencedBlock()}`);
    expect(maybeInitHint({ cwd: dir, isTTY: false })).toBeUndefined();
  });
});
