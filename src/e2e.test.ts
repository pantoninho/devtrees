import { afterEach, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { deriveWorktreeId } from "./anchor.js";
import { runAttach, runDown, runLs, runPrune, runUp } from "./commands.js";

// Unix domain socket paths are capped (~104 bytes on macOS, ~108 on Linux). The
// control socket lives at `<git-common-dir>/devtrees/run/<id>.sock`, so the temp
// repo must be rooted shallowly enough that the socket path fits. The OS tmpdir
// (e.g. macOS `/var/folders/.../T`) is already deep enough to overflow, so we use
// a short, fixed base dir instead.
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

const STUB = fileURLToPath(new URL("../test/stub-process-compose.mjs", import.meta.url));

/**
 * `afterEach` must run cleanups to completion before vitest reports the test
 * done — otherwise fire-and-forget `runDown` races against the `rmSync` of
 * the worktree tmp dir, the process-compose stub is never signalled, and its
 * detached children leak into the host port table (#41). Cleanups may be
 * sync or async; we run them in LIFO order so a worktree's `runDown` happens
 * before the tmp dir housing its socket is unlinked.
 */
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    if (!fn) continue;
    try {
      await fn();
    } catch {
      // Cleanups are best-effort; one failure must not block the next.
    }
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Build a fresh temp repo with `main/` initialised and committed, plus N linked
 * worktrees. Returns `{ root, main, worktrees }`. The caller is responsible for
 * registering an rm cleanup against `root`.
 */
function makeRepo(
  prefix: string,
  worktreeNames: ReadonlyArray<string>,
): { root: string; main: string; worktrees: Record<string, string> } {
  const root = mkdtempSync(join(SHORT_TMP, prefix));
  const main = join(root, "main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q");
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "README.md"), "x");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const worktrees: Record<string, string> = {};
  for (const name of worktreeNames) {
    const path = join(root, name);
    git(main, "worktree", "add", "-q", path, "-b", name);
    worktrees[name] = path;
  }
  return { root, main, worktrees };
}

/** The driver config that runs the stub instead of a real process-compose. */
function stubDriverDeps(worktree: string): {
  cwd: string;
  driver: { binary: string; prefixArgs: string[] };
  attach: false;
  waitForHealth: () => Promise<void>;
  getServiceStatuses: () => Promise<never[]>;
} {
  return {
    cwd: worktree,
    driver: { binary: process.execPath, prefixArgs: [STUB] },
    attach: false,
    // The stub doesn't implement `process-compose process list`, so the real
    // poll loop would hang. The wait-for-healthy contract itself is unit-
    // tested in commands.test.ts (#28); e2e here only proves the up/down
    // wiring against the stub binary.
    waitForHealth: () => Promise.resolve(),
    // The issue-#30 `up --json` envelope publishes per-service rows via the
    // driver's `getServiceStatuses` (same hook `ls --json` uses, issue #29).
    // Default it to an empty snapshot for up/down-focused e2e tests so this
    // call doesn't race the stub's async socket setup; the real shape is
    // exercised in commands.test.ts and through `runLs` in the #29 e2e.
    getServiceStatuses: () => Promise.resolve([]),
  };
}

async function waitForHttp(port: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitForGone(port: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      return true; // connection refused -> gone
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** A worktree whose single isolated service binds ${WEB_PORT} and writes a relative file. */
function writeStackConfig(worktreeRoot: string): void {
  // Inline Node HTTP server: reads its port verbatim from the environment, and
  // touches a relative file to exercise working-directory isolation.
  const server = [
    "import { createServer } from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('served.txt', 'hi');",
    "createServer((_, res) => res.end('ok')).listen(Number(process.env.WEB_PORT), '127.0.0.1');",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "server.mjs"), server);
  writeFileSync(
    join(worktreeRoot, "devtrees.yaml"),
    [
      "services:",
      "  web:",
      "    tier: isolated",
      '    command: "node server.mjs"',
      "    ports: [WEB_PORT]",
      "",
    ].join("\n"),
  );
}

describe("e2e smoke — up then down a single isolated service", () => {
  it("up starts the service on its injected port; down stops it cleanly", async () => {
    const repo = makeRepo("dt-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");
    writeStackConfig(worktree);

    const deps = stubDriverDeps(worktree);

    const up = await runUp(deps as never);
    cleanups.push(() => runDown(deps as never));

    // Acceptance: the worktree id is resolved from the directory, not the
    // branch — slug prefix of the basename plus a path-hash suffix (#82).
    expect(up.worktreeId).toMatch(/^login-[0-9a-f]{8}$/);

    const port = Number(up.env.WEB_PORT);
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThanOrEqual(65535);

    // Acceptance: the named port is reachable.
    expect(await waitForHttp(port)).toBe(true);

    // Acceptance: working-directory isolation — the relative file is worktree-local.
    expect(existsSync(join(worktree, "served.txt"))).toBe(true);

    // Acceptance: runtime state lives under <git-common-dir>/devtrees/.
    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    expect(existsSync(join(absCommon, "devtrees", `${up.worktreeId}.yaml`))).toBe(true);

    // Acceptance: down stops the worktree instance cleanly.
    await runDown(deps as never);
    expect(await waitForGone(port)).toBe(true);
  }, 20000);
});

/**
 * Extend-mode equivalent: the project owns a hand-authored `process-compose.yaml`,
 * and `devtrees.yaml` extends it with only tier + named-port metadata. devtrees
 * must read the base, never edit it, and emit a tier-free derived config.
 */
function writeExtendConfig(worktreeRoot: string): void {
  const server = [
    "import { createServer } from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('served.txt', 'hi');",
    "createServer((_, res) => res.end('ok')).listen(Number(process.env.WEB_PORT), '127.0.0.1');",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "server.mjs"), server);
  writeFileSync(
    join(worktreeRoot, "process-compose.yaml"),
    ["processes:", "  web:", '    command: "node server.mjs"', ""].join("\n"),
  );
  writeFileSync(
    join(worktreeRoot, "devtrees.yaml"),
    [
      "extends: ./process-compose.yaml",
      "services:",
      "  web:",
      "    tier: isolated",
      "    ports: [WEB_PORT]",
      "",
    ].join("\n"),
  );
}

