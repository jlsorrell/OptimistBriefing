import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import { describe, expect, it } from "vitest";

import { D1BriefingRepository } from "../../../src/db/d1-repository";
import { SourceHttpClient } from "../../../src/sources/http-client";
import { createNewsCollectorFromCatalog } from "../../../src/sources/news-collector";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    UPGRADE_DB: D1Database;
  }
}

const OLD_MTS_RESTRICTIONS =
  '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"manual","sectionEligibility":["world","technology"],"pageUrl":"https://mts.now/","canCorroborateFacts":false}';

const OLD_CATALOG_MIGRATION: D1Migration = {
  name: "0002_source_catalog.sql",
  queries: [
    `INSERT INTO sources (
      id, canonical_name, canonical_url, role, trust_prior, enabled,
      restrictions_json, last_success_at, health_status
    ) VALUES (
      'monitoring-the-situation',
      'Monitoring the Situation',
      'https://mts.now/',
      'analysis',
      0.55,
      1,
      '${OLD_MTS_RESTRICTIONS.replaceAll("'", "''")}',
      NULL,
      'unknown'
    )`,
  ],
};

function requiredMigration(name: string): D1Migration {
  const migration = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (migration === undefined) {
    throw new TypeError(`Required test migration is missing: ${name}`);
  }
  return migration;
}

async function applyOldMtsDatabase(): Promise<D1BriefingRepository> {
  await applyD1Migrations(env.UPGRADE_DB, [
    requiredMigration("0001_initial.sql"),
    OLD_CATALOG_MIGRATION,
  ]);
  return new D1BriefingRepository(env.UPGRADE_DB);
}

async function applyCanonicalFix(): Promise<void> {
  await applyD1Migrations(env.UPGRADE_DB, [
    requiredMigration("0003_fix_mts_canonical_url.sql"),
  ]);
}

function canonicalMtsFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url !== "https://www.mts.now/") {
    throw new Error(`Unexpected MTS URL after upgrade: ${url}`);
  }
  return Promise.resolve(
    new Response(
      `<!doctype html><html><body>
        <article>
          <h2><a href="/p/secure-model-evaluation">Secure model evaluation roundup</a></h2>
          <time datetime="2026-07-29T07:00:00.000Z">July 29, 2026</time>
          <p>Reporting and primary documents on secure evaluation.</p>
        </article>
      </body></html>`,
      { headers: { "content-type": "text/html" } },
    ),
  );
}

describe("MTS canonical URL migration", () => {
  it("upgrades the applied original catalog row and makes collection usable", async () => {
    const repo = await applyOldMtsDatabase();

    expect(
      (await repo.listSources()).find(
        (source) => source.id === "monitoring-the-situation",
      ),
    ).toMatchObject({
      canonicalUrl: "https://mts.now/",
      discoveryMechanism: "manual",
      restrictions: {
        pageUrl: "https://mts.now/",
      },
    });

    await applyCanonicalFix();
    const mtsSource = (await repo.listSources()).find(
      (source) => source.id === "monitoring-the-situation",
    );
    if (mtsSource === undefined) {
      throw new TypeError("MTS source disappeared during migration.");
    }
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: canonicalMtsFetch,
        maxRetries: 0,
        now: () => new Date("2026-07-29T08:00:00.000Z"),
      }),
      sources: [mtsSource],
    });

    expect(
      await collector.collect({
        from: "2026-07-28T00:00:00.000Z",
        to: "2026-07-29T12:00:00.000Z",
      }),
    ).toEqual([
      expect.objectContaining({
        sourceId: "monitoring-the-situation",
        originalUrl:
          "https://www.mts.now/p/secure-model-evaluation",
        canCorroborateFacts: false,
      }),
    ]);
  });

  it("preserves a locally customized old MTS row", async () => {
    const repo = await applyOldMtsDatabase();
    await repo.updateSource("monitoring-the-situation", {
      canonicalName: "My local MTS source",
      discoveryMechanism: "manual",
      restrictions: {
        bodyRetrieval: "forbidden",
        contentUse: "local-metadata-policy",
        pageUrl: "https://mts.now/local",
      },
    });

    await applyCanonicalFix();

    expect(
      (await repo.listSources()).find(
        (source) => source.id === "monitoring-the-situation",
      ),
    ).toMatchObject({
      canonicalName: "My local MTS source",
      canonicalUrl: "https://mts.now/",
      discoveryMechanism: "manual",
      restrictions: {
        contentUse: "local-metadata-policy",
        pageUrl: "https://mts.now/local",
      },
    });
  });

  it("is a no-op when the ordered fix migration is applied again", async () => {
    const repo = await applyOldMtsDatabase();
    await applyCanonicalFix();
    const once = (await repo.listSources()).find(
      (source) => source.id === "monitoring-the-situation",
    );
    expect(once).toMatchObject({
      canonicalUrl: "https://www.mts.now/",
      discoveryMechanism: "page",
    });

    await applyCanonicalFix();

    expect(
      (await repo.listSources()).find(
        (source) => source.id === "monitoring-the-situation",
      ),
    ).toEqual(once);
  });
});
