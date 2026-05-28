/**
 * `runUp` orchestration tests.
 *
 * Exercise the wired-up behaviour — per-service multi-port mapping, per-repo
 * allocator config, lock-guarded allocation, and the unmanaged-port warning —
 * through the public `runUp` interface, with every side-effecting collaborator
 * (git, registry lock, port probe, process-compose driver) injected as a stub.
 * Asserts on the returned `UpResult.env` and on emitted warnings; no on-disk
 * state and no real `process-compose` are involved.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUp, findUnmanagedPortBinds, type CommandDeps } from "./commands.js";
import type { RegistrySnapshot } from "./allocator.js";
import type { ResolvedStack } from "./stack.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** Compact builder for a normalized service — keeps the test bodies declarative. */
function service(
  name: string,
  command: string,
  ports: string[] = [],
  tier: "isolated" | "shared" = "isolated",
) {
  return { name, tier, command, ports, dependsOn: [] as string[], environment: [] as string[] };
}
const isolated = (name: string, command: string, ports: string[] = []) =>
  service(name, command, ports, "isolated");

function tmpAnchor(): { anchor: string; worktreeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "dt-cmd-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { anchor: join(root, ".git"), worktreeRoot: join(root, "wt") };
}

/** Build a `CommandDeps` whose every collaborator is a deterministic stub. */
function stubDeps(opts: {
  stack: ResolvedStack;
  worktreeId?: string;
  initialRegistry?: RegistrySnapshot;
  isPortFree?: (port: number) => boolean;
  warn?: (m: string) => void;
}): CommandDeps {
  const { anchor, worktreeRoot } = tmpAnchor();
  const worktreeId = opts.worktreeId ?? "login";
  let snapshot: RegistrySnapshot = opts.initialRegistry ?? {};

  // Fake git: tell the anchor resolver everything it needs without spawning git.
  const git = (args: ReadonlyArray<string>): string => {
    const flag = args[1];
    if (flag === "--git-common-dir") return anchor;
    if (flag === "--show-toplevel") return join(worktreeRoot, worktreeId);
    if (flag === "--is-bare-repository") return "false";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };

  return {
    cwd: join(worktreeRoot, worktreeId),
    git,
    readStack: () => opts.stack,
    withRegistryLock: (_anchor, mutate) => {
      const after = mutate(snapshot);
      snapshot = after;
      return after;
    },
    isPortFree: opts.isPortFree ?? (() => true),
    warn: opts.warn,
    attach: false,
    // Driver that never spawns anything: short-circuit `up` to a no-op.
    driver: {
      exists: () => Promise.resolve(true),
      spawner: () => ({ on: () => {}, unref: () => {} }),
    },
  };
}

describe("runUp — port injection", () => {
  it("maps multiple named ports on one service to consecutive offsets within its block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js", ["WEB_PORT", "METRICS_PORT", "DEBUG_PORT"])],
    };
    const result = await runUp(stubDeps({ stack }));

    const web = Number(result.env.WEB_PORT);
    expect(web).toBeGreaterThanOrEqual(20000);
    expect(Number(result.env.METRICS_PORT)).toBe(web + 1);
    expect(Number(result.env.DEBUG_PORT)).toBe(web + 2);
  });

  it("gives each service its own non-overlapping sub-range when several declare ports", async () => {
    const stack: ResolvedStack = {
      services: [
        isolated("web", "node web.js", ["WEB_PORT", "METRICS_PORT"]),
        isolated("worker", "node worker.js", ["WORKER_PORT"]),
      ],
    };
    const result = await runUp(stubDeps({ stack }));
    const web = Number(result.env.WEB_PORT);
    const metrics = Number(result.env.METRICS_PORT);
    const worker = Number(result.env.WORKER_PORT);

    // Distinct numbers, all derived from one contiguous block.
    expect(new Set([web, metrics, worker]).size).toBe(3);
    // Worker comes after both web ports — third offset.
    expect(worker).toBe(web + 2);
  });

  it("rejects a stack that needs more ports than block_size allows", async () => {
    const stack: ResolvedStack = {
      allocator: { blockSize: 2 },
      services: [isolated("web", "node x.js", ["A_PORT", "B_PORT", "C_PORT"])],
    };
    await expect(runUp(stubDeps({ stack }))).rejects.toThrow(/block_size is 2/);
  });
});

