# Namespaced shared services join the shared instance on demand, and shared drift is scoped to the selection

A consumer wants one database every worktree shares by default, and an isolated copy only for a branch that changes the schema: a shared `db-shared` in namespace `db-shared` and an isolated `db` in namespace `db`, booted with `up -n app -n db-shared` or `up -n app -n db` (#236). Two rules made this impossible:

- **#130 rejected `namespace:` on a shared service** ("a repo-wide singleton and always runs"). Without a namespace, every `up` lazy-starts every shared service. So an `up -n web` boot that never touches the database starts it anyway, and an isolated-database boot runs two databases.
- **`SHARED_DRIFT` hashed the whole shared subset.** Any difference between a worktree's shared services and the running shared instance failed **every** `up` in that worktree, including ones that use none of the differing services. The only remedy, `down --shared`, kills the shared instance under every other worktree. So a PR that edits one shared definition breaks every boot on the other side.

## Decision

**A shared service may declare `namespace:`** (a string or a list, as for isolated services). With no namespace it is **always on**: every `up` selects it, exactly as before. With one, an `up` selects it when it selects one of its namespaces. A selected shared service's shared `depends_on` targets are selected with it, transitively: the shared instance is repo-wide, so there is no unselected copy to fall back to, and dropping the edge would start the dependent ungated.

**There is still exactly one shared instance (ADR-0001).** Its process-compose config holds only the shared services that some `up` has selected since it started:

- The lazy start spawns it with the **selected** shared services only.
- When an `up` selects a shared service the running instance does not run yet, devtrees **adds** it. It appends the service's process to the shared derived config and asks process-compose to re-read that config (`POST /project/configuration`, the reload path of #194). The processes already in the file are kept byte-for-byte, so process-compose sees them unchanged and leaves them running. It starts only the new ones. This was verified on v1.122.0: the running process keeps its PID, and smoke scenario 120 asserts it. A refused reload fails `up` with **`SHARED_ACTIVATION_FAILED`** and restores the previous config. A timed-out one keeps the new config and records the services, because process-compose may still apply it, and a later reload from a config without them would stop them again.
- An added service **stays** until `devtrees down --shared`. Nothing removes a shared service from a running instance: some other worktree may be using it, and devtrees keeps no reference count (ADR-0001 rejected ref-counting). This is the shared-tier form of "a running instance keeps what it was booted with" (ADR-0008). The set only grows, until the explicit teardown.

**Revisions are per service.** The shared state (`shared-state.json`) gains `services: {name: {hash, ports}}`: each running shared service's revision (`sharedServiceHash`, the same canonical fields the subset hash covers, namespace excluded) and the named ports it owns. An `up` compares **only the shared services it selects**:

- A selected service running at another revision is `SHARED_DRIFT`. The error names each such service with both revisions (`details.services[] = {service, running_hash, local_hash}`). The remedy is unchanged: `devtrees down --shared && devtrees up`.
- A selected service that is not running is added, not drift. That includes a branch that adds an always-on shared service: it no longer forces a `down --shared`.
- A selected service that is not running, but declares a named port a running shared service owns, is `SHARED_DRIFT` too (`details.port_conflicts[]`). An example is a branch that renamed a shared service but kept its port. Adding it would bind a port the instance already uses.
- A shared service the `up` does not select is never checked, however far it has drifted. Neither is a running shared service this worktree no longer declares.

So drift in one shared service blocks only the `up`s that use it, and never blocks the others. Drift in an always-on shared service still fails every `up`, because every `up` selects it.

**What selects.** The fresh path uses the namespaces it is about to boot. On a running instance, an explicit `-n` selects what it names. A bare `up` selects the namespaces the instance booted, read back from process-compose (ADR-0008), as a pending hot-reload would leave them (#210). That read happens only when the stack declares a namespaced shared service, so a stack without one pays nothing. A namespace that holds **only** shared services leaves no trace in the worktree project, so a bare `up` cannot see that it was booted and does not select it. Consumers pass `-n` for it, which a script that boots by mode does anyway. Persisting the boot selection would fix this, but ADR-0008 rejected that as a second source of truth.

**Everything else follows the selection.** The dead-shared-service check (`SHARED_SERVICE_DEAD`) and the shared-health wait for dropped cross-tier edges (ADR-0003) cover the selected shared services only. `env` has no `-n`, so it checks drift for the always-on shared services only. `up --dry-run` reports `selected_shared_services`, and its `shared_config` previews exactly those. The `up` envelope gains `shared_activated[]`. Port injection is unchanged: every worktree gets every shared service's named port. For a service the instance does not run yet, that is the number adding it would bind. A port is bound only once, so an unbound port whose positional number a running service already holds moves to the lowest free number in the shared block.

## Compatibility

- **Stacks without a namespaced shared service** behave as before, with two exceptions. Adding a shared service on a branch now adds it to the running instance instead of failing `SHARED_DRIFT`. A branch that removes a shared service no longer fails at all. Edits still fail.
- **A `shared-state.json` written before this change** has no `services`. When this worktree's definitions of the running services (the processes in the shared derived config) hash to its whole-subset `hash`, they are taken as the running revisions. Otherwise each running service's revision is `unknown`, and it drifts for an `up` that selects it. That is the old behaviour, scoped.
- **An older devtrees beside this one.** The state's `hash` stays the whole-subset hash of the always-on shared services, so an older devtrees whose stack has the same always-on services keeps matching. It cannot parse a stack with a namespaced shared service at all (#130).
- **New codes and fields** are additive under ADR-0005: `SHARED_ACTIVATION_FAILED`, `SHARED_DRIFT.details.{services, port_conflicts, remedy}`, `up.shared_activated`, `up_dry_run.selected_shared_services`. `SHARED_DRIFT.details.running_hash`/`local_hash` now carry the first drifted service's revisions. Before, they were whole-subset hashes; both only ever meant "these differ".

## Considered Options

- **One shared instance per namespace** (`shared`, `shared@db-shared`, …): each group gets its own socket, state and drift, so scoping would come for free. Rejected because every tool that knows "the shared instance" would have to handle many: `ls`, `down --shared`, `attach`/`logs --shared`, `prune`, the run-dir discovery and the registry key. A list-valued namespace has no single group. Shared-to-shared `depends_on` across groups would cross instances, and need the ADR-0003 treatment a second time.
- **Keep one instance and boot it with `-n`**: process-compose cannot widen a running instance's namespace selection (ADR-0008), so the second namespace could never start without a `down --shared`.
- **Remove a shared service when no `up` selects it any more**: needs to know whether any worktree still uses it, which is the ref count ADR-0001 rejected.
- **Restart a drifted selected shared service in place**: a worktree-scoped command would bounce a process other worktrees use, the interference ADR-0008 forbids for dead shared services.
- **Keep whole-subset drift and only add namespaces**: still lets one PR's shared edit block every unrelated boot, which is half of #236.

## Consequences

- Supersedes #130's rejection of `namespace:` on shared services, and the parts of ADR-0008 and the glossary that say shared services run regardless of `-n`. The ADR-0001 lifecycle stands: lazily started, never stopped by a worktree, torn down only by `down --shared`. What it contains now grows on demand.
- The shared instance now gets config reloads, which before this change it never did. They only ever **add** processes. A reload never edits or removes one, so a service already running is never restarted by one.
- `down --shared` is unchanged and stops every shared service, namespaced or not. A per-namespace shared teardown is not provided. Add it if a consumer asks.
