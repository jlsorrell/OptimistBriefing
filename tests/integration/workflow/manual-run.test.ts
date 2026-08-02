import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

import {
  ItemSchema,
  StructuredSummarySchema,
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
  createD1ProductionPipelineContext,
  createProductionPipelineContext,
  createD1WorkflowLauncher,
  WorkflowRunAlreadyExistsError,
} from "../../../src/workflow/run-editorial-pipeline";
import {
  approvedBaselinePreferences,
  ReaderPreferencesSchema,
  type BriefingRepository,
  type ReaderPreferences,
} from "../../../src/db/repository";
import { D1BriefingRepository } from "../../../src/db/d1-repository";
import { FakeModelProvider } from "../../../src/models/fake-provider";
import { clusterNews } from "../../../src/editorial/cluster";
import { composeEdition } from "../../../src/workflow/compose-edition";
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

function fixturePreferences(
  overrides: Partial<Pick<
    ReaderPreferences,
    | "topicWeights"
    | "sourceWeights"
    | "sectionBudgets"
    | "feedbackHistory"
  >> = {},
): ReaderPreferences {
  const baseline = approvedBaselinePreferences();
  return ReaderPreferencesSchema.parse({
    ...baseline,
    ...overrides,
    baseline,
    feedbackHistory: overrides.feedbackHistory ?? [],
  });
}

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

class ConcurrencyTrackingAssessmentProvider implements ModelProvider {
  active = 0;
  maximumActive = 0;
  readonly startedPackets: string[] = [];

  async embed(): Promise<readonly (readonly number[])[]> {
    throw new Error("Assessment provider must not embed.");
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.startedPackets.push(input.sourcePacket);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    this.active -= 1;
    return {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract",
    };
  }
}

class ConcurrencyTrackingSummaryProvider implements ModelProvider {
  active = 0;
  maximumActive = 0;

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    return texts.map(() => [1, 0]);
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    this.active -= 1;
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

class WrongSourceGroundingProvider implements ModelProvider {
  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    return texts.map(() => [1, 0]);
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    if (input.schemaName !== "structured_summary") {
      throw new Error(`Unexpected schema: ${input.schemaName}`);
    }
    const sourceA = {
      sourceIds: ["source-a"],
      evidenceExcerpt: "fact only from A",
    };
    return {
      title: "fact only from A",
      oneSentence: "fact only from A",
      whyItMatters: "fact only from A",
      uncertainty: "fact only from A",
      claims: [{
        text: "fact only from A",
        sourceIds: ["source-b"],
        evidenceExcerpt: "fact only from A",
      }],
      accessLevel: "full_text",
      provenance: {
        title: sourceA,
        oneSentence: sourceA,
        whyItMatters: sourceA,
        uncertainty: sourceA,
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
  readonly preferenceSnapshots = new Map<string, ReaderPreferences>();

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

  it("preserves the calculated shortlist reasons in the persisted edition", async () => {
    // This fails if composition replaces the shortlist's actual reasons.
    const item = fixtureItem("reasoned-research", "research");
    const shortlistedSelectionReasons = [
      "Strong topical fit (91%).",
      "Strong technical quality (88%).",
    ];
    const shortlisted = ItemSchema.parse({
      ...item,
      metadata: {
        ...item.metadata,
        workflow: {
          version: 1,
          section: "research",
          selectionReasons: shortlistedSelectionReasons,
        },
      },
    });
    const context = fixturePipelineContext({
      runId: "run-selection-reasons",
    });
    const composition = await composeEdition(
      context,
      [{
        item: shortlisted,
        summary: fixtureSummary(shortlisted),
        valid: true,
      }],
      [item],
    );
    await context.store.persistEdition(
      composition.edition,
      composition.entries,
      "partial",
    );
    const persistedEdition = await context.store.getLatestEdition();

    expect(persistedEdition?.entries[0]!.selectionReasons)
      .toEqual(shortlistedSelectionReasons);
  });

  it("uses the editorial shortlist fallback when calculated reasons are absent", async () => {
    // This fails if composition revives the old validation placeholder or
    // emits an empty reason list.
    const item = fixtureItem("fallback-research", "research");
    const context = fixturePipelineContext({
      runId: "run-selection-reason-fallback",
    });

    const composition = await composeEdition(
      context,
      [{ item, summary: fixtureSummary(item), valid: true }],
      [item],
    );

    expect(composition.entries[0]!.selectionReasons).toEqual([
      "Selected by the editorial shortlist.",
    ]);
  });

  it("bounds deterministic unique source-failure metadata during composition", async () => {
    const item = fixtureItem("bounded-source-failures", "research");
    const context = fixturePipelineContext({
      runId: "run-bounded-source-failures",
    });
    context.sourceFailures = [
      `${"a".repeat(200)}:fetch`,
      "duplicate:parse",
      "duplicate:parse",
      ...Array.from({ length: 70 }, (_, index) =>
        `source-${String(index).padStart(2, "0")}:timeout`
      ),
    ];

    const composition = await composeEdition(
      context,
      [{ item, summary: fixtureSummary(item), valid: true }],
      [item],
    );
    const failures = composition.edition.metadata!.sourceFailures;

    expect(failures).toHaveLength(64);
    expect(failures).toEqual([...failures].sort());
    expect(new Set(failures).size).toBe(failures.length);
    expect(failures.every((failure) => [...failure].length <= 200)).toBe(true);
    expect(composition.sourceFailures).toEqual(failures);
  });

  it("delegates every durable checkpoint through an optional executor while the manual path remains direct", async () => {
    const delegated: string[] = [];
    const context = fixturePipelineContext({
      checkpointExecutor: async (checkpoint, execute) => {
        delegated.push(checkpoint);
        return execute();
      },
    });

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "published",
    });
    expect(delegated).toEqual(PIPELINE_STEPS);
  });

