/**
 * The live instance handle (#259): liveness, the unresponsive instance, the
 * pending reload and unbooted services are raised here, once, for every
 * command that opens a worktree or the shared instance. process-compose is
 * the in-memory adapter (src/in-memory-driver.ts); a liveness that stays
 * unknown is the one thing it cannot model, so those tests inject the probe.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { createInMemoryProcessCompose, type InMemoryProcessCompose } from "./in-memory-driver.js";
import type { InstanceStatus } from "./instances.js";
import {
  openSharedLiveInstance,
  openWorktreeInstance,
  type LiveInstance,
  type LiveInstanceSeams,
  type OpenContext,
} from "./live-instance.js";
import { instancePaths, runDir, sharedInstancePaths } from "./paths.js";
import { writePendingReload } from "./reload-pending.js";
import { declaredServices } from "./selection.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function svc(name: string, extra: Partial<ResolvedService> = {}): ResolvedService {
  return {
    name,
    tier: "isolated",
    command: "sleep 300",
    ports: [],
    dependsOn: [],
    environment: [],
    ...extra,
  };
}

/** `api` <- `web` (depends on it), `job` in the `jobs` namespace. */
const stack: ResolvedStack = {
  services: [
    svc("web", { dependsOn: [{ name: "api" }] }),
    svc("api"),
    svc("job", { namespace: "jobs" }),
  ],
};

const processes = {
  web: { command: "sleep 300", depends_on: { api: { condition: "process_started" } } },
  api: { command: "sleep 300" },
  job: { command: "sleep 300", namespace: "jobs" },
};

const ID = "login-0123abcd";
const restartContext: OpenContext = { command: "restart", retry: "devtrees restart web" };

/**
 * An anchor with a worktree instance and the shared instance on one
 * in-memory process-compose, both booted from `processes` with the default
 * namespace only (`job` is not booted). `probe` overrides the liveness probe.
 */
async function fixture(
  opts: { probe?: (socketPath: string) => Promise<InstanceStatus>; boot?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "dt-live-"));
  const anchor = join(root, ".git");
  mkdirSync(join(anchor, "devtrees"), { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => rmSync(runDir(anchor), { recursive: true, force: true }));
  const pc: InMemoryProcessCompose = createInMemoryProcessCompose({ firstPid: 500 });
  const wt = instancePaths(anchor, ID);
  const shared = sharedInstancePaths(anchor);
  for (const inst of [wt, shared]) {
    writeFileSync(inst.configPath, stringifyYaml({ processes }));
    if (opts.boot !== false) await pc.driver.up(inst, ["default"]);
  }
  const seams: LiveInstanceSeams = {
    driver: pc.driver,
    liveness: { probe: opts.probe ?? ((p) => pc.probeSocket(p)), retryDelaysMs: [0, 0] },
    probeSocket: (p) => pc.probeSocket(p),
  };
  const openWt = (context: OpenContext = restartContext, readOnly = false) =>
    openWorktreeInstance(anchor, ID, seams, context, { readOnly });
  const openShared = (context: OpenContext = { command: "up" }) =>
    openSharedLiveInstance(anchor, seams, context);
  return { anchor, pc, wt, shared, seams, openWt, openShared };
}

