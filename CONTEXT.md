# Devtrees

`devtrees` is a tool that extends [process-compose](https://github.com/F1bonacc1/process-compose) so the same project can run its services in multiple git worktrees at once, without the worktrees colliding with each other.

## Language

**Devtrees**:
The tool itself. Runs a project's services inside a single git worktree in a way that does not collide with the same project running in other worktrees. It does **not** create, remove, or otherwise manage git worktrees — that stays with `git` and the developer.
_Avoid_: "the wrapper", "the orchestrator" (process-compose is the orchestrator; devtrees configures it).

**Worktree**:
A git worktree — a checkout of the repo in its own directory. The unit of parallelism: each worktree runs its own copy of the project. Created and removed by the developer with `git worktree`, never by devtrees.

**Stack**:
The set of services a project runs, as defined for process-compose. Each worktree runs its own instance of the stack.
_Avoid_: "environment", "project" (overloaded), "compose".

**Service**:
One process in the stack (e.g. `postgres`, `web`, `worker`). The developer assigns each service a tier — `shared` or `isolated` — in the project's devtrees config.

**Isolated service**:
A service that runs a separate copy per worktree, with worktree-unique ports and worktree-local state, so worktrees cannot interfere with each other. The default tier.

**Shared service**:
A service that runs as a single instance serving all worktrees; each worktree's stack connects to that one instance instead of starting its own.

**Worktree instance**:
The process-compose instance that runs one worktree's isolated services. One per worktree that is "up".

**Shared instance**:
The single process-compose instance that runs all shared services for the repo. Anchored at the **anchor** and discovered from there by every worktree. Its lifecycle is independent of any worktree instance: lazily started by the first worktree that needs it, never stopped by a worktree going down, torn down only by an explicit command.

**Anchor**:
The fixed, always-present location the shared instance is rooted at and discovered from: the repo's git common dir (`git rev-parse --git-common-dir`) — `<main>/.git` in a normal repo, the bare dir in a bare-repo setup. "Anchored" means *located/discovered there* — it does **not** mean owned by the main worktree's stack.
_Avoid_: conflating "anchored to main" with "owned by main"; conflating the common dir (`.git`) with the main worktree's root.

**Tier**:
The per-service classification that decides where a service runs: `shared` (one instance for the whole repo) or `isolated` (one copy per worktree). Set per service; defaults to `isolated`.

**devtrees.yaml**:
The single config file a developer edits. Defines services either inline or by extending an existing `process-compose.yaml` (the **base config**), and attaches a `tier` to each service. The only devtrees-specific addition to the process-compose schema is the per-service `tier` field. It is never run by process-compose directly.

**Base config**:
An existing, hand-authored `process-compose.yaml` that `devtrees.yaml` extends. Remains a valid, standalone, independently-runnable process-compose file; devtrees reads it but never edits it.

**Derived config**:
A clean process-compose config that devtrees generates from `devtrees.yaml` + base config: tier keys stripped, services partitioned by tier, isolation values injected. Disposable build artifact, one per instance (shared-subset, isolated-subset). Emitted to disk on demand via `devtrees generate`.

**Injected value**:
A value devtrees computes and passes into a worktree instance as an environment variable / process-compose var, for the author to reference in their commands. Three kinds: an **allocated port** (this worktree's own isolated named ports, unique per worktree), **shared-service connection info** (the shared services' named ports, injected repo-wide and identical in every worktree), and the **worktree id**.

**Named port**:
A port a service declares in its `ports` list as the verbatim env-var name it should be injected as (e.g. `ports: [WEB_PORT]`). Devtrees allocates a number for it — worktree-unique for an isolated service, repo-wide for a shared one — and injects it as exactly that env var. The author references it as `${WEB_PORT}` in commands or reads it straight from the process environment; devtrees imposes no naming convention and does no name mangling.

**Worktree id**:
A stable per-worktree identifier devtrees injects so the author can de-collide otherwise-global names — unix sockets, container names, absolute state paths — that working-directory isolation does not cover. Derived from the worktree's absolute path: a human-readable slug of the directory basename plus a short path-hash suffix (e.g. `login-3f9c2a1b`), so same-basename worktrees at different paths get distinct ids and no worktree id can ever equal the reserved `shared` stem.

**Port block**:
The contiguous range of ports allocated to one worktree. Each of the worktree's named ports maps to a fixed offset within its block, so the port numbers are derived from the block base.

**Allocation registry**:
The per-repo record, kept at the anchor, mapping each worktree to its port block. A block is chosen by hashing the worktree id, linear-probing past any collision or in-use ports, and persisting the result so it stays stable across restarts. The **shared instance** is itself an entry in the registry (keyed by the anchor) and gets its own block, so a worktree discovers shared-service ports by reading the registry. Scoped to the repo only — there is no machine-global state, so two different repos can in principle pick overlapping blocks (a configurable per-repo port base mitigates this).

**Control socket**:
The unix domain socket a process-compose instance exposes its API on, at a path derived from the instance's id under the anchor's run dir (e.g. `<anchor>/.devtrees/run/<worktree-id>.sock`, plus a fixed `shared.sock`). Clients and devtrees talk to an instance through it; enumerating the run dir is how devtrees discovers every running instance and detects stale ones.

**Anchor state**:
A `devtrees/` directory *inside* the anchor (the git common dir) — i.e. `<git-common-dir>/devtrees/` — where devtrees keeps everything it needs to reason about the whole repo's running state: the allocation registry, the per-instance control sockets, the derived configs, and the shared instance's persisted name→port map (what the running shared instance actually bound, plus a hash of the shared subset it was started from — worktrees inject shared connection info from this map rather than recomputing it, and a worktree whose shared subset diverges from it fails with `SHARED_DRIFT`). Because it lives inside the git dir it is never part of the working tree, so it needs no `.gitignore` entry and works identically for normal and bare repos.

## Flagged ambiguities

_(none yet)_

## Example dialogue

> **Dev:** I've got the `login` worktree and the `billing` worktree both up. Are they fighting over Postgres?
>
> **Maintainer:** No — Postgres is a **shared service**, so it runs once in the **shared instance** at the **anchor**. Both worktrees just connect to it; its port is injected into each as `DB_PORT`.
>
> **Dev:** And the web server?
>
> **Maintainer:** That's `isolated`, so each worktree runs its own in its own **worktree instance**. They got different **allocated ports** out of their **port blocks** — `login` is on one number, `billing` on another. You reference it as `${WEB_PORT}` and never think about the number.
>
> **Dev:** What if I `devtrees down` the `login` worktree — does Postgres go too?
>
> **Maintainer:** No. `down` only stops that worktree instance. The shared instance is decoupled — it stays up for `billing`. You'd only stop Postgres with `down --shared`.
>
> **Dev:** I removed the `login` worktree with `git worktree remove` but its stack was still running.
>
> **Maintainer:** Right — devtrees doesn't manage git, so it didn't notice. Run `devtrees prune` and it'll reconcile against `git worktree list` and clean up the orphan.
