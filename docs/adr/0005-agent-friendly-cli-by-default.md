# Agent-friendly CLI by default

Coding agents are a first-class user of devtrees alongside human developers. Rather than gate agent ergonomics behind a mode flag, the CLI degrades gracefully based on context: `devtrees up` auto-detects TTY and skips TUI attachment when none is present, every command that emits structured data accepts a global `--json` flag, and new commands (`devtrees env`, `devtrees logs`) cover the gaps that the TUI-first surface left for non-interactive operators.

## Considered Options

Two choices in this surface are worth recording because a future contributor will see them and want to "fix" them:

- **`--json` errors are emitted on stdout, not stderr.** The Unix idiom is errors on stderr, but `--json` is an agent-facing contract: the agent reads one stream, parses one document, branches on `error.code`. Stderr stays available for human-readable diagnostics; the structured envelope (`{"error": {"code", "message", "details"}}`) is always on stdout when `--json` is set. The alternative (errors on stderr) forces agents to capture and merge two streams to handle failure.

- **`devtrees up` leaves the stack running when health-wait times out.** The atomic alternative (tear down on failure) gives cleaner semantics but destroys the debug surface — the agent loses access to the logs of *why* startup failed. Leaving the stack up means `devtrees logs <service>` and `devtrees ls --json` still work after a `HEALTH_TIMEOUT` exit, and the agent can decide whether to retry, debug, or `down`. Default timeout is 120s, overridable with `--wait-timeout`.

## Consequences

- The CLI has no "agent mode" — behavior is driven by TTY detection and explicit flags. This keeps the human-facing surface unchanged and avoids a flag the agent must remember to set on every invocation.
- `--json` output shapes are a stable contract **once devtrees declares the agent surface stable** (target: `v0.1.0` / first published agent release). Until then, the project is in walking-skeleton mode and shape changes don't require a `schema_version` bump — `"1"` is a placeholder for "draft v1, expect breaking changes." Once the surface is declared stable, the first real consumer migration becomes the trigger for `schema_version: "2"`, and subsequent breaking changes require a bump. While pre-stable, breaking changes are documented in CHANGELOG / release notes, not the version field — this keeps the version field a faithful signal that a real migration is required whenever it changes.
- Error codes (`PROCESS_COMPOSE_NOT_FOUND`, `CONFIG_INVALID`, `LOCK_CONTENTION`, `HEALTH_TIMEOUT`, `CONFIG_DRIFT`, `INSTANCE_NOT_FOUND`, …) are part of that contract; new codes are additive, renames are breaking.
