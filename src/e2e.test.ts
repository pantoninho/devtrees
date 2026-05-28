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
import { runDown, runUp } from "./commands.js";

// Unix domain socket paths are capped (~104 bytes on macOS, ~108 on Linux). The
// control socket lives at `<git-common-dir>/devtrees/run/<id>.sock`, so the temp
// repo must be rooted shallowly enough that the socket path fits. The OS tmpdir
// (e.g. macOS `/var/folders/.../T`) is already deep enough to overflow, so we use
// a short, fixed base dir instead.
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

const STUB = fileURLToPath(new URL("../test/stub-process-compose.mjs", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
    const root = mkdtempSync(join(SHORT_TMP, "dt-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    // A normal repo with a linked worktree.
    const main = join(root, "main");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q");
    git(main, "config", "user.email", "t@t");
    git(main, "config", "user.name", "t");
    writeFileSync(join(main, "README.md"), "x");
    git(main, "add", ".");
    git(main, "commit", "-qm", "init");

    const worktree = join(root, "login");
    git(main, "worktree", "add", "-q", worktree, "-b", "login");
    writeStackConfig(worktree);

    const deps = {
      cwd: worktree,
      driver: { binary: process.execPath, prefixArgs: [STUB] } as never,
      attach: false,
    };

    const up = await runUp(deps as never);
    cleanups.push(() => {
      void runDown(deps as never);
    });

    // Acceptance: the worktree id is resolved from the directory, not the branch.
    expect(up.worktreeId).toBe("login");

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

describe("e2e smoke — extend an existing process-compose.yaml", () => {
  it("up runs the base-defined service; the base file is unmodified; derived config is tier-free", async () => {
    const root = mkdtempSync(join(SHORT_TMP, "dt-ext-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const main = join(root, "main");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q");
    git(main, "config", "user.email", "t@t");
    git(main, "config", "user.name", "t");
    writeFileSync(join(main, "README.md"), "x");
    git(main, "add", ".");
    git(main, "commit", "-qm", "init");

    const worktree = join(root, "login");
    git(main, "worktree", "add", "-q", worktree, "-b", "login");
    writeExtendConfig(worktree);

    const basePath = join(worktree, "process-compose.yaml");
    const baseTextBefore = readFileSync(basePath, "utf8");
    const baseMtimeBefore = statSync(basePath).mtimeMs;

    const deps = {
      cwd: worktree,
      driver: { binary: process.execPath, prefixArgs: [STUB] } as never,
      attach: false,
    };

    const up = await runUp(deps as never);
    cleanups.push(() => {
      void runDown(deps as never);
    });

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