  it("reconciles a saved D1 checkpoint inside a retried workflow step without repeating provider work", async () => {
    let synthesisCalls = 0;
    let failRunSave = true;
    const context = fixturePipelineContext({
      synthesize: async (items) => {
        synthesisCalls += 1;
        return items.map((item) => ({ item, summary: fixtureSummary(item) }));
      },
      checkpointExecutor: async (_checkpoint, execute) => {
        try {
          return await execute();
        } catch {
          return execute();
        }
      },
    });
    const saveRun = context.store.saveRun.bind(context.store);
    context.store.saveRun = async (run) => {
      if (run.currentStep === "synthesize" && failRunSave) {
        failRunSave = false;
        throw new Error("TRANSIENT_RUN_SAVE_FAILURE");
      }
      await saveRun(run);
    };

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "published",
    });
    expect(synthesisCalls).toBe(1);
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
    const runId = "run-d1-partial-refresh";
    const store = createD1PipelineStore(env.DB);
    const context: PipelineContext = {
      ...fixturePipelineContext({
        editionDate: "2033-02-02",
        runId,
        collect: async () => {
          collectCalls += 1;
          await store.saveCollectionSourceFailures(
            runId,
            refreshed
              ? ["refreshed-source:parse"]
              : ["initial-source:fetch"],
          );
          return items;
        },
        synthesize: async (candidates) => candidates
          .filter((item) =>
            refreshed || ["research", "world", "dmv"].includes(item.id),
          )
          .map((item) => ({ item, summary: fixtureSummary(item) })),
      }),
      store,
      loadSourceFailures: () => store.readCollectionSourceFailures(runId),
    };

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
      metadata: {
        sourceFailures: ["refreshed-source:parse"],
      },
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

