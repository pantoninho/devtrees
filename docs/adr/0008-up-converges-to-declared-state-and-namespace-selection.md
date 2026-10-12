# `up` converges an instance to declared state; namespaces are opt-in and fixed at boot

`devtrees up` used to mean two different things depending on whether the worktree instance was already running. On a fresh start it spawned process-compose and health-waited. On a running instance it compared the stack hash, hot-reloaded on drift, and printed `'<id>' is up.` whatever state the services were in. Two bugs fell out of that split: a dead service in a running instance was never restarted and never reported (#162), and `up -n <new namespace>` on a running instance silently started nothing (#170). Both are the same lie — success reported for a stack that is not what was asked for — and both need one stated contract for `up` rather than two patches. This ADR is that contract. It is implemented by #173 (the v1.122.0 minimum), #174 (health never `ready` when not running), #175 (the stack hash covering every forwarded field), #176 (opt-in namespaces and `NO_SERVICES_SELECTED`), #177 (the running-instance check, fail-loud, and `NAMESPACE_NOT_RUNNING`), #178 (restarting dead isolated services and `SERVICE_START_FAILED`) and #179 (list-valued namespaces and dropped cross-namespace edge warnings).

## The contract

**`up` converges an instance to the declared and selected state, additively.** It never stops anything. Success means every _selected_ service is healthy, on a fresh start and on an already-running instance alike. A running instance that is already converged makes `up` a no-op that still verifies health; a half-dead one makes `up` repair it or fail naming what it could not repair. `is up.` is never printed on the strength of the instance merely existing.

**Namespace selection is exact.** `-n/--namespace` is forwarded verbatim to process-compose, once per value. `-n app` selects `app` and nothing else; it does **not** imply `default`. A consumer that wants both writes `-n default -n app`.

**Namespaces are opt-in.** A fresh bare `up` (no `-n`) starts only `default` — the services that declare no `namespace:`. A service in a named namespace never starts unless that namespace is asked for. If a bare fresh `up`'s `default` selection resolves to zero services, `up` fails with `NO_SERVICES_SELECTED` instead of starting an empty instance and reporting it healthy. Whether `-n` naming a namespace that has no services is the same error was not decided here; it is left to the implementing ticket (#176). There is no "all namespaces" flag; add one if a consumer asks.

**`namespace:` accepts a string or a list**, as process-compose does from v1.122.0. A service in several namespaces is selected if _any_ of them is. A `depends_on` edge from a selected service to an unselected one is dropped by process-compose; devtrees reports the dropped edges rather than letting the dependent start ungated without a trace (the same observability ADR-0003 asks of dropped cross-tier edges).

**The minimum supported process-compose is v1.122.0.** The list form of `namespace:` and the exclusion behaviour below were verified on that version, and devtrees relies on both.

### Bare `up` on a running instance

A running instance has a boot-time selection, and a bare `up` must neither widen nor narrow it. Rather than persist the selection, devtrees reads it back from the instance: **a bare `up` targets the namespaces whose declared services are all present in the process-compose project.** This is exact because process-compose omits `-n`-excluded services from the project entirely (verified on v1.122.0), so "present" means "was selected at boot". The "all present" clause is what keeps it correct when a service belongs to several namespaces: a namespace that only partly appears was not booted, and one of its services being present merely because it also belongs to a booted namespace must not count.

### Adding a namespace to a running instance is not supported

process-compose has no runtime way to widen the selection. `namespace start` reports "not found" for an excluded namespace, and `project update -n` ignores namespaces that `-n` excluded at boot (both verified on v1.122.0). So `up -n <namespace that was not booted>` on a running instance fails with `NAMESPACE_NOT_RUNNING`, names the namespaces, and tells the caller to `down` then `up`. Failing loudly is #170's own fallback ask, and it is strictly better than the previous silent success. If a consumer needs the incremental "boot the backend now, add the simulator later" flow, the route is devtrees-side filtering of the derived config (so unselected services are present but stopped, rather than absent) — a different design, deferred until someone needs it.

### Dead versus done

Reconciliation needs a definition of "dead" that does not mistake a finished one-shot for a crash. `Completed` with exit code 0 is a legitimately finished one-shot (a migration, a seed step) and is healthy. `Completed` with a non-zero exit or a signal exit — a killed process reports `-1` — is **dead**, as are `Failed` and `Error`. The #162 reproduction is exactly the `Completed`/`-1` case: `kill -9` produced `status: "Completed"`, which a check on status alone would have waved through. The JSON surface has the same hole: `health: "ready"` was reported for that dead process. The decision: devtrees reports health as not-ready whenever process-compose says the process is not running (`is_running: false`), in `ls`, `ls --json` and `up --json`, regardless of process-compose's stale `is_ready`. Health is never `ready` for a process that is not running (#174).

### Reconcile: restart dead isolated services, report dead shared ones

On a running worktree instance `up` **restarts dead selected isolated services**, then health-waits on them like a fresh start. If a restarted service does not become healthy within the wait window, `up` fails with `HEALTH_TIMEOUT` and leaves the instance running (ADR-0005); `SERVICE_START_FAILED` is only for the start request itself failing. These are this worktree's own processes, so restarting them touches nothing outside it.

Dead **shared** services are **reported, not restarted**: `up` fails, naming the service and the remedy `devtrees down --shared && devtrees up`. The shared instance serves every worktree (ADR-0001) and its lifecycle is independent of any one of them; a worktree's `up` silently bouncing a service other worktrees depend on would be exactly the cross-worktree interference devtrees exists to prevent.

## Supersedes #128

This ADR supersedes two parts of #128, the issue that introduced `namespace:` passthrough and `-n`:

- **"With no `-n`, all namespaces start (unchanged default)"** is replaced by opt-in namespaces: a bare `up` starts only `default`. The #128 default was chosen to leave existing configs unchanged, but it makes a namespace something you can only _subtract_, the opposite of what the motivating consumer (optional local backends) wants — a service declared as optional should not start unless asked for.
- **Its scope note** that changing the namespace set on a running instance is out of scope, and that "switching subsets is `down` then `up` with the new `-n`", is replaced by the explicit contract above: the unsupported case now fails with `NAMESPACE_NOT_RUNNING` instead of being undefined, and a bare `up` on a running instance has a defined target.

The rest of #128 stands: `namespace` is a process-compose-native key copied through the deriver (ADR-0002), the health wait's expected set is narrowed to the selected namespaces, and named ports are allocated and reserved regardless of which namespaces a given run starts.

## Considered Options

- **Keep "no `-n` means all namespaces"** (#128's default): rejected — it makes optional services impossible to declare. Any service in a named namespace starts on every bare `up` unless the caller remembers to subtract it.
- **Make `-n app` imply `default`**: rejected — it makes `-n` non-exact, so devtrees would no longer be forwarding what the user typed, and it leaves no way to run a named namespace without the default services. Exactness is also what lets the flag stay a verbatim passthrough.
- **Persist the booted namespace selection** (in the registry or a state file) and compare against it: rejected — it is a second source of truth that can disagree with what is actually running, and it would have to be written, migrated and cleaned up. Reading the selection back from the process-compose project is exact and stateless.
- **An "all namespaces" flag**: not added. Nothing needs it yet, and the spelling is cheap to choose once someone does.
- **Make `up` honest but not reconciling** (#162 ask 1: report and exit non-zero, never restart): rejected as the contract, though it remains the behaviour for shared services. For isolated services the restart is safe, and without it the only recovery for one dead process is an instance-wide `down` + `up` — in the reporter's stack that meant resetting a local database to bring back one Python process.
- **Restart dead shared services too**: rejected for the reason above — a worktree-scoped command must not bounce a repo-wide process.
- **Start the new namespace's services over the control socket** (#170 ask 1): not possible on v1.122.0, as above.
- **Support process-compose below v1.122.0**: rejected — the list form is what makes a service in two namespaces expressible, and the exclusion behaviour that makes bare-`up` target resolution exact was only verified from that version.

## Consequences

- **`up` can now fail on a running instance** where it used to print `is up.` and exit 0: for a dead shared service, for a restart process-compose refused (`SERVICE_START_FAILED`), for a restarted service that never became healthy (`HEALTH_TIMEOUT`, instance left running), and for an unbooted namespace. This is the intent, but a script that tolerated the old output will see new non-zero exits.
- **Existing configs change behaviour.** A stack whose services carry `namespace:` and which was started with a bare `up` used to start everything; it now starts only the services with no namespace, or fails with `NO_SERVICES_SELECTED` if there are none. The caller's fix is to name the namespaces with `-n`. This is accepted pre-stable (ADR-0005's walking-skeleton policy) and belongs in the release notes.
- **The booted selection is only knowable from a live instance.** Nothing records what a past run selected, so nothing survives `down`; the next fresh `up` starts from its own flags. That matches the instance lifecycle and is deliberate.
- **Dropped cross-namespace `depends_on` edges are another thing the derived config hides from `devtrees.yaml`.** Reporting them is part of the contract, not a nicety, for the reason ADR-0003 gives.
- **Three new error codes, additive under ADR-0005** (no `schema_version` bump): `NAMESPACE_NOT_RUNNING` (an `up -n` names a namespace the running instance did not boot; `details` carries the namespaces and the `down` + `up` remedy), `NO_SERVICES_SELECTED` (a bare fresh `up`'s `default` selection resolves to zero services), and `SERVICE_START_FAILED` (the start command itself failed: process-compose refused or errored when `up` asked it to start or restart a selected service; `details` names the service). A service that starts but never becomes healthy, including one reconcile restarted, is the existing `HEALTH_TIMEOUT`, with the instance left running. Like `WORKTREE_START_FAILED`, they exist because agents branch on `error.code` and the distinction must not live in prose they would have to parse.
- **The health wait runs on a running instance too**, because success is defined as every selected service healthy on both paths. Per-service state in the `up` result on a running instance follows from that; it is not a separate output commitment.
