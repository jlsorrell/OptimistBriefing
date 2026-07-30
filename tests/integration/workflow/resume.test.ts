import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
  Item,
  StructuredSummary,
} from "../../../src/contracts/editorial";
import {
  RunParamsSchema,
  ScheduledModelConfigSchema,
} from "../../../src/workflow/daily-briefing-workflow";
import {
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
import { coordinateScheduledBriefing } from "../../../src/worker";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const now = "2026-07-29T08:30:00.000Z";

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

  async getRun(runId: string) { return this.runs.get(runId) ?? null; }
  async createRun(run: PipelineRun) { this.runs.set(run.id, run); }
  async saveRun(run: PipelineRun) { this.runs.set(run.id, run); }
  async readCheckpoint(runId: string, step: PipelineStep) {
    return this.artifacts.has(`${runId}:${step}`);
  }
  async saveCheckpoint(runId: string, step: PipelineStep, artifact: CheckpointArtifact) {
    this.artifacts.set(`${runId}:${step}`, structuredClone(artifact));
  }
  async readArtifact(runId: string, step: PipelineStep) {
    return this.artifacts.get(`${runId}:${step}`) ?? null;
  }
  async beginAttempt(_runId: string, step: PipelineStep) {
    const attempt = (this.attempts.get(step) ?? 0) + 1;
    this.attempts.set(step, attempt);
    return attempt;
  }
  async failAttempt() { /* failure is represented by the run */ }
  async invalidateFrom() { this.artifacts.clear(); }
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
    },
  );

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
      { DB: env.DB, DAILY_BRIEFING: binding as never },
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
      { DB: env.DB, DAILY_BRIEFING: binding as never },
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
      { DB: env.DB, DAILY_BRIEFING: binding as never },
      new Date("2026-07-29T08:30:00.000Z"),
    );
    expect(restarts).toBe(1);
  });
});
