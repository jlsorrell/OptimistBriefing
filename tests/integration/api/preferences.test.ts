import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../src/api/app";
import type { EditionEntry, Item } from "../../../src/contracts/editorial";
import { READER_PROFILE } from "../../../src/config/reader-profile";
import { D1BriefingRepository } from "../../../src/db/d1-repository";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const authenticated = {
  "CF-Access-Jwt-Assertion": "signed-token",
  "content-type": "application/json",
};

function app() {
  return createApp({
    repository: new D1BriefingRepository(env.DB),
    authVerifier: async () => ({ email: "reader@example.com" }),
    workflow: null,
  });
}

function fixtureItem(id: string): Item {
  return {
    id,
    kind: "paper",
    canonicalUrl: `https://example.com/${id}`,
    title: `Archive ${id}`,
    publishedAt: "2034-01-02T12:00:00.000Z",
    sourceRefs: [
      {
        id: `source-${id}`,
        name: `Source ${id}`,
        url: `https://example.com/sources/${id}`,
        role: "primary",
        retrievedAt: "2034-01-03T08:00:00.000Z",
      },
    ],
    accessLevel: "abstract",
    primaryTopic: "alignment-interpretability",
    tags: ["alignment"],
    normalizedText: `A searchable summary about ${id} and evaluation.`,
    metadata: {
      authors: ["Ada Example"],
      institutions: ["Example Institute"],
    },
    createdAt: "2034-01-03T08:00:00.000Z",
    expiresAt: null,
  };
}

function fixtureEntry(
  editionId: string,
  item: Item,
  position: number,
): EditionEntry {
  return {
    id: `entry-${item.id}`,
    editionId,
    itemId: item.id,
    section: "research",
    position,
    summary: {
      title: item.title,
      oneSentence: item.normalizedText,
      whyItMatters: "It improves evaluation practice.",
      uncertainty: "The evidence is preliminary.",
      claims: [
        {
          text: "The work reports a measurable result.",
          sourceIds: [item.sourceRefs[0]!.id],
          evidenceExcerpt: "A measurable result was reported.",
        },
      ],
      accessLevel: "abstract",
    },
    selectionReasons: ["Relevant to alignment research"],
    sourceRefs: item.sourceRefs,
  };
}

async function publishArchiveFixtures(prefix: string) {
  const repository = new D1BriefingRepository(env.DB);
  const items = [fixtureItem(`${prefix}-one`), fixtureItem(`${prefix}-two`)];
  await repository.upsertItems(items);
  const draft = await repository.createDraftEdition(
    "2034-01-03",
    `run-${prefix}`,
  );
  await repository.replaceEditionEntries(
    draft.id,
    items.map((item, index) => fixtureEntry(draft.id, item, index)),
  );
  await repository.publishEdition(
    draft.id,
    "2034-01-03T09:45:00.000Z",
    "published",
  );
  return { repository, items };
}

