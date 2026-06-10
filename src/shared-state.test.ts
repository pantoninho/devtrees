/**
 * Shared-state store tests (#83). The store persists the running shared
 * instance's identity — the shared-subset hash and the name→port map it
 * bound — alongside the registry in the anchor state.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedState, writeSharedState } from "./shared-state.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tmpAnchor(): string {
  const root = mkdtempSync(join(tmpdir(), "dt-shared-state-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, ".git");
}

describe("shared-state store", () => {
  it("returns undefined when nothing has been persisted", () => {
    expect(readSharedState(tmpAnchor())).toBeUndefined();
  });

  it("round-trips the hash and the name→port map", () => {
    const anchor = tmpAnchor();
    writeSharedState(anchor, { hash: "abc123", ports: { DB_PORT: 20032, CACHE_PORT: 20033 } });
    expect(readSharedState(anchor)).toEqual({
      hash: "abc123",
      ports: { DB_PORT: 20032, CACHE_PORT: 20033 },
    });
  });

  it("overwrites a previous state on re-persist (down --shared + up cycle)", () => {
    const anchor = tmpAnchor();
    writeSharedState(anchor, { hash: "old", ports: { DB_PORT: 20032 } });
    writeSharedState(anchor, { hash: "new", ports: { DB_PORT: 20032, MQ_PORT: 20034 } });
    expect(readSharedState(anchor)).toEqual({
      hash: "new",
      ports: { DB_PORT: 20032, MQ_PORT: 20034 },
    });
  });

  it("treats a corrupt state file as absent rather than crashing", () => {
    const anchor = tmpAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "shared-state.json"), "{not json", "utf8");
    expect(readSharedState(anchor)).toBeUndefined();
  });

  it("treats a structurally-wrong state file (missing fields) as absent", () => {
    const anchor = tmpAnchor();
    mkdirSync(join(anchor, "devtrees"), { recursive: true });
    writeFileSync(join(anchor, "devtrees", "shared-state.json"), `{"hash": 42}`, "utf8");
    expect(readSharedState(anchor)).toBeUndefined();
  });
});
