# devtrees reference

The full command surface. The [README](../README.md) has the quick start and
the concepts; [coding-agents.md](coding-agents.md) has the onboarding block for
coding agents.

- [Commands and flags](#commands-and-flags)
- [Namespaces](#namespaces)
- [Namespaced shared services](#namespaced-shared-services)
- [Referencing ports in a command](#referencing-ports-in-a-command)
- [Where devtrees keeps its state](#where-devtrees-keeps-its-state)
- [Agent surface (`--json`)](#agent-surface---json)
- [Error codes](#error-codes)

## Commands and flags

```bash
devtrees --help        # list commands
devtrees --version     # print the version
devtrees <cmd> --help  # per-command flags, examples, and emittable error codes
```

Commands (from the exported `COMMANDS` manifest in [`src/cli.ts`](../src/cli.ts)):

| Command             | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `devtrees up`       | Bring up this worktree's stack                                            |
| `devtrees down`     | Stop this worktree's stack (`--shared` tears down the shared instance, `--shared -n` one namespace's shared services) |
| `devtrees restart`  | Restart named isolated services (or `-n` namespaces) in place; the rest of the stack keeps running |
| `devtrees ls`       | List every instance with status, namespaces and ports (`--services`)     |
| `devtrees attach`   | Attach a TUI to this worktree's instance (`--shared` for the shared one)  |
| `devtrees prune`    | Reconcile against `git worktree list` and clean up orphaned instances     |
| `devtrees env`      | Print this worktree's injected env (KEY=value, or `--json` for a map)     |
| `devtrees logs`     | Stream a service's logs (`--follow`, `--tail=N`, `--since=DUR`, `--all`, `--shared`) |
| `devtrees init`     | Write the coding-agent onboarding block into AGENTS.md/CLAUDE.md (`--agents`) |

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
  [ADR-0009](adr/0009-per-service-and-per-namespace-lifecycle-control.md).
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
- `devtrees down --shared -n <namespace>` (repeatable) stops only the shared
  services of those namespaces, and takes `--force` and `--dry-run`; see
  [Namespaces](#namespaces). A plain `down` takes no `-n`
  (`INVALID_ARGS`): a worktree's `down` always stops its whole instance.
- Every command accepts `--json` (see below).

## Namespaces

A service can declare a process-compose `namespace:` to make it optional.
Namespaces are **opt-in** and selection is **exact**
([ADR-0008](adr/0008-up-converges-to-declared-state-and-namespace-selection.md)):

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

## Namespaced shared services

A shared service with no `namespace:` is **always on**: every `up` uses it,
and the first `up` in any worktree starts it. A shared service **with** a
`namespace:` runs only once an `up` selects one of its namespaces
([ADR-0010](adr/0010-namespaced-shared-services-and-scoped-drift.md)).
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
  `devtrees down --shared`, or `devtrees down --shared -n <namespace>`,
  even when no `up` selects it any more.
- **`devtrees down --shared -n <namespace>`** (repeatable,
  [ADR-0012](adr/0012-namespaced-shared-teardown.md)) stops and removes
  only the shared services of the named namespaces: each one's
  `shutdown` hook runs, with the same bounded stop and force-kill as
  `restart`, then devtrees drops it from the shared derived config and
  process-compose re-reads that config, the reload that adds services. The
  other shared services keep running with the same pids and ports. It all
  happens under the shared lock, so it never interleaves with an `up` that
  is adding or restarting shared services.
  - It also forgets the revision the removed services ran, so the next
    `up -n <namespace>` adds them with its current definition and no
    `SHARED_DRIFT`. Their numbers stay in the stable shared port map, so
    `env` keeps injecting them and the services come back on them.
  - It refuses with `SHARED_IN_USE` while a running worktree has a booted
    isolated service that `depends_on` one of them, listing each in
    `details.dependants`. `--force` removes them anyway; the dependants keep
    running without them. A kept shared service that depends on one also
    refuses, and `--force` does not override that: name its namespace too.
    devtrees finds the dependants by reading every live worktree instance's
    derived config, which records the cross-tier edges it dropped (a
    service a pending hot-reload is applying counts as booted); for an
    instance started by an older devtrees it reads that worktree's
    `devtrees.yaml`, and an instance it cannot read counts as a dependant.
    A worktree with an `up`, `down` or `restart` in flight (its lifecycle
    lock held) counts too (`source: lifecycle_in_progress`) when it may use a
    target: an `up` there may be waiting for shared health, with no socket
    yet. An `up` past its shared step has recorded which shared services it
    uses (its shared-step marker: the ones it selected, plus the ones its
    booted isolated services depend on, which selection never pulls in), so
    it blocks only when it uses a target (listed in `depends_on`); a
    worktree `down` never blocks; an `up`
    not yet past its shared step, and a `restart`, still do. The teardown
    waits for such a command (up to 15s, outside the shared lock) and starts
    over. If it is still running after that, the refusal's `details.remedy`
    is the plain retry: `--force` never overrides an in-flight command.
  - An `up` that adds a removed service back while process-compose still
    lists it stopped (a removal whose reload timed out) starts it again, and
    lists it in `shared_restarted`.
  - When every drifted or dead shared service an `up` reports is
    namespaced, `SHARED_DRIFT` and `SHARED_SERVICE_DEAD` name this command
    as `details.remedy`: `devtrees down --shared -n <namespace> --force &&
    devtrees up -n …`. It leaves the other shared services running. The
    `--force` is there because the worktrees using a broken service would
    otherwise refuse its teardown. It interrupts them, as the full
    `down --shared` would.
  - A namespace with no running shared service is a no-op (exit 0), listed in
    `inactive_namespaces`. An always-on shared service has no namespace, so
    `-n` never stops it, not even `-n default`.
  - When the removed services were the last running ones, the whole shared
    instance stops, exactly as with `devtrees down --shared`
    (`instance_stopped: true`).
  - `--dry-run --json` previews it (`down_dry_run`: `services`,
    `would_stop_instance`, `dependants`, `blocked`) with no side effects.
  - An `up` racing it from another worktree waits for the shared lock, about
    10s. A stop that takes longer makes that `up` fail `LOCK_CONTENTION`;
    retry it.
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
  or the restarted service dies again or never becomes healthy, `up` fails
  with `SHARED_SERVICE_DEAD` (`details.reason`).
- When the shared instance is already running, `up` also waits (up to
  `--wait-timeout`) for every shared service it selects to be healthy before
  it succeeds: one another worktree just restarted may still be failing its
  readiness probe. So `--wait-timeout` can apply twice in one `up`, once to
  the shared services and once to the worktree's, and the worst case is
  about double it.
- `env` takes no `-n`, so it checks only the always-on shared services.
- Every `up` and `env` still injects every shared service's ports, selected or
  not.
- **Shared ports are stable by name.** The first `up` that sees a shared
  named port records its number in the shared port map
  (`<git-common-dir>/devtrees/shared-ports.json`), under the shared lock, and
  every later `up` and `env`, on any branch, uses that number. So two
  worktrees whose branches declare different shared services still agree on
  each one's port, and adding a namespaced shared service never moves a port
  some worktree was already given. A name seen for the first time takes its
  positional number in the shared block, or the lowest free one if a recorded
  name holds it. The map survives `down --shared`, like the shared block
  ([ADR-0011](adr/0011-shared-ports-are-stable-by-name.md)).
- `env --json` reports each shared port's origin in `shared_ports`
  (`{NAME: {port, origin}}`): `active` (a running shared service binds it),
  `recorded` (in the map) or `predicted` (no `up` recorded it yet; `env` and
  `up --dry-run` read the map but never write it). `ls --json` lists the map
  as `ls.shared_ports`, `active` or `recorded`.
- devtrees never hands one port to two names. When the map records a number
  another name holds, a running shared service binds a name at another
  number, or a service this `up` would add has a port a running shared
  process was given a different number for, `up` fails with
  `SHARED_PORT_CONFLICT` and changes nothing. Its remedy is
  `devtrees down --shared && devtrees up`. A stale number in a running shared
  process's env that nothing this `up` starts depends on is only warned about.
- The map only grows, so names no branch uses any more can fill the shared
  block. A new name then fails `SHARED_PORT_CONFLICT` (`reason: block_full`)
  instead of starting with its port unset. `devtrees prune --shared-ports`
  drops every recorded name no instance holds (no running shared service
  binds it, no derived config on disk carries it); it refuses with
  `LOCK_CONTENTION` while an `up` (before its shared step), `down` or
  `restart` is in flight, and counts the ports an `up` past its shared step
  injects as held. `--dry-run` shows what it would drop, and which in-flight
  commands would make it refuse, without a lock or a write. A recorded port
  outside the current shared block (after a `block_size` or `port_base`
  change) keeps its number and is warned about on every `up` and `env`. To
  move it into the block, stop what runs with it (`devtrees down --shared`,
  and `devtrees down` in each running worktree that injects it), then run
  `devtrees prune --shared-ports`: outside the block, a name is dropped once
  nothing running holds it, and the next `up` gives it an in-block number.
- A map entry that is not a valid port is ignored with a warning, and the
  next `up` (or `prune --shared-ports`) rewrites the map without it.
- A shared instance started by devtrees 0.4.0 or older has no map: the first
  `up` seeds it from the instance's live numbers (its bound ports and the env
  of its processes), restarting nothing.
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

## Referencing ports in a command

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

## Where devtrees keeps its state

Derived configs, the allocation registry and per-instance logs live in
`<git-common-dir>/devtrees/` — inside the git dir, so no `.gitignore` entry is
needed and bare-repo layouts work the same
([ADR-0001](adr/0001-shared-instance-anchored-at-git-common-dir.md)).

Control sockets are the exception. A unix socket path has to fit in `sun_path`
(104 bytes on macOS), which a deep checkout's git dir blows through, so they
live in a short per-user run dir keyed by a hash of the repo:
`$XDG_RUNTIME_DIR` (or `/tmp`) `/devtrees-<uid>/<repo-hash>/<instance>.sock`
([ADR-0007](adr/0007-control-sockets-in-a-short-runtime-dir.md)). Set
**`DEVTREES_RUNTIME_DIR`** to move that dir — useful if your `XDG_RUNTIME_DIR`
is itself long, or `/tmp` is unusable. If a socket path still cannot fit,
`devtrees up` fails with `SOCKET_PATH_TOO_LONG` rather than letting
process-compose die at `bind(2)` with no diagnostic.

## Agent surface (`--json`)

devtrees treats coding agents as first-class users
([ADR-0005](adr/0005-agent-friendly-cli-by-default.md)). Every command
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

## Error codes

The full enum the error envelope can carry, defined in
[`src/output.ts`](../src/output.ts) (`ERROR_CODES`). Each subcommand's `--help`
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
| `HEALTH_TIMEOUT`            | Stack started but services did not report healthy before the wait window expired, or a selected service is dead, including one `up` or `restart` restarted (`details.dead_services`); after `restart`, `devtrees restart <service>` retries it. |
| `NAMESPACE_NOT_RUNNING`     | `up -n` named a namespace the running instance was not booted with, or `restart` named a service in one, or such a namespace with `-n`; `details` has `{worktree_id, namespaces, services, remedy}`, the remedy being the `down` + `up` that boots it. |
| `SHARED_SERVICE_DEAD`       | A shared service `up` could not bring back (`details.reason`): process-compose refused to restart it (`start_refused`, `details.start_failures`), it died again after `up` restarted it (`died_again`), it died while `up` waited on it (`died_while_waiting`), it did not become healthy within `--wait-timeout` (`not_healthy`, `details.unhealthy_services`), or the shared instance records no state to check it against (`unknown_revision`). Other dead shared services `up` restarts itself. Run `details.remedy` (`devtrees down --shared && devtrees up`). |
| `SERVICE_START_FAILED`      | `up` tried to restart a dead service on the running instance, or `restart` a named one, and process-compose refused; `details.services` names each one, `details.remedy` says what to run next. The instance is still running. |
| `SHARED_SERVICE_REFUSED`    | `restart` named a shared service; a worktree never restarts the shared instance's services. Nothing was touched; `details` has `{services, remedy}`, the remedy being `devtrees down --shared && devtrees up` (for every worktree). |
| `LAST_SERVICES_RUNNING`     | `restart` would have to stop the instance's last running process (a `Pending` service does not count), and process-compose would then exit and take the instance down; nothing was touched. `details.services` names them, `details.remedy` is the `down` + `up` that restarts the instance. |
| `SERVICE_PENDING`           | `restart` named a service still waiting on its dependencies (`Pending`): it has not started, so there is nothing to restart, and nothing was touched. `details` has `{services, waiting_on, remedy}`: wait until it starts, or restart what it waits on. |
| `CONFIG_DRIFT`              | Running config differs from devtrees.yaml and hot-reload failed, or an earlier reload is still pending; `details.reason` is `timeout`, `not_supported`, `error`, or `reload_pending` (nothing was reloaded: kill `details.pids`, then retry; empty `pids` means the old process is gone and process-compose is still starting the new one, so retry shortly). |
| `SHARED_DRIFT`              | A shared service this `up` selects diverges from the revision the running shared instance runs (an `up` that does not select it is unaffected); `details.services` lists each `{service, running_hash, local_hash}`, `details.port_conflicts` each named port a running shared service already owns, `details.remedy` is `devtrees down --shared && devtrees up` (for every worktree). |
| `SHARED_START_FAILED`       | The lazy-started shared instance died before binding its control socket; `details.config_path` is the config to run by hand. |
| `SHARED_ACTIVATION_FAILED`  | Adding a selected namespaced shared service to the running shared instance failed (process-compose refused or timed out on the config reload); the shared services it already ran are untouched. `details` has `{services, reason, config_path, remedy}`. |
| `SHARED_PORT_CONFLICT`      | A shared named port cannot be resolved without handing one port to two names or moving a recorded one (the stable shared port map, #238): `details.conflicts` lists each `{reason, port_name, port, recorded_port?, holder?, process?}` (`reason`: `port_taken`, `bound_mismatch`, `stale_env`, or `block_full` when the shared block has no free number left); nothing was started, added or recorded. `details.remedy` is one command: `devtrees down --shared && devtrees up` (run for every worktree), or `devtrees prune --shared-ports` for `block_full`; `details.map_path` is the map. |
| `SHARED_IN_USE`             | `down --shared -n` refused: something still depends on a shared service it would remove. `details.dependants` lists each `{instance, service, depends_on, source}` (a live worktree's booted isolated service, a worktree with an `up` or `restart` in flight that may use a target, `source: lifecycle_in_progress`, whose `depends_on` lists the targets an `up` past its shared step uses, or a shared service it would keep, `instance: shared`). Nothing was stopped. `details.forceable` says whether `--force` overrides it (a shared dependant and a command still in flight after the wait never are); `details.remedy` is the one command to run: the plain retry while a command is in flight. |
| `SHARED_REMOVAL_FAILED`     | `down --shared -n` could not finish removing the shared services (`details.reason`): process-compose refused to stop them or they did not stop (`stop_refused`, `stop_incomplete`: nothing was removed), or it refused or timed out on the config reload that removes them (`not_supported`, `error`, `timeout`). The other shared services are untouched. `details` has `{services, reason, config_path, remedy}`; run `details.remedy`. |
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
[ADR-0005](adr/0005-agent-friendly-cli-by-default.md) for the
versioning policy.
