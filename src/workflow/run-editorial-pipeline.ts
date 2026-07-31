import { composeEdition } from "./compose-edition";
import { publishEdition } from "./publish-edition";
import { D1BriefingRepository } from "../db/d1-repository";
import { z } from "zod";
import { SourceHttpClient } from "../sources/http-client";
import { createNewsCollectorFromCatalog } from "../sources/news-collector";
import { durableCollectedCandidate } from "../sources/durable-evidence";
import { normalizeCandidate } from "../editorial/normalize";
import { deduplicateItems } from "../editorial/deduplicate";
import {
  summarizeItem,
  SummaryRejectedError,
} from "../editorial/summarize";
import type { SourcePacket } from "../editorial/validate-summary";
import type { ModelProvider } from "../models/provider";
import { assessResearch } from "../editorial/assess-research";
import { scoreResearch } from "../editorial/research-score";
import {
  NewsScoreSchema,
  scoreNews,
  scoreNewsDevelopment,
  type NewsScore,
} from "../editorial/news-score";
import {
  clusterNews,
  NewsDevelopmentSchema,
  type NewsDevelopment,
} from "../editorial/cluster";
import {
  shortlist as selectShortlist,
  type SectionBudgets,
  type ShortlistPreferences,
} from "../editorial/shortlist";
import { editorialSignals } from "../editorial/editorial-signals";
import { READER_PROFILE } from "../config/reader-profile";
import { ArxivAdapter } from "../sources/arxiv";
import { SemanticScholarAdapter } from "../sources/semantic-scholar";
import { OpenAlexAdapter } from "../sources/openalex";
import { ResearchCollector } from "../sources/research-collector";
import {
  RawNewsCandidateSchema,
  RawResearchCandidateSchema,
  type RawNewsCandidate,
  type RawResearchCandidate,
  type ResearchSourceInput,
} from "../sources/types";
import {
  EditionEntrySchema,
  EditionMetadataSchema,
  EditionSchema,
  ItemScoreSchema,
  ItemSchema,
  StructuredSummarySchema,
  type EditionSection,
  type Item,
  type ItemScore,
} from "../contracts/editorial";
import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
} from "../contracts/editorial";
import {
  PIPELINE_STEPS,
  CollectedCandidateSchema,
  WorkflowItemPayloadSchema,
  WorkflowItemSchema,
  type CheckpointArtifact,
  type CollectedCandidate,
  type PipelineContext,
  type PipelineResult,
  type PipelineRun,
  type PipelineStore,
  type PipelineStatus,
  type WorkflowItemPayload,
} from "./types";
import type { BudgetPolicy } from "../models/cost-ledger";

export { PIPELINE_STEPS } from "./types";
export type { PipelineContext, PipelineRun, PipelineStore } from "./types";

export class WorkflowRunAlreadyExistsError extends Error {
  constructor() {
    super("RUN_ALREADY_EXISTS");
    this.name = "WorkflowRunAlreadyExistsError";
  }
}

export class WorkflowResumeUnavailableError extends Error {
  constructor() {
    super("RUN_NOT_RETRYABLE");
    this.name = "WorkflowResumeUnavailableError";
  }
}

type PersistedRunRow = {
  id: string;
  edition_date: string;
  status: PipelineRun["status"];
  current_step: PipelineRun["currentStep"];
  retryable: number;
  attempt_count: number;
  failure_code: string | null;
  estimated_cost_usd: number;
  created_at: string;
  updated_at: string;
};

