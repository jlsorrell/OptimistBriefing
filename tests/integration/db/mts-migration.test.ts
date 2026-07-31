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

const ORIGINAL_MANUAL_MTS_RESTRICTIONS =
  '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"manual","sectionEligibility":["world","technology"],"pageUrl":"https://mts.now/","canCorroborateFacts":false}';

const D6F84BD_PAGE_MTS_RESTRICTIONS =
  '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"page","sectionEligibility":["world","technology"],"pageUrl":"https://mts.now/","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["mts.now"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}';

const LISTING_PAGE_MTS_RESTRICTIONS =
  '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"page","sectionEligibility":["world","technology"],"pageUrl":"https://mts.now/","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["mts.now"],"allowedPorts":[""],"allowedPathPrefixes":["/"]},"listing":{"itemSelector":"article","linkSelector":"h2 a, h3 a, a","titleSelector":"h2, h3","dateSelector":"time","dateAttribute":"datetime","summarySelector":"p","maxItems":50,"maxBodyFetches":0}}';

function oldCatalogMigration(restrictions: string): D1Migration {
  return {
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
      '${restrictions.replaceAll("'", "''")}',
      NULL,
      'unknown'
    )`,
    ],
  };
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

async function applyOldMtsDatabase(
  restrictions = ORIGINAL_MANUAL_MTS_RESTRICTIONS,
): Promise<D1BriefingRepository> {
  await applyD1Migrations(env.UPGRADE_DB, [
    requiredMigration("0001_initial.sql"),
    oldCatalogMigration(restrictions),
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

async function collectCanonicalMts(repo: D1BriefingRepository) {
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
  return (await collector.collect({
    from: "2026-07-28T00:00:00.000Z",
    to: "2026-07-29T12:00:00.000Z",
  })).candidates;
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

    expect(await collectCanonicalMts(repo)).toEqual([
      expect.objectContaining({
        sourceId: "monitoring-the-situation",
        originalUrl:
          "https://www.mts.now/p/secure-model-evaluation",
        canCorroborateFacts: false,
      }),
    ]);
  });

  it("upgrades the exact d6f84bd page row without a listing object", async () => {
    const repo = await applyOldMtsDatabase(
      D6F84BD_PAGE_MTS_RESTRICTIONS,
    );

    await applyCanonicalFix();

    expect(await collectCanonicalMts(repo)).toEqual([
      expect.objectContaining({
        sourceId: "monitoring-the-situation",
        originalUrl:
          "https://www.mts.now/p/secure-model-evaluation",
        canCorroborateFacts: false,
      }),
    ]);
  });

  it("upgrades the later page row that already had listing configuration", async () => {
    const repo = await applyOldMtsDatabase(
      LISTING_PAGE_MTS_RESTRICTIONS,
    );

    await applyCanonicalFix();

    expect(await collectCanonicalMts(repo)).toHaveLength(1);
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

  it("does not overwrite an old seed when the canonical URL belongs to another source", async () => {
    const repo = await applyOldMtsDatabase();
    await env.UPGRADE_DB.prepare(
      `INSERT INTO sources (
        id, canonical_name, canonical_url, role, trust_prior, enabled,
        restrictions_json, last_success_at, health_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "local-canonical-mts",
        "Local canonical source",
        "https://www.mts.now/",
        "analysis",
        0.5,
        1,
        JSON.stringify({
          discoveryMechanism: "manual",
          sectionEligibility: [],
        }),
        null,
        "unknown",
      )
      .run();

    await applyCanonicalFix();

    expect(
      (await repo.listSources()).find(
        (source) => source.id === "monitoring-the-situation",
      )?.canonicalUrl,
    ).toBe("https://mts.now/");
    expect(
      (await repo.listSources()).find(
        (source) => source.id === "local-canonical-mts",
      )?.canonicalUrl,
    ).toBe("https://www.mts.now/");
  });

  it("upgrades a seeded row with routine health-field changes", async () => {
    const repo = await applyOldMtsDatabase(
      D6F84BD_PAGE_MTS_RESTRICTIONS,
    );
    await env.UPGRADE_DB.prepare(
      `UPDATE sources
       SET last_success_at = ?, health_status = ?
       WHERE id = 'monitoring-the-situation'`,
    )
      .bind("2026-07-29T06:00:00.000Z", "healthy")
      .run();

    await applyCanonicalFix();

    expect(
      (await repo.listSources()).find(
        (source) => source.id === "monitoring-the-situation",
      ),
    ).toMatchObject({
      canonicalUrl: "https://www.mts.now/",
      lastSuccessAt: "2026-07-29T06:00:00.000Z",
      healthStatus: "healthy",
    });
  });

  it("keeps the fresh catalog canonical and collector-usable", async () => {
    const repo = new D1BriefingRepository(env.DB);

    expect(await collectCanonicalMts(repo)).toHaveLength(1);
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
