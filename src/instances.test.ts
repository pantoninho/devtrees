/**
 * Instance discovery — unit tests.
 *
 * Exercise the pure discovery primitive that powers `devtrees ls` (and #9
 * prune): given an anchor with its `devtrees/` state dir on disk, enumerate
 * every instance — each worktree's and the shared one — purely by listing
 * control sockets under `<anchor>/devtrees/run/` and cross-referencing the
 * allocation registry. No central daemon, no PID tracking.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { discoverInstances } from "./instances.js";
import { SHARED_INSTANCE_ID, SHARED_REGISTRY_KEY } from "./paths.js";

// Cleanups may be sync (rmSync) or async (server.close); each is wrapped to a
// promise so afterEach can await them uniformly without tripping the lint rule.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    const c = cleanups.pop();
    if (c) await Promise.resolve(c());
  }
});

function tmpAnchor(): string {
  const root = mkdtempSync(join(tmpdir(), "dt-disc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const anchor = join(root, ".git");
  mkdirSync(join(anchor, "devtrees", "run"), { recursive: true });
  return anchor;
}

/** Write a JSON snapshot of the allocation registry. */
function writeRegistry(anchor: string, snapshot: Record<string, number>): void {
  writeFileSync(
    join(anchor, "devtrees", "registry.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
}

/** Write a derived config exposing one named-port env entry per process. */
function writeDerivedConfig(
  anchor: string,
  id: string,
  processes: Record<string, { ports: ReadonlyArray<[string, number]> }>,
): void {
  const lines = ["processes:"];
  for (const [name, proc] of Object.entries(processes)) {
    lines.push(`  ${name}:`);
    lines.push("    command: noop");
    lines.push(`    working_dir: /tmp`);
    if (proc.ports.length > 0) {
      lines.push("    environment:");
      for (const [k, v] of proc.ports) lines.push(`      - ${k}=${v}`);
    }
  }
  writeFileSync(join(anchor, "devtrees", `${id}.yaml`), `${lines.join("\n")}\n`, "utf8");
}

/** Touch a marker file at the control-socket path so discovery sees it. */
function touchSocketMarker(anchor: string, id: string): void {
  writeFileSync(join(anchor, "devtrees", "run", `${id}.sock`), "", "utf8");
}

/**
 * Bind a real unix-socket server at the control-socket path; returns a closer
 * the afterEach hook will run. The server stays connectable for the duration
 * of one test so `status: "running"` can be asserted.
 */
async function bindSocketServer(anchor: string, id: string): Promise<void> {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(anchor, "devtrees", "run", `${id}.sock`), () => resolve());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
}

describe("discoverInstances", () => {
  it("returns an empty list when no run dir exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "dt-disc-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const anchor = join(root, ".git");
    // No `devtrees/run/` exists at all.
    const instances = await discoverInstances(anchor);
    expect(instances).toEqual([]);
  });

  it("returns an empty list when the run dir exists but is empty", async () => {
    const anchor = tmpAnchor();
    const instances = await discoverInstances(anchor);
    expect(instances).toEqual([]);
  });

  it("enumerates worktree instances by listing *.sock files under the run dir", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000, billing: 20032 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    writeDerivedConfig(anchor, "billing", { web: { ports: [["WEB_PORT", 20032]] } });
    touchSocketMarker(anchor, "login");
    touchSocketMarker(anchor, "billing");

    const instances = await discoverInstances(anchor);
    const ids = instances.map((i) => i.id).sort();
    expect(ids).toEqual(["billing", "login"]);
  });

  it("marks an instance as shared when its socket is shared.sock", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { [SHARED_REGISTRY_KEY]: 30000 });
    writeDerivedConfig(anchor, SHARED_INSTANCE_ID, { db: { ports: [["DB_PORT", 30000]] } });
    touchSocketMarker(anchor, SHARED_INSTANCE_ID);

    const [instance] = await discoverInstances(anchor);
    expect(instance).toBeDefined();
    expect(instance?.kind).toBe("shared");
    expect(instance?.id).toBe(SHARED_INSTANCE_ID);
  });

  it("marks worktree-id sockets as kind 'worktree'", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    touchSocketMarker(anchor, "login");

    const [instance] = await discoverInstances(anchor);
    expect(instance?.kind).toBe("worktree");
  });

  it("reports a connectable socket as status 'running'", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    await bindSocketServer(anchor, "login");

    const [instance] = await discoverInstances(anchor);
    expect(instance?.status).toBe("running");
  });

  it("reports an orphaned socket file (no listener) as status 'stale'", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    touchSocketMarker(anchor, "login");

    const [instance] = await discoverInstances(anchor);
    expect(instance?.status).toBe("stale");
  });

  it("reads each instance's allocated named ports from its derived config", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", {
      web: { ports: [["WEB_PORT", 20000]] },
      worker: { ports: [["WORKER_PORT", 20001]] },
    });
    touchSocketMarker(anchor, "login");

    const [instance] = await discoverInstances(anchor);
    expect(instance?.ports).toEqual({ WEB_PORT: 20000, WORKER_PORT: 20001 });
  });

  it("falls back to the registry's block base when no derived config is on disk", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    // No derived config for login — the socket exists but the per-instance YAML
    // was lost (or never written). Discovery must still report something useful.
    touchSocketMarker(anchor, "login");

    const [instance] = await discoverInstances(anchor);
    expect(instance?.blockBase).toBe(20000);
    expect(instance?.ports).toEqual({});
  });

  it("ignores non-.sock entries under the run dir", async () => {
    const anchor = tmpAnchor();
    writeFileSync(join(anchor, "devtrees", "run", "README"), "", "utf8");
    writeFileSync(join(anchor, "devtrees", "run", "registry.lock"), "", "utf8");

    const instances = await discoverInstances(anchor);
    expect(instances).toEqual([]);
  });

  it("returns instances sorted by id with the shared instance first", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, {
      [SHARED_REGISTRY_KEY]: 30000,
      login: 20000,
      billing: 20032,
    });
    touchSocketMarker(anchor, "login");
    touchSocketMarker(anchor, "billing");
    touchSocketMarker(anchor, SHARED_INSTANCE_ID);

    const instances = await discoverInstances(anchor);
    expect(instances.map((i) => i.id)).toEqual([SHARED_INSTANCE_ID, "billing", "login"]);
  });
});
