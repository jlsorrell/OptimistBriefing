import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../..");

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
    expect(vitestConfig).toContain('"tests/preview-e2e/**"');
    expect(previewConfig).toContain('testDir: "./tests/preview-e2e"');
    expect(previewConfig).toContain('trace: "off"');
    expect(previewConfig).toContain('screenshot: "off"');
    expect(previewConfig).toContain('video: "off"');
    expect(previewConfig).not.toContain("webServer");
  });
});
