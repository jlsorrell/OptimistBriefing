import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_ORIGIN, PREVIEW_TEMP_PREFIX } from "../../../scripts/preview-e2e/environment";

const projectRoot = resolve(import.meta.dirname, "../../..");
const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

describe("preview E2E wiring", () => {
  it("keeps preview Playwright isolated from ordinary test commands", async () => {
    const [packageJsonText, tsconfigText, vitestConfig, previewConfig] = await Promise.all([
      readFile(resolve(projectRoot, "package.json"), "utf8"),
      readFile(resolve(projectRoot, "tsconfig.json"), "utf8"),
      readFile(resolve(projectRoot, "vitest.config.ts"), "utf8"),
      readFile(resolve(projectRoot, "playwright.preview.config.ts"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      scripts: Record<string, string>;
    };
    const tsconfig = JSON.parse(tsconfigText) as { include: string[] };

    expect(packageJson.scripts["test:e2e:preview"]).toBe(
      "node --import tsx scripts/run-preview-e2e.ts",
    );
    expect(tsconfig.include).toContain("playwright.preview.config.ts");
    expect(vitestConfig).toContain('".worktrees/**"');
    expect(vitestConfig).toContain('"tests/preview-e2e/**"');
    expect(previewConfig).toContain('testDir: "./tests/preview-e2e"');
    expect(previewConfig).toContain('trace: "off"');
    expect(previewConfig).toContain('screenshot: "off"');
    expect(previewConfig).toContain('video: "off"');
    expect(previewConfig).not.toContain("webServer");
  });

  it("loads the preview configuration with exactly one worker", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), PREVIEW_TEMP_PREFIX));
    temporaryPaths.push(tempDirectory);
    await chmod(tempDirectory, 0o700);
    vi.stubEnv("OPTIMIST_PREVIEW_BASE_URL", PREVIEW_ORIGIN);
    vi.stubEnv("OPTIMIST_PREVIEW_TEMP_DIR", tempDirectory);
    vi.stubEnv("OPTIMIST_PREVIEW_ACCESS_TOKEN", "synthetic-preview-token-1234");

    const previewConfig = (await import("../../../playwright.preview.config")).default;

    expect(previewConfig.workers).toBe(1);
    expect(previewConfig.reporter).toEqual([
      ["line"],
      ["./scripts/preview-e2e/safe-reporter.ts"],
    ]);
    expect(previewConfig.use).not.toHaveProperty("storageState");
    expect(previewConfig.use).not.toHaveProperty("extraHTTPHeaders");
  });
});
