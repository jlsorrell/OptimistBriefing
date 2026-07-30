import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
  Item,
  StructuredSummary,
} from "../../../src/contracts/editorial";
import {
  PIPELINE_STEPS,
  runEditorialPipeline,
  type PipelineContext,
  type PipelineRun,
  type PipelineStore,
} from "../../../src/workflow/run-editorial-pipeline";
import { createApp, type WorkflowLauncher } from "../../../src/api/app";
import {
  createD1WorkflowLauncher,
  WorkflowRunAlreadyExistsError,
} from "../../../src/workflow/run-editorial-pipeline";
import type { BriefingRepository } from "../../../src/db/repository";
import { D1BriefingRepository } from "../../../src/db/d1-repository";
import { FakeModelProvider } from "../../../src/models/fake-provider";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const now = "2026-07-30T09:00:00.000Z";

function fixtureItem(id: string, section: string): Item {
  return {
    id,
    kind: section === "research" ? "paper" : "article",
    canonicalUrl: `https://example.com/${id}`,
    title: `${section} item ${id}`,
    publishedAt: now,
    sourceRefs: [{
      id: `source-${id}`,
      name: "Fixture source",
      url: `https://example.com/source/${id}`,
      role: "reporting",
      retrievedAt: now,
    }],
    accessLevel: "abstract",
    primaryTopic: section,
    tags: [section],
    normalizedText: `${section} fixture evidence`,
    metadata: { section },
    createdAt: now,
    expiresAt: null,
  };
}

function fixtureSummary(item: Item): StructuredSummary {
  return {
    title: item.title,
    oneSentence: `${item.title} is supported by the fixture source.`,
    whyItMatters: "It provides a validated fixture development.",
    uncertainty: "Its longer-term effects remain uncertain.",
    claims: [{
      text: `${item.title} is supported by the fixture source.`,
      sourceIds: [item.sourceRefs[0]!.id],
      evidenceExcerpt: `${item.title} is supported by the fixture source.`,
    }],
    accessLevel: "abstract",
  };
}

class FixtureStore implements PipelineStore {
  readonly checkpoints = new Map<string, Set<string>>();
  readonly artifacts = new Map<string, unknown>();
  readonly runs = new Map<string, PipelineRun>();
  readonly editions = new Map<string, EditionWithEntries>();

  async getRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  async createRun(run: PipelineRun) {
    if ([...this.runs.values()].some((value) => value.editionDate === run.editionDate)) {
      throw new Error("RUN_ALREADY_EXISTS");
    }
    this.runs.set(run.id, run);
  }

  async saveRun(run: PipelineRun) {
    this.runs.set(run.id, run);
  }

  async readCheckpoint(runId: string, step: string) {
    return this.checkpoints.get(runId)?.has(step) ?? false;
  }

  async saveCheckpoint(runId: string, step: string, output: unknown) {
    this.checkpoints.set(runId, new Set([...(this.checkpoints.get(runId) ?? []), step]));
    this.artifacts.set(`${runId}:${step}`, structuredClone(output));
  }

  async readArtifact<T>(runId: string, step: string): Promise<T | null> {
    return (this.artifacts.get(`${runId}:${step}`) as T | undefined) ?? null;
  }

  async beginAttempt() { return 1; }
  async failAttempt() { /* fixture records only successful artifacts */ }
  async invalidateFrom(runId: string) {
    this.checkpoints.delete(runId);
    for (const key of [...this.artifacts.keys()]) {
      if (key.startsWith(`${runId}:`)) this.artifacts.delete(key);
    }
  }

  async createDraft(edition: Edition) {
    this.editions.set(edition.editionDate, { ...edition, entries: [] });
  }

  async replaceEntries(editionId: string, entries: readonly EditionEntry[]) {
    for (const [date, edition] of this.editions) {
      if (edition.id === editionId) this.editions.set(date, { ...edition, entries: [...entries] });
    }
  }

  async publish(editionId: string, status: "published" | "partial") {
    for (const [date, edition] of this.editions) {
      if (edition.id === editionId) this.editions.set(date, {
        ...edition,
        status,
        publishedAt: now,
      });
    }
  }

