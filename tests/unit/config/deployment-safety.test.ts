import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("deployment configuration", () => {
  it("preserves remote variables and keeps Worker compatibility dates aligned", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: { deploy?: string };
    };
    const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
      compatibility_date?: string;
    };
    const workerConfig = readFileSync("vitest.worker.config.ts", "utf8");
    const compatibilityDateMatch = workerConfig.match(
      /compatibilityDate:\s*["']([^"']+)["']/,
    );

    expect(packageJson.scripts.deploy).toBe(
      "npm run build && wrangler deploy --keep-vars",
    );
    expect(compatibilityDateMatch).not.toBeNull();

    const workerCompatibilityDate = compatibilityDateMatch?.[1];
    expect(workerCompatibilityDate).toBe(wrangler.compatibility_date);
    expect(workerCompatibilityDate).toBe("2026-07-29");
  });
});
