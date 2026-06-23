/**
 * Config deriver.
 *
 * Transforms a `ResolvedStack` plus an allocation into clean process-compose
 * configs and the matching env injection, one per instance topology:
 *
 *  - **Worktree instance** (`deriveWorktreeConfig`): only `isolated` services.
 *    The author's named ports resolve to this worktree's allocated numbers, and
 *    the shared services' named ports — identical in every worktree — are
 *    injected as connection info so isolated services can reach shared ones
 *    with no hardcoding (CONTEXT.md "Injected value", ADR-0001).
 *  - **Shared instance** (`deriveSharedConfig`): only `shared` services. The
 *    shared services' named ports resolve to the repo-wide shared block.
 *
 * Both strip the devtrees-only `tier` key, pin `working_dir` (the worktree root
 * for isolated processes; the anchor for shared ones — ADR-0002 filesystem
 * isolation does not apply to shared services), and inject each named port as
 * exactly its declared env-var name. Commands are never rewritten.
 *
 * Pure data transforms, no I/O. Per-named-port numbers arrive via injected
 * `portFor` lookups so the deriver stays decoupled from the allocator.
 */

import { join } from "node:path";
import { SHARED_INSTANCE_ID, logsDir } from "./paths.js";
import type { ResolvedStack, Tier } from "./stack.js";

/** Env-var name devtrees injects the stable worktree id under. */
const WORKTREE_ID_ENV = "DEVTREES_WORKTREE_ID";

/**
 * Default process-compose `depends_on` condition. Same as process-compose's own
 * default — startup ordering only, no health gating.
 */
const DEFAULT_DEPENDS_ON_CONDITION = "process_started";

/** A single derived process-compose process entry (tier-free). */
export interface DerivedProcess {
  readonly command: string;
  readonly working_dir: string;
  readonly environment: ReadonlyArray<string>;
  readonly depends_on?: Readonly<Record<string, { condition: string }>>;
  /**
   * Opaque process-compose passthrough blocks. devtrees does not validate
   * their inner shape — whatever the author wrote in `devtrees.yaml` (or its
   * extends-base) is copied here unchanged so process-compose owns the
   * schema. Each is present only when the author declared it; no
   * `undefined` leaks into the derived YAML.
   */
  readonly readiness_probe?: Readonly<Record<string, unknown>>;
  readonly liveness_probe?: Readonly<Record<string, unknown>>;
  readonly availability?: Readonly<Record<string, unknown>>;
  /**
   * process-compose `shutdown` block (issue #134) — the teardown hook that runs
   * first on `down` (and `down --shared`) so a service can clean up out-of-band
   * resources before SIGKILL. Opaque object passthrough; present only when the
   * author declared it.
   */
  readonly shutdown?: Readonly<Record<string, unknown>>;
  /**
   * process-compose `is_daemon` flag (issue #134) — scalar passthrough for a
   * process whose `command` launches work into the background and returns.
   * Present only when authored; a declared `false` is preserved.
   */
  readonly is_daemon?: boolean;
  /**
   * process-compose `launch_timeout_seconds` (issue #134) — scalar passthrough,
   * companion to `is_daemon`. Present only when authored.
   */
  readonly launch_timeout_seconds?: number;
  /**
   * process-compose `namespace` the process belongs to (issue #128), copied
   * verbatim from the resolved stack. `up -n <ns>` starts only the selected
   * namespaces; present only when the author declared one — a namespace-less
   * service derives without the key (process-compose's implicit `default`).
   */
  readonly namespace?: string;
  /**
   * process-compose `log_location` (issue #136) — the **absolute** on-disk path
   * process-compose writes this process's logs to, so external tooling can tail
   * a component's log as a file. devtrees templates the author's relative
   * `log_location` under the per-instance logs dir (`<anchor>/devtrees/logs/
   * <instanceId>/`) so the same authored filename in two worktrees lands in
   * different files. Present only when the author declared one.
   */
  readonly log_location?: string;
  /**
   * process-compose `log_configuration` (issue #136) — opaque object passthrough
   * (rotation / format / flush), copied verbatim like `shutdown`; devtrees never
   * templates anything inside it. Present only when authored.
   */
  readonly log_configuration?: Readonly<Record<string, unknown>>;
}

