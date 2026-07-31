import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  EditionEntry,
  Item,
  StructuredSummary,
} from "../../../src/contracts/editorial";
import { EditionMetadataSchema } from "../../../src/contracts/editorial";
import { D1BriefingRepository } from "../../../src/db/d1-repository";
import { RepositoryValidationError } from "../../../src/db/repository";
import { SourceHttpClient } from "../../../src/sources/http-client";
import { createNewsCollectorFromCatalog } from "../../../src/sources/news-collector";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

function fixtureEditionEntry(
  editionId: string,
  id = "entry-1",
): EditionEntry {
  return {
    id,
    editionId,
    itemId: null,
    section: "morning_brief",
    position: 0,
    summary: {
      title: "A useful development",
      oneSentence: "The development improves an important outcome.",
      whyItMatters: "It offers concrete evidence of progress.",
      uncertainty: "The long-term effect remains uncertain.",
      claims: [
        {
          text: "The measured outcome improved.",
          sourceIds: ["source-1"],
          evidenceExcerpt: "The measured outcome improved during the trial.",
        },
      ],
      accessLevel: "full_text",
    },
    selectionReasons: ["High relevance"],
    sourceRefs: [
      {
        id: "source-1",
        name: "Example Source",
        url: "https://example.com/source",
        role: "primary",
        retrievedAt: "2026-07-29T09:00:00.000Z",
      },
    ],
  };
}