  async getLatestEdition() {
    return [...this.editions.values()]
      .filter((edition) => edition.status === "published" || edition.status === "partial")
      .sort((left, right) => right.editionDate.localeCompare(left.editionDate))[0] ?? null;
  }

  async persistEdition(edition: Edition, entries: readonly EditionEntry[], status: "draft" | "published" | "partial") {
    const stored: EditionWithEntries = { ...edition, status, publishedAt: status === "draft" ? null : now, entries: [...entries] };
    const current = this.editions.get(edition.editionDate);
    if (status === "draft" && current?.status === "partial") return current;
    this.editions.set(edition.editionDate, stored);
    return stored;
  }
}

function fixturePipelineContext(
  overrides: Partial<Omit<PipelineContext, "store">> = {},
): PipelineContext & { store: FixtureStore } {
  const items = [
    fixtureItem("research", "research"),
    fixtureItem("world", "world"),
    fixtureItem("technology", "technology"),
    fixtureItem("ai-policy", "ai_policy"),
    fixtureItem("dmv", "dmv"),
    fixtureItem("baltimore", "baltimore"),
  ];
  return {
    editionDate: "2026-07-30",
    runId: "run-fixture",
    now: () => now,
    store: new FixtureStore(),
    collect: async () => items,
    normalize: async (value) => value,
    enrich: async (value) => value,
    prefilter: async (value) => value,
    assess: async (value) => value,
    score: async (value) => value,
    cluster: async (value) => value,
    shortlist: async (value) => value,
    synthesize: async (value) => value.map((item) => ({ item, summary: fixtureSummary(item) })),
    validate: async (value) => value.map((entry) => ({ ...entry, valid: true })),
    ...overrides,
  };
}