/**
 * A `depends_on` edge devtrees dropped from a derived config because it crossed
 * the instance boundary (isolated → shared). Returned by the deriver so a
 * caller can surface it to the user — silent dropping would make the behavior
 * a mystery (ADR-0003 "Consequences").
 */
export interface DroppedEdge {
  readonly from: string;
  readonly to: string;
  readonly fromTier: Tier;
  readonly toTier: Tier;
}

/**
 * Devtrees-owned metadata embedded in the derived config under a
 * compose-spec-style `x-` extension key. process-compose ignores it (verified
 * against v1.110.0, including `is_strict: true`); devtrees reads it back at
 * `ls` time.
 *
 * `ports_by_service` exists because the per-process `environment:` lines are
 * a flat injection — every process carries every named port as connection
 * info — so the env alone cannot recover which ports a service *declares*
 * (issue #110). One entry per process in this instance; a portless service
 * gets an explicit `{}`.
 */
export interface DerivedMetadata {
  readonly ports_by_service: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Well-known key the derived config stores `DerivedMetadata` under. */
export const DEVTREES_METADATA_KEY = "x-devtrees";

/** The clean process-compose config for one instance. */
export interface DerivedConfig {
  readonly processes: Record<string, DerivedProcess>;
  readonly [DEVTREES_METADATA_KEY]: DerivedMetadata;
}

/** Resolves a declared named port to its allocated number, or undefined. */
export type PortResolver = (portName: string) => number | undefined;

export interface DeriveContext {
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  /**
   * Anchor (git common dir) — needed only to template a service's `log_location`
   * under the per-instance logs dir (`<anchor>/devtrees/logs/<worktreeId>/`,
   * issue #136). Optional: a stack with no `log_location` derives without it.
   * The deriver throws if a service authors `log_location` but no anchor was
   * provided — a programming error, since every production call site supplies it.
   */
  readonly anchor?: string;
  /** Resolve a declared isolated named port to its allocated number for this worktree. */
  readonly portFor: PortResolver;
  /**
   * Resolve a declared shared named port to its repo-wide allocated number.
   * Injected so the worktree instance gets the shared services' connection
   * info — identical in every worktree (CONTEXT.md "Injected value"). Optional:
   * a stack with no shared services may omit it.
   */
  readonly sharedPortFor?: PortResolver;
}

export interface DerivedWorktree {
  readonly config: DerivedConfig;
  /**
   * Flat env injection for the worktree instance: this worktree's own named
   * ports + the shared services' named ports + the worktree id. Identical for
   * every isolated process; an isolated service reaches a shared one through
   * the shared-port entry.
   */
  readonly env: Record<string, string>;
  /**
   * Cross-tier `depends_on` edges that were stripped from the derived config
   * because process-compose can't express a dependency on a process in another
   * instance (ADR-0003). Empty when nothing was dropped.
   */
  readonly droppedEdges: ReadonlyArray<DroppedEdge>;
}

/**
 * For each named port a service in `services` declares, look it up via `resolve`
 * and accumulate the resolved entries into `target`. Missing resolutions are
 * skipped — the deriver does not invent numbers it was not given.
 */
function collectPortEnv(
  services: ReadonlyArray<{ readonly ports: ReadonlyArray<string> }>,
  resolve: (portName: string) => number | undefined,
  target: Record<string, string>,
): void {
  for (const service of services) {
    for (const portName of service.ports) {
      const port = resolve(portName);
      if (port !== undefined) target[portName] = String(port);
    }
  }
}

/**
 * Build the per-service declared-port map for one instance's services: each
 * service's own `ports` list resolved to numbers. Unresolvable names are
 * skipped (the deriver does not invent numbers); a portless service keeps an
 * explicit `{}` so readers can distinguish "declares nothing" from "unknown
 * service".
 */
function collectPortsByService(
  services: ReadonlyArray<{ readonly name: string; readonly ports: ReadonlyArray<string> }>,
  resolve: PortResolver,
): Record<string, Record<string, number>> {
  const byService: Record<string, Record<string, number>> = {};
  for (const service of services) {
    const ports: Record<string, number> = {};
    for (const portName of service.ports) {
      const port = resolve(portName);
      if (port !== undefined) ports[portName] = port;
    }
    byService[service.name] = ports;
  }
  return byService;
}

/**
 * Derive the worktree instance's config + env injection from the stack and this
 * worktree's allocation. Only `isolated` services land in the worktree instance;
 * shared services' named ports are still injected as connection info.
 *
 * Per-process `depends_on` edges are partitioned by the dependency's tier:
 * same-tier (isolated → isolated) edges flow through to the derived config so
 * process-compose still enforces startup ordering within the worktree instance;
 * cross-tier (isolated → shared) edges are dropped (ADR-0003) and surfaced in
 * `droppedEdges` for visibility — the caller waits for shared services to be
 * healthy at the orchestration layer instead.
 */
export function deriveWorktreeConfig(stack: ResolvedStack, ctx: DeriveContext): DerivedWorktree {
  const isolated = stack.services.filter((s) => s.tier === "isolated");
  const shared = stack.services.filter((s) => s.tier === "shared");

  // The injection identical for every isolated process in this worktree:
  //  - the worktree id (for de-colliding global names)
  //  - this worktree's own named ports (allocated per-worktree)
  //  - the shared services' named ports (allocated repo-wide; identical in every worktree)
  const env: Record<string, string> = { [WORKTREE_ID_ENV]: ctx.worktreeId };
  collectPortEnv(isolated, ctx.portFor, env);
  if (ctx.sharedPortFor) collectPortEnv(shared, ctx.sharedPortFor, env);

  const { processes, droppedEdges } = buildTierProcesses({
    stack,
    tier: "isolated",
    services: isolated,
    workingDir: ctx.worktreeRoot,
    // Logs dir for this worktree instance — the authored `log_location` is
    // templated under it (issue #136). Resolved only when the anchor is known.
    logsBase: ctx.anchor !== undefined ? logsDir(ctx.anchor, ctx.worktreeId) : undefined,
    extraEnvLines: envLines(env),
  });

  return {
    config: {
      processes,
      [DEVTREES_METADATA_KEY]: { ports_by_service: collectPortsByService(isolated, ctx.portFor) },
    },
    env,
    droppedEdges,
  };
}

/** Context for the shared instance: the anchor (working dir) and the repo-wide port resolver. */
export interface SharedDeriveContext {
  /**
   * Absolute path the shared processes run in. Anchor (git common dir) by
   * default — shared services have no working tree of their own (ADR-0001).
   */
  readonly workingDir: string;
  /**
   * Anchor (git common dir) — needed only to template a shared service's
   * `log_location` under the shared instance's logs dir (`<anchor>/devtrees/
   * logs/shared/`, issue #136). Optional: a stack with no `log_location`
   * derives without it. The deriver throws if a service authors `log_location`
   * but no anchor was provided.
   */
  readonly anchor?: string;
  /** Resolve a declared shared named port to its repo-wide allocated number. */
  readonly portFor: PortResolver;
}

export interface DerivedShared {
  readonly config: DerivedConfig;
  /** Flat env injection for the shared instance: the shared services' named ports. */
  readonly env: Record<string, string>;
  /**
   * Cross-tier `depends_on` edges that were stripped from the shared config.
   * Always empty in practice because `shared → isolated` is rejected at load
   * time (stack.validateStack); exposed for symmetry with `DerivedWorktree`.
   */
  readonly droppedEdges: ReadonlyArray<DroppedEdge>;
}

/**
 * Derive the shared instance's config + env injection. Only `shared` services
 * land here. Each shared service's named ports are injected as exactly their
 * env-var names with the repo-wide allocated numbers, so the same value reaches
 * every worktree instance and the shared process itself.
 */
export function deriveSharedConfig(stack: ResolvedStack, ctx: SharedDeriveContext): DerivedShared {
  const shared = stack.services.filter((s) => s.tier === "shared");

  const env: Record<string, string> = {};
  collectPortEnv(shared, ctx.portFor, env);

  const { processes, droppedEdges } = buildTierProcesses({
    stack,
    tier: "shared",
    services: shared,
    workingDir: ctx.workingDir,
    // Shared-tier logs live under the fixed `shared` instance id so they never
    // collide with any worktree's logs (issue #136).
    logsBase: ctx.anchor !== undefined ? logsDir(ctx.anchor, SHARED_INSTANCE_ID) : undefined,
    extraEnvLines: envLines(env),
  });

  return {
    config: {
      processes,
      [DEVTREES_METADATA_KEY]: { ports_by_service: collectPortsByService(shared, ctx.portFor) },
    },
    env,
    droppedEdges,
  };
}

/** Flatten an env map into the `KEY=VALUE` lines process-compose's `environment` accepts. */
function envLines(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

/**
 * Build the derived `processes` map for one tier (isolated or shared): pins
 * `working_dir`, appends devtrees' env injection, and partitions each
 * service's `depends_on` into kept same-tier edges + dropped cross-tier
 * edges. Both `deriveWorktreeConfig` and `deriveSharedConfig` differ only in
 * which tier they pass in and which working_dir they use.
 */
function buildTierProcesses(input: {
  stack: ResolvedStack;
  tier: Tier;
  services: ReadonlyArray<{
    name: string;
    command: string;
    environment: ReadonlyArray<string>;
    dependsOn: ReadonlyArray<string>;
    readinessProbe?: Readonly<Record<string, unknown>>;
    livenessProbe?: Readonly<Record<string, unknown>>;
    availability?: Readonly<Record<string, unknown>>;
    namespace?: string;
    shutdown?: Readonly<Record<string, unknown>>;
    isDaemon?: boolean;
    launchTimeoutSeconds?: number;
    logLocation?: string;
    logConfiguration?: Readonly<Record<string, unknown>>;
  }>;
  workingDir: string;
  /**
   * Absolute per-instance logs dir (issue #136) under which an authored
   * `log_location` is templated, or `undefined` when no anchor was supplied. A
   * service that authors `log_location` without a logs base is a programming
   * error — the deriver throws rather than emit an un-templated path.
   */
  logsBase?: string;
  extraEnvLines: ReadonlyArray<string>;
}): { processes: Record<string, DerivedProcess>; droppedEdges: DroppedEdge[] } {
  const tierIndex = buildTierIndex(input.stack);
  const droppedEdges: DroppedEdge[] = [];
  const processes: Record<string, DerivedProcess> = {};
  for (const service of input.services) {
    const partition = partitionDependsOn(service.name, input.tier, service.dependsOn, tierIndex);
    droppedEdges.push(...partition.dropped);
    processes[service.name] = withOptionalDependsOn(
      {
        command: service.command,
        working_dir: input.workingDir,
        // Author-declared env first, then devtrees injection (injection wins on
        // duplicate keys because process-compose takes the last occurrence).
        environment: [...service.environment, ...input.extraEnvLines],
        // Opaque passthrough — only set when present, so the derived YAML
        // doesn't sprout `readiness_probe: undefined` for plain services.
        ...(service.readinessProbe !== undefined && { readiness_probe: service.readinessProbe }),
        ...(service.livenessProbe !== undefined && { liveness_probe: service.livenessProbe }),
        ...(service.availability !== undefined && { availability: service.availability }),
        // process-compose `namespace` passthrough (#128) — re-emitted verbatim,
        // only when authored, so namespace-less services derive without the key.
        ...(service.namespace !== undefined && { namespace: service.namespace }),
        // shutdown / daemon-launch passthrough (#134) — each emitted only when
        // the author declared it, so plain services derive unchanged. `shutdown`
        // is an opaque object; `is_daemon` / `launch_timeout_seconds` are
        // scalars copied verbatim (a declared `false` / `0` rides through).
        ...(service.shutdown !== undefined && { shutdown: service.shutdown }),
        ...(service.isDaemon !== undefined && { is_daemon: service.isDaemon }),
        ...(service.launchTimeoutSeconds !== undefined && {
          launch_timeout_seconds: service.launchTimeoutSeconds,
        }),
        // log persistence passthrough (#136). `log_location` is templated under
        // the per-instance logs dir to an absolute path so the same authored
        // filename in two worktrees never collides; `log_configuration` is an
        // opaque object copied verbatim. Each emitted only when authored, so a
        // service that declares neither derives unchanged.
        ...(service.logLocation !== undefined && {
          log_location: resolveLogLocation(service.name, service.logLocation, input.logsBase),
        }),
        ...(service.logConfiguration !== undefined && {
          log_configuration: service.logConfiguration,
        }),
      },
      partition.kept,
    );
  }
  return { processes, droppedEdges };
}

/**
 * Template a service's authored (relative, validated) `log_location` into the
 * per-instance logs dir, returning the absolute path process-compose writes to
 * (issue #136). `logsBase` is `undefined` only when no anchor reached the
 * deriver; a service that authored a `log_location` in that case is a
 * programming error (every production call site supplies the anchor), so we
 * throw rather than emit an un-rooted path that would defeat collision-proofing.
 */
function resolveLogLocation(
  serviceName: string,
  logLocation: string,
  logsBase: string | undefined,
): string {
  if (logsBase === undefined) {
    throw new Error(
      `cannot derive log_location for service '${serviceName}': no anchor was provided to the ` +
        `deriver, so the per-instance logs dir is unknown. Pass \`anchor\` in the derive context.`,
    );
  }
  return join(logsBase, logLocation);
}

/** Index `name → tier` over a resolved stack — keeps depends_on classification O(1). */
function buildTierIndex(stack: ResolvedStack): Map<string, Tier> {
  return new Map(stack.services.map((s) => [s.name, s.tier]));
}

/**
 * Split a service's `depends_on` list into edges to keep (same-tier, named
 * target exists) and edges to drop (cross-tier). Targets that aren't in the
 * stack at all are silently skipped: this slice rejects neither nor relays
 * them; a future "dangling deps" pass can lift them out.
 */
function partitionDependsOn(
  from: string,
  fromTier: Tier,
  deps: ReadonlyArray<string>,
  tierIndex: Map<string, Tier>,
): { kept: string[]; dropped: DroppedEdge[] } {
  const kept: string[] = [];
  const dropped: DroppedEdge[] = [];
  for (const to of deps) {
    const toTier = tierIndex.get(to);
    if (toTier === undefined) continue; // dangling; skip silently for now
    if (toTier === fromTier) {
      kept.push(to);
    } else {
      dropped.push({ from, to, fromTier, toTier });
    }
  }
  return { kept, dropped };
}

/** Attach a `depends_on` map keyed by `kept` names, or omit the field when empty. */
function withOptionalDependsOn(
  base: Omit<DerivedProcess, "depends_on">,
  kept: ReadonlyArray<string>,
): DerivedProcess {
  if (kept.length === 0) return base;
  const depends_on: Record<string, { condition: string }> = {};
  for (const name of kept) {
    depends_on[name] = { condition: DEFAULT_DEPENDS_ON_CONDITION };
  }
  return { ...base, depends_on };
}
