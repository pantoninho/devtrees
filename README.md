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
- **`process-compose` >= v1.122.0** — devtrees shells out to the external
  `process-compose` binary; it does not embed it. You must have `process-compose`
  installed and on your `PATH`; `devtrees up` refuses to start on an older release. See the [process-compose installation guide](https://f1bonacc1.github.io/process-compose/installation/).

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
| `devtrees ls`       | List every instance with status, namespaces and ports (`--services`)     |
| `devtrees attach`   | Attach a TUI to this worktree's instance (`--shared` for the shared one)  |
| `devtrees prune`    | Reconcile against `git worktree list` and clean up orphaned instances     |
| `devtrees env`      | Print this worktree's injected env (KEY=value, or `--json` for a map)     |
| `devtrees logs`     | Stream a service's logs (`--follow`, `--tail=N`, `--since=DUR`, `--all`, `--shared`) |

Flag highlights (run `devtrees <cmd> --help` for the full per-command surface):

- `devtrees up` accepts `--attach` / `--no-attach` (default: attach only when
  stdout & stderr are TTYs), `--wait-timeout <seconds>` (health-wait window,
  default 120s) and `-n/--namespace <ns>` (repeatable; see
  [Namespaces](#namespaces)).
- `devtrees logs` takes a service name positionally (`devtrees logs web`) or
  `--all` to interleave every service; `--follow`/`-f` keeps streaming,
  `--tail <N>` prints the last N lines, `--since <DUR>` filters by age
  (e.g. `30s`, `5m`, `1h`).
- `devtrees ls` shows each instance's booted namespaces (NAMESPACES column,
  read back from the running project as `up` does). `--services` prints one
  row per service instead, the shared instance's included: its namespaces,
  tier (`isolated` or `shared`), status and pid. Status is `active`, `dead` or
  `done` (a one-shot that exited 0); a service stopped with `process-compose
  process stop` reads `dead`, like a crashed one, because process-compose
  reports both the same way. The pid is shown only for an `active` service.
  `ls --json` always carries the instance's `namespaces` and, per service,
  `namespaces`, `tier`, `state` (the same `active`/`dead`/`done`) and `pid`
  (`null` unless active), next to process-compose's own `status` string.
  `ls` only reads: each instance gets at most 5s to answer, all of them in
  parallel. One that does not answer (busy or frozen) is still listed, with
  `?` for its namespaces and services, `"services_read": "unresponsive"` under
  `--json` (`"ok"` when read, `"skipped"` for a stale or unknown instance),
  and a note on stderr.
- `down`, `attach`, and `logs` accept `--shared` to target the shared instance
  instead of this worktree's.
- Every command accepts `--json` (see below).

### Namespaces

A service can declare a process-compose `namespace:` to make it optional.
Namespaces are **opt-in** and selection is **exact**
([ADR-0008](docs/adr/0008-up-converges-to-declared-state-and-namespace-selection.md)):

- A fresh `devtrees up` with no `-n` starts only the `default` namespace — the
  services that declare no `namespace:`. A service in a named namespace never
  starts unless you ask for it.
- `-n/--namespace` (repeatable) starts exactly the namespaces it names.
  `-n app` starts `app` and nothing else; it does **not** add `default`. To
  run both, write `devtrees up -n default -n app`.
- If the selection resolves to no services, `up` fails with
  `NO_SERVICES_SELECTED`, listing the namespaces to pick from with `-n`. That is
  a bare `up` when every service declares a namespace, and an `-n` that names
  only namespaces with no services (`up -n nope`) — an empty instance is
  useless, and process-compose exits after hot-reloading one (#203). Mixing a
  real namespace with an empty one (`-n app -n nope`) still starts `app`.
- A running stack keeps the namespaces it was booted with. A bare `up` on it
  checks exactly those; `-n` naming one it was not booted with fails with
  `NAMESPACE_NOT_RUNNING` (`devtrees down && devtrees up -n …` boots it).
- `devtrees up --dry-run` (with the same `-n` flags) shows the selection — the
  `namespaces` and `selected_services` fields under `--json` — and fails the
  same way. It previews the path the real `up` would take: on a running stack
  (`"instance": "running"`) that is the namespaces it was booted with for a bare
  `up`, whether the changed config would be hot-reloaded (`would_reload`), which
  dead services would be restarted (`would_restart`), and the same errors
  (`NAMESPACE_NOT_RUNNING`, `CONFIG_DRIFT` with `reload_pending`). It only reads
  the running instance: nothing is reloaded, restarted or written. A drifted
  stack is previewed as the hot-reload would leave it, since the real `up`
  reloads before it checks. The read of the instance is capped at 5s (or
  `--wait-timeout`), so a process-compose too slow to answer fails
  `HEALTH_TIMEOUT` sooner than the real `up`. With nothing running it previews
  a fresh start (`"instance": "fresh"`). `selected_services` is in
  `devtrees.yaml` order; `up.services` is in process-compose's order.

```yaml
services:
  web: # default namespace: starts on a bare `devtrees up`
    tier: isolated
    command: npm run dev
  api: # starts only with `devtrees up -n local-backend`
    tier: isolated
    namespace: local-backend
    command: npm run api
```

A service can belong to several namespaces: `namespace:` also takes a list
(process-compose ≥ v1.122.0). The service starts when **any** of its
namespaces is selected. The list must be non-empty and contain distinct names.

```yaml
services:
  db: # starts with -n backoffice, -n backoffice-be, or both
    tier: isolated
    namespace: [backoffice, backoffice-be]
    command: supabase start
  admin-api: # `devtrees up -n backoffice-be` starts db + admin-api
    tier: isolated
    namespace: backoffice-be
    command: npm run admin-api
    depends_on: [db]
  admin-ui:
    tier: isolated
    namespace: backoffice
    command: npm run admin-ui
    depends_on: [admin-api]
```

A `depends_on` on a service that is not selected is **dropped** by
process-compose: the dependent starts anyway, without waiting. Above,
`devtrees up -n backoffice` starts `admin-ui` without `admin-api`. devtrees
warns about each dropped edge on stderr, naming both services, in `up` and
`up --dry-run`:

```
devtrees: dropped cross-namespace depends_on 'admin-ui' -> 'admin-api': 'admin-api' is in namespace(s) [backoffice-be], none of which is selected, so process-compose starts 'admin-ui' without waiting for it. Select one of [backoffice-be] with -n to start 'admin-api' too.
```

Under `--json`, the same edges are in `dropped_namespace_edges`
(`[{from, to, to_namespaces}]`, always present) on both the `up` and
`up_dry_run` envelopes. On a running stack, a bare `up` reports the edges
dropped by the namespaces it was booted with.

Before ADR-0008, a bare `up` started every namespace. Stacks that relied on
that now need `-n`. Only isolated services can declare a namespace, as a
string or a list; shared services always run.

### Referencing ports in a command

devtrees injects each allocated port (and `DEVTREES_WORKTREE_ID`) into the
process environment. In a `command`, reference it as bare `$WEB_PORT`, or as
`$${WEB_PORT}` to get a braced form through process-compose. Plain
`${WEB_PORT}` runs empty: process-compose expands it when it loads the config,
from its own environment, before the process environment exists.

```yaml
services:
  web:
    tier: isolated
    ports: [WEB_PORT]
    command: npm run dev -- --port $WEB_PORT # not ${WEB_PORT}
```

`up` and `up --dry-run` warn on stderr about each `${NAME}` in a command where
`NAME` is a variable devtrees injects into that service, naming the service
and the variable. Under `--json`, the same are in `braced_env_vars`
(`[{service, variable}]`, always present) on both the `up` and `up_dry_run`
envelopes. The command is never rewritten.

### Where devtrees keeps its state

Derived configs, the allocation registry and per-instance logs live in
`<git-common-dir>/devtrees/` — inside the git dir, so no `.gitignore` entry is
needed and bare-repo layouts work the same
([ADR-0001](docs/adr/0001-shared-instance-anchored-at-git-common-dir.md)).

Control sockets are the exception. A unix socket path has to fit in `sun_path`
(104 bytes on macOS), which a deep checkout's git dir blows through, so they
live in a short per-user run dir keyed by a hash of the repo:
`$XDG_RUNTIME_DIR` (or `/tmp`) `/devtrees-<uid>/<repo-hash>/<instance>.sock`
([ADR-0007](docs/adr/0007-control-sockets-in-a-short-runtime-dir.md)). Set
**`DEVTREES_RUNTIME_DIR`** to move that dir — useful if your `XDG_RUNTIME_DIR`
is itself long, or `/tmp` is unusable. If a socket path still cannot fit,
`devtrees up` fails with `SOCKET_PATH_TOO_LONG` rather than letting
process-compose die at `bind(2)` with no diagnostic.

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
| `PROCESS_COMPOSE_TOO_OLD`   | The installed `process-compose` is older than v1.122.0; `details` has `installed_version`, `minimum_version`, `upgrade_url`. |
| `INSTANCE_NOT_FOUND`        | No worktree (or shared) instance is running for this anchor.                        |
| `INSTANCE_UNRESPONSIVE`     | The instance's control socket exists but did not answer repeated probes (process-compose busy or frozen); nothing was started or stopped, the socket was kept, `details.remedy` says what to do. |
| `DOWN_TIMEOUT`              | The stop did not finish within its budget and process-compose was still running after devtrees force-killed the stuck services, or a timed-out hot-reload never finished so the stop was not started (`details.pending_reload`); the socket and config were kept, `details` names the stuck services, their pids and the process-compose pid, `details.remedy` says what to do. |
| `DOWN_INCOMPLETE`           | process-compose stopped, but something the instance started is still alive: a listener on a booted service's port, or a member of a service's process group that survived SIGKILL; `details.survivors` lists each `{service, pid, command, port_name?, port?, port_forwarder?}`, `details.remedy` says what to do. A retried `down` checks the same ports again. |
| `SERVICE_NOT_FOUND`         | The named service does not exist in the target instance; `details.valid_services` lists the known ones. |
| `HEALTH_TIMEOUT`            | Stack started but services did not report healthy before the wait window expired, or a selected service is dead, including one `up` restarted (`details.dead_services`). |
| `NAMESPACE_NOT_RUNNING`     | `up -n` named a namespace the running instance was not booted with; `details.remedy` is the `down` + `up` that boots it. |
| `SHARED_SERVICE_DEAD`       | A shared service in the running shared instance is dead; it is not restarted from a worktree, run `details.remedy` (`devtrees down --shared && devtrees up`). |
| `SERVICE_START_FAILED`      | `up` tried to restart a dead service on the running instance and process-compose refused; `details.services` names each one, `details.remedy` is the `down` + `up` that restarts the stack. |
| `CONFIG_DRIFT`              | Running config differs from devtrees.yaml and hot-reload failed, or an earlier reload is still pending; `details.reason` is `timeout`, `not_supported`, `error`, or `reload_pending` (nothing was reloaded: kill `details.pids`, then retry; empty `pids` means the old process is gone and process-compose is still starting the new one, so retry shortly). |
| `SHARED_DRIFT`              | This worktree's shared services diverge from the running shared instance; bring shared down and up again. |
| `SHARED_START_FAILED`       | The lazy-started shared instance died before binding its control socket; `details.config_path` is the config to run by hand. |
| `WORKTREE_START_FAILED`     | This worktree's instance died before binding its control socket; `details.config_path` is the config to run by hand. |
| `NO_SERVICES_SELECTED`      | The selection has no services: a bare `up` starts only the `default` namespace and it has none, or `-n` names only namespaces with none. `details.namespaces` lists the namespaces to pass with `-n`. |
| `SOCKET_PATH_TOO_LONG`      | The control socket path exceeds the platform's unix-socket limit; set `DEVTREES_RUNTIME_DIR` to a shorter directory. |
| `STALE_PORT_BLOCK`          | Foreign listeners hold ports in this worktree's allocated block (likely orphans); `details.collisions[]` lists each `{port_name, port, pid, command, accepts_connections, port_forwarder}`. Never kill a holder with `accepts_connections: false` or `port_forwarder: true`. |
| `LOCK_CONTENTION`           | Another devtrees process holds a devtrees lock (allocation registry or an instance's lifecycle lock). |
| `CONFIG_INVALID`            | devtrees.yaml is malformed or rejected by the deriver.                              |
| `INVALID_ARGS`              | A flag value or positional argument failed validation before any effect ran.        |
| `UNKNOWN`                   | Unclassified failure; consult the error envelope's `message` field.                 |

New codes are additive; renames are breaking and require a `schema_version`
bump once the agent surface is declared stable — see
[ADR-0005](docs/adr/0005-agent-friendly-cli-by-default.md) for the
versioning policy.

## Using devtrees from a coding agent

A coding agent dropped into a consuming repo learns that repo's workflow from
its `AGENTS.md` (or `CLAUDE.md`, or whatever convention the agent reads), not
from devtrees' README. If your project uses devtrees to isolate per-worktree
stacks, paste the block below into your project's agent instructions so any
agent can drive the stack non-interactively.

The block is agent-agnostic — it's plain instructions about the devtrees CLI,
valid as `AGENTS.md` / `CLAUDE.md` content for any coding agent.

> Rather than copy this by hand, run `devtrees init --agents` in your project: it
> writes the exact block below into your `AGENTS.md` (or `CLAUDE.md` if that's
> your convention, creating `AGENTS.md` otherwise), fenced by
> `<!-- devtrees:start -->` / `<!-- devtrees:end -->` markers so re-running
> replaces it in place. The block is generated from the same in-repo source this
> README quotes, so the two can't drift.

````markdown
## Running the stack with devtrees

This worktree's services run under [devtrees](https://github.com/pantoninho/devtrees),
which gives every git worktree its own collision-free port block. Drive it
non-interactively — never attach the TUI:

```bash
# 1. Bring the stack up and wait for health. In a non-TTY context (an agent
#    shell) `up` skips the TUI and blocks until every probed service reports
#    health: ready, then exits. `--json` prints the success envelope — the
#    allocated ports, per-service rows, and the injected env map — on stdout.
devtrees up --json

# 2. Load this worktree's injected ports/URLs into the environment. `devtrees
#    env` prints `KEY=value` lines (use `--json` for a map); eval makes them
#    available to your test command.
eval "$(devtrees env)"

# 3. Run the project's tests/build against the running stack.
<your test command>   # e.g. npm test

# 4. On failure, read a service's recent logs. Without `--follow`, `logs`
#    prints the buffered tail and exits — safe in a non-interactive shell.
devtrees logs <service> --tail=200

# 5. Tear the stack down when done. Re-running `down` on an already-stopped
#    instance is a no-op and still exits 0.
devtrees down
```

`devtrees up` is safe to call defensively before every test run. On a stack
that is already running it hot-reloads changed config, **restarts** any
selected service that has died, then waits (up to `--wait-timeout`) for every
selected service to be healthy and exits 0 only then — immediately when all
are. It never stops anything, and never attaches the TUI.

- A bare `up` checks the namespaces the stack was booted with. `-n` checks
  exactly the namespaces it names; a narrower `-n` leaves the rest running
  and restarts nothing outside it.
- `-n` cannot add a namespace the running stack was not booted with: `up`
  fails with `NAMESPACE_NOT_RUNNING`. Boot with it: `devtrees down && devtrees
  up -n …` (the message names the exact command).
- A dead selected service (crashed, killed, or exited non-zero) is started
  again, and `up` names it (`restarted` in the `--json` envelope). Several
  dead services are started in `depends_on` order, without waiting between
  them. If one does not become healthy, or dies again, `up` fails with
  `HEALTH_TIMEOUT` naming it; if process-compose refuses to start it, with
  `SERVICE_START_FAILED`. The stack is left running either way. A one-shot
  that exited 0 counts as done and is not rerun.
- `up` and `down` on the same worktree take turns. An `up` that finds the
  stack stopped by a concurrent `down` starts nothing and fails with
  `INSTANCE_NOT_FOUND`; one that waits too long for the other fails with
  `LOCK_CONTENTION`. Either way, run `devtrees up` again.
- A hot-reload whose changed service's old process never stops fails with
  `CONFIG_DRIFT` (`details.reason: "timeout"`), and process-compose keeps
  waiting on that process. Until it exits, `up` reloads nothing and fails
  with `details.reason: "reload_pending"`, naming the service and the old
  PID: a second reload would start an untracked copy. Kill the old process,
  then run `devtrees up` again. `devtrees down` also works: it force-kills
  that old process before it stops the stack.
- `down` never hangs on a service that will not stop (a `shutdown.command`
  that leaves it running, or a process that ignores SIGTERM). After its
  budget (30s plus every `shutdown.timeout_seconds`) devtrees force-kills
  that service, and `down` names it (`force_killed` in the `--json`
  envelope). A timed-out hot-reload is let finish first: `down` waits
  for it before it stops anything, and force-kills (and names the same
  way) an old process that is still stuck after that same budget. If
  process-compose still does not exit, or the reload never finishes
  (`details.pending_reload`), `down` fails with `DOWN_TIMEOUT`.
- `down` stops each service's whole process group. process-compose calls a
  service stopped once its direct child exits, so a grandchild behind a
  wrapper chain (`exec pnpm exec … -- uv run … uvicorn --reload`) that
  ignores SIGTERM used to outlive it, holding its port. After process-compose
  stops, devtrees gives the group's leftovers 5s (sending SIGTERM first when
  process-compose did not signal the group: a `shutdown.command` or
  `shutdown.parent_only`), then SIGKILLs them. Every process it signals is
  named in `force_killed`. A process that left the group on purpose
  (`setsid`, a detached daemon other worktrees may share) is never signalled.
- process-compose skips the `shutdown.command` of a daemon
  (`is_daemon: true`) whose launch failed (`Error`, or `Completed` with a
  non-zero exit), so a launch that started containers and then failed left
  them running. `down` now runs those hooks itself, each bounded by its
  `shutdown.timeout_seconds` or, when unset, process-compose's own 10s. If a
  booted service's port still accepts connections after the stop, `down`
  fails with `DOWN_INCOMPLETE` naming the holder, instead of reporting the
  instance stopped; the next `down` checks the same ports again.
- A dead shared service fails `up` with `SHARED_SERVICE_DEAD`; run
  `devtrees down --shared && devtrees up`.

### Handling failures

With `--json`, every command emits a single JSON document on **stdout** and
exits non-zero on failure: `{"error":{"code":"…","message":"…","details":{…}}}`.
Branch on `error.code`:

| Code                        | What it means and what to do                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `LOCK_CONTENTION`           | Another devtrees process holds a lock. Wait briefly and **retry** `up`/`down`.               |
| `HEALTH_TIMEOUT`            | A service never reported ready, or is still dead after `up` restarted it (`details.dead_services`). The stack is **left running** — read `devtrees logs <service> --tail=N` to see why, then retry or follow the message (`devtrees down && devtrees up …`). |
| `NAMESPACE_NOT_RUNNING`     | You asked `-n` for a namespace the running stack was not booted with. Run `details.remedy` (`devtrees down && devtrees up -n …`). |
| `SHARED_SERVICE_DEAD`       | A shared service is dead. devtrees will not restart it from one worktree; run `devtrees down --shared && devtrees up`. |
| `SERVICE_START_FAILED`      | `up` tried to restart a dead service and process-compose refused. `details.services` carries each one with process-compose's message; read it, then run `details.remedy` (`devtrees down && devtrees up …`). |
| `STALE_PORT_BLOCK`          | Foreign listeners hold this worktree's ports. `details.collisions[]` lists `{port_name, port, pid, command, accepts_connections, port_forwarder}` (the message lists them too). Kill the orphaned holders and retry, but **never** kill one with `port_forwarder: true` (a container runtime's forwarder, such as OrbStack Helper, serving every instance: stop the container that publishes the port, `docker ps --filter publish=<port>`) or `accepts_connections: false` (usually a stale port forward). Holders that all refuse connections do not fail `up`; it warns and goes on. |
| `SHARED_DRIFT`              | This worktree's shared services diverge from the running shared instance. Follow the message: `devtrees down --shared && devtrees up`. |
| `CONFIG_DRIFT`              | The running config differs from `devtrees.yaml` and hot-reload failed, or an earlier reload is still pending. Branch on `details.reason`: `not_supported`/`error` → `devtrees down && devtrees up`. `timeout` → a changed service's old process won't stop: kill that process, then run `devtrees up` again to resync. Or run `devtrees down && devtrees up`: `down` force-kills that old process first and lists it in `force_killed`. `reload_pending` → that earlier reload is still waiting, so `up` reloaded nothing (another reload would start an untracked second copy): kill the old process (`details.pids`, for `details.services`), then run `devtrees up` again. Empty `details.pids` → the old process is gone and process-compose is still starting the new one: retry shortly; if it persists, follow the message's `devtrees down && devtrees up …`. |
| `SERVICE_NOT_FOUND`         | You named a service that isn't in the instance. `details.valid_services` lists the real names; pick one. |
| `NO_SERVICES_SELECTED`      | The selection has no services: a bare `up` starts only services with no `namespace:` and there are none, or `-n` names only namespaces with none. `details.namespaces` lists the namespaces; retry with `devtrees up -n <ns>`. |
| `INSTANCE_NOT_FOUND`        | No instance is running for this worktree. Run `devtrees up` first.                            |
| `INSTANCE_UNRESPONSIVE`     | The instance may be running but its process-compose did not answer (busy or frozen). Nothing changed. **Retry** in a moment; if it persists, follow `details.remedy`. Do not delete the socket by hand. |
| `DOWN_TIMEOUT`              | `down` could not finish: process-compose was still running after devtrees force-killed the stuck services (`details.stuck_services`; empty when it is waiting on a `shutdown.command` that does not exit), or a timed-out hot-reload was still being applied, so `down` did not start the stop (`details.pending_reload`; `details.remedy` names the old process to kill by hand first, which is safe because no stop is running). Nothing was removed. **Retry** `down` once; if it fails again, **surface it to the human** with `details.remedy`, which names the process-compose pid to stop by hand, or for a pending reload the old process to kill. |
| `DOWN_INCOMPLETE`           | `down` stopped process-compose, but something the instance started is still alive (`details.survivors`): a listener on a booted service's port (a container whose `shutdown.command` did not remove it, say), or a member of a service's process group that survived SIGKILL. Run `devtrees down` **once more**: with process-compose gone it runs every `shutdown.command` itself, checks the same ports again, and succeeds once they are free. If it fails the same way, **surface the survivors to the human** with `details.remedy`. Never kill a survivor with `port_forwarder: true`; stop the container that publishes its port. |
| `PROCESS_COMPOSE_NOT_FOUND` | The `process-compose` binary is missing. **Surface this to the human** — it's an environment setup gap you can't fix.   |
| `PROCESS_COMPOSE_TOO_OLD`   | The installed `process-compose` is below the minimum (v1.122.0). **Surface this to the human** — they need to upgrade it. |
| `CONFIG_INVALID` / `INVALID_ARGS` | The config or your arguments are malformed. Fix the input; don't retry blindly.        |

For the full error enum and the per-command subset each can emit, run
`devtrees <cmd> --help` or see devtrees' README.
````

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
  v1.122.0 or newer (run `process-compose version` to confirm). The CI workflow installs a
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
