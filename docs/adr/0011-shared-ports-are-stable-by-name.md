# Shared ports are stable by name, recorded in a shared port map

Since ADR-0010 (#237) a namespaced shared service joins the shared instance only when an `up` selects its namespace, and until then devtrees injects its _predicted_ port into every worktree. The prediction was positional: `resolveSharedPorts` gave each shared named port its offset in this worktree's shared layout, and moved it to the lowest free number when a bound port already held that offset. Both inputs differ between branches, so the prediction could go stale (#238):

1. **Different shared layouts across branches.** Branch A (`pg`, `x`) predicts `X_PORT` at slot 1. Branch B (`pg`, `y`, `x`) activates `y`, which takes slot 1. A's consumers, started earlier, now point `X_PORT` at `y`. When A later activates `x`, it moves to the lowest free number, and A's running consumers still hold the old one.
2. **Running processes keep their env.** Every shared process gets every shared port in its env. A process started before a later activation keeps the prediction it was started with, which the activation may contradict.

Both need a second shared service and two branches whose shared layouts differ, so a stack with one shared service was never affected. With two it is a silent miswiring. The smoke scenarios 130a and 130b reproduce it against v0.4.0: `login` and `billing` were injected different `X_PORT`s.

## Decision

**A shared port's number is assigned once per name and recorded.** The **shared port map**, `<anchor>/devtrees/shared-ports.json` (`{version: 1, ports: {NAME: port}}`), holds the number each shared named port got the first time any `up` saw it. Every `up` reads it under the shared lifecycle lock, in `ensureSharedStarted`, before it starts or adds anything:

- A recorded name keeps its number, always. Activation never reassigns one.
- An unrecorded name takes its positional number in the shared block when no recorded name holds that number, otherwise the lowest number in the block that no recorded name holds. A name seen for the first time therefore gets exactly the number it got before this change, and names recorded by another branch, which this stack does not declare, still reserve their numbers.
- The `up` records every shared port its stack declares, predicted or bound, and then derives the worktree and shared configs from the map. So the number injected into a consumer is the number the service will bind when some later `up` activates it, whichever branch that `up` runs on.

The map is separate from `shared-state.json` on purpose. That file describes what the **running** instance was started with, and a lazy start rewrites it. The map is a repo-wide reservation, and it has to survive that rewrite. Like the `__shared__` registry block (#51), it survives `down --shared`, so a consumer that remembers a shared port keeps a valid number across a shared restart. Nothing shrinks the map: removing a name would need the reference count ADR-0001 rejected. The shared block holds `blockSize` ports (32 by default), so names a stack no longer declares can run it out only after many renames. When the block is full, a new name gets no number, as before.

**Locks.** The map is written only inside the shared lifecycle lock, which `up` takes inside the worktree lifecycle lock. That keeps the existing acyclic order (worktree, then shared; no holder of the shared lock ever takes a worktree's). Two `up`s on different branches serialize on the shared lock, so the second reads the first's names. `env` and `up --dry-run` read the map and never write it, and they take no new lock. A name only they have seen is reported `predicted`, and becomes `recorded` at the next `up`.

**Never one port for two names.** Before it records or starts anything, `up` reconciles the map with what the shared instance already handed out. That is the bound ports in its state, and each derived process's env, taking the last `KEY=NUMBER` per key as process-compose does. The first claim on a number wins, in this order: map entries, bound ports, env. A claim that agrees with the map changes nothing. A claim for an unrecorded name on a free number is seeded into the map. Anything else is a conflict:

- `port_taken`: two names claim one number. Either the map records it twice (a hand edit), or a running service binds a number the map records for another name (an older devtrees beside this one activated a service without reading the map).
- `bound_mismatch`: a running service binds a name at a number other than the recorded one (same cause).
- `stale_env`: a running shared process was given a number for a name that is not the recorded number, or that belongs to another name.

`port_taken` and `bound_mismatch` fail every `up` whose stack declares one of the names involved, and `env` too, with **`SHARED_PORT_CONFLICT`** (`details.conflicts[] = {reason, port_name, port, recorded_port?, holder?, process?}`, `details.map_path`, `details.remedy`). Every declared shared port is injected into the worktree, so resolving such a name would either inject one number under two names or move a number someone was already given. There is no lowest-free fallback. The remedy is `devtrees down --shared && devtrees up` (for every worktree). The fresh start after it re-derives every shared process from the map, and it reports no conflict from a dead instance's numbers. A conflict between two map entries survives that, and the message says to remove one of them from the map.

**Running processes and stale env.** With the map in place, could case 2 still happen? Every number a shared process is started with comes from the map, recorded before the process's config is derived, and a recorded number never changes. So for any instance this version started, a running process's env can never disagree with the map. Only an instance started without a map can disagree, which means one started by devtrees 0.4.0 or older, or one beside an older devtrees, or one whose map was deleted. For those, `up`:

- **refuses** (`SHARED_PORT_CONFLICT`, `reason: stale_env`) to start or add the service that owns a name some running process holds a different number for. Adding it is exactly the step that would make the stale number wrong.
- **warns** for every other stale entry and goes on. The stale number is already in that process's env, and nothing this `up` does changes it.

Restarting the stale process instead was rejected. ADR-0008, as amended by #240, never lets a worktree-scoped `up` stop or restart a running shared service, because other worktrees use it. It may only start a dead one again. An automatic restart would bounce that process under every other worktree to fix an env var it may not even read, since every shared process gets every shared port whether it uses it or not. Refusing is loud, touches nothing, and the existing remedy (`down --shared`) clears it on purpose.

**Port origin.** `env --json` adds `shared_ports: {NAME: {port, origin}}` for every shared port the stack declares. `origin` is `active` when a running shared service binds the port (it is in the live instance's state), `recorded` when the map holds it, and `predicted` when only this read computed it. `ls --json` adds `ls.shared_ports`, the whole map plus any port the running instance binds that is not recorded yet, each `active` or `recorded`. `ls` reads no stack, so it never reports `predicted`. `up --dry-run` injects the same map numbers the real `up` would.

## Compatibility

- **Migration from 0.4.0.** A shared instance 0.4.0 started has `shared-state.json` but no map. The first `up` (or `env`, read-only) seeds the map from that instance's bound ports and the env its processes hold, including the 0.4.0 predictions for services it never activated. An env entry counts as a shared port when its name is known (declared by this stack, recorded, or bound) or its number lies in the shared block. Nothing is restarted or reloaded, and unchanged definitions raise no `SHARED_DRIFT`, because the drift check does not read the map. Smoke scenario 131 asserts this against the real binary: the running service keeps its pid, and the map holds the numbers 0.4.0 injected. A 0.4.0 instance that is already miswired raises `stale_env` as described above.
- **An older devtrees beside this one** ignores the map, so it can still hand a recorded number to another name. This version then sees `port_taken` or `bound_mismatch` and fails loudly, rather than injecting the wrong number.
- **First-time numbers are unchanged.** A stack seen for the first time gets the positional numbers it always got. The only numbers that differ from 0.4.0 are the ones that would have collided.
- **New code and fields** are additive under ADR-0005: `SHARED_PORT_CONFLICT`, `env --json`'s `shared_ports`, `ls --json`'s `ls.shared_ports`. `SHARED_DRIFT.details.port_conflicts` (a not-yet-running service declaring a port **name** a running one owns) is unrelated and unchanged.

## Considered Options

- **Keep the positional prediction and only detect staleness.** It still fails case 1 silently whenever the stale consumer is a worktree process, and devtrees cannot see worktree processes from the shared lock.
- **Record the map in `shared-state.json`.** That file is rewritten at every lazy start and describes one run of the shared instance. Mixing in a repo-wide reservation that must outlive the run makes every writer responsible for preserving it, including concurrent work on the shared lifecycle such as a per-namespace `down --shared` (#239). A separate file keeps the schema change additive and isolated.
- **Hash names to slots.** This is stable without a file, but two names can collide on a slot, and resolving the collision needs exactly the shared, ordered record this ADR keeps.
- **Restart stale shared processes.** Rejected above (ADR-0008).

## Consequences

- Supersedes ADR-0010's rule that "an unbound port whose positional number a running service already holds moves to the lowest free number". A number moves only the first time its name is seen, and it never moves after that.
- `resolveSharedPorts` is gone. `src/shared-ports.ts` owns the map, its reconciliation and the assignment.
- The map only grows. A consumer that renames many shared ports over time may want a way to compact it. None is provided; add one if asked, and it would need the same "nobody uses it" guarantee a shared-service removal would.
