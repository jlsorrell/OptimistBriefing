import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import {
  ItemSchema,
} from "../../../src/contracts/editorial";
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
import type { CheckpointArtifact } from "../../../src/workflow/types";
import { createApp, type WorkflowLauncher } from "../../../src/api/app";
import {
  createD1PipelineStore,
  createProductionPipelineContext,
  createD1WorkflowLauncher,
  WorkflowRunAlreadyExistsError,
} from "../../../src/workflow/run-editorial-pipeline";
import type { BriefingRepository } from "../../../src/db/repository";
import { D1BriefingRepository } from "../../../src/db/d1-repository";
import { FakeModelProvider } from "../../../src/models/fake-provider";
import type {
  GenerateObjectRequest,
  ModelProvider,
} from "../../../src/models/provider";
import type {
  RawNewsCandidate,
  RawResearchCandidate,
} from "../../../src/sources/types";

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
      id: "reuters",
      name: "Reuters",
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

function standardFixtureItems(): Item[] {
  return [
    fixtureItem("research", "research"),
    fixtureItem("world", "world"),
    fixtureItem("technology", "technology"),
    fixtureItem("ai-policy", "ai_policy"),
    fixtureItem("dmv", "dmv"),
    fixtureItem("baltimore", "baltimore"),
  ];
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

function rawResearchCandidate(
  arxivId = "2607.12345",
  title = "Mechanistic interpretability for oversight",
  citationCount = 4,
): RawResearchCandidate {
  return {
    kind: "paper",
    sourceId: "arxiv",
    sourceName: "arXiv",
    sourceRole: "primary",
    title,
    originalUrl: `https://arxiv.org/abs/${arxivId}`,
    externalId: `arXiv:${arxivId}`,
    externalIds: [`arXiv:${arxivId}`],
    publishedAt: now,
    retrievedAt: now,
    accessLevel: "abstract",
    authors: ["Researcher Example"],
    institutions: ["Stanford"],
    abstract:
      "Mechanistic interpretability improves oversight, although the longer-term effect remains uncertain.",
    content: null,
    relatedPaperIds: [],
    metadata: {},
    preferredInstitutionMatches: ["Stanford"],
    citationCount,
    influentialCitationCount: 1,
    topics: ["Interpretability"],
  };
}

function rawNewsCandidate(
  id: string,
  section: "world" | "technology" | "ai_policy" | "dmv" | "baltimore",
  externalId = id,
): RawNewsCandidate {
  const evidence =
    `Source ${id} adopted an evaluation standard, although implementation remains uncertain.`;
  return {
    kind: "article",
    sourceId: id,
    sourceName: `Source ${id}`,
    sourceRole: "reporting",
    title: `Source ${id} adopts an evaluation standard`,
    originalUrl: `https://${id}.example.com/standard`,
    externalId,
    externalIds: [externalId],
    publishedAt: now,
    retrievedAt: now,
    accessLevel: "full_text",
    authors: [],
    institutions: [],
    abstract: evidence,
    content: null,
    relatedPaperIds: [],
    metadata: { primarySection: section },
    canCorroborateFacts: true,
    sectionEligibility: [section],
    namedEntities: [`Entity ${id}`],
    primaryDocumentUrl: null,
    primaryDocumentUrls: [],
    eventFamilies: [`evaluation-standard-${id}`],
    materialFacts: [],
  };
}

function packetValue(sourcePacket: string, label: string): string {
  const match = new RegExp(`^${label}: (.+)$`, "m").exec(sourcePacket);
  if (match?.[1] === undefined) {
    throw new Error(`Missing ${label} in source packet.`);
  }
  return match[1];
}

function packetAccessLevel(
  sourcePacket: string,
): StructuredSummary["accessLevel"] {
  const value = packetValue(sourcePacket, "access_level");
  if (
    value === "metadata" ||
    value === "abstract" ||
    value === "full_text" ||
    value === "secondary"
  ) {
    return value;
  }
  throw new Error(`Unsupported source-packet access level: ${value}`);
}

function packetExcerpt(sourcePacket: string): string {
  const match = /^\[1\] (.+)$/m.exec(sourcePacket);
  if (match?.[1] === undefined) {
    throw new Error("Missing excerpt in source packet.");
  }
  return match[1];
}

class GroundedProductionProvider implements ModelProvider {
  readonly embedRequests: (readonly string[])[] = [];
  readonly generateRequests: GenerateObjectRequest[] = [];
  failNextSummary = true;

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    this.embedRequests.push([...texts]);
    const newsMarkers = [
      "Source reuters",
      "Source nist",
      "Source federal-register",
      "Source wtop",
      "Source wypr",
    ];
    return texts.map((text) => {
      const newsIndex = newsMarkers.findIndex((marker) => text.includes(marker));
      if (newsIndex >= 0) {
        return Array.from(
          { length: 6 },
          (_, index) => index === newsIndex + 1 ? 1 : 0,
        );
      }
      return [1, 0, 0, 0, 0, 0];
    });
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    this.generateRequests.push(structuredClone(input));
    if (input.schemaName !== "structured_summary") {
      throw new Error(`Unexpected schema: ${input.schemaName}`);
    }
    if (this.failNextSummary) {
      this.failNextSummary = false;
      throw new Error("TRANSIENT_SUMMARY_FAILURE");
    }
    const sourceId = packetValue(input.sourcePacket, "source_id");
    const title = packetValue(input.sourcePacket, "title");
    const evidence = packetExcerpt(input.sourcePacket);
    const accessLevel = packetAccessLevel(input.sourcePacket);
    const provenance = {
      sourceIds: [sourceId],
      evidenceExcerpt: evidence,
    };
    return {
      title,
      oneSentence: evidence,
      whyItMatters: evidence,
      uncertainty: evidence,
      claims: [{
        text: evidence,
        sourceIds: [sourceId],
        evidenceExcerpt: evidence,
      }],
      accessLevel,
      provenance: {
        title: provenance,
        oneSentence: provenance,
        whyItMatters: provenance,
        uncertainty: provenance,
      },
    };
  }
}

