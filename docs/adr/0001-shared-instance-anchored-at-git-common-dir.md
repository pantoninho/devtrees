# Shared services run in one instance anchored at the git common dir

Devtrees runs two kinds of process-compose instance: a **worktree instance** per worktree (isolated services) and a single **shared instance** for all `shared` services. The shared instance is anchored at — rooted in and discovered via — the repo's git common dir (`git rev-parse --git-common-dir`), which is the main worktree in a normal repo and the bare repo dir in a bare-repo worktree setup. Its lifecycle is independent of any worktree: lazily started by the first worktree that needs it, never stopped when a worktree goes down, torn down only by an explicit command.

## Considered Options

- **Host-worktree ownership** (whichever worktree starts first runs the shared services): rejected — `devtrees down` in that worktree kills services other worktrees are actively using.
- **Owned by the main worktree's stack**: rejected — forces the main stack to be "up" just to get shared services, and couples shared teardown to main. We keep "anchored at main's location" but decouple lifecycle.
- **Ref-counted auto-stop** (stop shared when the last worktree downs): rejected — the ref count desyncs on unclean exits (crash, `kill -9`, sleep), orphaning or prematurely killing shared services.
- **Anchor at the main worktree directly** instead of the git common dir: rejected — breaks the bare-repo worktree pattern, which has no main worktree. The common dir exists in both layouts.

## Consequences

- There are always two instance topologies in play; tooling that lists/attaches to instances must handle both.
- The shared instance can outlive every worktree; an explicit teardown/prune command is required, and stale-instance reconciliation is devtrees's responsibility (it does not manage git worktrees).
- All devtrees runtime state (registry, control sockets, derived configs) lives in `<git-common-dir>/devtrees/`. Because that path is inside the git dir, it is never part of the working tree — no `.gitignore` entry is needed and the same path works for normal and bare repos.