async function rejection(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    return err as Error & { code?: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a rejection");
}

function required(handle: LiveInstance | undefined): LiveInstance {
  if (handle === undefined) throw new Error("expected a live instance");
  return handle;
}

describe("opening an instance: liveness (#80, #186)", () => {
  it("a live worktree instance opens with its id, socket and derived config", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    expect(handle.id).toBe(ID);
    expect(handle.ref).toEqual({ socketPath: fx.wt.socketPath, configPath: fx.wt.configPath });
    expect(Object.keys(handle.processes() ?? {})).toEqual(["web", "api", "job"]);
  });

  it("a live shared instance opens as `shared`", async () => {
    const fx = await fixture();
    const handle = required(await fx.openShared());
    expect(handle.id).toBe("shared");
    expect(handle.socketPath).toBe(fx.shared.socketPath);
  });

  it("no socket file: not live, nothing probed", async () => {
    const probed: string[] = [];
    const fx = await fixture({
      boot: false,
      probe: async (p) => {
        probed.push(p);
        return "stale";
      },
    });
    expect(await fx.openWt()).toBeUndefined();
    expect(await fx.openShared()).toBeUndefined();
    expect(probed).toEqual([]);
  });

  it("a crashed instance's socket is stale: not live, and the orphaned file is unlinked", async () => {
    const fx = await fixture();
    fx.pc.crash(fx.wt.socketPath);
    fx.pc.crash(fx.shared.socketPath);
    expect(await fx.openWt()).toBeUndefined();
    expect(await fx.openShared()).toBeUndefined();
    expect(existsSync(fx.wt.socketPath)).toBe(false);
    expect(existsSync(fx.shared.socketPath)).toBe(false);
  });

  it("a read-only open leaves a stale socket file in place", async () => {
    const fx = await fixture();
    fx.pc.crash(fx.wt.socketPath);
    expect(await fx.openWt({ command: "up" }, true)).toBeUndefined();
    expect(existsSync(fx.wt.socketPath)).toBe(true);
  });

  it("a liveness that stays unknown fails INSTANCE_UNRESPONSIVE after every retry, socket kept", async () => {
    const probed: string[] = [];
    const fx = await fixture({
      probe: async (p) => {
        probed.push(p);
        return "unknown";
      },
    });
    const err = await rejection(fx.openWt());
    expect(err.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err.message).toContain("devtrees restart:");
    expect(err.details).toMatchObject({ instance: ID, socket_path: fx.wt.socketPath, attempts: 3 });
    expect(String(err.details?.remedy)).toContain("Retry `devtrees restart web`");
    expect(probed).toEqual([fx.wt.socketPath, fx.wt.socketPath, fx.wt.socketPath]);
    expect(existsSync(fx.wt.socketPath)).toBe(true);
  });

  it("the shared instance's unknown liveness names it and its own down", async () => {
    const fx = await fixture({ probe: async () => "unknown" });
    const err = await rejection(fx.openShared({ command: "down" }));
    expect(err.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err.details).toMatchObject({ instance: "shared", socket_path: fx.shared.socketPath });
    expect(String(err.details?.remedy)).toContain("devtrees down --shared");
    expect(existsSync(fx.shared.socketPath)).toBe(true);
  });

  it("a probe that answers on a retry opens the instance; a stale one after unknown is not live", async () => {
    const answers: InstanceStatus[] = ["unknown", "running", "unknown", "stale"];
    const fx = await fixture({ probe: async () => answers.shift() ?? "stale" });
    expect((await fx.openWt())?.id).toBe(ID);
    expect(await fx.openWt()).toBeUndefined();
  });
});

describe("reading the rows (#205, #226)", () => {
  it("reads the project", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const rows = await handle.rows(1000);
    expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual(["web:Running", "api:Running"]);
    expect(await handle.tryRows()).toEqual(rows);
  });

  it("a process-compose that never answers is HEALTH_TIMEOUT, or INSTANCE_UNRESPONSIVE when asked", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    fx.pc.freeze(fx.wt.socketPath);
    const notices: string[] = [];
    expect((await rejection(handle.rows(30, { notify: (m) => notices.push(m) }))).code).toBe(
      "HEALTH_TIMEOUT",
    );
    expect(notices).toHaveLength(1);
    const err = await rejection(handle.rows(30, { unresponsive: true }));
    expect(err.code).toBe("INSTANCE_UNRESPONSIVE");
    expect(err.details).toMatchObject({ instance: ID, attempts: 1 });
    expect(String(err.details?.remedy)).toContain("Retry `devtrees restart web`");
    expect(await handle.tryRows(20)).toBeUndefined();
  });

  it("a process-compose gone since it was opened is INSTANCE_NOT_FOUND", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    fx.pc.crash(fx.wt.socketPath);
    expect((await rejection(handle.rows(1000))).code).toBe("INSTANCE_NOT_FOUND");
    expect(await handle.gone()).toBe(true);
  });
});

