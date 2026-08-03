import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
  Item,
  StructuredSummary,
} from "../../../src/contracts/editorial";
import {
  createBudgetedPipelineRuntimeFactory,
  createD1ModelBudgetCallbacks,
  createD1TerminalReservationCleanup,
  runCheckpointWithWorkflowStep,
  RunParamsSchema,
  ScheduledModelConfigSchema,
} from "../../../src/workflow/daily-briefing-workflow";
import { D1BriefingRepository } from "../../../src/db/d1-repository";
import {
  approvedBaselinePreferences,
  ReaderPreferencesSchema,
  type ReaderPreferences,
} from "../../../src/db/repository";
import { BudgetHardStopError } from "../../../src/models/budget-gate";
import { FakeModelProvider } from "../../../src/models/fake-provider";
import {
  createD1PipelineStore,
  createProductionPipelineContext,
  loadOrCreatePreferenceSnapshot,
  PIPELINE_STEPS,
  runEditorialPipeline,
} from "../../../src/workflow/run-editorial-pipeline";
import type {
  CheckpointArtifact,
  PipelineContext,
  PipelineRun,
  PipelineStep,
  PipelineStore,
} from "../../../src/workflow/types";
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
        start: async ({ editionDate }: { editionDate: string }) => ({
          runId: editionDate,
        }),
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
      email: "reader@example.com",
    }),
  };
});

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const now = "2026-07-29T08:30:00.000Z";