/**
 * Two worktrees sharing one shared service, exercised end-to-end against the
 * stub `process-compose`. Asserts the full ADR-0001 lifecycle:
 *
 *  - one worktree `up` lazy-starts the shared instance
 *  - a second worktree `up` reuses it (single shared socket, identical DB_PORT)
 *  - per-worktree `down` leaves shared running for the other
 *  - `down --shared` tears shared down explicitly
 */
function writeMixedTierStack(worktreeRoot: string): void {
  // Two services: an HTTP server bound to ${WEB_PORT} (isolated per worktree)
  // and a TCP echo bound to ${DB_PORT} that stands in for a shared DB. The
  // isolated service runs a relative .mjs (worktree-local working_dir); the
  // shared one runs an inline `node -e` because it executes from the anchor
  // (the git common dir), not the worktree.
  const server = [
    "import { createServer } from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('served.txt', `wt=${process.env.DEVTREES_WORKTREE_ID}`);",
    "createServer((_, res) => res.end(`db=${process.env.DB_PORT}`))",
    "  .listen(Number(process.env.WEB_PORT), '127.0.0.1');",
  ].join("\n");
  // Inline single-line program; embedded in YAML as a JSON-quoted string so
  // semicolons survive. `${DB_PORT}` is referenced verbatim — devtrees does
  // not rewrite commands; process-compose expands it from the injected env.
  // The on-connect handler swallows socket errors (an unhandled 'error' would
  // crash the process — RST from a connect-then-close probe would otherwise
  // kill the shared listener after the first ping).
  const dbInline =
    "import('node:net').then(({createServer})=>createServer((s)=>{s.on('error',()=>{});s.end('OK');})" +
    ".listen(Number(process.env.DB_PORT),'127.0.0.1'));";
  writeFileSync(join(worktreeRoot, "server.mjs"), server);
  writeFileSync(
    join(worktreeRoot, "devtrees.yaml"),
    [
      "services:",
      "  web:",
      "    tier: isolated",
      '    command: "node server.mjs"',
      "    ports: [WEB_PORT]",
      "  pgstub:",
      "    tier: shared",
      `    command: ${JSON.stringify(`node -e ${JSON.stringify(dbInline)}`)}`,
      "    ports: [DB_PORT]",
      "",
    ].join("\n"),
  );
}