describe("a pending hot-reload (#191, #222)", () => {
  const isolated = stack.services;

  it("no marker: nothing pending", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const rows = await handle.rows(1000);
    const check = {
      rows,
      previous: handle.processes(),
      isolated,
      requested: [],
      isAlive: () => true,
    };
    expect(handle.assertNoPendingReload(check)).toBe(false);
  });

  it("an old run still alive refuses CONFIG_DRIFT reload_pending, naming its pid and the retry", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const rows = await handle.rows(1000);
    const webPid = fx.pc.pidOf(fx.wt.socketPath, "web") ?? 0;
    writePendingReload(fx.anchor, ID, {
      services: ["web"],
      oldRuns: [{ name: "web", pid: webPid }],
    });
    const check = {
      rows,
      previous: handle.processes(),
      isolated,
      requested: [],
      isAlive: () => true,
    };
    const up = await rejection(() => handle.assertNoPendingReload(check));
    expect(up.code).toBe("CONFIG_DRIFT");
    expect(up.details).toEqual({ reason: "reload_pending", services: ["web"], pids: [webPid] });
    expect(up.message).toContain(`devtrees up: a previous hot-reload of '${ID}'`);
    expect(up.message).toContain(`\`kill ${webPid}\`), then run \`devtrees up\` again`);
    const restart = await rejection(() =>
      handle.assertNoPendingReload({ ...check, command: "restart", retry: "devtrees restart api" }),
    );
    expect(restart.message).toContain("nothing was restarted");
    expect(restart.message).toContain("run `devtrees restart api` again");
  });

  it("a service the reload has not brought back yet: the remedy reboots its namespaces", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const rows = await handle.rows(1000);
    writePendingReload(fx.anchor, ID, { services: ["job"], oldRuns: [] });
    const check = {
      rows,
      previous: handle.processes(),
      isolated,
      requested: [],
      isAlive: () => false,
    };
    const err = await rejection(() => handle.assertNoPendingReload(check));
    expect(err.details).toEqual({ reason: "reload_pending", services: ["job"], pids: [] });
    expect(err.message).toContain("devtrees down && devtrees up -n default -n jobs");
  });

  it("converged: true after a successful read, false when the read failed", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const rows = await handle.rows(1000);
    writePendingReload(fx.anchor, ID, { services: ["web"], oldRuns: [{ name: "web", pid: 1 }] });
    const check = {
      rows,
      previous: handle.processes(),
      isolated,
      requested: [],
      isAlive: () => false,
    };
    expect(handle.assertNoPendingReload(check)).toBe(true);
    expect(handle.assertNoPendingReload({ ...check, rows: undefined })).toBe(false);
  });

  it("the shared instance has no pending-reload marker: it never refuses", async () => {
    const fx = await fixture();
    const handle = required(await fx.openShared());
    writePendingReload(fx.anchor, "shared", {
      services: ["web"],
      oldRuns: [{ name: "web", pid: 1 }],
    });
    const check = {
      rows: undefined,
      previous: undefined,
      isolated,
      requested: [],
      isAlive: () => true,
    };
    expect(handle.assertNoPendingReload(check)).toBe(false);
  });
});

describe("the booted selection (ADR-0008, #170, #224)", () => {
  it("a bare up targets what was booted, and its dead selected services", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    fx.pc.exit(fx.wt.socketPath, "web", 1);
    const plan = handle.planUp(stack, await handle.rows(1000), undefined);
    expect(plan.namespaces).toEqual(["default"]);
    expect(plan.services.map((s) => s.name)).toEqual(["web", "api"]);
    expect(plan.dead).toEqual(["web"]);
  });

  it("a namespace that was never booted is NAMESPACE_NOT_RUNNING, for up and for a named service", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const rows = await handle.rows(1000);
    expect((await rejection(() => handle.planUp(stack, rows, ["jobs"]))).code).toBe(
      "NAMESPACE_NOT_RUNNING",
    );
    const declared = declaredServices(handle.processes());
    const request = { worktreeId: ID, command: "restart" as const, declared };
    const job = declared.filter((s) => s.name === "job");
    const err = await rejection(() =>
      handle.assertNamedBooted(request, { isolated: job, skippedShared: [] }, rows),
    );
    expect(err.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(() =>
      handle.assertNamedBooted(
        request,
        { isolated: declared.slice(0, 2), skippedShared: [] },
        rows,
      ),
    ).not.toThrow();
  });
});

