import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../../src/api/app";
import { ApiErrorSchema } from "../../../src/contracts/api";
import type { EditionEntry, Item } from "../../../src/contracts/editorial";
import { READER_PROFILE } from "../../../src/config/reader-profile";
import { D1BriefingRepository } from "../../../src/db/d1-repository";
import { coordinateScheduledBriefing } from "../../../src/workflow/schedule";
import worker, { type Env } from "../../../src/worker";

const inlineLauncherCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock(
  "../../../src/workflow/run-editorial-pipeline",
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import("../../../src/workflow/run-editorial-pipeline")
    >();
    return {
      ...original,
      createD1WorkflowLauncher: () => ({
        start: async ({ editionDate }: { editionDate: string }) => {
          inlineLauncherCalls.count += 1;
          return { runId: editionDate };
        },
        resume: async () => {
          inlineLauncherCalls.count += 1;
        },
      }),
    };
  },
);

vi.mock("../../../src/auth/access", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../../src/auth/access")
  >();
  return {
    ...original,
    createAccessVerifier: () => async () => ({
      email: "  READER@EXAMPLE.COM  ",
    }),
  };
});

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const authenticated = {
  "CF-Access-Jwt-Assertion": "signed-token",
  "content-type": "application/json",
};

type WorkflowCreateInput = Parameters<
  Env["DAILY_BRIEFING"]["create"]
>[0];

class RecordingWorkflow {
  readonly created: WorkflowCreateInput[] = [];
  readonly instances = new Map<string, {
    status(): Promise<{ status: string }>;
    restart(): Promise<void>;
    resume(): Promise<void>;
  }>();

  constructor(
    private readonly afterCreate?: () => Promise<void>,
  ) {}

  async create(input: WorkflowCreateInput) {
    if (input?.id === undefined) throw new Error("Workflow ID is required.");
    if (this.instances.has(input.id)) {
      throw new Error("Workflow instance ID is already used.");
    }
    const instance = {
      status: async () => ({ status: "queued" }),
      restart: async () => undefined,
      resume: async () => undefined,
    };
    this.instances.set(input.id, instance);
    this.created.push(structuredClone(input));
    await this.afterCreate?.();
    return instance;
  }

  async get(id: string) {
    const instance = this.instances.get(id);
    if (instance === undefined) throw new Error("Workflow instance not found.");
    return instance;
  }
}

