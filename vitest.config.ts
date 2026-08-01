import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      ".worktrees/**",
      "tests/e2e/**",
      "tests/preview-e2e/**",
      "tests/integration/**/*.test.ts",
    ],
  },
});
