import { defineConfig } from "vite-plus";

const ignorePatterns = ["dist/**", "node_modules/**", "**/*.md"];

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
  },
});
