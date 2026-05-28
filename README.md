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

## License

MIT
