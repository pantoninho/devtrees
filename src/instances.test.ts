/**
 * Instance discovery — unit tests.
 *
 * Exercise the pure discovery primitive that powers `devtrees ls` (and #9
 * prune): given an anchor with its `devtrees/` state dir on disk, enumerate
 * every instance — each worktree's and the shared one — purely by listing
 * control sockets under the repo's run dir (`runDir(anchor)` — a short runtime
 * dir since #156) and cross-referencing the allocation registry. No central
 * daemon, no PID tracking.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { deriveWorktreeId } from "./anchor.js";
import {
  classifyProbe,
  discoverInstances,
  probeSocket,
  probeUntilDefinitive,
  socketHeldByProcess,
  type InstanceStatus,
} from "./instances.js";
import {
  SHARED_INSTANCE_ID,
  SHARED_REGISTRY_KEY,
  instancePaths,
  legacyRunDir,
  runDir,
} from "./paths.js";
import type { ServiceStatus } from "./driver.js";

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
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  mkdirSync(runDir(anchor), { recursive: true });
  cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
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

/**
 * Write a derived config the way the real deriver shapes it: every process's
 * `environment:` carries the flat injection of ALL the instance's named ports
 * (connection info, issue #110), while the `x-devtrees.ports_by_service`
 * metadata records only the ports each process *declares*. Pass
 * `{ metadata: false }` to model a legacy config written before the metadata
 * existed.
 */
interface DerivedProcessFixture {
  readonly ports: ReadonlyArray<[string, number]>;
  /** process-compose `namespace:` (#226); omitted means `default`. */
  readonly namespace?: string | ReadonlyArray<string>;
}

/** One process's lines in a derived config, environment carrying `allPorts`. */
function derivedProcessLines(
  name: string,
  proc: DerivedProcessFixture,
  allPorts: ReadonlyArray<[string, number]>,
): string[] {
  const lines = [`  ${name}:`, "    command: noop", `    working_dir: /tmp`];
  if (proc.namespace !== undefined) lines.push(`    namespace: ${JSON.stringify(proc.namespace)}`);
  if (allPorts.length > 0) {
    lines.push("    environment:", ...allPorts.map(([k, v]) => `      - ${k}=${v}`));
  }
  return lines;
}

function writeDerivedConfig(
  anchor: string,
  id: string,
  processes: Record<string, DerivedProcessFixture>,
  opts: { metadata?: boolean } = {},
): void {
  const allPorts = Object.values(processes).flatMap((p) => p.ports);
  const lines = ["processes:"];
  for (const [name, proc] of Object.entries(processes)) {
    lines.push(...derivedProcessLines(name, proc, allPorts));
  }
  if (opts.metadata !== false) {
    lines.push("x-devtrees:");
    lines.push("  ports_by_service:");
    for (const [name, proc] of Object.entries(processes)) {
      lines.push(`    ${name}:${proc.ports.length === 0 ? " {}" : ""}`);
      for (const [k, v] of proc.ports) lines.push(`      ${k}: ${v}`);
    }
  }
  writeFileSync(join(anchor, "devtrees", `${id}.yaml`), `${lines.join("\n")}\n`, "utf8");
}

