/**
 * The canonical coding-agent onboarding block — the single in-repo source of
 * truth for the instructions a consuming repo pastes into its agent-instructions
 * file (issue #118).
 *
 * Two surfaces consume this constant so they cannot drift:
 *
 *   - `devtrees init --agents` writes `ONBOARDING_BLOCK` into the consuming
 *     repo's `AGENTS.md` / `CLAUDE.md`, fenced by the markers below so re-runs
 *     replace it in place rather than appending.
 *   - the README "Using devtrees from a coding agent" section quotes this exact
 *     text inside a fenced code block; `onboarding.test.ts` pins README↔constant
 *     agreement so editing one without the other fails CI.
 *
 * The block is agent-agnostic — plain instructions about the devtrees CLI, valid
 * as `AGENTS.md` / `CLAUDE.md` content for any coding agent.
 */

/**
 * Opening marker devtrees writes around its managed block. Re-running
 * `init --agents` finds this fence (and {@link MARKER_END}) and replaces
 * everything between them, so the block is never duplicated or appended twice.
 * HTML comments so the marker is invisible in rendered markdown.
 */
export const MARKER_START = "<!-- devtrees:start -->";

/** Closing marker — see {@link MARKER_START}. */
export const MARKER_END = "<!-- devtrees:end -->";

/**
 * The canonical onboarding text. Quoted verbatim by the README's
 * "Using devtrees from a coding agent" section (pinned by `onboarding.test.ts`)
 * and written between {@link MARKER_START}/{@link MARKER_END} by
 * `devtrees init --agents`.
 */
export const ONBOARDING_BLOCK = `## Running the stack with devtrees

This worktree's services run under [devtrees](https://github.com/pantoninho/devtrees),
which gives every git worktree its own collision-free port block. Drive it
non-interactively — never attach the TUI:

\`\`\`bash
# 1. Bring the stack up and wait for health. In a non-TTY context (an agent
#    shell) \`up\` skips the TUI and blocks until every probed service reports
#    health: ready, then exits. \`--json\` prints the success envelope — the
#    allocated ports, per-service rows, and the injected env map — on stdout.
devtrees up --json

# 2. Load this worktree's injected ports/URLs into the environment. \`devtrees
#    env\` prints \`KEY=value\` lines (use \`--json\` for a map); eval makes them
#    available to your test command.
eval "$(devtrees env)"

# 3. Run the project's tests/build against the running stack.
<your test command>   # e.g. npm test

# 4. On failure, read a service's recent logs. Without \`--follow\`, \`logs\`
#    prints the buffered tail and exits — safe in a non-interactive shell.
devtrees logs <service> --tail=200

# 5. Tear the stack down when done. Re-running \`down\` on an already-stopped
#    instance is a no-op and still exits 0.
devtrees down
\`\`\`

\`devtrees up\` is idempotent: calling it when the stack is already running
reconciles config (hot-reloading on change) instead of erroring, so it's safe
to call defensively before every test run rather than tracking whether the
stack is up.

### Handling failures

With \`--json\`, every command emits a single JSON document on **stdout** and
exits non-zero on failure: \`{"error":{"code":"…","message":"…","details":{…}}}\`.
Branch on \`error.code\`:

| Code                        | What it means and what to do                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| \`LOCK_CONTENTION\`           | Another devtrees process holds a lock. Wait briefly and **retry** \`up\`/\`down\`.               |
| \`HEALTH_TIMEOUT\`            | A service never reported ready. The stack is **left running** — read \`devtrees logs <service> --tail=N\` to see why, then retry or \`down\`. |
| \`STALE_PORT_BLOCK\`          | Foreign listeners hold this worktree's ports. \`details.collisions[]\` lists \`{port_name, port, pid, command}\`; kill the orphans and retry. |
| \`SHARED_DRIFT\`              | This worktree's shared services diverge from the running shared instance. Follow the message: \`devtrees down --shared && devtrees up\`. |
| \`CONFIG_DRIFT\`              | The running config differs from \`devtrees.yaml\` and hot-reload failed. Follow the message — usually \`devtrees down && devtrees up\`. |
| \`SERVICE_NOT_FOUND\`         | You named a service that isn't in the instance. \`details.valid_services\` lists the real names; pick one. |
| \`INSTANCE_NOT_FOUND\`        | No instance is running for this worktree. Run \`devtrees up\` first.                            |
| \`PROCESS_COMPOSE_NOT_FOUND\` | The \`process-compose\` binary is missing. **Surface this to the human** — it's an environment setup gap you can't fix.   |
| \`CONFIG_INVALID\` / \`INVALID_ARGS\` | The config or your arguments are malformed. Fix the input; don't retry blindly.        |

For the full error enum and the per-command subset each can emit, run
\`devtrees <cmd> --help\` or see devtrees' README.
`;

/**
 * Candidate target filenames for `init --agents`, in preference order:
 * an existing `AGENTS.md` wins, else an existing `CLAUDE.md`, else create
 * `AGENTS.md` (the first entry). Order matters — `detectTarget` walks it.
 */
export const TARGET_CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Wrap the canonical block in its fence markers, as written into a target file.
 * A trailing newline keeps the fence on its own final line. Exported so both
 * the writer and its tests build the managed region identically.
 */
export function fencedBlock(): string {
  return `${MARKER_START}\n${ONBOARDING_BLOCK}${MARKER_END}\n`;
}

/**
 * Replace an existing devtrees-managed region (between the markers) in `content`
 * with `replacement`, or — when no region exists — append `replacement`,
 * separated from prior content by a blank line. Idempotent: a file already
 * carrying the block has exactly that region swapped, never duplicated.
 *
 * Pure string surgery so it is trivially unit-testable; the filesystem read /
 * write lives in `runInit` (commands.ts).
 */
export function upsertBlock(content: string, replacement: string): string {
  const start = content.indexOf(MARKER_START);
  const end = content.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = content.slice(0, start);
    const after = content.slice(end + MARKER_END.length);
    // Drop a single leading newline left on `after` so re-runs don't accrete
    // blank lines after the fence.
    const tail = after.startsWith("\n") ? after.slice(1) : after;
    return `${before}${replacement}${tail}`;
  }
  if (content.length === 0) return replacement;
  // Append to existing content, guaranteeing exactly one blank line between the
  // prior content and the managed block.
  const base = content.endsWith("\n") ? content : `${content}\n`;
  const separated = base.endsWith("\n\n") ? base : `${base}\n`;
  return `${separated}${replacement}`;
}
