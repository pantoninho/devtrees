import { describe, expect, it } from "vite-plus/test";
import { instancePaths, stateDir } from "./paths.js";

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
