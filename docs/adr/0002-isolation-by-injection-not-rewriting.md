# Isolation by injection, not command rewriting

Devtrees makes `isolated` services non-colliding by **allocating per-worktree values and injecting them** (as env / process-compose vars) for the author to reference in commands. It never parses or rewrites command lines. Filesystem state is isolated for free by running each worktree instance with the worktree as the working directory, so relative paths are naturally worktree-local. The author is responsible for parameterizing their collision points (ports, absolute/shared paths, globally-named resources); devtrees can warn about unmanaged port binds but does not fix them.

Three kinds of value are injected into a worktree instance: (1) the worktree's allocated ports for its declared named ports, (2) the shared instance's connection info so isolated services can reach shared services, and (3) a stable per-worktree identifier for de-colliding otherwise-global names (sockets, container names, absolute paths).

## Considered Options

- **Command rewriting** (parse `--port 3000`, swap it): rejected — devtrees runs arbitrary binaries and cannot reliably know which token is a port/path across every CLI. Fragile and unbounded.
- **Pure offset convention** (inject one offset, author does `$((3000+OFFSET))`): rejected — shell arithmetic is ugly and inconsistent with process-compose's Go-template `vars`.

## Consequences

- Adopting devtrees requires a one-time parameterization of each service's collision points. This is explicit and debuggable but not zero-effort.
- A hardcoded/unparameterized port will collide across worktrees; devtrees surfaces the failure rather than preventing it.