  it("applies topic and source weights to relevance without disabling candidates", async () => {
    // This fails if ranking ignores either configured weight, or treats zero as
    // source authorization instead of a relevance signal.
    const summary = new FakeModelProvider({
      embeddingBatches: [[
        [0.6, 0.8],
        [0.6, 0.8],
        [1, 0],
        [1, 0],
        [1, 0],
      ]],
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-12",
      runId: "run-preference-weighting",
      store: new FixtureStore(),
      now: () => now,
      preferences: fixturePreferences({
        topicWeights: {
          ...approvedBaselinePreferences().topicWeights,
          "alignment-interpretability": 2,
          technology: 1,
        },
        sourceWeights: { nist: 0 },
        feedbackHistory: [
          {
            id: "source-feedback-earlier",
            itemId: "source-feedback-item",
            action: "less_like_this",
            reason: "source",
            adjustments: [{
              dimension: "source",
              key: "nist",
              delta: -0.1,
              resultingWeight: 0.2,
            }],
            createdAt: "2026-07-30T08:00:00.000Z",
          },
          {
            id: "source-feedback-later",
            itemId: "source-feedback-item",
            action: "more_like_this",
            reason: "source",
            adjustments: [{
              dimension: "source",
              key: "nist",
              delta: 0.1,
              resultingWeight: 0.5,
            }],
            createdAt: now,
          },
        ],
      }),
      providers: {
        summary,
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [
        rawResearchCandidate(
          "2607.40101",
          "Mechanistic interpretability for oversight",
        ),
        rawNewsCandidate("nist", "technology"),
      ],
    });

    const enriched = await context.enrich(
      await context.normalize(await context.collect()),
    );
    const research = enriched.find((item) => item.kind === "paper");
    const news = enriched.find((item) => item.kind === "article");
    const researchWorkflow = research?.metadata.workflow as
      | { topicalFit?: number }
      | undefined;
    const newsWorkflow = news?.metadata.workflow as
      | { personalRelevance?: number }
      | undefined;

    expect(researchWorkflow?.topicalFit).toBe(1);
    expect(newsWorkflow?.personalRelevance).toBeCloseTo(0.45, 12);
    expect(news).toBeDefined();
  });

  it("uses bounded preference section budgets for the shortlist", async () => {
    // This fails if shortlisting continues to use only READER_PROFILE budgets.
    const assessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract" as const,
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-13",
      runId: "run-preference-budgets",
      store: new FixtureStore(),
      now: () => now,
      preferences: fixturePreferences({
        sectionBudgets: {
          morning_brief: 1,
          research: 1,
          research_radar: 0,
          world: 1,
          technology: 0,
          ai_policy: 0,
          dmv: 0,
          baltimore: 0,
          forecast: 0,
        },
      }),
      providers: {
        summary: new FakeModelProvider({
          embeddingBatches: [[
            [1, 0],
            [1, 0],
            [1, 0],
            [1, 0],
            [1, 0],
          ]],
        }),
        assessment: new FakeModelProvider({
          generatedObjects: [assessment],
        }),
      },
      collectCandidates: async () => [
        rawResearchCandidate(
          "2607.40102",
          "Mechanistic interpretability with a bounded briefing",
        ),
        rawNewsCandidate("world-budget", "world"),
      ],
    });

    const collected = await context.collect();
    const normalized = await context.normalize(collected);
    const enriched = await context.enrich(normalized);
    const prefiltered = await context.prefilter(enriched);
    const assessed = await context.assess(prefiltered);
    const scored = await context.score(assessed);
    const clustered = await context.cluster(scored);

    await expect(context.shortlist(clustered)).resolves.toHaveLength(1);
  });

