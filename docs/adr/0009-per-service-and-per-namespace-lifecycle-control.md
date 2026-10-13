# Per-service and per-namespace lifecycle control (`stop`, `restart`)

Every lifecycle verb devtrees had acted on a whole instance. Cycling one process meant `down` + `up`, which in the reporting stack also tore down Supabase's containers and the backend to bring back one Metro server, or reaching past the CLI into the process-compose socket (#160). A consumer that boots `-n app -n ios` and wants to give the simulator back while the backend keeps serving had the same problem one level up (#171). Namespaces bought selective boot but not selective stop. This ADR adds the two verbs that close the gap, `stop` and `restart`, and decides what they promise, because process-compose cannot tell devtrees whether a process was stopped on purpose or crashed.

## The contract

**Two new top-level verbs, `devtrees stop` and `devtrees restart`.** Each takes one or more service names and/or a repeatable `-n/--namespace <namespace>`, which expands to every isolated service in that namespace (a service in several namespaces is in the expansion if _any_ of them is named, as for `up`). Several names are processed one after another, in `depends_on` order, because `process start`, `process restart` and `namespace start|stop|restart` take exactly one target in process-compose v1.122.0 (only `process stop` accepts several), so devtrees loops. They act on this worktree's instance only.

**There is deliberately no `start`.** A stopped service comes back through `up`, which already restarts dead or stopped isolated services in the namespaces it covers (ADR-0008, reconcile). A separate `start` would be a second path that could disagree with `up`. In particular it would bring a service back on stale config by skipping the pending hot-reload, and `process start X` does not start stopped dependencies: a dependent with a `process_healthy` condition becomes `Skipped` and never runs. `up` orders by `depends_on`; that is why it is the bring-back path.

**A stop does not survive the next `up`.** process-compose reports a stopped process exactly like a crashed one: `Completed` with `exit_code -1`, the same as a SIGKILLed or externally SIGTERMed process (verified on v1.122.0; a finished one-shot shows `exit_code 0`). Telling "stopped on purpose" from "crashed" would need devtrees to record it, and ADR-0008 rejected persisting a second source of truth that can disagree with what is running. So the next `up` covering that namespace restarts the service, and `stop`'s output and the docs say so. `stop -n <namespace>` is transient in the same way; it delegates to process-compose `namespace stop`.

**`restart` restarts what it names, and only that.** `restart X` does not cascade to dependents, matching process-compose (`process restart` does not restart them). A consumer that wants dependents cycled names them.

**Bare `restart` restarts every booted isolated service in place**, in `depends_on` order. Ports, the instance id and connections are kept, shared services are untouched, and namespaces that were not booted stay unbooted (the booted set is read back from the project, as in ADR-0008). Bare `stop` with no arguments is an error that points to `down`. A clean slate is still `down` then `up`.

**Idempotent.** Stopping an already-stopped service succeeds, and restarting a stopped service succeeds. Validation happens before anything is touched: an unknown service name fails `SERVICE_NOT_FOUND` (the existing `logs` code, ADR-0005, with the same `details` of `{service, valid_services[]}`), a `-n` naming a namespace the instance did not boot fails `NAMESPACE_NOT_RUNNING`, and no running instance fails `INSTANCE_NOT_FOUND`.

**Shared services are refused with a named error.** Naming a shared service fails `SHARED_SERVICE_REFUSED`; a `-n` expansion contains isolated services only. Per ADR-0008, a worktree-scoped command must not bounce a repo-wide process (ADR-0001). A `--shared` flag is deferred.

### `restart` has `up` semantics for success

`restart` waits for the named services to be healthy and honours `--wait-timeout`. A service that does not become healthy fails `HEALTH_TIMEOUT` and is left running, so `logs` and `ls --json` still work afterwards (ADR-0005). `SERVICE_START_FAILED` is for process-compose refusing the restart request itself, as in ADR-0008. `--json` emits the usual envelope.

### `stop` waits for actual exit

`stop` is not done when process-compose accepts the request; it is done when the process is gone. It reuses `down`'s bounded-stop machinery (ADR-0005; #190, #208, #219). `process stop` signals the whole process group and escalates to SIGKILL after `shutdown.timeout_seconds`, but a process that calls `setsid()` escapes the group, and a `shutdown.command` that exits without stopping its process leaves the service `Terminating` forever. So `stop` allows the grace period (including the hook time limit), then force-kills what is left of the service's process group, reports it in `force_killed` (`[{service, pid}]`, as on `down`), and fails `SERVICE_STOP_INCOMPLETE` if a process still outlives that, with `details` naming it, mirroring `DOWN_INCOMPLETE`.