class RankingEmbeddingProvider implements ModelProvider {
  private basis(index: number): number[] {
    return Array.from({ length: 7 }, (_, position) =>
      position === index ? 1 : 0
    );
  }

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => {
      if (
        text.includes("Interpretability study") ||
        text.includes("AI safety, alignment")
      ) {
        return this.basis(0);
      }
      if (
        text.includes("Source nist") ||
        text.includes("Oversight and governance")
      ) {
        return this.basis(1);
      }
      if (
        text.includes("Source federal-register") ||
        text.includes("Secure computation and machine learning")
      ) {
        return this.basis(2);
      }
      const worldIndex = ["world-a", "world-b", "world-c", "world-d"]
        .findIndex((id) => text.includes(`Source ${id}`));
      if (worldIndex >= 0) return this.basis(worldIndex + 3);
      throw new Error(`Unexpected embedding input: ${text.slice(0, 80)}`);
    });
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    throw new Error(`Unexpected generation request: ${input.schemaName}`);
  }
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

  async readArtifact(
    runId: string,
    step: string,
  ): Promise<CheckpointArtifact<unknown> | null> {
    return (
      this.artifacts.get(`${runId}:${step}`) as
        | CheckpointArtifact<unknown>
        | undefined
    ) ?? null;
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
  const items = standardFixtureItems();
  return {
    editionDate: "2026-07-30",
    runId: "run-fixture",
    now: () => now,
    store: new FixtureStore(),
    collect: async () => items,
    normalize: async (value) => value.map((item) => ItemSchema.parse(item)),
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

function d1FixturePipelineContext(
  overrides: Partial<Omit<PipelineContext, "store">>,
): PipelineContext {
  return {
    ...fixturePipelineContext(overrides),
    store: createD1PipelineStore(env.DB),
  };
}

async function seedD1Items(items: readonly Item[]): Promise<void> {
  await new D1BriefingRepository(env.DB).upsertItems(items);
}

async function publishD1FixtureEdition(
  repo: D1BriefingRepository,
  editionDate: string,
  runId: string,
): Promise<void> {
  const item = fixtureItem(`prior-${runId}`, "world");
  const draft = await repo.createDraftEdition(editionDate, runId);
  await repo.replaceEditionEntries(draft.id, [{
    id: `entry-${runId}`,
    editionId: draft.id,
    itemId: null,
    section: "world",
    position: 0,
    summary: fixtureSummary(item),
    selectionReasons: ["Prior visible edition."],
    sourceRefs: item.sourceRefs,
  }]);
  await repo.publishEdition(draft.id, now, "published");
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

  it("rejects a corrupt durable composition checkpoint before publication", async () => {
    const fixture = fixturePipelineContext({
      editionDate: "2033-01-01",
      runId: "run-corrupt-composition",
    });
    const store = createD1PipelineStore(env.DB);
    const context: PipelineContext = { ...fixture, store };
    await store.createRun({
      id: context.runId,
      editionDate: context.editionDate,
      status: "retryable",
      currentStep: "compose",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    const collected = await context.collect();
    const items = await context.normalize(collected);
    const summaries = await context.synthesize(items);
    const validated = await context.validate(summaries);
    const outputs = new Map<string, unknown>([
      ["collect", collected],
      ...["normalize", "enrich", "prefilter", "assess", "score", "cluster", "shortlist"]
        .map((step) => [step, items] as const),
      ["synthesize", summaries],
      ["validate", validated],
    ]);
    for (const [step, output] of outputs) {
      await store.saveCheckpoint(context.runId, step as (typeof PIPELINE_STEPS)[number], {
        output,
        attempts: 1,
        durationMs: 0,
        itemCount: Array.isArray(output) ? output.length : 1,
        estimatedCostUsd: 0,
      });
    }
    await env.DB.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "corrupt-compose-event",
      context.runId,
      "workflow_checkpoint",
      JSON.stringify({
        step: "compose",
        artifact: {
          output: {
            edition: {
              id: "edition:run-corrupt-composition",
              editionDate: context.editionDate,
              runId: context.runId,
              status: "draft",
              readingMinutes: 20,
              publishedAt: null,
              createdAt: now,
              metadata: { missingSections: [], sourceFailures: [] },
            },
            entries: [{
              id: "edition:run-corrupt-composition:entry:0",
              editionId: "edition:run-corrupt-composition",
              itemId: items[0]!.id,
              section: "research",
              position: 0,
              summary: fixtureSummary(items[0]!),
              selectionReasons: ["Fixture selection."],
              sourceRefs: items[0]!.sourceRefs,
              unexpected: "must not be stripped",
            }],
            status: "published",
            missingSections: [],
            sourceFailures: [],
          },
          attempts: 1,
          durationMs: 0,
          itemCount: 1,
          estimatedCostUsd: 0,
        },
      }),
      now,
    ).run();

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "INVALID_CHECKPOINT_ARTIFACT:compose",
    );
    expect(
      await env.DB.prepare(
        "SELECT status FROM editions WHERE edition_date = ?",
      ).bind(context.editionDate).first(),
    ).toBeNull();
  });

  it("durably records a failed attempt and resumes without repeating completed D1 checkpoints", async () => {
    const items = standardFixtureItems();
    await seedD1Items(items);
    let collectCalls = 0;
    let normalizeCalls = 0;
    let enrichCalls = 0;
    let failEnrich = true;
    const context = d1FixturePipelineContext({
      editionDate: "2033-02-01",
      runId: "run-d1-attempt-resume",
      collect: async () => {
        collectCalls += 1;
        return items;
      },
      normalize: async (candidates) => {
        normalizeCalls += 1;
        return candidates.map((candidate) => ItemSchema.parse(candidate));
      },
      enrich: async (candidates) => {
        enrichCalls += 1;
        if (failEnrich) throw new Error("TRANSIENT_ENRICH_FAILURE");
        return candidates;
      },
    });

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "TRANSIENT_ENRICH_FAILURE",
    );
    failEnrich = false;
    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "published",
    });

    expect({ collectCalls, normalizeCalls, enrichCalls }).toEqual({
      collectCalls: 1,
      normalizeCalls: 1,
      enrichCalls: 2,
    });
    const events = await env.DB.prepare(
      `SELECT event_type, event_json FROM audit_events
       WHERE run_id = ? AND event_type IN (?, ?)
       ORDER BY created_at, id`,
    ).bind(
      context.runId,
      "workflow_attempt",
      "workflow_attempt_failed",
    ).all<{ event_type: string; event_json: string }>();
    const parsed = events.results.map((event) => ({
      eventType: event.event_type,
      ...JSON.parse(event.event_json) as {
        step: string;
        attempt: number;
        status?: string;
        error?: string;
      },
    }));
    expect(parsed.filter((event) =>
      event.eventType === "workflow_attempt" && event.step === "enrich"
    ).map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(parsed).toContainEqual(expect.objectContaining({
      eventType: "workflow_attempt_failed",
      step: "enrich",
      attempt: 1,
      error: "TRANSIENT_ENRICH_FAILURE",
    }));
    expect(
      await env.DB.prepare(
        "SELECT status, attempt_count FROM workflow_runs WHERE id = ?",
      ).bind(context.runId).first(),
    ).toEqual({ status: "published", attempt_count: 2 });
  });

  it("invalidates a partial D1 checkpoint chain and improves it to published", async () => {
    const items = standardFixtureItems();
    await seedD1Items(items);
    let refreshed = false;
    let collectCalls = 0;
    const context = d1FixturePipelineContext({
      editionDate: "2033-02-02",
      runId: "run-d1-partial-refresh",
      collect: async () => {
        collectCalls += 1;
        return items;
      },
      synthesize: async (candidates) => candidates
        .filter((item) =>
          refreshed || ["research", "world", "dmv"].includes(item.id),
        )
        .map((item) => ({ item, summary: fixtureSummary(item) })),
    });

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "partial",
    });
    refreshed = true;
    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "published",
    });

    expect(collectCalls).toBe(2);
    expect(
      await new D1BriefingRepository(env.DB).getEditionByDate(
        context.editionDate,
      ),
    ).toMatchObject({
      status: "published",
      entries: expect.arrayContaining([
        expect.objectContaining({ itemId: "technology" }),
        expect.objectContaining({ itemId: "baltimore" }),
      ]),
    });
    const attempts = await env.DB.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = ?`,
    ).bind(context.runId, "workflow_attempt").all<{ event_json: string }>();
    expect(attempts.results.map(({ event_json }) =>
      JSON.parse(event_json) as { step: string; attempt: number }
    ).filter(({ step }) => step === "collect").map(({ attempt }) => attempt))
      .toEqual([1, 2]);
    const checkpoints = await env.DB.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = ?`,
    ).bind(context.runId, "workflow_checkpoint")
      .all<{ event_json: string }>();
    expect(checkpoints.results.map(({ event_json }) =>
      JSON.parse(event_json) as { step: string }
    ).filter(({ step }) => step === "collect")).toHaveLength(1);
  });

  it("keeps the prior visible edition when the atomic D1 persist batch fails", async () => {
    const repo = new D1BriefingRepository(env.DB);
    await publishD1FixtureEdition(
      repo,
      "2033-02-03",
      "run-d1-prior-visible",
    );
    const items = standardFixtureItems();
    await seedD1Items(items);
    const context = d1FixturePipelineContext({
      editionDate: "2033-02-04",
      runId: "run-d1-atomic-persist",
      collect: async () => items,
    });
    await env.DB.prepare(
      `CREATE TRIGGER fail_task_9_atomic_persist
       BEFORE INSERT ON edition_entries
       WHEN NEW.id LIKE 'edition:run-d1-atomic-persist:%'
       BEGIN
         SELECT RAISE(ABORT, 'FORCED_ATOMIC_PERSIST_FAILURE');
       END`,
    ).run();

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "FORCED_ATOMIC_PERSIST_FAILURE",
    );
    expect((await repo.getLatestEdition())?.editionDate).toBe("2033-02-03");
    expect(
      await env.DB.prepare(
        "SELECT id FROM editions WHERE edition_date = ?",
      ).bind(context.editionDate).first(),
    ).toBeNull();
  });

  it("excludes an invalid validated summary from D1 publication", async () => {
    const invalidItemId = "technology";
    const items = [
      ...standardFixtureItems(),
      fixtureItem("world-extra", "world"),
    ];
    await seedD1Items(items);
    const context = d1FixturePipelineContext({
      editionDate: "2033-02-05",
      runId: "run-d1-invalid-summary",
      collect: async () => items,
      validate: async (entries) => entries.map((entry) => ({
        ...entry,
        valid: entry.item.id !== invalidItemId,
        ...(entry.item.id === invalidItemId
          ? { validationErrors: ["unsupported_claim"] }
          : {}),
      })),
    });

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "published",
    });
    const edition = await new D1BriefingRepository(env.DB).getEditionByDate(
      context.editionDate,
    );
    expect(edition?.entries).toHaveLength(6);
    expect(edition?.entries.map(({ itemId }) => itemId))
      .not.toContain(invalidItemId);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM summaries WHERE item_id = ?",
      ).bind(invalidItemId).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("runs the established production editorial stages with a distinct assessment provider", async () => {
    const summaryProvider = new FakeModelProvider({
      embeddingBatches: [[
        [1, 0],
        [0, 1],
        [0, 1],
        [1, 0],
        [0, 1],
        [0.5, 0.5],
      ]],
    });
    const assessmentProvider = new FakeModelProvider({
      generatedObjects: [{
        technicalQuality: 0.9,
        novelty: 0.8,
        strengths: ["The abstract describes a concrete method."],
        limitations: ["Only abstract evidence was supplied."],
        rationale: "The available abstract supports a strong assessment.",
        accessLevel: "abstract",
      }],
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-02",
      runId: "run-production-stages",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: summaryProvider,
        assessment: assessmentProvider,
      },
      collectCandidates: async () => [
        rawResearchCandidate(),
        rawNewsCandidate("world-one", "world", "world-duplicate"),
        rawNewsCandidate("world-two", "world", "world-duplicate"),
        rawNewsCandidate("dmv-one", "dmv"),
      ],
    });

    const collected = await context.collect();
    const normalized = await context.normalize(collected);
    const enriched = await context.enrich(normalized);
    const prefilted = await context.prefilter(enriched);
    const assessed = await context.assess(prefilted);
    const scored = await context.score(assessed);
    const clustered = await context.cluster(scored);
    const shortlisted = await context.shortlist(clustered);

    expect(normalized).toHaveLength(3);
    expect(summaryProvider.embedRequests).toHaveLength(1);
    expect(summaryProvider.embedRequests[0]).toHaveLength(6);
    expect(assessmentProvider.generateRequests).toHaveLength(1);
    expect(assessmentProvider.generateRequests[0]?.schemaName).toBe(
      "research_assessment",
    );
    expect(scored.every((item) => {
      const workflow = item.metadata.workflow as Record<string, unknown>;
      return item.kind === "paper"
        ? workflow.researchScore !== undefined
        : workflow.newsScore !== undefined;
    })).toBe(true);
    expect(clustered.filter((item) => item.kind !== "paper").every(
      (item) => item.id.startsWith("cluster-"),
    )).toBe(true);
    expect(new Set(shortlisted.map((item) => item.metadata.section))).toEqual(
      new Set(["research", "world", "dmv"]),
    );
  });

  it("keeps higher-ranked technology and AI policy in the authoritative morning brief and excludes research radar", async () => {
    const assessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract" as const,
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-03",
      runId: "run-production-ranking",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new RankingEmbeddingProvider(),
        assessment: new FakeModelProvider({
          generatedObjects: Array.from({ length: 4 }, () => assessment),
        }),
      },
      collectCandidates: async () => [
        rawResearchCandidate(
          "2607.10001",
          "Interpretability study Alpha for oversight",
          100,
        ),
        rawResearchCandidate(
          "2607.10002",
          "Interpretability study Beta for oversight",
          100,
        ),
        rawResearchCandidate(
          "2607.10003",
          "Interpretability study Gamma for oversight",
          100,
        ),
        rawResearchCandidate(
          "2607.10004",
          "Interpretability study Radar for oversight",
          0,
        ),
        rawNewsCandidate("world-a", "world"),
        rawNewsCandidate("world-b", "world"),
        rawNewsCandidate("world-c", "world"),
        rawNewsCandidate("world-d", "world"),
        rawNewsCandidate("nist", "technology"),
        rawNewsCandidate("federal-register", "ai_policy"),
      ],
    });

    const collected = await context.collect();
    const normalized = await context.normalize(collected);
    const enriched = await context.enrich(normalized);
    const prefilted = await context.prefilter(enriched);
    const assessed = await context.assess(prefilted);
    const scored = await context.score(assessed);
    const clustered = await context.cluster(scored);
    const shortlisted = await context.shortlist(clustered);

    expect(clustered.filter(
      (item) => item.kind === "paper" || item.kind === "blog",
    )).toHaveLength(4);
    expect(shortlisted).toHaveLength(8);
    expect(shortlisted.filter(
      (item) => item.kind === "paper" || item.kind === "blog",
    )).toHaveLength(3);
    expect(shortlisted.map((item) => item.metadata.section)).toEqual(
      expect.arrayContaining(["technology", "ai_policy"]),
    );
    expect(shortlisted.map((item) => item.metadata.section))
      .not.toContain("research_radar");
  });

  it("persists normalized production items before clustered-news publication and does not re-persist them on resume", async () => {
    const editionDate = "2033-02-07";
    const runId = "run-production-d1-persistence";
    const store = createD1PipelineStore(env.DB);
    const repository = new D1BriefingRepository(env.DB);
    const summaryProvider = new GroundedProductionProvider();
    const assessmentProvider = new FakeModelProvider({
      generatedObjects: [{
        technicalQuality: 0.9,
        novelty: 0.8,
        strengths: ["The abstract describes a concrete method."],
        limitations: ["Only abstract evidence was supplied."],
        rationale: "The available abstract supports a strong assessment.",
        accessLevel: "abstract",
      }],
    });
    const persistedBatches: string[][] = [];
    const persistItems = async (items: readonly Item[]) => {
      persistedBatches.push(items.map(({ id }) => id));
      await repository.upsertItems(items);
    };
    const contextOptions = {
      editionDate,
      runId,
      store,
      now: () => now,
      providers: {
        summary: summaryProvider,
        assessment: assessmentProvider,
      },
      collectCandidates: async () => [
        rawResearchCandidate(),
        rawNewsCandidate("reuters", "world"),
        rawNewsCandidate("nist", "technology"),
        rawNewsCandidate("federal-register", "ai_policy"),
        rawNewsCandidate("wtop", "dmv"),
        rawNewsCandidate("wypr", "baltimore"),
      ],
      persistItems,
    };
    const context = createProductionPipelineContext(contextOptions);

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "TRANSIENT_SUMMARY_FAILURE",
    );
    expect(persistedBatches).toHaveLength(1);

    await expect(runEditorialPipeline(context)).resolves.toEqual({
      runId,
      status: "published",
      missingSections: [],
    });
    expect(persistedBatches).toHaveLength(1);

    const normalizedIds = new Set(persistedBatches[0]);
    const edition = await repository.getEditionByDate(editionDate);
    expect(edition?.entries).toHaveLength(6);
    expect(edition?.entries.every(
      ({ itemId }) => itemId !== null && normalizedIds.has(itemId),
    )).toBe(true);
    expect(JSON.stringify(
      (await store.readArtifact(runId, "shortlist"))?.output,
    )).toContain('"id":"cluster-');
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM edition_entries AS entry
         JOIN editions AS edition ON edition.id = entry.edition_id
         LEFT JOIN items AS item ON item.id = entry.item_id
         WHERE edition.edition_date = ? AND item.id IS NULL`,
      ).bind(editionDate).first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM items WHERE id LIKE 'cluster-%'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
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
      workflow: createD1WorkflowLauncher(env.DB, {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      }),
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