  it("uses the larger valid local preference as the combined DMV and Baltimore budget", async () => {
    // This fails if the combined shortlist budget ignores either local control
    // or adds them together beyond the requested local reading depth.
    const candidates = [
      rawNewsCandidate("dmv-budget-one", "dmv"),
      rawNewsCandidate("baltimore-budget-one", "baltimore"),
      rawNewsCandidate("baltimore-budget-two", "baltimore"),
    ];
    const context = createProductionPipelineContext({
      editionDate: "2033-01-14",
      runId: "run-local-preference-budget",
      store: new FixtureStore(),
      now: () => now,
      preferences: fixturePreferences({
        sectionBudgets: {
          dmv: 1,
          baltimore: 2,
        },
      }),
      providers: {
        summary: new FakeModelProvider({
          embeddingBatches: [[
            [1, 0],
            [1, 0],
            [1, 0],
            [1, 0],
            [1, 0],
            [1, 0],
          ]],
        }),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => candidates,
    });
    const normalized = await context.normalize(await context.collect());
    const enriched = await context.enrich(normalized);
    const scored = await context.score(await context.prefilter(enriched));
    const clustered = await context.cluster(scored);

    const shortlisted = await context.shortlist(clustered);
    expect(shortlisted).toHaveLength(2);
    expect(shortlisted.every((item) =>
      item.metadata.section === "dmv" ||
      item.metadata.section === "baltimore"
    )).toBe(true);
  });

  it("accepts compact cluster and shortlist checkpoints after semantic clustering", async () => {
    const embedding = [1, ...Array<number>(1_535).fill(0)];
    const candidates = ["source-a", "source-b"].map((id) => ({
      ...fixtureItem(id, "world"),
      metadata: {
        primarySection: "world",
        sectionEligibility: ["world"],
        namedEntities: ["Example Agency"],
      },
    }));
    const store = new FixtureStore();
    const context = createProductionPipelineContext({
      editionDate: "2033-02-08",
      runId: "run-compact-cluster-checkpoint",
      store,
      now: () => now,
      providers: {
        summary: new FakeModelProvider({
          embeddingBatches: [[
            embedding,
            embedding,
            embedding,
            embedding,
            embedding,
          ]],
        }),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => candidates,
    });
    context.synthesize = async (items) => items.map((item) => ({
      item,
      summary: fixtureSummary(item),
    }));
    context.validate = async (entries) => entries.map((entry) => ({
      ...entry,
      valid: true,
    }));

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "failed",
    });
    expect(await store.readCheckpoint(context.runId, "cluster")).toBe(true);
    expect(await store.readCheckpoint(context.runId, "shortlist")).toBe(true);

    const scored = store.artifacts.get(`${context.runId}:score`);
    const clustered = store.artifacts.get(`${context.runId}:cluster`);
    const shortlisted = store.artifacts.get(`${context.runId}:shortlist`);

    expect(JSON.stringify(scored)).toContain('"embedding"');
    expect(clustered).toBeDefined();
    expect(shortlisted).toBeDefined();
    expect(JSON.stringify(clustered)).not.toContain('"embedding"');
    expect(JSON.stringify(shortlisted)).not.toContain('"embedding"');
  });

