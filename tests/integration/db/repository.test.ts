import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  EditionEntry,
  Item,
  StructuredSummary,
} from "../../../src/contracts/editorial";
import { D1BriefingRepository } from "../../../src/db/d1-repository";
import { RepositoryValidationError } from "../../../src/db/repository";

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
      deletedDiagnosticLogs: 0,
    });

    const persisted = await env.DB.prepare(
      "SELECT id FROM items ORDER BY id",
    ).all<{ id: string }>();
    expect(persisted.results).toEqual([{ id: "retained" }]);
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
