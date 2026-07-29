import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import { describe, expect, it } from "vitest";

import { D1BriefingRepository } from "../../../src/db/d1-repository";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    UPGRADE_DB: D1Database;
  }
}

function requiredMigration(name: string): D1Migration {
  const migration = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (migration === undefined) {
    throw new TypeError(`Required test migration is missing: ${name}`);
  }
  return migration;
}

async function preferredSections(
  database: D1Database,
): Promise<Map<string, unknown>> {
  const sources = await new D1BriefingRepository(database).listSources();
  return new Map(
    sources.map((source) => [
      source.id,
      source.restrictions.preferredSection,
    ]),
  );
}

describe("source preferred-section migration", () => {
  it("sets Baltimore and DMV defaults in a fresh database", async () => {
    const sections = await preferredSections(env.DB);

    for (const id of ["wypr", "baltimore-banner", "baltimore-brew"]) {
      expect(sections.get(id), id).toBe("baltimore");
    }
    for (const id of [
      "maryland-gov",
      "maryland-general-assembly",
      "dc-gov",
      "dc-register",
      "virginia-gov",
      "virginia-lis",
      "wtop",
      "maryland-matters",
      "wamu",
    ]) {
      expect(sections.get(id), id).toBe("dmv");
    }
  });

  it("is a no-op when applied again", async () => {
    await applyD1Migrations(env.UPGRADE_DB, [
      requiredMigration("0001_initial.sql"),
      requiredMigration("0002_source_catalog.sql"),
      requiredMigration("0003_fix_mts_canonical_url.sql"),
      requiredMigration("0004_source_preferred_sections.sql"),
    ]);
    const once = await preferredSections(env.UPGRADE_DB);

    await applyD1Migrations(env.UPGRADE_DB, [
      requiredMigration("0004_source_preferred_sections.sql"),
    ]);

    expect(await preferredSections(env.UPGRADE_DB)).toEqual(once);
  });
});
