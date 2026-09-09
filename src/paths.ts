/**
 * Anchor state paths.
 *
 * Durable devtrees state — derived configs, per-instance logs, the allocation
 * registry, the shared instance's persisted name→port map — lives in
 * `<git-common-dir>/devtrees/`. Because that directory is inside the git dir,
 * it is never part of the working tree: no `.gitignore` entry is needed and the
 * same layout works for normal and bare repos (CONTEXT.md "Anchor state",
 * ADR-0001).
 *
 * **Control sockets are the exception** (issue #156, ADR-0007). A unix-domain
 * socket path has to fit in `sockaddr_un.sun_path` — 104 bytes on macOS, 108 on
 * Linux — and `<git-common-dir>/devtrees/run/<worktree-id>.sock` blows that
 * budget on any deep checkout (a `.../.claude/worktrees/agent-<id>/.git/...`
 * layout reaches 163 bytes). The bind then fails silently: process-compose
 * prints nothing, the socket never appears, and `up` fails with an unrelated
 * timeout envelope. So sockets live under a short, per-user runtime dir keyed
 * by a hash of the anchor — `<runtime-base>/devtrees-<uid>/<anchor-hash>/` —
 * which keeps the same two uniqueness guarantees the anchor path gave for free:
 * one namespace per repo (the anchor hash) and one file per instance inside it
 * (the worktree id, which already carries its own path hash).
 *
 * The shared instance has a fixed identity at the anchor: its derived config
 * lives at `<anchor>/devtrees/shared.yaml` and its control socket at
 * `<run-dir>/shared.sock`. It is registered in the allocation registry under
 * the well-known key `__shared__` (CONTEXT.md "Allocation registry") so a
 * worktree can read the registry and discover the shared services' ports
 * without any other coordination.
 */

import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Well-known registry key for the shared instance's port block. */
export const SHARED_REGISTRY_KEY = "__shared__";

/**
 * Filename stem used for the shared instance's derived config + control socket
 * (`shared.yaml`, `shared.sock`). Distinct from the registry key so the
 * on-disk filename stays human-readable.
 */
export const SHARED_INSTANCE_ID = "shared";

/**
 * Escape hatch for the runtime base dir (issue #156). Points devtrees at a
 * different parent for the control-socket dir — useful when the default base
 * is itself too long (an exotic `XDG_RUNTIME_DIR`), when `/tmp` is mounted
 * `noexec`/read-only, or to sandbox a test run.
 */
export const RUNTIME_DIR_ENV = "DEVTREES_RUNTIME_DIR";

/**
 * Usable bytes of a unix-domain socket path. `sun_path` is `char[104]` on
 * macOS and `char[108]` on Linux, and the kernel needs room for the trailing
 * NUL — so the path itself gets one byte less. Measured in *bytes*, not
 * characters: a non-ASCII directory name costs more than its length suggests.
 */
export const SOCKET_PATH_MAX_BYTES = process.platform === "darwin" ? 103 : 107;

/** Hex chars of the anchor hash that namespaces one repo's run dir. */
const ANCHOR_HASH_LENGTH = 12;

/**
 * Thrown when a control-socket path does not fit in `sun_path` (issue #156).
 *
 * The relocation to a short runtime dir makes this all but unreachable in
 * practice, so this is a guard rail rather than a routine failure — but it has
 * to exist and it has to be loud. Before it did, the over-long path surfaced
 * as "the socket never appeared" and got misdiagnosed as a startup crash
 * (issue #154 chased exactly that ghost). The CLI maps it to the
 * `SOCKET_PATH_TOO_LONG` envelope (ADR-0005); `details` carries the offending
 * path, its size, the limit, and the env var that overrides the base dir, so
 * an agent can act without a second round-trip.
 *
 * Module-private, like the error classes in `commands.ts`: the `code` field —
 * not the class identity — is the contract callers branch on (`classifyError`
 * in `output.ts` reads it structurally).
 */
class SocketPathTooLongError extends Error {
  readonly code = "SOCKET_PATH_TOO_LONG" as const;
  readonly details: {
    readonly socket_path: string;
    readonly length_bytes: number;
    readonly max_bytes: number;
    readonly runtime_dir_env: string;
  };
  constructor(details: {
    readonly socket_path: string;
    readonly length_bytes: number;
    readonly max_bytes: number;
  }) {
    super(
      // No `devtrees:` prefix — the CLI's human formatter adds one (output.ts).
      `the control socket path is ${details.length_bytes} bytes, over this ` +
        `platform's unix-socket limit of ${details.max_bytes} — process-compose cannot ` +
        `bind it and would fail with no diagnostic of its own. Point ` +
        `${RUNTIME_DIR_ENV} at a shorter directory (e.g. \`export ${RUNTIME_DIR_ENV}=/tmp\`) ` +
        `and retry. Path: ${details.socket_path}`,
    );
    this.name = "SocketPathTooLongError";
    this.details = { ...details, runtime_dir_env: RUNTIME_DIR_ENV };
  }
}

/** The `devtrees/` state directory inside the anchor (git common dir). */
export function stateDir(anchor: string): string {
  return join(anchor, "devtrees");
}

