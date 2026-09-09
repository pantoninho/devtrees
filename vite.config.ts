import { defineConfig } from "vite-plus";

const ignorePatterns = [
  "dist/**",
  "node_modules/**",
  "**/*.md",
  // fallow's saved baselines are machine-generated; don't reformat/lint them.
  "fallow-baselines/**",
];

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: true,
    // Ship a single self-contained dist/cli.mjs. Without this, tsdown emits
    // separate chunks for dynamic imports (e.g. `await import("./commands.js")`
    // in cli.ts), so copying only dist/cli.mjs to a directory without the rest
    // of the chunks would crash at runtime with a missing-chunk error. Tracked
    // alongside issue #65, which closed the deps externalisation gap.
    outputOptions: {
      codeSplitting: false,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Sandboxes DEVTREES_RUNTIME_DIR so the control sockets tests create land
    // in one temp dir per run instead of the developer's real runtime dir, and
    // are removed when the run ends (issue #156 / ADR-0007). Global (not a
    // per-file setup) so it is set before any worker starts and torn down once.
    globalSetup: ["src/test-setup.ts"],
  },
  fmt: {
    ignorePatterns,
  },
  lint: {
    ignorePatterns,
    options: {
      // Run TypeScript type-aware lint rules and full type-checking as part of
      // `vp check`, so CI's check stage actually type-checks (see issue #12).
      typeAware: true,
      typeCheck: true,
    },
  },
});
