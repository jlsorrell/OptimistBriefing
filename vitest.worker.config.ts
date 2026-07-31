import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "src/db/migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-07-29",
          d1Databases: ["DB", "UPGRADE_DB"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["tests/integration/**/*.test.ts"],
      setupFiles: ["./tests/integration/db/apply-migrations.ts"],
    },
  };
});