/**
 * Base directory the per-user run dir is created under. Precedence:
 *
 *   1. `DEVTREES_RUNTIME_DIR` — the explicit escape hatch.
 *   2. `XDG_RUNTIME_DIR` — the per-user, 0700, tmpfs-backed runtime dir Linux
 *      already provides for exactly this purpose (`/run/user/<uid>`).
 *   3. `/tmp` — deliberately NOT `os.tmpdir()`: on macOS that resolves to the
 *      per-user `/var/folders/<xx>/<hash>/T/`, ~49 bytes, which would eat half
 *      the `sun_path` budget the relocation exists to reclaim. `/tmp` costs 4.
 */
function runtimeBase(env: NodeJS.ProcessEnv): string {
  const override = env[RUNTIME_DIR_ENV];
  if (override !== undefined && override !== "") return override;
  const xdg = env["XDG_RUNTIME_DIR"];
  if (xdg !== undefined && xdg !== "") return xdg;
  return "/tmp";
}

/**
 * The run dir holding this repo's per-instance control sockets:
 * `<runtime-base>/devtrees-<uid>/<anchor-hash>` (issue #156).
 *
 * The `<uid>` segment keeps two users on one machine out of each other's dir
 * when the base is a shared `/tmp`; the anchor hash keeps two repos apart, so
 * `shared.sock` means one repo's shared instance and nothing else. Exported
 * because discovery enumerates this dir directly — the socket file is the only
 * liveness marker devtrees keeps (`instances.ts`).
 */
export function runDir(anchor: string, env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? 0;
  const hash = createHash("sha256").update(anchor).digest("hex").slice(0, ANCHOR_HASH_LENGTH);
  return join(runtimeBase(env), `devtrees-${uid}`, hash);
}

/**
 * The run dir devtrees used before #156 — `<anchor>/devtrees/run`. Nothing is
 * ever written here any more; discovery still reads it so an instance started
 * by an older devtrees stays visible to `ls` and reclaimable by `prune`
 * instead of silently becoming an unreachable orphan across the upgrade.
 */
export function legacyRunDir(anchor: string): string {
  return join(stateDir(anchor), "run");
}

export interface InstancePaths {
  readonly stateDir: string;
  readonly runDir: string;
  readonly configPath: string;
  readonly socketPath: string;
}

/** Per-instance derived-config and control-socket paths, keyed by worktree id. */
export function instancePaths(anchor: string, worktreeId: string): InstancePaths {
  return {
    stateDir: stateDir(anchor),
    runDir: runDir(anchor),
    configPath: join(stateDir(anchor), `${worktreeId}.yaml`),
    socketPath: join(runDir(anchor), `${worktreeId}.sock`),
  };
}

/**
 * Guard the bind sites: throw `SocketPathTooLongError` when `socketPath` would
 * overflow `sun_path` (issue #156). Called before `driver.up` spawns
 * process-compose — never on the read paths, so `ls`/`down`/`prune` keep
 * working against whatever is already on disk.
 */
export function assertSocketPathFits(socketPath: string): void {
  const lengthBytes = Buffer.byteLength(socketPath, "utf8");
  if (lengthBytes <= SOCKET_PATH_MAX_BYTES) return;
  throw new SocketPathTooLongError({
    socket_path: socketPath,
    length_bytes: lengthBytes,
    max_bytes: SOCKET_PATH_MAX_BYTES,
  });
}

/**
 * Create this repo's run dir (0700) and return it.
 *
 * The dir now lives outside the git dir, and its default base (`/tmp`) is
 * world-writable, so the `devtrees-<uid>` level is verified to be a real
 * directory we own with no group/other write bit — otherwise another local
 * user could pre-create it and read (or impersonate) every service's control
 * socket. A failed check is fatal and explicit: silently binding into a
 * hostile directory is the one outcome worth refusing outright.
 */
export function ensureRunDir(anchor: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = runDir(anchor, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(join(runtimeBase(env), `devtrees-${process.getuid?.() ?? 0}`));
  return dir;
}

/** Fail unless `dir` is a directory owned by us that no one else can write. */
function assertPrivateDir(dir: string): void {
  const stats = statSync(dir);
  const uid = process.getuid?.();
  if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
    throw new Error(
      `refusing to use '${dir}' for control sockets — it is not a directory ` +
        `owned by the current user. Remove it, or point ${RUNTIME_DIR_ENV} elsewhere.`,
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(
      `refusing to use '${dir}' for control sockets — it is group- or ` +
        `world-writable. Run \`chmod 700 ${dir}\`, or point ${RUNTIME_DIR_ENV} elsewhere.`,
    );
  }
}

/**
 * Per-instance on-disk logs dir — `<anchor>/devtrees/logs/<instanceId>/` (issue
 * #136). devtrees templates an authored `log_location` under this dir and emits
 * the resolved absolute path as process-compose `log_location`, so the same
 * authored filename in two worktrees lands in different files (no cross-worktree
 * collision). `instanceId` is the worktree id for isolated services and
 * `SHARED_INSTANCE_ID` (`shared`) for the shared tier.
 */
export function logsDir(anchor: string, instanceId: string): string {
  return join(stateDir(anchor), "logs", instanceId);
}

/**
 * Paths for the shared instance — its derived config fixed at
 * `<anchor>/devtrees/shared.yaml` and its control socket at
 * `<run-dir>/shared.sock`. There is only ever one shared instance per repo, so
 * its filenames are constant rather than keyed.
 */
export function sharedInstancePaths(anchor: string): InstancePaths {
  return instancePaths(anchor, SHARED_INSTANCE_ID);
}
