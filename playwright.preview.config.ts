import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

import { resolvePreviewRuntimeEnvironment } from "./scripts/preview-e2e/environment";

const runtime = resolvePreviewRuntimeEnvironment(process.env);

export default defineConfig({
  testDir: "./tests/preview-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: join(runtime.tempDirectory, "test-results"),
  use: {
    baseURL: runtime.baseURL,
    storageState: runtime.storageStatePath,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