### `stop` refuses to stop the last running processes

process-compose v1.122.0 exits ("Project completed") when every process has stopped, unless booted with `--keep-project`. A `stop` that took the last running process would therefore silently `down` the instance, losing its socket and its debug surface under a command that promised only a service. So `stop` fails `LAST_SERVICES_RUNNING` if the stop would leave the instance with no running process, naming the services and pointing to `down`. Done one-shots and already-stopped services do not count as running.

### `ls` shows what is running

Acting on one service needs seeing it (#160 ask 3). `ls` gains a NAMESPACES column (booted namespaces, read back from the project as in ADR-0008) and a `--services` flag that prints one row per service. `ls --json` gains a `services[]` list per instance: `name`, `namespaces`, `tier` (`isolated` or `shared`), `status` (`active`, `dead` or `done`, from the existing dead-versus-done classification of ADR-0008) and `pid`. Additive.

## Considered Options

- **Persistent `down -n <namespace>`** (#171): deferred. It is implementable by hot-reloading a derived config without the namespace: process-compose removes the processes, the read-back then reports the namespace as unbooted, and re-adding works only for namespaces in the boot `-n` set. But every later reload would have to filter to the currently booted namespaces, or an edit to `devtrees.yaml` revives the downed one. It would also partly reverse ADR-0008's "adding a namespace is not supported". The cost and risk are not worth paying until a consumer needs it. #171 stays open; the transient `stop -n` covers the immediate need (give the simulator back; the next `up` that covers it brings it back).
- **A one-run launch override** (#160 ask 2, e.g. `restart mobile -- --clear`): deferred. process-compose has no per-start args. `POST /process` (UpdateProcess) replaces one process's config and restarts only it, but the override is sticky: it survives `process restart`, is invisible to devtrees' stack hash and drift detection, and is reverted by the next drift reload. Devtrees would have to record and revert it itself, which is state it does not keep today.
- **A `start` verb**: rejected, for the reasons above. It can be revisited if someone needs "bring back exactly this one service without reconciling the rest".
- **Recording intentionally stopped services**, so `up` leaves them stopped: rejected. It is the same second-source-of-truth argument ADR-0008 made against persisting the booted selection.
- **Bare `restart` as `down` + `up`**: rejected in favour of in place. It is faster and keeps ports and the instance alive. If in-place restart of the whole booted set proves too hard to do correctly, the fallback is that bare `restart` fails with a clear error for now.
- **Cascading restarts to dependents**: rejected. It matches process-compose, keeps `restart X` meaning X, and a dependent that must be cycled can be named.
- **Booting with process-compose `--keep-project`** so the last `stop` is allowed: deferred. It changes boot semantics and interacts with #203's empty-selection exit. `LAST_SERVICES_RUNNING` is the cheap guard.
- **Restart or stop shared services from a worktree**: rejected, per ADR-0008; `--shared` is deferred.

## Consequences

- **A stopped service is only stopped until the next `up`.** Anyone expecting `stop` to mean "keep it off for the session" will be surprised; `stop`'s output and the README say so. A script that wants it off must not call `up` on that namespace.
- **New error codes, additive under ADR-0005** (no `schema_version` bump): `SHARED_SERVICE_REFUSED` (a shared service was named), `LAST_SERVICES_RUNNING` (the stop would leave no running process; `details` names the services and the `down` remedy), `SERVICE_STOP_INCOMPLETE` (a process outlived the bounded stop and the force-kill), and `NO_SERVICES_GIVEN` (a bare `stop`, or a `-n` that expands to no isolated service). `SERVICE_NOT_FOUND` is reused from `logs`. Agents branch on `error.code`, so each distinction lives in a code rather than prose. The names are proposals for the implementer to confirm.
- **`ls --json` is extended additively**: a `services[]` list and a `namespaces` field per instance.
- **The README and `--help` need the new verbs**, the transient-stop caveat, and the error codes table.
- **The implementation reuses `down`'s bounded stop and `up`'s reconcile and health wait**; neither is a new mechanism, which keeps one definition of "stopped" and of "healthy".
- **`stop` can never end an instance**; `down` remains the only verb that does, apart from `prune`.
