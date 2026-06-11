# devtrees

Run a project's [process-compose](https://github.com/F1bonacc1/process-compose)
stack across multiple git worktrees without collision.

devtrees is a thin layer over process-compose. You configure a project once in a
`devtrees.yaml` and mark each service `isolated` (a separate copy per worktree)
or `shared` (one instance for the whole repo). From inside any worktree,
`devtrees up` brings up that worktree's stack with auto-allocated, collision-free
ports injected as environment variables. See [the PRD](https://github.com/pantoninho/devtrees/issues/1)
for the full vision.

## Requirements

- **Node.js** >= 22
- **`process-compose`** — devtrees shells out to the external `process-compose`
  binary; it does not embed it. You must have `process-compose` installed and on
  your `PATH`. See the [process-compose installation guide](https://f1bonacc1.github.io/process-compose/installation/).

## Install

```bash
npm install -g devtrees
```

## Usage

```bash
devtrees --help        # list commands
devtrees --version     # print the version
devtrees <cmd> --help  # per-command flags, examples, and emittable error codes
```

Commands (from the exported `COMMANDS` manifest in [`src/cli.ts`](src/cli.ts)):

| Command             | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `devtrees up`       | Bring up this worktree's stack                                            |
| `devtrees down`     | Stop this worktree's stack (`--shared` tears down the shared instance)    |
| `devtrees ls`       | List every instance across the repo with status and ports                 |
| `devtrees attach`   | Attach a TUI to this worktree's instance (`--shared` for the shared one)  |
| `devtrees generate` | Write the derived process-compose config to disk                          |
| `devtrees prune`    | Reconcile against `git worktree list` and clean up orphaned instances     |
| `devtrees env`      | Print this worktree's injected env (KEY=value, or `--json` for a map)     |
| `devtrees logs`     | Stream a service's logs (`--follow`, `--tail=N`, `--since=DUR`, `--all`, `--shared`) |

Flag highlights (run `devtrees <cmd> --help` for the full per-command surface):

- `devtrees up` accepts `--attach` / `--no-attach` (default: attach only when
  stdout & stderr are TTYs) and `--wait-timeout <seconds>` (health-wait window,
  default 120s).
- `devtrees logs` takes a service name positionally (`devtrees logs web`) or
  `--all` to interleave every service; `--follow`/`-f` keeps streaming,
  `--tail <N>` prints the last N lines, `--since <DUR>` filters by age
  (e.g. `30s`, `5m`, `1h`).
- `down`, `attach`, and `logs` accept `--shared` to target the shared instance
  instead of this worktree's.
- Every command accepts `--json` (see below).

## Agent surface (`--json`)

devtrees treats coding agents as first-class users
([ADR-0005](docs/adr/0005-agent-friendly-cli-by-default.md)). Every command
accepts a `--json` flag that emits a single JSON document on stdout with a
top-level `schema_version` (currently `"1"`):

```bash
$ devtrees env --json
{"schema_version":"1","env":{"WEB_PORT":"5180","DB_PORT":"5176","DEVTREES_WORKTREE_ID":"login-3f9c2a1b"}}
```

On failure, the same stream carries an error envelope and the process exits
non-zero:

```json
{"schema_version":"1","error":{"code":"HEALTH_TIMEOUT","message":"...","details":{}}}
```

Two deliberate departures from Unix habit, recorded in ADR-0005:

- **`--json` errors land on stdout, not stderr** — the agent reads one stream,
  parses one document, and branches on `error.code`. Stderr still carries the
  human-readable diagnostic line.
- **`devtrees up` leaves the stack running on `HEALTH_TIMEOUT`** so
  `devtrees logs <service>` and `devtrees ls --json` keep working and the
  agent can debug why startup failed before deciding to retry or `down`.

One exception to the single-document shape: `devtrees logs --json` streams
NDJSON — one `{ts, service, stream, line}` object per log event, with no
top-level wrapper.

### Error codes

The full enum the error envelope can carry, defined in
[`src/output.ts`](src/output.ts) (`ERROR_CODES`). Each subcommand's `--help`
footer lists the subset that command can actually emit.

| Code                        | Meaning                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `PROCESS_COMPOSE_NOT_FOUND` | The `process-compose` binary is not on PATH.                                        |
| `INSTANCE_NOT_FOUND`        | No worktree (or shared) instance is running for this anchor.                        |
| `HEALTH_TIMEOUT`            | Stack started but services did not report healthy before the wait window expired.   |
| `CONFIG_DRIFT`              | Running config differs from devtrees.yaml and hot-reload failed.                    |
| `SHARED_DRIFT`              | This worktree's shared services diverge from the running shared instance; bring shared down and up again. |
| `STALE_PORT_BLOCK`          | Foreign listeners hold ports in this worktree's allocated block (likely orphans).   |
| `LOCK_CONTENTION`           | Another devtrees process holds the allocation registry lock.                        |
| `CONFIG_INVALID`            | devtrees.yaml is malformed or rejected by the deriver.                              |
| `INVALID_ARGS`              | A flag value or positional argument failed validation before any effect ran.        |
| `UNKNOWN`                   | Unclassified failure; consult the error envelope's `message` field.                 |

New codes are additive; renames are breaking and require a `schema_version`
bump once the agent surface is declared stable — see
[ADR-0005](docs/adr/0005-agent-friendly-cli-by-default.md) for the
versioning policy.

## Development

devtrees is built with [Vite+](https://viteplus.dev/) (the `vp` CLI), per
[ADR-0004](docs/adr/0004-nodejs-typescript-with-vite-plus.md).

```bash
npm install      # install dependencies
npm test         # run the Vitest suite
npm run build    # bundle the CLI to dist/cli.mjs
npm run check    # format, lint, and type-check
```

Or drive Vite+ directly with the `vp` CLI (what CI runs):

```bash
vp install       # install dependencies
vp check         # format + lint + type-check in one pass
vp lint          # lint only
vp fmt --check   # verify formatting without writing
vp test run      # run the test suite once
vp run build     # bundle the CLI (runs `vp pack`; `vp build` is the app build)
```

### Smoke testing against real process-compose

Most tests run against the stub `test/stub-process-compose.mjs`. There's also
a **real-binary smoke suite** (`src/real-pc.smoke.test.ts`, issue #60) that
drives the built `dist/cli.mjs` against the real `process-compose` binary —
catching the kind of regressions only the real binary surfaces (probe
convergence timing, OS `EADDRINUSE`, hot-reload behaviour). It is gated off
by default so a local `vp test run` is unaffected.

Prerequisites:

- [`process-compose`](https://github.com/F1bonacc1/process-compose) on `PATH`
  (run `process-compose version` to confirm). The CI workflow installs a
  pinned release; see [`.github/workflows/smoke-real-pc.yml`](.github/workflows/smoke-real-pc.yml).

Run it locally:

```bash
vp run build                            # the smoke spawns dist/cli.mjs
DEVTREES_REAL_PC_E2E=1 vp test run real-pc.smoke
```

When `DEVTREES_REAL_PC_E2E` is unset or `process-compose` is missing, the
suite skips with a clear marker line.

Golden envelopes live under [`test/fixtures/agent-surface/`](test/fixtures/agent-surface/).
The test normalises allocation-dependent fields (port numbers, `block_base`,
worktree ids) before comparing — see `normaliseEnvelope` in the test file
for the explicit list. If you intentionally change a `--json` envelope shape,
update the fixture in the same PR so the smoke catches the change at review
time.

In CI the smoke runs:

- On PRs touching `src/{commands,driver,deriver,stack,output,allocator,instances}.ts`,
  the smoke test file itself, or the fixtures. Unrelated PRs skip it.
- Nightly at 06:00 UTC, so process-compose-side regressions surface within a
  day even on quiet weeks.

## CI/CD

CI runs on every push to `main` and on every pull request via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), in two parts.

### 1. Vite+ pipeline

The [`voidzero-dev/setup-vp`](https://viteplus.dev/guide/ci) action installs
Vite+, Node 22, and the package manager with dependency caching in a single
step (replacing `setup-node` + manual cache steps). It then runs each stage of
the Vite+ pipeline as its own step so a failure points at exactly which gate
broke: `vp install` → `vp check` (format + lint + **type-check**) → `vp lint` →
`vp fmt --check` → `vp test run` → `vp run build` (the project's `vp pack`
library build; plain `vp build` is the frontend-app build and doesn't apply
to a CLI).

Type-checking is wired into `vp check` via `lint.options.typeCheck` in
[`vite.config.ts`](vite.config.ts), so the check stage genuinely fails on type
errors rather than silently skipping them.

Run the same checks locally with `vp check` and `vp test` (see Development
above).

### 2. fallow code-quality gate

On pull requests, [fallow](https://docs.fallow.tools/) runs as a code-quality
gate covering dead code, duplication, circular dependencies, and a complexity
**health** score. It gates on **regressions**, not absolute purity:

- `fallow audit` compares the PR's changed files against committed baselines
  ([`fallow-baselines/*.json`](fallow-baselines)) and fails on new issues with
  `--fail-on-regression --tolerance 2%`.
- `fallow health --min-score 80` enforces a health-score floor.
- `fallow dupes --threshold 10` enforces a duplication ceiling (percent).

Results are surfaced on the PR as a markdown comment and in the job summary.

**All thresholds are starting points and tunable.** The tolerance,
health-score floor, and duplication threshold live in
[`.fallowrc.jsonc`](.fallowrc.jsonc) and the workflow; tighten them as the
codebase matures. Regenerate the baselines on `main` when you intentionally
pay down or accept debt:

```bash
npx fallow dead-code --save-baseline fallow-baselines/dead-code.json
npx fallow health    --save-baseline fallow-baselines/health.json
npx fallow dupes     --save-baseline fallow-baselines/dupes.json
```

Run fallow locally before pushing:

```bash
npx fallow audit            # dead code + dupes + health on changed files
npx fallow health           # full-tree health score
npx fallow dupes            # full-tree duplication report
```

## License

MIT
