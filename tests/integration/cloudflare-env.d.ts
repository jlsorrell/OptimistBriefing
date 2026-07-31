import type { D1Migration } from "@cloudflare/vitest-pool-workers";

import type { Env as WorkerEnv } from "../../src/worker";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      UPGRADE_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
