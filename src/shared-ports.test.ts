/**
 * Stable shared ports (#238, ADR-0011): the persisted shared port map, its
 * reconciliation with a running shared instance's numbers, and the
 * assignment of numbers to names it does not hold yet.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assignSharedPorts,
  blockingPortConflicts,
  liveSharedPortsOf,
  planSharedPorts,
  readSharedPortMap,
  reconcileSharedPortMap,
  sharedPortMapFile,
  sharedPortOrigins,
  writeSharedPortMap,
} from "./shared-ports.js";

const block = { base: 20_000, size: 10 };
const noLive = { bound: {}, processEnv: {} };
const any = (): "seed" => "seed";

describe("assignSharedPorts", () => {
  const positional = (name: string) =>
    ({ PG_PORT: 20_000, SB_PORT: 20_001, CACHE_PORT: 20_002 })[name];

  it("is the positional map when nothing is recorded (the pre-#238 numbers)", () => {
    const names = ["PG_PORT", "SB_PORT", "CACHE_PORT"];
    expect(assignSharedPorts({ names, map: {}, positional, block })).toEqual({
      ports: { PG_PORT: 20_000, SB_PORT: 20_001, CACHE_PORT: 20_002 },
      assigned: names,
      unassigned: [],
    });
  });

  it("keeps every recorded number, even off its positional slot", () => {
    const map = { PG_PORT: 20_005, SB_PORT: 20_001 };
    const result = assignSharedPorts({ names: ["PG_PORT", "SB_PORT"], map, positional, block });
    expect(result).toEqual({
      ports: { PG_PORT: 20_005, SB_PORT: 20_001 },
      assigned: [],
      unassigned: [],
    });
  });

  it("moves a new name off a number another branch's recorded name holds", () => {
    // Another branch recorded OTHER_PORT at 20_001. SB_PORT, seen for the
    // first time, takes the lowest free number instead, and so does
    // CACHE_PORT once SB_PORT holds its slot: no number goes to two names.
    const map = { PG_PORT: 20_000, OTHER_PORT: 20_001 };
    const names = ["PG_PORT", "SB_PORT", "CACHE_PORT"];
    expect(assignSharedPorts({ names, map, positional, block })).toEqual({
      ports: { PG_PORT: 20_000, SB_PORT: 20_002, CACHE_PORT: 20_003 },
      assigned: ["SB_PORT", "CACHE_PORT"],
      unassigned: [],
    });
  });

  it("skips a name when the block is full", () => {
    const tiny = { base: 20_000, size: 1 };
    const result = assignSharedPorts({
      names: ["PG_PORT", "SB_PORT"],
      map: { PG_PORT: 20_000 },
      positional: () => 20_000,
      block: tiny,
    });
    expect(result).toEqual({ ports: { PG_PORT: 20_000 }, assigned: [], unassigned: ["SB_PORT"] });
  });
});

describe("planSharedPorts — the cross-branch case (#238)", () => {
  // Branch A declares pg, x; branch B declares pg, y, x. Positionally A gives
  // X_PORT slot 1 and B gives Y_PORT slot 1: the collision the issue reports.
  const positionalA = (name: string) => ({ PG_PORT: 20_000, X_PORT: 20_001 })[name];
  const positionalB = (name: string) => ({ PG_PORT: 20_000, Y_PORT: 20_001, X_PORT: 20_002 })[name];
  const planA = (recorded?: Record<string, number>) =>
    planSharedPorts({
      names: ["PG_PORT", "X_PORT"],
      recorded,
      live: noLive,
      running: false,
      positional: positionalA,
      block,
    });
  const planB = (recorded?: Record<string, number>) =>
    planSharedPorts({
      names: ["PG_PORT", "Y_PORT", "X_PORT"],
      recorded,
      live: noLive,
      running: false,
      positional: positionalB,
      block,
    });

  it("A then B: both agree on X_PORT, and Y_PORT does not take it", () => {
    const a = planA();
    const b = planB(a.map);
    expect(a.ports.X_PORT).toBe(20_001);
    expect(b.ports.X_PORT).toBe(20_001);
    expect(b.ports.Y_PORT).toBe(20_002);
    expect(new Set(Object.values(b.map)).size).toBe(Object.keys(b.map).length);
  });

  it("B then A: both agree on X_PORT and Y_PORT", () => {
    const b = planB();
    const a = planA(b.map);
    expect(b.ports).toEqual({ PG_PORT: 20_000, Y_PORT: 20_001, X_PORT: 20_002 });
    expect(a.ports).toEqual({ PG_PORT: 20_000, X_PORT: 20_002 });
    expect(a.changed).toBe(false);
  });

  it("records nothing new once every name is recorded", () => {
    const a = planA();
    expect(a.changed).toBe(true);
    expect(planA(a.map)).toMatchObject({ changed: false, map: a.map });
  });
});

describe("reconcileSharedPortMap — migration from a 0.4.0 shared instance", () => {
  it("seeds the map from the bound ports and the processes' env, conflict-free", () => {
    // pg bound PG_PORT; its env also holds the 0.4.0 prediction for SB_PORT.
    const live = liveSharedPortsOf(
      { PG_PORT: 20_000 },
      { pg: { environment: ["PGUSER=me", "PG_PORT=20000", "SB_PORT=20001"] } },
    );
    expect(reconcileSharedPortMap(undefined, live, any)).toEqual({
      map: { PG_PORT: 20_000, SB_PORT: 20_001 },
      seeded: ["PG_PORT", "SB_PORT"],
      conflicts: [],
      reserved: new Set(),
    });
  });

  it("takes the last env entry for a key, as process-compose does", () => {
    const live = liveSharedPortsOf({}, { pg: { environment: ["SB_PORT=1", "SB_PORT=20001"] } });
    expect(live.processEnv.pg).toEqual({ SB_PORT: 20_001 });
  });

  it("reports a running process whose env holds another name's port as stale_env", () => {
    // 0.4.0: pg was started predicting X_PORT=20001; another branch then
    // activated y, which bound 20001.
    const live = liveSharedPortsOf(
      { PG_PORT: 20_000, Y_PORT: 20_001 },
      { pg: { environment: ["PG_PORT=20000", "X_PORT=20001"] } },
    );
    const { map, conflicts } = reconcileSharedPortMap(undefined, live, any);
    expect(map).toEqual({ PG_PORT: 20_000, Y_PORT: 20_001 });
    expect(conflicts).toEqual([
      { reason: "stale_env", portName: "X_PORT", port: 20_001, process: "pg" },
    ]);
  });

  it("reports a bound port that differs from the recorded one as bound_mismatch", () => {
    const live = liveSharedPortsOf({ X_PORT: 20_003 }, {});
    const { conflicts } = reconcileSharedPortMap({ X_PORT: 20_001 }, live, any);
    expect(conflicts).toEqual([
      { reason: "bound_mismatch", portName: "X_PORT", port: 20_003, recordedPort: 20_001 },
    ]);
  });

  it("reports a bound port another recorded name holds as port_taken", () => {
    // An older devtrees beside this one bound Y_PORT on X_PORT's recorded number.
    const live = liveSharedPortsOf({ Y_PORT: 20_001 }, {});
    const { map, conflicts } = reconcileSharedPortMap({ X_PORT: 20_001 }, live, any);
    expect(map).toEqual({ X_PORT: 20_001 });
    expect(conflicts).toEqual([
      { reason: "port_taken", portName: "Y_PORT", port: 20_001, holder: "X_PORT" },
    ]);
  });

  it("ignores env entries that are not shared ports", () => {
    const live = liveSharedPortsOf({}, { pg: { environment: ["PGPORT=5432"] } });
    const isShared = (name: string) => (name.endsWith("_PORT") ? "seed" : "ignore");
    expect(reconcileSharedPortMap(undefined, live, isShared).map).toEqual({});
  });
});

describe("planSharedPorts — conflicts", () => {
  it("drops a dead instance's stale numbers but keeps two recorded names on one port", () => {
    const live = liveSharedPortsOf({ Y_PORT: 20_001 }, { pg: { environment: ["X_PORT=20009"] } });
    const plan = planSharedPorts({
      names: ["X_PORT", "Z_PORT"],
      recorded: { X_PORT: 20_001, Z_PORT: 20_001 },
      live,
      running: false,
      positional: () => undefined,
      block,
    });
    expect(plan.conflicts).toEqual([
      { reason: "port_taken", portName: "Z_PORT", port: 20_001, holder: "X_PORT" },
    ]);
  });

  it("never seeds an author env entry; an unknown in-block number is only avoided", () => {
    // `FOO=20004` is the author's own environment (or another branch's
    // pre-#238 prediction devtrees cannot name): it is never recorded, but a
    // new name does not take its number while the instance runs.
    const live = liveSharedPortsOf({}, { pg: { environment: ["FOO=20004", "FOREIGN=31337"] } });
    const plan = planSharedPorts({
      names: ["PG_PORT", "NEW_PORT"],
      recorded: undefined,
      live,
      running: true,
      positional: (name) => ({ PG_PORT: 20_000, NEW_PORT: 20_004 })[name],
      block,
    });
    expect(plan.map).toEqual({ PG_PORT: 20_000, NEW_PORT: 20_001 });
    expect(plan.conflicts).toEqual([]);
  });

  it("reports block_full for a new name when recorded names hold every number", () => {
    // The reviewer's repro: block of 4, A..D recorded, a new name E.
    const tiny = { base: 100, size: 4 };
    const plan = planSharedPorts({
      names: ["E_PORT"],
      recorded: { A: 100, B: 101, C: 102, D: 103 },
      live: noLive,
      running: false,
      positional: () => 100,
      block: tiny,
    });
    expect(plan.ports).toEqual({});
    expect(plan.conflicts).toEqual([{ reason: "block_full", portName: "E_PORT" }]);
    expect(blockingPortConflicts(plan.conflicts, new Set(["E_PORT"]), new Set())).toHaveLength(1);
  });

  it("warns about a recorded port outside the current shared block", () => {
    const plan = planSharedPorts({
      names: ["PG_PORT"],
      recorded: { PG_PORT: 30_000 },
      live: noLive,
      running: false,
      positional: () => 20_000,
      block,
    });
    expect(plan.ports.PG_PORT).toBe(30_000);
    expect(plan.warnings).toEqual([expect.stringContaining("PG_PORT=30000")]);
  });
});

describe("blockingPortConflicts", () => {
  const stale = { reason: "stale_env" as const, portName: "X_PORT", port: 1, process: "pg" };
  const taken = { reason: "port_taken" as const, portName: "Y_PORT", port: 2, holder: "X_PORT" };

  it("blocks a stale env entry only for an up that binds its port", () => {
    expect(blockingPortConflicts([stale], new Set(["X_PORT"]), new Set())).toEqual([]);
    expect(blockingPortConflicts([stale], new Set(), new Set(["X_PORT"]))).toEqual([stale]);
  });

  it("blocks a port_taken for any up that declares either name", () => {
    expect(blockingPortConflicts([taken], new Set(["X_PORT"]), new Set())).toEqual([taken]);
    expect(blockingPortConflicts([taken], new Set(["Y_PORT"]), new Set())).toEqual([taken]);
    expect(blockingPortConflicts([taken], new Set(["Z_PORT"]), new Set())).toEqual([]);
  });
});

describe("sharedPortOrigins", () => {
  it("is active when bound, recorded when in the map, else predicted", () => {
    const ports = { A: 1, B: 2, C: 3 };
    expect(sharedPortOrigins(ports, { A: 1, B: 2 }, { A: 1 })).toEqual({
      A: { port: 1, origin: "active" },
      B: { port: 2, origin: "recorded" },
      C: { port: 3, origin: "predicted" },
    });
  });
});

describe("shared port map file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const anchor = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "dt-ports-"));
    dirs.push(dir);
    return dir;
  };

  it("round-trips", () => {
    const dir = anchor();
    expect(readSharedPortMap(dir)).toBeUndefined();
    writeSharedPortMap(dir, { PG_PORT: 20_000 });
    expect(readSharedPortMap(dir)).toEqual({ PG_PORT: 20_000 });
  });

  it("writes atomically: no temp file is left beside the map", () => {
    const dir = anchor();
    writeSharedPortMap(dir, { PG_PORT: 20_000 });
    writeSharedPortMap(dir, { PG_PORT: 20_000, SB_PORT: 20_001 });
    expect(readdirSync(join(dir, "devtrees"))).toEqual(["shared-ports.json"]);
  });

  it("warns, and reads as absent, a file that cannot be parsed", () => {
    const dir = anchor();
    writeSharedPortMap(dir, {});
    writeFileSync(sharedPortMapFile(dir), "{not json");
    const warnings: string[] = [];
    expect(readSharedPortMap(dir, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining("cannot read the shared port map")]);
  });

  it("drops only an invalid entry, with a warning, and keeps the rest", () => {
    const dir = anchor();
    writeSharedPortMap(dir, {});
    writeFileSync(
      sharedPortMapFile(dir),
      JSON.stringify({ version: 1, ports: { PG_PORT: 20_000, SB_PORT: "x", Z: -1 } }),
    );
    const warnings: string[] = [];
    expect(readSharedPortMap(dir, (m) => warnings.push(m))).toEqual({ PG_PORT: 20_000 });
    expect(warnings).toHaveLength(2);
  });
});