describe("manual editorial run", () => {
  it("collects, validates, and atomically publishes one edition", async () => {
    // This fails if the orchestrator omits validation, composition, or publication.
    const context = fixturePipelineContext();
    const result = await runEditorialPipeline(context);

    expect(result.status).toBe("published");
    const latest = await context.store.getLatestEdition();
    expect(latest?.entries.some((entry) => entry.section === "research")).toBe(true);
    expect(latest?.entries).toHaveLength(6);
    expect(await Promise.all(PIPELINE_STEPS.map((step) => context.store.readCheckpoint("run-fixture", step)))).toEqual(
      PIPELINE_STEPS.map(() => true),
    );
  });

  it("publishes a source-partial edition only when research, nonlocal news, and DMV coverage remain", async () => {
    const context = fixturePipelineContext({
      runId: "run-partial",
      synthesize: async (items) => items
        .filter((item) => ["research", "world", "dmv"].includes(item.id))
        .map((item) => ({ item, summary: fixtureSummary(item) })),
    });

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({ status: "partial" });
    expect((await context.store.getLatestEdition())?.status).toBe("partial");
  });

  it("leaves a failed minimum draft unpublished and preserves the prior edition", async () => {
    const context = fixturePipelineContext({
      runId: "run-failed-minimum",
      synthesize: async (items) => items
        .filter((item) => item.id === "research")
        .map((item) => ({ item, summary: fixtureSummary(item) })),
    });
    const prior: EditionWithEntries = {
      id: "prior",
      editionDate: "2026-07-29",
      runId: "prior-run",
      status: "published",
      readingMinutes: 20,
      publishedAt: now,
      createdAt: now,
      entries: [],
    };
    context.store.editions.set(prior.editionDate, prior);

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({ status: "failed" });
    expect(await context.store.getLatestEdition()).toEqual(prior);
  });

  it("fails six valid entries when they omit required coverage", async () => {
    const context = fixturePipelineContext({
      runId: "run-six-world-only",
      collect: async () => Array.from({ length: 6 }, (_, index) =>
        fixtureItem(`world-${index}`, "world"),
      ),
    });

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "failed",
      missingSections: ["research", "dmv_or_baltimore"],
    });
    expect(await context.store.getLatestEdition()).toBeNull();
  });

  it("resumes an interrupted run from persisted checkpoints without repeating completed work", async () => {
    let completedStageWasRepeated = false;
    const context = fixturePipelineContext({ runId: "run-resume" });
    context.normalize = async () => {
      completedStageWasRepeated = true;
      throw new Error("completed normalize must not run");
    };
    await context.store.createRun({
      id: context.runId,
      editionDate: context.editionDate,
      status: "retryable",
      currentStep: "enrich",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    const collected = await context.collect();
    for (const step of ["collect", "normalize", "enrich"] as const) {
      await context.store.saveCheckpoint(context.runId, step, {
        output: collected,
        attempts: 1,
        durationMs: 0,
        itemCount: collected.length,
        estimatedCostUsd: 0,
      });
    }

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({ status: "published" });
    expect(completedStageWasRepeated).toBe(false);
    expect(await context.store.readCheckpoint(context.runId, "publish")).toBe(true);
  });

  it("returns the original published result for an idempotent retry", async () => {
    const context = fixturePipelineContext({ runId: "run-idempotent" });
    const first = await runEditorialPipeline(context);
    const second = await runEditorialPipeline(context);

    expect(second).toEqual(first);
  });

  it("requires authentication and exposes only the allowed manual start and retry states", async () => {
    const calls: string[] = [];
    const workflow: WorkflowLauncher = {
      start: async ({ editionDate, actorEmail }) => {
        calls.push(`start:${editionDate}:${actorEmail}`);
        if (editionDate === "2026-07-31") throw new WorkflowRunAlreadyExistsError();
        return { runId: "run-admin" };
      },
      resume: async ({ runId, actorEmail }) => {
        calls.push(`resume:${runId}:${actorEmail}`);
      },
    };
    const app = createApp({
      repository: {} as BriefingRepository,
      authVerifier: async () => ({ email: "reader@example.com" }),
      workflow,
    });

    await expect(app.request("/api/admin/runs", {
      method: "POST",
      body: JSON.stringify({ editionDate: "2026-07-30" }),
    })).resolves.toMatchObject({ status: 401 });
    await expect(app.request("/api/admin/runs", {
      method: "POST",
      headers: { "CF-Access-Jwt-Assertion": "signed", "content-type": "application/json" },
      body: JSON.stringify({ editionDate: "2026-07-30" }),
    })).resolves.toMatchObject({ status: 202 });
    await expect(app.request("/api/admin/runs", {
      method: "POST",
      headers: { "CF-Access-Jwt-Assertion": "signed", "content-type": "application/json" },
      body: JSON.stringify({ editionDate: "2026-07-31" }),
    })).resolves.toMatchObject({ status: 409 });
    await expect(app.request("/api/admin/runs/run-admin/resume", {
      method: "POST",
      headers: { "CF-Access-Jwt-Assertion": "signed" },
    })).resolves.toMatchObject({ status: 202 });
    expect(calls).toEqual([
      "start:2026-07-30:reader@example.com",
      "start:2026-07-31:reader@example.com",
      "resume:run-admin:reader@example.com",
    ]);
  });

  it("returns RUN_ALREADY_EXISTS and audits duplicate D1-backed start requests", async () => {
    const app = createApp({
      repository: new D1BriefingRepository(env.DB),
      authVerifier: async () => ({ email: "reader@example.com" }),
      workflow: createD1WorkflowLauncher(env.DB, new FakeModelProvider()),
    });
    const request = () => app.request("/api/admin/runs", {
      method: "POST",
      headers: { "CF-Access-Jwt-Assertion": "signed", "content-type": "application/json" },
      body: JSON.stringify({ editionDate: "2031-01-01" }),
    });

    const first = await request();
    expect(first.status, await first.text()).toBe(202);
    await expect(request()).resolves.toMatchObject({ status: 409 });
    const audit = await env.DB.prepare(
      "SELECT event_type FROM audit_events WHERE event_type = ?",
    ).bind("manual_run_started").all<{ event_type: string }>();
    expect(audit.results).toHaveLength(2);
  });
});