describe("starting dead services (ADR-0008, #178, #240)", () => {
  it("starts only the dead ones, in depends_on order, each with the pid of the run that died", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const webPid = fx.pc.pidOf(fx.wt.socketPath, "web");
    fx.pc.exit(fx.wt.socketPath, "web", 1);
    const rows = await handle.rows(1000);
    const started = await handle.restartDead({
      rows,
      names: ["web", "api"],
      order: stack.services,
    });
    expect(started).toEqual([{ name: "web", stalePid: webPid }]);
    expect(fx.pc.rows(fx.wt.socketPath).find((r) => r.name === "web")?.status).toBe("Running");
    expect(
      await handle.restartDead({
        rows: await handle.rows(1000),
        names: ["web"],
        order: stack.services,
      }),
    ).toEqual([]);
  });

  it("a refused start in a worktree instance is SERVICE_START_FAILED with the caller's remedy", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    fx.pc.exit(fx.wt.socketPath, "web", 1);
    fx.pc.refuse("start", "web", "no");
    const err = await rejection(
      handle.restartDead({
        rows: await handle.rows(1000),
        names: ["web"],
        order: stack.services,
        remedyFor: () => "devtrees down && devtrees up",
      }),
    );
    expect(err.code).toBe("SERVICE_START_FAILED");
    expect(err.details).toMatchObject({ worktree_id: ID, remedy: "devtrees down && devtrees up" });
    expect(err.message).toContain(`could not restart dead service(s) in '${ID}': web (`);
  });

  it("a refused start in the shared instance is SHARED_SERVICE_DEAD start_refused", async () => {
    const fx = await fixture();
    const handle = required(await fx.openShared());
    fx.pc.exit(fx.shared.socketPath, "api", 1);
    fx.pc.refuse("start", "api", "no");
    const err = await rejection(
      handle.restartDead({
        rows: await handle.rows(1000),
        names: ["web", "api"],
        order: stack.services,
        remedyFor: (names) => `devtrees down --shared -n ${names.join(" ")}`,
      }),
    );
    expect(err.code).toBe("SHARED_SERVICE_DEAD");
    expect(err.details).toMatchObject({ reason: "start_refused" });
    expect(err.message).toContain("devtrees down --shared -n api");
  });
});

describe("bounded stop and restart (ADR-0009, #190)", () => {
  const seams = { readProcessTable: async () => [], pollMs: 1, treeGraceMs: 1 };

  it("restarts one running service in place with a new run", async () => {
    const fx = await fixture();
    const handle = required(await fx.openWt());
    const before = fx.pc.pidOf(fx.wt.socketPath, "api");
    const config = { processes } as never;
    const outcome = await handle.restart("api", { rows: await handle.rows(1000), config, seams });
    expect(outcome.ok).toBe(true);
    expect(fx.pc.pidOf(fx.wt.socketPath, "api")).not.toBe(before);
    expect(fx.pc.rows(fx.wt.socketPath).find((r) => r.name === "api")?.status).toBe("Running");
  });

  it("stops the named services and nothing else", async () => {
    const fx = await fixture();
    const handle = required(await fx.openShared());
    const config = { processes } as never;
    const outcome = await handle.stop(["web"], { rows: await handle.rows(1000), config, seams });
    expect(outcome.unsettled).toEqual([]);
    const rows = fx.pc.rows(fx.shared.socketPath);
    expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual(["web:Completed", "api:Running"]);
  });
});