describe("reader controls API", () => {
  it.each([
    ["POST", "/api/feedback"],
    ["GET", "/api/preferences"],
    ["PUT", "/api/preferences"],
    ["POST", "/api/preferences/reset"],
    ["GET", "/api/archive"],
    ["GET", "/api/runs"],
    ["GET", "/api/runs/run-private"],
    ["GET", "/api/sources"],
    ["POST", "/api/sources"],
    ["PUT", "/api/sources/source-private"],
  ])("requires the allowed authenticated user for %s %s", async (method, path) => {
    const response = await app().request(path, { method });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  it("rejects unknown feedback actions and reasons without writing", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback",
    ).first<{ count: number }>();
    for (const body of [
      { itemId: "missing", action: "view", reason: null },
      { itemId: "missing", action: "less_like_this", reason: "boring" },
      { itemId: "", action: "save", reason: null },
    ]) {
      const response = await app().request("/api/feedback", {
        method: "POST",
        headers: authenticated,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
    }
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback",
    ).first<{ count: number }>();
    expect(after).toEqual(before);
  });

  it("stores the raw less-like-this action, reason, and resulting explicit delta", async () => {
    const repository = new D1BriefingRepository(env.DB);
    const item = fixtureItem("feedback-delta");
    await repository.upsertItems([item]);

    const response = await app().request("/api/feedback", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({
        itemId: item.id,
        action: "less_like_this",
        reason: "too_incremental",
      }),
    });

    expect(response.status).toBe(201);
    const preferences = await repository.getPreferences();
    expect(preferences.feedbackHistory.at(-1)).toMatchObject({
      itemId: item.id,
      action: "less_like_this",
      reason: "too_incremental",
      adjustments: [
        {
          dimension: "topic",
          key: "alignment-interpretability",
          delta: -0.1,
          resultingWeight: 0.9,
        },
      ],
    });
    expect(preferences.topicWeights).toEqual({});
    expect(preferences.baseline.topicWeights["alignment-interpretability"]).toBe(1);
  });

  it("persists saves and unsaves while passive archive and preference reads do not mutate", async () => {
    const { items } = await publishArchiveFixtures("saved-passive");
    const saved = await app().request("/api/feedback", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({
        itemId: items[0]!.id,
        action: "save",
        reason: null,
      }),
    });
    expect(saved.status).toBe(201);

    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback",
    ).first<{ count: number }>();
    const savedArchive = await app().request("/api/archive?saved=true", {
      headers: authenticated,
    });
    expect(savedArchive.status).toBe(200);
    await expect(savedArchive.json()).resolves.toMatchObject({
      items: [{ itemId: items[0]!.id }],
      nextCursor: null,
    });
    await app().request("/api/preferences", { headers: authenticated });
    await app().request("/api/archive?q=searchable", { headers: authenticated });
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback",
    ).first<{ count: number }>();
    expect(after).toEqual(before);

    const unsaved = await app().request("/api/feedback", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({
        itemId: items[0]!.id,
        action: "unsave",
        reason: null,
      }),
    });
    expect(unsaved.status).toBe(201);
    const empty = await app().request("/api/archive?saved=true", {
      headers: authenticated,
    });
    await expect(empty.json()).resolves.toMatchObject({ items: [] });
  });

  it("updates explicit preferences, removes feedback adjustments, and resets the exact baseline", async () => {
    const repository = new D1BriefingRepository(env.DB);
    const item = fixtureItem("preference-reset");
    await repository.upsertItems([item]);
    await app().request("/api/feedback", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({
        itemId: item.id,
        action: "more_like_this",
        reason: "topic",
      }),
    });
    const adjustmentId = (await repository.getPreferences()).feedbackHistory.at(-1)!.id;

    const updated = await app().request("/api/preferences", {
      method: "PUT",
      headers: authenticated,
      body: JSON.stringify({
        topicWeights: { custom: 0.7 },
        sourceWeights: {},
        institutionWeights: {},
        sectionBudgets: { world: 3 },
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      topicWeights: { custom: 0.7 },
      sectionBudgets: { world: 3 },
    });

    const removed = await app().request("/api/preferences", {
      method: "PUT",
      headers: authenticated,
      body: JSON.stringify({ removeFeedbackId: adjustmentId }),
    });
    expect(removed.status).toBe(200);
    expect(
      ((await removed.json()) as { feedbackHistory: unknown[] }).feedbackHistory,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: adjustmentId })]),
    );

    const reset = await app().request("/api/preferences/reset", {
      method: "POST",
      headers: authenticated,
    });
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toMatchObject({
      baseline: {
        topicWeights: Object.fromEntries(
          READER_PROFILE.researchTopics.map((topic) => [topic.id, 1]),
        ),
        sectionBudgets: {
          morning_brief: READER_PROFILE.sectionBudgets.morningBrief,
          research: READER_PROFILE.sectionBudgets.featuredResearch,
          research_radar: READER_PROFILE.sectionBudgets.researchRadar,
          world: READER_PROFILE.sectionBudgets.world,
          technology: READER_PROFILE.sectionBudgets.technology,
          ai_policy: READER_PROFILE.sectionBudgets.aiPolicy,
          dmv: READER_PROFILE.sectionBudgets.dmvAndBaltimore,
          baltimore: READER_PROFILE.sectionBudgets.dmvAndBaltimore,
          forecast: READER_PROFILE.sectionBudgets.forecastSignals,
        },
      },
      feedbackHistory: [],
    });
  });

  it("validates all archive filters and advances an opaque cursor", async () => {
    const { items } = await publishArchiveFixtures("archive-filter");
    const first = await app().request(
      "/api/archive?q=searchable&topic=alignment-interpretability&author=Ada&institution=Example&source=Source&section=research&limit=1",
      { headers: authenticated },
    );
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: Array<{ itemId: string | null }>;
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await app().request(
      `/api/archive?topic=alignment-interpretability&limit=1&cursor=${page.nextCursor}`,
      { headers: authenticated },
    );
    expect(second.status).toBe(200);
    expect((await second.json()) as unknown).toMatchObject({
      items: [{ itemId: items[1]!.id }],
      nextCursor: null,
    });

    for (const query of [
      "limit=0",
      "limit=51",
      "section=unknown",
      "cursor=not-a-cursor",
      "saved=maybe",
    ]) {
      const invalid = await app().request(`/api/archive?${query}`, {
        headers: authenticated,
      });
      expect(invalid.status).toBe(422);
    }

  });

  it("requires strict canonical HTTPS source input, reports duplicate URLs, and audits updates", async () => {
    const source = {
      id: "task-10-source",
      canonicalName: "Task 10 Source",
      canonicalUrl: "https://task-10.example/",
      role: "reporting",
      trustPrior: 0.8,
      enabled: true,
      restrictions: { paywall: "none", bodyRetrieval: "permitted" },
      discoveryMechanism: "rss",
      sectionEligibility: ["world"],
    };
    for (const invalid of [
      { ...source, id: "http-source", canonicalUrl: "http://task-10.example/" },
      { ...source, id: "loose-source", unexpected: true },
      { ...source, id: "bad-trust", trustPrior: 1.1 },
      { ...source, id: "no-sections", sectionEligibility: [] },
    ]) {
      const response = await app().request("/api/sources", {
        method: "POST",
        headers: authenticated,
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(422);
    }

    const created = await app().request("/api/sources", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify(source),
    });
    expect(created.status).toBe(201);

    const duplicate = await app().request("/api/sources", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({ ...source, id: "task-10-source-duplicate" }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: "SOURCE_ALREADY_EXISTS" },
    });

    const updated = await app().request(`/api/sources/${source.id}`, {
      method: "PUT",
      headers: authenticated,
      body: JSON.stringify({ enabled: false }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ enabled: false });
    const audit = await env.DB.prepare(
      "SELECT event_json FROM audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1",
    ).bind("source_updated").first<{ event_json: string }>();
    expect(JSON.parse(audit!.event_json)).toMatchObject({
      sourceId: source.id,
      actorEmail: "reader@example.com",
      changes: { enabled: false },
    });
  });

  it("does not apply a source update when its required audit event cannot be stored", async () => {
    const repository = new D1BriefingRepository(env.DB);
    await repository.createSource({
      id: "task-10-atomic-source",
      canonicalName: "Task 10 Atomic Source",
      canonicalUrl: "https://atomic-task-10.example/",
      role: "reporting",
      trustPrior: 0.7,
      enabled: true,
      restrictions: { paywall: "none" },
      discoveryMechanism: "rss",
      sectionEligibility: ["world"],
    });
    await env.DB.prepare(
      `CREATE TRIGGER task_10_fail_source_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'source_updated'
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END`,
    ).run();
    try {
      const response = await app().request(
        "/api/sources/task-10-atomic-source",
        {
          method: "PUT",
          headers: authenticated,
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(response.status).toBe(500);
      expect(
        (await repository.listSources()).find(
          (source) => source.id === "task-10-atomic-source",
        )?.enabled,
      ).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER task_10_fail_source_audit").run();
    }
  });

  it("lists run checkpoints, attempts, failures, rejections, publish time, and monthly cost without packets or secrets", async () => {
    const runId = "task-10-private-run";
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      "2034-02-01",
      "published",
      "publish",
      0,
      2,
      "apiKey=must-not-leak",
      1.25,
      "2034-02-01T08:00:00.000Z",
      "2034-02-01T09:45:00.000Z",
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "task-10-checkpoint",
        runId,
        "workflow_checkpoint",
        JSON.stringify({
          step: "validate",
          artifact: {
            output: [
              {
                valid: false,
                validationErrors: ["unsupported_claim"],
                privatePacket: "must-not-leak",
                secret: "must-not-leak",
              },
            ],
            attempts: 2,
            durationMs: 42,
            itemCount: 1,
            estimatedCostUsd: 0.5,
          },
        }),
        "2034-02-01T09:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "task-10-attempt-failed",
        runId,
        "workflow_attempt_failed",
        JSON.stringify({
          step: "validate",
          attempt: 1,
          error: "MODEL_TIMEOUT apiKey=must-not-leak",
          apiKey: "must-not-leak",
        }),
        "2034-02-01T08:59:00.000Z",
      ),
      env.DB.prepare(
        `INSERT INTO editions (
          id, edition_date, run_id, status, reading_minutes, published_at,
          created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "task-10-run-edition",
        "2034-02-01",
        runId,
        "published",
        20,
        "2034-02-01T09:45:00.000Z",
        "2034-02-01T08:00:00.000Z",
        JSON.stringify({
          missingSections: [],
          sourceFailures: ["reuters"],
        }),
      ),
    ]);

    const list = await app().request("/api/runs", { headers: authenticated });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: runId })]),
    );

    const response = await app().request(`/api/runs/${runId}`, {
      headers: authenticated,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("must-not-leak");
    expect(text).not.toContain("privatePacket");
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toMatchObject({
      id: runId,
      checkpoints: [
        {
          step: "validate",
          state: "completed",
          attempts: 2,
          itemCount: 1,
        },
      ],
      failures: [
        { step: "validate", attempt: 1, reason: "REDACTED_FAILURE" },
      ],
      failureCode: "REDACTED_FAILURE",
      sourceFailures: ["reuters"],
      rejectedSummaryReasons: ["unsupported_claim"],
      publishedAt: "2034-02-01T09:45:00.000Z",
      estimatedMonthlyCostUsd: 1.25,
    });
  });
});
