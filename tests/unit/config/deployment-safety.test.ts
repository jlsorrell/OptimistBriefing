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

  it("documents secret-safe and fail-closed research discovery operations", () => {
    const readme = readFileSync("README.md", "utf8");
    const deploymentRunbook = readFileSync(
      "docs/runbooks/deployment.md",
      "utf8",
    );
    const privacyRunbook = readFileSync(
      "docs/runbooks/privacy-and-retention.md",
      "utf8",
    );
    const sourceHealthRunbook = readFileSync(
      "docs/runbooks/source-health.md",
      "utf8",
    );
    const wranglerConfig = readFileSync("wrangler.jsonc", "utf8");
    const devVarsExample = readFileSync(".dev.vars.example", "utf8");

    expect(readme).toContain("OPENALEX_API_KEY");
    expect(deploymentRunbook).toContain("optional free OpenAlex API key");
    expect(deploymentRunbook).toContain(
      'npx wrangler secret put OPENALEX_API_KEY --config "$OPTIMIST_PREVIEW_CONFIG"',
    );
    expect(deploymentRunbook).toContain("--keep-vars");
    expect(deploymentRunbook).toMatch(
      /already-reviewed isolated preview\s+configuration/,
    );
    expect(deploymentRunbook).toMatch(
      /command arguments, Git, D1, logs, audits, or\s+screenshots/,
    );
    expect(wranglerConfig).not.toContain("OPENALEX_API_KEY");
    expect(devVarsExample.split("\n")).toContain(
      ["OPENALEX_API_KEY", ""].join("="),
    );
    expect(privacyRunbook).toContain("OPENALEX_API_KEY");

    for (const reason of [
      "out_of_window",
      "unchanged_observation",
      "identity_merged",
      "route_excluded",
      "topic_mismatch",
      "quality_rejected",
      "capacity_limited",
    ]) {
      expect(sourceHealthRunbook).toContain(reason);
    }
    expect(sourceHealthRunbook).toContain(
      "An empty AI Policy section is preferable to unrelated filler.",
    );
    expect(sourceHealthRunbook).toContain("AI Policy routing fails closed");
  });
});
