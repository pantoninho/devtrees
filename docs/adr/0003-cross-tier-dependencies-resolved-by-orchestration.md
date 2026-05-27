# Cross-tier dependencies resolved at the orchestration layer

A `depends_on` edge from an isolated service to a shared service crosses the instance boundary: the two processes end up in different process-compose instances (worktree instance vs shared instance), so process-compose cannot express the dependency and would error on the unknown process.

Devtrees resolves this at the orchestration layer instead of inside process-compose: `devtrees up` waits for the shared services' readiness probes to report healthy *before* it derives and starts the worktree instance, then **drops the cross-tier `depends_on` edge** from the derived worktree config. Startup ordering is thus preserved (an isolated service still won't start until the shared service it depends on is healthy), matching process-compose's own startup-gating semantics.

Connection info is carried by the same named-port mechanism: a shared service's named ports are injected repo-wide into every worktree instance, so an isolated service reaches a shared one via injected `${...}` values with no special wiring.

A `shared` service may not `depends_on` an `isolated` service — that would mean depending on N per-worktree copies. Devtrees rejects this as a config error at load time.

## Considered Options

- **Inject a wait-process** into the worktree instance (a no-op process whose readiness probe pings the shared service) and re-point the edge at it: preserves runtime re-gating if the shared service restarts mid-session. Deferred as a later robustness upgrade; the orchestration-layer approach is simpler and matches process-compose's startup-only `depends_on` semantics.

## Consequences

- Cross-tier `depends_on` re-gates startup only, not mid-session restarts of shared services (same limitation as process-compose `depends_on`; runtime resilience is the dependent service's own retry/liveness concern).
- Dropping edges from the derived config is invisible in the source `devtrees.yaml`; tooling/output should make the dropped edges and the shared-health wait observable so the behavior isn't a mystery.