function workerEnv(workflow: object): Env {
  return {
    DB: env.DB,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "briefing.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "briefing-audience",
    ALLOWED_EMAILS: "reader@example.com",
    OPENAI_API_KEY: "unused",
    SUMMARY_MODEL: "unused-summary",
    ASSESSMENT_MODEL: "unused-assessment",
    EMBEDDING_MODEL: "unused-embedding",
    MONTHLY_BUDGET_USD: "10",
    SUMMARY_UNIT_PRICE_USD: "0.001",
    ASSESSMENT_UNIT_PRICE_USD: "0.001",
    EMBEDDING_UNIT_PRICE_USD: "0.001",
    DAILY_BRIEFING: workflow as Env["DAILY_BRIEFING"],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function manualStartRequest(editionDate: string): Request {
  return new Request("https://briefing.example/api/admin/runs", {
    method: "POST",
    headers: authenticated,
    body: JSON.stringify({ editionDate }),
  });
}

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
  it("dispatches a manual start to the durable Workflow without provider work in fetch", async () => {
    inlineLauncherCalls.count = 0;
    const workflow = new RecordingWorkflow();

    const response = await worker.fetch(
      manualStartRequest("2026-07-30"),
      workerEnv(workflow),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ runId: "2026-07-30" });
    expect(workflow.created).toEqual([{
      id: "2026-07-30",
      params: { editionDate: "2026-07-30", runId: "2026-07-30" },
      retention: { successRetention: "90 days", errorRetention: "90 days" },
    }]);
    expect(inlineLauncherCalls.count).toBe(0);
    await expect(
      new D1BriefingRepository(env.DB).getWorkflowRun("2026-07-30"),
    ).resolves.toMatchObject({
      id: "2026-07-30",
      editionDate: "2026-07-30",
      status: "pending",
    });
    const audit = await env.DB.prepare(
      "SELECT event_json FROM audit_events WHERE event_type = ?",
    ).bind("manual_run_started").first<{ event_json: string }>();
    expect(JSON.parse(audit!.event_json)).toEqual({
      actorEmail: "reader@example.com",
    });
  });

  it.each([
    ["manual", 202],
    ["scheduled", 409],
  ] as const)(
    "claims one pending D1 run when the %s start wins the race",
    async (winner, expectedStatus) => {
    inlineLauncherCalls.count = 0;
    const created = deferred();
    const release = deferred();
    const workflow = new RecordingWorkflow(async () => {
      created.resolve();
      await release.promise;
    });
    const editionDate = winner === "manual" ? "2026-07-30" : "2026-07-31";
    const instant = winner === "manual"
      ? new Date("2026-07-30T08:30:00.000Z")
      : new Date("2026-07-31T08:30:00.000Z");
    let responsePromise: Promise<Response>;
    let scheduledPromise: Promise<void>;
    if (winner === "manual") {
      responsePromise = worker.fetch(
        manualStartRequest(editionDate),
        workerEnv(workflow),
      );
      await created.promise;
      scheduledPromise = coordinateScheduledBriefing(
        {
          listRuns: () =>
            new D1BriefingRepository(env.DB).listWorkflowRuns(),
          workflow,
        },
        instant,
      );
    } else {
      scheduledPromise = coordinateScheduledBriefing(
        {
          listRuns: async () => [],
          workflow,
        },
        instant,
      );
      await created.promise;
      responsePromise = worker.fetch(
        manualStartRequest(editionDate),
        workerEnv(workflow),
      );
    }
    release.resolve();
    const [response] = await Promise.all([
      responsePromise,
      scheduledPromise,
    ]);

    expect(response.status).toBe(expectedStatus);
    expect(workflow.created).toHaveLength(1);
    expect(workflow.instances.size).toBe(1);
    expect(inlineLauncherCalls.count).toBe(0);
    const runs = await env.DB.prepare(
      `SELECT id, edition_date, status
       FROM workflow_runs WHERE edition_date = ?`,
    ).bind(editionDate).all<{
      id: string;
      edition_date: string;
      status: string;
    }>();
    expect(runs.results).toEqual([{
      id: editionDate,
      edition_date: editionDate,
      status: "pending",
    }]);
    },
  );

  it("releases an untouched D1 claim when Workflow creation is rejected", async () => {
    inlineLauncherCalls.count = 0;
    let rejectCreate = true;
    const accepted = new RecordingWorkflow();
    const workflow = {
      create: async (input: WorkflowCreateInput) => {
        if (rejectCreate) throw new Error("Workflow API unavailable.");
        return accepted.create(input);
      },
      get: async () => ({
        status: async () => ({ status: "unknown" }),
        restart: async () => undefined,
        resume: async () => undefined,
      }),
    };

    const rejected = await worker.fetch(
      manualStartRequest("2026-08-01"),
      workerEnv(workflow),
    );
    expect(rejected.status).toBe(500);
    await expect(
      new D1BriefingRepository(env.DB).getWorkflowRun("2026-08-01"),
    ).resolves.toBeNull();

    rejectCreate = false;
    const retried = await worker.fetch(
      manualStartRequest("2026-08-01"),
      workerEnv(workflow),
    );
    expect(retried.status).toBe(202);
    expect(accepted.created).toHaveLength(1);
    expect(inlineLauncherCalls.count).toBe(0);
  });

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
    await app().request("/api/feedback", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({
        itemId: item.id,
        action: "save",
        reason: null,
      }),
    });

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
      feedbackHistory: [
        expect.objectContaining({
          itemId: item.id,
          action: "save",
        }),
      ],
    });
    const persistedSave = await env.DB.prepare(
      `SELECT action
      FROM feedback
      WHERE item_id = ? AND action = 'save'`,
    )
      .bind(item.id)
      .first<{ action: string }>();
    expect(persistedSave).toEqual({ action: "save" });
  });

  it("recomputes remaining feedback snapshots and serializes concurrent deltas", async () => {
    const repository = new D1BriefingRepository(env.DB);
    await repository.resetPreferences();
    const item = fixtureItem("feedback-consistency");
    await repository.upsertItems([item]);
    for (let index = 0; index < 3; index += 1) {
      await repository.recordFeedback({
        itemId: item.id,
        action: "more_like_this",
        reason: "topic",
      });
    }
    const before = (await repository.getPreferences()).feedbackHistory.filter(
      (record) => record.itemId === item.id,
    );
    await repository.removeFeedbackAdjustment(before[0]!.id);
    expect(
      (await repository.getPreferences()).feedbackHistory
        .filter((record) => record.itemId === item.id)
        .map((record) => record.adjustments[0]?.resultingWeight),
    ).toEqual([1.1, 1.2]);

    await repository.resetPreferences();
    const concurrent = fixtureItem("feedback-concurrent");
    await repository.upsertItems([concurrent]);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.recordFeedback({
          itemId: concurrent.id,
          action: "less_like_this",
          reason: "topic",
        }),
      ),
    );
    expect(
      (await repository.getPreferences()).feedbackHistory
        .filter((record) => record.itemId === concurrent.id)
        .map((record) => record.adjustments[0]?.resultingWeight),
    ).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
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
      expect(invalid.status).toBe(400);
    }

    const unknown = await app().request("/api/archive?unexpected=value", {
      headers: authenticated,
    });
    expect(unknown.status).toBe(400);

    for (const literal of ['"', "%", "_"]) {
      const response = await app().request(
        `/api/archive?q=${encodeURIComponent(literal)}`,
        { headers: authenticated },
      );
      expect(response.status).toBe(200);
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
    const duplicateBody = await duplicate.json();
    expect(duplicateBody).toMatchObject({
      error: { code: "SOURCE_ALREADY_EXISTS" },
    });
    expect(() => ApiErrorSchema.parse(duplicateBody)).not.toThrow();

    const duplicateId = await app().request("/api/sources", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({
        ...source,
        canonicalName: "Different source",
        canonicalUrl: "https://different-task-10.example/",
      }),
    });
    expect(duplicateId.status).toBe(409);
    const duplicateIdBody = await duplicateId.json();
    expect(duplicateIdBody).toMatchObject({
      error: { code: "SOURCE_ID_ALREADY_EXISTS" },
    });
    expect(() => ApiErrorSchema.parse(duplicateIdBody)).not.toThrow();

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

    const repository = new D1BriefingRepository(env.DB);
    await repository.updateSource(source.id, { enabled: true });
    const systemAudit = await env.DB.prepare(
      "SELECT event_json FROM audit_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 1",
    ).bind("source_updated").first<{ event_json: string }>();
    expect(JSON.parse(systemAudit!.event_json)).toMatchObject({
      sourceId: source.id,
      actorEmail: "system",
      changes: { enabled: true },
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
      "sk_live_must_not_leak",
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
                validationErrors: [
                  "unsupported_claim",
                  "secret-must-not-leak",
                ],
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
          error: "BearerToken_must_not_leak",
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
          sourceFailures: ["reuters", "api-key-must-not-leak"],
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
    expect(text).not.toContain("sk_live");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("api-key");
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
      sourceFailures: ["REDACTED_SOURCE", "reuters"],
      rejectedSummaryReasons: [
        "REDACTED_REJECTION",
        "unsupported_claim",
      ],
      publishedAt: "2034-02-01T09:45:00.000Z",
      estimatedMonthlyCostUsd: 1.25,
    });
  });
});