const PersistedRunSchema = z.object({
  id: z.string().min(1), edition_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["pending", "running", "retryable", "published", "partial", "failed"]),
  current_step: z.enum(PIPELINE_STEPS).nullable(), retryable: z.union([z.literal(0), z.literal(1)]),
  attempt_count: z.number().int().nonnegative(), failure_code: z.string().nullable(),
  estimated_cost_usd: z.number().finite().nonnegative(), created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict();
const CollectedCandidatesSchema = z.array(CollectedCandidateSchema).max(1_000);

type ItemStage =
  | "normalize"
  | "enrich"
  | "prefilter"
  | "assess"
  | "score"
  | "cluster"
  | "shortlist";

function stageItemsSchema(stage: ItemStage) {
  return z.array(WorkflowItemSchema).max(1_000).superRefine(
    (items, context) => {
      items.forEach((item, index) => {
        if (item.metadata.workflow === undefined) return;
        const payload = WorkflowItemPayloadSchema.parse(
          item.metadata.workflow,
        );
        const research = item.kind === "paper" || item.kind === "blog";
        const requireField = (
          present: boolean,
          field: keyof WorkflowItemPayload,
        ) => {
          if (present) return;
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Production ${stage} artifacts require ${field}.`,
            path: [index, "metadata", "workflow", field],
          });
        };
        if (research) {
          requireField(payload.rawResearch !== undefined, "rawResearch");
        }
        if (
          stage === "enrich" ||
          stage === "prefilter" ||
          stage === "assess" ||
          stage === "score" ||
          stage === "cluster" ||
          stage === "shortlist"
        ) {
          requireField(payload.embedding !== undefined, "embedding");
          requireField(
            research
              ? payload.topicalFit !== undefined
              : payload.personalRelevance !== undefined,
            research ? "topicalFit" : "personalRelevance",
          );
        }
        if (
          research &&
          (stage === "assess" ||
            stage === "score" ||
            stage === "cluster" ||
            stage === "shortlist")
        ) {
          requireField(payload.assessment !== undefined, "assessment");
        }
        if (
          research &&
          (stage === "score" ||
            stage === "cluster" ||
            stage === "shortlist")
        ) {
          requireField(payload.researchScore !== undefined, "researchScore");
        }
        if (!research && stage === "score") {
          requireField(payload.newsScore !== undefined, "newsScore");
        }
        if (!research && (stage === "cluster" || stage === "shortlist")) {
          requireField(payload.development !== undefined, "development");
          requireField(
            payload.developmentScore !== undefined,
            "developmentScore",
          );
        }
        if (stage === "shortlist") {
          requireField(payload.section !== undefined, "section");
          requireField(
            payload.selectionReasons !== undefined,
            "selectionReasons",
          );
        }
      });
    },
  );
}

const NormalizedItemsSchema = stageItemsSchema("normalize");
const EnrichedItemsSchema = stageItemsSchema("enrich");
const PrefilteredItemsSchema = stageItemsSchema("prefilter");
const AssessedItemsSchema = stageItemsSchema("assess");
const ScoredItemsSchema = stageItemsSchema("score");
const ClusteredItemsSchema = stageItemsSchema("cluster");
const ShortlistedItemsSchema = stageItemsSchema("shortlist");
const SummaryCandidateSchema = z.object({
  item: WorkflowItemSchema,
  summary: StructuredSummarySchema,
}).strict();
const ValidatedSummaryCandidateSchema = SummaryCandidateSchema.extend({
  valid: z.boolean(),
  validationErrors: z.array(z.string().min(1).max(200)).max(64).optional(),
}).strict();
const SummaryCandidatesSchema = z.array(SummaryCandidateSchema).max(8);
const ValidatedSummaryCandidatesSchema = z.array(
  ValidatedSummaryCandidateSchema,
).max(8);
const CheckpointStringSchema = z.string().min(1).max(200);
const DraftEditionSchema = EditionSchema.extend({
  status: z.literal("draft"),
  publishedAt: z.null(),
  metadata: EditionMetadataSchema,
}).strict();
const CompositionSchema = z.object({
  edition: DraftEditionSchema,
  entries: z.array(EditionEntrySchema).max(8),
  status: z.enum(["published", "partial", "failed"]),
  missingSections: z.array(CheckpointStringSchema).max(32),
  sourceFailures: z.array(CheckpointStringSchema).max(64),
}).strict().superRefine((composition, context) => {
  composition.entries.forEach((entry, index) => {
    if (entry.editionId !== composition.edition.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Composition entries must belong to the composed edition.",
        path: ["entries", index, "editionId"],
      });
    }
  });
  if (
    JSON.stringify(composition.missingSections) !==
      JSON.stringify(composition.edition.metadata.missingSections) ||
    JSON.stringify(composition.sourceFailures) !==
      JSON.stringify(composition.edition.metadata.sourceFailures)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Composition metadata must match its durable status fields.",
      path: ["edition", "metadata"],
    });
  }
});

function checkpointOutputSchema(
  step: (typeof PIPELINE_STEPS)[number],
): z.ZodType<unknown, z.ZodTypeDef, unknown> {
  switch (step) {
    case "collect":
      return CollectedCandidatesSchema;
    case "normalize":
      return NormalizedItemsSchema;
    case "enrich":
      return EnrichedItemsSchema;
    case "prefilter":
      return PrefilteredItemsSchema;
    case "assess":
      return AssessedItemsSchema;
    case "score":
      return ScoredItemsSchema;
    case "cluster":
      return ClusteredItemsSchema;
    case "shortlist":
      return ShortlistedItemsSchema;
    case "synthesize":
      return SummaryCandidatesSchema;
    case "validate":
      return ValidatedSummaryCandidatesSchema;
    case "compose":
    case "publish":
      return CompositionSchema;
  }
}

const ArtifactAttemptsSchema = z.number().int().positive();
const ArtifactDurationSchema = z.number().finite().nonnegative();
const ArtifactItemCountSchema = z.number().int().nonnegative();
const ArtifactCostSchema = z.number().finite().nonnegative();
const ARTIFACT_KEYS = new Set([
  "output",
  "attempts",
  "durationMs",
  "itemCount",
  "estimatedCostUsd",
]);

function parseCheckpointArtifact(
  step: (typeof PIPELINE_STEPS)[number],
  value: unknown,
): CheckpointArtifact<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Checkpoint artifact must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== ARTIFACT_KEYS.size ||
    keys.some((key) => !ARTIFACT_KEYS.has(key))
  ) {
    throw new TypeError("Checkpoint artifact has unknown or missing fields.");
  }
  return {
    output: checkpointOutputSchema(step).parse(record.output),
    attempts: ArtifactAttemptsSchema.parse(record.attempts),
    durationMs: ArtifactDurationSchema.parse(record.durationMs),
    itemCount: ArtifactItemCountSchema.parse(record.itemCount),
    estimatedCostUsd: ArtifactCostSchema.parse(record.estimatedCostUsd),
  };
}

export class D1PipelineStore implements PipelineStore {
  readonly repository: D1BriefingRepository;

  constructor(private readonly db: D1Database) {
    this.repository = new D1BriefingRepository(db);
  }

  private runFromRow(row: PersistedRunRow): PipelineRun {
    const valid = PersistedRunSchema.parse(row);
    return {
      id: valid.id, editionDate: valid.edition_date, status: valid.status,
      currentStep: valid.current_step, retryable: valid.retryable === 1,
      attemptCount: valid.attempt_count, estimatedCostUsd: valid.estimated_cost_usd,
      createdAt: valid.created_at, updatedAt: valid.updated_at, failureCode: valid.failure_code,
    };
  }

  async getRun(runId: string): Promise<PipelineRun | null> {
    const row = await this.db.prepare(
      `SELECT
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
       FROM workflow_runs WHERE id = ?`,
    )
      .bind(runId).first<PersistedRunRow>();
    return row === null ? null : this.runFromRow(row);
  }

  async createRun(run: PipelineRun): Promise<void> {
    const result = await this.db.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM workflow_runs WHERE edition_date = ?)`,
    ).bind(
      run.id, run.editionDate, run.status, run.currentStep,
      run.retryable ? 1 : 0, run.attemptCount, run.failureCode ?? null,
      run.estimatedCostUsd, run.createdAt, run.updatedAt, run.editionDate,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) throw new WorkflowRunAlreadyExistsError();
  }

  async saveRun(run: PipelineRun): Promise<void> {
    await this.db.prepare(
      `UPDATE workflow_runs SET
        status = ?, current_step = ?, retryable = ?, attempt_count = ?,
        failure_code = ?, estimated_cost_usd = ?, updated_at = ?
      WHERE id = ?`,
    ).bind(
      run.status, run.currentStep, run.retryable ? 1 : 0, run.attemptCount,
      run.failureCode ?? null, run.estimatedCostUsd, run.updatedAt, run.id,
    ).run();
  }

  async readCheckpoint(runId: string, step: (typeof PIPELINE_STEPS)[number]): Promise<boolean> {
    return (await this.readArtifact(runId, step)) !== null;
  }

  async saveCheckpoint(
    runId: string,
    step: (typeof PIPELINE_STEPS)[number],
    artifact: CheckpointArtifact,
  ): Promise<void> {
    const validArtifact = parseCheckpointArtifact(step, artifact);
    await this.db.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), runId, "workflow_checkpoint",
      JSON.stringify({ step, artifact: validArtifact }), new Date().toISOString(),
    ).run();
  }

  async beginAttempt(runId: string, step: (typeof PIPELINE_STEPS)[number]): Promise<number> {
    const records = await this.db.prepare(
      "SELECT event_json FROM audit_events WHERE run_id = ? AND event_type = ?",
    ).bind(runId, "workflow_attempt").all<{ event_json: string }>();
    const attempt = records.results.filter((row) => {
      try { return (JSON.parse(row.event_json) as { step?: unknown }).step === step; } catch { return false; }
    }).length + 1;
    await this.db.prepare(
      "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), runId, "workflow_attempt", JSON.stringify({ step, attempt, status: "running" }), new Date().toISOString()).run();
    return attempt;
  }

  async failAttempt(runId: string, step: (typeof PIPELINE_STEPS)[number], attempt: number, error: string): Promise<void> {
    await this.db.prepare(
      "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), runId, "workflow_attempt_failed", JSON.stringify({ step, attempt, error }), new Date().toISOString()).run();
  }

  async invalidateFrom(runId: string, step: (typeof PIPELINE_STEPS)[number]): Promise<void> {
    const steps = PIPELINE_STEPS.slice(PIPELINE_STEPS.indexOf(step));
    const records = await this.db.prepare(
      "SELECT id, event_json FROM audit_events WHERE run_id = ? AND event_type = ?",
    ).bind(runId, "workflow_checkpoint").all<{ id: string; event_json: string }>();
    const ids = records.results.flatMap((row) => {
      try { return steps.includes((JSON.parse(row.event_json) as { step?: unknown }).step as typeof step) ? [row.id] : []; } catch { return []; }
    });
    for (const id of ids) await this.db.prepare("DELETE FROM audit_events WHERE id = ?").bind(id).run();
  }

  async readArtifact(
    runId: string,
    step: (typeof PIPELINE_STEPS)[number],
  ): Promise<CheckpointArtifact<unknown> | null> {
    const records = await this.db.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = ? ORDER BY created_at DESC`,
    ).bind(runId, "workflow_checkpoint").all<{ event_json: string }>();
    for (const record of records.results) {
      let parsed: { step?: unknown; artifact?: unknown };
      try {
        parsed = JSON.parse(record.event_json) as { step?: unknown; artifact?: unknown };
      } catch (error) {
        throw new Error("INVALID_CHECKPOINT_RECORD", { cause: error });
      }
      if (parsed.step !== step) continue;
      try {
        return parseCheckpointArtifact(step, parsed.artifact);
      } catch (error) {
        throw new Error(`INVALID_CHECKPOINT_ARTIFACT:${step}`, {
          cause: error,
        });
      }
    }
    return null;
  }

  async createDraft(edition: Edition): Promise<void> {
    const result = await this.db.prepare(
      `INSERT INTO editions (
        id, edition_date, run_id, status, reading_minutes, published_at, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edition_date) DO UPDATE SET metadata_json = excluded.metadata_json
      WHERE editions.run_id = excluded.run_id AND editions.status = 'draft'`,
    ).bind(
      edition.id, edition.editionDate, edition.runId, edition.status,
      edition.readingMinutes, edition.publishedAt, edition.createdAt,
      JSON.stringify(edition.metadata ?? { missingSections: [], sourceFailures: [] }),
    ).run();
    if ((result.meta.changes ?? 0) === 0) {
      const existing = await this.db.prepare(
        "SELECT run_id, status FROM editions WHERE edition_date = ?",
      ).bind(edition.editionDate).first<{ run_id: string; status: string }>();
      if (existing?.run_id !== edition.runId || existing.status !== "draft") {
        throw new Error("EDITION_ALREADY_EXISTS");
      }
    }
  }

  replaceEntries(editionId: string, entries: readonly EditionEntry[]): Promise<void> {
    return this.repository.replaceEditionEntries(editionId, entries);
  }

  publish(editionId: string, status: "published" | "partial"): Promise<void> {
    return this.repository.publishEdition(editionId, new Date().toISOString(), status);
  }

  getLatestEdition(): Promise<EditionWithEntries | null> {
    return this.repository.getLatestEdition();
  }

  async persistEdition(
    edition: Edition,
    entries: readonly EditionEntry[],
    status: "draft" | "published" | "partial",
  ): Promise<Edition> {
    return this.repository.persistEdition(
      edition.editionDate,
      edition.runId,
      entries,
      status,
      edition.metadata ?? { missingSections: [], sourceFailures: [] },
    );
  }

  async audit(runId: string | null, eventType: string, actorEmail: string | undefined): Promise<void> {
    await this.db.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), runId, eventType,
      JSON.stringify({ actorEmail: actorEmail ?? null }), new Date().toISOString(),
    ).run();
  }
}

export function createD1PipelineStore(db: D1Database): PipelineStore {
  return new D1PipelineStore(db);
}

export type PipelineProviders = {
  summary: ModelProvider;
  assessment: ModelProvider;
};

export type PipelineRuntime = {
  providers: PipelineProviders;
  budgetPolicy?: BudgetPolicy;
};

export type PipelineRuntimeFactory = (input: {
  runId: string;
  editionDate: string;
}) => Promise<PipelineRuntime>;

export type ProductionPipelineContextOptions = {
  editionDate: string;
  runId: string;
  store: PipelineStore;
  now: () => string;
  providers: PipelineProviders;
  collectCandidates: () => Promise<readonly CollectedCandidate[]>;
  persistItems?: (items: readonly Item[]) => Promise<void>;
  sourceFailures?: readonly string[];
  checkpointExecutor?: PipelineContext["checkpointExecutor"];
  budgetPolicy?: BudgetPolicy;
};

function workflowPayload(item: Item): WorkflowItemPayload {
  return WorkflowItemPayloadSchema.parse(item.metadata.workflow);
}

function withWorkflowPayload(
  item: Item,
  patch: Partial<Omit<WorkflowItemPayload, "version">>,
  metadataPatch: Readonly<Record<string, unknown>> = {},
): Item {
  const existing = item.metadata.workflow === undefined
    ? { version: 1 as const }
    : workflowPayload(item);
  const workflow = WorkflowItemPayloadSchema.parse({
    ...existing,
    ...patch,
    version: 1,
  });
  return WorkflowItemSchema.parse({
    ...item,
    metadata: {
      ...item.metadata,
      ...metadataPatch,
      workflow,
    },
  });
}

function normalizedCandidate(candidate: CollectedCandidate): Item {
  const storedItem = ItemSchema.safeParse(candidate);
  if (storedItem.success) {
    return withWorkflowPayload(storedItem.data, {});
  }
  const research = RawResearchCandidateSchema.safeParse(candidate);
  return withWorkflowPayload(
    normalizeCandidate(candidate),
    research.success ? { rawResearch: research.data } : {},
  );
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) return 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(
    0,
    Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)),
  );
}

function profileEmbeddingTexts(): string[] {
  return READER_PROFILE.researchTopics.map((topic) =>
    [topic.description, ...topic.positiveExamples].join(". "),
  );
}

function itemEmbeddingText(item: Item): string {
  return [item.title, item.primaryTopic, item.normalizedText]
    .filter((value) => value.length > 0)
    .join("\n");
}

function newsSection(item: Item): EditionSection {
  const parsed = z.enum([
    "world",
    "technology",
    "ai_policy",
    "dmv",
    "baltimore",
    "forecast",
  ]).safeParse(item.metadata.primarySection);
  return parsed.success ? parsed.data : item.kind === "forecast"
    ? "forecast"
    : "world";
}

function sourceQuality(item: Item): number {
  const priorities: Readonly<Record<Item["sourceRefs"][number]["role"], number>> = {
    primary: 0.98,
    reporting: 0.9,
    analysis: 0.7,
    blog: 0.7,
    opinion: 0.4,
    forecast: 0.5,
  };
  return Math.max(...item.sourceRefs.map((source) => priorities[source.role]));
}

function newsImportance(section: EditionSection): number {
  if (section === "world" || section === "ai_policy") return 0.85;
  if (section === "technology") return 0.8;
  if (section === "dmv" || section === "baltimore") return 0.75;
  return 0.6;
}

function recency(item: Item, now: string): number {
  if (item.publishedAt === null) return 0.5;
  const ageHours = Math.max(
    0,
    (Date.parse(now) - Date.parse(item.publishedAt)) / (60 * 60 * 1_000),
  );
  return Math.max(0, Math.min(1, 1 - ageHours / (7 * 24)));
}

function packet(item: Item): SourcePacket {
  const sources = [
    ...new Map(item.sourceRefs.map((source) => [source.id, source])).values(),
  ].slice(0, 12);
  return {
    itemKind: item.kind,
    sources: sources.map((source) => ({
      sourceId: source.id,
      role: source.role,
      title: item.title,
      url: source.url,
      retrievedAt: source.retrievedAt,
      accessLevel: item.accessLevel,
      excerpts: [{
        number: 1,
        text: item.normalizedText.slice(0, 4_000) || item.title,
      }],
    })),
  };
}

function averageNewsComponent(
  scores: readonly NewsScore[],
  key:
    | "publicImportance"
    | "personalRelevance"
    | "sourceQuality"
    | "recency"
    | "geography"
    | "novelty",
): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, score) => sum + score[key], 0) / scores.length;
}

function itemFromDevelopment(
  development: NewsDevelopment,
  score: NewsScore,
): Item {
  const representative = development.representativeItem;
  return withWorkflowPayload(
    ItemSchema.parse({
      ...representative,
      id: development.id,
      canonicalUrl:
        development.canonicalPrimaryDocument ??
        representative.canonicalUrl,
      title: development.title,
      sourceRefs: development.sourceRefs,
      normalizedText: development.items
        .map((item) => item.normalizedText)
        .join(" "),
      metadata: {
        ...representative.metadata,
        primarySection: development.primarySection,
        sectionEligibility: development.sectionEligibility,
      },
    }),
    {
      development,
      developmentScore: score,
    },
  );
}

function selectionReasons(item: Item): readonly string[] {
  const payload = workflowPayload(item);
  return (
    payload.researchScore?.selectionReasons ??
    payload.developmentScore?.selectionReasons ??
    ["Selected by the editorial shortlist."]
  );
}

function applyResearchBudget(
  items: readonly Item[],
  policy: BudgetPolicy | undefined,
): Item[] {
  if (policy === undefined) return [...items];
  const maximumRadar = policy.state === "hard_stop"
    ? 0
    : policy.state === "degraded"
      ? 1
      : READER_PROFILE.sectionBudgets.researchRadar;
  const maximumFeatured = READER_PROFILE.sectionBudgets.featuredResearch;
  let researchIndex = 0;
  return items.flatMap((item) => {
    if (item.kind !== "paper" && item.kind !== "blog") return [item];
    const tier = researchIndex < maximumFeatured ? "featured" : "radar";
    researchIndex += 1;
    if (researchIndex > maximumFeatured + maximumRadar) return [];
    return [withWorkflowPayload(item, { researchTier: tier })];
  });
}

function isOptionalRadar(item: Item): boolean {
  if (item.metadata.section === "research_radar") return true;
  const workflow = WorkflowItemPayloadSchema.safeParse(item.metadata.workflow);
  return workflow.success && workflow.data.researchTier === "radar";
}

function providerEligibleItems(
  items: readonly Item[],
  policy: BudgetPolicy | undefined,
): readonly Item[] {
  return policy?.state === "hard_stop"
    ? items.filter((item) => !isOptionalRadar(item))
    : items;
}

function isRawCollectedCandidate(
  candidate: CollectedCandidate,
): candidate is RawNewsCandidate | RawResearchCandidate {
  return "sourceId" in candidate && "retrievedAt" in candidate;
}

export function createProductionPipelineContext(
  options: ProductionPipelineContextOptions,
): PipelineContext {
  return {
    editionDate: options.editionDate,
    runId: options.runId,
    store: options.store,
    now: options.now,
    collect: async () =>
      z.array(CollectedCandidateSchema).parse(
        (await options.collectCandidates()).map((candidate) =>
          isRawCollectedCandidate(candidate)
            ? durableCollectedCandidate(candidate)
            : candidate,
        ),
      ),
    normalize: async (candidates) => {
      const normalized = candidates.map(normalizedCandidate);
      return deduplicateItems(normalized).items.map((item) =>
        withWorkflowPayload(item, {}),
      );
    },
    ...(options.persistItems === undefined
      ? {}
      : { persistItems: options.persistItems }),
    enrich: async (items) => {
      const budgetedItems = applyResearchBudget(items, options.budgetPolicy);
      if (budgetedItems.length === 0) return [];
      const profileTexts = profileEmbeddingTexts();
      const vectors = z.array(
        z.array(z.number().finite()).min(1).max(4_096),
      ).length(budgetedItems.length + profileTexts.length).parse(
        await options.providers.summary.embed([
          ...budgetedItems.map(itemEmbeddingText),
          ...profileTexts,
        ]),
      );
      const dimension = vectors[0]?.length;
      if (
        dimension === undefined ||
        vectors.some((vector) => vector.length !== dimension)
      ) {
        throw new Error("INVALID_EMBEDDING_BATCH");
      }
      const profileVectors = vectors.slice(budgetedItems.length);
      return budgetedItems.map((candidate, index) => {
        const item = WorkflowItemSchema.parse(candidate);
        const embedding = vectors[index];
        if (embedding === undefined) throw new Error("MISSING_ITEM_EMBEDDING");
        const relevance = Math.max(
          0,
          ...profileVectors.map((profileVector) =>
            cosineSimilarity(embedding, profileVector),
          ),
        );
        return withWorkflowPayload(
          item,
          item.kind === "paper" || item.kind === "blog"
            ? { embedding, topicalFit: relevance }
            : { embedding, personalRelevance: relevance },
        );
      });
    },
    prefilter: async (items) => items
      .map((item) => WorkflowItemSchema.parse(item))
      .filter((item) => {
        if (item.normalizedText.trim().length === 0) return false;
        if (item.kind !== "paper" && item.kind !== "blog") return true;
        const topicalFit = workflowPayload(item).topicalFit;
        return (
          topicalFit !== undefined &&
          topicalFit >=
            READER_PROFILE.researchQualityGates.minimumTopicalFit
        );
      }),
    assess: async (items) => Promise.all(
      providerEligibleItems(items, options.budgetPolicy).map(async (candidate) => {
      const item = WorkflowItemSchema.parse(candidate);
      if (item.kind !== "paper" && item.kind !== "blog") return item;
      const rawResearch = workflowPayload(item).rawResearch;
      if (rawResearch === undefined) {
        throw new Error(`MISSING_RAW_RESEARCH:${item.id}`);
      }
      const assessment = await assessResearch(
        rawResearch,
        options.providers.assessment,
      );
      return withWorkflowPayload(item, { assessment });
    })),
    score: async (items) => items.map((candidate) => {
      const item = WorkflowItemSchema.parse(candidate);
      const payload = workflowPayload(item);
      if (item.kind === "paper" || item.kind === "blog") {
        const rawResearch = payload.rawResearch;
        const assessment = payload.assessment;
        if (rawResearch === undefined || assessment === undefined) {
          throw new Error(`MISSING_RESEARCH_ASSESSMENT:${item.id}`);
        }
        const citationSignal =
          rawResearch.citationCount === null
            ? null
            : Math.min(1, Math.log1p(rawResearch.citationCount) / Math.log(101));
        const researchScore = scoreResearch({
          itemId: item.id,
          topicalFit: payload.topicalFit ?? 0,
          technicalQuality: null,
          researchSignal: Math.min(
            1,
            0.5 + rawResearch.preferredInstitutionMatches.length * 0.15,
          ),
          novelty: null,
          seriousAttention: citationSignal,
          assessment,
        });
        return withWorkflowPayload(item, { researchScore });
      }
      const signals = editorialSignals(item);
      const section = newsSection(item);
      const newsScore = scoreNews({
        itemId: item.id,
        publicImportance: newsImportance(section),
        personalRelevance: payload.personalRelevance ?? 0,
        sourceQuality: sourceQuality(item),
        recency: recency(item, options.now()),
        geography:
          section === "dmv" || section === "baltimore" ? 1 : 0.25,
        novelty: 0.7,
        evidence: signals.map((signal) => ({
          sourceId: signal.sourceId,
          role: signal.sourceRole,
          accessLevel: signal.accessLevel,
          provenanceUrl: signal.sourceUrl,
          canCorroborateFacts: signal.canCorroborateFacts,
        })),
      });
      return withWorkflowPayload(item, { newsScore });
    }),
    cluster: async (items) => {
      const parsed = items.map((item) => WorkflowItemSchema.parse(item));
      const research = parsed.filter(
        (item) => item.kind === "paper" || item.kind === "blog",
      );
      const news = parsed.filter(
        (item) => item.kind !== "paper" && item.kind !== "blog",
      );
      const embeddings = Object.fromEntries(news.map((item) => [
        item.id,
        workflowPayload(item).embedding ?? [],
      ]));
      const byId = new Map(news.map((item) => [item.id, item]));
      const developments = clusterNews(news, embeddings);
      const developmentItems = developments.map((development) => {
        const scores = development.itemIds.map((itemId) => {
          const item = byId.get(itemId);
          if (item === undefined) throw new Error(`MISSING_CLUSTER_ITEM:${itemId}`);
          return NewsScoreSchema.parse(workflowPayload(item).newsScore);
        });
        const developmentScore = scoreNewsDevelopment(development, {
          publicImportance: averageNewsComponent(scores, "publicImportance"),
          personalRelevance: averageNewsComponent(scores, "personalRelevance"),
          sourceQuality: averageNewsComponent(scores, "sourceQuality"),
          recency: averageNewsComponent(scores, "recency"),
          geography: averageNewsComponent(scores, "geography"),
          novelty: averageNewsComponent(scores, "novelty"),
        });
        return itemFromDevelopment(development, developmentScore);
      });
      return [...research, ...developmentItems];
    },
    shortlist: async (items) => {
      const parsed = items.map((item) => WorkflowItemSchema.parse(item));
      const candidates = parsed.map((item) =>
        item.kind === "paper" || item.kind === "blog"
          ? item
          : NewsDevelopmentSchema.parse(workflowPayload(item).development),
      );
      const scores = parsed.map((item): ItemScore | NewsScore =>
        item.kind === "paper" || item.kind === "blog"
          ? ItemScoreSchema.parse(workflowPayload(item).researchScore)
          : NewsScoreSchema.parse(workflowPayload(item).developmentScore),
      );
      const preferences: ShortlistPreferences = {
        researchTopics: READER_PROFILE.researchTopics.map(({ id }) => id),
        researchQualityGates: {
          ...READER_PROFILE.researchQualityGates,
        },
      };
      const budgets: SectionBudgets = {
        ...READER_PROFILE.sectionBudgets,
        researchRadar: options.budgetPolicy?.state === "hard_stop"
          ? 0
          : options.budgetPolicy?.state === "degraded"
            ? Math.min(1, READER_PROFILE.sectionBudgets.researchRadar)
            : READER_PROFILE.sectionBudgets.researchRadar,
      };
      const selected = selectShortlist(
        candidates,
        scores,
        preferences,
        budgets,
      );
      const morning = selected.morningBrief.map((candidate) =>
        "representativeItem" in candidate
          ? { id: candidate.id, section: candidate.primarySection }
          : { id: candidate.id, section: "research" as const }
      );
      const morningIds = new Set(morning.map(({ id }) => id));
      const radar = selected.researchRadar
        .filter((item) => !morningIds.has(item.id))
        .slice(0, Math.min(
          budgets.researchRadar,
          Math.max(0, READER_PROFILE.sectionBudgets.morningBrief - morning.length),
        ))
        .map((item) => ({ id: item.id, section: "research_radar" as const }));
      const ordered = [...morning, ...radar];
      const byId = new Map(parsed.map((item) => [item.id, item]));
      return ordered.map(({ id, section }) => {
        const item = byId.get(id);
        if (item === undefined) throw new Error(`MISSING_SHORTLIST_ITEM:${id}`);
        const reasons = [...selectionReasons(item)];
        return withWorkflowPayload(
          item,
          {
            section,
            selectionReasons: reasons,
            ...(item.kind === "paper" || item.kind === "blog"
              ? {
                  researchTier:
                    section === "research_radar" ? "radar" : "featured",
                }
              : {}),
          },
          { section },
        );
      });
    },
    synthesize: async (items) => {
      const summaries = await Promise.all(
        providerEligibleItems(items, options.budgetPolicy).map(async (candidate) => {
        const item = WorkflowItemSchema.parse(candidate);
        try {
          return {
            item,
            summary: await summarizeItem(
              packet(item),
              options.providers.summary,
              options.budgetPolicy === undefined
                ? {}
                : {
                    maxOutputTokens:
                      isOptionalRadar(item)
                        ? options.budgetPolicy.radarSummaryTokens
                        : options.budgetPolicy.featuredSummaryTokens,
                  },
            ),
          };
        } catch (error) {
          if (error instanceof SummaryRejectedError) return null;
          throw error;
        }
      }));
      return summaries.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      );
    },
    validate: async (entries) => entries.map((entry) => {
      const parsedSummary = StructuredSummarySchema.strict().safeParse(
        entry.summary,
      );
      const sourceIds = new Set(entry.item.sourceRefs.map(({ id }) => id));
      const validationErrors = parsedSummary.success
        ? [
            ...new Set(
              parsedSummary.data.claims.flatMap((claim) =>
                claim.sourceIds
                  .filter((sourceId) => !sourceIds.has(sourceId))
                  .map((sourceId) =>
                    `UNKNOWN_ITEM_SOURCE:${
                      encodeURIComponent(sourceId).slice(0, 160)
                    }`
                  ),
              ),
            ),
          ]
        : ["SCHEMA_INVALID"];
      return {
        ...entry,
        valid: validationErrors.length === 0,
        ...(validationErrors.length === 0 ? {} : { validationErrors }),
      };
    }),
    ...(options.sourceFailures === undefined
      ? {}
      : { sourceFailures: options.sourceFailures }),
    ...(options.checkpointExecutor === undefined
      ? {}
      : { checkpointExecutor: options.checkpointExecutor }),
    ...(options.budgetPolicy === undefined
      ? {}
      : { budgetPolicy: options.budgetPolicy }),
  };
}

function catalogSourceInput(
  source: Awaited<ReturnType<D1BriefingRepository["listSources"]>>[number],
): ResearchSourceInput {
  return {
    id: source.id,
    canonicalName: source.canonicalName,
    canonicalUrl: source.canonicalUrl,
    role: source.role,
    enabled: source.enabled,
    sectionEligibility: [...source.sectionEligibility],
    restrictions: source.restrictions,
  };
}

export function createD1ProductionPipelineContext(
  store: D1PipelineStore,
  editionDate: string,
  runId: string,
  providers: PipelineProviders,
  options: Pick<ProductionPipelineContextOptions, "checkpointExecutor" | "budgetPolicy"> = {},
): PipelineContext {
  const now = () => new Date().toISOString();
  return createProductionPipelineContext({
    editionDate,
    runId,
    store,
    now,
    providers,
    ...options,
    persistItems: async (items) => store.repository.upsertItems(items),
    collectCandidates: async () => {
      const sources = await store.repository.listSources();
      const source = (id: string) => {
        const match = sources.find((candidate) => candidate.id === id);
        if (match === undefined) throw new Error(`MISSING_CATALOG_SOURCE:${id}`);
        return catalogSourceInput(match);
      };
      const http = new SourceHttpClient();
      const newsCollector = createNewsCollectorFromCatalog({ http, sources });
      const researchCollector = new ResearchCollector({
        discoveryAdapters: [new ArxivAdapter(http, source("arxiv"))],
        enrichers: [
          new SemanticScholarAdapter(http, source("semantic-scholar")),
          new OpenAlexAdapter(http, source("openalex")),
        ],
        preferredInstitutions: READER_PROFILE.preferredInstitutions,
        preferredLabs: READER_PROFILE.preferredLabs,
      });
      const to = now();
      const from = new Date(
        Date.parse(to) - 36 * 60 * 60 * 1_000,
      ).toISOString();
      const [news, research] = await Promise.all([
        newsCollector.collect({ from, to }),
        researchCollector.collect({ from, to }),
      ]);
      return [
        ...research.map((candidate) =>
          RawResearchCandidateSchema.parse(candidate),
        ),
        ...news.map((candidate) => RawNewsCandidateSchema.parse(candidate)),
      ];
    },
  });
}

export function createD1WorkflowLauncher(
  db: D1Database,
  runtimeSource: PipelineProviders | PipelineRuntimeFactory,
): {
  start(input: { editionDate: string; actorEmail?: string }): Promise<{ runId: string }>;
  resume(input: { runId: string; actorEmail?: string }): Promise<void>;
} {
  const store = new D1PipelineStore(db);
  const runtime = async (runId: string, editionDate: string): Promise<PipelineRuntime> =>
    typeof runtimeSource === "function"
      ? runtimeSource({ runId, editionDate })
      : { providers: runtimeSource };
  return {
    async start(input) {
      const runId = crypto.randomUUID();
      try {
        const configured = await runtime(runId, input.editionDate);
        await runEditorialPipeline(createD1ProductionPipelineContext(
          store,
          input.editionDate,
          runId,
          configured.providers,
          configured.budgetPolicy === undefined
            ? {}
            : { budgetPolicy: configured.budgetPolicy },
        ));
      } catch (error) {
        await store.audit(
          error instanceof WorkflowRunAlreadyExistsError ? null : runId,
          "manual_run_started",
          input.actorEmail,
        );
        if (error instanceof WorkflowRunAlreadyExistsError) throw error;
        return { runId };
      }
      try {
        await store.audit(runId, "manual_run_started", input.actorEmail);
      } catch (error) {
        throw error;
      }
      return { runId };
    },
    async resume(input) {
      const run = await store.getRun(input.runId);
      if (run === null || !run.retryable || (run.status !== "retryable" && run.status !== "partial" && run.status !== "failed")) {
        throw new WorkflowResumeUnavailableError();
      }
      await store.audit(run.id, "manual_run_resumed", input.actorEmail);
      const configured = await runtime(run.id, run.editionDate);
      await runEditorialPipeline(createD1ProductionPipelineContext(
        store,
        run.editionDate,
        run.id,
        configured.providers,
        configured.budgetPolicy === undefined
          ? {}
          : { budgetPolicy: configured.budgetPolicy },
      ));
    },
  };
}

function countOutput(value: unknown): number {
  return Array.isArray(value) ? value.length : 1;
}

function result(
  runId: string,
  status: PipelineStatus,
  missingSections: readonly string[] = [],
): PipelineResult {
  if (status === "retryable") throw new Error("A retryable run cannot be returned as a pipeline result.");
  return { runId, status, missingSections };
}

async function currentRun(context: PipelineContext): Promise<PipelineRun> {
  const existing = await context.store.getRun(context.runId);
  if (existing !== null) return existing;
  const now = context.now();
  const run: PipelineRun = {
    id: context.runId,
    editionDate: context.editionDate,
    status: "pending",
    currentStep: null,
    retryable: false,
    attemptCount: 0,
    estimatedCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    failureCode: null,
  };
  await context.store.createRun(run);
  return run;
}

async function checkpoint<T>(
  context: PipelineContext,
  run: PipelineRun,
  step: (typeof PIPELINE_STEPS)[number],
  outputSchema: z.ZodType<T, z.ZodTypeDef, unknown>,
  execute: () => Promise<unknown>,
  beforeSave?: (output: T) => Promise<void>,
): Promise<T> {
  const executeCheckpoint = async (): Promise<T> => {
    // Reconcile inside the retried Workflow operation so a retry after the
    // checkpoint write cannot repeat external/provider work.
    const storedBefore = await context.store.getRun(context.runId) ?? run;
    const completed = await context.store.readCheckpoint(context.runId, step);
    if (completed) {
      const artifact = await context.store.readArtifact(context.runId, step);
      if (artifact === null) throw new Error(`MISSING_CHECKPOINT_ARTIFACT:${step}`);
      const storedStepIndex = storedBefore.currentStep === null
        ? -1
        : PIPELINE_STEPS.indexOf(storedBefore.currentStep);
      if (storedStepIndex < PIPELINE_STEPS.indexOf(step)) {
        await context.store.saveRun({
          ...storedBefore,
          status: "running",
          currentStep: step,
          retryable: false,
          estimatedCostUsd:
            storedBefore.estimatedCostUsd + artifact.estimatedCostUsd,
          updatedAt: context.now(),
          failureCode: null,
        });
      }
      return outputSchema.parse(artifact.output);
    }
    const attempt = await context.store.beginAttempt(context.runId, step);
    const startedAt = Date.parse(context.now());
    let output: T;
    try {
      output = outputSchema.parse(await execute());
      await beforeSave?.(output);
    } catch (error) {
      await context.store.failAttempt(context.runId, step, attempt, error instanceof Error ? error.message : "PIPELINE_FAILED");
      throw error;
    }
    const estimatedCostUsd = context.estimateCostUsd?.(step, output) ?? 0;
    const artifact: CheckpointArtifact<T> = {
      output,
      attempts: attempt,
      durationMs: Math.max(0, Date.parse(context.now()) - startedAt),
      itemCount: countOutput(output),
      estimatedCostUsd,
    };
    await context.store.saveCheckpoint(context.runId, step, artifact);
    const storedRun = await context.store.getRun(context.runId) ?? run;
    await context.store.saveRun({
      ...storedRun,
      status: "running",
      currentStep: step,
      retryable: false,
      estimatedCostUsd: storedRun.estimatedCostUsd + estimatedCostUsd,
      updatedAt: context.now(),
      failureCode: null,
    });
    return output;
  };
  return context.checkpointExecutor === undefined
    ? executeCheckpoint()
    : context.checkpointExecutor(step, executeCheckpoint);
}

export async function runEditorialPipeline(
  context: PipelineContext,
): Promise<PipelineResult> {
  let run = await currentRun(context);
  if (run.status === "published" || (run.status === "failed" && !run.retryable)) {
    return result(context.runId, run.status);
  }
  if (run.status === "partial" && run.retryable) {
    await context.store.invalidateFrom(context.runId, "collect");
  }
  run = {
    ...run,
    status: "running",
    retryable: false,
    attemptCount: run.attemptCount + 1,
    updatedAt: context.now(),
    failureCode: null,
  };
  await context.store.saveRun(run);

  try {
    const collected = await checkpoint(
      context, run, "collect", CollectedCandidatesSchema, context.collect,
    );
    const normalized = await checkpoint(
      context, run, "normalize", NormalizedItemsSchema,
      () => context.normalize(collected),
      context.persistItems,
    );
    const enriched = await checkpoint(
      context, run, "enrich", EnrichedItemsSchema,
      () => context.enrich(normalized),
    );
    const prefilted = await checkpoint(
      context, run, "prefilter", PrefilteredItemsSchema,
      () => context.prefilter(enriched),
    );
    const assessed = await checkpoint(
      context, run, "assess", AssessedItemsSchema,
      () => context.assess(prefilted),
    );
    const scored = await checkpoint(
      context, run, "score", ScoredItemsSchema,
      () => context.score(assessed),
    );
    const clustered = await checkpoint(
      context, run, "cluster", ClusteredItemsSchema,
      () => context.cluster(scored),
    );
    const shortlisted = await checkpoint(
      context, run, "shortlist", ShortlistedItemsSchema,
      () => context.shortlist(clustered),
    );
    const synthesized = await checkpoint(
      context, run, "synthesize", SummaryCandidatesSchema,
      () => context.synthesize(shortlisted),
    );
    const validated = await checkpoint(
      context, run, "validate", ValidatedSummaryCandidatesSchema,
      () => context.validate(synthesized),
    );
    const composition = await checkpoint(
      context, run, "compose", CompositionSchema,
      () => composeEdition(context, validated, normalized),
    );
    await checkpoint(
      context, run, "publish", CompositionSchema,
      () => publishEdition(context, composition),
    );
    const finalRun = {
      ...(await context.store.getRun(context.runId) ?? run),
      status: composition.status,
      currentStep: "publish" as const,
      retryable: composition.status === "partial",
      updatedAt: context.now(),
      failureCode: composition.status === "failed" ? "MINIMUM_COVERAGE_FAILED" : null,
    };
    await context.store.saveRun(finalRun);
    return result(context.runId, composition.status, composition.missingSections);
  } catch (error) {
    const failureCode = error instanceof Error ? error.message.slice(0, 200) : "PIPELINE_FAILED";
    await context.store.saveRun({
      ...(await context.store.getRun(context.runId) ?? run),
      status: "retryable",
      retryable: true,
      failureCode,
      updatedAt: context.now(),
    });
    throw error;
  }
}
