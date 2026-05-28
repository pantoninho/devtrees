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
  },
  test: {
    include: ["src/**/*.test.ts"],
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