describe("runUp — per-repo allocator config", () => {
  it("honours port_base from devtrees.yaml so two repos can keep their ranges apart", async () => {
    const stack: ResolvedStack = {
      allocator: { portBase: 40000, blockSize: 8 },
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUp(stubDeps({ stack }));
    expect(Number(result.env.WEB_PORT)).toBeGreaterThanOrEqual(40000);
    // First block starts at port_base; offset 0 maps to the block base.
    expect((Number(result.env.WEB_PORT) - 40000) % 8).toBe(0);
  });

  it("falls back to deps-level defaults when devtrees.yaml omits the allocator section", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };
    const result = await runUp(stubDeps({ stack }));
    const port = Number(result.env.WEB_PORT);
    expect(port).toBeGreaterThanOrEqual(20000);
    expect((port - 20000) % 32).toBe(0);
  });
});

describe("runUp — lock-guarded persistence", () => {
  const singleWebStack: ResolvedStack = {
    services: [isolated("web", "node x.js", ["WEB_PORT"])],
  };

  it("persists a freshly-allocated block under the lock so subsequent ups reuse it", async () => {
    const deps = stubDeps({ stack: singleWebStack });

    const first = await runUp(deps);
    const second = await runUp(deps);

    expect(second.env.WEB_PORT).toBe(first.env.WEB_PORT);
  });

  it("respects an already-registered block from the snapshot (stable across restarts)", async () => {
    const result = await runUp(
      stubDeps({ stack: singleWebStack, initialRegistry: { login: 30000 } }),
    );
    expect(result.env.WEB_PORT).toBe("30000");
  });
});

describe("runUp — double allocation prevention", () => {
  it("two worktrees sharing one registry get distinct, non-overlapping blocks", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node x.js", ["WEB_PORT"])],
    };

    // Both worktrees share the same registry and lock so the second `up` sees
    // the first's allocation and probes past it — exactly the contract under
    // concurrent `up`s once the lock has serialised them.
    let snapshot: RegistrySnapshot = {};
    const lock = (_a: string, m: (s: RegistrySnapshot) => RegistrySnapshot) => {
      const after = m(snapshot);
      snapshot = after;
      return after;
    };

    const loginDeps = { ...stubDeps({ stack, worktreeId: "login" }), withRegistryLock: lock };
    const billingDeps = { ...stubDeps({ stack, worktreeId: "billing" }), withRegistryLock: lock };

    const login = await runUp(loginDeps);
    const billing = await runUp(billingDeps);

    const loginPort = Number(login.env.WEB_PORT);
    const billingPort = Number(billing.env.WEB_PORT);
    expect(loginPort).not.toBe(billingPort);
    // Blocks are 32-wide by default; the two must be at least one full block apart.
    expect(Math.abs(loginPort - billingPort)).toBeGreaterThanOrEqual(32);
  });
});

describe("runUp — unmanaged port warning", () => {
  it("warns when an isolated service's command appears to bind a port outside its block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js --port 3000", ["WEB_PORT"])],
    };
    const warnings: string[] = [];
    await runUp(stubDeps({ stack, warn: (m) => warnings.push(m) }));

    expect(warnings.some((w) => /3000/.test(w) && /web/.test(w))).toBe(true);
  });

  it("stays silent when every port literal in the command is inside the allocated block", async () => {
    const stack: ResolvedStack = {
      services: [isolated("web", "node server.js --port ${WEB_PORT}", ["WEB_PORT"])],
    };
    const warnings: string[] = [];
    await runUp(stubDeps({ stack, warn: (m) => warnings.push(m) }));

    expect(warnings).toEqual([]);
  });
});

describe("findUnmanagedPortBinds — heuristic", () => {
  const stack = (cmd: string): ResolvedStack => ({ services: [isolated("web", cmd)] });

  it("flags a `--port NNNN` literal outside the block", () => {
    expect(findUnmanagedPortBinds(stack("node x --port 3000"), 20000, 32)).toHaveLength(1);
  });

  it("flags a `:NNNN` host:port literal outside the block", () => {
    expect(findUnmanagedPortBinds(stack("redis-cli -h 127.0.0.1:6379"), 20000, 32)).toHaveLength(1);
  });

  it("ignores a literal that falls inside the block (caller already managed it)", () => {
    // 20000 is the block base — exactly inside [20000, 20031].
    expect(findUnmanagedPortBinds(stack("node x --port 20000"), 20000, 32)).toHaveLength(0);
  });

  it("ignores 3-digit numbers (too small to be a user port) and 6-digit numbers", () => {
    expect(findUnmanagedPortBinds(stack("node x --version 999 --build 100000"), 20000, 32)).toEqual(
      [],
    );
  });

  it("does not flag shared services (they live in another instance)", () => {
    const s: ResolvedStack = {
      services: [service("pg", "postgres -p 5432", [], "shared")],
    };
    expect(findUnmanagedPortBinds(s, 20000, 32)).toEqual([]);
  });
});
