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

\`devtrees up\` is safe to call defensively before every test run. On a stack
that is already running it hot-reloads changed config, **restarts** any
selected service that has died, then waits (up to \`--wait-timeout\`) for every
selected service to be healthy and exits 0 only then — immediately when all
are. It never stops anything, and never attaches the TUI.

- A bare \`up\` checks the namespaces the stack was booted with. \`-n\` checks
  exactly the namespaces it names; a narrower \`-n\` leaves the rest running
  and restarts nothing outside it.
- \`-n\` cannot add a namespace the running stack was not booted with: \`up\`
  fails with \`NAMESPACE_NOT_RUNNING\`. Boot with it: \`devtrees down && devtrees
  up -n …\` (the message names the exact command).
- A dead selected service (crashed, killed, or exited non-zero) is started
  again, and \`up\` names it (\`restarted\` in the \`--json\` envelope). Several
  dead services are started in \`depends_on\` order, without waiting between
  them. If one does not become healthy, or dies again, \`up\` fails with
  \`HEALTH_TIMEOUT\` naming it; if process-compose refuses to start it, with
  \`SERVICE_START_FAILED\`. The stack is left running either way. A one-shot
  that exited 0 counts as done and is not rerun.
- \`up\` and \`down\` on the same worktree take turns. An \`up\` that finds the
  stack stopped by a concurrent \`down\` starts nothing and fails with
  \`INSTANCE_NOT_FOUND\`; one that waits too long for the other fails with
  \`LOCK_CONTENTION\`. Either way, run \`devtrees up\` again.
- A dead shared service fails \`up\` with \`SHARED_SERVICE_DEAD\`; run
  \`devtrees down --shared && devtrees up\`.

### Handling failures

With \`--json\`, every command emits a single JSON document on **stdout** and
exits non-zero on failure: \`{"error":{"code":"…","message":"…","details":{…}}}\`.
Branch on \`error.code\`:

| Code                        | What it means and what to do                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| \`LOCK_CONTENTION\`           | Another devtrees process holds a lock. Wait briefly and **retry** \`up\`/\`down\`.               |
| \`HEALTH_TIMEOUT\`            | A service never reported ready, or is still dead after \`up\` restarted it (\`details.dead_services\`). The stack is **left running** — read \`devtrees logs <service> --tail=N\` to see why, then retry or follow the message (\`devtrees down && devtrees up …\`). |
| \`NAMESPACE_NOT_RUNNING\`     | You asked \`-n\` for a namespace the running stack was not booted with. Run \`details.remedy\` (\`devtrees down && devtrees up -n …\`). |
| \`SHARED_SERVICE_DEAD\`       | A shared service is dead. devtrees will not restart it from one worktree; run \`devtrees down --shared && devtrees up\`. |
| \`SERVICE_START_FAILED\`      | \`up\` tried to restart a dead service and process-compose refused. \`details.services\` carries each one with process-compose's message; read it, then run \`details.remedy\` (\`devtrees down && devtrees up …\`). |
| \`STALE_PORT_BLOCK\`          | Foreign listeners hold this worktree's ports. \`details.collisions[]\` lists \`{port_name, port, pid, command}\`; kill the orphans and retry. |
| \`SHARED_DRIFT\`              | This worktree's shared services diverge from the running shared instance. Follow the message: \`devtrees down --shared && devtrees up\`. |
| \`CONFIG_DRIFT\`              | The running config differs from \`devtrees.yaml\` and hot-reload failed. Branch on \`details.reason\`: \`not_supported\`/\`error\` → \`devtrees down && devtrees up\`. \`timeout\` → a changed service's old process won't stop and \`down\` would hang too: do **not** re-run \`up\` (it starts an untracked second copy); kill that process, then run \`devtrees up\` again to resync. |
| \`SERVICE_NOT_FOUND\`         | You named a service that isn't in the instance. \`details.valid_services\` lists the real names; pick one. |
| \`NO_SERVICES_SELECTED\`      | A bare \`up\` starts only services with no \`namespace:\`, and there are none. \`details.namespaces\` lists the namespaces; retry with \`devtrees up -n <ns>\`. |
| \`INSTANCE_NOT_FOUND\`        | No instance is running for this worktree. Run \`devtrees up\` first.                            |
| \`INSTANCE_UNRESPONSIVE\`     | The instance may be running but its process-compose did not answer (busy or frozen). Nothing changed. **Retry** in a moment; if it persists, follow \`details.remedy\`. Do not delete the socket by hand. |
| \`PROCESS_COMPOSE_NOT_FOUND\` | The \`process-compose\` binary is missing. **Surface this to the human** — it's an environment setup gap you can't fix.   |
| \`PROCESS_COMPOSE_TOO_OLD\`   | The installed \`process-compose\` is below the minimum (v1.122.0). **Surface this to the human** — they need to upgrade it. |
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