function resumeWorkerEnv(workflow: object): Env {
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

async function createRetryableRun(runId: string, editionDate: string) {
  await env.DB.prepare(
    `INSERT INTO workflow_runs (
      id, edition_date, status, current_step, retryable, attempt_count,
      failure_code, estimated_cost_usd, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    runId, editionDate, "failed", "publish", 1, 1,
    "MINIMUM_COVERAGE_FAILED", 0, now, now,
  ).run();
}

function item(id: string, section: string): Item {
  return {
    id,
    kind: section === "research" ? "paper" : "article",
    canonicalUrl: `https://example.com/${id}`,
    title: `${section} ${id}`,
    publishedAt: now,
    sourceRefs: [{
      id: `source-${id}`,
      name: `Source ${id}`,
      url: `https://example.com/source/${id}`,
      role: "reporting",
      retrievedAt: now,
    }],
    accessLevel: "abstract",
    primaryTopic: section,
    tags: [section],
    normalizedText: `${section} evidence`,
    metadata: { section },
    createdAt: now,
    expiresAt: null,
  };
}

function summary(value: Item): StructuredSummary {
  const evidence = `${value.title} is supported.`;
  return {
    title: value.title,
    oneSentence: evidence,
    whyItMatters: evidence,
    uncertainty: evidence,
    claims: [{
      text: evidence,
      sourceIds: [value.sourceRefs[0]!.id],
      evidenceExcerpt: evidence,
    }],
    accessLevel: "abstract",
  };
}

class ResumeStore implements PipelineStore {
  readonly runs = new Map<string, PipelineRun>();
  readonly artifacts = new Map<string, CheckpointArtifact>();
  readonly attempts = new Map<PipelineStep, number>();
  readonly editions = new Map<string, EditionWithEntries>();
  readonly invalidatedFrom: string[] = [];
  readonly preferenceSnapshots = new Map<string, ReaderPreferences>();
  readonly artifactReads: PipelineStep[] = [];

  async getRun(runId: string) { return this.runs.get(runId) ?? null; }
  async createRun(run: PipelineRun) { this.runs.set(run.id, run); }
  async saveRun(run: PipelineRun) { this.runs.set(run.id, run); }
  async readPreferenceSnapshot(runId: string) {
    return this.preferenceSnapshots.get(runId) ?? null;
  }
  async savePreferenceSnapshot(
    runId: string,
    preferences: ReaderPreferences,
  ) {
    if (!this.preferenceSnapshots.has(runId)) {
      this.preferenceSnapshots.set(
        runId,
        ReaderPreferencesSchema.parse(preferences),
      );
    }
  }
  async readCheckpoint(runId: string, step: PipelineStep) {
    return this.artifacts.has(`${runId}:${step}`);
  }
  async saveCheckpoint(runId: string, step: PipelineStep, artifact: CheckpointArtifact) {
    this.artifacts.set(`${runId}:${step}`, structuredClone(artifact));
  }
  async readArtifact(runId: string, step: PipelineStep) {
    this.artifactReads.push(step);
    return this.artifacts.get(`${runId}:${step}`) ?? null;
  }
  async beginAttempt(_runId: string, step: PipelineStep) {
    const attempt = (this.attempts.get(step) ?? 0) + 1;
    this.attempts.set(step, attempt);
    return attempt;
  }
  async failAttempt() { /* failure is represented by the run */ }
  async invalidateFrom(runId: string, step: PipelineStep) {
    this.invalidatedFrom.push(runId, step);
    this.artifacts.clear();
  }
  async createDraft() { /* composition is persisted atomically later */ }
  async replaceEntries() { /* composition is persisted atomically later */ }
  async publish() { /* composition is persisted atomically later */ }
  async getLatestEdition() {
    return [...this.editions.values()][0] ?? null;
  }
  async persistEdition(
    edition: Edition,
    entries: readonly EditionEntry[],
    status: "draft" | "published" | "partial",
  ) {
    const stored: EditionWithEntries = {
      ...edition,
      status,
      publishedAt: status === "draft" ? null : now,
      entries: [...entries],
    };
    this.editions.set(edition.editionDate, stored);
    return stored;
  }
}

function resumableContext(
  failedStep: PipelineStep,
): PipelineContext & {
  store: ResumeStore;
  calls: Map<PipelineStep, number>;
} {
  const values = [
    item("research", "research"),
    item("world", "world"),
    item("technology", "technology"),
    item("ai-policy", "ai_policy"),
    item("dmv", "dmv"),
    item("baltimore", "baltimore"),
  ];
  const calls = new Map<PipelineStep, number>();
  const counted = <T>(step: PipelineStep, operation: () => T) => async () => {
    calls.set(step, (calls.get(step) ?? 0) + 1);
    return operation();
  };
  let injected = false;
  return {
    editionDate: `2034-01-${String(PIPELINE_STEPS.indexOf(failedStep) + 1).padStart(2, "0")}`,
    runId: `resume-${failedStep}`,
    now: () => now,
    store: new ResumeStore(),
    calls,
    collect: counted("collect", () => values),
    normalize: async (input) => {
      calls.set("normalize", (calls.get("normalize") ?? 0) + 1);
      return input as readonly Item[];
    },
    enrich: async (input) => {
      calls.set("enrich", (calls.get("enrich") ?? 0) + 1);
      return input;
    },
    prefilter: async (input) => {
      calls.set("prefilter", (calls.get("prefilter") ?? 0) + 1);
      return input;
    },
    assess: async (input) => {
      calls.set("assess", (calls.get("assess") ?? 0) + 1);
      return input;
    },
    score: async (input) => {
      calls.set("score", (calls.get("score") ?? 0) + 1);
      return input;
    },
    cluster: async (input) => {
      calls.set("cluster", (calls.get("cluster") ?? 0) + 1);
      return input;
    },
    shortlist: async (input) => {
      calls.set("shortlist", (calls.get("shortlist") ?? 0) + 1);
      return input;
    },
    synthesize: async (input) => {
      calls.set("synthesize", (calls.get("synthesize") ?? 0) + 1);
      return input.map((candidate) => ({ item: candidate, summary: summary(candidate) }));
    },
    validate: async (input) => {
      calls.set("validate", (calls.get("validate") ?? 0) + 1);
      return input.map((candidate) => ({ ...candidate, valid: true }));
    },
    checkpointExecutor: async (step, execute) => {
      const output = await execute();
      if (step === failedStep && !injected) {
        injected = true;
        throw new Error(`INJECTED_${step.toUpperCase()}_FAILURE`);
      }
      return output;
    },
  };
}

describe("durable workflow checkpoint execution", () => {
  it("persists only a small Workflow marker while returning the checkpoint output", async () => {
    const checkpointOutput = { payload: "x".repeat(1_100_000) };
    let persistedStepOutput: unknown;
    let operationCalls = 0;
    const workflowStep = {
      do: async <T,>(
        _name: string,
        _config: unknown,
        operation: () => Promise<T>,
      ): Promise<T> => {
        const output = await operation();
        persistedStepOutput = output;
        return output;
      },
    };

    const result = await runCheckpointWithWorkflowStep(
      workflowStep,
      "enrich",
      async () => {
        operationCalls += 1;
        return checkpointOutput;
      },
    );

    expect(result).toBe(checkpointOutput);
    expect(operationCalls).toBe(1);
    expect(persistedStepOutput).toEqual({
      checkpoint: "enrich",
      completed: true,
    });
    expect(JSON.stringify(persistedStepOutput).length).toBeLessThan(100);
  });

  it("reloads D1 checkpoint output when Cloudflare reuses a completed step marker", async () => {
    const checkpointOutput = { payload: "restored-from-d1" };
    let operationCalls = 0;
    const workflowStep = {
      do: async <T,>(): Promise<T> => ({
        checkpoint: "enrich",
        completed: true,
      }) as T,
    };

    const result = await runCheckpointWithWorkflowStep(
      workflowStep,
      "enrich",
      async () => {
        operationCalls += 1;
        return checkpointOutput;
      },
    );

    expect(result).toBe(checkpointOutput);
    expect(operationCalls).toBe(1);
  });

  it("does not transfer malformed checkpoint rows from another step", async () => {
    const runId = "step-filtered-checkpoint";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2036-04-08",
      status: "running",
      currentStep: "shortlist",
      retryable: false,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const shortlisted = [item("filtered-shortlist", "research")];
    await store.saveCheckpoint(runId, "shortlist", {
      output: shortlisted,
      attempts: 1,
      durationMs: 10,
      itemCount: 1,
      estimatedCostUsd: 0,
    });
    await env.DB.prepare(
      `INSERT INTO audit_events (
      id, run_id, event_type, event_json, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "malformed-unrelated-checkpoint",
      runId,
      "workflow_checkpoint",
      "{malformed unrelated checkpoint",
      "2036-04-08T09:01:00.000Z",
    ).run();

    await expect(store.readArtifact(runId, "shortlist")).resolves.toMatchObject({
      output: shortlisted,
      itemCount: 1,
    });
  });

  it("keeps pre-feedback ranking on resume while a new run applies feedback", async () => {
    // This fails if ranking ignores effective feedback weights or a resume
    // rereads mutable global preferences.
    const repository = new D1BriefingRepository(env.DB);
    const feedbackItem: Item = {
      ...item("preference-feedback-item", "research"),
      primaryTopic: "alignment-interpretability",
    };
    await repository.upsertItems([feedbackItem]);
    const firstRunId = "preference-snapshot-resume";
    const firstStore = createD1PipelineStore(env.DB);
    await firstStore.createRun({
      id: firstRunId,
      editionDate: "2036-04-01",
      status: "retryable",
      currentStep: "collect",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: "TRANSIENT",
    });
    const firstSnapshot = await loadOrCreatePreferenceSnapshot(
      firstStore,
      firstRunId,
    );
    await firstStore.saveCheckpoint(firstRunId, "collect", {
      output: [],
      attempts: 1,
      durationMs: 0,
      itemCount: 0,
      estimatedCostUsd: 0,
    });

    await repository.recordFeedback({
      itemId: feedbackItem.id,
      action: "more_like_this",
      reason: "topic",
    });
    const resumedSnapshot = await loadOrCreatePreferenceSnapshot(
      firstStore,
      firstRunId,
    );
    const newRunId = "preference-snapshot-new-run";
    const newStore = createD1PipelineStore(env.DB);
    await newStore.createRun({
      id: newRunId,
      editionDate: "2036-04-02",
      status: "pending",
      currentStep: null,
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const newSnapshot = await loadOrCreatePreferenceSnapshot(
      newStore,
      newRunId,
    );
    const topicalFit = async (
      runId: string,
      preferences: ReaderPreferences,
    ): Promise<number | undefined> => {
      const alignmentItem: Item = {
        ...item(`alignment-${runId}`, "research"),
        primaryTopic: "alignment-interpretability",
        metadata: { workflow: { version: 1 } },
      };
      const context = createProductionPipelineContext({
        editionDate: "2036-04-04",
        runId,
        store: new ResumeStore(),
        now: () => now,
        preferences,
        providers: {
          summary: new FakeModelProvider({
            embeddingBatches: [[
              [0.6, 0.8],
              [1, 0],
              [1, 0],
              [1, 0],
            ]],
          }),
          assessment: new FakeModelProvider(),
        },
        collectCandidates: async () => [],
      });
      const enriched = await context.enrich([alignmentItem]);
      return (enriched[0]?.metadata.workflow as
        | { topicalFit?: number }
        | undefined)?.topicalFit;
    };

    expect(firstSnapshot.feedbackHistory).toEqual([]);
    expect(resumedSnapshot.feedbackHistory).toEqual([]);
    expect(newSnapshot.feedbackHistory[0]?.adjustments[0]?.resultingWeight)
      .toBe(1.1);
    await expect(topicalFit("initial-ranking", firstSnapshot)).resolves.toBe(0.6);
    await expect(topicalFit("resumed-ranking", resumedSnapshot)).resolves.toBe(0.6);
    await expect(topicalFit("new-ranking", newSnapshot)).resolves.toBe(0.66);
  });

  it("stores exactly one immutable preference snapshot under concurrent retries", async () => {
    // This fails if retries append or overwrite run-scoped preference state.
    const repository = new D1BriefingRepository(env.DB);
    const baseline = approvedBaselinePreferences();
    await repository.updatePreferences({
      ...baseline,
      topicWeights: {
        ...baseline.topicWeights,
        "alignment-interpretability": 2,
      },
    });
    const runId = "preference-snapshot-concurrent";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2036-04-03",
      status: "pending",
      currentStep: null,
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const preferred = await repository.getPreferences();

    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.savePreferenceSnapshot(runId, preferred)
      ),
    );
    await store.savePreferenceSnapshot(runId, ReaderPreferencesSchema.parse({
      ...preferred,
      topicWeights: {
        ...preferred.topicWeights,
        "alignment-interpretability": 0,
      },
    }));
    const events = await env.DB.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = ?`,
    ).bind(runId, "preference_snapshot").all<{ event_json: string }>();

    expect(events.results).toHaveLength(1);
    expect(await store.readPreferenceSnapshot(runId)).toEqual(preferred);
  });

  it("replaces the deterministic source-failure snapshot on a real recollection", async () => {
    const runId = "source-failure-recollection";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2036-04-08",
      status: "running",
      currentStep: "collect",
      retryable: false,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });

    await store.saveCollectionSourceFailures(runId, ["first-source:fetch"]);
    await env.DB.prepare(
      "UPDATE audit_events SET created_at = ? WHERE id = ?",
    ).bind(
      "2000-01-01T00:00:00.000Z",
      `collection_source_failures:${runId}`,
    ).run();
    await store.saveCollectionSourceFailures(runId, ["second-source:parse"]);

    expect(await store.readCollectionSourceFailures(runId)).toEqual([
      "second-source:parse",
    ]);
    const events = (await env.DB.prepare(
      `SELECT id, created_at FROM audit_events
       WHERE run_id = ? AND event_type = ?`,
    ).bind(runId, "collection_source_failures").all<{
      id: string;
      created_at: string;
    }>()).results;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: `collection_source_failures:${runId}`,
    });
    expect(events[0]?.created_at).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("does not overwrite a deterministic ID owned by another run or event type", async () => {
    const store = createD1PipelineStore(env.DB);
    const runIds = [
      "source-failure-owner",
      "source-failure-run-conflict",
      "source-failure-event-conflict",
    ];
    for (const [index, runId] of runIds.entries()) {
      await store.createRun({
        id: runId,
        editionDate: `2036-04-${String(index + 9).padStart(2, "0")}`,
        status: "running",
        currentStep: "collect",
        retryable: false,
        attemptCount: 1,
        estimatedCostUsd: 0,
        createdAt: now,
        updatedAt: now,
        failureCode: null,
      });
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        "collection_source_failures:source-failure-run-conflict",
        "source-failure-owner",
        "collection_source_failures",
        '["owner:fetch"]',
        now,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        "collection_source_failures:source-failure-event-conflict",
        "source-failure-event-conflict",
        "source_updated",
        '{"preserve":true}',
        now,
      ),
    ]);

    await store.saveCollectionSourceFailures(
      "source-failure-run-conflict",
      ["replacement:parse"],
    );
    await store.saveCollectionSourceFailures(
      "source-failure-event-conflict",
      ["replacement:parse"],
    );

    expect((await env.DB.prepare(
      `SELECT id, run_id, event_type, event_json FROM audit_events
       WHERE id IN (?, ?)
       ORDER BY id`,
    ).bind(
      "collection_source_failures:source-failure-run-conflict",
      "collection_source_failures:source-failure-event-conflict",
    ).all()).results).toEqual([
      {
        id: "collection_source_failures:source-failure-event-conflict",
        run_id: "source-failure-event-conflict",
        event_type: "source_updated",
        event_json: '{"preserve":true}',
      },
      {
        id: "collection_source_failures:source-failure-run-conflict",
        run_id: "source-failure-owner",
        event_type: "collection_source_failures",
        event_json: '["owner:fetch"]',
      },
    ]);
  });

  it("uses immutable defaults for a corrupt stored preference snapshot", async () => {
    const baseline = approvedBaselinePreferences();
    const repository = new D1BriefingRepository(env.DB);
    await repository.updatePreferences({
      ...baseline,
      topicWeights: {
        ...baseline.topicWeights,
        "alignment-interpretability": 2,
      },
    });
    const runId = "corrupt-preference-snapshot";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2036-04-05",
      status: "pending",
      currentStep: null,
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    await env.DB.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      `preference_snapshot:${runId}`,
      runId,
      "preference_snapshot",
      "{corrupt immutable snapshot",
      now,
    ).run();

    const snapshot = await loadOrCreatePreferenceSnapshot(store, runId);

    expect(snapshot.topicWeights["alignment-interpretability"]).toBe(1);
    expect(snapshot.feedbackHistory).toEqual([]);
    expect(await env.DB.prepare(
      "SELECT event_json FROM audit_events WHERE id = ?",
    ).bind(`preference_snapshot:${runId}`).first()).toEqual({
      event_json: "{corrupt immutable snapshot",
    });
  });

  it("snapshots defaults when current stored preferences are invalid", async () => {
    await env.DB.prepare(
      "UPDATE preferences SET topic_weights_json = ?",
    ).bind('{"alignment-interpretability":"invalid"}').run();
    const runId = "invalid-current-preferences";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2036-04-06",
      status: "pending",
      currentStep: null,
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });

    const snapshot = await loadOrCreatePreferenceSnapshot(store, runId);

    expect(snapshot.topicWeights["alignment-interpretability"]).toBe(1);
    expect(await store.readPreferenceSnapshot(runId)).toEqual(snapshot);
  });

  it("fails open to default ranking for invalid supplied preferences", async () => {
    const baseline = approvedBaselinePreferences();
    const invalidPreferences = {
      ...baseline,
      topicWeights: { "alignment-interpretability": Number.NaN },
      baseline,
      feedbackHistory: [],
    } as ReaderPreferences;
    const alignmentItem: Item = {
      ...item("invalid-supplied-preferences", "research"),
      primaryTopic: "alignment-interpretability",
      metadata: { workflow: { version: 1 } },
    };
    const context = createProductionPipelineContext({
      editionDate: "2036-04-07",
      runId: "invalid-supplied-preferences",
      store: new ResumeStore(),
      now: () => now,
      preferences: invalidPreferences,
      providers: {
        summary: new FakeModelProvider({
          embeddingBatches: [[
            [0.6, 0.8],
            [1, 0],
            [1, 0],
            [1, 0],
          ]],
        }),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    const enriched = await context.enrich([alignmentItem]);

    expect((enriched[0]?.metadata.workflow as { topicalFit?: number })
      .topicalFit).toBe(0.6);
  });

  it("authorizes every paid request against live D1 reservations", async () => {
    const runId = "live-budget-runtime";
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      "2036-03-01",
      "running",
      "assess",
      0,
      1,
      null,
      0,
      now,
      now,
    ).run();
    const callbacks = createD1ModelBudgetCallbacks(
      new D1BriefingRepository(env.DB),
      {
        runId,
        monthlyLimitUsd: 1,
        unitPricesUsd: { "paid-model": 0.001 },
        clock: () => new Date("2036-03-01T09:00:00.000Z"),
      },
    );

    const first = await callbacks.authorize({
      model: "paid-model",
      maximumBillableUnits: 600,
    });
    expect(first).not.toBeNull();
    expect(await callbacks.authorize({
      model: "paid-model",
      maximumBillableUnits: 600,
    })).toBeNull();
    if (first === null) throw new Error("Expected first reservation");
    await callbacks.reconcile(first, {
      provider: "openai",
      operation: "generation",
      model: "paid-model",
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
      embeddingCount: 0,
    });
    await expect(callbacks.authorize({
      model: "paid-model",
      maximumBillableUnits: 600,
    })).resolves.not.toBeNull();
  });

  it("cleans terminal reservations after exhausted synthesis failure", async () => {
    const context = resumableContext("publish");
    const cleanup = vi.fn(async () => undefined);
    context.cleanupTerminalReservations = cleanup;
    context.synthesize = async () => {
      throw new Error("Worker exceeded memory limit.");
    };
    context.checkpointExecutor = async (_step, execute) => execute();

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "Worker exceeded memory limit.",
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("Worker exceeded memory limit.");
  });

  it("does not mask the pipeline error when terminal cleanup fails", async () => {
    const context = resumableContext("publish");
    context.cleanupTerminalReservations = async () => {
      throw new Error("MODEL_BUDGET_CLEANUP_FAILED");
    };
    context.synthesize = async () => {
      throw new Error("ORIGINAL_SYNTHESIS_FAILURE");
    };
    context.checkpointExecutor = async (_step, execute) => execute();

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "ORIGINAL_SYNTHESIS_FAILURE",
    );
  });

  it("does not clean reservations when a temporary step retry succeeds", async () => {
    const context = resumableContext("publish");
    const cleanup = vi.fn(async () => undefined);
    context.cleanupTerminalReservations = cleanup;
    let attempts = 0;
    const synthesize = context.synthesize;
    context.synthesize = async (items) => {
      attempts += 1;
      if (attempts === 1) throw new Error("TEMPORARY_SYNTHESIS_FAILURE");
      return synthesize(items);
    };
    context.checkpointExecutor = async (_step, execute) => {
      try {
        return await execute();
      } catch {
        return execute();
      }
    };

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      runId: context.runId,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("releases and audits terminal D1 reservations", async () => {
    const releaseRunModelBudget = vi.fn(async () => ({
      releasedReservations: 3,
      releasedMaximumCostMicrousd: 300_750,
    }));
    const recordTerminalModelBudgetCleanup = vi.fn(async () => undefined);
    const cleanup = createD1TerminalReservationCleanup(
      { releaseRunModelBudget, recordTerminalModelBudgetCleanup },
      {
        runId: "terminal-cleanup-run",
        clock: () => new Date("2036-02-10T09:05:00.000Z"),
      },
    );

    await cleanup("Worker exceeded memory limit.");

    expect(releaseRunModelBudget).toHaveBeenCalledWith({
      runId: "terminal-cleanup-run",
      releasedAt: "2036-02-10T09:05:00.000Z",
    });
    expect(recordTerminalModelBudgetCleanup).toHaveBeenCalledWith({
      runId: "terminal-cleanup-run",
      failureCode: "WORKER_MEMORY_LIMIT",
      outcome: "released",
      occurredAt: "2036-02-10T09:05:00.000Z",
      releasedReservations: 3,
      releasedMaximumCostMicrousd: 300_750,
    });
  });

  it("records only a generic diagnostic when terminal release fails", async () => {
    const releaseError = new Error("private repository details");
    const privatePipelineError =
      "Bearer secret-token; provider body; request req-123; reservation reservation-456; SELECT * FROM items";
    const releaseRunModelBudget = vi.fn(async () => {
      throw releaseError;
    });
    const recordTerminalModelBudgetCleanup = vi.fn(async () => undefined);
    const cleanup = createD1TerminalReservationCleanup(
      { releaseRunModelBudget, recordTerminalModelBudgetCleanup },
      {
        runId: "terminal-cleanup-run",
        clock: () => new Date("2036-02-10T09:05:00.000Z"),
      },
    );

    await expect(cleanup(privatePipelineError)).rejects.toBe(releaseError);
    expect(recordTerminalModelBudgetCleanup).toHaveBeenCalledWith({
      runId: "terminal-cleanup-run",
      failureCode: "PIPELINE_TERMINAL_FAILURE",
      outcome: "failed",
      occurredAt: "2036-02-10T09:05:00.000Z",
      releasedReservations: 0,
      releasedMaximumCostMicrousd: 0,
    });
    expect(JSON.stringify(recordTerminalModelBudgetCleanup.mock.calls))
      .not.toContain("private repository details");
    expect(JSON.stringify(recordTerminalModelBudgetCleanup.mock.calls))
      .not.toContain(privatePipelineError);
  });

  it("treats a success-audit write failure as best effort", async () => {
    const releaseRunModelBudget = vi.fn(async () => ({
      releasedReservations: 1,
      releasedMaximumCostMicrousd: 99_450,
    }));
    const recordTerminalModelBudgetCleanup = vi.fn(async () => {
      throw new Error("AUDIT_WRITE_FAILED");
    });
    const cleanup = createD1TerminalReservationCleanup(
      { releaseRunModelBudget, recordTerminalModelBudgetCleanup },
      {
        runId: "terminal-cleanup-run",
        clock: () => new Date("2036-02-10T09:05:00.000Z"),
      },
    );

    await expect(cleanup("PIPELINE_FAILED")).resolves.toBeUndefined();
    expect(recordTerminalModelBudgetCleanup).toHaveBeenCalledOnce();
  });

  it("persists a live budget rejection as retryable and rethrows it", async () => {
    const context = resumableContext("publish");
    context.assess = async () => {
      throw new BudgetHardStopError();
    };
    context.checkpointExecutor = async (_step, execute) => execute();

    await expect(runEditorialPipeline(context)).rejects.toBeInstanceOf(
      BudgetHardStopError,
    );
    expect(context.store.runs.get(context.runId)).toMatchObject({
      status: "retryable",
      retryable: true,
      failureCode: "BUDGET_HARD_STOP",
    });
  });

  it("reloads normalized data only when composition needs it", async () => {
    const context = resumableContext("publish");
    context.checkpointExecutor = async (_step, execute) => execute();

    await runEditorialPipeline(context);

    expect(context.store.artifactReads).toEqual(["normalize"]);
    expect(context.store.runs.get(context.runId)?.currentStep).toBe("publish");
  });

  it.each([
    ["paused", "resume"],
    ["errored", "restart"],
    ["terminated", "restart"],
    ["complete", "restart"],
    ["unknown", "create"],
  ] as const)(
    "routes manual resume for a %s Workflow instance through %s",
    async (workflowStatus, expectedAction) => {
      inlineLauncherCalls.count = 0;
      const statuses = [
        "paused",
        "errored",
        "terminated",
        "complete",
        "unknown",
      ] as const;
      const sequence = statuses.indexOf(workflowStatus) + 1;
      const editionDate = `2035-01-${String(sequence).padStart(2, "0")}`;
      const runId = `manual-resume-${workflowStatus}`;
      await createRetryableRun(runId, editionDate);
      const actions: string[] = [];
      const instance = {
        status: async () => ({ status: workflowStatus }),
        resume: async () => { actions.push("resume"); },
        restart: async () => { actions.push("restart"); },
      };
      const workflow = {
        get: async (id: string) => {
          actions.push(`get:${id}`);
          return instance;
        },
        create: async (input: unknown) => {
          actions.push("create");
          return { ...instance, input };
        },
      };

      const response = await worker.fetch(
        new Request(
          `https://briefing.example/api/admin/runs/${runId}/resume`,
          {
            method: "POST",
            headers: { "CF-Access-Jwt-Assertion": "signed-token" },
          },
        ),
        resumeWorkerEnv(workflow),
      );

      expect(response.status).toBe(202);
      expect(actions).toEqual([`get:${editionDate}`, expectedAction]);
      expect(inlineLauncherCalls.count).toBe(0);
    },
  );

  it.each(PIPELINE_STEPS)(
    "resumes after an injected %s failure without repeating completed work",
    async (checkpoint) => {
      const context = resumableContext(checkpoint);
      await expect(runEditorialPipeline(context)).rejects.toThrow(
        `INJECTED_${checkpoint.toUpperCase()}_FAILURE`,
      );
      await expect(runEditorialPipeline(context)).resolves.toMatchObject({
        status: "published",
      });
      expect(Object.fromEntries(context.store.attempts)).toEqual(
        Object.fromEntries(PIPELINE_STEPS.map((step) => [step, 1])),
      );
      for (const calls of context.calls.values()) expect(calls).toBe(1);
      expect(context.store.invalidatedFrom).toEqual([]);
    },
  );

  it("refreshes collection when retrying failed minimum coverage", async () => {
    const context = resumableContext("publish");
    const candidates = [
      item("research", "research"),
      item("world", "world"),
      item("technology", "technology"),
      item("ai-policy", "ai_policy"),
      item("dmv", "dmv"),
      item("baltimore", "baltimore"),
    ];
    let localAvailable = false;
    context.collect = async () => candidates.filter((candidate) =>
      localAvailable ||
      !["dmv", "baltimore"].includes(candidate.metadata.section as string)
    );
    context.checkpointExecutor = async (_step, execute) => execute();

    const first = await runEditorialPipeline(context);
    expect(first.status).toBe("failed");
    expect(context.store.runs.get(context.runId)).toMatchObject({
      status: "failed",
      retryable: true,
      failureCode: "MINIMUM_COVERAGE_FAILED",
    });

    localAvailable = true;
    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "published",
    });
    expect(context.store.invalidatedFrom).toEqual([
      context.runId,
      "collect",
    ]);
  });

  it("strictly validates bounded workflow payload and model configuration", () => {
    expect(RunParamsSchema.parse({ editionDate: "2026-07-29" })).toEqual({
      editionDate: "2026-07-29",
    });
    expect(() => RunParamsSchema.parse({
      editionDate: "2026-07-29",
      unexpected: true,
    })).toThrow();
    expect(() => ScheduledModelConfigSchema.parse({
      OPENAI_API_KEY: "secret",
      SUMMARY_MODEL: "summary",
      ASSESSMENT_MODEL: "assessment",
      EMBEDDING_MODEL: "embedding",
      MONTHLY_BUDGET_USD: "31",
      SUMMARY_UNIT_PRICE_USD: "0.001",
      ASSESSMENT_UNIT_PRICE_USD: "0.001",
      EMBEDDING_UNIT_PRICE_USD: "0.001",
    })).toThrow();
  });

  it("rejects conflicting prices for one model before runtime construction", () => {
    let dbAccesses = 0;
    const database = new Proxy({}, {
      get() {
        dbAccesses += 1;
        throw new Error("DB must not be accessed for invalid model pricing.");
      },
    }) as D1Database;
    const base = {
      DB: database,
      OPENAI_API_KEY: "secret",
      SUMMARY_MODEL: "shared-model",
      ASSESSMENT_MODEL: "shared-model",
      EMBEDDING_MODEL: "embedding-model",
      MONTHLY_BUDGET_USD: "10",
      SUMMARY_UNIT_PRICE_USD: "0.001",
      ASSESSMENT_UNIT_PRICE_USD: "0.002",
      EMBEDDING_UNIT_PRICE_USD: "0.0001",
    };

    expect(() => createBudgetedPipelineRuntimeFactory(base)).toThrow(
      "CONFLICTING_MODEL_UNIT_PRICE:shared-model",
    );
    expect(dbAccesses).toBe(0);
    expect(() => createBudgetedPipelineRuntimeFactory({
      ...base,
      ASSESSMENT_UNIT_PRICE_USD: "0.001",
    })).not.toThrow();
    expect(dbAccesses).toBe(0);
  });

  it("coordinates the local-date Workflow ID and skips a published run", async () => {
    const created: unknown[] = [];
    const binding = {
      create: async (input: unknown) => {
        created.push(input);
        return {};
      },
      get: async () => { throw new Error("get must not be called"); },
    };
    await coordinateScheduledBriefing(
      {
        listRuns: () => new D1BriefingRepository(env.DB).listWorkflowRuns(),
        workflow: binding as never,
      },
      new Date("2026-07-29T08:30:00.000Z"),
    );
    expect(created).toEqual([{
      id: "2026-07-29",
      params: { editionDate: "2026-07-29", runId: "2026-07-29" },
      retention: { successRetention: "90 days", errorRetention: "90 days" },
    }]);

    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "published-local-date", "2026-07-30", "published", "publish", 0, 1,
      null, 0, now, now,
    ).run();
    await coordinateScheduledBriefing(
      {
        listRuns: () => new D1BriefingRepository(env.DB).listWorkflowRuns(),
        workflow: binding as never,
      },
      new Date("2026-07-30T08:30:00.000Z"),
    );
    expect(created).toHaveLength(1);
  });

  it("restarts a retryable local-date Workflow instance", async () => {
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "retryable-run", "2026-07-29", "retryable", "assess", 1, 1,
      "TRANSIENT", 0, now, now,
    ).run();
    let restarts = 0;
    const binding = {
      create: async () => { throw new Error("create must not be called"); },
      get: async (id: string) => {
        expect(id).toBe("2026-07-29");
        return {
          status: async () => ({ status: "errored" }),
          restart: async () => { restarts += 1; },
        };
      },
    };
    await coordinateScheduledBriefing(
      {
        listRuns: () => new D1BriefingRepository(env.DB).listWorkflowRuns(),
        workflow: binding as never,
      },
      new Date("2026-07-29T08:30:00.000Z"),
    );
    expect(restarts).toBe(1);
  });
});
