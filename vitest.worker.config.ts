import path from "node:path";

import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "src/db/migrations"),
  );

  return {
    test: {
      include: ["tests/integration/**/*.test.ts"],
      setupFiles: ["./tests/integration/db/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityDate: "2025-09-01",
            d1Databases: ["DB", "UPGRADE_DB"],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
