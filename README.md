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
| `devtrees restart`  | Restart named isolated services (or `-n` namespaces) in place; the rest of the stack keeps running |
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
  tier (`isolated` or `shared`), state and pid. State is `active`, `dead` or
  `done` (a one-shot that exited 0); a service stopped with `process-compose
  process stop` reads `dead`, like a crashed one, because process-compose
  reports both the same way. The pid is shown only while process-compose
  reports the process running, so not for a service waiting out a restart
  backoff (`Restarting`, still `active`).
  `ls --json` always carries the instance's `namespaces`, `services_read` and
  `reload_pending` and, per service, `namespaces`, `tier`, `state` (the same
  `active`/`dead`/`done`) and `pid` (`null` when not running), next to
  process-compose's own `status` string.
  `ls` only reads: each instance gets at most 5s to answer, all of them in
  parallel. One that does not answer (busy or frozen) is still listed, with
  `"services_read": "unresponsive"` under `--json` (`"ok"` when read,
  `"skipped"` when stale or of unknown liveness) and a note on stderr. One
  found gone during the read (a racing `down`) is listed as `stale`.
  In the tables, `?` means not known (an instance that did not answer, of
  unknown liveness, or whose derived config is gone; `namespaces: null` under
  `--json`) and `-` means none (no pid, no namespaces, a stale instance). An
  instance with no service rows gets one `--services` row whose SERVICE cell
  says why: `(unresponsive)`, `(unknown)`, `(stale)` or `(none)`. While a
  timed-out hot-reload is still pending, `ls` counts its services as booted,
  sets `reload_pending: true`, and notes it on stderr.
- `devtrees restart <service>...` restarts named isolated services of this
  worktree's running instance in place, one at a time in `depends_on` order:
  it stops the service (waiting for the old process to exit, force-killing
  it after the same budget as `down`, named in `force_killed`), starts it,
  and waits for it to be healthy before restarting the services that depend
  on it (`--wait-timeout <seconds>`, one budget for all of them, default
  120s). The instance, the ports and every other service keep running;
  dependents of a named service are not restarted, and a stopped one is
  simply started. It refuses before anything is touched
  (`SHARED_SERVICE_REFUSED`,
  `CONFIG_DRIFT` for a pending reload, `NAMESPACE_NOT_RUNNING`,
  `SERVICE_PENDING` for a service still waiting on its dependencies), and the
  instance's last running process (`LAST_SERVICES_RUNNING`: its stop would
  make process-compose exit; `details.remedy` restarts the whole instance
  with `down` + `up`). Each service's stop and start hold the lifecycle lock:
  about 30s plus the service's `shutdown.timeout_seconds` at worst (an old
  process that will not exit), plus up to 10s for the start, so a concurrent
  `up` or `down` may wait about 10s and fail `LOCK_CONTENTION`.
  `--wait-timeout` covers only the health waits, not the stops and starts.
  A bare `devtrees restart`, with no names and no `-n`, fails `INVALID_ARGS`
  and touches nothing: restarting every service in place would have to stop
  the last running one, and process-compose would exit. Name the services
  (or `-n <namespace>`), or run the
  error's `details.remedy`, the `down` + `up` that boots the same namespaces
  again (`devtrees down && devtrees up -n app`, say). When devtrees cannot
  read which namespaces are running, the remedy boots every declared one,
  and the message says so. See
  [ADR-0009](docs/adr/0009-per-service-and-per-namespace-lifecycle-control.md).
- `restart` takes a repeatable `-n <namespace>`, alone or mixed with names
  (`devtrees restart -n app worker`). It expands to every isolated service
  of that namespace in the running instance (a service in several
  namespaces is in each); the union with the names, each once, then goes
  through the same checks and the same restart. Shared services, which have
  no namespace and so sit in `default`, are skipped and reported
  (`skipped_shared` under `--json`); naming one is still
  `SHARED_SERVICE_REFUSED`. A namespace the instance did not boot fails
  `NAMESPACE_NOT_RUNNING`; one with no isolated service fails
  `NO_SERVICES_SELECTED`.
