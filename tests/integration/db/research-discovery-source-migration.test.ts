import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";

import { D1BriefingRepository } from "../../../src/db/d1-repository";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    UPGRADE_DB: D1Database;
  }
}

const OFFICIAL_PUBLICATION_POLICIES = {
  "stanford-research": ["research.stanford.edu", "/news"],
  "berkeley-research": ["vcresearch.berkeley.edu", "/news"],
  "harvard-research": ["research.harvard.edu", "/"],
  "mit-research": ["news.mit.edu", "/rss/"],
  "cmu-research": ["www.cmu.edu", "/news/"],
  "penn-research": ["research.upenn.edu", "/news/"],
  "johns-hopkins-research": ["hub.jhu.edu", "/topics/research/"],
  "ut-austin-research": ["research.utexas.edu", "/news"],
  "georgia-tech-research": ["research.gatech.edu", "/news"],
  "google-research": ["research.google", "/blog/"],
  "google-deepmind": ["deepmind.google", "/discover/blog/"],
  anthropic: ["www.anthropic.com", "/research"],
  openai: ["openai.com", "/research/"],
} as const;

function requiredMigration(name: string): D1Migration {
  const migration = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (migration === undefined) {
    throw new TypeError(`Required test migration is missing: ${name}`);
  }
  return migration;
}

async function source(id: string, database = env.DB) {
  const found = (await new D1BriefingRepository(database).listSources()).find(
    (candidate) => candidate.id === id,
  );
  if (found === undefined) {
    throw new TypeError(`Missing source: ${id}`);
  }
  return found;
}

async function applyPreDiscoveryMigrations(): Promise<void> {
  await applyD1Migrations(
    env.UPGRADE_DB,
    ["0001_initial.sql", "0002_source_catalog.sql", "0003_fix_mts_canonical_url.sql", "0004_source_preferred_sections.sql", "0005_edition_metadata.sql", "0006_model_budget_reservations.sql"].map(
      requiredMigration,
    ),
  );
}

describe("research discovery source migration", () => {
  it("adds the catalog sources and strict policies for official publications", async () => {
    expect(await source("alignment-forum")).toMatchObject({
      role: "blog",
      discoveryMechanism: "rss",
      sectionEligibility: ["research", "research_radar"],
    });
    expect((await source("lesswrong-curated")).restrictions.feedUrl).toBe(
      "https://www.lesswrong.com/feed.xml?view=curated",
    );
    expect((await source("papers-with-code-co")).restrictions.pageUrl).toBe(
      "https://paperswithcode.co/papers/recent",
    );

    for (const [id, [host, pathPrefix]] of Object.entries(
      OFFICIAL_PUBLICATION_POLICIES,
    )) {
      expect((await source(id)).restrictions.urlPolicy).toEqual({
        allowedHosts: [host],
        allowedPorts: [""],
        allowedPathPrefixes: [pathPrefix],
      });
    }
  });

  it("is idempotent and preserves an existing official publication URL policy", async () => {
    await applyPreDiscoveryMigrations();
    const customPolicy = {
      allowedHosts: ["custom.stanford.example"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/local"],
    };
    const before = await source("stanford-research", env.UPGRADE_DB);
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify({ ...before.restrictions, urlPolicy: customPolicy }),
        "stanford-research",
      )
      .run();

    await applyD1Migrations(env.UPGRADE_DB, [
      requiredMigration("0007_research_discovery_sources.sql"),
    ]);
    const once = await new D1BriefingRepository(env.UPGRADE_DB).listSources();

    await applyD1Migrations(env.UPGRADE_DB, [
      requiredMigration("0007_research_discovery_sources.sql"),
    ]);

    expect(
      (await source("stanford-research", env.UPGRADE_DB)).restrictions.urlPolicy,
    ).toEqual(customPolicy);
    expect(await new D1BriefingRepository(env.UPGRADE_DB).listSources()).toEqual(
      once,
    );
  });
});
