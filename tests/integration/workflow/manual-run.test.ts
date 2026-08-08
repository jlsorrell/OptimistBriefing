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
  MAX_D1_CHECKPOINT_EVENT_BYTES,
  runEditorialPipeline,
  type PipelineContext,
  type PipelineRun,
  type PipelineStore,
} from "../../../src/workflow/run-editorial-pipeline";
import {
  PROVIDER_TEXT_NORMALIZATION_VERSION,
  PROVIDER_TEXT_PREPARATION_VERSION,
  type CheckpointArtifact,
} from "../../../src/workflow/types";
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
import { OpenAIModelProvider } from "../../../src/models/openai-provider";
import { clusterNews } from "../../../src/editorial/cluster";
import { scoreNewsDevelopment } from "../../../src/editorial/news-score";
import {
  canonicalResearchIdentity,
  consolidateResearchCandidates,
} from "../../../src/editorial/research-identity";
import {
  researchFingerprints,
  triageResearch,
} from "../../../src/editorial/research-triage";
import { CONFIGURED_RESEARCH_TOPIC_IDS } from "../../../src/editorial/research-topics";
import { composeEdition } from "../../../src/workflow/compose-edition";
import { sourcePacketForItem } from "../../../src/workflow/source-packet";
import { normalizeCandidate } from "../../../src/editorial/normalize";
import type {
  GenerateObjectRequest,
  ModelProvider,
} from "../../../src/models/provider";
import type {
  DiscoveryDiagnosticsState,
  DiscoveryLaneDiagnostic,
  DiscoveryObservation,
  RawNewsCandidate,
  RawPublicationCandidate,
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

function rawOfficialPublicationCandidate(
  section: "technology" | "ai_policy",
  id: string,
  publishedAt: string,
  evidence: string,
): RawPublicationCandidate {
  const sourceId = section === "technology" ? "nist" : "federal-register";
  const title = section === "technology"
    ? `NIST launches AI software capability ${id}`
    : `Federal Register adopts AI governance oversight standard ${id}`;
  return {
    kind: "publication",
    sourceId,
    sourceName: section === "technology" ? "NIST" : "Federal Register",
    sourceRole: "primary",
    title,
    originalUrl: `https://${sourceId}.example.com/publications/${id}`,
    externalId: id,
    externalIds: [id],
    publishedAt,
    retrievedAt: now,
    accessLevel: "abstract",
    authors: [],
    institutions: [],
    abstract: evidence,
    content: null,
    relatedPaperIds: [],
    metadata: {},
    sectionEligibility: [section],
    discoveryFamily: "official-publication",
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

class TitleRepairingSummaryProvider implements ModelProvider {
  readonly requests: GenerateObjectRequest[] = [];
  readonly embedRequests: (readonly string[])[] = [];

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    this.embedRequests.push([...texts]);
    return texts.map(() => [1, 0]);
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    this.requests.push(input);
    const sourceId = packetValue(input.sourcePacket, "source_id");
    const title = packetValue(input.sourcePacket, "title");
    const evidence = packetExcerpt(input.sourcePacket);
    const repairing = input.sourcePacket.startsWith(
      "VALIDATION ERRORS AND REQUIRED REPAIRS",
    );
    const provenance = {
      sourceIds: [sourceId],
      evidenceExcerpt: repairing ? title : evidence,
    };
    return {
      title: repairing ? title : "Unsupported paraphrased headline",
      oneSentence: evidence,
      whyItMatters: evidence,
      uncertainty: evidence,
      claims: [{
        text: evidence,
        sourceIds: [sourceId],
        evidenceExcerpt: evidence,
      }],
      accessLevel: packetAccessLevel(input.sourcePacket),
      provenance: {
        title: provenance,
        oneSentence: {
          sourceIds: [sourceId],
          evidenceExcerpt: evidence,
        },
        whyItMatters: {
          sourceIds: [sourceId],
          evidenceExcerpt: evidence,
        },
        uncertainty: {
          sourceIds: [sourceId],
          evidenceExcerpt: evidence,
        },
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

class RejectionThenAcceptanceProvider implements ModelProvider {
  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    return texts.map(() => [1, 0]);
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    if (input.schemaName !== "structured_summary") {
      throw new Error(`Unexpected schema: ${input.schemaName}`);
    }
    const sourceId = packetValue(input.sourcePacket, "source_id");
    const title = packetValue(input.sourcePacket, "title");
    const evidence = packetExcerpt(input.sourcePacket);
    const accessLevel = packetAccessLevel(input.sourcePacket);
    const provenance = { sourceIds: [sourceId], evidenceExcerpt: evidence };
    if (title === "Rejected private item title") {
      return {
        title,
        oneSentence: evidence,
        whyItMatters: evidence,
        uncertainty: evidence,
        claims: [{
          text: "Unsupported raw provider claim",
          sourceIds: [sourceId],
          evidenceExcerpt: "Unsupported raw provider evidence",
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

class UnknownSourceThenAcceptanceProvider implements ModelProvider {
  constructor(readonly unknownSourceId: string) {}

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    return texts.map(() => [1, 0]);
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    if (input.schemaName !== "structured_summary") {
      throw new Error(`Unexpected schema: ${input.schemaName}`);
    }
    const sourceId = packetValue(input.sourcePacket, "source_id");
    const title = packetValue(input.sourcePacket, "title");
    const evidence = packetExcerpt(input.sourcePacket);
    const accessLevel = packetAccessLevel(input.sourcePacket);
    const provenance = { sourceIds: [sourceId], evidenceExcerpt: evidence };
    if (title === "Unknown-source private item") {
      return {
        title,
        oneSentence: evidence,
        whyItMatters: evidence,
        uncertainty: evidence,
        claims: [{
          text: "Unsupported model claim",
          sourceIds: [sourceId, this.unknownSourceId],
          evidenceExcerpt: "Unsupported model evidence",
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
    return Array.from({ length: 16 }, (_, position) =>
      position === index ? 1 : 0
    );
  }

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => {
      const highNewsIndex = /high-news-(\d+)/.exec(text)?.[1];
      if (highNewsIndex !== undefined) {
        const index = Number(highNewsIndex);
        const embedding = this.basis(index <= 4 ? 1 : 2);
        embedding[6 + index] = 1;
        return embedding;
      }
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

function rawHighScoringNewsCandidate(
  id: string,
  section: "technology" | "ai_policy",
): RawNewsCandidate {
  const sourceId = section === "technology" ? "nist" : "federal-register";
  return {
    ...rawNewsCandidate(sourceId, section, id),
    title: `Source ${sourceId} ${id} adopts an evaluation standard`,
    originalUrl: `https://${sourceId}.example.com/${id}`,
    namedEntities: [`Entity ${id}`],
    eventFamilies: [`evaluation-standard-${id}`],
  };
}

const researchAssessment = {
  technicalQuality: 0.9,
  novelty: 0.8,
  strengths: ["The abstract describes a concrete method."],
  limitations: ["Only abstract evidence was supplied."],
  rationale: "The available abstract supports a strong assessment.",
  accessLevel: "abstract" as const,
};

const belowTechnicalQualityAssessment = {
  ...researchAssessment,
  technicalQuality: 0.4,
};

const qualifiedResearchAssessment = {
  ...researchAssessment,
  technicalQuality: 0.5,
  novelty: 0,
};

function highScoringNews(): RawNewsCandidate[] {
  return Array.from({ length: 8 }, (_, index) =>
    rawHighScoringNewsCandidate(
      `high-news-${index + 1}`,
      index < 4 ? "technology" : "ai_policy",
    )
  );
}

async function productionShortlist(
  candidates: readonly (RawResearchCandidate | RawNewsCandidate)[],
  assessments: readonly typeof researchAssessment[],
  runId: string,
): Promise<readonly Item[]> {
  const context = createProductionPipelineContext({
    editionDate: "2033-01-03",
    runId,
    store: new FixtureStore(),
    now: () => now,
    providers: {
      summary: new RankingEmbeddingProvider(),
      assessment: new FakeModelProvider({ generatedObjects: assessments }),
    },
    collectCandidates: async () => candidates,
  });
  const normalized = await context.normalize(await context.collect());
  const enriched = await context.enrich(normalized);
  const prefiltered = await context.prefilter(enriched);
  const assessed = await context.assess(prefiltered);
  const scored = await context.score(assessed);
  const clustered = await context.cluster(scored);
  return context.shortlist(clustered);
}

class RelevanceFirstEmbeddingProvider implements ModelProvider {
  readonly embedRequests: string[][] = [];

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    this.embedRequests.push([...texts]);
    return texts.map((text) =>
      text.includes("Irrelevant arrival") ? [0, 1] : [1, 0]
    );
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
  it.each([
    ["title", "&lt;br&gt;"],
    ["sourceName", "&lt;br&gt;"],
    ["title", "&#65308;br&#65310;"],
    ["sourceName", "&#65308;br&#65310;"],
  ] as const)(
    "isolates an empty prepared %s value %s without swallowing structural errors",
    async (invalidField, invalidValue) => {
      const laneId = `official-publication:empty-prepared-${invalidField}`;
      const diagnosticWrites: DiscoveryLaneDiagnostic[][] = [];
      const invalid = {
        ...rawNewsCandidate(`empty-prepared-${invalidField}`, "world"),
        [invalidField]: invalidValue,
        metadata: {
          discoveryFamily: "official-publication",
          discoveryLaneIds: [laneId],
        },
      };
      const valid = {
        ...rawNewsCandidate("valid-prepared-title", "world"),
        metadata: {
          discoveryFamily: "official-publication",
          discoveryLaneIds: [laneId],
        },
      };
      const context = createProductionPipelineContext({
        editionDate: "2033-01-01",
        runId: "run-isolate-empty-prepared-title",
        store: new FixtureStore(),
        now: () => now,
        providers: {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
        collectCandidates: async () => [invalid, valid],
        loadDiscoveryDiagnostics: () => [{
          laneId,
          sourceId: "custom",
          discoveryFamily: "official-publication",
          discovered: 2,
          deduplicated: 0,
          triaged: 0,
          assessed: 0,
          outcome: "success",
          rejectionCounts: {},
        }],
        researchRepository: {
          getDiscoveryObservations: async () => [],
          upsertDiscoveryObservations: async () => undefined,
          getCachedResearchAssessment: async () => null,
          putCachedResearchAssessment: async () => undefined,
          recordDiscoveryDiagnostics: async (_runId, diagnostics) => {
            diagnosticWrites.push(structuredClone([...diagnostics]));
          },
        },
      });

      const collected = await context.collect();
      expect(diagnosticWrites[0]?.[0]?.rejectionCounts).toEqual({
        quality_rejected: 1,
      });
      const normalized = await context.normalize(collected);

      expect(collected).toHaveLength(1);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]?.title).toBe(valid.title);
      await expect(context.normalize([{
        ...valid,
        originalUrl: "javascript:alert(1)",
      }])).rejects.toThrow();
    },
  );

  it.each([
    ["title", "&lt;br&gt;"],
    ["sourceName", "&lt;br&gt;"],
    ["title", "&#65308;br&#65310;"],
    ["sourceName", "&#65308;br&#65310;"],
  ] as const)(
    "isolates an encoded-markup-only stored Item %s value %s from its valid sibling",
    async (invalidField, invalidValue) => {
      const laneId = `official-publication:stored-item-${invalidField}`;
      const diagnosticWrites: DiscoveryLaneDiagnostic[][] = [];
      const invalidFixture = fixtureItem(
        `stored-empty-${invalidField}`,
        "world",
      );
      const invalid = ItemSchema.parse({
        ...invalidFixture,
        ...(invalidField === "title" ? { title: invalidValue } : {}),
        sourceRefs: invalidFixture.sourceRefs.map((source) => ({
          ...source,
          ...(invalidField === "sourceName" ? { name: invalidValue } : {}),
        })),
        metadata: {
          ...invalidFixture.metadata,
          discoveryFamily: "official-publication",
          discoveryLaneIds: [laneId],
        },
      });
      const valid = ItemSchema.parse({
        ...fixtureItem("stored-valid-title", "world"),
        metadata: {
          ...fixtureItem("stored-valid-title", "world").metadata,
          discoveryFamily: "official-publication",
          discoveryLaneIds: [laneId],
        },
      });
      const context = createProductionPipelineContext({
        editionDate: "2033-01-01",
        runId: "run-isolate-stored-empty-title",
        store: new FixtureStore(),
        now: () => now,
        providers: {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
        collectCandidates: async () => [],
        loadDiscoveryDiagnostics: () => [{
          laneId,
          sourceId: "stored-items",
          discoveryFamily: "official-publication",
          discovered: 2,
          deduplicated: 0,
          triaged: 0,
          assessed: 0,
          outcome: "success",
          rejectionCounts: {},
        }],
        researchRepository: {
          getDiscoveryObservations: async () => [],
          upsertDiscoveryObservations: async () => undefined,
          getCachedResearchAssessment: async () => null,
          putCachedResearchAssessment: async () => undefined,
          recordDiscoveryDiagnostics: async (_runId, diagnostics) => {
            diagnosticWrites.push(structuredClone([...diagnostics]));
          },
        },
      });

      const normalized = await context.normalize([invalid, valid]);

      expect(normalized).toHaveLength(1);
      expect(normalized[0]?.id).toBe(valid.id);
      expect(diagnosticWrites.at(-1)?.[0]?.rejectionCounts).toEqual({
        quality_rejected: 1,
      });
    },
  );

  it("strips encoded wrappers from stored display and evidence without decoding URLs", async () => {
    const fixture = fixtureItem("stored-useful-markup", "world");
    const originalUrl =
      "https://example.com/stored-useful-markup?label=%26lt%3Bbr%26gt%3B";
    const stored = ItemSchema.parse({
      ...fixture,
      canonicalUrl: originalUrl,
      title:
        "&#65308;script&#65310;Useful stored title&#65308;/script&#65310;",
      primaryTopic: "&#119;orld",
      sourceRefs: fixture.sourceRefs.map((source) => ({
        ...source,
        name:
          "&#65308;em&#65310;Useful stored source&#65308;/em&#65310;",
      })),
      normalizedText:
        "&#65308;p&#65310;Useful stored evidence&#65308;/p&#65310;",
      metadata: {
        ...fixture.metadata,
        authors: [
          "&#65308;strong&#65310;Useful stored author&#65308;/strong&#65310;",
        ],
        venue:
          "&#65308;em&#65310;Useful stored venue&#65308;/em&#65310;",
        structuralId: "structural-＆#8217;",
      },
    });
    const context = createProductionPipelineContext({
      editionDate: "2034-04-02",
      runId: "run-stored-useful-markup",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    const normalized = (await context.normalize([stored]))[0]!;

    expect(normalized.title).toBe("Useful stored title");
    expect(normalized.sourceRefs[0]?.name).toBe("Useful stored source");
    expect(normalized.normalizedText).toBe("Useful stored evidence");
    expect(normalized.metadata.authors).toEqual(["Useful stored author"]);
    expect(normalized.metadata.venue).toBe("Useful stored venue");
    expect(normalized.metadata.structuralId).toBe("structural-＆#8217;");
    expect(normalized.canonicalUrl).toBe(originalUrl);
    expect(normalized.primaryTopic).toBe("&#119;orld");
    expect(JSON.stringify(normalized)).not.toMatch(
      /<(?:script|em|strong|p)>/i,
    );
  });

  it("rebuilds an ordinary stored aggregate after filtering typed-invalid nested display text", async () => {
    const relatedItem = (id: string): Item => ItemSchema.parse({
      ...fixtureItem(id, "world"),
      metadata: {
        ...fixtureItem(id, "world").metadata,
        primarySection: "world",
        sectionEligibility: ["world"],
        namedEntities: ["Ordinary Development Agency"],
        normalizedAuthors: [],
        primaryDocumentUrl:
          "https://example.com/documents/ordinary-development",
        primaryDocumentUrls: [
          "https://example.com/documents/ordinary-development",
        ],
      },
    });
    const validA = relatedItem("ordinary-development-valid-a");
    const validB = relatedItem("ordinary-development-valid-b");
    const invalidTitle = ItemSchema.parse({
      ...relatedItem("ordinary-development-invalid-title"),
      title: "&lt;br&gt;",
    });
    const invalidSourceFixture = relatedItem(
      "ordinary-development-invalid-source",
    );
    const invalidSource = ItemSchema.parse({
      ...invalidSourceFixture,
      sourceRefs: invalidSourceFixture.sourceRefs.map((source) => ({
        ...source,
        name: "&lt;br&gt;",
      })),
    });
    const staleDevelopment = clusterNews([
      invalidTitle,
      invalidSource,
      validA,
      validB,
    ], {})[0]!;
    const freshDevelopment = clusterNews([validA, validB], {})[0]!;
    const scoreInputs = {
      publicImportance: 0.81,
      personalRelevance: 0.72,
      sourceQuality: 0.91,
      recency: 0.84,
      geography: 0.25,
      novelty: 0.63,
    };
    const aggregate = ItemSchema.parse({
      ...staleDevelopment.representativeItem,
      id: staleDevelopment.id,
      title: staleDevelopment.title,
      sourceRefs: staleDevelopment.sourceRefs,
      normalizedText: staleDevelopment.items
        .map((item) => item.normalizedText)
        .join(" "),
      primaryTopic: staleDevelopment.primarySection,
      metadata: {
        ...staleDevelopment.representativeItem.metadata,
        ordinaryAggregateSentinel: "must-not-survive",
        workflow: {
          version: 1,
          embedding: [0.25],
          personalRelevance: scoreInputs.personalRelevance,
          development: staleDevelopment,
          developmentScore: scoreNewsDevelopment(
            staleDevelopment,
            scoreInputs,
          ),
          section: "technology",
          selectionReasons: ["Preserved selection reason."],
        },
      },
    });
    const context = createProductionPipelineContext({
      editionDate: "2034-04-03",
      runId: "run-ordinary-development-typed-filter",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    const normalized = await context.normalize([aggregate]);

    expect(normalized).toHaveLength(1);
    const rebuilt = normalized[0]!;
    const rebuiltWorkflow = rebuilt.metadata.workflow as {
      development: typeof freshDevelopment;
      developmentScore: ReturnType<typeof scoreNewsDevelopment>;
      embedding?: readonly number[];
      personalRelevance?: number;
      section?: string;
      selectionReasons?: readonly string[];
    };
    expect(rebuiltWorkflow.development).toEqual(freshDevelopment);
    expect(rebuiltWorkflow.developmentScore).toEqual(
      scoreNewsDevelopment(freshDevelopment, scoreInputs),
    );
    expect(rebuilt).toMatchObject({
      id: freshDevelopment.id,
      title: freshDevelopment.title,
      sourceRefs: freshDevelopment.sourceRefs,
      normalizedText: freshDevelopment.items
        .map((item) => item.normalizedText)
        .join(" "),
      primaryTopic: freshDevelopment.primarySection,
    });
    expect(rebuiltWorkflow.embedding).toBeUndefined();
    expect(rebuiltWorkflow.personalRelevance).toBe(
      scoreInputs.personalRelevance,
    );
    expect(rebuiltWorkflow.section).toBe(freshDevelopment.primarySection);
    expect(rebuiltWorkflow.selectionReasons).toEqual([
      "Preserved selection reason.",
    ]);
    expect(rebuilt.metadata.ordinaryAggregateSentinel).toBeUndefined();
    expect(JSON.stringify(rebuilt)).not.toContain("<br>");
  });

  it("drops an ordinary stored aggregate only when every nested Item is typed-invalid", async () => {
    const relatedItem = (id: string): Item => ItemSchema.parse({
      ...fixtureItem(id, "world"),
      metadata: {
        ...fixtureItem(id, "world").metadata,
        primarySection: "world",
        sectionEligibility: ["world"],
        namedEntities: ["All Bad Development Agency"],
        normalizedAuthors: [],
        primaryDocumentUrl:
          "https://example.com/documents/all-bad-development",
        primaryDocumentUrls: [
          "https://example.com/documents/all-bad-development",
        ],
      },
    });
    const invalidTitle = ItemSchema.parse({
      ...relatedItem("ordinary-all-bad-title"),
      title: "&lt;br&gt;",
    });
    const invalidSourceFixture = relatedItem("ordinary-all-bad-source");
    const invalidSource = ItemSchema.parse({
      ...invalidSourceFixture,
      sourceRefs: invalidSourceFixture.sourceRefs.map((source) => ({
        ...source,
        name: "&lt;br&gt;",
      })),
    });
    const staleDevelopment = clusterNews(
      [invalidTitle, invalidSource],
      {},
    )[0]!;
    const aggregate = ItemSchema.parse({
      ...staleDevelopment.representativeItem,
      id: staleDevelopment.id,
      metadata: {
        ...staleDevelopment.representativeItem.metadata,
        workflow: {
          version: 1,
          development: staleDevelopment,
        },
      },
    });
    const validSibling = fixtureItem("ordinary-all-bad-valid-sibling", "world");
    const context = createProductionPipelineContext({
      editionDate: "2034-04-04",
      runId: "run-ordinary-development-all-bad",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    const normalized = await context.normalize([aggregate, validSibling]);

    expect(normalized.map(({ id }) => id)).toEqual([validSibling.id]);
  });

  it("propagates a structurally invalid nested Item from an ordinary stored aggregate", async () => {
    const validNews = fixtureItem("ordinary-structural-news", "world");
    const validDevelopment = clusterNews([validNews], {})[0]!;
    const researchItem = fixtureItem("ordinary-structural-paper", "research");
    const structurallyInvalidDevelopment = {
      ...validDevelopment,
      title: researchItem.title,
      itemIds: [researchItem.id],
      items: [researchItem],
      representativeItem: researchItem,
      sourceRefs: researchItem.sourceRefs,
    };
    const aggregate = ItemSchema.parse({
      ...validNews,
      id: validDevelopment.id,
      metadata: {
        ...validNews.metadata,
        workflow: {
          version: 1,
          development: structurallyInvalidDevelopment,
        },
      },
    });
    const context = createProductionPipelineContext({
      editionDate: "2034-04-05",
      runId: "run-ordinary-development-structural-bad",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    await expect(context.normalize([aggregate])).rejects.toThrow(
      "News developments require only news Items.",
    );
  });

  it("prepares publication text before routing without changing structure", async () => {
    const publication: RawPublicationCandidate = {
      ...rawOfficialPublicationCandidate(
        "technology",
        "encoded-route",
        now,
        "The paper reports a substantive study with bounded evidence.",
      ),
      title: "A study of &amp;#105;nterpretability",
      originalUrl: "https://nist.example/publications/encoded?id=%26amp%3B",
      externalId: "publication&#65;",
      externalIds: ["publication&#65;"],
      sectionEligibility: ["research", "research_radar"],
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-01",
      runId: "run-prepare-before-route",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [publication],
    });

    const normalized = await context.normalize([publication]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      kind: "blog",
      title: "A study of interpretability",
      canonicalUrl: "https://nist.example/publications/encoded?id=%26amp%3B",
      publishedAt: now,
    });
    expect(normalized[0]?.metadata.externalIds).toContain(
      "publication&#65;",
    );
    expect(normalized[0]?.metadata.configuredTopics).toContain(
      "alignment-interpretability",
    );
  });

  it("bounds assessment evidence without splitting astral characters", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: [
        researchAssessment,
        { ...researchAssessment, accessLevel: "full_text" },
      ],
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-01",
      runId: "run-safe-assessment-bounds",
      store: new FixtureStore(),
      now: () => now,
      providers: { summary: new FakeModelProvider(), assessment: provider },
      collectCandidates: async () => [],
    });
    const storedResearch = (
      id: string,
      accessLevel: "abstract" | "full_text",
      normalizedText: string,
    ): Item => {
      const item = fixtureItem(id, "research");
      return ItemSchema.parse({
        ...item,
        accessLevel,
        normalizedText,
        metadata: {
          ...item.metadata,
          workflow: {
            version: 1,
            rawResearch: {
              ...rawResearchCandidate(`2607.${id}`, `Assessment ${id}`),
              accessLevel,
            },
          },
        },
      });
    };
    const abstractItem = storedResearch(
      "astral-abstract",
      "abstract",
      `${"a".repeat(3_999)}😀tail`,
    );
    const fullTextItem = storedResearch(
      "astral-full",
      "full_text",
      `${"b".repeat(99_999)}😀tail`,
    );

    await expect(context.assess([abstractItem, fullTextItem])).resolves
      .toHaveLength(2);

    expect(provider.generateRequests).toHaveLength(2);
    for (const request of provider.generateRequests) {
      expect(request.sourcePacket).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
      expect(request.sourcePacket).not.toMatch(/\\ud[c-f][0-9a-f]{2}/i);
    }
  });

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

  it("normalizes legacy completed checkpoints in memory before assessment", async () => {
    const store = new FixtureStore();
    const observedEvidenceFingerprints: string[] = [];
    const legacyRaw: RawResearchCandidate = {
      ...rawResearchCandidate(
        "2607.checkpoint-legacy",
        "Checkpoint &#114;esearch title",
      ),
      sourceName: "Checkpoint &amp; Source",
      metadata: { arbitraryRawDisplay: "Legacy &#82;aw metadata" },
    };
    const freshLegacyResearch = normalizeCandidate({
      ...legacyRaw,
      title: "Checkpoint research title",
      abstract: "Checkpoint evidence for assessment.",
      metadata: {},
    });
    const structuralProvenance = {
      sourceId: "source&#65;",
      sourceName: "Checkpoint &amp; Source",
      role: "primary",
      accessLevel: "abstract",
      url: "https://example.com/paper?id=%26amp%3B",
      retrievedAt: now,
      canCorroborateFacts: true,
    };
    const legacyItem = ItemSchema.parse({
      ...fixtureItem("legacy-checkpoint-research", "research"),
      title: "Checkpoint &#114;esearch title",
      sourceRefs: [{
        ...fixtureItem("legacy-checkpoint-source", "research").sourceRefs[0]!,
        id: "arxiv",
        name: "Checkpoint &amp; Source",
        url: legacyRaw.originalUrl,
      }],
      normalizedText: "Checkpoint &#101;vidence for assessment.",
      tags: ["research", "stale&#45;topic"],
      metadata: {
        normalizedAuthors: ["&amp;#65;da Example"],
        institutions: ["Checkpoint &#73;nstitute"],
        providerTopics: ["&#73;nterpretability"],
        provenance: [structuralProvenance],
        attachedCommentary: [{
          sourceId: "arxiv",
          role: "blog",
          title: "Attached &#67;ommentary",
          url: legacyRaw.originalUrl,
          retrievedAt: now,
          accessLevel: "abstract",
          excerpt: "Attached &#101;vidence excerpt.",
          relatedPaperIds: [],
        }],
        editorialSignals: [{
          sourceName: "Signal &#83;ource",
          structuralValue: "keep&#65;",
        }],
        namedEntities: ["Stale &#69;ntity"],
        eventFamilies: ["stale-event-family"],
        eventInstances: [{ stale: "&#69;vent" }],
        materialFacts: [{ stale: "&#70;act" }],
        scopedMaterialFacts: [{ stale: "&#83;coped fact" }],
        contentFingerprint: "content:stale-legacy-value",
        evidenceFingerprint: "evidence:stale-legacy-value",
        configuredTopics: ["stale-topic"],
        primaryTopic: "stale-topic",
        workflow: {
          version: 1,
          rawResearch: legacyRaw,
          topicalFit: 0.9,
        },
      },
    });
    const rawLegacyNews: RawNewsCandidate = {
      ...rawNewsCandidate("legacy-news-signals", "world"),
      title: "Federal Reserve raises interest rates to 5%",
      abstract:
        "Federal Reserve raises interest rates to 5% after the meeting.",
      namedEntities: [],
      eventFamilies: [],
      materialFacts: [],
    };
    const freshNews = normalizeCandidate(rawLegacyNews);
    const legacyNews = ItemSchema.parse({
      ...freshNews,
      title: "F&#101;deral Reserve raises interest rates to 5%",
      normalizedText:
        "F&#101;deral Reserve raises interest rates to 5% after the meeting.",
      tags: ["world", "stale&#45;section"],
      metadata: {
        ...freshNews.metadata,
        namedEntities: ["Stale &#69;ntity"],
        eventFamilies: ["stale-event-family"],
        eventInstances: [{ stale: "&#69;vent" }],
        materialFacts: [{ stale: "&#70;act" }],
        scopedMaterialFacts: [{ stale: "&#83;coped fact" }],
        editorialSignals: [{
          ...(freshNews.metadata.editorialSignals as
            Record<string, unknown>[])[0],
          namedEntities: ["Stale &#69;ntity"],
          eventFamilies: ["stale-event-family"],
        }],
      },
    });
    const assessmentProvider = new FakeModelProvider({
      generatedObjects: [researchAssessment],
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-15",
      runId: "run-legacy-completed-checkpoint",
      store,
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: assessmentProvider,
      },
      collectCandidates: async () => {
        throw new Error("completed collect must not run");
      },
      researchRepository: {
        getDiscoveryObservations: async () => [],
        upsertDiscoveryObservations: async () => undefined,
        getCachedResearchAssessment: async (
          _canonicalId,
          evidenceFingerprint,
        ) => {
          observedEvidenceFingerprints.push(evidenceFingerprint);
          return null;
        },
        putCachedResearchAssessment: async () => undefined,
      },
    });
    context.normalize = async () => {
      throw new Error("completed normalize must not run");
    };
    context.score = async () => {
      throw new Error("STOP_AFTER_ASSESS");
    };
    await store.createRun({
      id: context.runId,
      editionDate: context.editionDate,
      status: "retryable",
      currentStep: "prefilter",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const step of ["collect", "normalize", "enrich", "prefilter"] as const) {
      await store.saveCheckpoint(context.runId, step, {
        output: [legacyItem, legacyNews],
        attempts: 1,
        durationMs: 0,
        itemCount: 2,
        estimatedCostUsd: 0,
      });
    }

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_ASSESS",
    );

    const sourcePacket = assessmentProvider.generateRequests[0]?.sourcePacket;
    expect(sourcePacket).toContain("title: Checkpoint research title");
    expect(sourcePacket).toContain("source_name: Checkpoint & Source");
    expect(sourcePacket).toContain("Checkpoint evidence for assessment.");
    expect(sourcePacket).not.toContain("&#");
    const assessedArtifact = store.artifacts.get(
      `${context.runId}:assess`,
    ) as CheckpointArtifact<readonly Item[]>;
    const assessed = assessedArtifact.output[0]!;
    const assessedNews = assessedArtifact.output[1]!;
    const compact = (assessed.metadata.workflow as {
      rawResearch: RawResearchCandidate;
    }).rawResearch;
    expect(compact.metadata).toEqual({});
    expect(assessed.metadata.provenance).toEqual([{
      ...structuralProvenance,
      sourceName: "Checkpoint & Source",
    }]);
    expect(assessed.metadata.normalizedAuthors).toEqual([]);
    expect(assessed.metadata.contentFingerprint).toBeUndefined();
    expect(assessed.metadata.evidenceFingerprint).toBeUndefined();
    expect(observedEvidenceFingerprints).toEqual([
      researchFingerprints(assessed).evidenceFingerprint,
    ]);
    expect(observedEvidenceFingerprints).not.toContain(
      "evidence:stale-legacy-value",
    );
    expect(assessed.metadata.namedEntities).toEqual([]);
    expect(assessed.metadata.eventFamilies).toEqual([]);
    expect(assessed.metadata.eventInstances).toEqual([]);
    expect(assessed.metadata.materialFacts).toEqual([]);
    expect(assessed.metadata.scopedMaterialFacts).toEqual([]);
    expect(assessed.tags).toEqual(freshLegacyResearch.tags);
    expect(assessed.metadata.configuredTopics).toContain(
      "alignment-interpretability",
    );
    expect(assessed.primaryTopic).toBe("alignment-interpretability");
    expect(assessed.metadata.attachedCommentary).toEqual([
      expect.objectContaining({
        title: "Attached Commentary",
        excerpt: "Attached evidence excerpt.",
      }),
    ]);
    expect(JSON.stringify(assessed.metadata.editorialSignals)).not.toContain(
      "&#",
    );
    expect(JSON.stringify(sourcePacketForItem(assessed))).toContain(
      "Attached Commentary",
    );
    expect(JSON.stringify(sourcePacketForItem(assessed))).toContain(
      "Attached evidence excerpt.",
    );
    for (const field of [
      "namedEntities",
      "eventFamilies",
      "eventInstances",
      "materialFacts",
      "scopedMaterialFacts",
      "editorialSignals",
    ] as const) {
      expect(assessedNews.metadata[field]).toEqual(freshNews.metadata[field]);
    }
    expect(assessedNews).toMatchObject({
      title: freshNews.title,
      normalizedText: freshNews.normalizedText,
      primaryTopic: freshNews.primaryTopic,
      tags: freshNews.tags,
    });
    expect(clusterNews([assessedNews], {})).toEqual(
      clusterNews([freshNews], {}),
    );
    expect(JSON.stringify(assessedNews)).not.toContain("Stale &#");
    expect(triageResearch([assessed], {
      maximum: 1,
      maximumPerFamily: 1,
      maximumPerPublisherDomain: 1,
      configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
      now,
    }).items).toHaveLength(1);
    const staleIdentity = (id: string): Item => ItemSchema.parse({
      ...assessed,
      id,
      canonicalUrl: `https://${id}.example/research`,
      sourceRefs: assessed.sourceRefs.map((source) => ({
        ...source,
        id,
        url: `https://${id}.example/source`,
      })),
      metadata: {
        ...assessed.metadata,
        externalIds: [],
      },
    });
    expect(consolidateResearchCandidates([
      staleIdentity("legacy-no-author-a"),
      staleIdentity("legacy-no-author-b"),
    ]).papers).toHaveLength(2);
    expect(JSON.stringify(
      (store.artifacts.get(`${context.runId}:normalize`) as
        CheckpointArtifact<readonly Item[]>).output,
    )).toContain("arbitraryRawDisplay");
  });

  it.each([
    ["title", "&lt;br&gt;"],
    ["sourceName", "&lt;br&gt;"],
    ["title", "&#65308;br&#65310;"],
    ["sourceName", "&#65308;br&#65310;"],
  ] as const)(
    "drops only an encoded-markup-empty Item %s value %s from a legacy normalize checkpoint",
    async (invalidField, invalidValue) => {
      const store = new FixtureStore();
      const invalidFixture = fixtureItem(
        `legacy-normalize-empty-${invalidField}`,
        "world",
      );
      const invalid = ItemSchema.parse({
        ...invalidFixture,
        ...(invalidField === "title" ? { title: invalidValue } : {}),
        sourceRefs: invalidFixture.sourceRefs.map((source) => ({
          ...source,
          ...(invalidField === "sourceName" ? { name: invalidValue } : {}),
        })),
      });
      const valid = fixtureItem("legacy-normalize-valid-title", "world");
      const restoredInputs: Item[][] = [];
      const context = createProductionPipelineContext({
        editionDate: "2033-01-16",
        runId: "run-legacy-normalize-empty-title",
        store,
        now: () => now,
        providers: {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
        collectCandidates: async () => {
          throw new Error("completed collect must not run");
        },
      });
      context.normalize = async () => {
        throw new Error("completed normalize must not run");
      };
      context.enrich = async (items) => {
        restoredInputs.push([...items]);
        throw new Error("STOP_AFTER_LEGACY_NORMALIZE_RESTORE");
      };
      await store.createRun({
        id: context.runId,
        editionDate: context.editionDate,
        status: "retryable",
        currentStep: "normalize",
        retryable: true,
        attemptCount: 1,
        estimatedCostUsd: 0,
        createdAt: now,
        updatedAt: now,
      });
      await store.saveCheckpoint(context.runId, "collect", {
        output: [],
        attempts: 1,
        durationMs: 0,
        itemCount: 0,
        estimatedCostUsd: 0,
      });
      await store.saveCheckpoint(context.runId, "normalize", {
        output: [invalid, valid],
        attempts: 1,
        durationMs: 0,
        itemCount: 2,
        estimatedCostUsd: 0,
      });

      await expect(runEditorialPipeline(context)).rejects.toThrow(
        "STOP_AFTER_LEGACY_NORMALIZE_RESTORE",
      );
      expect(restoredInputs).toHaveLength(1);
      expect(restoredInputs[0]?.map(({ id }) => id)).toEqual([valid.id]);
    },
  );

  it("normalizes a completed collect Item only once before normalization", async () => {
    const store = new FixtureStore();
    const legacyRaw = rawResearchCandidate(
      "2607.single-boundary",
      "Research &amp;amp;#8217; result",
    );
    const legacyItem = ItemSchema.parse({
      ...fixtureItem("single-boundary-research", "research"),
      title: "Research &amp;amp;#8217; result",
      sourceRefs: [{
        ...fixtureItem("single-boundary-source", "research").sourceRefs[0]!,
        id: "arxiv",
        name: "Source &amp;amp;#8217; Name",
        url: legacyRaw.originalUrl,
      }],
      normalizedText: "Evidence &amp;amp;#8217; remains bounded.",
      metadata: {
        authors: ["Author &amp;amp;#8217; Name"],
        institutions: ["Institute &amp;amp;#8217; Name"],
        providerTopics: ["Topic &amp;amp;#8217; Name"],
        workflow: { version: 1, rawResearch: legacyRaw },
      },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-17",
      runId: "run-single-provider-text-boundary",
      store,
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => {
        throw new Error("completed collect must not run");
      },
    });
    context.enrich = async () => {
      throw new Error("STOP_AFTER_NORMALIZE");
    };
    await store.createRun({
      id: context.runId,
      editionDate: context.editionDate,
      status: "retryable",
      currentStep: "collect",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveCheckpoint(context.runId, "collect", {
      output: [legacyItem],
      attempts: 1,
      durationMs: 0,
      itemCount: 1,
      estimatedCostUsd: 0,
    });

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_NORMALIZE",
    );

    const normalizedArtifact = store.artifacts.get(
      `${context.runId}:normalize`,
    ) as CheckpointArtifact<readonly Item[]>;
    const normalized = normalizedArtifact.output[0]!;
    expect(normalized.title).toBe("Research &#8217; result");
    expect(normalized.sourceRefs[0]!.name).toBe("Source &#8217; Name");
    expect(normalized.normalizedText).toBe(
      "Evidence &#8217; remains bounded.",
    );
    expect((normalized.metadata.workflow as {
      rawResearch: RawResearchCandidate;
    }).rawResearch.title).toBe("Research &#8217; result");
  });

  it("normalizes nested development Items restored from a completed shortlist", async () => {
    const store = new FixtureStore();
    const summaryProvider = new GroundedProductionProvider();
    summaryProvider.failNextSummary = false;
    const context = createProductionPipelineContext({
      editionDate: "2033-01-18",
      runId: "run-legacy-news-development",
      store,
      now: () => now,
      providers: {
        summary: summaryProvider,
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [
        rawNewsCandidate("legacy-development", "world"),
      ],
    });
    const collected = await context.collect();
    const [normalized] = await context.normalize(collected);
    const normalizedWorkflow = normalized!.metadata.workflow as
      Record<string, unknown>;
    const enriched = ItemSchema.parse({
      ...normalized!,
      metadata: {
        ...normalized!.metadata,
        workflow: {
          ...normalizedWorkflow,
          embedding: [1, 0],
          personalRelevance: 0.8,
        },
      },
    });
    const [scored] = await context.score([enriched]);
    const [clustered] = await context.cluster([scored!]);
    const clusteredWorkflow = structuredClone(
      clustered!.metadata.workflow as Record<string, unknown>,
    ) as Record<string, unknown> & {
      development: {
        title: string;
        items: Item[];
        representativeItem: Item;
      };
    };
    const nested = clusteredWorkflow.development.items[0]!;
    const {
      providerTextNormalizationVersion: _nestedWorkflowVersion,
      ...legacyNestedWorkflow
    } = nested.metadata.workflow as Record<string, unknown>;
    const {
      workflow: _nestedWorkflow,
      ...nestedMetadata
    } = nested.metadata;
    const encodedNested = ItemSchema.parse({
      ...nested,
      title: "Nested &#114;eport",
      sourceRefs: nested.sourceRefs.map((source) => ({
        ...source,
        name: "Nested &amp; Source",
      })),
      normalizedText: "Nested &#101;vidence for synthesis.",
      metadata: {
        ...nestedMetadata,
        providerTextNormalizationVersion: 1,
        workflow: legacyNestedWorkflow,
      },
    });
    clusteredWorkflow.development = {
      ...clusteredWorkflow.development,
      title: "Nested &#114;eport",
      items: [encodedNested],
      representativeItem: encodedNested,
    };
    const {
      providerTextNormalizationVersion: _clusterWorkflowVersion,
      ...legacyClusteredWorkflow
    } = clusteredWorkflow;
    const legacyShortlisted = ItemSchema.parse({
      ...clustered!,
      metadata: {
        ...clustered!.metadata,
        providerTextNormalizationVersion: 1,
        section: "world",
        workflow: {
          ...legacyClusteredWorkflow,
          section: "world",
          selectionReasons: ["Fixture selection."],
        },
      },
    });
    context.validate = async () => {
      throw new Error("STOP_AFTER_SYNTHESIS");
    };
    await store.createRun({
      id: context.runId,
      editionDate: context.editionDate,
      status: "retryable",
      currentStep: "shortlist",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    const outputs = new Map<string, unknown>([
      ["collect", collected],
      ["normalize", [normalized]],
      ["enrich", [enriched]],
      ["prefilter", [enriched]],
      ["assess", [enriched]],
      ["score", [scored]],
      ["cluster", [legacyShortlisted]],
      ["shortlist", [legacyShortlisted]],
    ]);
    for (const [step, output] of outputs) {
      await store.saveCheckpoint(context.runId, step, {
        output,
        attempts: 1,
        durationMs: 0,
        itemCount: 1,
        estimatedCostUsd: 0,
      });
    }

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_SYNTHESIS",
    );

    const packet = summaryProvider.generateRequests[0]?.sourcePacket;
    expect(packet).toContain("title: Nested report");
    expect(packet).toContain("source_name: Nested & Source");
    expect(packet).toContain("Nested evidence for synthesis.");
    expect(packet).not.toContain("&#");
  });

  it("ignores a fresh Item's spoofed workflow normalization marker", async () => {
    const store = new FixtureStore();
    const legacyRaw = rawResearchCandidate(
      "2607.spoofed-marker",
      "Fresh &amp;amp;#8217; research",
    );
    const spoofed = ItemSchema.parse({
      ...fixtureItem("spoofed-marker-research", "research"),
      title: "Fresh &amp;amp;#8217; research",
      sourceRefs: [{
        ...fixtureItem("spoofed-marker-source", "research").sourceRefs[0]!,
        id: "arxiv",
        name: "Fresh &amp;amp;#8217; Source",
        url: legacyRaw.originalUrl,
      }],
      normalizedText: "Fresh &amp;amp;#8217; evidence.",
      metadata: {
        workflow: {
          version: 1,
          providerTextNormalizationVersion: 1,
          rawResearch: legacyRaw,
        },
      },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-19",
      runId: "run-spoofed-item-marker",
      store,
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [spoofed],
    });
    context.enrich = async () => {
      throw new Error("STOP_AFTER_NORMALIZE");
    };

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_NORMALIZE",
    );

    const artifact = store.artifacts.get(
      `${context.runId}:normalize`,
    ) as CheckpointArtifact<readonly Item[]>;
    const normalized = artifact.output[0]!;
    expect(normalized.title).toBe("Fresh &#8217; research");
    expect(normalized.sourceRefs[0]!.name).toBe("Fresh &#8217; Source");
    expect(normalized.normalizedText).toBe("Fresh &#8217; evidence.");
  });

  it("trusts a current synthesis envelope without changing workflow-less nested Items", async () => {
    const store = new FixtureStore();
    const context = createProductionPipelineContext({
      editionDate: "2033-01-20",
      runId: "run-current-synthesis-envelope",
      store,
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [
        rawNewsCandidate("current-envelope-development", "world"),
      ],
    });
    const collected = await context.collect();
    const [normalized] = await context.normalize(collected);
    const enriched = ItemSchema.parse({
      ...normalized!,
      metadata: {
        ...normalized!.metadata,
        workflow: {
          ...(normalized!.metadata.workflow as Record<string, unknown>),
          embedding: [1, 0],
          personalRelevance: 0.8,
        },
      },
    });
    const [scored] = await context.score([enriched]);
    const [clustered] = await context.cluster([scored!]);
    const workflow = structuredClone(
      clustered!.metadata.workflow as Record<string, unknown>,
    ) as Record<string, unknown> & {
      development: {
        items: Item[];
        representativeItem: Item;
      };
    };
    const nested = workflow.development.items[0]!;
    const encodedWorkflowlessNested = ItemSchema.parse({
      ...nested,
      title: "Current &#8217; nested report",
      sourceRefs: nested.sourceRefs.map((source) => ({
        ...source,
        name: "Current &#8217; nested source",
      })),
      normalizedText: "Current &#8217; nested evidence.",
      metadata: Object.fromEntries(
        Object.entries(nested.metadata).filter(([key]) => key !== "workflow"),
      ),
    });
    workflow.development = {
      ...workflow.development,
      items: [encodedWorkflowlessNested],
      representativeItem: encodedWorkflowlessNested,
    };
    const shortlisted = ItemSchema.parse({
      ...clustered!,
      metadata: {
        ...clustered!.metadata,
        section: "world",
        workflow: {
          ...workflow,
          section: "world",
          selectionReasons: ["Fixture selection."],
        },
      },
    });
    const observed: Item[] = [];
    context.validate = async (entries) => {
      const restoredWorkflow = entries[0]!.item.metadata.workflow as {
        development: { items: Item[] };
      };
      observed.push(structuredClone(restoredWorkflow.development.items[0]!));
      throw new Error("STOP_AFTER_SYNTHESIS_RESTORE");
    };
    await store.createRun({
      id: context.runId,
      editionDate: context.editionDate,
      status: "retryable",
      currentStep: "synthesize",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageOutputs = new Map<string, unknown>([
      ["collect", collected],
      ["normalize", [normalized]],
      ["enrich", [enriched]],
      ["prefilter", [enriched]],
      ["assess", [enriched]],
      ["score", [scored]],
      ["cluster", [shortlisted]],
      ["shortlist", [shortlisted]],
    ]);
    for (const [step, output] of stageOutputs) {
      await store.saveCheckpoint(context.runId, step, {
        output,
        attempts: 1,
        durationMs: 0,
        itemCount: 1,
        estimatedCostUsd: 0,
      });
    }
    await store.saveCheckpoint(context.runId, "synthesize", {
      output: [{ item: shortlisted, summary: fixtureSummary(shortlisted) }],
      attempts: 1,
      durationMs: 0,
      itemCount: 1,
      estimatedCostUsd: 0,
      providerTextNormalizationVersion: 1,
    });

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_SYNTHESIS_RESTORE",
    );
    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_SYNTHESIS_RESTORE",
    );

    expect(observed).toHaveLength(2);
    expect(observed[0]!.title).toBe("Current &#8217; nested report");
    expect(observed[0]!.sourceRefs[0]!.name).toBe(
      "Current &#8217; nested source",
    );
    expect(observed[0]!.normalizedText).toBe(
      "Current &#8217; nested evidence.",
    );
    expect(observed[0]!.metadata.workflow).toBeUndefined();
    expect(observed[1]).toEqual(observed[0]);
  });

  it("promotes a legacy checkpoint graph to a stable current envelope", async () => {
    const store = new FixtureStore();
    const legacy = ItemSchema.parse({
      ...fixtureItem("legacy-envelope-item", "world"),
      title: "Legacy &amp;amp;#8217; item",
      sourceRefs: fixtureItem("legacy-envelope-source", "world").sourceRefs.map(
        (source) => ({ ...source, name: "Legacy &amp;amp;#8217; Source" }),
      ),
      normalizedText: "Legacy &amp;amp;#8217; evidence.",
      metadata: {
        authors: ["Legacy &#65;uthor"],
        normalizedAuthors: ["stale-author"],
      },
    });
    const observed: Item[] = [];
    const context = fixturePipelineContext({
      editionDate: "2033-01-21",
      runId: "run-legacy-envelope-promotion",
    });
    context.store = store;
    context.enrich = async (items) => items;
    context.prefilter = async (items) => {
      observed.push(structuredClone(items[0]!));
      throw new Error("STOP_AFTER_ENRICH_RESTORE");
    };
    await store.createRun({
      id: context.runId,
      editionDate: context.editionDate,
      status: "retryable",
      currentStep: "normalize",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveCheckpoint(context.runId, "collect", {
      output: [],
      attempts: 1,
      durationMs: 0,
      itemCount: 0,
      estimatedCostUsd: 0,
    });
    await store.saveCheckpoint(context.runId, "normalize", {
      output: [legacy],
      attempts: 1,
      durationMs: 0,
      itemCount: 1,
      estimatedCostUsd: 0,
    });

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_ENRICH_RESTORE",
    );
    const legacyArtifact = store.artifacts.get(
      `${context.runId}:normalize`,
    ) as CheckpointArtifact<readonly Item[]>;
    const currentArtifact = store.artifacts.get(
      `${context.runId}:enrich`,
    ) as CheckpointArtifact<readonly Item[]> & {
      providerTextNormalizationVersion?: number;
    };
    expect(legacyArtifact.output[0]!.title).toBe(
      "Legacy &amp;amp;#8217; item",
    );
    expect(currentArtifact.providerTextNormalizationVersion).toBe(1);

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_ENRICH_RESTORE",
    );

    expect(observed).toHaveLength(2);
    expect(observed[0]!.title).toBe("Legacy &#8217; item");
    expect(observed[0]!.metadata.workflow).toBeUndefined();
    expect(observed[0]!.metadata.authors).toEqual(["Legacy Author"]);
    expect(observed[0]!.metadata.normalizedAuthors).toEqual([
      "legacy author",
    ]);
    expect(observed[1]).toEqual(observed[0]);
  });

  it("marks prepared collect and normalized item checkpoints separately", async () => {
    const store = new FixtureStore();
    const context = createProductionPipelineContext({
      editionDate: "2033-01-22",
      runId: "run-checkpoint-envelope-labels",
      store,
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [
        rawResearchCandidate(
          "2607.envelope-labels",
          "Raw interpretability &amp;amp;#8217; research",
        ),
      ],
    });
    context.enrich = async () => {
      throw new Error("STOP_AFTER_NORMALIZE");
    };

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_NORMALIZE",
    );

    const collectArtifact = store.artifacts.get(
      `${context.runId}:collect`,
    ) as CheckpointArtifact<unknown> & {
      providerTextNormalizationVersion?: number;
      providerTextPreparationVersion?: number;
    };
    const normalizeArtifact = store.artifacts.get(
      `${context.runId}:normalize`,
    ) as CheckpointArtifact<unknown> & {
      providerTextNormalizationVersion?: number;
    };
    expect(collectArtifact.providerTextNormalizationVersion).toBeUndefined();
    expect(collectArtifact.providerTextPreparationVersion).toBe(
      PROVIDER_TEXT_PREPARATION_VERSION,
    );
    expect(JSON.stringify(collectArtifact.output)).toContain(
      "Raw interpretability &#8217; research",
    );
    expect(normalizeArtifact.providerTextNormalizationVersion).toBe(1);
    expect((normalizeArtifact.output as Item[])[0]?.title).toBe(
      "Raw interpretability &#8217; research",
    );

    await expect(runEditorialPipeline(context)).rejects.toThrow(
      "STOP_AFTER_NORMALIZE",
    );
    expect((normalizeArtifact.output as Item[])[0]?.title).toBe(
      "Raw interpretability &#8217; research",
    );
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

  it("persists compact normalized research display text and assesses only normalized evidence", async () => {
    const assessmentProvider = new FakeModelProvider({
      generatedObjects: [researchAssessment],
    });
    const originalUrl =
      "https://research.example.com/paper?cursor=a%26amp%3Bb";
    const candidate: RawResearchCandidate = {
      ...rawResearchCandidate("2607.encoded", "Mechanistic &#105;nterpretability &amp; oversight"),
      sourceName: "arXiv &amp; Labs",
      originalUrl,
      externalId: "Corpus:record-1",
      externalIds: ["Corpus:record-1", "Corpus:related-2"],
      authors: ["Ada &#69;xample"],
      institutions: ["&#83;tanford"],
      abstract:
        "Mechanistic &#105;nterpretability improves oversight &amp; evaluation.",
      relatedPaperIds: ["Corpus:related&#65;"],
      preferredInstitutionMatches: ["&#83;tanford"],
      topics: ["&#73;nterpretability"],
      metadata: {
        venue: "Journal &amp; Review",
        topics: ["&#73;nterpretability", "AI &amp; Society"],
        arbitraryProviderDisplay: "Do not persist &#82;aw provider metadata",
      },
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-12",
      runId: "run-normalized-research-display-text",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: assessmentProvider,
      },
      collectCandidates: async () => [candidate],
    });

    const [item] = await context.normalize(await context.collect());
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      title: "Mechanistic interpretability & oversight",
      sourceRefs: [{ name: "arXiv & Labs", url: originalUrl }],
      metadata: {
        authors: ["Ada Example"],
        institutions: ["Stanford"],
        providerTopics: ["Interpretability"],
        preferredInstitutionMatches: ["Stanford"],
        venue: "Journal & Review",
        topics: ["AI & Society", "Interpretability"],
        provenance: [{ sourceName: "arXiv & Labs" }],
      },
    });
    await new D1BriefingRepository(env.DB).upsertItems([item!]);
    const row = await env.DB.prepare(
      "SELECT normalized_json FROM items WHERE id = ?",
    ).bind(item!.id).first<{ normalized_json: string }>();
    const persistedItem = ItemSchema.parse(JSON.parse(row!.normalized_json));
    const rawResearch = (persistedItem.metadata.workflow as {
      rawResearch: RawResearchCandidate;
    }).rawResearch;
    expect(rawResearch).toMatchObject({
      kind: "paper",
      title: "Mechanistic interpretability & oversight",
      sourceId: "arxiv",
      sourceName: "arXiv & Labs",
      sourceRole: "primary",
      originalUrl,
      externalId: "Corpus:record-1",
      externalIds: ["Corpus:record-1", "Corpus:related-2"],
      publishedAt: now,
      retrievedAt: now,
      accessLevel: "abstract",
      authors: ["Ada Example"],
      institutions: ["Stanford"],
      abstract: null,
      content: null,
      relatedPaperIds: ["Corpus:related&#65;"],
      preferredInstitutionMatches: ["Stanford"],
      citationCount: 4,
      influentialCitationCount: 1,
      topics: ["Interpretability"],
      metadata: {},
    });
    expect(JSON.stringify(rawResearch)).not.toContain(
      "arbitraryProviderDisplay",
    );

    await context.assess([persistedItem]);
    const sourcePacket = assessmentProvider.generateRequests[0]?.sourcePacket;
    expect(sourcePacket).toContain(
      "title: Mechanistic interpretability & oversight",
    );
    expect(sourcePacket).toContain("source_name: arXiv & Labs");
    expect(sourcePacket).toContain(
      "Mechanistic interpretability improves oversight & evaluation.",
    );
    expect(sourcePacket).not.toContain("&#");
  });

  it("bounds normalized research display fields after NFKC expansion", async () => {
    const expanding = "ﬃ".repeat(200);
    const candidate: RawResearchCandidate = {
      ...rawResearchCandidate("2607.expanding", expanding),
      sourceName: expanding,
      authors: [expanding, "&nbsp;"],
      institutions: [expanding, "&nbsp;"],
      preferredInstitutionMatches: [expanding],
      topics: [expanding],
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-13",
      runId: "run-bounded-research-display-text",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [candidate],
    });

    const [item] = await context.normalize(await context.collect());
    const rawResearch = (item!.metadata.workflow as {
      rawResearch: RawResearchCandidate;
    }).rawResearch;

    expect(item!.title).toHaveLength(500);
    expect(item!.sourceRefs[0]!.name).toHaveLength(500);
    expect(item!.metadata.authors).toEqual(["ffi".repeat(166) + "ff"]);
    expect(item!.metadata.institutions).toEqual(["ffi".repeat(166) + "ff"]);
    expect(rawResearch.title).toHaveLength(500);
    expect(rawResearch.sourceName).toHaveLength(500);
    expect(rawResearch.authors[0]).toHaveLength(500);
    expect(rawResearch.institutions[0]).toHaveLength(500);
    expect(rawResearch.preferredInstitutionMatches[0]).toHaveLength(500);
    expect(rawResearch.topics[0]).toHaveLength(500);
  });

  it("recompacts legacy Item workflow research before persistence and assessment", async () => {
    const legacyRaw: RawResearchCandidate = {
      ...rawResearchCandidate(
        "2607.legacy",
        "Legacy &#114;esearch title",
      ),
      sourceName: "Legacy &amp; Source",
      authors: ["Legacy &#65;uthor"],
      institutions: ["Legacy &#73;nstitute"],
      preferredInstitutionMatches: ["Legacy &#73;nstitute"],
      topics: ["&#73;nterpretability"],
      metadata: { arbitraryRawDisplay: "Legacy &#82;aw metadata" },
    };
    const legacyItem = ItemSchema.parse({
      ...fixtureItem("legacy-research-item", "research"),
      title: "Stored &#114;esearch title",
      sourceRefs: [{
        ...fixtureItem("legacy-source", "research").sourceRefs[0]!,
        id: "arxiv",
        name: "Legacy &amp; Source",
        url: legacyRaw.originalUrl,
      }],
      normalizedText: "Stored &#101;vidence for assessment.",
      metadata: {
        authors: ["Stored &#65;uthor"],
        institutions: ["Stored &#73;nstitute"],
        providerTopics: ["&#73;nterpretability"],
        venue: "Stored &amp; Venue",
        topics: ["AI &amp; Society"],
        provenance: [{
          sourceId: "legacy&#65;source",
          sourceName: "Legacy &amp; Source",
          role: "primary",
          accessLevel: "abstract",
          url: "https://example.com/source?id=%26amp%3B",
          retrievedAt: now,
          canCorroborateFacts: true,
        }],
        workflow: { version: 1, rawResearch: legacyRaw },
      },
    });
    const assessmentProvider = new FakeModelProvider({
      generatedObjects: [researchAssessment],
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-14",
      runId: "run-recompact-legacy-item",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: assessmentProvider,
      },
      collectCandidates: async () => [legacyItem],
    });

    const [item] = await context.normalize(await context.collect());
    const compact = (item!.metadata.workflow as {
      rawResearch: RawResearchCandidate;
    }).rawResearch;

    expect(item).toMatchObject({
      title: "Stored research title",
      normalizedText: "Stored evidence for assessment.",
      sourceRefs: [{ name: "Legacy & Source" }],
      metadata: {
        authors: ["Stored Author"],
        institutions: ["Stored Institute"],
        providerTopics: ["Interpretability"],
        venue: "Stored & Venue",
        topics: ["AI & Society"],
        provenance: [{
          sourceId: "legacy&#65;source",
          sourceName: "Legacy & Source",
          role: "primary",
          accessLevel: "abstract",
          url: "https://example.com/source?id=%26amp%3B",
          retrievedAt: now,
          canCorroborateFacts: true,
        }],
      },
    });
    expect(compact).toMatchObject({
      title: "Stored research title",
      sourceName: "Legacy & Source",
      authors: ["Stored Author"],
      institutions: ["Stored Institute"],
      preferredInstitutionMatches: ["Legacy Institute"],
      topics: ["Interpretability"],
      abstract: null,
      content: null,
      metadata: {},
    });

    const [assessed] = await context.assess([item!]);
    expect(assessmentProvider.generateRequests[0]?.sourcePacket).toContain(
      "Stored evidence for assessment.",
    );
    expect(assessmentProvider.generateRequests[0]?.sourcePacket).not.toContain(
      "&#",
    );
    const [scored] = await context.score([ItemSchema.parse({
      ...assessed!,
      metadata: {
        ...assessed!.metadata,
        workflow: {
          ...(assessed!.metadata.workflow as Record<string, unknown>),
          topicalFit: 0.8,
        },
      },
    })]);
    expect((scored!.metadata.workflow as {
      researchScore: { researchSignal: number };
    }).researchScore.researchSignal).toBe(0.65);
  });

  it("bounds oversized legacy research metadata arrays deterministically", async () => {
    const values = Array.from(
      { length: 70 },
      (_, index) => `Entry &amp; ${index.toString().padStart(2, "0")}`,
    );
    const legacyRaw = rawResearchCandidate(
      "2607.oversized-legacy",
      "Oversized legacy metadata",
    );
    const legacyItem = ItemSchema.parse({
      ...fixtureItem("oversized-legacy-research", "research"),
      sourceRefs: [{
        ...fixtureItem("oversized-legacy-source", "research").sourceRefs[0]!,
        id: "arxiv",
        url: legacyRaw.originalUrl,
      }],
      metadata: {
        authors: values,
        institutions: values,
        providerTopics: values,
        preferredInstitutionMatches: values,
        workflow: { version: 1, rawResearch: legacyRaw },
      },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-16",
      runId: "run-bound-legacy-research-arrays",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [legacyItem],
    });

    const [item] = await context.normalize(await context.collect());
    const compact = (item!.metadata.workflow as {
      rawResearch: RawResearchCandidate;
    }).rawResearch;

    for (const entries of [
      compact.authors,
      compact.institutions,
      compact.topics,
      compact.preferredInstitutionMatches,
    ]) {
      expect(entries).toHaveLength(64);
      expect(entries[0]).toBe("Entry & 00");
      expect(entries[63]).toBe("Entry & 63");
    }
  });

  it("updates real-lane diagnostics through assessment and applies research context scoring", async () => {
    const diagnosticWrites: Array<readonly unknown[]> = [];
    let persistedDiagnostics: DiscoveryDiagnosticsState | undefined;
    let failedNormalizeDiagnostics: DiscoveryDiagnosticsState | undefined;
    const observationWrites: Array<readonly DiscoveryObservation[]> = [];
    const initialDiagnostics = [
      {
        laneId: "arxiv:one",
        sourceId: "arxiv",
        discoveryFamily: "arxiv" as const,
        discovered: 2,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success" as const,
        rejectionCounts: {},
      },
      {
        laneId: "arxiv:zero",
        sourceId: "arxiv",
        discoveryFamily: "arxiv" as const,
        discovered: 0,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success" as const,
        rejectionCounts: {},
      },
      {
        laneId: "papers-with-code-co:page",
        sourceId: "papers-with-code-co",
        discoveryFamily: "commentary" as const,
        discovered: 1,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success" as const,
        rejectionCounts: {},
      },
    ];
    const repository = {
      getDiscoveryObservations: async () => [],
      upsertDiscoveryObservations: async (
        observations: readonly DiscoveryObservation[],
      ) => {
        observationWrites.push(structuredClone(observations));
      },
      getCachedResearchAssessment: async () => null,
      putCachedResearchAssessment: async () => undefined,
      recordDiscoveryDiagnostics: async (
        _runId: string,
        diagnostics: DiscoveryDiagnosticsState["diagnostics"],
        rejectionCountsByStage?: DiscoveryDiagnosticsState[
          "rejectionCountsByStage"
        ],
      ) => {
        diagnosticWrites.push(structuredClone(diagnostics));
        persistedDiagnostics = structuredClone({
          diagnostics,
          rejectionCountsByStage: rejectionCountsByStage!,
        });
        if (diagnosticWrites.length === 2) {
          failedNormalizeDiagnostics = persistedDiagnostics;
        }
      },
    };
    const assessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract" as const,
    };
    const candidate = {
      ...rawResearchCandidate(),
      metadata: {
        discoveryFamily: "arxiv",
        discoveryLaneIds: ["arxiv:one"],
        implementationAvailable: true,
      },
    };
    const secondCandidate = {
      ...rawResearchCandidate(
        "2607.54321",
        "A second interpretability paper for oversight",
      ),
      metadata: {
        discoveryFamily: "arxiv",
        discoveryLaneIds: ["arxiv:one"],
      },
    };
    const commentary = {
      ...rawResearchCandidate(),
      kind: "blog" as const,
      sourceId: "papers-with-code-co",
      sourceName: "Papers with Code",
      sourceRole: "blog" as const,
      originalUrl: "https://paperswithcode.co/paper/2607.12345",
      externalId: "papers-with-code:2607.12345",
      externalIds: ["papers-with-code:2607.12345"],
      accessLevel: "metadata" as const,
      abstract: null,
      content: null,
      relatedPaperIds: [candidate.externalId, secondCandidate.externalId],
      preferredInstitutionMatches: [],
      citationCount: null,
      influentialCitationCount: null,
      metadata: {
        discoveryFamily: "commentary",
        discoveryLaneIds: ["papers-with-code-co:page"],
        implementationAvailable: true,
      },
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-20",
      runId: "run-discovery-diagnostics",
      store: new FixtureStore(),
      now: () => now,
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
          generatedObjects: [assessment, assessment],
        }),
      },
      collectCandidates: async () => [candidate, secondCandidate, commentary],
      loadDiscoveryDiagnostics: () => initialDiagnostics,
      researchRepository: repository,
    });

    const collected = await context.collect();
    const normalized = await context.normalize(collected);
    const enriched = await context.enrich(normalized);
    const triaged = await context.prefilter(enriched);
    const assessed = await context.assess(triaged);
    const scored = await context.score(assessed);

    expect(diagnosticWrites).toEqual([
      initialDiagnostics,
      [
        { ...initialDiagnostics[0], deduplicated: 2 },
        initialDiagnostics[1],
        {
          ...initialDiagnostics[2],
          deduplicated: 1,
          rejectionCounts: { identity_merged: 1 },
        },
      ],
      [
        { ...initialDiagnostics[0], deduplicated: 2, triaged: 2 },
        initialDiagnostics[1],
        {
          ...initialDiagnostics[2],
          deduplicated: 1,
          triaged: 1,
          rejectionCounts: { identity_merged: 1 },
        },
      ],
      [
        {
          ...initialDiagnostics[0],
          deduplicated: 2,
          triaged: 2,
          assessed: 2,
        },
        initialDiagnostics[1],
        {
          ...initialDiagnostics[2],
          deduplicated: 1,
          triaged: 1,
          assessed: 1,
          rejectionCounts: { identity_merged: 1 },
        },
      ],
    ]);
    expect(observationWrites.flat().filter(({ sourceId }) =>
      sourceId === "papers-with-code-co"
    ).every(({ discoveryFamily }) => discoveryFamily === "commentary")).toBe(
      true,
    );
    expect(observationWrites.flat().filter(({ sourceId }) =>
      sourceId === "arxiv"
    ).every(({ discoveryFamily }) => discoveryFamily === "arxiv")).toBe(true);
    expect(
      (scored[0]?.metadata.workflow as {
        researchScore?: { selectionReasons: string[] };
      }).researchScore?.selectionReasons,
    ).toContain("Independent implementation located.");

    const resumedWrites: Array<readonly unknown[]> = [];
    const resumeContext = createProductionPipelineContext({
      editionDate: "2033-01-20",
      runId: "run-discovery-diagnostics",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
      loadDiscoveryDiagnostics: async () => failedNormalizeDiagnostics!,
      researchRepository: {
        ...repository,
        recordDiscoveryDiagnostics: async (
          _runId: string,
          diagnostics: DiscoveryDiagnosticsState["diagnostics"],
          rejectionCountsByStage?: DiscoveryDiagnosticsState[
            "rejectionCountsByStage"
          ],
        ) => {
          resumedWrites.push(structuredClone(diagnostics));
          expect(rejectionCountsByStage).toEqual(
            failedNormalizeDiagnostics?.rejectionCountsByStage,
          );
        },
      },
    });

    await resumeContext.normalize(collected);
    expect(resumedWrites).toEqual([diagnosticWrites[1]]);
  });

  it("attributes every rejected identity from merge groups larger than stored lineage", async () => {
    const laneIds = Array.from(
      { length: 64 },
      (_, index) => `arxiv:large-merge-${String(index).padStart(2, "0")}`,
    );
    const candidates = Array.from({ length: 20 }, (_, index) => {
      const base = rawResearchCandidate(
        "2607.77777",
        "A large multi-provider identity merge",
      );
      const retained = index === 0;
      return {
        ...base,
        sourceId: `provider-${String(index).padStart(2, "0")}`,
        sourceName: `Provider ${index}`,
        originalUrl: `${base.originalUrl}?provider=${index}`,
        accessLevel: retained ? "full_text" as const : "abstract" as const,
        content: retained
          ? "Full text makes this candidate the actual retained winner."
          : null,
        metadata: {
          discoveryFamily: "arxiv",
          discoveryLaneIds: retained ? laneIds.slice(0, 32) : laneIds,
        },
      } satisfies RawResearchCandidate;
    });
    const writes: DiscoveryDiagnosticsState[] = [];
    const context = createProductionPipelineContext({
      editionDate: "2033-01-20",
      runId: "run-large-merge-diagnostics",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => candidates,
      loadDiscoveryDiagnostics: () => laneIds.map((laneId, index) => ({
        laneId,
        sourceId: "arxiv",
        discoveryFamily: "arxiv" as const,
        discovered: index < 32 ? 20 : 19,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success" as const,
        rejectionCounts: {},
      })),
      researchRepository: {
        getDiscoveryObservations: async () => [],
        upsertDiscoveryObservations: async () => undefined,
        getCachedResearchAssessment: async () => null,
        putCachedResearchAssessment: async () => undefined,
        recordDiscoveryDiagnostics: async (
          _runId,
          diagnostics,
          rejectionCountsByStage,
        ) => {
          writes.push(structuredClone({
            diagnostics: [...diagnostics],
            rejectionCountsByStage: rejectionCountsByStage!,
          }));
        },
      },
    });

    const normalized = await context.normalize(await context.collect());

    expect(normalized).toHaveLength(1);
    expect(
      (normalized[0]?.metadata.discoveryLineage as unknown[]).length,
    ).toBe(1_024);
    expect(writes.at(-1)?.diagnostics).toHaveLength(64);
    expect(writes.at(-1)?.diagnostics.every((diagnostic) =>
      diagnostic.rejectionCounts.identity_merged === 19
    )).toBe(true);
    expect(writes.at(-1)?.rejectionCountsByStage.normalize).toHaveLength(64);
    expect(JSON.stringify(writes.at(-1))).not.toContain("provider=19");
  });

  it("attributes bounded discovery rejections without changing selected IDs", async () => {
    const laneId = "arxiv:bounded-diagnostics";
    const aliasLaneId = "arxiv:alias-diagnostics";
    const withLane = (
      candidate: RawResearchCandidate,
      discoveryFamily: "arxiv" | "bibliographic" = "arxiv",
      discoveryLaneId = laneId,
    ): RawResearchCandidate => ({
      ...candidate,
      metadata: {
        ...candidate.metadata,
        discoveryFamily,
        discoveryLaneIds: [discoveryLaneId],
      },
    });
    const aliasA = withLane(rawResearchCandidate(
      "2607.11111",
      "Alias study of mechanistic interpretability",
      20,
    ));
    const aliasB = withLane({
      ...rawResearchCandidate(
        "2607.11111",
        "Alias study of mechanistic interpretability",
        20,
      ),
      sourceId: "openalex",
      sourceName: "OpenAlex",
      originalUrl: "https://openalex.org/works/W11111",
    }, "bibliographic", aliasLaneId);
    const repeated = withLane({
      ...rawResearchCandidate(
        "2607.22222",
        "Repeated interpretability observation",
      ),
      publishedAt: "2026-07-26T09:00:00.000Z",
    });
    const belowFit = withLane(rawResearchCandidate(
      "2607.33333",
      "Irrelevant arrival below topical fit",
    ));
    const capacityA = withLane(rawResearchCandidate(
      "2607.44444",
      "Capacity candidate A for interpretability",
      2,
    ));
    const capacityB = withLane(rawResearchCandidate(
      "2607.55555",
      "Capacity candidate B for interpretability",
      1,
    ));
    const routedOut: RawPublicationCandidate = {
      ...rawOfficialPublicationCandidate(
        "technology",
        "route-excluded",
        now,
        "A routine community bulletin without a substantive result.",
      ),
      sourceId: "community-bulletin",
      sourceName: "Community Bulletin",
      sourceRole: "blog",
      title: "Routine community bulletin",
      originalUrl: "https://community.example/bulletins/routine",
      sectionEligibility: ["research", "research_radar"],
      discoveryFamily: "commentary",
      metadata: { discoveryLaneIds: [laneId] },
    };
    const candidates = [
      aliasA,
      aliasB,
      repeated,
      belowFit,
      capacityA,
      capacityB,
      routedOut,
    ];
    const previewRepository = {
      getDiscoveryObservations: async () => [],
      upsertDiscoveryObservations: async () => undefined,
      getCachedResearchAssessment: async () => null,
      putCachedResearchAssessment: async () => undefined,
    };
    const previewContext = createProductionPipelineContext({
      editionDate: "2033-01-21",
      runId: "run-discovery-preview",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [repeated],
      researchRepository: previewRepository,
    });
    const preview = await previewContext.normalize(
      await previewContext.collect(),
    );
    const repeatedItem = preview[0]!;
    const repeatedFingerprints = researchFingerprints(repeatedItem);
    const priorObservation: DiscoveryObservation = {
      runId: "run-discovery-prior",
      canonicalId: canonicalResearchIdentity(repeatedItem),
      sourceId: "arxiv",
      discoveryFamily: "arxiv",
      windowKind: "reconsideration",
      publishedAt: repeatedItem.publishedAt,
      retrievedAt: "2026-07-26T10:00:00.000Z",
      observedAt: "2026-07-26T10:00:00.000Z",
      ...repeatedFingerprints,
      joinedExternalIds: ["arXiv:2607.22222"],
      route: "research",
      expiresAt: "2026-08-02T10:00:00.000Z",
    };
    const assessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract" as const,
    };
    const preferences = fixturePreferences({
      sectionBudgets: {
        ...approvedBaselinePreferences().sectionBudgets,
        morning_brief: 1,
        research: 1,
        research_radar: 0,
      },
    });
    const diagnosticWrites: Array<readonly unknown[]> = [];
    const repository = {
      getDiscoveryObservations: async () => [priorObservation],
      upsertDiscoveryObservations: async () => undefined,
      getCachedResearchAssessment: async () => null,
      putCachedResearchAssessment: async () => undefined,
      recordDiscoveryDiagnostics: async (
        _runId: string,
        diagnostics: readonly unknown[],
      ) => {
        diagnosticWrites.push(structuredClone(diagnostics));
      },
    };
    const {
      recordDiscoveryDiagnostics: _recordDiscoveryDiagnostics,
      ...baselineRepository
    } = repository;
    const runStages = async (
      runId: string,
      withDiagnostics: boolean,
    ) => {
      const context = createProductionPipelineContext({
        editionDate: "2033-01-21",
        runId,
        store: new FixtureStore(),
        now: () => now,
        preferences,
        providers: {
          summary: new RelevanceFirstEmbeddingProvider(),
          assessment: new FakeModelProvider({
            generatedObjects: [assessment, assessment, assessment],
          }),
        },
        collectCandidates: async () => candidates,
        ...(withDiagnostics
          ? {
              loadDiscoveryDiagnostics: () => [{
                laneId,
                sourceId: "arxiv",
                discoveryFamily: "arxiv" as const,
                discovered: candidates.length - 1,
                deduplicated: 0,
                triaged: 0,
                assessed: 0,
                outcome: "success" as const,
                rejectionCounts: {},
              }, {
                laneId: aliasLaneId,
                sourceId: "openalex",
                discoveryFamily: "bibliographic" as const,
                discovered: 1,
                deduplicated: 0,
                triaged: 0,
                assessed: 0,
                outcome: "success" as const,
                rejectionCounts: {},
              }],
            }
          : {}),
        researchRepository: withDiagnostics
          ? repository
          : baselineRepository,
      });
      const collected = await context.collect();
      const normalized = await context.normalize(collected);
      const enriched = await context.enrich(normalized);
      const triaged = await context.prefilter(enriched);
      const assessed = await context.assess(triaged);
      const scored = await context.score(assessed);
      const clustered = await context.cluster(scored);
      const shortlisted = await context.shortlist(clustered);
      return {
        normalizedIds: normalized.map(({ id }) => id),
        triagedIds: triaged.map(({ id }) => id),
        assessedIds: assessed.map(({ id }) => id),
        selectedIds: shortlisted.map(({ id }) => id),
      };
    };

    const baseline = await runStages("run-discovery-baseline", false);
    const observed = await runStages("run-discovery-attribution", true);

    expect(observed).toEqual(baseline);
    expect(observed.normalizedIds).toHaveLength(4);
    expect(observed.triagedIds).toHaveLength(3);
    expect(observed.assessedIds).toHaveLength(3);
    expect(observed.selectedIds).toHaveLength(1);
    const finalDiagnostics = diagnosticWrites.at(-1) as Array<{
      laneId: string;
      discovered: number;
      deduplicated: number;
      triaged: number;
      assessed: number;
    }>;
    const finalDiagnostic = finalDiagnostics.find((value) =>
      value.laneId === laneId
    );
    expect(finalDiagnostic).toEqual({
      laneId,
      sourceId: "arxiv",
      discoveryFamily: "arxiv",
      discovered: 6,
      deduplicated: 4,
      triaged: 3,
      assessed: 3,
      outcome: "success",
      rejectionCounts: {
        route_excluded: 1,
        unchanged_observation: 1,
        topic_mismatch: 1,
        capacity_limited: 2,
      },
    });
    expect(finalDiagnostics.find((value) =>
      value.laneId === aliasLaneId
    )).toEqual({
      laneId: aliasLaneId,
      sourceId: "openalex",
      discoveryFamily: "bibliographic",
      discovered: 1,
      deduplicated: 1,
      triaged: 1,
      assessed: 1,
      outcome: "success",
      rejectionCounts: { identity_merged: 1 },
    });
    expect(finalDiagnostic).toMatchObject({
      discovered: expect.any(Number),
      deduplicated: expect.any(Number),
      triaged: expect.any(Number),
      assessed: expect.any(Number),
    });
    const funnel = finalDiagnostic!;
    expect(funnel.discovered).toBeGreaterThanOrEqual(funnel.deduplicated);
    expect(funnel.deduplicated).toBeGreaterThanOrEqual(funnel.triaged);
    expect(funnel.triaged).toBeGreaterThanOrEqual(funnel.assessed);
  });

  it("attributes invalid research, access overclaims, and uncached assessment caps", async () => {
    const laneId = "arxiv:quality-cap-diagnostics";
    const candidate = (
      arxivId: string,
      abstract?: string,
    ): RawResearchCandidate => {
      const value = rawResearchCandidate(
        arxivId,
        `Assessment candidate ${arxivId} for interpretability`,
      );
      return {
        ...value,
        ...(abstract === undefined ? {} : { abstract }),
        metadata: {
          discoveryFamily: "arxiv",
          discoveryLaneIds: [laneId],
        },
      };
    };
    const candidates = [
      candidate("2607.60000", "   "),
      candidate("2607.60001"),
      candidate("2607.60002"),
      candidate("2607.60003"),
      candidate("2607.60004"),
      candidate("2607.60005"),
    ];
    const writes: Array<readonly unknown[]> = [];
    const repository = {
      getDiscoveryObservations: async () => [],
      upsertDiscoveryObservations: async () => undefined,
      getCachedResearchAssessment: async () => null,
      putCachedResearchAssessment: async () => undefined,
      recordDiscoveryDiagnostics: async (
        _runId: string,
        diagnostics: readonly unknown[],
      ) => {
        writes.push(structuredClone(diagnostics));
      },
    };
    const validAssessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract" as const,
    };
    const context = createProductionPipelineContext({
      editionDate: "2033-01-22",
      runId: "run-quality-cap-attribution",
      store: new FixtureStore(),
      now: () => now,
      budgetPolicy: {
        state: "degraded",
        radarSummaryTokens: 120,
        featuredSummaryTokens: 900,
      },
      providers: {
        summary: new RelevanceFirstEmbeddingProvider(),
        assessment: new FakeModelProvider({
          generatedObjects: [{
            ...validAssessment,
            accessLevel: "full_text",
          }, validAssessment, validAssessment, validAssessment],
        }),
      },
      collectCandidates: async () => candidates,
      loadDiscoveryDiagnostics: () => [{
        laneId,
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        discovered: candidates.length,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success",
        rejectionCounts: {},
      }],
      researchRepository: repository,
    });

    const collected = await context.collect();
    const normalized = await context.normalize(collected);
    const enriched = await context.enrich(normalized);
    const triaged = await context.prefilter(enriched);
    const assessed = await context.assess(triaged);

    expect(normalized).toHaveLength(6);
    expect(triaged).toHaveLength(5);
    expect(assessed).toHaveLength(3);
    expect(writes.at(-1)?.[0]).toMatchObject({
      discovered: 6,
      deduplicated: 6,
      triaged: 5,
      assessed: 3,
      rejectionCounts: {
        quality_rejected: 2,
        capacity_limited: 1,
      },
    });
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
    const candidates = [
      rawResearchCandidate(
        "2607.50001",
        "Mechanistic interpretability for compact checkpoints",
      ),
      ...["source-a", "source-b"].map((id) => ({
        ...fixtureItem(id, "world"),
        metadata: {
          primarySection: "world",
          sectionEligibility: ["world"],
          namedEntities: ["Example Agency"],
        },
      })),
    ];
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
            embedding,
          ]],
        }),
        assessment: new FakeModelProvider({
          generatedObjects: [{
            technicalQuality: 0.9,
            novelty: 0.8,
            strengths: ["The abstract describes a concrete method."],
            limitations: ["Only abstract evidence was supplied."],
            rationale: "The available abstract supports a strong assessment.",
            accessLevel: "abstract",
          }],
        }),
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

    const enriched = store.artifacts.get(`${context.runId}:enrich`) as
      | CheckpointArtifact<readonly Item[]>
      | undefined;
    const scored = store.artifacts.get(`${context.runId}:score`) as
      | CheckpointArtifact<readonly Item[]>
      | undefined;
    const clustered = store.artifacts.get(`${context.runId}:cluster`) as
      | CheckpointArtifact<readonly Item[]>
      | undefined;
    const shortlisted = store.artifacts.get(`${context.runId}:shortlist`) as
      | CheckpointArtifact<readonly Item[]>
      | undefined;

    expect(enriched).toBeDefined();
    expect(JSON.stringify(enriched).length).toBeLessThan(1_000_000);
    const enrichedResearch = enriched!.output.filter((item) =>
      item.kind === "paper" || item.kind === "blog"
    );
    const enrichedNews = enriched!.output.filter((item) =>
      item.kind !== "paper" && item.kind !== "blog"
    );
    expect(enrichedResearch).toHaveLength(1);
    expect(enrichedResearch.every((item) =>
      !("embedding" in (item.metadata.workflow as Record<string, unknown>))
    )).toBe(true);
    expect(enrichedResearch.every((item) =>
      typeof (item.metadata.workflow as { topicalFit?: unknown }).topicalFit ===
        "number"
    )).toBe(true);
    expect(enrichedNews.every((item) =>
      "embedding" in (item.metadata.workflow as Record<string, unknown>)
    )).toBe(true);
    expect(JSON.stringify(scored)).toContain('"embedding"');
    expect(clustered).toBeDefined();
    expect(shortlisted).toBeDefined();
    const clusteredResearch = clustered!.output.filter((item) =>
      item.kind === "paper" || item.kind === "blog"
    );
    const clusteredNews = clustered!.output.filter((item) =>
      item.kind !== "paper" && item.kind !== "blog"
    );
    expect(clusteredResearch).toHaveLength(1);
    expect(clusteredNews).toHaveLength(1);
    expect(shortlisted!.output.some((item) => item.kind === "paper")).toBe(true);
    expect(
      (clusteredNews[0]!.metadata.workflow as {
        development?: { itemIds?: readonly string[] };
      }).development?.itemIds,
    ).toEqual(["source-a", "source-b"]);
    expect(JSON.stringify(clustered)).not.toContain('"embedding"');
    expect(JSON.stringify(shortlisted)).not.toContain('"embedding"');
  });

  it.each(["cluster", "shortlist"] as const)(
    "rebuilds a stale legacy %s development through exactly one text boundary",
    async (checkpointStep) => {
      const sharedDocument =
        "https://example.com/documents/legacy-development-shared";
      const encodedTitle =
        "World agency reviews &amp;amp;#115;oftware safeguards";
      const encodedEvidence =
        "Evidence &amp;amp;#69; remains bounded after the review.";
      const encodedSourceName = "Source &amp;amp;#83;yndicate";
      const freshNewsItem = (
        id: string,
        sourceRole: RawNewsCandidate["sourceRole"],
      ): Item => normalizeCandidate({
        ...rawNewsCandidate(id, "world"),
        sourceRole,
        sourceName: encodedSourceName,
        title: encodedTitle,
        abstract: encodedEvidence,
        namedEntities: [],
        eventFamilies: [],
        materialFacts: [],
        primaryDocumentUrl: sharedDocument,
        primaryDocumentUrls: [sharedDocument],
        sectionEligibility: ["world", "technology"],
        metadata: {
          primarySection: "world",
          representativeStructuralSentinel: {
            owner: id,
            sourceDocument: sharedDocument,
          },
        },
      });
      const legacyNewsItem = (
        id: string,
        sourceRole: RawNewsCandidate["sourceRole"],
      ): Item => {
        const fresh = freshNewsItem(id, sourceRole);
        return ItemSchema.parse({
          ...fresh,
          title: encodedTitle,
          sourceRefs: fresh.sourceRefs.map((source) => ({
            ...source,
            name: encodedSourceName,
          })),
          normalizedText: encodedEvidence,
          metadata: {
            ...fresh.metadata,
            normalizedTitle: "stale-encoded-title",
            editorialSignals: (
              fresh.metadata.editorialSignals as readonly Record<
                string,
                unknown
              >[]
            ).map((signal) => ({
              ...signal,
              sourceName: encodedSourceName,
            })),
            provenance: (
              fresh.metadata.provenance as readonly Record<string, unknown>[]
            ).map((entry) => ({
              ...entry,
              sourceName: encodedSourceName,
            })),
          },
        });
      };
      const freshSurvivorA = freshNewsItem(
        "legacy-development-a",
        "reporting",
      );
      const freshSurvivorB = freshNewsItem(
        "legacy-development-b",
        "reporting",
      );
      const survivorA = legacyNewsItem(
        "legacy-development-a",
        "reporting",
      );
      const survivorB = legacyNewsItem(
        "legacy-development-b",
        "reporting",
      );
      const invalidRepresentative = ItemSchema.parse({
        ...freshNewsItem("legacy-development-invalid", "primary"),
        sourceRefs: freshNewsItem(
          "legacy-development-invalid",
          "primary",
        ).sourceRefs.map((source) => ({
          ...source,
          name: "&#65308;br&#65310;",
        })),
        tags: ["stale&#45;section"],
      });
      const invalidTitleItem = ItemSchema.parse({
        ...freshNewsItem("legacy-development-empty-title", "reporting"),
        title: "&#65308;br&#65310;",
        tags: ["stale&#45;section"],
      });
      const freshDevelopment = clusterNews(
        [freshSurvivorA, freshSurvivorB],
        {},
      )[0]!;
      const legacyDevelopment = clusterNews(
        [
          invalidRepresentative,
          invalidTitleItem,
          survivorA,
          survivorB,
        ],
        {},
      )[0]!;
      const scoreInputs = {
        publicImportance: 0.8,
        personalRelevance: 0.8,
        sourceQuality: 0.8,
        recency: 0.8,
        geography: 0.2,
        novelty: 0.7,
      };
      expect(legacyDevelopment.representativeItem.id).toBe(
        invalidRepresentative.id,
      );
      const staleDevelopment = {
        ...legacyDevelopment,
        title: "Stale &#68;evelopment title",
        namedEntities: ["Stale &#69;ntity"],
        eventFamilies: ["stale&#45;event-family"],
        materialFacts: [{
          kind: "status" as const,
          key: "stale&#45;status",
          value: "stale&#45;value",
        }],
        primarySection: "technology" as const,
        eventInstance: {
          subject: "Stale &#83;ubject",
          domain: "governance-event" as const,
          object: "Stale &#79;bject",
        },
        developmentKey: "development-stale&#45;key",
        repeatable: true,
        materialFactsFingerprint: "facts-stale&#45;fingerprint",
        editorialSignals: legacyDevelopment.editorialSignals.map((signal) => ({
          ...signal,
          namedEntities: ["Stale &#69;ntity"],
          eventFamilies: ["stale&#45;event-family"],
        })),
      };
      const legacyAggregate = ItemSchema.parse({
        ...invalidRepresentative,
        id: legacyDevelopment.id,
        title: legacyDevelopment.title,
        sourceRefs: legacyDevelopment.sourceRefs,
        normalizedText: legacyDevelopment.items
          .map((item) => item.normalizedText)
          .join(" "),
        primaryTopic: "technology",
        tags: ["technology", "stale&#45;section"],
        metadata: {
          ...invalidRepresentative.metadata,
          primarySection: "technology",
          sectionEligibility: ["technology"],
          section: "technology",
          tags: ["stale&#45;aggregate-tag"],
          contentFingerprint: "content:stale-aggregate-only",
          evidenceFingerprint: "evidence:stale-aggregate-only",
          attachedCommentary: [{
            sourceId: "stale-commentary",
            sourceName: "Stale &amp;amp;#83;ource",
            displaySourceName: "Stale &amp;amp;#68;isplay",
            url: "https://example.com/stale-commentary",
            title: "Stale &amp;amp;#84;itle",
            excerpt: "Stale &amp;amp;#69;vidence",
            retrievedAt: now,
          }],
          aggregateOnlyDisplaySentinel:
            "Stale &amp;amp;#68;isplay metadata",
          aggregateOnlyStructuralSentinel: {
            legacyRootId: legacyDevelopment.id,
          },
          workflow: {
            version: 1,
            embedding: [0.25],
            personalRelevance: 0.8,
            development: staleDevelopment,
            developmentScore: scoreNewsDevelopment(
              legacyDevelopment,
              scoreInputs,
            ),
            ...(checkpointStep === "shortlist"
              ? {
                  section: "world" as const,
                  selectionReasons: ["Fixture selection."],
                }
              : {}),
          },
        },
      });
      const store = new FixtureStore();
      const context = createProductionPipelineContext({
        editionDate:
          checkpointStep === "cluster" ? "2034-04-01" : "2034-04-02",
        runId: `run-legacy-${checkpointStep}-development-refresh`,
        store,
        now: () => now,
        providers: {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
        collectCandidates: async () => {
          throw new Error("completed collect must not run");
        },
      });
      const restored: Item[][] = [];
      context.shortlist = async (items) => {
        restored.push([...items]);
        throw new Error("STOP_AFTER_LEGACY_CLUSTER_RESTORE");
      };
      context.synthesize = async (items) => {
        restored.push([...items]);
        throw new Error("STOP_AFTER_LEGACY_SHORTLIST_RESTORE");
      };
      await store.createRun({
        id: context.runId,
        editionDate: context.editionDate,
        status: "running",
        currentStep: checkpointStep,
        retryable: false,
        attemptCount: 1,
        estimatedCostUsd: 0,
        createdAt: now,
        updatedAt: now,
      });
      const targetIndex = PIPELINE_STEPS.indexOf(checkpointStep);
      for (const step of PIPELINE_STEPS.slice(0, targetIndex + 1)) {
        await store.saveCheckpoint(context.runId, step, {
          output: step === checkpointStep ? [legacyAggregate] : [],
          attempts: 1,
          durationMs: 0,
          itemCount: step === checkpointStep ? 1 : 0,
          estimatedCostUsd: 0,
        });
      }

      await expect(runEditorialPipeline(context)).rejects.toThrow(
        checkpointStep === "cluster"
          ? "STOP_AFTER_LEGACY_CLUSTER_RESTORE"
          : "STOP_AFTER_LEGACY_SHORTLIST_RESTORE",
      );

      expect(restored).toHaveLength(1);
      const refreshedAggregate = restored[0]?.[0];
      expect(refreshedAggregate).toBeDefined();
      const refreshedWorkflow = refreshedAggregate!.metadata.workflow as {
        development: typeof freshDevelopment;
        developmentScore: ReturnType<typeof scoreNewsDevelopment>;
        embedding?: readonly number[];
        personalRelevance?: number;
        section?: string;
        selectionReasons?: readonly string[];
      };
      const refreshedDevelopment = refreshedWorkflow.development;
      expect(refreshedDevelopment).toEqual(freshDevelopment);
      expect(refreshedWorkflow.developmentScore).toEqual(
        scoreNewsDevelopment(freshDevelopment, scoreInputs),
      );
      expect(refreshedAggregate).toMatchObject({
        id: freshDevelopment.id,
        title: "World agency reviews &#115;oftware safeguards",
        primaryTopic: freshDevelopment.primarySection,
        tags: freshDevelopment.representativeItem.tags,
      });
      expect(refreshedAggregate!.title).toBe(refreshedDevelopment.title);
      expect(refreshedAggregate!.title).toBe(
        refreshedDevelopment.representativeItem.title,
      );
      expect(refreshedAggregate!.normalizedText).toBe(
        refreshedDevelopment.items
          .map((nestedItem) => nestedItem.normalizedText)
          .join(" "),
      );
      expect(refreshedAggregate!.normalizedText).toContain(
        "Evidence &#69; remains bounded",
      );
      expect(refreshedAggregate!.sourceRefs).toEqual(
        refreshedDevelopment.sourceRefs,
      );
      expect(refreshedAggregate!.sourceRefs[0]!.name).toBe(
        "Source &#83;yndicate",
      );
      expect(refreshedAggregate!.metadata).toMatchObject({
        primarySection: "world",
        sectionEligibility: ["technology", "world"],
        representativeStructuralSentinel:
          freshDevelopment.representativeItem.metadata
            .representativeStructuralSentinel,
      });
      expect(refreshedAggregate!.metadata.tags).toBeUndefined();
      expect(
        refreshedAggregate!.metadata.contentFingerprint,
      ).toBeUndefined();
      expect(
        refreshedAggregate!.metadata.evidenceFingerprint,
      ).toBeUndefined();
      expect(
        refreshedAggregate!.metadata.attachedCommentary,
      ).toBeUndefined();
      expect(
        refreshedAggregate!.metadata.aggregateOnlyDisplaySentinel,
      ).toBeUndefined();
      expect(
        refreshedAggregate!.metadata.aggregateOnlyStructuralSentinel,
      ).toBeUndefined();
      expect(refreshedWorkflow.section).toBe(
        checkpointStep === "shortlist" ? "world" : undefined,
      );
      expect(refreshedAggregate!.metadata.section).toBe(
        checkpointStep === "shortlist" ? "world" : undefined,
      );
      expect(refreshedWorkflow.embedding).toBeUndefined();
      expect(refreshedWorkflow.personalRelevance).toBe(0.8);
      expect(refreshedWorkflow.selectionReasons).toEqual(
        checkpointStep === "shortlist"
          ? ["Fixture selection."]
          : undefined,
      );
      expect(JSON.stringify(refreshedAggregate)).toContain("&#");
      expect(JSON.stringify(refreshedAggregate)).not.toContain("software");
      expect(JSON.stringify(refreshedAggregate)).not.toContain(
        "stale-aggregate-only",
      );

      const onceRestored = structuredClone(refreshedAggregate!);
      await store.saveCheckpoint(context.runId, checkpointStep, {
        output: [onceRestored],
        attempts: 1,
        durationMs: 0,
        itemCount: 1,
        estimatedCostUsd: 0,
        providerTextNormalizationVersion:
          PROVIDER_TEXT_NORMALIZATION_VERSION,
      });
      await expect(runEditorialPipeline(context)).rejects.toThrow(
        checkpointStep === "cluster"
          ? "STOP_AFTER_LEGACY_CLUSTER_RESTORE"
          : "STOP_AFTER_LEGACY_SHORTLIST_RESTORE",
      );
      expect(restored).toHaveLength(2);
      expect(restored[1]![0]).toEqual(onceRestored);
    },
  );

  it("rejects a normalized envelope on a D1 collect checkpoint", async () => {
    const runId = "run-d1-reject-normalized-collect";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2034-03-01",
      status: "running",
      currentStep: "collect",
      retryable: false,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });

    await expect(store.saveCheckpoint(runId, "collect", {
      output: [rawResearchCandidate(
        "2608.invalid-collect-envelope",
        "Raw collect checkpoint",
      )],
      attempts: 1,
      durationMs: 0,
      itemCount: 1,
      estimatedCostUsd: 0,
      providerTextNormalizationVersion:
        PROVIDER_TEXT_NORMALIZATION_VERSION,
    })).rejects.toThrow(
      "Collect checkpoint artifacts cannot be marked provider-text normalized.",
    );
    expect(await store.readArtifact(runId, "collect")).toBeNull();
  });

  it("rejects D1 checkpoint chunks with inconsistent normalization envelopes", async () => {
    const runId = "run-d1-mixed-normalization-chunks";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2034-03-02",
      status: "running",
      currentStep: "normalize",
      retryable: false,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const checkpointId = "mixed-normalization-envelope";
    const items = [
      fixtureItem("mixed-envelope-a", "world"),
      fixtureItem("mixed-envelope-b", "technology"),
    ];
    const events = items.map((item, chunkIndex) => JSON.stringify({
      step: "normalize",
      checkpointId,
      chunkIndex,
      chunkCount: 2,
      artifact: {
        output: [item],
        attempts: 1,
        durationMs: 0,
        itemCount: 2,
        estimatedCostUsd: 0,
        ...(chunkIndex === 0
          ? {}
          : {
              providerTextNormalizationVersion:
                PROVIDER_TEXT_NORMALIZATION_VERSION,
            }),
      },
    }));
    await env.DB.batch(events.map((eventJson, chunkIndex) =>
      env.DB.prepare(
        `INSERT INTO audit_events (
          id, run_id, event_type, event_json, created_at
        ) VALUES (?, ?, 'workflow_checkpoint', ?, ?)`,
      ).bind(
        `${checkpointId}:${chunkIndex}`,
        runId,
        eventJson,
        now,
      )
    ));

    await expect(store.readArtifact(runId, "normalize")).rejects.toThrow(
      "INVALID_CHECKPOINT_CHUNKS:normalize",
    );
  });

  it("round trips a current normalization envelope through D1 checkpoint chunks", async () => {
    const runId = "run-d1-current-normalization-chunks";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2034-03-03",
      status: "running",
      currentStep: "normalize",
      retryable: false,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const items = Array.from({ length: 500 }, (_, index) => ({
      ...fixtureItem(`current-envelope-chunk-${index}`, "world"),
      normalizedText:
        `CURRENT_ENVELOPE_${String(index).padStart(3, "0")} ` +
        "é".repeat(3_000),
    }));
    const artifact: CheckpointArtifact<readonly Item[]> = {
      output: items,
      attempts: 1,
      durationMs: 25,
      itemCount: items.length,
      estimatedCostUsd: 0.25,
      providerTextNormalizationVersion:
        PROVIDER_TEXT_NORMALIZATION_VERSION,
    };

    await store.saveCheckpoint(runId, "normalize", artifact);

    const rows = await env.DB.prepare(
      `SELECT event_json
       FROM audit_events
       WHERE run_id = ? AND event_type = 'workflow_checkpoint'`,
    ).bind(runId).all<{ event_json: string }>();
    expect(rows.results.length).toBeGreaterThan(1);
    expect(rows.results.every(({ event_json: eventJson }) =>
      (JSON.parse(eventJson) as {
        artifact?: { providerTextNormalizationVersion?: unknown };
      }).artifact?.providerTextNormalizationVersion === 1
    )).toBe(true);
    await expect(store.readArtifact(runId, "normalize")).resolves.toEqual(
      artifact,
    );
  }, 30_000);

  it("keeps every 500-item worst-case D1 checkpoint below the encoded row limit", async () => {
    const families = [
      "arxiv",
      "bibliographic",
      "official-publication",
      "commentary",
    ] as const;
    const candidates = Array.from({ length: 500 }, (_, index) => {
      const identifier = `2608.${String(index).padStart(5, "0")}`;
      const evidenceMarker = `SELECTED_EVIDENCE_${String(index).padStart(3, "0")}`;
      return {
        ...rawResearchCandidate(
          identifier,
          `Mechanistic interpretability candidate ${index}`,
        ),
        sourceId: `research-source-${index}`,
        sourceName: `Research Source ${index}`,
        originalUrl: `https://publisher-${index}.example/papers/${identifier}`,
        abstract: `${evidenceMarker} ${"é".repeat(3_000)}`,
        metadata: {
          discoveryFamily: families[index % families.length],
          discoveryLaneIds: [`lane-${index}`],
        },
      };
    });
    const assessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The supplied evidence describes a concrete method."],
      limitations: ["Only the supplied evidence was assessed."],
      rationale: "The bounded evidence supports the assessment.",
      accessLevel: "abstract" as const,
    };
    const summaryProvider: ModelProvider = {
      embed: async (texts) => texts.map(() => [1, 0]),
      generateObject: async (input) => {
        throw new Error(`Unexpected summary generation: ${input.schemaName}`);
      },
    };
    const assessmentProvider: ModelProvider = {
      embed: async () => {
        throw new Error("Unexpected assessment embedding.");
      },
      generateObject: async (input) => {
        expect(input.schemaName).toBe("research_assessment");
        expect(input.sourcePacket).toContain("SELECTED_EVIDENCE_");
        return assessment;
      },
    };
    const store = createD1PipelineStore(env.DB);
    const context = createProductionPipelineContext({
      editionDate: "2033-02-05",
      runId: "run-worst-case-checkpoint-bytes",
      store,
      now: () => now,
      providers: {
        summary: summaryProvider,
        assessment: assessmentProvider,
      },
      collectCandidates: async () => candidates,
    });
    context.synthesize = async () => [];
    context.validate = async () => [];

    await expect(runEditorialPipeline(context)).resolves.toMatchObject({
      status: "failed",
    });

    const rows = await env.DB.prepare(
      `SELECT event_json
       FROM audit_events
       WHERE run_id = ? AND event_type = 'workflow_checkpoint'`,
    ).bind(context.runId).all<{ event_json: string }>();
    const encodedLimit = 2 * 1_024 * 1_024;
    const checkpointSteps = new Set<string>();
    let postChunkMaximumBytes = 0;
    for (const { event_json: eventJson } of rows.results) {
      const parsed = JSON.parse(eventJson) as { step?: string };
      if (parsed.step !== undefined) checkpointSteps.add(parsed.step);
      const rowBytes = new TextEncoder().encode(eventJson).byteLength;
      postChunkMaximumBytes = Math.max(postChunkMaximumBytes, rowBytes);
      expect(rowBytes).toBeLessThan(
        encodedLimit,
      );
    }
    expect(checkpointSteps).toEqual(new Set(PIPELINE_STEPS));

    let preChunkMaximumBytes = 0;
    for (const step of PIPELINE_STEPS) {
      const artifact = await store.readArtifact(context.runId, step);
      preChunkMaximumBytes = Math.max(
        preChunkMaximumBytes,
        new TextEncoder().encode(JSON.stringify({ step, artifact })).byteLength,
      );
    }
    expect(preChunkMaximumBytes).toBeGreaterThan(encodedLimit);
    expect(postChunkMaximumBytes).toBeLessThanOrEqual(
      MAX_D1_CHECKPOINT_EVENT_BYTES,
    );

    const collected = await store.readArtifact(context.runId, "collect");
    const prefilted = await store.readArtifact(context.runId, "prefilter");
    expect(collected?.output).toHaveLength(500);
    expect(prefilted?.output).toHaveLength(24);
    expect((prefilted?.output as Item[]).every((item) =>
      item.normalizedText.includes("SELECTED_EVIDENCE_")
    )).toBe(true);
    expect((prefilted?.output as Item[]).every((item) => {
      const rawResearch = (item.metadata.workflow as {
        rawResearch?: { abstract?: unknown; content?: unknown };
      }).rawResearch;
      return rawResearch?.abstract === null && rawResearch.content === null;
    })).toBe(true);
    for (const step of [
      "enrich",
      "prefilter",
      "assess",
      "score",
      "cluster",
      "shortlist",
    ] as const) {
      const artifact = await store.readArtifact(context.runId, step);
      const research = (artifact?.output as Item[]).filter((item) =>
        item.kind === "paper" || item.kind === "blog"
      );
      expect(JSON.stringify(research)).not.toContain('"embedding"');
    }
  }, 30_000);

  it("rejects a persisted research embedding in the enrich checkpoint", async () => {
    const context = createProductionPipelineContext({
      editionDate: "2033-02-10",
      runId: "run-research-embedding-checkpoint",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider({
          embeddingBatches: [[
            [1, 0],
            [1, 0],
            [1, 0],
            [1, 0],
          ]],
        }),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [rawResearchCandidate(
        "2607.50003",
        "Mechanistic interpretability without durable vectors",
      )],
    });
    const enrich = context.enrich;
    context.enrich = async (items) => (await enrich(items)).map((item) =>
      ItemSchema.parse({
        ...item,
        metadata: {
          ...item.metadata,
          workflow: {
            ...(item.metadata.workflow as Record<string, unknown>),
            embedding: [1, 0],
          },
        },
      })
    );

    await expect(runEditorialPipeline(context)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: "Production enrich artifacts forbid research embedding.",
        }),
      ]),
    });
  });

  it("rejects compact cluster checkpoints that omit relevance", async () => {
    const embedding = [1, ...Array<number>(1_535).fill(0)];
    const context = createProductionPipelineContext({
      editionDate: "2033-02-09",
      runId: "run-compact-cluster-missing-relevance",
      store: new FixtureStore(),
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
        assessment: new FakeModelProvider({
          generatedObjects: [{
            technicalQuality: 0.9,
            novelty: 0.8,
            strengths: ["The abstract describes a concrete method."],
            limitations: ["Only abstract evidence was supplied."],
            rationale: "The available abstract supports a strong assessment.",
            accessLevel: "abstract",
          }],
        }),
      },
      collectCandidates: async () => [
        rawResearchCandidate(
          "2607.50002",
          "Mechanistic interpretability with required relevance",
        ),
        fixtureItem("relevance-news", "world"),
      ],
    });
    const cluster = context.cluster;
    context.cluster = async (items) => (await cluster(items)).map((item) => {
      const workflow = {
        ...(item.metadata.workflow as Record<string, unknown>),
      };
      if (item.kind === "paper" || item.kind === "blog") {
        delete workflow.topicalFit;
      } else {
        delete workflow.personalRelevance;
      }
      return ItemSchema.parse({
        ...item,
        metadata: { ...item.metadata, workflow },
      });
    });
    context.synthesize = async (items) => items.map((item) => ({
      item,
      summary: fixtureSummary(item),
    }));
    context.validate = async (entries) => entries.map((entry) => ({
      ...entry,
      valid: true,
    }));

    await expect(runEditorialPipeline(context)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: "Production cluster artifacts require topicalFit.",
        }),
        expect.objectContaining({
          message: "Production cluster artifacts require personalRelevance.",
        }),
      ]),
    });
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
    class AvailableDiagnosticStore extends FixtureStore {
      async recordSummaryRejection(): Promise<void> {}
    }
    const context = createProductionPipelineContext({
      editionDate: "2033-01-03",
      runId: "run-wrong-source-grounding",
      store: new AvailableDiagnosticStore(),
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

  it("records bounded synthesis rejections", async () => {
    // This fails if a rejected summary is discarded rather than audited.
    const runId = "run-record-synthesis-rejection";
    const privateItemId =
      "https://identity.example/items/42?access_token=SECRET_ITEM_ID_CREDENTIAL";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2033-01-04",
      status: "running",
      currentStep: "synthesize",
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const rejectedItem = ItemSchema.parse({
      ...fixtureItem(privateItemId, "world"),
      title: "Rejected private item title",
      canonicalUrl: "https://private.example/SECRET_URL_MARKER",
      normalizedText: "Private source text SECRET_REJECTION_MARKER",
      sourceRefs: [{
        id: "private-source",
        name: "Private Source",
        url: "https://private.example/SECRET_URL_MARKER",
        role: "reporting",
        retrievedAt: now,
      }],
      metadata: { workflow: { version: 1, section: "world" } },
    });
    const acceptedItem = ItemSchema.parse({
      ...fixtureItem("accepted-item", "technology"),
      metadata: { workflow: { version: 1, section: "technology" } },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-04",
      runId,
      store,
      now: () => now,
      providers: {
        summary: new RejectionThenAcceptanceProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    const summaries = await context.synthesize([rejectedItem, acceptedItem]);
    const events = await env.DB.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = 'summary_rejected'`,
    ).bind(runId).all<{ event_json: string }>();

    expect(summaries.map(({ item }) => item.id)).toEqual([acceptedItem.id]);
    expect(events.results).toHaveLength(1);
    expect(JSON.parse(events.results[0]!.event_json)).toEqual({
      section: "world",
      errors: expect.arrayContaining(["CLAIM_EVIDENCE_NOT_EXACT"]),
      createdAt: now,
    });
    const serialized = events.results[0]!.event_json;
    expect(serialized).not.toContain(privateItemId);
    expect(serialized).not.toContain("SECRET_ITEM_ID_CREDENTIAL");
    expect(serialized).not.toContain(rejectedItem.title);
    expect(serialized).not.toContain(rejectedItem.normalizedText);
    expect(serialized).not.toContain(rejectedItem.sourceRefs[0]!.url);
    expect(serialized).not.toContain("Unsupported raw provider claim");
    expect(serialized).not.toContain("SECRET_REJECTION_MARKER");
  });

  it("keeps synthesis rejection events idempotent", async () => {
    // This fails if retries create more than one rejection event for an item.
    const runId = "run-idempotent-synthesis-rejection";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2033-01-05",
      status: "running",
      currentStep: "synthesize",
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const item = ItemSchema.parse({
      ...fixtureItem("idempotent-rejected-item", "world"),
      title: "Rejected private item title",
      metadata: { workflow: { version: 1, section: "world" } },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-05",
      runId,
      store,
      now: () => now,
      providers: {
        summary: new RejectionThenAcceptanceProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    await expect(context.synthesize([item])).resolves.toEqual([]);
    await expect(context.synthesize([item])).resolves.toEqual([]);
    const events = await env.DB.prepare(
      `SELECT id FROM audit_events
       WHERE run_id = ? AND event_type = 'summary_rejected'`,
    ).bind(runId).all<{ id: string }>();

    expect(events.results).toHaveLength(1);
    expect(events.results[0]!.id).toMatch(/^summary_rejected:[a-f0-9]{64}$/);
  });

  it("redacts model-supplied unknown source IDs from synthesis rejections", async () => {
    // This fails if provider-controlled source IDs reach a persisted diagnostic.
    const runId = "run-redacted-unknown-source";
    const maliciousSourceId = [
      "https://attacker.example/private?token=SECRET_CREDENTIAL_MARKER",
      "x".repeat(115),
    ].join("&payload=");
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2033-01-08",
      status: "running",
      currentStep: "synthesize",
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const rejectedItem = ItemSchema.parse({
      ...fixtureItem("redacted-unknown-source", "world"),
      title: "Unknown-source private item",
      metadata: { section: "world", workflow: { version: 1 } },
    });
    const acceptedItem = ItemSchema.parse({
      ...fixtureItem("accepted-after-unknown-source", "technology"),
      metadata: { section: "technology", workflow: { version: 1 } },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-08",
      runId,
      store,
      now: () => now,
      providers: {
        summary: new UnknownSourceThenAcceptanceProvider(maliciousSourceId),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    await expect(
      context.synthesize([rejectedItem, acceptedItem]),
    ).resolves.toMatchObject([{ item: { id: acceptedItem.id } }]);
    const event = await env.DB.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = 'summary_rejected'`,
    ).bind(runId).first<{ event_json: string }>();

    expect(event).not.toBeNull();
    expect(JSON.parse(event!.event_json).errors).toEqual([
      "CLAIM_EVIDENCE_NOT_EXACT",
      "EVIDENCE_NOT_FOUND:0",
      "UNGROUNDED_CLAIM:0",
      "UNKNOWN_SOURCE",
    ]);
    expect(event!.event_json).not.toContain(maliciousSourceId);
    expect(event!.event_json).not.toContain(
      encodeURIComponent(maliciousSourceId),
    );
    expect(event!.event_json).not.toContain("SECRET_CREDENTIAL_MARKER");
  });

  it("uses collision-safe IDs for ambiguous summary rejection run and item pairs", async () => {
    // This fails if delimiter-containing run/item pairs share one audit row.
    const store = createD1PipelineStore(env.DB);
    const pairs = [
      { runId: "run", itemId: "item:other", editionDate: "2033-01-09" },
      { runId: "run:item", itemId: "other", editionDate: "2033-01-10" },
    ];
    for (const pair of pairs) {
      await store.createRun({
        id: pair.runId,
        editionDate: pair.editionDate,
        status: "running",
        currentStep: "synthesize",
        retryable: false,
        attemptCount: 0,
        estimatedCostUsd: 0,
        createdAt: now,
        updatedAt: now,
        failureCode: null,
      });
      await store.recordSummaryRejection(pair.runId, pair.itemId, {
        section: "world",
        errors: ["CLAIM_EVIDENCE_NOT_EXACT"],
        createdAt: now,
      });
    }
    const events = await env.DB.prepare(
      `SELECT id FROM audit_events WHERE event_type = 'summary_rejected'
       ORDER BY id`,
    ).all<{ id: string }>();

    expect(events.results).toHaveLength(2);
    expect(new Set(events.results.map(({ id }) => id)).size).toBe(2);
    expect(events.results.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^summary_rejected:[a-f0-9]{64}$/),
      ]),
    );
  });

  it("rejects invalid event envelopes and fail-closes malformed rejection codes", async () => {
    // This fails if invalid envelopes are stored or malformed codes are not
    // replaced by the shared deterministic fallback.
    const runId = "run-bounded-synthesis-rejection";
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate: "2033-01-07",
      status: "running",
      currentStep: "synthesize",
      retryable: false,
      attemptCount: 0,
      estimatedCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    });
    const recorder = store as unknown as {
      recordSummaryRejection: (
        id: string,
        itemId: string,
        event: unknown,
      ) => Promise<void>;
    };
    await expect(
      recorder.recordSummaryRejection(runId, "invalid-envelope", {
        section: "not-a-section",
        errors: ["CLAIM_EVIDENCE_NOT_EXACT"],
        createdAt: now,
      }),
    ).rejects.toBeDefined();

    const malformedEvents = [
      {
        section: "world",
        errors: Array.from(
          { length: 65 },
          (_, index) => `UNGROUNDED_CLAIM:${index}`,
        ),
        createdAt: now,
      },
      {
        section: "world",
        errors: [`SCHEMA_INVALID:${"a".repeat(186)}`],
        createdAt: now,
      },
    ];

    for (const [index, event] of malformedEvents.entries()) {
      await expect(
        recorder.recordSummaryRejection(runId, `malformed-${index}`, event),
      ).resolves.toBeUndefined();
    }
    const events = await env.DB.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = 'summary_rejected'`,
    ).bind(runId).all<{ event_json: string }>();
    expect(events.results.map(({ event_json }) =>
      JSON.parse(event_json).errors
    )).toEqual([
      ["SCHEMA_INVALID:root"],
      ["SCHEMA_INVALID:root"],
    ]);
  });

  it("fails closed when recording a synthesis rejection fails", async () => {
    // This fails if the synthesis catch block swallows diagnostic storage errors.
    class DiagnosticFailureStore extends FixtureStore {
      async recordSummaryRejection(): Promise<void> {
        throw new Error("DIAGNOSTIC_WRITE_FAILED");
      }
    }
    const item = ItemSchema.parse({
      ...fixtureItem("diagnostic-failure-item", "world"),
      title: "Rejected private item title",
      metadata: { workflow: { version: 1, section: "world" } },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-06",
      runId: "run-diagnostic-write-failure",
      store: new DiagnosticFailureStore(),
      now: () => now,
      providers: {
        summary: new RejectionThenAcceptanceProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    await expect(context.synthesize([item])).rejects.toThrow(
      "DIAGNOSTIC_WRITE_FAILED",
    );
  });

  it("fails closed when a synthesis rejection recorder is unavailable", async () => {
    // This fails if optional chaining silently drops a required diagnostic.
    const item = ItemSchema.parse({
      ...fixtureItem("missing-diagnostic-recorder", "world"),
      title: "Rejected private item title",
      metadata: { workflow: { version: 1, section: "world" } },
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-01-11",
      runId: "run-missing-diagnostic-recorder",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new RejectionThenAcceptanceProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [],
    });

    await expect(context.synthesize([item])).rejects.toThrow(
      "DIAGNOSTIC_STORE_UNAVAILABLE",
    );
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

  it("sends the runtime OpenAlex key without persisting it in discovery diagnostics", async () => {
    await env.DB.prepare(
      "UPDATE sources SET enabled = CASE WHEN id = 'openalex' THEN 1 ELSE 0 END",
    ).run();
    const sourceFetch = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ results: [] })
    );
    vi.stubGlobal("fetch", sourceFetch);
    try {
      const launcher = createD1WorkflowLauncher(
        env.DB,
        (async () => ({
          providers: {
            summary: new FakeModelProvider(),
            assessment: new FakeModelProvider(),
          },
          openAlexApiKey: "fixture-openalex-key",
        })) as Parameters<typeof createD1WorkflowLauncher>[1],
      );

      const { runId } = await launcher.start({ editionDate: "2033-03-02" });
      const urls = sourceFetch.mock.calls.map(([input]) => new URL(String(input)));

      expect(urls).not.toHaveLength(0);
      expect(urls.every((url) =>
        url.searchParams.get("api_key") === "fixture-openalex-key"
      )).toBe(true);
      expect(JSON.stringify(
        await new D1BriefingRepository(env.DB).getWorkflowRunDetail(runId),
      )).not.toContain("fixture-openalex-key");
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("uses relevance-first research triage before assessment", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      ...rawResearchCandidate(
        `2607.${String(32_000 + index)}`,
        index < 9
          ? `Irrelevant arrival ${index}`
          : `Relevant candidate ${index} for interpretability oversight`,
      ),
      abstract: index < 9
        ? "Unrelated agricultural logistics observations."
        : "Mechanistic interpretability improves oversight with a concrete method.",
      metadata: { discoveryFamily: "arxiv" },
    }));
    const embedding = new RelevanceFirstEmbeddingProvider();
    const assessment = new ConcurrencyTrackingAssessmentProvider();
    const context = createProductionPipelineContext({
      editionDate: "2033-03-13",
      runId: "relevance-first-research",
      store: new FixtureStore(),
      now: () => now,
      providers: { summary: embedding, assessment },
      collectCandidates: async () => candidates,
      budgetPolicy: {
        state: "normal",
        radarSummaryTokens: 300,
        featuredSummaryTokens: 900,
      },
    });

    const normalized = await context.normalize(await context.collect());
    const enriched = await context.enrich(normalized);
    const prefiltered = await context.prefilter(enriched);
    const assessed = await context.assess(prefiltered);

    const embeddedText = embedding.embedRequests.flat().join("\n");
    for (const candidate of candidates) {
      expect(embeddedText).toContain(candidate.title);
    }
    expect(prefiltered).toHaveLength(6);
    expect(prefiltered.every(({ title }) =>
      title.startsWith("Relevant candidate")
    )).toBe(true);
    expect(assessment.startedPackets).toHaveLength(6);
    expect(assessment.startedPackets.every((packet) =>
      packet.includes("Relevant candidate")
    )).toBe(true);
    expect(assessed).toHaveLength(6);
    for (const item of enriched) {
      const workflow = item.metadata.workflow as {
        topicalFit?: number;
        embedding?: readonly number[];
      };
      expect(workflow.topicalFit).toEqual(expect.any(Number));
      expect(workflow).not.toHaveProperty("embedding");
    }
  });

  it("keeps two-window research selection stable when the same run retries", async () => {
    const repository = new D1BriefingRepository(env.DB);
    const fourDaysOld = "2026-07-26T09:00:00.000Z";
    const fresh = {
      ...rawResearchCandidate("2607.31001", "Fresh interpretability result"),
      publishedAt: "2026-07-29T12:00:00.000Z",
      metadata: {
        discoveryFamily: "arxiv",
        contentFingerprint: "content:fresh",
        evidenceFingerprint: "evidence:fresh",
      },
    };
    const unchanged = {
      ...rawResearchCandidate("2607.31002", "Unchanged interpretability result"),
      publishedAt: fourDaysOld,
      metadata: {
        discoveryFamily: "arxiv",
        contentFingerprint: "content:unchanged",
        evidenceFingerprint: "evidence:unchanged",
      },
    };
    const changed = {
      ...rawResearchCandidate("2607.31003", "Changed interpretability evidence"),
      publishedAt: fourDaysOld,
      metadata: {
        discoveryFamily: "arxiv",
        contentFingerprint: "content:changed",
        evidenceFingerprint: "evidence:new",
      },
    };
    await repository.upsertDiscoveryObservations([
      {
        runId: "prior-run",
        canonicalId: "arxiv:2607.31002",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        windowKind: "fresh",
        publishedAt: fourDaysOld,
        retrievedAt: fourDaysOld,
        observedAt: "2026-07-27T09:00:00.000Z",
        contentFingerprint: "content:unchanged",
        evidenceFingerprint: "evidence:unchanged",
        joinedExternalIds: ["arxiv:2607.31002"],
        route: "research",
        expiresAt: "2026-08-03T09:00:00.000Z",
      },
      {
        runId: "prior-run",
        canonicalId: "arxiv:2607.31003",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        windowKind: "fresh",
        publishedAt: fourDaysOld,
        retrievedAt: fourDaysOld,
        observedAt: "2026-07-27T09:00:00.000Z",
        contentFingerprint: "content:changed",
        evidenceFingerprint: "evidence:old",
        joinedExternalIds: ["arxiv:2607.31003"],
        route: "research",
        expiresAt: "2026-08-03T09:00:00.000Z",
      },
      {
        runId: "two-window-current-run",
        canonicalId: "arxiv:2607.31003",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        windowKind: "reconsideration",
        publishedAt: fourDaysOld,
        retrievedAt: now,
        observedAt: now,
        contentFingerprint: "content:changed",
        evidenceFingerprint: "evidence:new",
        joinedExternalIds: ["arxiv:2607.31003"],
        route: "research",
        expiresAt: "2026-08-06T09:00:00.000Z",
      },
    ]);
    const context = createProductionPipelineContext({
      editionDate: "2033-03-12",
      runId: "two-window-current-run",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [unchanged, fresh, changed],
      researchRepository: repository,
    });

    const collected = await context.collect();
    const first = await context.normalize(collected);
    const retried = await context.normalize(collected);

    expect(first.map(({ title }) => title)).toEqual([
      "Fresh interpretability result",
      "Changed interpretability evidence",
    ]);
    expect(retried.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
    expect(first.map((item) => item.metadata.discoveryWindow)).toEqual([
      "fresh",
      "reconsideration",
    ]);
    const currentRunObservations = await repository.getDiscoveryObservations(
      ["arxiv:2607.31001", "arxiv:2607.31003"],
      "2026-07-23T09:00:00.000Z",
      "another-run",
    );
    expect(currentRunObservations.filter(({ runId }) =>
      runId === "two-window-current-run"
    )).toHaveLength(2);
  });

  it.each([
    { section: "technology" as const, label: "Technology" },
    { section: "ai_policy" as const, label: "AI Policy" },
  ])("applies two-window observation policy to routed $label official publications", async ({
    section,
  }) => {
    // This fails if routed official-publication articles bypass observation
    // classification or if their persisted route is hardcoded as research.
    const repository = new D1BriefingRepository(env.DB);
    const priorNow = "2026-07-27T09:00:00.000Z";
    const olderPublishedAt = "2026-07-26T09:00:00.000Z";
    const contextFor = (
      runId: string,
      observedAt: string,
      candidates: readonly RawPublicationCandidate[],
    ) =>
      createProductionPipelineContext({
        editionDate: "2033-03-12",
        runId,
        store: new FixtureStore(),
        now: () => observedAt,
        providers: {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
        collectCandidates: async () => candidates,
        researchRepository: repository,
      });
    const normalize = async (
      runId: string,
      observedAt: string,
      candidates: readonly RawPublicationCandidate[],
    ) => {
      const context = contextFor(runId, observedAt, candidates);
      return context.normalize(await context.collect());
    };

    const fresh = rawOfficialPublicationCandidate(
      section,
      `${section}-fresh`,
      "2026-07-30T08:00:00.000Z",
      "The official publication supplies fresh evidence.",
    );
    const unchanged = rawOfficialPublicationCandidate(
      section,
      `${section}-unchanged`,
      olderPublishedAt,
      "The official publication supplies unchanged evidence.",
    );
    const changedBefore = rawOfficialPublicationCandidate(
      section,
      `${section}-changed`,
      olderPublishedAt,
      "The official publication supplies initial evidence.",
    );
    const changedAfter = {
      ...changedBefore,
      abstract: "The official publication supplies materially changed evidence.",
    };

    const freshSelected = await normalize(
      `${section}-fresh-run`,
      now,
      [fresh],
    );
    await normalize(`${section}-unchanged-prior`, priorNow, [unchanged]);
    const unchangedSelected = await normalize(
      `${section}-unchanged-current`,
      now,
      [unchanged],
    );
    await normalize(`${section}-changed-prior`, priorNow, [changedBefore]);
    const changedSelected = await normalize(
      `${section}-changed-current`,
      now,
      [changedAfter],
    );

    expect(freshSelected).toHaveLength(1);
    expect(freshSelected[0]).toMatchObject({
      kind: "article",
      metadata: {
        primarySection: section,
        discoveryWindow: "fresh",
      },
    });
    expect(unchangedSelected).toEqual([]);
    expect(changedSelected).toHaveLength(1);
    expect(changedSelected[0]).toMatchObject({
      kind: "article",
      metadata: {
        primarySection: section,
        discoveryWindow: "reconsideration",
      },
    });
    const changedItem = changedSelected[0]!;
    const observations = await repository.getDiscoveryObservations(
      [canonicalResearchIdentity(changedItem)],
      "2026-07-23T09:00:00.000Z",
      "inspection-run",
    );
    expect(observations.find(({ runId }) =>
      runId === `${section}-changed-current`
    )).toMatchObject({
      canonicalId: canonicalResearchIdentity(changedItem),
      sourceId: section === "technology" ? "nist" : "federal-register",
      discoveryFamily: "official-publication",
      windowKind: "reconsideration",
      route: section,
      ...researchFingerprints(changedItem),
    });
  });

  it("keeps ordinary news outside discovery-observation classification", async () => {
    // This fails if the official-publication fallback family accidentally
    // classifies ordinary article collection as routed publication discovery.
    const repository = new D1BriefingRepository(env.DB);
    const context = createProductionPipelineContext({
      editionDate: "2033-03-12",
      runId: "ordinary-news-window",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [
        rawNewsCandidate("ordinary-technology", "technology"),
      ],
      researchRepository: repository,
    });

    const selected = await context.normalize(await context.collect());

    expect(selected).toHaveLength(1);
    expect(selected[0]?.metadata).not.toHaveProperty("discoveryWindow");
    expect(await repository.getDiscoveryObservations(
      [canonicalResearchIdentity(selected[0]!)],
      "2026-07-23T09:00:00.000Z",
      "inspection-run",
    )).toEqual([]);
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

  it("repairs canary-like extractive titles", async () => {
    // This fails if production qualification or clustering drops a canary
    // candidate, shortlist reservation moves qualified research behind news,
    // title repair exceeds one attempt, or repaired summaries fail downstream
    // validation and coverage composition.
    const provider = new TitleRepairingSummaryProvider();
    const assessment = new FakeModelProvider({
      generatedObjects: Array.from(
        { length: 2 },
        () => researchAssessment,
      ),
    });
    const context = createProductionPipelineContext({
      editionDate: "2033-03-13",
      runId: "canary-like-title-repair",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: provider,
        assessment,
      },
      collectCandidates: async () => [
        {
          ...rawResearchCandidate(
            "2607.30001",
            "Research title Alpha absent from the abstract",
            20,
          ),
          abstract: "Alpha research evidence supports oversight, although long-term effects remain uncertain.",
        },
        {
          ...rawResearchCandidate(
            "2607.30002",
            "Research title Beta absent from the abstract",
            10,
          ),
          abstract: "Beta research evidence supports evaluation, although implementation remains uncertain.",
        },
        rawNewsCandidate("canary-world", "world"),
        rawNewsCandidate("canary-technology", "technology"),
        rawNewsCandidate("canary-ai-policy", "ai_policy"),
        rawNewsCandidate("canary-dmv", "dmv"),
        rawNewsCandidate("canary-baltimore", "baltimore"),
        {
          ...rawNewsCandidate("canary-world-second", "world"),
          title: "Canary reserve opens a separate public service program",
        },
      ],
    });
    const collected = await context.collect();
    const normalized = await context.normalize(collected);
    const enriched = await context.enrich(normalized);
    const prefiltered = await context.prefilter(enriched);
    const assessed = await context.assess(prefiltered);
    const scored = await context.score(assessed);
    const clustered = await context.cluster(scored);
    const shortlisted = await context.shortlist(clustered);

    expect(collected).toHaveLength(8);
    expect(normalized).toHaveLength(8);
    expect(new Set(normalized.map(({ id }) => id)).size).toBe(8);
    expect(prefiltered).toHaveLength(8);
    expect(assessed).toHaveLength(8);
    expect(assessment.generateRequests).toHaveLength(2);
    expect(provider.embedRequests).toHaveLength(1);
    expect(provider.embedRequests[0]).toHaveLength(11);
    expect(clustered).toHaveLength(8);
    expect(shortlisted).toHaveLength(8);
    expect(shortlisted.filter(({ kind }) => kind === "paper")).toHaveLength(2);
    expect(shortlisted.slice(0, 2).map(({ title }) => title)).toEqual([
      "Research title Alpha absent from the abstract",
      "Research title Beta absent from the abstract",
    ]);

    const summaries = await context.synthesize(shortlisted);
    const validated = await context.validate(summaries);
    const composition = await composeEdition(context, validated, normalized);

    expect(summaries).toHaveLength(8);
    expect(summaries.filter(({ item }) => item.kind === "paper")).toHaveLength(2);
    expect(provider.requests).toHaveLength(16);
    expect(provider.requests.filter(({ sourcePacket }) =>
      sourcePacket.startsWith("VALIDATION ERRORS AND REQUIRED REPAIRS")
    )).toHaveLength(8);
    expect(summaries.every(({ summary, item }) =>
      summary.title === item.title
    )).toBe(true);
    for (let index = 0; index < 8; index += 1) {
      expect(provider.requests[index * 2]?.sourcePacket.startsWith(
        "VALIDATION ERRORS AND REQUIRED REPAIRS",
      )).toBe(false);
      expect(provider.requests[index * 2 + 1]?.sourcePacket).toContain(
        "UNGROUNDED_PROSE:title",
      );
    }
    expect(validated).toHaveLength(8);
    expect(validated.every(({ valid }) => valid)).toBe(true);
    expect(composition).toMatchObject({
      status: "published",
      missingSections: [],
    });
    expect(composition.entries).toHaveLength(8);
    expect(composition.entries.map(({ summary }) => summary.title)).toEqual(
      shortlisted.map(({ title }) => title),
    );
  });

  it("drops hard-stop uncached assessment and caps degraded calls before 120-token radar synthesis", async () => {
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
    const hardAssessed = await hard.assess(hardPrefiltered);
    expect(hardEnriched).toHaveLength(0);
    expect(hardPrefiltered).toHaveLength(0);
    expect(hardAssessed).toHaveLength(0);
    expect(hardAssessment.generateRequests).toHaveLength(0);

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

  it("reuses cached hard-stop research with a denied real model provider and zero model calls", async () => {
    const candidate = rawResearchCandidate(
      "2607.29999",
      "Cached interpretability evidence for oversight",
      50,
    );
    const assessment = {
      technicalQuality: 0.9,
      novelty: 0.8,
      strengths: ["The abstract describes a concrete method."],
      limitations: ["Only abstract evidence was supplied."],
      rationale: "The available abstract supports a strong assessment.",
      accessLevel: "abstract" as const,
    };
    const repository = new D1BriefingRepository(env.DB);
    const seed = createProductionPipelineContext({
      editionDate: "2033-03-04",
      runId: "hard-budget-cache-seed",
      store: new FixtureStore(),
      now: () => now,
      providers: {
        summary: new FakeModelProvider(),
        assessment: new FakeModelProvider(),
      },
      collectCandidates: async () => [candidate],
    });
    const [normalized] = await seed.normalize(await seed.collect());
    expect(normalized).toBeDefined();
    await repository.putCachedResearchAssessment(
      canonicalResearchIdentity(normalized!),
      researchFingerprints(normalized!).evidenceFingerprint,
      assessment,
      "2034-01-01T00:00:00.000Z",
      0.95,
    );

    const authorize = vi.fn(async () => null);
    const transport = vi.fn(async () => {
      throw new Error("Model transport must not run at hard stop.");
    });
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "test-generation",
      embeddingModel: "test-embedding",
      authorize,
      fetch: transport as typeof fetch,
    });
    const embed = vi.spyOn(provider, "embed");
    const generateObject = vi.spyOn(provider, "generateObject");
    const hard = createProductionPipelineContext({
      editionDate: "2033-03-04",
      runId: "hard-budget-cached",
      store: new FixtureStore(),
      now: () => now,
      providers: { summary: provider, assessment: provider },
      collectCandidates: async () => [candidate],
      researchRepository: repository,
      budgetPolicy: {
        state: "hard_stop",
        radarSummaryTokens: 0,
        featuredSummaryTokens: 900,
      },
    });

    const hardNormalized = await hard.normalize(await hard.collect());
    const hardEnriched = await hard.enrich(hardNormalized);
    const hardPrefiltered = await hard.prefilter(hardEnriched);
    const hardAssessed = await hard.assess(hardPrefiltered);

    expect(hardEnriched).toHaveLength(1);
    expect((hardEnriched[0]!.metadata.workflow as { topicalFit?: number })
      .topicalFit).toBe(0.95);
    expect(hardAssessed).toHaveLength(1);
    expect((hardAssessed[0]!.metadata.workflow as {
      assessment?: unknown;
    }).assessment).toEqual(assessment);
    expect(embed).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(provider.usage).toEqual([]);
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

  it("reserves qualified featured research ahead of higher-scoring news", async () => {
    // This fails if the production shortlist lets globally ranked news consume
    // all morning-brief capacity before the qualified featured research is kept.
    const clustered = [
      rawResearchCandidate(
        "2607.30001",
        "Interpretability study Alpha for oversight",
        0,
      ),
      rawResearchCandidate(
        "2607.30002",
        "Interpretability study Beta for oversight",
        0,
      ),
      rawResearchCandidate(
        "2607.30003",
        "Interpretability study Gamma for oversight",
        0,
      ),
      rawResearchCandidate(
        "2607.30004",
        "Interpretability study Delta for oversight",
        0,
      ),
      ...highScoringNews(),
    ];

    const shortlisted = await productionShortlist(
      clustered,
      Array.from({ length: 4 }, () => qualifiedResearchAssessment),
      "reserved-featured-forward",
    );
    const reversed = await productionShortlist(
      [...clustered].reverse(),
      Array.from({ length: 4 }, () => qualifiedResearchAssessment),
      "reserved-featured-reverse",
    );

    expect(shortlisted).toHaveLength(8);
    expect(shortlisted.filter(
      (item) => item.kind === "paper" || item.kind === "blog",
    )).toHaveLength(3);
    expect(shortlisted.slice(0, 3).map((item) => item.metadata.section))
      .toEqual(["research", "research", "research"]);
    expect(new Set(shortlisted.map(({ id }) => id)).size).toBe(8);
    expect(shortlisted.map(({ id }) => id))
      .toEqual(reversed.map(({ id }) => id));
  });

  it.each([
    { qualified: 0, expectedResearch: 0 },
    { qualified: 1, expectedResearch: 1 },
    { qualified: 2, expectedResearch: 2 },
  ])("reserves only $expectedResearch qualified research slots", async ({
    qualified,
    expectedResearch,
  }) => {
    // This fails if a qualifying featured paper is displaced by higher-ranked
    // news, or if research below the technical-quality gate is retained.
    const papers = qualified === 0
      ? [rawResearchCandidate(
          "2607.31000",
          "Interpretability study below technical quality",
          0,
        )]
      : Array.from({ length: qualified }, (_, index) => rawResearchCandidate(
          `2607.3100${index + 1}`,
          `Interpretability study qualified ${index + 1}`,
          0,
        ));
    const clustered = qualified === 0 ? papers : [...papers, ...highScoringNews()];
    const shortlisted = await productionShortlist(
      clustered,
      qualified === 0
        ? [belowTechnicalQualityAssessment]
        : Array.from({ length: qualified }, () => qualifiedResearchAssessment),
      `reserved-featured-${qualified}`,
    );
    const isResearchFixture = (item: Item) =>
      item.kind === "paper" || item.kind === "blog";

    expect(shortlisted.filter(isResearchFixture)).toHaveLength(expectedResearch);
    expect(shortlisted.length).toBeLessThanOrEqual(8);
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
        "https://www.wypr.org/wypr-news.rss",
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
            "https://api.semanticscholar.org/graph/v1/paper/search/bulk",
          )
        ) {
          return Response.json({ total: 0, data: [] });
        }
        if (
          url.startsWith(
            "https://api.semanticscholar.org/recommendations/v1/papers",
          )
        ) {
          return Response.json({ recommendedPapers: [] });
        }
        if (url.startsWith("https://api.openalex.org/institutions")) {
          return Response.json({ results: [] });
        }
        if (url.startsWith("https://api.openalex.org/works")) {
          return Response.json({ results: [] });
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
        { openAlexApiKey: "fixture-openalex-key" },
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
        { openAlexApiKey: "fixture-openalex-key" },
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

  it("collects the enabled PapersWithCode catalog source through the production context", async () => {
    await env.DB.prepare(
      `UPDATE sources
       SET enabled = CASE WHEN id = 'papers-with-code-co' THEN 1 ELSE 0 END`,
    ).run();
    const catalogSource = await new D1BriefingRepository(env.DB)
      .listSources()
      .then((sources) => sources.find(({ id }) => id === "papers-with-code-co"));
    expect(catalogSource).toMatchObject({
      id: "papers-with-code-co",
      role: "analysis",
      discoveryMechanism: "page",
    });

    const publishedDate = new Date(Date.now() - 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    const sourceFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        "https://paperswithcode.co/?order_by=date_published",
      );
      return new Response(
        `<!doctype html><html><body><section><h2>Relevant papers</h2>
          <article>
            <a href="/paper/2608.01234">Production PapersWithCode result</a>
            <time datetime="${publishedDate}">${publishedDate}</time>
            <a href="https://github.com/example/production-result">Code</a>
          </article>
        </section></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    });
    vi.stubGlobal("fetch", sourceFetch);
    try {
      const runId = "run-production-papers-with-code";
      const editionDate = "2033-02-07";
      const createdAt = new Date().toISOString();
      const store = createD1PipelineStore(env.DB);
      await store.createRun({
        id: runId,
        editionDate,
        status: "running",
        currentStep: "collect",
        retryable: false,
        attemptCount: 1,
        estimatedCostUsd: 0,
        createdAt,
        updatedAt: createdAt,
      });
      const context = createD1ProductionPipelineContext(
        store,
        editionDate,
        runId,
        {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
      );

      const collected = await context.collect();

      expect(sourceFetch).toHaveBeenCalledOnce();
      expect(collected).toEqual([
        expect.objectContaining({
          kind: "publication",
          sourceId: "papers-with-code-co",
          externalId: "arXiv:2608.01234",
          discoveryFamily: "commentary",
          metadata: expect.objectContaining({
            implementationAvailable: true,
            discoveryLaneIds: ["papers-with-code-co:page"],
          }),
        }),
      ]);
      await expect(store.repository.getWorkflowRunDetail(runId)).resolves
        .toMatchObject({
          discoveryDiagnostics: [{
            laneId: "papers-with-code-co:page",
            sourceId: "papers-with-code-co",
            discoveryFamily: "commentary",
            discovered: 1,
            outcome: "success",
          }],
        });
      expect((await store.repository.listSources()).find(
        ({ id }) => id === "papers-with-code-co",
      )).toMatchObject({
        healthStatus: "healthy",
        lastSuccessAt: expect.any(String),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("replaces stale D1 diagnostics when a retry recollects zero lanes", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
    const runId = "run-zero-lane-diagnostics-retry";
    const editionDate = "2033-02-10";
    const createdAt = new Date().toISOString();
    const store = createD1PipelineStore(env.DB);
    await store.createRun({
      id: runId,
      editionDate,
      status: "failed",
      currentStep: "publish",
      retryable: true,
      attemptCount: 1,
      estimatedCostUsd: 0,
      createdAt,
      updatedAt: createdAt,
      failureCode: "MINIMUM_COVERAGE_FAILED",
    });
    await store.repository.recordDiscoveryDiagnostics(runId, [{
      laneId: "arxiv:stale",
      sourceId: "arxiv",
      discoveryFamily: "arxiv",
      discovered: 1,
      deduplicated: 1,
      triaged: 1,
      assessed: 1,
      outcome: "success",
      rejectionCounts: {},
    }]);

    const fetch = vi.fn(async () => {
      throw new Error("disabled sources must not fetch");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const context = createD1ProductionPipelineContext(
        store,
        editionDate,
        runId,
        {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
      );

      await expect(runEditorialPipeline(context)).resolves.toMatchObject({
        status: "failed",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        (await store.repository.getDiscoveryDiagnosticsState(runId))
          ?.diagnostics,
      ).toEqual([]);
      expect(
        (await store.repository.getWorkflowRunDetail(runId))
          ?.discoveryDiagnostics,
      ).toEqual([]);

      const freshContext = createD1ProductionPipelineContext(
        createD1PipelineStore(env.DB),
        editionDate,
        runId,
        {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
      );
      await freshContext.normalize([]);
      expect(
        (await store.repository.getDiscoveryDiagnosticsState(runId))
          ?.diagnostics,
      ).toEqual([]);
      expect(
        (await store.repository.getWorkflowRunDetail(runId))
          ?.discoveryDiagnostics,
      ).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses a 36-hour production window for news and seven days for research publications", async () => {
    const enabledSources = ["alignment-forum", "reuters"];
    await env.DB.prepare(
      `UPDATE sources
       SET enabled = CASE
         WHEN id IN (${enabledSources.map(() => "?").join(", ")}) THEN 1
         ELSE 0
       END`,
    ).bind(...enabledSources).run();
    const publishedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1_000)
      .toUTCString();
    const feed = (title: string, link: string, guid: string) =>
      `<?xml version="1.0"?><rss><channel><item>
        <title>${title}</title><link>${link}</link><guid>${guid}</guid>
        <pubDate>${publishedAt}</pubDate>
        <description>Linked evidence at https://arxiv.org/abs/2608.04567.</description>
      </item></channel></rss>`;
    const sourceFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://www.reutersagency.com/feed/") {
        return new Response(feed(
          "Unchanged four-day-old ordinary news",
          "https://www.reuters.com/world/old-news",
          "old-news",
        ), { headers: { "content-type": "application/rss+xml" } });
      }
      if (
        url ===
          "https://www.alignmentforum.org/feed.xml?view=frontpage"
      ) {
        return new Response(feed(
          "Four-day-old research commentary",
          "https://www.alignmentforum.org/posts/example/commentary",
          "research-commentary",
        ), { headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`Unexpected production-context URL: ${url}`);
    });
    vi.stubGlobal("fetch", sourceFetch);
    try {
      const runId = "run-production-window-split";
      const editionDate = "2033-02-06";
      const createdAt = new Date().toISOString();
      const store = createD1PipelineStore(env.DB);
      await store.createRun({
        id: runId,
        editionDate,
        status: "running",
        currentStep: "collect",
        retryable: false,
        attemptCount: 1,
        estimatedCostUsd: 0,
        createdAt,
        updatedAt: createdAt,
      });
      const context = createD1ProductionPipelineContext(
        store,
        editionDate,
        runId,
        {
          summary: new FakeModelProvider(),
          assessment: new FakeModelProvider(),
        },
      );

      const collected = await context.collect();

      expect(sourceFetch).toHaveBeenCalledTimes(2);
      expect(collected.flatMap((candidate) =>
        "sourceId" in candidate ? [candidate.sourceId] : []
      )).toEqual(["alignment-forum"]);
      expect(collected[0]).toMatchObject({
        kind: "publication",
        relatedPaperIds: ["arXiv:2608.04567"],
      });
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