- There is no `devtrees stop` (removed in 0.3.0, see ADR-0009's amendment):
  `restart` cycles a live-but-bad service, and to stop a service by hand
  (to run it yourself on its port, say) use `devtrees attach` and stop it in
  the process-compose TUI. The next `devtrees up` starts it again.
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
  (`NAMESPACE_NOT_RUNNING`, `CONFIG_DRIFT` with `reload_pending`). On either
  path, when the shared instance is running, `would_restart_shared` lists the
  dead selected shared services `up` would restart. It only reads the running
  instances: nothing is reloaded, restarted or written. A drifted
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
that now need `-n`. A namespace is a string or a list.

### Namespaced shared services

A shared service with no `namespace:` is **always on**: every `up` uses it,
and the first `up` in any worktree starts it. A shared service **with** a
`namespace:` runs only once an `up` selects one of its namespaces
([ADR-0010](docs/adr/0010-namespaced-shared-services-and-scoped-drift.md)).
That lets a stack offer one database every worktree shares, plus an isolated
copy for a branch that changes the schema:

```yaml
services:
  db-shared:
    tier: shared
    namespace: db-shared
    ports: [DB_PORT]
    command: supabase start
  db:
    tier: isolated
    namespace: db
    ports: [DB_PORT_ISOLATED]
    command: supabase start --workdir ./isolated
  api:
    namespace: app
    ports: [API_PORT]
    command: node api.js --port $API_PORT
```

`devtrees up -n app -n db-shared` uses the shared database and
`devtrees up -n app -n db` runs an isolated one; neither starts the other.

- There is still one shared instance per repo. The first `up` that selects a
  namespaced shared service adds it to that instance, if the instance is
  already running. It is appended to the shared derived config and
  process-compose re-reads the config. The shared services already running
  are left exactly as they are and keep running. The `up` result lists the
  added services in `shared_activated`. If process-compose refuses the
  reload, `up` fails with `SHARED_ACTIVATION_FAILED`.
- Once added, a shared service stays in the shared instance until
  `devtrees down --shared`, even when no `up` selects it any more.
- A selected shared service's shared `depends_on` targets are selected with
  it.
- An `up` only checks the shared services it selects for drift and death.
  `SHARED_DRIFT` names each drifted service with both revisions. An `up` that
  does not select a drifted shared service does not fail. Drift in an
  always-on shared service still fails every `up`.
- An `up` **restarts a dead shared service it selects**, from any worktree,
  and waits for it to be healthy; the result lists it in `shared_restarted`.
  It never stops, restarts or reloads a shared service that is running, and
  it checks drift first: on `SHARED_DRIFT` it restarts nothing. Two worktrees
  running `up` at once restart it once. If process-compose refuses the start,
  or the restarted service dies again, `up` fails with `SHARED_SERVICE_DEAD`
  (`details.reason`); if it never becomes healthy, with `HEALTH_TIMEOUT`.
- `env` takes no `-n`, so it checks only the always-on shared services.
- Every `up` and `env` still injects every shared service's ports, selected or
  not.
- **Always pass `-n` when a stack has namespaced shared services.** On a
  running instance, a bare `up` selects the namespaces the instance booted,
  read back from process-compose. A namespace that holds only shared
  services leaves no trace there, so a bare `up` does not select it: it
  neither checks it for drift nor adds it back after `down --shared`.
- If adding a service times out (`SHARED_ACTIVATION_FAILED`, `reason:
  timeout`), retry `up`. A retried `up` that finds a recorded service missing
  from the shared instance re-sends the reload.
- `up --dry-run` lists the shared services the selection includes in
  `selected_shared_services` (always present).

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
| `HEALTH_TIMEOUT`            | Stack started but services did not report healthy before the wait window expired, or a selected service is dead, including one `up` or `restart` restarted (`details.dead_services`); after `restart`, `devtrees restart <service>` retries it. A dead shared service `up` restarted that never became healthy is this code too, with `details.instance: "shared"` and the shared `details.remedy`. |
| `NAMESPACE_NOT_RUNNING`     | `up -n` named a namespace the running instance was not booted with, or `restart` named a service in one, or such a namespace with `-n`; `details` has `{worktree_id, namespaces, services, remedy}`, the remedy being the `down` + `up` that boots it. |
| `SHARED_SERVICE_DEAD`       | A dead shared service `up` could not repair (`details.reason`): process-compose refused to restart it (`start_refused`, `details.start_failures`), it died again after `up` restarted it (`died_again`), it died during the shared-health wait (`died_while_waiting`), or the shared instance records no state to check it against (`unknown_revision`). Other dead shared services `up` restarts itself. Run `details.remedy` (`devtrees down --shared && devtrees up`). |
| `SERVICE_START_FAILED`      | `up` tried to restart a dead service on the running instance, or `restart` a named one, and process-compose refused; `details.services` names each one, `details.remedy` says what to run next. The instance is still running. |
| `SHARED_SERVICE_REFUSED`    | `restart` named a shared service; a worktree never restarts the shared instance's services. Nothing was touched; `details` has `{services, remedy}`, the remedy being `devtrees down --shared && devtrees up` (for every worktree). |
| `LAST_SERVICES_RUNNING`     | `restart` would have to stop the instance's last running process (a `Pending` service does not count), and process-compose would then exit and take the instance down; nothing was touched. `details.services` names them, `details.remedy` is the `down` + `up` that restarts the instance. |
| `SERVICE_PENDING`           | `restart` named a service still waiting on its dependencies (`Pending`): it has not started, so there is nothing to restart, and nothing was touched. `details` has `{services, waiting_on, remedy}`: wait until it starts, or restart what it waits on. |
| `CONFIG_DRIFT`              | Running config differs from devtrees.yaml and hot-reload failed, or an earlier reload is still pending; `details.reason` is `timeout`, `not_supported`, `error`, or `reload_pending` (nothing was reloaded: kill `details.pids`, then retry; empty `pids` means the old process is gone and process-compose is still starting the new one, so retry shortly). |
| `SHARED_DRIFT`              | A shared service this `up` selects diverges from the revision the running shared instance runs (an `up` that does not select it is unaffected); `details.services` lists each `{service, running_hash, local_hash}`, `details.port_conflicts` each named port a running shared service already owns, `details.remedy` is `devtrees down --shared && devtrees up` (for every worktree). |
| `SHARED_START_FAILED`       | The lazy-started shared instance died before binding its control socket; `details.config_path` is the config to run by hand. |
| `SHARED_ACTIVATION_FAILED`  | Adding a selected namespaced shared service to the running shared instance failed (process-compose refused or timed out on the config reload); the shared services it already ran are untouched. `details` has `{services, reason, config_path, remedy}`. |
| `WORKTREE_START_FAILED`     | This worktree's instance died before binding its control socket; `details.config_path` is the config to run by hand. |
| `NO_SERVICES_SELECTED`      | The selection has no services: a bare `up` starts only the `default` namespace and it has none, or `-n` names only namespaces with none, or a `restart -n` namespace has no isolated service (`details.selected_namespaces` names it; nothing was touched). `details.namespaces` lists the namespaces to pass with `-n`. |
| `SOCKET_PATH_TOO_LONG`      | The control socket path exceeds the platform's unix-socket limit; set `DEVTREES_RUNTIME_DIR` to a shorter directory. |
| `STALE_PORT_BLOCK`          | Foreign listeners hold ports in this worktree's allocated block (likely orphans); `details.collisions[]` lists each `{port_name, port, pid, command, accepts_connections, port_forwarder}`. Never kill a holder with `accepts_connections: false` or `port_forwarder: true`. |
| `LOCK_CONTENTION`           | Another devtrees process holds a devtrees lock (allocation registry or an instance's lifecycle lock). |
| `CONFIG_INVALID`            | devtrees.yaml is malformed or rejected by the deriver.                              |
| `INVALID_ARGS`              | A flag value or positional argument failed validation before any effect ran. A bare `restart` (no names, no `-n`) carries `details.remedy`, the `down` + `up` that restarts the whole instance with its booted namespaces. |
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
- If the stack has **namespaced shared services** (`tier: shared` with a
  `namespace:`), **always pass `-n`**, every time, naming the same
  namespaces you booted with. A bare `up` cannot tell that a namespace holding
  only shared services was booted, so it does not select them: it neither
  checks them for drift nor adds them back after `down --shared`.
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
- A dead shared service `up` selects is restarted too, whichever worktree
  runs it, and named in `shared_restarted`. A running shared service is never
  touched. If process-compose refuses the start, or the restarted service
  dies again, `up` fails with `SHARED_SERVICE_DEAD`; if it never becomes
  healthy, with `HEALTH_TIMEOUT` (`details.instance: "shared"`). Both name
  `devtrees down --shared && devtrees up`, which stops the shared instance
  for every worktree.
- To cycle one service without touching the rest (a wedged dev server, say),
  run `devtrees restart <service>...`. It restarts only the services it
  names, in `depends_on` order, keeps their ports and the instance, and
  never restarts their dependents (name those too). Each one is stopped
  (waiting until it has exited, force-killing it after the same budget as
  `down`, named in `force_killed`), started again, and waited on like `up`
  (`--wait-timeout`) before the next. Failures read the same:
  `HEALTH_TIMEOUT` leaves the stack running (`devtrees restart <service>`
  tries again), `SERVICE_START_FAILED` means process-compose refused. It
  refuses a shared service (`SHARED_SERVICE_REFUSED`), a service still
  waiting on its dependencies (`SERVICE_PENDING`), and the stack's last
  running process (`LAST_SERVICES_RUNNING`: use `details.remedy`, a `down` +
  `up`). To restart the whole stack, use that `down` + `up` too: a bare
  `devtrees restart` fails `INVALID_ARGS` and prints it.
- `-n <namespace>` on `restart` acts on every isolated service of that
  namespace (`devtrees restart -n app`), and can be mixed with names. Shared
  services are skipped and listed in `skipped_shared`. A namespace the stack
  was not booted with fails `NAMESPACE_NOT_RUNNING`, and one with no
  isolated service `NO_SERVICES_SELECTED`.

### Handling failures

With `--json`, every command emits a single JSON document on **stdout** and
exits non-zero on failure: `{"error":{"code":"…","message":"…","details":{…}}}`.
Branch on `error.code`:

| Code                        | What it means and what to do                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `LOCK_CONTENTION`           | Another devtrees process holds a lock. Wait briefly and **retry** `up`/`down`.               |
| `HEALTH_TIMEOUT`            | A service never reported ready, or is still dead after `up` or `restart` restarted it (`details.dead_services`). The stack is **left running** — read `devtrees logs <service> --tail=N` to see why, then retry or follow the message (`devtrees down && devtrees up …`). With `details.instance: "shared"` it is a shared service `up` restarted: read `devtrees logs --shared <service>`, and the remedy is `details.remedy` (`devtrees down --shared && devtrees up`). |
| `NAMESPACE_NOT_RUNNING`     | You asked `-n` for a namespace the running stack was not booted with. Run `details.remedy` (`devtrees down && devtrees up -n …`). |
| `SHARED_SERVICE_DEAD`       | A dead shared service `up` could not repair: process-compose refused to restart it, or it died again after `up` restarted it (`details.reason`). Read why with `devtrees logs --shared <service> --tail=N`, then run `devtrees down --shared && devtrees up` (it stops the shared instance for every worktree). |
| `SERVICE_START_FAILED`      | `up` tried to restart a dead service, or `restart` a named one, and process-compose refused. `details.services` carries each one with process-compose's message; read it, then run `details.remedy` (`devtrees down && devtrees up …`). |
| `STALE_PORT_BLOCK`          | Foreign listeners hold this worktree's ports. `details.collisions[]` lists `{port_name, port, pid, command, accepts_connections, port_forwarder}` (the message lists them too). Kill the orphaned holders and retry, but **never** kill one with `port_forwarder: true` (a container runtime's forwarder, such as OrbStack Helper, serving every instance: stop the container that publishes the port, `docker ps --filter publish=<port>`) or `accepts_connections: false` (usually a stale port forward). Holders that all refuse connections do not fail `up`; it warns and goes on. |
| `SHARED_DRIFT`              | A shared service this `up` selects (`details.services`) runs at another revision than this worktree defines. An `up` that does not select it is unaffected. Follow the message: `devtrees down --shared && devtrees up` (it stops the shared instance for every worktree). |
| `SHARED_ACTIVATION_FAILED`  | `up` could not add a namespaced shared service to the running shared instance; nothing that was running changed. `reason: timeout` → retry `devtrees up`. Otherwise **surface it to the human** with `details.remedy`. |
| `CONFIG_DRIFT`              | The running config differs from `devtrees.yaml` and hot-reload failed, or an earlier reload is still pending. Branch on `details.reason`: `not_supported`/`error` → `devtrees down && devtrees up`. `timeout` → a changed service's old process won't stop: kill that process, then run `devtrees up` again to resync. Or run `devtrees down && devtrees up`: `down` force-kills that old process first and lists it in `force_killed`. `reload_pending` → that earlier reload is still waiting, so `up` reloaded nothing (another reload would start an untracked second copy): kill the old process (`details.pids`, for `details.services`), then run `devtrees up` again. Empty `details.pids` → the old process is gone and process-compose is still starting the new one: retry shortly; if it persists, follow the message's `devtrees down && devtrees up …`. |
| `SERVICE_NOT_FOUND`         | You named a service that isn't in the instance. `details.valid_services` lists the real names; pick one. |
| `NO_SERVICES_SELECTED`      | The selection has no services: a bare `up` starts only services with no `namespace:` and there are none, or `-n` names only namespaces with none (on `restart`, any `-n` namespace with no isolated service, in `details.selected_namespaces`). `details.namespaces` lists the namespaces; retry with one of them. |
| `INSTANCE_NOT_FOUND`        | No instance is running for this worktree. Run `devtrees up` first.                            |
| `INSTANCE_UNRESPONSIVE`     | The instance may be running but its process-compose did not answer (busy or frozen). Nothing changed. **Retry** in a moment; if it persists, follow `details.remedy`. Do not delete the socket by hand. |
| `DOWN_TIMEOUT`              | `down` could not finish: process-compose was still running after devtrees force-killed the stuck services (`details.stuck_services`; empty when it is waiting on a `shutdown.command` that does not exit), or a timed-out hot-reload was still being applied, so `down` did not start the stop (`details.pending_reload`; `details.remedy` names the old process to kill by hand first, which is safe because no stop is running). Nothing was removed. **Retry** `down` once; if it fails again, **surface it to the human** with `details.remedy`, which names the process-compose pid to stop by hand, or for a pending reload the old process to kill. |
| `DOWN_INCOMPLETE`           | `down` stopped process-compose, but something the instance started is still alive (`details.survivors`): a listener on a booted service's port (a container whose `shutdown.command` did not remove it, say), or a member of a service's process group that survived SIGKILL. Run `devtrees down` **once more**: with process-compose gone it runs every `shutdown.command` itself, checks the same ports again, and succeeds once they are free. If it fails the same way, **surface the survivors to the human** with `details.remedy`. Never kill a survivor with `port_forwarder: true`; stop the container that publishes its port. |
| `SHARED_SERVICE_REFUSED`    | You asked `restart` for a shared service. Nothing was touched; a worktree never restarts what other worktrees share. Leave it, or restart the shared instance with `details.remedy` (`devtrees down --shared && devtrees up`). |
| `LAST_SERVICES_RUNNING`     | `restart` would have to stop the last running process, and process-compose would then exit and take the whole stack down. Nothing was touched. To restart the stack, run `details.remedy` (`devtrees down && devtrees up …`). |
| `SERVICE_PENDING`           | You asked `restart` for a service still waiting on its dependencies: it has not started, so nothing was touched. Wait until it starts, or restart what it waits on (`details.waiting_on`, the command is in `details.remedy`). |
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
