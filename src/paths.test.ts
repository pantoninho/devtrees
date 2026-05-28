import { describe, expect, it } from "vite-plus/test";
import {
  SHARED_INSTANCE_ID,
  SHARED_REGISTRY_KEY,
  instancePaths,
  sharedInstancePaths,
  stateDir,
} from "./paths.js";

describe("anchor state paths", () => {
  it("roots all runtime state under <git-common-dir>/devtrees/ (no .gitignore needed)", () => {
    expect(stateDir("/repo/.git")).toBe("/repo/.git/devtrees");
  });

  it("derives a per-instance config and control socket from the worktree id", () => {
    const p = instancePaths("/repo/.git", "login");
    expect(p.configPath).toBe("/repo/.git/devtrees/login.yaml");
    expect(p.socketPath).toBe("/repo/.git/devtrees/run/login.sock");
  });
});

describe("shared instance paths", () => {
  it("fixes the shared derived config and socket at the anchor (one per repo)", () => {
    const p = sharedInstancePaths("/repo/.git");
    expect(p.configPath).toBe("/repo/.git/devtrees/shared.yaml");
    expect(p.socketPath).toBe("/repo/.git/devtrees/run/shared.sock");
  });

  it("keeps the shared registry key distinct from any plausible worktree slug", () => {
    // The slugifier strips leading underscores, so a real worktree path can
    // never produce `__shared__` — the well-known key is unambiguous.
    expect(SHARED_REGISTRY_KEY).toBe("__shared__");
    expect(SHARED_INSTANCE_ID).toBe("shared");
  });
});