/** Touch a marker file at the control-socket path so discovery sees it. */
function touchSocketMarker(anchor: string, id: string): void {
  writeFileSync(instancePaths(anchor, id).socketPath, "", "utf8");
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
    server.listen(instancePaths(anchor, id).socketPath, () => resolve());
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

  it("classifies a worktree directory named `shared` as a worktree instance (issue #82)", async () => {
    // `deriveWorktreeId` suffixes every worktree id with a path hash, so a
    // worktree at `.../shared` gets a stem like `shared-1a2b3c4d` — never the
    // bare reserved `shared` stem. Discovery must file it as kind `worktree`.
    const anchor = tmpAnchor();
    const id = deriveWorktreeId("/repo/wt/shared");
    writeRegistry(anchor, { [id]: 20000 });
    writeDerivedConfig(anchor, id, { web: { ports: [["WEB_PORT", 20000]] } });
    touchSocketMarker(anchor, id);

    const [instance] = await discoverInstances(anchor);
    expect(instance).toBeDefined();
    expect(instance?.kind).toBe("worktree");
    expect(instance?.id).toBe(id);
    expect(instance?.blockBase).toBe(20000);
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
    writeFileSync(join(runDir(anchor), "README"), "", "utf8");
    writeFileSync(join(runDir(anchor), "registry.lock"), "", "utf8");

    const instances = await discoverInstances(anchor);
    expect(instances).toEqual([]);
  });

  it("still sees a socket left in the pre-#156 run dir, and reports its real path", async () => {
    // An instance started by a devtrees that predated the relocation has its
    // socket in `<anchor>/devtrees/run`. Discovery reads that dir too, so `ls`
    // shows the instance and `prune` can reclaim it across the upgrade instead
    // of leaving an invisible orphan.
    const anchor = tmpAnchor();
    const legacy = legacyRunDir(anchor);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "login-abcd1234.sock"), "", "utf8");

    const [instance] = await discoverInstances(anchor);
    expect(instance?.id).toBe("login-abcd1234");
    expect(instance?.socketPath).toBe(join(legacy, "login-abcd1234.sock"));
  });

  it("prefers the canonical run dir when the same id exists in both locations", async () => {
    const anchor = tmpAnchor();
    const legacy = legacyRunDir(anchor);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "login-abcd1234.sock"), "", "utf8");
    touchSocketMarker(anchor, "login-abcd1234");

    const instances = await discoverInstances(anchor);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.socketPath).toBe(instancePaths(anchor, "login-abcd1234").socketPath);
  });

  it("populates services[] on each running instance via a single getServiceStatuses call per instance", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000, billing: 21000 });
    writeDerivedConfig(anchor, "login", {
      web: { ports: [["WEB_PORT", 20000]] },
      worker: { ports: [["WORKER_PORT", 20001]] },
    });
    writeDerivedConfig(anchor, "billing", { web: { ports: [["WEB_PORT", 21000]] } });
    await bindSocketServer(anchor, "login");
    await bindSocketServer(anchor, "billing");

    const calls: string[] = [];
    const fakeStatuses: Record<string, ServiceStatus[]> = {
      login: [
        { name: "web", status: "Running", health: "ready" },
        { name: "worker", status: "Running", health: "not_ready" },
      ],
      billing: [{ name: "web", status: "Running", health: "ready" }],
    };
    const getServiceStatuses = async (socketPath: string): Promise<ServiceStatus[]> => {
      calls.push(socketPath);
      const id = socketPath.endsWith("login.sock") ? "login" : "billing";
      const statuses = fakeStatuses[id];
      if (statuses === undefined) throw new Error(`no fake for ${id}`);
      return statuses;
    };

    const instances = await discoverInstances(anchor, { getServiceStatuses });
    // One call per discovered (running) instance — never more.
    expect(calls).toHaveLength(2);

    const byId = new Map(instances.map((i) => [i.id, i]));
    const login = byId.get("login");
    const billing = byId.get("billing");
    expect(login?.services).toMatchObject([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20000 } },
      { name: "worker", status: "Running", health: "not_ready", ports: { WORKER_PORT: 20001 } },
    ]);
    expect(billing?.services).toMatchObject([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 21000 } },
    ]);
  });

  it("scopes services[].ports to the service's declared ports — `{}` for a portless service (#110)", async () => {
    // Every process's environment carries the whole instance port map (flat
    // connection-info injection), so a service's ports must come from the
    // `x-devtrees.ports_by_service` metadata, not from reading env back.
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", {
      web: { ports: [["WEB_PORT", 20000]] },
      worker: { ports: [] },
    });
    await bindSocketServer(anchor, "login");

    const getServiceStatuses = async (): Promise<ServiceStatus[]> => [
      { name: "web", status: "Running", health: "ready" },
      { name: "worker", status: "Running", health: "unknown" },
    ];

    const [instance] = await discoverInstances(anchor, { getServiceStatuses });
    expect(instance?.services).toMatchObject([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 20000 } },
      { name: "worker", status: "Running", health: "unknown", ports: {} },
    ]);
    // The instance-level projection still flattens the whole map.
    expect(instance?.ports).toEqual({ WEB_PORT: 20000 });
  });

  it("falls back to `{}` per service for a legacy derived config without x-devtrees metadata", async () => {
    // An instance started by an older devtrees has no ports_by_service record.
    // Claiming the full instance map per service would be wrong (the #110 bug);
    // the honest answer is "unknown" — empty ports, instance-level map intact.
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(
      anchor,
      "login",
      { web: { ports: [["WEB_PORT", 20000]] } },
      {
        metadata: false,
      },
    );
    await bindSocketServer(anchor, "login");

    const getServiceStatuses = async (): Promise<ServiceStatus[]> => [
      { name: "web", status: "Running", health: "ready" },
    ];

    const [instance] = await discoverInstances(anchor, { getServiceStatuses });
    expect(instance?.services).toMatchObject([
      { name: "web", status: "Running", health: "ready", ports: {} },
    ]);
    expect(instance?.ports).toEqual({ WEB_PORT: 20000 });
  });

  it("skips getServiceStatuses for stale instances — services[] is empty for an orphaned socket", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    touchSocketMarker(anchor, "login");

    let called = false;
    const getServiceStatuses = async (): Promise<ServiceStatus[]> => {
      called = true;
      return [];
    };

    const [instance] = await discoverInstances(anchor, { getServiceStatuses });
    expect(instance?.status).toBe("stale");
    expect(instance?.services).toEqual([]);
    expect(called).toBe(false);
  });

  it("services[] defaults to [] when no getServiceStatuses injector is provided", async () => {
    // Lock-free read path: callers (and the default fallback) must not be
    // forced to talk to the binary just to discover instances. Tests that
    // don't care about service rows pass no injector.
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    await bindSocketServer(anchor, "login");

    const [instance] = await discoverInstances(anchor);
    expect(instance?.services).toEqual([]);
  });

  it("swallows a getServiceStatuses error for one instance without losing the others", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000, billing: 21000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    writeDerivedConfig(anchor, "billing", { web: { ports: [["WEB_PORT", 21000]] } });
    await bindSocketServer(anchor, "login");
    await bindSocketServer(anchor, "billing");

    const getServiceStatuses = async (socketPath: string): Promise<ServiceStatus[]> => {
      if (socketPath.endsWith("login.sock")) throw new Error("socket hiccup");
      return [{ name: "web", status: "Running", health: "ready" }];
    };

    const instances = await discoverInstances(anchor, { getServiceStatuses });
    const login = instances.find((i) => i.id === "login");
    const billing = instances.find((i) => i.id === "billing");
    expect(login?.services).toEqual([]);
    expect(billing?.services).toMatchObject([
      { name: "web", status: "Running", health: "ready", ports: { WEB_PORT: 21000 } },
    ]);
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

/**
 * Probe classification (issue #186). Only a definitive "nothing is listening"
 * may read as `stale` (and so license unlinking the socket); a timeout or an
 * ambiguous error is `unknown`.
 */
describe("classifyProbe", () => {
  it("a connect is running", () => {
    expect(classifyProbe({ kind: "connected" })).toBe("running");
  });

  it("ENOENT, ECONNREFUSED and ENOTSOCK are stale: nothing is listening", () => {
    expect(classifyProbe({ kind: "error", code: "ENOENT" })).toBe("stale");
    expect(classifyProbe({ kind: "error", code: "ECONNREFUSED" })).toBe("stale");
    expect(classifyProbe({ kind: "error", code: "ENOTSOCK" })).toBe("stale");
  });

  it("a timeout is unknown, never stale", () => {
    expect(classifyProbe({ kind: "timeout" })).toBe("unknown");
  });

  it("any other error is unknown", () => {
    for (const code of ["EAGAIN", "EACCES", "EMFILE", "ETIMEDOUT", undefined]) {
      expect(classifyProbe({ kind: "error", code })).toBe("unknown");
    }
  });
});

/**
 * Bind a unix socket at `path` in a child process (so it can be frozen or
 * killed without touching this test runner). Resolves once it listens.
 */
async function spawnListener(path: string, backlog = 511): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("net").createServer().listen({ path: ${JSON.stringify(path)}, backlog: ${backlog} }, () => console.log("up"))`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(() => {
    child.kill("SIGCONT");
    child.kill("SIGKILL");
  });
  await new Promise((resolve) => child.stdout?.once("data", resolve));
  return child;
}

/** Leave a real socket file with no listener, the way a SIGKILLed process-compose does. */
async function leaveDeadSocket(path: string): Promise<void> {
  const child = await spawnListener(path);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

describe("probeSocket", () => {
  it("a path with no file is stale (ENOENT)", async () => {
    const anchor = tmpAnchor();
    expect(await probeSocket(instancePaths(anchor, "gone").socketPath)).toBe("stale");
  });

  it("a plain file at the socket path is stale (ENOTSOCK)", async () => {
    const anchor = tmpAnchor();
    touchSocketMarker(anchor, "login");
    expect(await probeSocket(instancePaths(anchor, "login").socketPath)).toBe("stale");
  });

  it("a socket file whose listener was SIGKILLed is stale (ECONNREFUSED, nobody holds it)", async () => {
    const anchor = tmpAnchor();
    const path = instancePaths(anchor, "login").socketPath;
    await leaveDeadSocket(path);
    expect(await probeSocket(path)).toBe("stale");
    expect(await probeSocket(path, { heldByProcess: async () => false })).toBe("stale");
    // lsof unavailable or failing: the refusal's verdict stands.
    expect(await probeSocket(path, { heldByProcess: async () => undefined })).toBe("stale");
  });

  it("a refused connect is unknown while a process still holds the socket (a full backlog)", async () => {
    const anchor = tmpAnchor();
    const path = instancePaths(anchor, "login").socketPath;
    await leaveDeadSocket(path);
    expect(await probeSocket(path, { heldByProcess: async () => true })).toBe("unknown");
  });

  it("a live listener whose probe stalls past the timeout is unknown, not stale", async () => {
    // The #186 mechanism: on a loaded machine the event loop wakes with the
    // connect timer already due, and timers run before the connect callback.
    // Blocking the loop past the timeout reproduces that against a real,
    // healthy listener. This relies on libuv's loop order: an expired timer
    // fires in the timers phase, before the poll phase delivers the connect
    // completion, so the 5ms timer always wins after the 50ms stall.
    const anchor = tmpAnchor();
    await bindSocketServer(anchor, "login");
    const pending = probeSocket(instancePaths(anchor, "login").socketPath, { timeoutMs: 5 });
    const until = Date.now() + 50;
    while (Date.now() < until) {
      // Busy-wait: starve the event loop the way a loaded machine does.
    }
    expect(await pending).toBe("unknown");
  });

  it("a live listener that answers in time is running", async () => {
    const anchor = tmpAnchor();
    await bindSocketServer(anchor, "login");
    expect(await probeSocket(instancePaths(anchor, "login").socketPath)).toBe("running");
  });

  // macOS: a listener with a full accept backlog refuses connects with
  // ECONNREFUSED, the same errno as a socket file with no listener. Only the
  // lsof cross-check tells them apart, and it is verified on this platform.
  it.runIf(process.platform === "darwin")(
    "a frozen listener with a full backlog is unknown, not stale (SIGSTOP)",
    async () => {
      const anchor = tmpAnchor();
      const path = instancePaths(anchor, "frozen").socketPath;
      const child = await spawnListener(path, 1);
      const held: Socket[] = [];
      cleanups.push(() => {
        for (const s of held) s.destroy();
      });
      child.kill("SIGSTOP");
      // Queue connections behind the frozen listener until one is refused.
      for (let i = 0; i < 64; i++) {
        const connected = await new Promise<boolean>((resolve) => {
          const s = connect(path);
          held.push(s);
          s.once("connect", () => resolve(true));
          s.once("error", () => resolve(false));
        });
        if (!connected) break;
      }
      expect(await socketHeldByProcess(path)).toBe(true);
      expect(await probeSocket(path)).toBe("unknown");
    },
  );

  it.runIf(process.platform === "darwin")(
    "socketHeldByProcess: false for a dead socket file, true for a live listener's",
    async () => {
      const anchor = tmpAnchor();
      const dead = instancePaths(anchor, "dead").socketPath;
      await leaveDeadSocket(dead);
      expect(await socketHeldByProcess(dead)).toBe(false);
      const live = instancePaths(anchor, "live").socketPath;
      await spawnListener(live);
      expect(await socketHeldByProcess(live)).toBe(true);
    },
  );

  it("socketHeldByProcess: an lsof that times out counts as held, so a refusal stays unknown", async () => {
    // On a loaded machine lsof itself can be slow exactly when process-compose
    // is; a timeout must never fall through to "stale" and unlink the socket.
    const anchor = tmpAnchor();
    const slowLsof = join(anchor, "slow-lsof.sh");
    writeFileSync(slowLsof, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const path = instancePaths(anchor, "login").socketPath;
    expect(await socketHeldByProcess(path, { lsofPath: slowLsof, timeoutMs: 100 })).toBe(true);

    await leaveDeadSocket(path);
    const status = await probeSocket(path, {
      heldByProcess: (p) => socketHeldByProcess(p, { lsofPath: slowLsof, timeoutMs: 100 }),
    });
    expect(status).toBe("unknown");
  });

  it("socketHeldByProcess: a missing lsof binary is 'not known', so a crash still reads stale", async () => {
    const anchor = tmpAnchor();
    const path = instancePaths(anchor, "login").socketPath;
    const missing = join(anchor, "no-such-lsof");
    expect(await socketHeldByProcess(path, { lsofPath: missing })).toBeUndefined();

    await leaveDeadSocket(path);
    const status = await probeSocket(path, {
      heldByProcess: (p) => socketHeldByProcess(p, { lsofPath: missing }),
    });
    expect(status).toBe("stale");
  });
});

describe("probeUntilDefinitive", () => {
  it("re-probes while unknown and returns the first definitive answer", async () => {
    const answers: InstanceStatus[] = ["unknown", "unknown", "running"];
    let i = 0;
    const status = await probeUntilDefinitive(
      "/x.sock",
      async () => answers[i++] ?? "unknown",
      [0, 0, 0],
    );
    expect(status).toBe("running");
    expect(i).toBe(3);
  });

  it("gives up as unknown after one probe per backoff step plus the first", async () => {
    let probes = 0;
    const status = await probeUntilDefinitive(
      "/x.sock",
      async () => {
        probes++;
        return "unknown";
      },
      [0, 0],
    );
    expect(status).toBe("unknown");
    expect(probes).toBe(3);
  });

  it("does not retry a definitive answer", async () => {
    let probes = 0;
    const status = await probeUntilDefinitive("/x.sock", async () => {
      probes++;
      return "stale";
    });
    expect(status).toBe("stale");
    expect(probes).toBe(1);
  });
});

describe("discoverInstances — unknown liveness (#186)", () => {
  it("lists an instance whose probe stays unknown as `unknown` and makes no driver call for it", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [["WEB_PORT", 20000]] } });
    touchSocketMarker(anchor, "login");
    const fetched: string[] = [];

    const [instance] = await discoverInstances(anchor, {
      probeSocket: async () => "unknown",
      probeRetryDelaysMs: [0],
      getServiceStatuses: async (p) => {
        fetched.push(p);
        return [];
      },
    });

    expect(instance?.status).toBe("unknown");
    expect(instance?.ports).toEqual({ WEB_PORT: 20000 });
    expect(instance?.services).toEqual([]);
    expect(fetched).toEqual([]);
    // Discovery is read-only: the socket file is never removed.
    expect(existsSync(instancePaths(anchor, "login").socketPath)).toBe(true);
  });
});

/**
 * Issue #226 (ADR-0009): discovery reads back each instance's booted
 * namespaces and lists every service with its namespaces, tier, dead-versus-
 * done state and pid. A read that fails is `unresponsive`, never fatal.
 */
describe("discoverInstances — namespaces and per-service state (#226)", () => {
  it("reads the booted namespaces back as `up` does: one whose services are all present", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    // Booted with `-n app`: `shared-ui` is in app and ios, `sim` only in ios.
    writeDerivedConfig(anchor, "login", {
      web: { ports: [["WEB_PORT", 20000]], namespace: "app" },
      "shared-ui": { ports: [], namespace: ["app", "ios"] },
      sim: { ports: [], namespace: "ios" },
      plain: { ports: [] },
    });
    await bindSocketServer(anchor, "login");

    const [instance] = await discoverInstances(anchor, {
      getServiceStatuses: async () => [
        { name: "web", status: "Running", health: "ready", pid: 11 },
        { name: "shared-ui", status: "Running", health: "unknown", pid: 12 },
        { name: "plain", status: "Running", health: "unknown", pid: 13 },
      ],
    });

    expect(instance?.servicesRead).toBe("ok");
    // `ios` is not booted: `sim` is missing, even though `shared-ui` runs.
    expect(instance?.namespaces).toEqual(["app", "default"]);
    expect(instance?.services.map((s) => [s.name, s.namespaces, s.tier])).toEqual([
      ["web", ["app"], "isolated"],
      ["shared-ui", ["app", "ios"], "isolated"],
      ["plain", ["default"], "isolated"],
    ]);
  });

  it("classifies each service active, dead or done, and publishes a pid only while active", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    writeDerivedConfig(anchor, "login", {
      web: { ports: [] },
      stopped: { ports: [] },
      migrate: { ports: [] },
      crashed: { ports: [] },
    });
    await bindSocketServer(anchor, "login");

    const [instance] = await discoverInstances(anchor, {
      getServiceStatuses: async () => [
        { name: "web", status: "Running", health: "unknown", pid: 21 },
        // `process stop` and a crash look the same on v1.122.0 (ADR-0009).
        { name: "stopped", status: "Completed", health: "unknown", exitCode: -1, pid: 22 },
        { name: "migrate", status: "Completed", health: "unknown", exitCode: 0, pid: 23 },
        { name: "crashed", status: "Error", health: "unknown", exitCode: 1, pid: 24 },
      ],
    });

    expect(instance?.services.map((s) => [s.name, s.state, s.pid])).toEqual([
      ["web", "active", 21],
      ["stopped", "dead", undefined],
      ["migrate", "done", undefined],
      ["crashed", "dead", undefined],
    ]);
    expect(instance?.services[1]?.status).toBe("Completed");
  });

  it("lists the shared instance's services with tier `shared`", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { [SHARED_REGISTRY_KEY]: 30000 });
    writeDerivedConfig(anchor, SHARED_INSTANCE_ID, { db: { ports: [["DB_PORT", 30000]] } });
    await bindSocketServer(anchor, SHARED_INSTANCE_ID);

    const [instance] = await discoverInstances(anchor, {
      getServiceStatuses: async () => [{ name: "db", status: "Running", health: "unknown" }],
    });

    expect(instance?.kind).toBe("shared");
    expect(instance?.namespaces).toEqual(["default"]);
    expect(instance?.services).toEqual([
      {
        name: "db",
        status: "Running",
        health: "unknown",
        ports: { DB_PORT: 30000 },
        namespaces: ["default"],
        tier: "shared",
        state: "active",
      },
    ]);
  });

  it("falls back to process-compose's namespaces when the derived config is gone", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    await bindSocketServer(anchor, "login");

    const [instance] = await discoverInstances(anchor, {
      getServiceStatuses: async () => [
        { name: "web", status: "Running", health: "unknown", namespaces: ["app"] },
        { name: "api", status: "Running", health: "unknown", namespaces: ["app", "backend"] },
      ],
    });

    expect(instance?.namespaces).toEqual(["app", "backend"]);
    expect(instance?.services.map((s) => s.namespaces)).toEqual([["app"], ["app", "backend"]]);
  });

  it("marks a running instance whose read fails as unresponsive, and keeps listing the others", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000, billing: 21000 });
    writeDerivedConfig(anchor, "login", { web: { ports: [] } });
    writeDerivedConfig(anchor, "billing", { web: { ports: [] } });
    await bindSocketServer(anchor, "login");
    await bindSocketServer(anchor, "billing");

    const instances = await discoverInstances(anchor, {
      getServiceStatuses: async (socketPath) => {
        if (socketPath.endsWith("login.sock")) throw new Error("timed out after 5000ms");
        return [{ name: "web", status: "Running", health: "unknown" }];
      },
    });

    const login = instances.find((i) => i.id === "login");
    const billing = instances.find((i) => i.id === "billing");
    expect(login).toMatchObject({
      status: "running",
      servicesRead: "unresponsive",
      namespaces: [],
      services: [],
    });
    expect(billing).toMatchObject({ servicesRead: "ok", namespaces: ["default"] });
  });

  it("does not read a stale instance: services_read is skipped", async () => {
    const anchor = tmpAnchor();
    writeRegistry(anchor, { login: 20000 });
    touchSocketMarker(anchor, "login");

    const [instance] = await discoverInstances(anchor, {
      getServiceStatuses: async () => {
        throw new Error("must not be called");
      },
    });

    expect(instance).toMatchObject({ status: "stale", servicesRead: "skipped", namespaces: [] });
  });
});
