import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("deployment configuration", () => {
  it("preserves remote variables and keeps Worker compatibility dates aligned", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: { deploy?: string };
    };
    const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
      compatibility_date?: string;
      limits?: { cpu_ms?: number };
    };
    const workerConfig = readFileSync("vitest.worker.config.ts", "utf8");
    const compatibilityDateMatches = [
      ...workerConfig.matchAll(
        /^\s*compatibilityDate:\s*["']([^"']+)["'],?\s*$/gm,
      ),
    ];

    expect(packageJson.scripts.deploy).toBe(
      "npm run build && wrangler deploy --keep-vars",
    );
    expect(compatibilityDateMatches).toHaveLength(1);

    const workerCompatibilityDate = compatibilityDateMatches[0]?.[1];
    expect(workerCompatibilityDate).toBe(wrangler.compatibility_date);
    expect(workerCompatibilityDate).toBe("2026-07-29");
    expect(wrangler.limits?.cpu_ms).toBe(30_000);
  });
});