function fixtureItem(
  id: string,
  overrides: Partial<Item> = {},
): Item {
  return {
    id,
    kind: "article",
    canonicalUrl: `https://example.com/items/${id}`,
    title: `Promising result ${id}`,
    publishedAt: "2026-07-28T12:00:00.000Z",
    sourceRefs: [
      {
        id: `source-${id}`,
        name: `Source ${id}`,
        url: `https://example.com/sources/${id}`,
        role: "reporting",
        retrievedAt: "2026-07-29T09:00:00.000Z",
      },
    ],
    accessLevel: "full_text",
    primaryTopic: "public health",
    tags: ["health", "progress"],
    normalizedText: "A clinical intervention produced a promising result.",
    metadata: {
      authors: ["Ada Example"],
      institutions: ["Example Institute"],
    },
    createdAt: "2026-07-29T09:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

function fixtureSummary(): StructuredSummary {
  return fixtureEditionEntry("unused").summary;
}

async function publishFixtureEdition(
  repo: D1BriefingRepository,
  editionDate: string,
  runId: string,
  status: "published" | "partial" = "published",
  entries?: readonly EditionEntry[],
) {
  const draft = await repo.createDraftEdition(editionDate, runId);
  await repo.replaceEditionEntries(
    draft.id,
    entries ?? [fixtureEditionEntry(draft.id, `entry-${runId}`)],
  );
  await repo.publishEdition(
    draft.id,
    `${editionDate}T09:45:00.000Z`,
    status,
  );
  return draft;
}

describe("D1BriefingRepository", () => {
  it("atomically reserves monthly model budget and counts reconciled cost instead of maxima", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const createdAt = "2036-02-01T09:00:00.000Z";
    await env.DB.batch(
      ["budget-run-a", "budget-run-b"].map((runId, index) =>
        env.DB.prepare(
          `INSERT INTO workflow_runs (
            id, edition_date, status, current_step, retryable, attempt_count,
            failure_code, estimated_cost_usd, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          runId,
          `2036-02-0${index + 1}`,
          "running",
          "assess",
          0,
          1,
          null,
          0,
          createdAt,
          createdAt,
        ),
      ),
    );

    const attempts = await Promise.all([
      repo.reserveModelBudget({
        reservationId: "reservation-a",
        runId: "budget-run-a",
        monthStart: "2036-02-01T00:00:00.000Z",
        maximumCostMicrousd: 600_000,
        monthlyLimitMicrousd: 1_000_000,
        reservedAt: createdAt,
      }),
      repo.reserveModelBudget({
        reservationId: "reservation-b",
        runId: "budget-run-b",
        monthStart: "2036-02-01T00:00:00.000Z",
        maximumCostMicrousd: 600_000,
        monthlyLimitMicrousd: 1_000_000,
        reservedAt: createdAt,
      }),
    ]);

    const accepted = attempts.filter(
      (reservation): reservation is NonNullable<typeof reservation> =>
        reservation !== null,
    );
    expect(accepted).toHaveLength(1);
    expect(await env.DB.prepare(
      `SELECT COALESCE(SUM(
        CASE
          WHEN status = 'reserved' THEN maximum_cost_microusd
          WHEN status = 'reconciled' THEN actual_cost_microusd
          ELSE 0
        END
      ), 0) AS total
      FROM model_budget_reservations
      WHERE month_start = ?`,
    ).bind("2036-02-01T00:00:00.000Z").first<{ total: number }>())
      .toEqual({ total: 600_000 });

    const first = accepted[0]!;
    const firstRunId = first.id === "reservation-a"
      ? "budget-run-a"
      : "budget-run-b";
    await repo.reconcileModelBudget({
      reservationId: first.id,
      runId: firstRunId,
      actualCostMicrousd: 100_000,
      reconciledAt: "2036-02-01T09:01:00.000Z",
    });
    const secondRunId = firstRunId === "budget-run-a"
      ? "budget-run-b"
      : "budget-run-a";
    const second = await repo.reserveModelBudget({
      reservationId: "reservation-after-reconcile",
      runId: secondRunId,
      monthStart: "2036-02-01T00:00:00.000Z",
      maximumCostMicrousd: 600_000,
      monthlyLimitMicrousd: 1_000_000,
      reservedAt: "2036-02-01T09:02:00.000Z",
    });
    expect(second).toEqual({
      id: "reservation-after-reconcile",
      maximumCostMicrousd: 600_000,
    });
    if (second === null) throw new Error("Expected second reservation");

    await repo.releaseModelBudget({
      reservationId: second.id,
      runId: secondRunId,
      releasedAt: "2036-02-01T09:03:00.000Z",
    });
    expect(await env.DB.prepare(
      `SELECT COALESCE(SUM(
        CASE
          WHEN status = 'reserved' THEN maximum_cost_microusd
          WHEN status = 'reconciled' THEN actual_cost_microusd
          ELSE 0
        END
      ), 0) AS total
      FROM model_budget_reservations
      WHERE month_start = ?`,
    ).bind("2036-02-01T00:00:00.000Z").first<{ total: number }>())
      .toEqual({ total: 100_000 });
  });

  it("accepts only exact legacy or complete bounded edition metadata", () => {
    expect(EditionMetadataSchema.parse({})).toEqual({
      missingSections: [],
      sourceFailures: [],
    });
    expect(EditionMetadataSchema.parse({
      missingSections: ["technology"],
      sourceFailures: ["reuters"],
    })).toEqual({
      missingSections: ["technology"],
      sourceFailures: ["reuters"],
    });

    for (const invalid of [
      { missingSections: ["technology"] },
      {
        missingSections: [],
        sourceFailures: [],
        unexpected: true,
      },
      {
        missingSections: Array.from(
          { length: 33 },
          (_, index) => `missing-${index}`,
        ),
        sourceFailures: [],
      },
    ]) {
      expect(() => EditionMetadataSchema.parse(invalid)).toThrow();
    }
  });

  it("persists only validated edition coverage metadata in published reads", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const draft = await repo.createDraftEdition("2032-01-01", "metadata-run", {
      missingSections: ["technology"],
      sourceFailures: ["reuters"],
    });
    await repo.replaceEditionEntries(
      draft.id,
      [fixtureEditionEntry(draft.id, "metadata-entry")],
    );
    await repo.publishEdition(draft.id, "2032-01-01T09:00:00.000Z", "partial");

    expect(await repo.getEditionByDate("2032-01-01")).toMatchObject({
      metadata: {
        missingSections: ["technology"],
        sourceFailures: ["reuters"],
      },
    });
  });

  it("reads the migration's legacy empty metadata default as a complete safe shape", async () => {
    await env.DB.prepare(
      `INSERT INTO editions (id, edition_date, run_id, status, reading_minutes, published_at, created_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("legacy-metadata", "2032-01-02", "legacy-run", "published", null,
      "2032-01-02T09:00:00.000Z", "2032-01-02T08:00:00.000Z", "{}").run();
    const repo = new D1BriefingRepository(env.DB);
    await expect(repo.getEditionByDate("2032-01-02")).resolves.toMatchObject({
      metadata: { missingSections: [], sourceFailures: [] },
    });
  });
  it("seeds an editable source catalog without overwriting local customization", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const catalog = await repo.listSources();
    const ids = new Set(catalog.map((source) => source.id));

    for (const id of [
      "reuters",
      "associated-press",
      "npr",
      "economist",
      "nist",
      "federal-register",
      "congress-gov",
      "maryland-gov",
      "dc-gov",
      "virginia-gov",
      "wypr",
      "baltimore-banner",
      "baltimore-brew",
      "wtop",
      "maryland-matters",
      "wamu",
      "gdelt",
      "monitoring-the-situation",
      "polymarket",
      "stanford-research",
      "berkeley-research",
      "harvard-research",
      "mit-research",
      "cmu-research",
      "penn-research",
      "johns-hopkins-research",
      "ut-austin-research",
      "georgia-tech-research",
      "google-research",
      "google-deepmind",
      "anthropic",
      "openai",
    ]) {
      expect(ids.has(id), `missing source ${id}`).toBe(true);
    }
    for (const catalogSource of catalog) {
      expect(catalogSource.restrictions).toMatchObject({
        paywall: expect.any(String),
        contentUse: expect.any(String),
        bodyRetrieval: expect.stringMatching(/^(forbidden|permitted)$/),
      });
    }
    expect(() =>
      createNewsCollectorFromCatalog({
        http: new SourceHttpClient({
          fetch: async () => {
            throw new Error("Catalog construction must not use network.");
          },
        }),
        sources: catalog,
      }),
    ).not.toThrow();

    await repo.updateSource("reuters", {
      enabled: false,
      restrictions: {
        paywall: "locally-overridden",
        contentUse: "metadata-only",
        bodyRetrieval: "forbidden",
      },
    });
    const catalogMigration = env.TEST_MIGRATIONS.find(
      (migration) => migration.name === "0002_source_catalog.sql",
    );
    expect(catalogMigration).toBeDefined();
    await applyD1Migrations(
      env.DB,
      catalogMigration === undefined ? [] : [catalogMigration],
      "source_catalog_idempotency",
    );

    expect(
      catalog.find((source) => source.id === "reuters")?.canonicalName,
    ).toBe("Reuters");
    expect(
      (await repo.listSources()).find((source) => source.id === "reuters"),
    ).toMatchObject({
      enabled: false,
      restrictions: {
        paywall: "locally-overridden",
        contentUse: "metadata-only",
        bodyRetrieval: "forbidden",
      },
    });
  });

  it("collects the canonical Monitoring the Situation listing", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const mtsSource = (await repo.listSources()).find(
      (source) => source.id === "monitoring-the-situation",
    );
    if (mtsSource === undefined) {
      throw new TypeError("MTS source is missing from the catalog.");
    }
    const fetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://mts.now/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.mts.now/" },
        });
      }
      if (url === "https://www.mts.now/") {
        return new Response(
          `<!doctype html><html><body>
            <article>
              <h2><a href="/p/secure-model-evaluation">Secure model evaluation roundup</a></h2>
              <time datetime="2026-07-29T07:00:00.000Z">July 29, 2026</time>
              <p>Reporting and primary documents on secure evaluation.</p>
            </article>
          </body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`Unexpected MTS URL: ${url}`);
    };
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-07-29T08:00:00.000Z"),
      }),
      sources: [mtsSource],
    });

    expect(
      (await collector.collect({
        from: "2026-07-28T00:00:00.000Z",
        to: "2026-07-29T12:00:00.000Z",
      })).candidates,
    ).toEqual([
      expect.objectContaining({
        sourceId: "monitoring-the-situation",
        sourceRole: "analysis",
        title: "Secure model evaluation roundup",
        originalUrl:
          "https://www.mts.now/p/secure-model-evaluation",
        accessLevel: "metadata",
        canCorroborateFacts: false,
      }),
    ]);
  });

  it("isolates an unrelated redirect from the configured MTS listing", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const mtsSource = (await repo.listSources()).find(
      (source) => source.id === "monitoring-the-situation",
    );
    if (mtsSource === undefined) {
      throw new TypeError("MTS source is missing from the catalog.");
    }
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "https://attacker.example/copied-listing",
            },
          }),
        maxRetries: 0,
      }),
      sources: [mtsSource],
    });

    await expect(collector.collect({
      from: "2026-07-28T00:00:00.000Z",
      to: "2026-07-29T12:00:00.000Z",
    })).resolves.toEqual({
      candidates: [],
      succeededSourceIds: [],
      failures: [{
        sourceId: "monitoring-the-situation",
        kind: "policy",
      }],
    });
  });

  it("does not expose draft editions and atomically exposes published editions", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const draft = await repo.createDraftEdition("2026-07-29", "run-1");

    expect(await repo.getLatestEdition()).toBeNull();

    await repo.replaceEditionEntries(draft.id, [
      fixtureEditionEntry(draft.id),
    ]);
    await repo.publishEdition(
      draft.id,
      "2026-07-29T09:45:00.000Z",
      "published",
    );

    expect((await repo.getLatestEdition())?.status).toBe("published");
  });

  it("keeps an invalid replacement draft invisible and leaves the prior publication visible", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await publishFixtureEdition(repo, "2026-07-28", "run-prior");
    const draft = await repo.createDraftEdition("2026-07-29", "run-next");
    const duplicate = fixtureEditionEntry(draft.id, "duplicate-entry");

    await expect(
      repo.replaceEditionEntries(draft.id, [duplicate, duplicate]),
    ).rejects.toThrow();

    expect((await repo.getLatestEdition())?.editionDate).toBe("2026-07-28");
    expect(await repo.getEditionByDate("2026-07-29")).toBeNull();
  });

  it("exposes partial editions to readers", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await publishFixtureEdition(
      repo,
      "2026-07-29",
      "run-partial",
      "partial",
    );

    expect((await repo.getLatestEdition())?.status).toBe("partial");
  });

  it("round-trips source restrictions and their repository metadata", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const created = await repo.createSource({
      id: "source-configured",
      canonicalName: "Configured Source",
      canonicalUrl: "https://example.com/configured",
      role: "primary",
      trustPrior: 0.8,
      enabled: true,
      restrictions: {
        robotsPolicy: "respect",
        nested: { maximumRequests: 2 },
      },
      discoveryMechanism: "rss",
      sectionEligibility: ["research", "technology"],
    });

    expect(created).toEqual({
      id: "source-configured",
      canonicalName: "Configured Source",
      canonicalUrl: "https://example.com/configured",
      role: "primary",
      trustPrior: 0.8,
      enabled: true,
      restrictions: {
        robotsPolicy: "respect",
        nested: { maximumRequests: 2 },
      },
      discoveryMechanism: "rss",
      sectionEligibility: ["research", "technology"],
      lastSuccessAt: null,
      healthStatus: "unknown",
    });

    const updated = await repo.updateSource("source-configured", {
      trustPrior: 0.65,
      enabled: false,
      restrictions: { robotsPolicy: "metadata-only" },
      discoveryMechanism: "api",
      sectionEligibility: ["morning_brief"],
    });

    expect(updated.trustPrior).toBe(0.65);
    expect(updated.enabled).toBe(false);
    expect(updated.restrictions).toEqual({
      robotsPolicy: "metadata-only",
    });
    expect(updated.discoveryMechanism).toBe("api");
    expect(updated.sectionEligibility).toEqual(["morning_brief"]);
    expect(
      (await repo.listSources()).find(
        (catalogSource) => catalogSource.id === updated.id,
      ),
    ).toEqual(updated);
  });

  it("rejects malformed stored source booleans instead of normalizing them", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
    try {
      await env.DB.prepare(
        `INSERT INTO sources (
          id, canonical_name, canonical_url, role, trust_prior, enabled,
          restrictions_json, health_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          "source-invalid-boolean",
          "Invalid Boolean Source",
          "https://example.com/invalid-boolean",
          "primary",
          0.5,
          2,
          '{"discoveryMechanism":"manual","sectionEligibility":[]}',
          "unknown",
        )
        .run();
    } finally {
      await env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
    }

    await expect(repo.listSources()).rejects.toBeInstanceOf(
      RepositoryValidationError,
    );
  });

  it("records healthy, degraded, and failing source outcomes without losing the last success", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const firstSuccess = "2026-07-29T08:00:00.000Z";

    await repo.recordSourceOutcome("reuters", "success", firstSuccess);
    expect(
      (await repo.listSources()).find(({ id }) => id === "reuters"),
    ).toMatchObject({
      healthStatus: "healthy",
      lastSuccessAt: firstSuccess,
    });

    await repo.recordSourceOutcome(
      "reuters",
      "fetch",
      "2026-07-29T09:00:00.000Z",
    );
    expect(
      (await repo.listSources()).find(({ id }) => id === "reuters"),
    ).toMatchObject({
      healthStatus: "degraded",
      lastSuccessAt: firstSuccess,
    });

    await repo.recordSourceOutcome(
      "reuters",
      "policy",
      "2026-07-29T10:00:00.000Z",
    );
    expect(
      (await repo.listSources()).find(({ id }) => id === "reuters"),
    ).toMatchObject({
      healthStatus: "failing",
      lastSuccessAt: firstSuccess,
    });
  });

  it("rejects source outcomes for unknown catalog sources", async () => {
    const repo = new D1BriefingRepository(env.DB);

    await expect(
      repo.recordSourceOutcome(
        "not-in-catalog",
        "success",
        "2026-07-29T08:00:00.000Z",
      ),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
  });

  it("rejects non-JSON source restrictions with typed validation errors", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolKeyed: Record<string, unknown> = {};
    Object.defineProperty(symbolKeyed, Symbol("not JSON"), {
      value: "not JSON",
      enumerable: true,
    });
    const invalidRestrictions: readonly Record<string, unknown>[] = [
      { value: 1n },
      { value: undefined },
      { value: () => "not JSON" },
      { value: Symbol("not JSON") },
      symbolKeyed,
      { value: cyclic },
      { value: new Date("2026-07-29T09:00:00.000Z") },
    ];

    for (const [index, restrictions] of invalidRestrictions.entries()) {
      await expect(
        repo.createSource({
          id: `source-invalid-json-${index}`,
          canonicalName: `Invalid JSON Source ${index}`,
          canonicalUrl: `https://example.com/invalid-json/${index}`,
          role: "primary",
          trustPrior: 0.5,
          enabled: true,
          restrictions,
          discoveryMechanism: "manual",
          sectionEligibility: [],
        }),
      ).rejects.toBeInstanceOf(RepositoryValidationError);
    }
  });

  it("rejects non-JSON item metadata with a typed validation error", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const item = fixtureItem("invalid-metadata", {
      metadata: {
        nested: {
          droppedByJsonStringify: undefined,
        },
      },
    });

    await expect(repo.upsertItems([item])).rejects.toBeInstanceOf(
      RepositoryValidationError,
    );
  });

  it("preserves valid nested source restrictions and item metadata exactly", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const restrictions = {
      policy: {
        paths: ["/papers", "/reports"],
        budget: 3,
        enabled: true,
        note: null,
      },
    };
    const metadata = {
      authors: ["Ada Example"],
      institutions: ["Example Institute"],
      metrics: {
        effectSizes: [0.1, 0.25],
        peerReviewed: true,
        note: null,
      },
      reservedKeyObject: JSON.parse(
        '{"__proto__":{"preserved":true},"constructor":"literal"}',
      ),
    };

    const source = await repo.createSource({
      id: "source-nested-json",
      canonicalName: "Nested JSON Source",
      canonicalUrl: "https://example.com/nested-json",
      role: "primary",
      trustPrior: 0.75,
      enabled: true,
      restrictions,
      discoveryMechanism: "api",
      sectionEligibility: ["research"],
    });
    await repo.upsertItems([
      fixtureItem("nested-json-item", { metadata }),
    ]);

    expect(source.restrictions).toEqual(restrictions);
    const row = await env.DB.prepare(
      "SELECT normalized_json FROM items WHERE id = ?",
    )
      .bind("nested-json-item")
      .first<{ normalized_json: string }>();
    expect(JSON.parse(row?.normalized_json ?? "{}").metadata).toEqual(
      metadata,
    );
  });

  it("persists complete provenance without rewriting catalog source URLs", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const cases = [
      {
        name: "one article discovered through multiple catalog sources",
        item: fixtureItem("multi-catalog-source", {
          canonicalUrl:
            "https://www.reuters.com/world/shared-development",
          sourceRefs: [
            {
              id: "reuters",
              name: "Reuters",
              url: "https://www.reuters.com/world/shared-development",
              role: "reporting" as const,
              retrievedAt: "2026-07-29T09:00:00.000Z",
            },
            {
              id: "gdelt",
              name: "GDELT",
              url: "https://www.reuters.com/world/shared-development",
              role: "analysis" as const,
              retrievedAt: "2026-07-29T09:01:00.000Z",
            },
          ],
        }),
        expectedItemSources: [
          {
            source_id: "gdelt",
            source_name: "GDELT",
            source_url:
              "https://www.reuters.com/world/shared-development",
            role: "analysis",
            retrieved_at: "2026-07-29T09:01:00.000Z",
          },
          {
            source_id: "reuters",
            source_name: "Reuters",
            source_url:
              "https://www.reuters.com/world/shared-development",
            role: "reporting",
            retrieved_at: "2026-07-29T09:00:00.000Z",
          },
        ],
      },
      {
        name: "repeated source ID with multiple retained URLs",
        item: fixtureItem("repeated-source-id", {
          canonicalUrl:
            "https://www.reuters.com/world/repeated-discovery",
          sourceRefs: [
            {
              id: "reuters",
              name: "Reuters",
              url:
                "https://www.reuters.com/world/repeated-discovery?view=z",
              role: "reporting" as const,
              retrievedAt: "2026-07-29T09:05:00.000Z",
            },
            {
              id: "reuters",
              name: "Reuters",
              url:
                "https://www.reuters.com/world/repeated-discovery?view=a",
              role: "reporting" as const,
              retrievedAt: "2026-07-29T09:00:00.000Z",
            },
          ],
        }),
        expectedItemSources: [
          {
            source_id: "reuters",
            source_name: "Reuters",
            source_url:
              "https://www.reuters.com/world/repeated-discovery?view=a",
            role: "reporting",
            retrieved_at: "2026-07-29T09:00:00.000Z",
          },
        ],
      },
    ] as const;

    for (const testCase of cases) {
      await expect(
        repo.upsertItems([testCase.item]),
        testCase.name,
      ).resolves.toBeUndefined();

      const itemSources = await env.DB.prepare(
        `SELECT source_id, source_name, source_url, role, retrieved_at
         FROM item_sources
         WHERE item_id = ?
         ORDER BY source_id`,
      )
        .bind(testCase.item.id)
        .all();
      expect(itemSources.results, testCase.name).toEqual(
        testCase.expectedItemSources,
      );

      const itemRow = await env.DB.prepare(
        "SELECT normalized_json FROM items WHERE id = ?",
      )
        .bind(testCase.item.id)
        .first<{ normalized_json: string }>();
      expect(
        JSON.parse(itemRow?.normalized_json ?? "null").sourceRefs,
        testCase.name,
      ).toEqual(testCase.item.sourceRefs);
    }

    const catalogUrls = await env.DB.prepare(
      `SELECT id, canonical_url
       FROM sources
       WHERE id IN ('gdelt', 'reuters')
       ORDER BY id`,
    ).all();
    expect(catalogUrls.results).toEqual([
      {
        id: "gdelt",
        canonical_url: "https://www.gdeltproject.org/",
      },
      {
        id: "reuters",
        canonical_url: "https://www.reuters.com/",
      },
    ]);
  });

  it("persists feedback history without inferring preference weights", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await repo.upsertItems([fixtureItem("feedback-item")]);

    await repo.recordFeedback({
      itemId: "feedback-item",
      action: "more_like_this",
      reason: "topic",
    });
    await repo.recordFeedback({
      itemId: "feedback-item",
      action: "save",
      reason: null,
    });

    const preferences = await repo.getPreferences();
    expect(preferences.topicWeights).toEqual({});
    expect(preferences.sourceWeights).toEqual({});
    expect(preferences.institutionWeights).toEqual({});
    expect(preferences.sectionBudgets).toEqual({});
    expect(
      preferences.feedbackHistory.map(({ itemId, action, reason }) => ({
        itemId,
        action,
        reason,
      })),
    ).toEqual([
      {
        itemId: "feedback-item",
        action: "more_like_this",
        reason: "topic",
      },
      {
        itemId: "feedback-item",
        action: "save",
        reason: null,
      },
    ]);
  });

  it("prunes expired candidates while preserving items in published editions", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const retained = fixtureItem("retained", {
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
    const discarded = fixtureItem("discarded", {
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
    await repo.upsertItems([retained, discarded]);

    const draft = await repo.createDraftEdition("2026-07-29", "run-retention");
    await repo.replaceEditionEntries(draft.id, [
      {
        ...fixtureEditionEntry(draft.id),
        itemId: retained.id,
      },
    ]);
    await repo.publishEdition(
      draft.id,
      "2026-07-29T09:45:00.000Z",
      "published",
    );

    expect(await repo.pruneExpiredData("2026-07-29T10:00:00.000Z")).toEqual({
      deletedUnselectedCandidates: 1,
      deletedWorkflowRuns: 0,
      deletedWorkflowArtifacts: 0,
      deletedDiagnosticLogs: 0,
    });

    const persisted = await env.DB.prepare(
      "SELECT id FROM items ORDER BY id",
    ).all<{ id: string }>();
    expect(persisted.results).toEqual([{ id: "retained" }]);
  });

  it("preserves expired saved and summarized items and records a retention audit", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const saved = fixtureItem("saved-retention", {
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
    const summarized = fixtureItem("summary-retention", {
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
    const discarded = fixtureItem("discard-retention", {
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
    await repo.upsertItems([saved, summarized, discarded]);
    await repo.recordFeedback({ itemId: saved.id, action: "save", reason: null });
    await repo.saveSummary(summarized.id, fixtureSummary());

    const report = await repo.pruneExpiredData("2026-07-29T10:00:00.000Z");
    await repo.recordRetentionAudit("2026-07-29T10:00:00.000Z", report);
    expect(report.deletedUnselectedCandidates).toBe(1);
    expect((await env.DB.prepare("SELECT id FROM items ORDER BY id").all<{ id: string }>()).results)
      .toEqual([{ id: saved.id }, { id: summarized.id }]);
    expect(await env.DB.prepare(
      "SELECT event_json FROM audit_events WHERE event_type = ?",
    ).bind("retention_pruned").first<{ event_json: string }>()).toEqual({
      event_json: JSON.stringify(report),
    });
  });

  it("expires workflow artifacts after 90 days while preserving durable audit and monthly usage history", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workflow_runs (
          id, edition_date, status, current_step, retryable, attempt_count,
          failure_code, estimated_cost_usd, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "old-artifact-run", "2026-04-01", "failed", "synthesize", 0, 1,
        "OLD_FAILURE", 0, "2026-04-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "old-checkpoint", "old-artifact-run", "workflow_checkpoint",
        JSON.stringify({
          step: "collect",
          artifact: {
            itemCount: 1,
            payload: "full private checkpoint payload",
          },
        }),
        "2026-04-01T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "old-attempt", "old-artifact-run", "workflow_attempt",
        "{\"step\":\"collect\",\"attempt\":1}",
        "2026-04-01T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "old-attempt-failed", "old-artifact-run", "workflow_attempt_failed",
        "{\"step\":\"collect\",\"attempt\":1,\"error\":\"SOURCE_TIMEOUT\"}",
        "2026-04-01T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "old-preference-snapshot", "old-artifact-run", "preference_snapshot",
        "{}", "2026-04-01T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "old-orphan-checkpoint", null, "workflow_checkpoint",
        "{\"step\":\"collect\",\"artifact\":{\"payload\":\"orphaned private payload\"}}",
        "2026-04-01T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "recent-checkpoint", null, "workflow_checkpoint",
        "{\"step\":\"collect\",\"artifact\":{\"payload\":\"recent\"}}",
        "2026-07-01T00:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("old-diagnostic", null, "diagnostic_log", "{}", "2026-05-01T00:00:00.000Z"),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("old-audit", null, "source_updated", "{}", "2026-05-01T00:00:00.000Z"),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "old-model-usage",
        null,
        "model_usage",
        JSON.stringify({
          provider: "openai",
          model: "gpt-test",
          inputTokens: 10,
          outputTokens: 2,
          embeddingCount: 0,
          unitPriceUsd: 0.001,
          estimatedCostUsd: 0.012,
        }),
        "2026-05-01T00:00:00.000Z",
      ),
    ]);

    const report = await repo.pruneExpiredData("2026-07-29T10:00:00.000Z");
    expect(report).toEqual({
      deletedUnselectedCandidates: 0,
      deletedWorkflowRuns: 1,
      deletedWorkflowArtifacts: 5,
      deletedDiagnosticLogs: 1,
    });
    await repo.recordRetentionAudit("2026-07-29T10:00:00.000Z", report);
    expect((await env.DB.prepare(
      "SELECT id, event_type FROM audit_events WHERE event_type <> ? ORDER BY id",
    ).bind(
      "retention_pruned",
    ).all<{ id: string; event_type: string }>()).results).toEqual([
      { id: "old-audit", event_type: "source_updated" },
      { id: "old-model-usage", event_type: "model_usage" },
      { id: "recent-checkpoint", event_type: "workflow_checkpoint" },
    ]);
    expect(await env.DB.prepare(
      "SELECT event_json FROM audit_events WHERE event_type = ?",
    ).bind("retention_pruned").first<{ event_json: string }>()).toEqual({
      event_json: JSON.stringify(report),
    });
  });

  it("persists item scores and summaries and searches the archive through FTS", async () => {
    const repo = new D1BriefingRepository(env.DB);
    const item = fixtureItem("searchable");
    await repo.upsertItems([item]);
    await repo.saveScores([
      {
        itemId: item.id,
        topicalFit: 0.9,
        technicalQuality: 0.8,
        researchSignal: 0.7,
        novelty: 0.6,
        seriousAttention: 0.85,
        total: 0.81,
        selectionReasons: ["Strong evidence"],
      },
    ]);
    await repo.saveSummary(item.id, fixtureSummary());

    const draft = await repo.createDraftEdition("2026-07-29", "run-search");
    await repo.replaceEditionEntries(draft.id, [
      {
        ...fixtureEditionEntry(draft.id),
        itemId: item.id,
        section: "research",
      },
    ]);
    await repo.publishEdition(
      draft.id,
      "2026-07-29T09:45:00.000Z",
      "published",
    );

    const page = await repo.searchArchive({
      query: "clinical",
      topic: "public health",
      author: "Ada Example",
      institution: "Example Institute",
      source: "Source searchable",
      section: "research",
      limit: 10,
      cursor: null,
    });
    expect(page.items.map((entry) => entry.itemId)).toEqual(["searchable"]);
    expect(page.nextCursor).toBeNull();
  });

  it("uses opaque cursors for edition pagination and rejects malformed cursors", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await publishFixtureEdition(repo, "2026-07-28", "run-page-1");
    await publishFixtureEdition(repo, "2026-07-29", "run-page-2");

    const first = await repo.listEditions({ limit: 1, cursor: null });
    expect(first.items.map((edition) => edition.editionDate)).toEqual([
      "2026-07-29",
    ]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await repo.listEditions({
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((edition) => edition.editionDate)).toEqual([
      "2026-07-28",
    ]);
    expect(second.nextCursor).toBeNull();

    await expect(
      repo.listEditions({ limit: 1, cursor: "not-a-valid-cursor" }),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
  });

  it("returns validated workflow runs", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "run-validated",
        "2026-07-29",
        "retryable",
        "summarize",
        1,
        2,
        "MODEL_TIMEOUT",
        0.42,
        "2026-07-29T09:00:00.000Z",
        "2026-07-29T09:30:00.000Z",
      )
      .run();

    expect(await repo.getWorkflowRun("run-validated")).toEqual({
      id: "run-validated",
      editionDate: "2026-07-29",
      status: "retryable",
      currentStep: "summarize",
      retryable: true,
      attemptCount: 2,
      failureCode: "MODEL_TIMEOUT",
      estimatedCostUsd: 0.42,
      createdAt: "2026-07-29T09:00:00.000Z",
      updatedAt: "2026-07-29T09:30:00.000Z",
    });
  });

  it("rejects malformed stored workflow booleans instead of normalizing them", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
    try {
      await env.DB.prepare(
        `INSERT INTO workflow_runs (
          id, edition_date, status, retryable, attempt_count,
          estimated_cost_usd, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          "run-invalid-boolean",
          "2026-07-29",
          "running",
          -1,
          1,
          0,
          "2026-07-29T09:00:00.000Z",
          "2026-07-29T09:00:00.000Z",
        )
        .run();
    } finally {
      await env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
    }

    await expect(
      repo.getWorkflowRun("run-invalid-boolean"),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
  });
});
