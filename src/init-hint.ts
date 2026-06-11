/**
 * The agent-onboarding hint for `devtrees up` (issue #119).
 *
 * If a developer never ran `devtrees init --agents` (#118), an agent driving
 * the stack still has no in-repo pointer to the non-interactive workflow. This
 * module decides whether `up` should surface a one-line, non-fatal hint
 * pointing at that command, and produces the line itself.
 *
 * The hint is deliberately narrow (the decided design in #119):
 *
 *   - It is written to **stderr**, never to the `--json` stdout envelope — the
 *     stdout document is the `schema_version: "1"` contract agents parse, and a
 *     hint field there would be a schema change and per-call noise (ADR-0005).
 *   - It fires only in an **agent context** (neither stdout nor stderr is a
 *     TTY — the same detection `up` uses to skip the TUI) AND only when the
 *     repo has **no agent-instructions file referencing devtrees**. A repo that
 *     already carries the onboarding block (or otherwise mentions devtrees in
 *     `AGENTS.md`/`CLAUDE.md`) stays silent.
 *   - It never changes exit code or blocks — the caller emits it as a
 *     side-effect after a successful `up` and ignores any failure.
 *
 * The predicate (`shouldHintInit`) is pure so the TTY × doc-present matrix is
 * unit-testable without booting a command; the filesystem read lives in
 * `agentDocReferencesDevtrees` / `maybeInitHint`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TARGET_CANDIDATES } from "./onboarding.js";

/**
 * The one-line hint, written to stderr. Names `devtrees init --agents` so an
 * agent reading its captured log can run the command (or surface it to the
 * human) without bouncing through docs. A leading `devtrees:` namespaces it
 * the same way every other diagnostic line on stderr is namespaced.
 */
export const INIT_HINT_LINE =
  "devtrees: no agent-instructions file references devtrees. " +
  "Run `devtrees init --agents` to write the onboarding block into AGENTS.md/CLAUDE.md " +
  "so coding agents drive the stack non-interactively.";

/**
 * Pure gating predicate for the `up` init-hint (#119). Fire only when BOTH:
 *
 *   - `isTTY` is false — an agent context (neither stdout nor stderr is a
 *     terminal). A human at a terminal sees the TUI and doesn't need the hint.
 *   - `agentDocReferencesDevtrees` is false — no `AGENTS.md`/`CLAUDE.md` already
 *     mentions devtrees, so onboarding looks absent.
 *
 * Kept side-effect-free so the full matrix is exercised in a unit test without
 * touching the filesystem or a real `up`.
 */
export function shouldHintInit(args: {
  readonly isTTY: boolean;
  readonly agentDocReferencesDevtrees: boolean;
}): boolean {
  return !args.isTTY && !args.agentDocReferencesDevtrees;
}

/**
 * Does any agent-instructions file in `cwd` reference devtrees? Walks the same
 * `AGENTS.md`/`CLAUDE.md` candidates `init --agents` targets (`TARGET_CANDIDATES`)
 * and returns true as soon as one exists and contains the word `devtrees`
 * (case-insensitively) — which covers both the managed `<!-- devtrees:start -->`
 * block and any hand-written mention. A missing file, or one that exists but
 * never mentions devtrees, contributes nothing — so a repo with an empty
 * `CLAUDE.md` of unrelated house rules still gets the hint.
 *
 * Best-effort: a read error (permissions, a directory where a file was
 * expected) is treated as "no reference" rather than throwing, so the hint
 * path can never fail an otherwise-healthy `up`.
 */
export function agentDocReferencesDevtrees(cwd: string): boolean {
  for (const candidate of TARGET_CANDIDATES) {
    const path = join(cwd, candidate);
    if (!existsSync(path)) continue;
    try {
      if (readFileSync(path, "utf8").toLowerCase().includes("devtrees")) return true;
    } catch {
      // Unreadable candidate: ignore it and keep scanning the rest.
    }
  }
  return false;
}

/**
 * Compose the filesystem probe and the pure predicate into the line `up`
 * should emit, or `undefined` when the hint is gated off. The single entry
 * point the CLI calls after a successful `up`.
 */
export function maybeInitHint(args: {
  readonly cwd: string;
  readonly isTTY: boolean;
}): string | undefined {
  const referenced = agentDocReferencesDevtrees(args.cwd);
  return shouldHintInit({ isTTY: args.isTTY, agentDocReferencesDevtrees: referenced })
    ? INIT_HINT_LINE
    : undefined;
}
