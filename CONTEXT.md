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

## Flagged ambiguities

_(none yet)_