  it("rejects a claim when its cited source lacks the claimed evidence", async () => {
    // This fails if validation accepts evidence from another source in the development.
    const sourceA: Item = {
      ...fixtureItem("source-a", "world"),
      title: "Source A title",
      sourceRefs: [{
        id: "source-a",
        name: "Source A",
        url: "https://example.com/sources/source-a",
        role: "primary",
        retrievedAt: now,
      }],
      accessLevel: "full_text",
      normalizedText: "fact only from A",
      metadata: {
        primarySection: "world",
        sectionEligibility: ["world"],
        primaryDocumentUrl: "https://example.com/documents/shared-event",
        namedEntities: ["Example Agency"],
      },
    };
    const sourceB: Item = {
      ...fixtureItem("source-b", "world"),
      title: "Source B title",
      sourceRefs: [{
        id: "source-b",
        name: "Source B",
        url: "https://example.com/sources/source-b",
        role: "reporting",
        retrievedAt: now,
      }],
      accessLevel: "full_text",
      normalizedText: "different fact from B",
      metadata: {
        primarySection: "world",
        sectionEligibility: ["world"],
        primaryDocumentUrl: "https://example.com/documents/shared-event",
        namedEntities: ["Example Agency"],
      },
    };
    const development = clusterNews([sourceA, sourceB], {})[0];
    if (development === undefined) throw new Error("Expected clustered development.");
    const item = ItemSchema.parse({
      ...development.representativeItem,
      id: development.id,
      title: development.title,
      sourceRefs: development.sourceRefs,
      normalizedText: development.items.map((value) => value.normalizedText).join(" "),
      metadata: {
        ...development.representativeItem.metadata,
        workflow: { version: 1, development },
      },
    });
    const provider = new WrongSourceGroundingProvider();
    const context = createProductionPipelineContext({
      editionDate: "2033-01-03",
      runId: "run-wrong-source-grounding",
      store: new FixtureStore(),
      now: () => now,
      providers: { summary: provider, assessment: provider },
      collectCandidates: async () => [],
    });
    await expect(context.synthesize([item])).resolves.toEqual([]);
    const summary = StructuredSummarySchema.parse(
      await provider.generateObject({
        model: "briefing-summary",
        schemaName: "structured_summary",
        jsonSchema: {},
        system: "Use only the supplied source packet.",
        sourcePacket: "source_id: source-a",
        maxOutputTokens: 1_800,
      }),
    );

    const validated = await context.validate([{ item, summary }]);

    expect(validated).toMatchObject([{
      valid: false,
      validationErrors: expect.arrayContaining(["CLAIM_EVIDENCE_NOT_EXACT"]),
    }]);
  });