async function waitForTcp(port: number, timeoutMs = 4000): Promise<boolean> {
  const { connect } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("e2e — shared instance lifecycle across two worktrees", () => {
  it("lazy-starts shared on first up, reuses it on second, survives per-worktree down, dies on down --shared", async () => {
    const repo = makeRepo("dt-sh-", ["login", "billing"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));

    const loginWt = repo.worktrees.login;
    const billingWt = repo.worktrees.billing;
    if (loginWt === undefined || billingWt === undefined) {
      throw new Error("expected login and billing worktrees");
    }
    writeMixedTierStack(loginWt);
    writeMixedTierStack(billingWt);

    const loginDeps = stubDriverDeps(loginWt);
    const billingDeps = stubDriverDeps(billingWt);

    // Acceptance: first up lazy-starts the shared instance.
    const login = await runUp(loginDeps as never);
    // Register shared tear-down here too: if the test times out before the
    // second worktree's cleanup gets pushed, this still reaps the shared
    // stub (otherwise its long-lived parent leaks past the suite).
    cleanups.push(async () => {
      await runDown(loginDeps as never).catch(() => {});
      await runDown(loginDeps as never, { shared: true }).catch(() => {});
    });
    expect(login.sharedStarted).toBe(true);
    expect(await waitForHttp(Number(login.env.WEB_PORT))).toBe(true);
    expect(await waitForTcp(Number(login.env.DB_PORT))).toBe(true);

    // The shared socket lives at <anchor>/devtrees/run/shared.sock.
    const commonDir = git(loginWt, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(loginWt, commonDir);
    const sharedSocket = join(absCommon, "devtrees", "run", "shared.sock");
    expect(existsSync(sharedSocket)).toBe(true);

    // Acceptance: a second worktree up reuses the running shared instance.
    const billing = await runUp(billingDeps as never);
    // Include the shared tear-down in cleanup so a timeout before the test
    // body reaches `runDown(..., {shared:true})` still reaps the shared stub
    // (otherwise its parent process leaks past the suite).
    cleanups.push(async () => {
      await runDown(billingDeps as never).catch(() => {});
      await runDown(billingDeps as never, { shared: true }).catch(() => {});
    });
    expect(billing.sharedStarted).toBe(false);
    // Shared DB_PORT is identical in both worktrees (repo-wide injection).
    expect(billing.env.DB_PORT).toBe(login.env.DB_PORT);
    // Isolated WEB_PORTs differ.
    expect(billing.env.WEB_PORT).not.toBe(login.env.WEB_PORT);
    expect(await waitForHttp(Number(billing.env.WEB_PORT))).toBe(true);

    // The isolated service reached the shared one via the injected value.
    const httpRes = await fetch(`http://127.0.0.1:${Number(billing.env.WEB_PORT)}/`);
    expect(await httpRes.text()).toContain(billing.env.DB_PORT);

    // Acceptance: plain down in one worktree leaves shared up for the other.
    await runDown(loginDeps as never);
    expect(await waitForGone(Number(login.env.WEB_PORT))).toBe(true);
    expect(existsSync(sharedSocket)).toBe(true);
    expect(await waitForTcp(Number(billing.env.DB_PORT))).toBe(true);

    // Acceptance: down --shared tears shared down explicitly.
    await runDown(billingDeps as never);
    await runDown(billingDeps as never, { shared: true });
    expect(await waitForGone(Number(billing.env.DB_PORT))).toBe(true);
    expect(existsSync(sharedSocket)).toBe(false);
  }, 30000);

  /**
   * Issue #51 — `down --shared` preserves the `__shared__` registry entry so a
   * subsequent `up` reuses the same shared block. The end-to-end signal is
   * stable `DB_PORT` across the teardown cycle, plus `ls --json` correctly
   * reporting shared as gone (post-down) and running (post-second-up).
   */
  it("preserves the shared block across down --shared + up (#51)", async () => {
    const repo = makeRepo("dt-sh-stab-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));

    const loginWt = repo.worktrees.login;
    if (loginWt === undefined) throw new Error("expected login worktree");
    writeMixedTierStack(loginWt);

    const deps = stubDriverDeps(loginWt);
    const commonDir = git(loginWt, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(loginWt, commonDir);
    const sharedSocket = join(absCommon, "devtrees", "run", "shared.sock");

    const first = await runUp(deps as never);
    cleanups.push(async () => {
      await runDown(deps as never).catch(() => {});
      await runDown(deps as never, { shared: true }).catch(() => {});
    });
    expect(first.sharedStarted).toBe(true);
    expect(await waitForTcp(Number(first.env.DB_PORT))).toBe(true);

    // ls --json sees the shared instance as running, on the first DB_PORT.
    const lsBefore = await runLs({ cwd: loginWt, driver: deps.driver });
    const sharedBefore = lsBefore.instances.find((i) => i.id === "shared");
    expect(sharedBefore?.status).toBe("running");
    expect(sharedBefore?.ports.DB_PORT).toBe(Number(first.env.DB_PORT));

    // Tear the worktree down first so the second `up` re-runs the full
    // lazy-start path (the idempotency branch short-circuits otherwise).
    await runDown(deps as never);
    await runDown(deps as never, { shared: true });
    expect(await waitForGone(Number(first.env.DB_PORT))).toBe(true);
    expect(existsSync(sharedSocket)).toBe(false);

    // ls --json no longer reports the shared instance (socket-driven liveness).
    const lsAfterDown = await runLs({ cwd: loginWt, driver: deps.driver });
    expect(lsAfterDown.instances.find((i) => i.id === "shared")).toBeUndefined();

    // The next up reuses the same shared block — DB_PORT is identical.
    const second = await runUp(deps as never);
    expect(second.sharedStarted).toBe(true);
    expect(second.env.DB_PORT).toBe(first.env.DB_PORT);
    expect(await waitForTcp(Number(second.env.DB_PORT))).toBe(true);

    // ls --json shows shared back up on the original DB_PORT.
    const lsAfterUp = await runLs({ cwd: loginWt, driver: deps.driver });
    const sharedAfter = lsAfterUp.instances.find((i) => i.id === "shared");
    expect(sharedAfter?.status).toBe("running");
    expect(sharedAfter?.ports.DB_PORT).toBe(Number(first.env.DB_PORT));
  }, 30000);

  /**
   * Issue #56 — `up` from a worktree whose isolated stack is still running
   * must lazy-restart shared when a prior `down --shared` killed it. Without
   * the fix, the idempotency branch in `runUp` short-circuits before the
   * shared liveness check and returns `shared_started: false` while shared
   * stays dead — leaving the agent with no `up`-driven recovery path.
   */
  it("up → down --shared → up lazy-restarts shared even though the worktree is still running (#56)", async () => {
    const repo = makeRepo("dt-sh-recover-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));

    const loginWt = repo.worktrees.login;
    if (loginWt === undefined) throw new Error("expected login worktree");
    writeMixedTierStack(loginWt);

    const deps = stubDriverDeps(loginWt);
    const commonDir = git(loginWt, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(loginWt, commonDir);
    const sharedSocket = join(absCommon, "devtrees", "run", "shared.sock");

    const first = await runUp(deps as never);
    cleanups.push(async () => {
      await runDown(deps as never).catch(() => {});
      await runDown(deps as never, { shared: true }).catch(() => {});
    });
    expect(first.sharedStarted).toBe(true);
    expect(await waitForTcp(Number(first.env.DB_PORT))).toBe(true);
    expect(existsSync(sharedSocket)).toBe(true);

    // Only `down --shared` — the worktree itself stays up so the next `up`
    // hits the idempotency branch.
    await runDown(deps as never, { shared: true });
    expect(await waitForGone(Number(first.env.DB_PORT))).toBe(true);
    expect(existsSync(sharedSocket)).toBe(false);

    // The worktree's HTTP server is still listening (its instance wasn't
    // touched). Confirms we really are hitting the idempotency path.
    expect(await waitForHttp(Number(first.env.WEB_PORT))).toBe(true);

    // Re-`up` from the same (still-running) worktree must lazy-restart
    // shared, and the envelope must report it (acceptance, #56).
    const second = await runUp(deps as never);
    expect(second.sharedStarted).toBe(true);
    expect(existsSync(sharedSocket)).toBe(true);
    expect(await waitForTcp(Number(second.env.DB_PORT))).toBe(true);
    // Shared block survived (registry entry preserved, #51).
    expect(second.env.DB_PORT).toBe(first.env.DB_PORT);
    // Worktree env round-trips identically (idempotent branch envelope).
    expect(second.env.WEB_PORT).toBe(first.env.WEB_PORT);
  }, 30000);
});

/**
 * `devtrees ls` end-to-end: two worktrees with one shared service between
 * them. After bringing both up, enumeration must report all three instances —
 * the two worktrees plus the shared one — purely by walking control sockets
 * under the anchor's run dir. No central daemon, no PID tracking (#8).
 */
describe("e2e — devtrees ls discovers worktree instances + the shared instance", () => {
  it("lists both worktrees and the shared instance with their allocated ports", async () => {
    const repo = makeRepo("dt-ls-", ["login", "billing"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));

    const loginWt = repo.worktrees.login;
    const billingWt = repo.worktrees.billing;
    if (loginWt === undefined || billingWt === undefined) {
      throw new Error("expected login and billing worktrees");
    }
    writeMixedTierStack(loginWt);
    writeMixedTierStack(billingWt);

    const loginDeps = stubDriverDeps(loginWt);
    const billingDeps = stubDriverDeps(billingWt);

    const login = await runUp(loginDeps as never);
    // Register shared tear-down here too: if the test times out before the
    // second worktree's cleanup gets pushed, this still reaps the shared
    // stub (otherwise its long-lived parent leaks past the suite).
    cleanups.push(async () => {
      await runDown(loginDeps as never).catch(() => {});
      await runDown(loginDeps as never, { shared: true }).catch(() => {});
    });
    const billing = await runUp(billingDeps as never);
    cleanups.push(async () => {
      await runDown(billingDeps as never).catch(() => {});
      await runDown(billingDeps as never, { shared: true }).catch(() => {});
    });

    // The stub `process-compose` creates its control socket from a detached
    // child, so a freshly-returned `runUp` may have written the derived YAML
    // before the socket exists on disk. Wait until both worktree services are
    // reachable on their ports — that's our liveness gate before enumeration.
    expect(await waitForHttp(Number(login.env.WEB_PORT))).toBe(true);
    expect(await waitForHttp(Number(billing.env.WEB_PORT))).toBe(true);
    expect(await waitForTcp(Number(login.env.DB_PORT))).toBe(true);

    // Discovery is anchored at the shared git common dir — call from either
    // worktree and the answer is the same. The driver dep points at the stub
    // so `getServiceStatuses` (issue #29) reaches the stub's `process list`
    // rather than the real process-compose binary against a stub UDS.
    const lsFromLogin = await runLs({ cwd: loginWt, driver: loginDeps.driver });
    const ids = lsFromLogin.instances.map((i) => i.id).sort();
    expect(ids).toEqual([billing.worktreeId, login.worktreeId, "shared"].sort());

    // Acceptance: every entry shows status + allocated ports.
    for (const inst of lsFromLogin.instances) {
      expect(inst.status).toBe("running");
    }
    const loginEntry = lsFromLogin.instances.find((i) => i.id === login.worktreeId);
    const billingEntry = lsFromLogin.instances.find((i) => i.id === billing.worktreeId);
    const sharedEntry = lsFromLogin.instances.find((i) => i.id === "shared");
    expect(loginEntry?.kind).toBe("worktree");
    expect(billingEntry?.kind).toBe("worktree");
    expect(sharedEntry?.kind).toBe("shared");

    // The worktree instances expose the same WEB_PORT names but with the
    // numbers that were injected at up-time.
    expect(loginEntry?.ports.WEB_PORT).toBe(Number(login.env.WEB_PORT));
    expect(billingEntry?.ports.WEB_PORT).toBe(Number(billing.env.WEB_PORT));
    // The shared instance carries the repo-wide DB_PORT, identical to what
    // both worktrees got injected.
    expect(sharedEntry?.ports.DB_PORT).toBe(Number(login.env.DB_PORT));

    // Acceptance: ls from the other worktree returns the same set.
    const lsFromBilling = await runLs({ cwd: billingWt, driver: billingDeps.driver });
    expect(lsFromBilling.instances.map((i) => i.id).sort()).toEqual(ids);
  }, 30000);

  /**
   * Issue #29 — agent-facing `ls` populates `services[]` on each running
   * instance via one `getServiceStatuses` shell-out per instance. Runs the
   * driver against the stub process-compose, which serves a deterministic
   * `process list -o json` snapshot recovered from the derived config it
   * was started with.
   */
  it("populates services[] (name/status/health/ports) on each running instance", async () => {
    const repo = makeRepo("dt-svc-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const loginWt = repo.worktrees.login;
    if (loginWt === undefined) throw new Error("expected login worktree");
    writeMixedTierStack(loginWt);

    const deps = stubDriverDeps(loginWt);
    const up = await runUp(deps as never);
    cleanups.push(() => {
      void runDown(deps as never).catch(() => {});
      void runDown(deps as never, { shared: true }).catch(() => {});
    });
    expect(await waitForHttp(Number(up.env.WEB_PORT))).toBe(true);

    // `getServiceStatuses` is per-driver; ls must use the same stub-pointing
    // driver deps the up/down path used so the call reaches the stub
    // (otherwise it'd shell out to a non-existent real `process-compose`).
    const ls = await runLs({ cwd: loginWt, driver: deps.driver });

    const login = ls.instances.find((i) => i.id === up.worktreeId);
    const shared = ls.instances.find((i) => i.id === "shared");
    expect(login?.services?.map((s) => s.name)).toEqual(["web"]);
    expect(login?.services?.[0]?.status).toBe("Running");
    expect(login?.services?.[0]?.health).toBe("ready");
    // Web sees its own WEB_PORT plus the shared DB_PORT (cross-tier
    // connection-info injection). The worktree-id env var lives alongside
    // these but is filtered out — only `KEY=NUMBER` entries qualify as ports.
    expect(login?.services?.[0]?.ports).toEqual({
      WEB_PORT: Number(up.env.WEB_PORT),
      DB_PORT: Number(up.env.DB_PORT),
    });

    expect(shared?.services?.map((s) => s.name)).toEqual(["pgstub"]);
    expect(shared?.services?.[0]?.status).toBe("Running");
    expect(shared?.services?.[0]?.health).toBe("ready");
    expect(shared?.services?.[0]?.ports).toEqual({
      DB_PORT: Number(up.env.DB_PORT),
    });
  }, 30000);
});

/**
 * Issue #50 — devtrees passes process-compose's `readiness_probe`,
 * `liveness_probe`, and `availability` blocks through verbatim. The fixture
 * here authors a probe whose inner shape includes a field devtrees doesn't
 * model (`future_field`) so the test also covers the "no normalization"
 * acceptance bullet.
 */
function writeProbeStack(worktreeRoot: string): void {
  const server = [
    "import { createServer } from 'node:http';",
    "createServer((_, res) => res.end('ok')).listen(Number(process.env.WEB_PORT), '127.0.0.1');",
  ].join("\n");
  writeFileSync(join(worktreeRoot, "server.mjs"), server);
  writeFileSync(
    join(worktreeRoot, "devtrees.yaml"),
    [
      "services:",
      "  web:",
      "    tier: isolated",
      '    command: "node server.mjs"',
      "    ports: [WEB_PORT]",
      "    readiness_probe:",
      "      exec:",
      '        command: "echo ok"',
      "      initial_delay_seconds: 1",
      "      period_seconds: 2",
      "      future_field:",
      "        nested: true",
      "    liveness_probe:",
      "      exec:",
      '        command: "echo alive"',
      "      failure_threshold: 3",
      "    availability:",
      "      restart: on_failure",
      "      backoff_seconds: 5",
      "",
    ].join("\n"),
  );
}

describe("e2e — readiness_probe / liveness_probe / availability passthrough (#50)", () => {
  it("writes the three blocks verbatim into the derived YAML and surfaces health: ready", async () => {
    const repo = makeRepo("dt-probe-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");
    writeProbeStack(worktree);

    const deps = stubDriverDeps(worktree);
    const up = await runUp(deps as never);
    cleanups.push(() => runDown(deps as never));

    expect(await waitForHttp(Number(up.env.WEB_PORT))).toBe(true);

    // Acceptance: the derived YAML on disk carries the three blocks unchanged,
    // including the `future_field` devtrees doesn't model.
    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    const configPath = join(absCommon, "devtrees", `${up.worktreeId}.yaml`);
    const derived = parseYaml(readFileSync(configPath, "utf8")) as {
      processes: Record<string, Record<string, unknown>>;
    };
    expect(derived.processes.web?.readiness_probe).toEqual({
      exec: { command: "echo ok" },
      initial_delay_seconds: 1,
      period_seconds: 2,
      future_field: { nested: true },
    });
    expect(derived.processes.web?.liveness_probe).toEqual({
      exec: { command: "echo alive" },
      failure_threshold: 3,
    });
    expect(derived.processes.web?.availability).toEqual({
      restart: "on_failure",
      backoff_seconds: 5,
    });

    // Acceptance: with the probe present, `getServiceStatuses` reports the
    // service as ready. (Against the real process-compose this is the
    // converged-probe assertion. Against the stub it's a smoke check that
    // the driver→stub path returns `is_ready: "Ready"`.)
    const ls = await runLs({ cwd: worktree, driver: deps.driver });
    const login = ls.instances.find((i) => i.id === up.worktreeId);
    expect(login?.services?.[0]?.name).toBe("web");
    expect(login?.services?.[0]?.health).toBe("ready");

    await runDown(deps as never);
    expect(await waitForGone(Number(up.env.WEB_PORT))).toBe(true);
  }, 20000);
});

describe("e2e — cross-tier wiring: isolated waits for shared health (ADR-0003)", () => {
  it("an isolated service that depends_on a shared service does not start until shared is healthy", async () => {
    // Isolated `web` depends_on shared `pgstub`. The shared service stalls 500ms
    // before listening on DB_PORT (a stand-in for an actual readiness gate).
    // The worktree `web` records a timestamp at startup; if the cross-tier wait
    // is honoured, that timestamp lands *after* the shared listener is up.
    const repo = makeRepo("dt-xt-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");

    const webMjs = [
      "import { writeFileSync } from 'node:fs';",
      "import { createServer } from 'node:http';",
      "writeFileSync('web-start.txt', String(Date.now()));",
      "createServer((_, res) => res.end('ok')).listen(Number(process.env.WEB_PORT), '127.0.0.1');",
    ].join("\n");
    writeFileSync(join(worktree, "web.mjs"), webMjs);

    // Shared `pgstub`: delay 500ms, then start TCP listener and touch a marker file.
    const dbInline =
      "setTimeout(()=>{" +
      "import('node:fs').then(({writeFileSync})=>writeFileSync(process.env.DB_READY_FILE,String(Date.now())));" +
      "import('node:net').then(({createServer})=>createServer((s)=>{s.on('error',()=>{});s.end('OK');})" +
      ".listen(Number(process.env.DB_PORT),'127.0.0.1'));" +
      "},500);";

    // The shared service writes its readiness timestamp into a file under the
    // anchor so the test can read it deterministically (no process-compose
    // probe is hit in this e2e — the test stubs waitForSharedHealth to poll
    // the same flag file).
    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    const readyFile = join(absCommon, "db-ready.txt");

    writeFileSync(
      join(worktree, "devtrees.yaml"),
      [
        "services:",
        "  web:",
        "    tier: isolated",
        '    command: "node web.mjs"',
        "    ports: [WEB_PORT]",
        "    depends_on: [pgstub]",
        "  pgstub:",
        "    tier: shared",
        `    command: ${JSON.stringify(`node -e ${JSON.stringify(dbInline)}`)}`,
        "    ports: [DB_PORT]",
        `    environment: [${JSON.stringify(`DB_READY_FILE=${readyFile}`)}]`,
        "",
      ].join("\n"),
    );

    // Custom waitForSharedHealth: poll for the ready file. Mirrors what the
    // real default does over process-compose's `process list` — exposes the
    // same async hook in the test.
    const waitForSharedHealth = async (): Promise<void> => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (existsSync(readyFile)) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("shared readiness file never appeared");
    };

    const deps = {
      ...stubDriverDeps(worktree),
      waitForSharedHealth,
    };

    const up = await runUp(deps as never);
    cleanups.push(async () => {
      await runDown(deps as never).catch(() => {});
      await runDown(deps as never, { shared: true }).catch(() => {});
    });

    // Acceptance: web is up and reaches the shared DB port via the injection.
    expect(await waitForHttp(Number(up.env.WEB_PORT))).toBe(true);
    expect(await waitForTcp(Number(up.env.DB_PORT))).toBe(true);

    // Acceptance: the cross-tier `depends_on` was dropped — derived worktree
    // config carries no reference to the shared service, so process-compose
    // never sees an unknown-process error.
    const derivedPath = join(absCommon, "devtrees", `${up.worktreeId}.yaml`);
    const derived = parseYaml(readFileSync(derivedPath, "utf8")) as {
      processes: Record<string, { depends_on?: Record<string, unknown> }>;
    };
    expect(derived.processes.web?.depends_on).toBeUndefined();

    // Acceptance: the same-tier check — web has no isolated depends_on, but the
    // depends_on key is omitted entirely (not an empty map).
    expect("depends_on" in (derived.processes.web ?? {})).toBe(false);

    // Acceptance: ordering — the web process started *after* the shared service's
    // ready marker landed. Both write Date.now() at start; web's must be later.
    const webStart = Number(readFileSync(join(worktree, "web-start.txt"), "utf8"));
    const dbReady = Number(readFileSync(readyFile, "utf8"));
    expect(webStart).toBeGreaterThanOrEqual(dbReady);
  }, 30000);
});

describe("e2e — shared→isolated depends_on is rejected at load time (ADR-0003)", () => {
  it("a shared service that depends_on an isolated service raises a clear config error", async () => {
    const repo = makeRepo("dt-rej-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");

    writeFileSync(
      join(worktree, "devtrees.yaml"),
      [
        "services:",
        "  postgres:",
        "    tier: shared",
        '    command: "postgres"',
        "    depends_on: [web]",
        "  web:",
        "    tier: isolated",
        '    command: "node server.js"',
        "",
      ].join("\n"),
    );

    const deps = stubDriverDeps(worktree);
    await expect(runUp(deps as never)).rejects.toThrow(/shared.*depends_on.*isolated/i);
  });
});

/**
 * `devtrees prune` end-to-end (#9): bring two worktrees up, remove one with
 * `git worktree remove --force` mid-run, then reconcile against
 * `git worktree list`. The orphan's instance must be stopped and its anchor
 * state (control socket, derived config, registry entry) cleared; the
 * surviving worktree's instance must be untouched.
 */
describe("e2e — devtrees prune reconciles against git worktree list", () => {
  it("stops the orphan, cleans its anchor state, leaves the surviving instance alone", async () => {
    const repo = makeRepo("dt-prune-", ["login", "billing"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));

    const loginWt = repo.worktrees.login;
    const billingWt = repo.worktrees.billing;
    if (loginWt === undefined || billingWt === undefined) {
      throw new Error("expected login and billing worktrees");
    }
    writeStackConfig(loginWt);
    writeStackConfig(billingWt);

    const loginDeps = stubDriverDeps(loginWt);
    const billingDeps = stubDriverDeps(billingWt);

    const login = await runUp(loginDeps as never);
    const billing = await runUp(billingDeps as never);
    cleanups.push(() => runDown(billingDeps as never));

    expect(await waitForHttp(Number(login.env.WEB_PORT))).toBe(true);
    expect(await waitForHttp(Number(billing.env.WEB_PORT))).toBe(true);

    // Pre-state: both instances visible at the anchor.
    const commonDir = git(billingWt, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(billingWt, commonDir);
    const loginSocket = join(absCommon, "devtrees", "run", `${login.worktreeId}.sock`);
    const loginConfig = join(absCommon, "devtrees", `${login.worktreeId}.yaml`);
    expect(existsSync(loginSocket)).toBe(true);
    expect(existsSync(loginConfig)).toBe(true);

    // Remove the login worktree with git, while its stack is still running —
    // exactly the situation CONTEXT.md's example dialogue describes.
    git(billingWt, "worktree", "remove", "--force", loginWt);

    // Prune from the surviving worktree (cwd doesn't have to be the orphan —
    // discovery is anchor-wide).
    const result = await runPrune({
      cwd: billingWt,
      driver: { binary: process.execPath, prefixArgs: [STUB] },
    });

    // Acceptance: prune reports the orphan, the surviving instance is left alone.
    expect(result.pruned.map((p) => p.id).sort()).toEqual([login.worktreeId]);

    // Acceptance: the orphan's anchor state is gone.
    expect(existsSync(loginSocket)).toBe(false);
    expect(existsSync(loginConfig)).toBe(false);

    // Acceptance: the surviving instance is still up.
    expect(await waitForHttp(Number(billing.env.WEB_PORT))).toBe(true);
    const billingSocket = join(absCommon, "devtrees", "run", `${billing.worktreeId}.sock`);
    expect(existsSync(billingSocket)).toBe(true);

    // Acceptance: a follow-up prune is a no-op (idempotent).
    const second = await runPrune({
      cwd: billingWt,
      driver: { binary: process.execPath, prefixArgs: [STUB] },
    });
    expect(second.pruned).toEqual([]);
  }, 30000);
});

describe("e2e smoke — extend an existing process-compose.yaml", () => {
  it("up runs the base-defined service; the base file is unmodified; derived config is tier-free", async () => {
    const repo = makeRepo("dt-ext-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");
    writeExtendConfig(worktree);

    const basePath = join(worktree, "process-compose.yaml");
    const baseTextBefore = readFileSync(basePath, "utf8");
    const baseMtimeBefore = statSync(basePath).mtimeMs;

    const deps = stubDriverDeps(worktree);

    const up = await runUp(deps as never);
    cleanups.push(() => runDown(deps as never));

    const port = Number(up.env.WEB_PORT);
    expect(await waitForHttp(port)).toBe(true);

    // Acceptance: the base file is read but never modified.
    expect(readFileSync(basePath, "utf8")).toBe(baseTextBefore);
    expect(statSync(basePath).mtimeMs).toBe(baseMtimeBefore);

    // Acceptance: derived config contains no `tier` keys (strict-safe).
    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    const derivedPath = join(absCommon, "devtrees", `${up.worktreeId}.yaml`);
    const derivedText = readFileSync(derivedPath, "utf8");
    expect(derivedText).not.toMatch(/^\s*tier:/m);
    const derived = parseYaml(derivedText) as {
      processes: Record<string, Record<string, unknown>>;
    };
    for (const proc of Object.values(derived.processes)) {
      expect("tier" in proc).toBe(false);
    }

    await runDown(deps as never);
    expect(await waitForGone(port)).toBe(true);
  }, 20000);
});

describe("e2e — attach to a running worktree instance", () => {
  it("up then attach reaches process-compose with the worktree's control socket; attach fails clearly when nothing is running", async () => {
    const repo = makeRepo("dt-att-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");
    writeStackConfig(worktree);

    const deps = stubDriverDeps(worktree);

    // Acceptance: attaching with nothing running is a clear, non-zero error.
    await expect(runAttach(deps as never)).rejects.toThrow(/no worktree instance is running/);

    const up = await runUp(deps as never);
    cleanups.push(() => runDown(deps as never));
    expect(await waitForHttp(Number(up.env.WEB_PORT))).toBe(true);

    // Acceptance: attach reaches `process-compose attach` against the
    // running instance's UDS. The stub records evidence as a sibling
    // `<socket>.attached` marker.
    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    const sock = join(absCommon, "devtrees", "run", `${up.worktreeId}.sock`);
    expect(existsSync(sock)).toBe(true);

    await runAttach(deps as never);
    expect(existsSync(`${sock}.attached`)).toBe(true);

    await runDown(deps as never);
    expect(await waitForGone(Number(up.env.WEB_PORT))).toBe(true);
  }, 20000);
});

/**
 * Process-survival helpers for the teardown-leak invariant test.
 *
 * Each `runUp` against the stub creates two cohorts the suite must reap:
 *   - the stub parent itself (sticks around because the real binary daemonises;
 *     identified by `-u <socket>` in its argv, which is unique per test)
 *   - the services it spawned (recorded by the stub in `<socket>.pids`)
 *
 * The fixture leak (#41) was: nothing killed the stub parent, and its detached
 * children survived `runDown` because `down` only addressed the recorded pids.
 */
function pgrepFull(pattern: string): number[] {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => Number(s));
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForReaped(pids: ReadonlyArray<number>, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let survivors = pids.filter(pidAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    survivors = pids.filter(pidAlive);
  }
  return survivors;
}

describe("e2e — teardown-leak invariant: stub parents and children are reaped on runDown", () => {
  it("after a runUp+runDown cycle, every stub-spawned process is gone", async () => {
    const repo = makeRepo("dt-leak-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");
    writeStackConfig(worktree);
    const deps = stubDriverDeps(worktree);

    const up = await runUp(deps as never);
    expect(await waitForHttp(Number(up.env.WEB_PORT))).toBe(true);

    // Snapshot every process this test spawned. The socket path uniquely
    // identifies the stub parent (its argv carries -u <socket>); the stub
    // records the service pids alongside the socket.
    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    const sock = join(absCommon, "devtrees", "run", `${up.worktreeId}.sock`);
    const recordedChildPids = JSON.parse(readFileSync(`${sock}.pids`, "utf8")) as number[];
    const stubParents = pgrepFull(sock);
    const ourPids = Array.from(new Set([...stubParents, ...recordedChildPids]));
    expect(ourPids.length).toBeGreaterThan(0);
    expect(stubParents.length).toBeGreaterThan(0);

    await runDown(deps as never);

    const survivors = await waitForReaped(ourPids, 4000);
    expect(survivors).toEqual([]);
  }, 15000);
});

describe("e2e — attach to the shared instance", () => {
  it("up (with a shared service) then attach --shared reaches the shared socket; attach --shared fails clearly without a running shared instance", async () => {
    const repo = makeRepo("dt-att-sh-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");
    writeMixedTierStack(worktree);

    const deps = stubDriverDeps(worktree);

    // Acceptance: attaching --shared with nothing running is a clear error.
    await expect(runAttach(deps as never, { shared: true })).rejects.toThrow(
      /no shared instance is running/,
    );

    const up = await runUp(deps as never);
    cleanups.push(async () => {
      await runDown(deps as never).catch(() => {});
      await runDown(deps as never, { shared: true }).catch(() => {});
    });
    expect(up.sharedStarted).toBe(true);
    expect(await waitForTcp(Number(up.env.DB_PORT))).toBe(true);

    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    const sharedSock = join(absCommon, "devtrees", "run", "shared.sock");
    expect(existsSync(sharedSock)).toBe(true);

    await runAttach(deps as never, { shared: true });
    expect(existsSync(`${sharedSock}.attached`)).toBe(true);

    await runDown(deps as never);
    await runDown(deps as never, { shared: true });
    expect(existsSync(sharedSock)).toBe(false);
  }, 30000);
});

/**
 * Stale-port-block detection (#58). When a foreign process is squatting on one
 * of the worktree's allocated named ports at start time, `runUp` must abort
 * with `StalePortBlockError` (code `STALE_PORT_BLOCK`) BEFORE the spawn — so
 * the error envelope publishes the (port, pid, command) so the agent can act.
 * The acceptance check binds a TCP listener directly via `net.createServer`,
 * pins the worktree's allocator to that exact port via the registry, and
 * asserts the typed-error short-circuit through the CLI's `classifyError`
 * envelope shape.
 */
describe("e2e — STALE_PORT_BLOCK pre-flight (#58)", () => {
  it("aborts with code STALE_PORT_BLOCK + collisions[] when a leaked listener squats the worktree's named port", async () => {
    const { createServer } = await import("node:net");
    const { classifyError, formatError } = await import("./output.js");

    const repo = makeRepo("dt-stale-", ["login"]);
    cleanups.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const worktree = repo.worktrees.login;
    if (worktree === undefined) throw new Error("expected login worktree");
    writeStackConfig(worktree);

    // Bind an ephemeral port from THIS test process — that's the "foreign"
    // listener the pre-flight must catch. Pin the allocator to it via the
    // registry, so `allocateBlock`'s fast-path hands the same port back.
    const leaker = await new Promise<{ port: number; close: () => Promise<void> }>(
      (resolve, reject) => {
        const s = createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => {
          const addr = s.address();
          if (addr === null || typeof addr === "string") {
            reject(new Error("ephemeral bind returned no address"));
            return;
          }
          resolve({ port: addr.port, close: () => new Promise((r) => s.close(() => r())) });
        });
      },
    );
    cleanups.push(() => leaker.close());

    // Seed the registry so the allocator's stability fast-path returns this
    // exact port as the worktree's blockBase. This mirrors the real-world
    // failure mode: registry hit → no re-probe → spawn → silent EADDRINUSE.
    // The registry is keyed by the derived worktree id (#82), so derive it
    // from the same toplevel path the anchor resolver will see.
    const worktreeId = deriveWorktreeId(git(worktree, "rev-parse", "--show-toplevel"));
    const commonDir = git(worktree, "rev-parse", "--git-common-dir");
    const absCommon = commonDir.startsWith("/") ? commonDir : join(worktree, commonDir);
    const devtreesDir = join(absCommon, "devtrees");
    mkdirSync(devtreesDir, { recursive: true });
    writeFileSync(
      join(devtreesDir, "registry.json"),
      JSON.stringify({ [worktreeId]: leaker.port }),
      "utf8",
    );

    const deps = stubDriverDeps(worktree);

    // Sanity: socket is absent (first-up path) so the pre-flight DOES run.
    const socketPath = join(devtreesDir, "run", `${worktreeId}.sock`);
    expect(existsSync(socketPath)).toBe(false);

    const err = await runUp(deps as never).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: unknown },
    );
    if (err === undefined) throw new Error("expected runUp to reject with STALE_PORT_BLOCK");
    expect(err.code).toBe("STALE_PORT_BLOCK");

    // Verify the CLI's classifier + formatter produce the documented envelope
    // shape on stdout (ADR-0005: --json errors on stdout, not stderr).
    const payload = classifyError(err);
    expect(payload.code).toBe("STALE_PORT_BLOCK");
    const out = formatError(payload, "json");
    const parsed = JSON.parse(out.stdout) as {
      schema_version: string;
      error: {
        code: string;
        message: string;
        details?: {
          block_base: number;
          worktree_id: string;
          collisions: Array<{
            port_name: string;
            port: number;
            pid: number | null;
            command: string | null;
          }>;
        };
      };
    };
    expect(parsed.error.code).toBe("STALE_PORT_BLOCK");
    expect(parsed.error.details).toBeDefined();
    const details = parsed.error.details;
    if (details === undefined) throw new Error("expected error.details to be present");
    expect(details.block_base).toBe(leaker.port);
    expect(details.worktree_id).toBe(worktreeId);
    expect(details.collisions.length).toBeGreaterThanOrEqual(1);
    const webCollision = details.collisions.find((c) => c.port_name === "WEB_PORT");
    expect(webCollision).toBeDefined();
    if (webCollision === undefined) throw new Error("expected a WEB_PORT collision");
    expect(webCollision.port).toBe(leaker.port);
    // pid may be null on hosts without lsof; assert it's our own pid only
    // when lsof actually returned something (graceful degradation rule).
    if (webCollision.pid !== null) {
      expect(webCollision.pid).toBe(process.pid);
    }
  }, 20000);
});
