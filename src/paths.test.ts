import { describe, expect, it } from "vite-plus/test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  RUNTIME_DIR_ENV,
  SHARED_INSTANCE_ID,
  SHARED_REGISTRY_KEY,
  SOCKET_PATH_MAX_BYTES,
  assertSocketPathFits,
  ensureRunDir,
  instancePaths,
  legacyRunDir,
  logsDir,
  runDir,
  sharedInstancePaths,
  stateDir,
} from "./paths.js";

/** A worktree path deep enough to reproduce the #156 overflow verbatim. */
const DEEP_ANCHOR =
  "/Users/somebody/dev/projects/monorepo/.claude/worktrees/agent-a4162b7436899b8cd/.git";

describe("anchor state paths", () => {
  it("roots durable state under <git-common-dir>/devtrees/ (no .gitignore needed)", () => {
    expect(stateDir("/repo/.git")).toBe("/repo/.git/devtrees");
  });

  it("keeps the per-instance derived config in the anchor, keyed by the worktree id", () => {
    expect(instancePaths("/repo/.git", "login").configPath).toBe("/repo/.git/devtrees/login.yaml");
  });
});

describe("control socket location (#156)", () => {
  const env = { [RUNTIME_DIR_ENV]: "/tmp" } as NodeJS.ProcessEnv;

  it("puts the socket in a short runtime dir, NOT under the (possibly deep) anchor", () => {
    const socket = join(runDir(DEEP_ANCHOR, env), "login-3f9c2a1b.sock");
    expect(socket.startsWith("/tmp/")).toBe(true);
    expect(socket).not.toContain(DEEP_ANCHOR);
  });

  it("fits in sun_path even for the deep checkout that reproduced the bug", () => {
    // The pre-#156 path for this anchor is 163 bytes — well past the limit.
    const legacy = join(legacyRunDir(DEEP_ANCHOR), "login-3f9c2a1b.sock");
    expect(Buffer.byteLength(legacy)).toBeGreaterThan(SOCKET_PATH_MAX_BYTES);

    const relocated = join(runDir(DEEP_ANCHOR, env), "login-3f9c2a1b.sock");
    expect(Buffer.byteLength(relocated)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);
  });

  it("namespaces the run dir per repo, so two repos never share a shared.sock", () => {
    expect(runDir("/a/.git", env)).not.toBe(runDir("/b/.git", env));
  });

  it("gives every worktree of one repo the same run dir but a distinct socket", () => {
    const login = instancePaths(DEEP_ANCHOR, "login-3f9c2a1b");
    const billing = instancePaths(DEEP_ANCHOR, "billing-77aa01ff");
    expect(dirname(login.socketPath)).toBe(dirname(billing.socketPath));
    expect(basename(login.socketPath)).toBe("login-3f9c2a1b.sock");
    expect(basename(billing.socketPath)).toBe("billing-77aa01ff.sock");
  });

  it("is stable across calls for the same anchor — discovery must recompute it", () => {
    expect(runDir(DEEP_ANCHOR, env)).toBe(runDir(DEEP_ANCHOR, env));
  });

  it("keeps two users apart when the base dir is a shared /tmp", () => {
    expect(runDir("/repo/.git", env)).toContain(`devtrees-${process.getuid?.() ?? 0}`);
  });

  it("honours DEVTREES_RUNTIME_DIR as the escape hatch", () => {
    const custom = { [RUNTIME_DIR_ENV]: "/tmp/elsewhere" } as NodeJS.ProcessEnv;
    expect(runDir("/repo/.git", custom).startsWith("/tmp/elsewhere/")).toBe(true);
  });

  it("prefers DEVTREES_RUNTIME_DIR over XDG_RUNTIME_DIR, and XDG over /tmp", () => {
    const both = {
      [RUNTIME_DIR_ENV]: "/tmp/explicit",
      XDG_RUNTIME_DIR: "/run/user/1000",
    } as NodeJS.ProcessEnv;
    expect(runDir("/repo/.git", both).startsWith("/tmp/explicit/")).toBe(true);
    const xdgOnly = { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv;
    expect(runDir("/repo/.git", xdgOnly).startsWith("/run/user/1000/")).toBe(true);
    expect(runDir("/repo/.git", {} as NodeJS.ProcessEnv).startsWith("/tmp/")).toBe(true);
  });

  it("still names the pre-#156 location, so discovery can read leftovers", () => {
    expect(legacyRunDir("/repo/.git")).toBe("/repo/.git/devtrees/run");
  });
});

describe("socket path length guard (#156)", () => {
  it("accepts a path at exactly the platform limit", () => {
    const path = `/tmp/${"a".repeat(SOCKET_PATH_MAX_BYTES - "/tmp/".length)}`;
    expect(Buffer.byteLength(path)).toBe(SOCKET_PATH_MAX_BYTES);
    expect(() => assertSocketPathFits(path)).not.toThrow();
  });

  it("throws SOCKET_PATH_TOO_LONG one byte past the limit, not a silent bind failure", () => {
    const path = `/tmp/${"a".repeat(SOCKET_PATH_MAX_BYTES + 1 - "/tmp/".length)}`;
    expect(() => assertSocketPathFits(path)).toThrow(/unix-socket limit/);
  });

  it("carries an actionable envelope: the path, its size, the limit, and the override", () => {
    const path = `/tmp/${"a".repeat(SOCKET_PATH_MAX_BYTES + 1 - "/tmp/".length)}`;
    try {
      assertSocketPathFits(path);
      expect.unreachable("expected assertSocketPathFits to throw");
    } catch (err) {
      const e = err as Error & {
        code: string;
        details: Record<string, unknown>;
      };
      expect(e.code).toBe("SOCKET_PATH_TOO_LONG");
      expect(e.details["socket_path"]).toBe(path);
      expect(e.details["length_bytes"]).toBe(SOCKET_PATH_MAX_BYTES + 1);
      expect(e.details["max_bytes"]).toBe(SOCKET_PATH_MAX_BYTES);
      expect(e.details["runtime_dir_env"]).toBe(RUNTIME_DIR_ENV);
      expect(e.message).toContain(RUNTIME_DIR_ENV);
    }
  });

  it("measures bytes, not characters — a multi-byte dir name costs its real width", () => {
    // 51 × 2-byte chars = 102 bytes, plus "/tmp/" = 107 bytes but only 56
    // characters: over the macOS limit, exactly at the Linux one.
    const path = `/tmp/${"é".repeat(51)}`;
    expect(path.length).toBeLessThan(SOCKET_PATH_MAX_BYTES);
    expect(Buffer.byteLength(path)).toBe(107);
    if (SOCKET_PATH_MAX_BYTES < 107) expect(() => assertSocketPathFits(path)).toThrow();
    else expect(() => assertSocketPathFits(path)).not.toThrow();
  });
});

describe("ensureRunDir (#156)", () => {
  it("creates the run dir private to the current user and returns it", () => {
    const base = mkdtempSync("/tmp/dt-run-");
    try {
      const env = { [RUNTIME_DIR_ENV]: base } as NodeJS.ProcessEnv;
      const dir = ensureRunDir("/repo/.git", env);
      expect(dir).toBe(runDir("/repo/.git", env));
      expect(() => ensureRunDir("/repo/.git", env)).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses a group/world-writable runtime dir rather than binding sockets into it", () => {
    const base = mkdtempSync("/tmp/dt-run-");
    try {
      const env = { [RUNTIME_DIR_ENV]: base } as NodeJS.ProcessEnv;
      // Pre-create the per-user level wide open, as a hostile /tmp squatter
      // would. chmod after mkdir: the mode argument is masked by the umask.
      const squatted = join(base, `devtrees-${process.getuid?.() ?? 0}`);
      mkdirSync(squatted);
      chmodSync(squatted, 0o777);
      expect(() => ensureRunDir("/repo/.git", env)).toThrow(/world-writable|not a directory/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("shared instance paths", () => {
  it("fixes the shared derived config at the anchor and its socket in the run dir", () => {
    const p = sharedInstancePaths("/repo/.git");
    expect(p.configPath).toBe("/repo/.git/devtrees/shared.yaml");
    expect(p.socketPath).toBe(join(runDir("/repo/.git"), "shared.sock"));
  });

  it("keeps the shared registry key distinct from any plausible worktree slug", () => {
    // The slugifier strips leading underscores, so a real worktree path can
    // never produce `__shared__` — the well-known key is unambiguous.
    expect(SHARED_REGISTRY_KEY).toBe("__shared__");
    expect(SHARED_INSTANCE_ID).toBe("shared");
  });
});

describe("per-instance logs dir (#136)", () => {
  it("roots a worktree instance's logs under <anchor>/devtrees/logs/<worktreeId>/", () => {
    expect(logsDir("/repo/.git", "login")).toBe("/repo/.git/devtrees/logs/login");
  });

  it("uses the shared instance id for the shared tier, so it never collides with a worktree", () => {
    expect(logsDir("/repo/.git", SHARED_INSTANCE_ID)).toBe("/repo/.git/devtrees/logs/shared");
  });
});