  it("keeps ephemeral article bodies out of collection checkpoints and D1", async () => {
    const store = new FixtureStore();
    const candidate: RawNewsCandidate = {
      ...rawNewsCandidate("reuters", "world"),
      abstract: null,
      content: `${"evidence ".repeat(260)}COPYRIGHTED_BODY_TAIL`,
      retrievedAt: "2026-07-29T08:30:00.000Z",
      metadata: {
        primarySection: "world",
        retention: "ephemeral-only",
      },
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-02",
      runId: "run-ephemeral-evidence",
      store,
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [candidate],
    });

    const collected = await context.collect();
    await store.saveCheckpoint(context.runId, "collect", collected);
    const normalized = await context.normalize(collected);
    await new D1BriefingRepository(env.DB).upsertItems(normalized);

    expect(JSON.stringify(store.artifacts.get("run-ephemeral-evidence:collect")))
      .not.toContain("COPYRIGHTED_BODY_TAIL");
    const itemId = normalized[0]!.id;
    const row = await env.DB.prepare(
      "SELECT normalized_json, expires_at FROM items WHERE id = ?",
    ).bind(itemId).first<{ normalized_json: string; expires_at: string }>();
    expect(row!.normalized_json).not.toContain("COPYRIGHTED_BODY_TAIL");
    expect(row!.expires_at).toBe("2026-10-27T08:30:00.000Z");
  });

  it("constructs manual-run providers and budget policy from the run-scoped runtime factory", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
    const factoryCalls: Array<{ runId: string; editionDate: string }> = [];
    const launcher = createD1WorkflowLauncher(
      env.DB,
      (async (input: { runId: string; editionDate: string }) => {
        factoryCalls.push(input);
        return {
          providers: {
            summary: new FakeModelProvider(),
            assessment: new FakeModelProvider(),
          },
          budgetPolicy: {
            state: "hard_stop" as const,
            radarSummaryTokens: 0,
            featuredSummaryTokens: 900,
          },
        };
      }) as unknown as Parameters<typeof createD1WorkflowLauncher>[1],
    );

    const { runId } = await launcher.start({ editionDate: "2033-03-01" });
    expect(factoryCalls).toEqual([{ runId, editionDate: "2033-03-01" }]);
  });

  it("runs paid research assessments sequentially", async () => {
    const assessment = new ConcurrencyTrackingAssessmentProvider();
    const context = createProductionPipelineContext({
      editionDate: "2033-03-10",
      runId: "sequential-assessment",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new GroundedProductionProvider(),
        assessment,
      },
      collectCandidates: async () => [
        rawResearchCandidate("2607.30001", "First sequential assessment"),
        rawResearchCandidate("2607.30002", "Second sequential assessment"),
      ],
    });
    const normalized = await context.normalize(await context.collect());
    const enriched = await context.enrich(normalized);
    const prefiltered = await context.prefilter(enriched);

    await expect(context.assess(prefiltered)).resolves.toHaveLength(2);
    expect(assessment.maximumActive).toBe(1);
    expect(assessment.startedPackets[0]).toContain(
      "First sequential assessment",
    );
    expect(assessment.startedPackets[1]).toContain(
      "Second sequential assessment",
    );
  });

  it("runs paid synthesis calls sequentially", async () => {
    const summary = new ConcurrencyTrackingSummaryProvider();
    const context = createProductionPipelineContext({
      editionDate: "2033-03-11",
      runId: "sequential-synthesis",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary,
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [
        rawNewsCandidate("sequential-world", "world"),
        rawNewsCandidate("sequential-tech", "technology"),
      ],
    });
    const normalized = await context.normalize(await context.collect());

    await expect(context.synthesize(normalized)).resolves.toHaveLength(2);
    expect(summary.maximumActive).toBe(1);
  });

  it("removes hard-stop radar before assessment and gives degraded radar only 120 summary tokens", async () => {
    const candidates = [
      rawResearchCandidate("2607.20001", "Interpretability study Alpha for oversight", 100),
      rawResearchCandidate("2607.20002", "Interpretability study Beta for oversight", 80),
      rawResearchCandidate("2607.20003", "Interpretability study Gamma for oversight", 60),
      rawResearchCandidate("2607.20004", "Interpretability study Radar for oversight", 1),
    ];
    const assessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract" as const,
    };
    const hardAssessment = new FakeModelProvider({
      generatedObjects: Array.from({ length: 3 }, () => assessment),
    });
    const hard = createProductionPipelineContext({
      editionDate: "2033-03-02",
      runId: "hard-budget",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new GroundedProductionProvider(),
        assessment: hardAssessment,
      },
      collectCandidates: async () => candidates,
      budgetPolicy: {
        state: "hard_stop",
        radarSummaryTokens: 0,
        featuredSummaryTokens: 900,
      },
    });
    const hardNormalized = await hard.normalize(await hard.collect());
    const hardEnriched = await hard.enrich(hardNormalized);
    const hardPrefiltered = await hard.prefilter(hardEnriched);
    await hard.assess(hardPrefiltered);
    expect(hardPrefiltered).toHaveLength(3);
    expect(hardAssessment.generateRequests).toHaveLength(3);

    const summary = new GroundedProductionProvider();
    summary.failNextSummary = false;
    const degraded = createProductionPipelineContext({
      editionDate: "2033-03-03",
      runId: "degraded-budget",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary,
        assessment: new FakeModelProvider({
          generatedObjects: Array.from({ length: 4 }, () => assessment),
        }),
      },
      collectCandidates: async () => candidates,
      budgetPolicy: {
        state: "degraded",
        radarSummaryTokens: 120,
        featuredSummaryTokens: 900,
      },
    });
    const normalized = await degraded.normalize(await degraded.collect());
    const enriched = await degraded.enrich(normalized);
    const prefiltered = await degraded.prefilter(enriched);
    const assessed = await degraded.assess(prefiltered);
    const scored = await degraded.score(assessed);
    const clustered = await degraded.cluster(scored);
    const shortlisted = await degraded.shortlist(clustered);
    await degraded.synthesize(shortlisted);

    expect(shortlisted.map((item) => item.metadata.section)).toEqual([
      "research",
      "research",
      "research",
      "research_radar",
    ]);
    expect(summary.generateRequests.map(({ maxOutputTokens }) => maxOutputTokens))
      .toEqual([900, 900, 900, 120]);
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

  it("restores sanitized source failures when a fresh context resumes past collect", async () => {
    const enabledSources = [
      "arxiv",
      "federal-register",
      "nist",
      "npr",
      "openalex",
      "reuters",
      "semantic-scholar",
      "wtop",
      "wypr",
    ];
    await env.DB.prepare(
      `UPDATE sources
      SET enabled = CASE
        WHEN id IN (${enabledSources.map(() => "?").join(", ")}) THEN 1
        ELSE 0
      END`,
    ).bind(...enabledSources).run();
    const retrievedAt = new Date();
    const publishedAt = new Date(
      retrievedAt.getTime() - 60 * 60 * 1_000,
    ).toISOString();
    const publicationDate = publishedAt.slice(0, 10);
    const rss = (
      title: string,
      link: string,
      guid: string,
    ) => `<?xml version="1.0"?>
      <rss version="2.0"><channel><item>
        <title>${title}</title>
        <link>${link}</link>
        <guid>${guid}</guid>
        <description>${title} has durable public evidence.</description>
      </item></channel></rss>`;
    const feedBodies = new Map<string, string>([
      [
        "https://www.nist.gov/news-events/news/rss.xml",
        rss(
          "Source nist certifies a quantum clock",
          "https://www.nist.gov/news-events/news/quantum-clock",
          "nist-clock",
        ),
      ],
      [
        "https://feeds.npr.org/1001/rss.xml",
        rss(
          "Source npr reports election observers",
          "https://www.npr.org/sections/world/election-observers",
          "npr-observers",
        ),
      ],
      [
        "https://wtop.com/feed/",
        rss(
          "Source wtop reports a Virginia transit bridge",
          "https://wtop.com/virginia/transit-bridge",
          "wtop-bridge",
        ),
      ],
      [
        "https://www.wypr.org/rss/local-news",
        rss(
          "Source wypr reports a Baltimore school clinic",
          "https://www.wypr.org/wypr-news/baltimore-school-clinic",
          "wypr-clinic",
        ),
      ],
    ]);
    const arxivFeed = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>https://arxiv.org/abs/2607.12345v1</id>
          <updated>${publishedAt}</updated>
          <published>${publishedAt}</published>
          <title>Mechanistic interpretability for reliable oversight</title>
          <summary>A concrete interpretability method improves reliable oversight.</summary>
          <author><name>Researcher Example</name></author>
          <link href="https://arxiv.org/abs/2607.12345v1" rel="alternate" type="text/html" />
          <category term="cs.AI" />
        </entry>
      </feed>`;
    const sourceFetch = vi.fn(
      async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url === "https://www.reutersagency.com/feed/") {
          throw new Error("secret failed-feed URL and credential");
        }
        const feedBody = feedBodies.get(url);
        if (feedBody !== undefined) {
          return new Response(feedBody, {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        if (url.startsWith("https://export.arxiv.org/api/query")) {
          return new Response(arxivFeed, {
            headers: { "content-type": "application/atom+xml" },
          });
        }
        if (
          url.startsWith(
            "https://api.semanticscholar.org/graph/v1/paper/batch",
          )
        ) {
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.startsWith(
            "https://www.federalregister.gov/api/v1/documents.json",
          )
        ) {
          return Response.json({
            results: [{
              document_number: "2026-briefing-1",
              title: "Federal Register schedules a public lands hearing",
              html_url:
                "https://www.federalregister.gov/documents/2026/briefing-1",
              publication_date: publicationDate,
              type: "Notice",
              abstract:
                "The notice schedules a public hearing with durable evidence.",
            }],
          });
        }
        if (
          url.startsWith("https://www.nist.gov/") ||
          url.startsWith("https://www.npr.org/") ||
          url.startsWith("https://wtop.com/") ||
          url.startsWith("https://www.wypr.org/")
        ) {
          return new Response(
            "<html><article><p>Durable public evidence supports this development.</p></article></html>",
            { headers: { "content-type": "text/html" } },
          );
        }
        throw new Error(`Unexpected production-context URL: ${url}`);
      },
    );
    vi.stubGlobal("fetch", sourceFetch);
    try {
      const firstStore = createD1PipelineStore(env.DB);
      const firstContext = createD1ProductionPipelineContext(
        firstStore,
        "2033-02-08",
        "run-fail-open-production",
        {
          summary: new GroundedProductionProvider(),
          assessment: new FakeModelProvider({
            generatedObjects: [{
              technicalQuality: 0.9,
              novelty: 0.8,
              strengths: ["The abstract describes a concrete method."],
              limitations: ["Only abstract evidence was supplied."],
              rationale:
                "The available abstract supports a strong assessment.",
              accessLevel: "abstract",
            }],
          }),
        },
      );

      await expect(runEditorialPipeline(firstContext)).rejects.toThrow(
        "TRANSIENT_SUMMARY_FAILURE",
      );
      const fetchCallsAfterCollect = sourceFetch.mock.calls.length;
      expect(await firstStore.readCollectionSourceFailures(
        "run-fail-open-production",
      )).toEqual(["reuters:fetch"]);
      expect((await env.DB.prepare(
        `SELECT id FROM audit_events
         WHERE run_id = ? AND event_type = ?`,
      ).bind(
        "run-fail-open-production",
        "collection_source_failures",
      ).all()).results).toEqual([{
        id: "collection_source_failures:run-fail-open-production",
      }]);

      const resumedSummary = new GroundedProductionProvider();
      resumedSummary.failNextSummary = false;
      const resumedContext = createD1ProductionPipelineContext(
        createD1PipelineStore(env.DB),
        "2033-02-08",
        "run-fail-open-production",
        {
          summary: resumedSummary,
          assessment: new FakeModelProvider(),
        },
      );
      await expect(runEditorialPipeline(resumedContext)).resolves.toMatchObject({
        status: "published",
      });
      expect(sourceFetch).toHaveBeenCalledTimes(fetchCallsAfterCollect);
      const edition = await new D1BriefingRepository(env.DB)
        .getEditionByDate("2033-02-08");
      expect(edition?.metadata?.sourceFailures).toEqual(["reuters:fetch"]);
      expect(JSON.stringify(edition?.metadata)).not.toContain(
        "secret failed-feed URL",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains an unknown-source failure in production metadata without updating health", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
    await env.DB.prepare(
      `INSERT INTO sources (
        id, canonical_name, canonical_url, role, trust_prior, enabled,
        restrictions_json, last_success_at, health_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "malformed source",
      "Malformed Source ID",
      "https://malformed-source.example/",
      "reporting",
      0.5,
      1,
      JSON.stringify({
        bodyRetrieval: "forbidden",
        paywall: "none",
        contentUse: "metadata-only",
        discoveryMechanism: "rss",
        sectionEligibility: ["world"],
        feedUrl: "https://malformed-source.example/feed.xml",
        urlPolicy: {
          allowedHosts: ["malformed-source.example"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/"],
        },
      }),
      null,
      "unknown",
    ).run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("private upstream body", { status: 401 })
      ),
    );
    try {
      const store = createD1PipelineStore(env.DB);
      const context = createD1ProductionPipelineContext(
        store,
        "2033-02-09",
        "run-unknown-source-failure",
        {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
      );

      await expect(context.collect()).resolves.toEqual([]);
      expect(context.sourceFailures).toEqual(["unknown-source:fetch"]);
      expect(
        (await store.repository.listSources()).find(
          ({ id }) => id === "malformed source",
        ),
      ).toMatchObject({
        healthStatus: "unknown",
        lastSuccessAt: null,
      });
      expect(JSON.stringify(context.sourceFailures)).not.toContain(
        "private upstream body",
      );
    } finally {
      vi.unstubAllGlobals();
    }
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
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
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
