# devtrees

Run a project's [process-compose](https://github.com/F1bonacc1/process-compose)
stack across multiple git worktrees without collision.

devtrees is a thin layer over process-compose. You configure a project once in a
`devtrees.yaml` and mark each service `isolated` (a separate copy per worktree)
or `shared` (one instance for the whole repo). From inside any worktree,
`devtrees up` brings up that worktree's stack with auto-allocated, collision-free
ports injected as environment variables. See [the PRD](https://github.com/pantoninho/devtrees/issues/1)
for the full vision.

> **Status: walking skeleton.** The CLI runs and reports `--help`/`--version`;
> the commands below are stubbed and not yet implemented.

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
devtrees --help      # list commands
devtrees --version   # print the version
```

Planned commands (stubbed today):

| Command             | What it will do                                                       |
| ------------------- | --------------------------------------------------------------------- |
| `devtrees up`       | Bring up this worktree's stack                                        |
| `devtrees down`     | Stop this worktree's stack (`--shared` tears down the shared instance) |
| `devtrees ls`       | List every instance across the repo with status and ports             |
| `devtrees attach`   | Attach a TUI to this worktree's instance (`--shared` for the shared one) |
| `devtrees generate` | Write the derived process-compose config to disk                      |

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
