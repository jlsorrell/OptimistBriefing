import { composeEdition } from "./compose-edition";
import { publishEdition } from "./publish-edition";
import { D1BriefingRepository } from "../db/d1-repository";
import {
  approvedBaselinePreferences,
  ReaderPreferencesSchema,
  type BriefingRepository,
  type ReaderPreferences,
} from "../db/repository";
import { z } from "zod";
import { SourceHttpClient } from "../sources/http-client";
import { createNewsCollectorFromCatalog } from "../sources/news-collector";
import { createPublicationCollectorFromCatalog } from "../sources/publication-collector";
import {
  boundedSourceFailureLabels,
  boundedSourceFailureMetadata,
} from "../sources/collection-settlement";
import { durableCollectedCandidate } from "../sources/durable-evidence";
import {
  InvalidPreparedCandidateTextError,
  isPreparedRawCandidate,
  markPreparedRawCandidate,
  normalizePreparedAuthorKey,
  normalizePreparedTitleKey,
  normalizePreparedCandidate,
  prepareRawCandidateForPipeline,
} from "../editorial/normalize";
import { deriveNewsSignals } from "../sources/news-signals";
import { routePublication } from "../editorial/route-publication";
import {
  deduplicateItems,
  type ItemMergeGroup,
} from "../editorial/deduplicate";
import {
  canonicalResearchIdentity,
  consolidateResearchCandidates,
} from "../editorial/research-identity";
import {
  boundResearchDiscoveryPool,
  classifyDiscoveryWindowDecision,
  researchFingerprints,
  triageResearch,
} from "../editorial/research-triage";
import {
  CONFIGURED_RESEARCH_TOPIC_IDS,
  mapResearchTopicIds,
} from "../editorial/research-topics";
import {
  summarizeItem,
  SummaryRejectedError,
} from "../editorial/summarize";
import { canonicalSummaryRejectionCodes } from "../editorial/summary-rejection-code";
import { claimEvidenceMatchesAllSources } from "../editorial/validate-summary";
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
  developmentFromItems,
  NewsDevelopmentSchema,
  type NewsDevelopment,
} from "../editorial/cluster";
import {
  shortlist as selectShortlist,
  type SectionBudgets,
  type ShortlistPreferences,
} from "../editorial/shortlist";
import { APPROVED_SECTION_MAXIMA } from "../editorial/shortlist";
import { editorialSignals } from "../editorial/editorial-signals";
import { READER_PROFILE } from "../config/reader-profile";
import { createPaperDiscoveryAdapters } from "../sources/paper-discovery";
import { SemanticScholarAdapter } from "../sources/semantic-scholar";
import { OpenAlexAdapter } from "../sources/openalex";
import { ResearchCollector } from "../sources/research-collector";
import {
  normalizeProviderText,
  truncateProviderTextAtCodePointBoundary,
} from "../sources/provider-text";
import {
  MAX_PROVIDER_ARRAY_ITEMS,
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  MAX_PROVIDER_TITLE_CHARACTERS,
  RawNewsCandidateSchema,
  RawPublicationCandidateSchema,
  RawResearchCandidateSchema,
  DiscoveryFamilySchema,
  DiscoveryDiagnosticsStateSchema,
  DiscoveryLaneDiagnosticSchema,
  type RawNewsCandidate,
  type RawPublicationCandidate,
  type RawResearchCandidate,
  type DiscoveryFamily,
  type DiscoveryDiagnosticsState,
  type DiscoveryLaneDiagnostic,
  type DiscoveryObservation,
  type DiscoveryRejectionReason,
  type ResearchSourceInput,
} from "../sources/types";
import {
  EditionEntrySchema,
  EditionMetadataSchema,
  EditionSchema,
  EditionSectionSchema,
  ItemScoreSchema,
  ItemSchema,
  StructuredSummarySchema,
  type EditionSection,
  type Item,
  type ItemScore,
  type ResearchAssessment,
  type StructuredSummary,
} from "../contracts/editorial";
import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
} from "../contracts/editorial";
import {
  PIPELINE_STEPS,
  PROVIDER_TEXT_NORMALIZATION_VERSION,
  PROVIDER_TEXT_PREPARATION_VERSION,
  CollectedCandidateSchema,
  SummaryRejectionEventSchema,
  WorkflowItemPayloadSchema,
  WorkflowItemSchema,
  type CheckpointArtifact,
  type CollectedCandidate,
  type PipelineContext,
  type PipelineResult,
  type PipelineRun,
  type PipelineStep,
  type PipelineStore,
  type PipelineStatus,
  type SummaryRejectionEvent,
  type WorkflowItemPayload,
} from "./types";
import type { BudgetPolicy } from "../models/cost-ledger";
import { sourcePacketForItem } from "./source-packet";
import {
  DiscoveryDiagnosticsTracker,
  type DiscoveryDiagnosticRef,
} from "./discovery-diagnostics";

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
          stage === "score"
        ) {
          if (research && payload.embedding !== undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `Production ${stage} artifacts forbid research embedding.`,
              path: [index, "metadata", "workflow", "embedding"],
            });
          }
          if (!research) {
            requireField(payload.embedding !== undefined, "embedding");
          }
        } else if (
          research &&
          (stage === "cluster" || stage === "shortlist") &&
          payload.embedding !== undefined
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Production ${stage} artifacts forbid research embedding.`,
            path: [index, "metadata", "workflow", "embedding"],
          });
        }
        if (
          stage === "enrich" ||
          stage === "prefilter" ||
          stage === "assess" ||
          stage === "score" ||
          stage === "cluster" ||
          stage === "shortlist"
        ) {
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
const CollectionSourceFailuresSchema = z.array(CheckpointStringSchema).max(64);
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

async function summaryRejectionAuditId(
  runId: string,
  itemId: string,
): Promise<string> {
  const canonical = `${runId.length}:${runId}${itemId.length}:${itemId}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `summary_rejected:${hash}`;
}

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
export const MAX_D1_CHECKPOINT_EVENT_BYTES = 1_500_000;
const MAX_CHECKPOINT_CHUNKS = 1_000;
const ARTIFACT_KEYS = new Set([
  "output",
  "attempts",
  "durationMs",
  "itemCount",
  "estimatedCostUsd",
  "providerTextNormalizationVersion",
  "providerTextPreparationVersion",
]);
const REQUIRED_ARTIFACT_KEYS = [
  "output",
  "attempts",
  "durationMs",
  "itemCount",
  "estimatedCostUsd",
] as const;

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
    REQUIRED_ARTIFACT_KEYS.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !ARTIFACT_KEYS.has(key))
  ) {
    throw new TypeError("Checkpoint artifact has unknown or missing fields.");
  }
  const providerTextNormalizationVersion =
    record.providerTextNormalizationVersion === undefined
      ? undefined
      : z.literal(PROVIDER_TEXT_NORMALIZATION_VERSION).parse(
          record.providerTextNormalizationVersion,
        );
  const providerTextPreparationVersion =
    record.providerTextPreparationVersion === undefined
      ? undefined
      : z.literal(PROVIDER_TEXT_PREPARATION_VERSION).parse(
          record.providerTextPreparationVersion,
        );
  if (step === "collect" && providerTextNormalizationVersion !== undefined) {
    throw new TypeError(
      "Collect checkpoint artifacts cannot be marked provider-text normalized.",
    );
  }
  if (step !== "collect" && providerTextPreparationVersion !== undefined) {
    throw new TypeError(
      "Only collect checkpoint artifacts can be marked provider-text prepared.",
    );
  }
  return {
    output: checkpointOutputSchema(step).parse(record.output),
    attempts: ArtifactAttemptsSchema.parse(record.attempts),
    durationMs: ArtifactDurationSchema.parse(record.durationMs),
    itemCount: ArtifactItemCountSchema.parse(record.itemCount),
    estimatedCostUsd: ArtifactCostSchema.parse(record.estimatedCostUsd),
    ...(providerTextNormalizationVersion === undefined
      ? {}
      : { providerTextNormalizationVersion }),
    ...(providerTextPreparationVersion === undefined
      ? {}
      : { providerTextPreparationVersion }),
  };
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function checkpointEventJson(
  step: (typeof PIPELINE_STEPS)[number],
  checkpointId: string,
  chunkIndex: number,
  chunkCount: number,
  artifact: CheckpointArtifact<unknown>,
  output: unknown,
): string {
  return JSON.stringify({
    step,
    checkpointId,
    chunkIndex,
    chunkCount,
    artifact: { ...artifact, output },
  });
}

function serializedCheckpointEvents(
  step: (typeof PIPELINE_STEPS)[number],
  artifact: CheckpointArtifact<unknown>,
  checkpointId: string,
): string[] {
  if (!Array.isArray(artifact.output)) {
    const event = checkpointEventJson(
      step,
      checkpointId,
      0,
      1,
      artifact,
      artifact.output,
    );
    if (encodedBytes(event) > MAX_D1_CHECKPOINT_EVENT_BYTES) {
      throw new Error(`CHECKPOINT_VALUE_TOO_LARGE:${step}`);
    }
    return [event];
  }

  const chunks: unknown[][] = [];
  let current: unknown[] = [];
  for (const entry of artifact.output) {
    const candidate = [...current, entry];
    const candidateEvent = checkpointEventJson(
      step,
      checkpointId,
      MAX_CHECKPOINT_CHUNKS - 1,
      MAX_CHECKPOINT_CHUNKS,
      artifact,
      candidate,
    );
    if (
      current.length > 0 &&
      encodedBytes(candidateEvent) > MAX_D1_CHECKPOINT_EVENT_BYTES
    ) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
    const singleEntryEvent = checkpointEventJson(
      step,
      checkpointId,
      MAX_CHECKPOINT_CHUNKS - 1,
      MAX_CHECKPOINT_CHUNKS,
      artifact,
      current,
    );
    if (encodedBytes(singleEntryEvent) > MAX_D1_CHECKPOINT_EVENT_BYTES) {
      throw new Error(`CHECKPOINT_ITEM_TOO_LARGE:${step}`);
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  if (chunks.length > MAX_CHECKPOINT_CHUNKS) {
    throw new Error(`CHECKPOINT_CHUNK_LIMIT_EXCEEDED:${step}`);
  }
  return chunks.map((chunk, chunkIndex) => {
    const event = checkpointEventJson(
      step,
      checkpointId,
      chunkIndex,
      chunks.length,
      artifact,
      chunk,
    );
    if (encodedBytes(event) > MAX_D1_CHECKPOINT_EVENT_BYTES) {
      throw new Error(`CHECKPOINT_VALUE_TOO_LARGE:${step}`);
    }
    return event;
  });
}

type CheckpointChunkRecord = {
  checkpointId: string;
  chunkIndex: number;
  chunkCount: number;
  artifact: unknown;
};

function checkpointChunkRecord(
  value: Record<string, unknown>,
): CheckpointChunkRecord | null {
  if (
    typeof value.checkpointId !== "string" ||
    value.checkpointId.length === 0 ||
    typeof value.chunkIndex !== "number" ||
    !Number.isInteger(value.chunkIndex) ||
    value.chunkIndex < 0 ||
    typeof value.chunkCount !== "number" ||
    !Number.isInteger(value.chunkCount) ||
    value.chunkCount < 1 ||
    value.chunkCount > MAX_CHECKPOINT_CHUNKS ||
    value.chunkIndex >= value.chunkCount
  ) return null;
  return {
    checkpointId: value.checkpointId,
    chunkIndex: value.chunkIndex,
    chunkCount: value.chunkCount,
    artifact: value.artifact,
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

  async readPreferenceSnapshot(
    runId: string,
  ): Promise<ReaderPreferences | null> {
    const record = await this.db.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ).bind(runId, "preference_snapshot").first<{ event_json: string }>();
    if (record === null) return null;
    try {
      return ReaderPreferencesSchema.parse(JSON.parse(record.event_json));
    } catch {
      return defaultReaderPreferences();
    }
  }

  async savePreferenceSnapshot(
    runId: string,
    preferences: ReaderPreferences,
  ): Promise<void> {
    const validPreferences = ReaderPreferencesSchema.parse(preferences);
    await this.db.prepare(
      `INSERT OR IGNORE INTO audit_events (
        id, run_id, event_type, event_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      `preference_snapshot:${runId}`,
      runId,
      "preference_snapshot",
      JSON.stringify(validPreferences),
      new Date().toISOString(),
    ).run();
  }

  async recordSummaryRejection(
    runId: string,
    itemId: string,
    event: SummaryRejectionEvent,
  ): Promise<void> {
    const valid = SummaryRejectionEventSchema.parse({
      ...event,
      errors: canonicalSummaryRejectionCodes(event.errors),
    });
    const id = await summaryRejectionAuditId(runId, itemId);
    await this.db.prepare(
      `INSERT OR IGNORE INTO audit_events (
        id, run_id, event_type, event_json, created_at
      ) VALUES (?, ?, 'summary_rejected', ?, ?)`,
    ).bind(
      id,
      runId,
      JSON.stringify(valid),
      valid.createdAt,
    ).run();
  }

  async readCollectionSourceFailures(runId: string): Promise<string[]> {
    const record = await this.db.prepare(
      `SELECT event_json FROM audit_events
       WHERE id = ? AND run_id = ? AND event_type = ?
       LIMIT 1`,
    ).bind(
      `collection_source_failures:${runId}`,
      runId,
      "collection_source_failures",
    ).first<{ event_json: string }>();
    if (record === null) return [];
    try {
      return CollectionSourceFailuresSchema.parse(JSON.parse(record.event_json));
    } catch {
      return [];
    }
  }

  async saveCollectionSourceFailures(
    runId: string,
    sourceFailures: readonly string[],
  ): Promise<void> {
    const valid = CollectionSourceFailuresSchema.parse(
      boundedSourceFailureMetadata(sourceFailures),
    );
    await this.db.prepare(
      `INSERT INTO audit_events (
        id, run_id, event_type, event_json, created_at
      ) SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM workflow_runs WHERE id = ?)
      ON CONFLICT(id) DO UPDATE SET
        event_json = excluded.event_json,
        created_at = excluded.created_at
      WHERE audit_events.run_id = excluded.run_id
        AND audit_events.event_type = excluded.event_type`,
    ).bind(
      `collection_source_failures:${runId}`,
      runId,
      "collection_source_failures",
      JSON.stringify(valid),
      new Date().toISOString(),
      runId,
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
    const checkpointId = crypto.randomUUID();
    const events = serializedCheckpointEvents(
      step,
      validArtifact,
      checkpointId,
    );
    const createdAt = new Date().toISOString();
    await this.db.batch(events.map((eventJson, chunkIndex) =>
      this.db.prepare(
        `INSERT INTO audit_events (
          id, run_id, event_type, event_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        `${checkpointId}:${chunkIndex}`,
        runId,
        "workflow_checkpoint",
        eventJson,
        createdAt,
      )
    ));
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
       WHERE run_id = ?
         AND event_type = ?
         AND json_valid(event_json) = 1
         AND json_extract(event_json, '$.step') = ?
       ORDER BY created_at DESC, id DESC`,
    ).bind(
      runId,
      "workflow_checkpoint",
      step,
    ).all<{ event_json: string }>();
    const groups = new Map<string, {
      chunkCount: number;
      chunks: Map<number, unknown>;
    }>();
    for (const record of records.results) {
      let parsed: Record<string, unknown>;
      try {
        const value = JSON.parse(record.event_json) as unknown;
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("Checkpoint event must be an object.");
        }
        parsed = value as Record<string, unknown>;
      } catch (error) {
        throw new Error("INVALID_CHECKPOINT_RECORD", { cause: error });
      }
      if (parsed.step !== step) continue;
      const chunk = checkpointChunkRecord(parsed);
      if (chunk !== null) {
        const group = groups.get(chunk.checkpointId) ?? {
          chunkCount: chunk.chunkCount,
          chunks: new Map<number, unknown>(),
        };
        if (
          group.chunkCount !== chunk.chunkCount ||
          group.chunks.has(chunk.chunkIndex)
        ) {
          throw new Error(`INVALID_CHECKPOINT_CHUNKS:${step}`);
        }
        group.chunks.set(chunk.chunkIndex, chunk.artifact);
        groups.set(chunk.checkpointId, group);
        continue;
      }
      try {
        return parseCheckpointArtifact(step, parsed.artifact);
      } catch (error) {
        throw new Error(`INVALID_CHECKPOINT_ARTIFACT:${step}`, {
          cause: error,
        });
      }
    }
    for (const group of groups.values()) {
      if (group.chunks.size !== group.chunkCount) {
        throw new Error(`INCOMPLETE_CHECKPOINT_CHUNKS:${step}`);
      }
      const artifacts = Array.from(
        { length: group.chunkCount },
        (_, chunkIndex) => {
          const chunk = group.chunks.get(chunkIndex);
          if (chunk === undefined) {
            throw new Error(`INCOMPLETE_CHECKPOINT_CHUNKS:${step}`);
          }
          return parseCheckpointArtifact(step, chunk);
        },
      );
      const first = artifacts[0];
      if (first === undefined) {
        throw new Error(`INCOMPLETE_CHECKPOINT_CHUNKS:${step}`);
      }
      if (artifacts.length === 1 && !Array.isArray(first.output)) return first;
      if (artifacts.some(({ output }) => !Array.isArray(output))) {
        throw new Error(`INVALID_CHECKPOINT_CHUNKS:${step}`);
      }
      if (
        artifacts.some(
          (artifact) =>
            artifact.providerTextNormalizationVersion !==
              first.providerTextNormalizationVersion ||
            artifact.providerTextPreparationVersion !==
              first.providerTextPreparationVersion,
        )
      ) {
        throw new Error(`INVALID_CHECKPOINT_CHUNKS:${step}`);
      }
      try {
        return parseCheckpointArtifact(step, {
          ...first,
          output: artifacts.flatMap(({ output }) => output as unknown[]),
        });
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

export function createD1PipelineStore(db: D1Database): D1PipelineStore {
  return new D1PipelineStore(db);
}

export type PipelineProviders = {
  summary: ModelProvider;
  assessment: ModelProvider;
};

export type PipelineRuntime = {
  providers: PipelineProviders;
  budgetPolicy?: BudgetPolicy;
  openAlexApiKey?: string;
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
  preferences?: ReaderPreferences;
  providers: PipelineProviders;
  collectCandidates: () => Promise<readonly CollectedCandidate[]>;
  loadDiscoveryDiagnostics?: () =>
    | readonly DiscoveryLaneDiagnostic[]
    | DiscoveryDiagnosticsState
    | Promise<readonly DiscoveryLaneDiagnostic[] | DiscoveryDiagnosticsState>;
  persistItems?: (items: readonly Item[]) => Promise<void>;
  sourceFailures?: readonly string[];
  loadSourceFailures?: PipelineContext["loadSourceFailures"];
  checkpointExecutor?: PipelineContext["checkpointExecutor"];
  budgetPolicy?: BudgetPolicy;
  openAlexApiKey?: string;
  cleanupTerminalReservations?: PipelineContext["cleanupTerminalReservations"];
  researchRepository?: Pick<
    BriefingRepository,
    | "getDiscoveryObservations"
    | "upsertDiscoveryObservations"
    | "getCachedResearchAssessment"
    | "getCachedResearchTopicalFit"
    | "putCachedResearchAssessment"
  > & Partial<Pick<BriefingRepository, "recordDiscoveryDiagnostics">>;
};

function defaultReaderPreferences(): ReaderPreferences {
  const baseline = approvedBaselinePreferences();
  return ReaderPreferencesSchema.parse({
    ...baseline,
    baseline,
    feedbackHistory: [],
  });
}

function parsedPreferences(
  preferences: ReaderPreferences | undefined,
): ReaderPreferences {
  if (preferences === undefined) return defaultReaderPreferences();
  const parsed = ReaderPreferencesSchema.safeParse(preferences);
  return parsed.success ? parsed.data : defaultReaderPreferences();
}

function effectivePreferenceWeights(
  preferences: ReaderPreferences,
): Pick<ReaderPreferences, "topicWeights" | "sourceWeights"> {
  const weights = {
    topic: {
      ...preferences.baseline.topicWeights,
      ...preferences.topicWeights,
    },
    source: {
      ...preferences.baseline.sourceWeights,
      ...preferences.sourceWeights,
    },
  };
  for (const feedback of preferences.feedbackHistory) {
    for (const adjustment of feedback.adjustments) {
      weights[adjustment.dimension][adjustment.key] =
        adjustment.resultingWeight;
    }
  }
  return {
    topicWeights: weights.topic,
    sourceWeights: weights.source,
  };
}

export async function loadOrCreatePreferenceSnapshot(
  store: D1PipelineStore,
  runId: string,
): Promise<ReaderPreferences> {
  const existing = await store.readPreferenceSnapshot(runId);
  if (existing !== null) return existing;
  let current: ReaderPreferences;
  try {
    current = ReaderPreferencesSchema.parse(
      await store.repository.getPreferences(),
    );
  } catch {
    current = defaultReaderPreferences();
  }
  await store.savePreferenceSnapshot(runId, current);
  const stored = await store.readPreferenceSnapshot(runId);
  if (stored === null) throw new Error("PREFERENCE_SNAPSHOT_NOT_SAVED");
  return stored;
}

export async function ensurePipelineRun(
  store: PipelineStore,
  runId: string,
  editionDate: string,
  now: string,
): Promise<PipelineRun> {
  const existing = await store.getRun(runId);
  if (existing !== null) return existing;
  const run: PipelineRun = {
    id: runId,
    editionDate,
    status: "pending",
    currentStep: null,
    retryable: false,
    attemptCount: 0,
    estimatedCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    failureCode: null,
  };
  try {
    await store.createRun(run);
    return run;
  } catch (error) {
    const accepted = await store.getRun(runId);
    if (accepted !== null) return accepted;
    throw error;
  }
}

function workflowPayload(item: Item): WorkflowItemPayload {
  const {
    providerTextNormalizationVersion: _legacyItemMarker,
    ...payload
  } = WorkflowItemPayloadSchema.parse(item.metadata.workflow);
  return payload;
}

function withoutWorkflowEmbedding(item: Item): Item {
  const { embedding: _embedding, ...workflow } = workflowPayload(item);
  return WorkflowItemSchema.parse({
    ...item,
    metadata: {
      ...item.metadata,
      workflow,
    },
  });
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

function discoveryIdentityHash(value: string): string {
  let first = 2_166_136_261;
  let second = 2_246_822_519;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ point, 16_777_619);
    second = Math.imul(second ^ point, 32_654_599);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function upstreamCandidateIdentity(
  candidate: CollectedCandidate,
  normalizedItemId?: string,
): string {
  if (!isRawCollectedCandidate(candidate)) return `item:${candidate.id}`;
  const sourceLabel = candidate.sourceId.slice(0, 100);
  const upstream = `${sourceLabel}:${discoveryIdentityHash(JSON.stringify([
    candidate.sourceId,
    candidate.externalId,
    candidate.originalUrl,
  ]))}`;
  return normalizedItemId === undefined
    ? `upstream:${upstream}`
    : `item:${normalizedItemId}:${upstream}`;
}

function normalizedCandidate(candidate: CollectedCandidate): Item | null {
  const storedItem = ItemSchema.safeParse(candidate);
  if (storedItem.success) {
    return normalizedStoredWorkflowItem(storedItem.data, true);
  }
  const prepared = isPreparedRawCandidate(candidate)
    ? candidate
    : prepareRawCandidateForPipeline(candidate);
  const publication = RawPublicationCandidateSchema.safeParse(prepared);
  const routed = publication.success
    ? routePublication(publication.data)
    : prepared;
  if (routed === null) return null;
  const research = RawResearchCandidateSchema.safeParse(routed);
  const news = RawNewsCandidateSchema.safeParse(routed);
  if (!research.success && !news.success) return null;
  const routedCandidate: RawResearchCandidate | RawNewsCandidate =
    research.success ? research.data : news.success ? news.data : (() => {
      throw new TypeError("Routed candidate did not match a raw schema.");
    })();
  const preparedRouted = markPreparedRawCandidate(routedCandidate);
  const normalized = normalizePreparedCandidate(preparedRouted);
  const directFamily = DiscoveryFamilySchema.safeParse(
    preparedRouted.metadata.discoveryFamily,
  );
  const discoveryFamily: DiscoveryFamily = directFamily.success
    ? directFamily.data
    : preparedRouted.sourceId === "arxiv"
      ? "arxiv"
      : preparedRouted.sourceRole === "blog" || preparedRouted.kind === "blog"
        ? "commentary"
        : preparedRouted.sourceId === "openalex" ||
            preparedRouted.sourceId === "semantic-scholar"
          ? "bibliographic"
          : "official-publication";
  const discoveryLineage = itemStringArray(
    preparedRouted.metadata.discoveryLaneIds,
  ).slice(0, 64).map((laneId) => JSON.stringify([
    laneId,
    preparedRouted.sourceId,
    discoveryFamily,
    upstreamCandidateIdentity(preparedRouted, normalized.id),
  ]));
  const normalizedWithLineage = ItemSchema.parse({
    ...normalized,
    metadata: {
      ...normalized.metadata,
      discoveryLineage,
    },
  });
  return withWorkflowPayload(
    normalizedWithLineage,
    research.success
      ? {
          rawResearch: compactResearchCandidate(
            normalizedWithLineage,
            research.data,
          ),
        }
      : {},
  );
}

function normalizedStoredDisplay(value: string): string {
  return normalizeProviderText(value, {
    maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
  }) ?? "";
}

function normalizedRequiredStoredTitle(value: string): string {
  const title = normalizeProviderText(value, {
    maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
  });
  if (title === null) {
    throw new InvalidPreparedCandidateTextError("title");
  }
  return title;
}

function normalizedStoredArray(value: unknown): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of itemStringArray(value)) {
    const display = normalizedStoredDisplay(entry);
    if (display.length === 0 || seen.has(display)) continue;
    seen.add(display);
    normalized.push(display);
    if (normalized.length === MAX_PROVIDER_ARRAY_ITEMS) break;
  }
  return normalized;
}

function normalizedStoredItem(item: Item, refreshDerived = false): Item {
  const metadata: Record<string, unknown> = { ...item.metadata };
  if (refreshDerived) {
    delete metadata.contentFingerprint;
    delete metadata.evidenceFingerprint;
    delete metadata.tags;
  }
  for (const key of [
    "authors",
    "institutions",
    "providerTopics",
    "preferredInstitutionMatches",
    "topics",
  ] as const) {
    if (Array.isArray(metadata[key])) {
      metadata[key] = normalizedStoredArray(metadata[key]);
    }
  }
  if (typeof metadata.venue === "string") {
    metadata.venue = normalizeProviderText(metadata.venue, {
      maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
    });
  }
  if (Array.isArray(metadata.provenance)) {
    metadata.provenance = metadata.provenance.map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).sourceName !== "string"
      ) {
        return entry;
      }
      return {
        ...(entry as Record<string, unknown>),
        sourceName: normalizedStoredDisplay(
          (entry as Record<string, unknown>).sourceName as string,
        ),
      };
    });
  }
  if (Array.isArray(metadata.attachedCommentary)) {
    metadata.attachedCommentary = metadata.attachedCommentary.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const normalized = { ...(entry as Record<string, unknown>) };
      for (const key of ["title", "sourceName", "displaySourceName"] as const) {
        if (typeof normalized[key] === "string") {
          normalized[key] = normalizedStoredDisplay(normalized[key] as string);
        }
      }
      if (typeof normalized.excerpt === "string") {
        normalized.excerpt = normalizeProviderText(normalized.excerpt, {
          maxCharacters: MAX_PROVIDER_EVIDENCE_CHARACTERS,
        }) ?? "";
      }
      return normalized;
    });
  }
  if (!refreshDerived && Array.isArray(metadata.editorialSignals)) {
    metadata.editorialSignals = metadata.editorialSignals.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const signal = entry as Record<string, unknown>;
      return typeof signal.sourceName === "string"
        ? { ...signal, sourceName: normalizedStoredDisplay(signal.sourceName) }
        : signal;
    });
  }
  const title = normalizedRequiredStoredTitle(item.title);
  const normalizedText = normalizeProviderText(item.normalizedText) ?? "";
  const authors = itemStringArray(metadata.authors);
  if (Array.isArray(metadata.authors)) metadata.authors = authors;
  metadata.normalizedAuthors = [...new Set(
    authors.map(normalizePreparedAuthorKey).filter(
      (author) => author.length > 0,
    ),
  )].sort((left, right) => left.localeCompare(right));
  const research = item.kind === "paper" || item.kind === "blog";
  const configuredTopics = research
    ? mapResearchTopicIds([
        title,
        ...itemStringArray(metadata.providerTopics),
        ...itemStringArray(metadata.topics),
        normalizedText,
      ])
    : [];
  if (research) metadata.configuredTopics = configuredTopics;
  let primaryTopic = configuredTopics[0] ??
    normalizedStoredDisplay(item.primaryTopic);
  let tags = refreshDerived && research
    ? [...configuredTopics]
    : [...item.tags];
  if (refreshDerived) {
    metadata.normalizedTitle = normalizePreparedTitleKey(title);
    const derivedFields = [
      "namedEntities",
      "eventFamilies",
      "eventInstances",
      "materialFacts",
      "scopedMaterialFacts",
      "editorialSignals",
    ] as const;
    for (const field of derivedFields) delete metadata[field];

    if (item.kind === "paper" || item.kind === "blog") {
      metadata.namedEntities = [];
      metadata.eventFamilies = [];
      metadata.eventInstances = [];
      metadata.materialFacts = [];
      metadata.scopedMaterialFacts = [];
    } else {
      const sectionEligibility = itemStringArray(metadata.sectionEligibility)
        .flatMap((section): EditionSection[] => {
          const parsed = EditionSectionSchema.safeParse(section);
          return parsed.success ? [parsed.data] : [];
        });
      const signals = deriveNewsSignals({
        kind: item.kind,
        title,
        abstract: normalizedText,
        content: null,
        originalUrl: item.canonicalUrl,
        sectionEligibility,
        metadata,
        preferredSection: undefined,
      });
      metadata.sectionEligibility = signals.sectionEligibility;
      metadata.namedEntities = signals.namedEntities;
      metadata.primaryDocumentUrl = signals.primaryDocumentUrl;
      metadata.primaryDocumentUrls = signals.primaryDocumentUrls;
      metadata.eventFamilies = signals.eventFamilies;
      metadata.eventInstances = signals.eventInstances;
      metadata.materialFacts = signals.materialFacts;
      metadata.scopedMaterialFacts = signals.scopedMaterialFacts;
      metadata.primarySection = signals.metadata.primarySection;
      const section = EditionSectionSchema.parse(
        signals.metadata.primarySection,
      );
      primaryTopic = section;
      tags = [...new Set([
        ...signals.sectionEligibility,
        section,
      ])].sort((left, right) => left.localeCompare(right));
    }
  }
  const normalized = ItemSchema.parse({
    ...item,
    title,
    primaryTopic,
    tags,
    sourceRefs: item.sourceRefs.map((source) => ({
      ...source,
      name: normalizedStoredDisplay(source.name),
    })),
    normalizedText,
    metadata,
  });
  return refreshDerived
    ? ItemSchema.parse({
        ...normalized,
        metadata: {
          ...normalized.metadata,
          editorialSignals: editorialSignals(normalized),
        },
      })
    : normalized;
}

function normalizedStoredWorkflowItem(
  item: Item,
  ensureWorkflow = false,
  refreshDerived = false,
): Item {
  const originalWorkflow = item.metadata.workflow === undefined
    ? null
    : workflowPayload(item);
  let development: NewsDevelopment | undefined;
  let storedInput = item;
  if (originalWorkflow?.development !== undefined) {
    if (refreshDerived) {
      const survivingItems = normalizedStoredWorkflowItems(
        originalWorkflow.development.items,
        true,
      );
      if (survivingItems.length === 0) {
        throw new InvalidPreparedCandidateTextError("title");
      }
      development = developmentFromItems(survivingItems);
      const representative = development.representativeItem;
      storedInput = ItemSchema.parse({
        ...representative,
        id: development.id,
        canonicalUrl:
          development.canonicalPrimaryDocument ?? representative.canonicalUrl,
        title: development.title,
        sourceRefs: development.sourceRefs,
        normalizedText: development.items
          .map((nestedItem) => nestedItem.normalizedText)
          .join(" "),
        primaryTopic: development.primarySection,
        tags: representative.tags,
        metadata: {
          ...item.metadata,
          ...representative.metadata,
          primarySection: development.primarySection,
          sectionEligibility: development.sectionEligibility,
          workflow: item.metadata.workflow,
        },
      });
    } else {
      development = NewsDevelopmentSchema.parse({
        ...originalWorkflow.development,
        title: normalizedRequiredStoredTitle(
          originalWorkflow.development.title,
        ),
        items: originalWorkflow.development.items.map((nestedItem) =>
          normalizedStoredWorkflowItem(nestedItem)
        ),
        representativeItem: normalizedStoredWorkflowItem(
          originalWorkflow.development.representativeItem,
        ),
        sourceRefs: originalWorkflow.development.sourceRefs.map((source) => ({
          ...source,
          name: normalizedStoredDisplay(source.name),
        })),
      });
    }
  }
  const normalizedStored = normalizedStoredItem(storedInput, refreshDerived);
  if (
    normalizedStored.metadata.workflow === undefined &&
    !ensureWorkflow
  ) {
    return normalizedStored;
  }
  const existing = normalizedStored.metadata.workflow === undefined
    ? null
    : workflowPayload(normalizedStored);
  const refreshedDevelopmentScore =
    refreshDerived &&
      development !== undefined &&
      existing?.developmentScore !== undefined
      ? scoreNewsDevelopment(development, {
          publicImportance: existing.developmentScore.publicImportance,
          personalRelevance: existing.developmentScore.personalRelevance,
          sourceQuality: existing.developmentScore.sourceQuality,
          recency: existing.developmentScore.recency,
          geography: existing.developmentScore.geography,
          novelty: existing.developmentScore.novelty,
        })
      : undefined;
  return withWorkflowPayload(
    normalizedStored,
    {
      ...(existing?.rawResearch === undefined
        ? {}
        : {
            rawResearch: compactResearchCandidate(
              normalizedStored,
              existing.rawResearch,
            ),
          }),
      ...(development === undefined ? {} : { development }),
      ...(refreshedDevelopmentScore === undefined
        ? {}
        : { developmentScore: refreshedDevelopmentScore }),
      ...(refreshDerived &&
          development !== undefined &&
          existing?.section !== undefined
        ? { section: development.primarySection }
        : {}),
    },
  );
}

function normalizedStoredWorkflowItems(
  items: readonly Item[],
  refreshDerived: boolean,
): Item[] {
  return items.flatMap((item): Item[] => {
    try {
      return [normalizedStoredWorkflowItem(item, false, refreshDerived)];
    } catch (error) {
      if (error instanceof InvalidPreparedCandidateTextError) return [];
      throw error;
    }
  });
}

function compactResearchCandidate(
  item: Item,
  research: RawResearchCandidate,
): RawResearchCandidate {
  const sourceName = item.sourceRefs.find(
    ({ id }) => id === research.sourceId,
  )?.name ?? item.sourceRefs[0]?.name ?? research.sourceName;
  const preferredInstitutionMatches = Array.isArray(
      item.metadata.preferredInstitutionMatches,
    )
    ? normalizedStoredArray(item.metadata.preferredInstitutionMatches)
    : normalizedStoredArray(research.preferredInstitutionMatches);
  return RawResearchCandidateSchema.parse({
    kind: research.kind,
    sourceId: research.sourceId,
    sourceName,
    sourceRole: research.sourceRole,
    title: item.title,
    originalUrl: research.originalUrl,
    externalId: research.externalId,
    externalIds: research.externalIds,
    publishedAt: research.publishedAt,
    retrievedAt: research.retrievedAt,
    accessLevel: research.accessLevel,
    authors: normalizedStoredArray(item.metadata.authors),
    institutions: normalizedStoredArray(item.metadata.institutions),
    abstract: null,
    content: null,
    relatedPaperIds: research.relatedPaperIds,
    metadata: {},
    preferredInstitutionMatches,
    citationCount: research.citationCount,
    influentialCitationCount: research.influentialCitationCount,
    topics: normalizedStoredArray(item.metadata.providerTopics),
  });
}

function assessmentCandidate(
  item: Item,
  compact: RawResearchCandidate,
): RawResearchCandidate {
  const evidence = item.normalizedText.trim();
  switch (compact.accessLevel) {
    case "full_text":
    case "secondary":
      return RawResearchCandidateSchema.parse({
        ...compact,
        content: truncateProviderTextAtCodePointBoundary(
          evidence,
          100_000,
        ) || null,
      });
    case "abstract":
      return RawResearchCandidateSchema.parse({
        ...compact,
        abstract: truncateProviderTextAtCodePointBoundary(
          evidence,
          4_000,
        ) || null,
      });
    case "metadata":
      return compact;
  }
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

function synthesisSection(item: Item): EditionSection {
  const section = EditionSectionSchema.safeParse(item.metadata.section);
  if (section.success) {
    return section.data;
  }
  return isResearchItem(item) ? "research" : newsSection(item);
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

function clamped(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function adjustedRelevance(
  relevance: number,
  configuredWeights: readonly number[],
): number {
  if (configuredWeights.length === 0) return clamped(relevance);
  const average = configuredWeights.reduce(
    (sum, weight) => sum + weight,
    0,
  ) / configuredWeights.length;
  return clamped(relevance * average);
}

function validBudget(
  value: number | undefined,
  maximum: number,
): number | undefined {
  return value !== undefined &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= maximum
    ? value
    : undefined;
}

function preferredSectionBudgets(
  preferences: ReaderPreferences,
): SectionBudgets {
  const configured = preferences.sectionBudgets;
  const localBudgets = [
    validBudget(configured.dmv, APPROVED_SECTION_MAXIMA.dmvAndBaltimore),
    validBudget(
      configured.baltimore,
      APPROVED_SECTION_MAXIMA.dmvAndBaltimore,
    ),
  ].filter((budget): budget is number => budget !== undefined);
  const local = localBudgets.length === 0
    ? undefined
    : Math.max(...localBudgets);
  return {
    morningBrief:
      validBudget(
        configured.morning_brief,
        APPROVED_SECTION_MAXIMA.morningBrief,
      ) ?? READER_PROFILE.sectionBudgets.morningBrief,
    featuredResearch:
      validBudget(
        configured.research,
        APPROVED_SECTION_MAXIMA.featuredResearch,
      ) ?? READER_PROFILE.sectionBudgets.featuredResearch,
    researchRadar:
      validBudget(
        configured.research_radar,
        APPROVED_SECTION_MAXIMA.researchRadar,
      ) ?? READER_PROFILE.sectionBudgets.researchRadar,
    world:
      validBudget(configured.world, APPROVED_SECTION_MAXIMA.world) ??
      READER_PROFILE.sectionBudgets.world,
    technology:
      validBudget(
        configured.technology,
        APPROVED_SECTION_MAXIMA.technology,
      ) ?? READER_PROFILE.sectionBudgets.technology,
    aiPolicy:
      validBudget(
        configured.ai_policy,
        APPROVED_SECTION_MAXIMA.aiPolicy,
      ) ?? READER_PROFILE.sectionBudgets.aiPolicy,
    dmvAndBaltimore:
      local ?? READER_PROFILE.sectionBudgets.dmvAndBaltimore,
    forecastSignals:
      validBudget(
        configured.forecast,
        APPROVED_SECTION_MAXIMA.forecastSignals,
      ) ?? READER_PROFILE.sectionBudgets.forecastSignals,
  };
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
): candidate is RawNewsCandidate | RawResearchCandidate | RawPublicationCandidate {
  return "sourceId" in candidate && "retrievedAt" in candidate;
}

function isResearchItem(item: Item): boolean {
  return item.kind === "paper" || item.kind === "blog";
}

function itemStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const DiscoveryLineageSchema = z.tuple([
  z.string().min(1).max(200),
  z.string().min(1).max(2_048),
  DiscoveryFamilySchema,
  z.string().min(1).max(2_048),
]);

type DiscoveryLineage = z.infer<typeof DiscoveryLineageSchema>;

function itemDiscoveryLineage(item: Item): DiscoveryLineage[] {
  return itemStringArray(item.metadata.discoveryLineage)
    .slice(0, 1_024)
    .flatMap((encoded): DiscoveryLineage[] => {
      try {
        const parsed = DiscoveryLineageSchema.safeParse(JSON.parse(encoded));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

function legacyCommentaryLineageKeys(
  item: Item,
  sourceId: string,
): string[] {
  const attached = Array.isArray(item.metadata.attachedCommentary)
    ? item.metadata.attachedCommentary
    : [];
  const attachedKeys = attached.flatMap((value): string[] => {
    if (value === null || typeof value !== "object") return [];
    const commentary = value as Record<string, unknown>;
    return commentary.sourceId === sourceId &&
        typeof commentary.url === "string" &&
        typeof commentary.title === "string" &&
        typeof commentary.retrievedAt === "string"
      ? [JSON.stringify([
          sourceId,
          commentary.url,
          commentary.title,
          commentary.retrievedAt,
        ])]
      : [];
  });
  if (attachedKeys.length > 0) return attachedKeys;
  return item.sourceRefs
    .filter((source) => source.id === sourceId && source.role === "blog")
    .map((source) => JSON.stringify([
      source.id,
      source.url,
      item.title,
      source.retrievedAt,
    ]));
}

function distinctDiagnosticRefs(
  refs: readonly DiscoveryDiagnosticRef[],
): DiscoveryDiagnosticRef[] {
  return [...new Map(refs.map((ref) => [
    `${ref.laneId}\u0000${ref.identity}`,
    ref,
  ])).values()];
}

function rawDiagnosticRefs(
  candidate: CollectedCandidate,
): DiscoveryDiagnosticRef[] {
  const identity = upstreamCandidateIdentity(candidate);
  return distinctDiagnosticRefs(discoveryLaneIds(candidate).map((laneId) => ({
    laneId,
    identity,
  })));
}

function upstreamDiagnosticRefs(item: Item): DiscoveryDiagnosticRef[] {
  const lineage = itemDiscoveryLineage(item).map(
    ([laneId, , , identity]) => ({ laneId, identity }),
  );
  const coveredLanes = new Set(lineage.map(({ laneId }) => laneId));
  const fallbackIdentity = canonicalResearchIdentity(item);
  return distinctDiagnosticRefs([
    ...lineage,
    ...discoveryLaneIds(item).flatMap((laneId) =>
      coveredLanes.has(laneId) ? [] : [{ laneId, identity: fallbackIdentity }]
    ),
  ]);
}

function retainedUpstreamDiagnosticRefs(item: Item): DiscoveryDiagnosticRef[] {
  const refs = upstreamDiagnosticRefs(item);
  const identities = [...new Set(refs.map(({ identity }) => identity))];
  const retainedIdentity = identities
    .filter((identity) => identity.startsWith(`item:${item.id}:`))
    .sort()[0] ?? identities.sort()[0];
  return retainedIdentity === undefined
    ? []
    : refs.filter(({ identity }) => identity === retainedIdentity);
}

function mergedUpstreamDiagnosticRefs(
  mergeGroups: readonly ItemMergeGroup[],
): DiscoveryDiagnosticRef[] {
  return distinctDiagnosticRefs(mergeGroups.flatMap((group) => {
    const refs = group.inputItems.flatMap(upstreamDiagnosticRefs);
    const retainedIdentity = retainedUpstreamDiagnosticRefs(
      group.retainedItem,
    )[0]?.identity;
    return retainedIdentity === undefined
      ? []
      : refs.filter(({ identity }) => identity !== retainedIdentity);
  }));
}

function stageDiagnosticRefs(
  items: readonly Item[],
  assessedOnly = false,
): DiscoveryDiagnosticRef[] {
  return distinctDiagnosticRefs(items.flatMap((item) => {
    if (
      !isResearchItem(item) ||
      (assessedOnly && workflowPayload(item).assessment === undefined)
    ) {
      return [];
    }
    const identity = canonicalResearchIdentity(item);
    const laneIds = new Set([
      ...discoveryLaneIds(item),
      ...itemDiscoveryLineage(item).map(([laneId]) => laneId),
    ]);
    return [...laneIds].map((laneId) => ({ laneId, identity }));
  }));
}

function omittedItems(
  input: readonly Item[],
  retained: readonly Item[],
): Item[] {
  const retainedCounts = new Map<string, number>();
  for (const item of retained) {
    retainedCounts.set(item.id, (retainedCounts.get(item.id) ?? 0) + 1);
  }
  return input.filter((item) => {
    const remaining = retainedCounts.get(item.id) ?? 0;
    if (remaining === 0) return true;
    retainedCounts.set(item.id, remaining - 1);
    return false;
  });
}

function itemDiscoveryFamily(item: Item): DiscoveryFamily {
  const direct = DiscoveryFamilySchema.safeParse(item.metadata.discoveryFamily);
  if (direct.success) return direct.data;
  const sourceIds = new Set(item.sourceRefs.map(({ id }) => id));
  if (sourceIds.has("arxiv")) return "arxiv";
  if (sourceIds.has("semantic-scholar") || sourceIds.has("openalex")) {
    return "bibliographic";
  }
  if (item.kind === "blog") return "commentary";
  return "official-publication";
}

function sourceDiscoveryFamily(item: Item, sourceId: string): DiscoveryFamily {
  const lineageFamilies = [...new Set(
    itemDiscoveryLineage(item)
      .filter(([, lineageSourceId]) => lineageSourceId === sourceId)
      .map(([, , family]) => family),
  )];
  if (lineageFamilies.length === 1) return lineageFamilies[0]!;
  if (legacyCommentaryLineageKeys(item, sourceId).length > 0) {
    return "commentary";
  }
  if (sourceId === "arxiv") return "arxiv";
  if (sourceId === "semantic-scholar" || sourceId === "openalex") {
    return "bibliographic";
  }
  return lineageFamilies.sort()[0] ?? itemDiscoveryFamily(item);
}

function routedOfficialPublicationRoute(
  item: Item,
): "technology" | "ai_policy" | null {
  const discoveryFamily = DiscoveryFamilySchema.safeParse(
    item.metadata.discoveryFamily,
  );
  if (
    isResearchItem(item) ||
    !discoveryFamily.success ||
    discoveryFamily.data !== "official-publication"
  ) {
    return null;
  }
  const route = z.enum(["technology", "ai_policy"])
    .safeParse(item.metadata.primarySection);
  return route.success ? route.data : null;
}

function discoveryObservation(
  item: Item,
  sourceId: string,
  retrievedAt: string,
  windowKind: DiscoveryObservation["windowKind"],
  route: DiscoveryObservation["route"],
  runId: string,
  observedAt: string,
): DiscoveryObservation {
  const fingerprints = researchFingerprints(item);
  return {
    runId,
    canonicalId: canonicalResearchIdentity(item),
    sourceId,
    discoveryFamily: sourceDiscoveryFamily(item, sourceId),
    windowKind,
    publishedAt: item.publishedAt,
    retrievedAt,
    observedAt,
    contentFingerprint: fingerprints.contentFingerprint,
    evidenceFingerprint: fingerprints.evidenceFingerprint,
    joinedExternalIds: itemStringArray(item.metadata.externalIds).slice(0, 32),
    route,
    expiresAt: new Date(
      Date.parse(observedAt) + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
  };
}

const DiscoveryDiagnosticsArraySchema = z.array(
  DiscoveryLaneDiagnosticSchema,
).max(64);

function discoveryLaneIds(candidate: CollectedCandidate | Item): string[] {
  return itemStringArray(candidate.metadata.discoveryLaneIds).slice(0, 64);
}

export function createProductionPipelineContext(
  options: ProductionPipelineContextOptions,
): PipelineContext {
  const preferences = parsedPreferences(options.preferences);
  const effectiveWeights = effectivePreferenceWeights(preferences);
  const configuredBudgets = preferredSectionBudgets(preferences);
  const discoveryDiagnosticsWriter = options.researchRepository
    ?.recordDiscoveryDiagnostics?.bind(options.researchRepository);
  let discoveryDiagnostics: DiscoveryDiagnosticsTracker | null = null;
  const withDiscoveryDiagnostics = async (
    action: (tracker: DiscoveryDiagnosticsTracker) => void | Promise<void>,
  ): Promise<void> => {
    if (
      discoveryDiagnosticsWriter === undefined ||
      options.loadDiscoveryDiagnostics === undefined
    ) {
      return;
    }
    try {
      if (discoveryDiagnostics === null) {
        const loaded = await options.loadDiscoveryDiagnostics();
        const input = Array.isArray(loaded)
          ? DiscoveryDiagnosticsArraySchema.parse(loaded)
          : DiscoveryDiagnosticsStateSchema.parse(loaded);
        discoveryDiagnostics = new DiscoveryDiagnosticsTracker(input);
      }
      await action(discoveryDiagnostics);
    } catch {
      // Optional observability must not abort editorial work.
    }
  };
  const rejectDiscoveryDiagnostics = async (
    reason: DiscoveryRejectionReason,
    refs: readonly DiscoveryDiagnosticRef[],
  ): Promise<void> => {
    await withDiscoveryDiagnostics((tracker) => tracker.reject(reason, refs));
  };
  const recordDiscoveryDiagnostics = async (
    field?: "deduplicated" | "triaged" | "assessed",
    items: readonly Item[] = [],
  ): Promise<void> => {
    await withDiscoveryDiagnostics(async (tracker) => {
      if (field !== undefined) {
        tracker.setStage(
          field,
          stageDiagnosticRefs(items, field === "assessed"),
        );
      }
      await discoveryDiagnosticsWriter!(
        options.runId,
        tracker.snapshot(),
        tracker.state().rejectionCountsByStage,
      );
    });
  };
  return {
    editionDate: options.editionDate,
    runId: options.runId,
    store: options.store,
    now: options.now,
    ...(options.cleanupTerminalReservations === undefined
      ? {}
      : { cleanupTerminalReservations: options.cleanupTerminalReservations }),
    collect: async () => {
      const prepared: unknown[] = [];
      const invalidContent: DiscoveryDiagnosticRef[] = [];
      for (const candidate of await options.collectCandidates()) {
        if (!isRawCollectedCandidate(candidate)) {
          prepared.push(candidate);
          continue;
        }
        const durable = durableCollectedCandidate(candidate);
        try {
          prepared.push(isPreparedRawCandidate(candidate)
            ? markPreparedRawCandidate(durable)
            : prepareRawCandidateForPipeline(durable));
        } catch (error) {
          if (!(error instanceof InvalidPreparedCandidateTextError)) {
            throw error;
          }
          invalidContent.push(...rawDiagnosticRefs(candidate));
        }
      }
      const collected = z.array(CollectedCandidateSchema).parse(prepared)
        .map((candidate) =>
          isRawCollectedCandidate(candidate)
            ? markPreparedRawCandidate(candidate)
            : candidate
        );
      await rejectDiscoveryDiagnostics("quality_rejected", invalidContent);
      await recordDiscoveryDiagnostics();
      return collected;
    },
    normalize: async (candidates) => {
      await withDiscoveryDiagnostics((tracker) => {
        tracker.beginStage("normalize");
      });
      const normalized: Item[] = [];
      const routeExcluded: DiscoveryDiagnosticRef[] = [];
      const invalidContent: DiscoveryDiagnosticRef[] = [];
      for (const candidate of candidates) {
        let routed: Item | null;
        try {
          routed = normalizedCandidate(candidate);
        } catch (error) {
          if (!(error instanceof InvalidPreparedCandidateTextError)) {
            throw error;
          }
          invalidContent.push(...rawDiagnosticRefs(candidate));
          continue;
        }
        if (routed === null) {
          routeExcluded.push(...rawDiagnosticRefs(candidate));
        } else {
          normalized.push(routed);
        }
      }
      await rejectDiscoveryDiagnostics("quality_rejected", invalidContent);
      await rejectDiscoveryDiagnostics("route_excluded", routeExcluded);
      const unboundedResearch = normalized.filter(isResearchItem);
      const boundedResearch = boundResearchDiscoveryPool(
        unboundedResearch,
      );
      await rejectDiscoveryDiagnostics(
        "capacity_limited",
        omittedItems(unboundedResearch, boundedResearch).flatMap(
          upstreamDiagnosticRefs,
        ),
      );
      const consolidated = consolidateResearchCandidates(boundedResearch);
      await rejectDiscoveryDiagnostics(
        "identity_merged",
        mergedUpstreamDiagnosticRefs(consolidated.mergeGroups),
      );
      const fingerprintedResearch = [
        ...consolidated.papers,
        ...consolidated.standaloneCommentary,
      ].map((item) => {
        const fingerprints = researchFingerprints(item);
        return withWorkflowPayload(item, {}, fingerprints);
      });
      const fingerprintedOfficialArticles = normalized.flatMap((item) => {
        const route = routedOfficialPublicationRoute(item);
        if (route === null) return [];
        return [{
          original: item,
          item: withWorkflowPayload(item, {}, researchFingerprints(item)),
          route,
        }];
      });
      const observedCandidates = [
        ...fingerprintedResearch,
        ...fingerprintedOfficialArticles.map(({ item }) => item),
      ];
      const observedAt = options.now();
      const since = new Date(
        Date.parse(observedAt) - 7 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      let priorObservations: readonly DiscoveryObservation[] = [];
      if (
        options.researchRepository !== undefined &&
        observedCandidates.length > 0
      ) {
        try {
          priorObservations = await options.researchRepository
            .getDiscoveryObservations(
              observedCandidates.map(canonicalResearchIdentity),
              since,
              options.runId,
            );
        } catch {
          priorObservations = [];
        }
      }
      const researchDecisions = fingerprintedResearch.map((item) => ({
        item,
        decision: classifyDiscoveryWindowDecision(
          item,
          priorObservations,
          observedAt,
        ),
      }));
      const selectedResearch = researchDecisions.flatMap(({ item, decision }) => {
        return decision.windowKind === null
          ? []
          : [withWorkflowPayload(
              item,
              {},
              { discoveryWindow: decision.windowKind },
            )];
      });
      for (const { item, decision } of researchDecisions) {
        if (decision.rejectionReason !== null) {
          await rejectDiscoveryDiagnostics(
            decision.rejectionReason,
            retainedUpstreamDiagnosticRefs(item),
          );
        }
      }
      const officialArticleDecisions = fingerprintedOfficialArticles.map(
        (candidate) => ({
          candidate,
          decision: classifyDiscoveryWindowDecision(
            candidate.item,
            priorObservations,
            observedAt,
          ),
        }),
      );
      const selectedOfficialArticles = officialArticleDecisions.flatMap(
        ({ candidate, decision }) => {
          return decision.windowKind === null
            ? []
            : [{
                ...candidate,
                item: withWorkflowPayload(
                  candidate.item,
                  {},
                  { discoveryWindow: decision.windowKind },
                ),
              }];
        },
      );
      for (const { candidate: { item }, decision } of officialArticleDecisions) {
        if (decision.rejectionReason !== null) {
          await rejectDiscoveryDiagnostics(
            decision.rejectionReason,
            retainedUpstreamDiagnosticRefs(item),
          );
        }
      }
      const selectedObservedItems = [
        ...selectedResearch.map((item) => ({
          item,
          route: "research" as const,
        })),
        ...selectedOfficialArticles.map(({ item, route }) => ({ item, route })),
      ];
      if (
        options.researchRepository !== undefined &&
        selectedObservedItems.length > 0
      ) {
        await options.researchRepository.upsertDiscoveryObservations(
          selectedObservedItems.flatMap(({ item, route }) => {
            const windowKind = z.enum(["fresh", "reconsideration"])
              .parse(item.metadata.discoveryWindow);
            return item.sourceRefs.map((source) =>
              discoveryObservation(
                item,
                source.id,
                source.retrievedAt,
                windowKind,
                route,
                options.runId,
                observedAt,
              )
            );
          }),
        );
      }
      const officialArticleOriginals = new Set(
        fingerprintedOfficialArticles.map(({ original }) => original),
      );
      const selectedOfficialByOriginal = new Map(
        selectedOfficialArticles.map(({ original, item }) => [original, item]),
      );
      const newsCandidates = normalized.flatMap((item) => {
        if (isResearchItem(item)) return [];
        if (!officialArticleOriginals.has(item)) return [item];
        const selected = selectedOfficialByOriginal.get(item);
        return selected === undefined ? [] : [selected];
      });
      const deduplicatedNews = deduplicateItems(newsCandidates);
      await rejectDiscoveryDiagnostics(
        "identity_merged",
        mergedUpstreamDiagnosticRefs(deduplicatedNews.mergeGroups),
      );
      const news = deduplicatedNews.items.map((item) =>
        withWorkflowPayload(item, {})
      );
      const result = [...selectedResearch, ...news];
      await recordDiscoveryDiagnostics("deduplicated", result);
      return result;
    },
    ...(options.persistItems === undefined
      ? {}
      : { persistItems: options.persistItems }),
    enrich: async (items) => {
      if (items.length === 0) return [];
      if (options.budgetPolicy?.state === "hard_stop") {
        const getCachedTopicalFit = options.researchRepository
          ?.getCachedResearchTopicalFit;
        if (getCachedTopicalFit === undefined) return [];
        const cachedResearch: Item[] = [];
        for (const candidate of items) {
          const item = WorkflowItemSchema.parse(candidate);
          if (!isResearchItem(item)) continue;
          let topicalFit: number | null = null;
          try {
            topicalFit = await getCachedTopicalFit.call(
              options.researchRepository,
              canonicalResearchIdentity(item),
              researchFingerprints(item).evidenceFingerprint,
              options.now(),
            );
          } catch {
            topicalFit = null;
          }
          if (topicalFit !== null) {
            cachedResearch.push(withWorkflowPayload(item, { topicalFit }));
          }
        }
        return cachedResearch;
      }
      const profileTexts = profileEmbeddingTexts();
      const embeddingInputs = [
        ...items.map(itemEmbeddingText),
        ...profileTexts,
      ];
      const embedded: Array<readonly number[]> = [];
      for (let offset = 0; offset < embeddingInputs.length; offset += 500) {
        embedded.push(...await options.providers.summary.embed(
          embeddingInputs.slice(offset, offset + 500),
        ));
      }
      const vectors = z.array(
        z.array(z.number().finite()).min(1).max(4_096),
      ).length(embeddingInputs.length).parse(embedded);
      const dimension = vectors[0]?.length;
      if (
        dimension === undefined ||
        vectors.some((vector) => vector.length !== dimension)
      ) {
        throw new Error("INVALID_EMBEDDING_BATCH");
      }
      const profileVectors = vectors.slice(items.length);
      return items.map((candidate, index) => {
        const item = WorkflowItemSchema.parse(candidate);
        const embedding = vectors[index];
        if (embedding === undefined) throw new Error("MISSING_ITEM_EMBEDDING");
        const relevance = Math.max(
          0,
          ...profileVectors.map((profileVector) =>
            cosineSimilarity(embedding, profileVector),
          ),
        );
        const topicWeight = effectiveWeights.topicWeights[item.primaryTopic];
        const sourceWeights = [
          ...new Set(item.sourceRefs.map(({ id }) => id)),
        ].flatMap((sourceId) => {
          const weight = effectiveWeights.sourceWeights[sourceId];
          return weight === undefined ? [] : [weight];
        });
        return withWorkflowPayload(
          item,
          item.kind === "paper" || item.kind === "blog"
            ? {
                topicalFit: adjustedRelevance(
                  relevance,
                  topicWeight === undefined ? [] : [topicWeight],
                ),
              }
            : {
                embedding,
                personalRelevance: adjustedRelevance(
                  relevance,
                  [
                    ...(topicWeight === undefined ? [] : [topicWeight]),
                    ...sourceWeights,
                  ],
                ),
              },
        );
      });
    },
    prefilter: async (items) => {
      await withDiscoveryDiagnostics((tracker) => {
        tracker.beginStage("prefilter");
      });
      const parsed = items.map((item) => WorkflowItemSchema.parse(item));
      const research = parsed.filter(isResearchItem);
      const news = parsed.filter((item) =>
        !isResearchItem(item) && item.normalizedText.trim().length > 0
      );
      const triaged = triageResearch(research, {
        maximum: 24,
        maximumPerFamily: 12,
        maximumPerPublisherDomain: 6,
        configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
        now: options.now(),
        minimumTopicalFit:
          READER_PROFILE.researchQualityGates.minimumTopicalFit,
      });
      const researchById = new Map(research.map((item) => [item.id, item]));
      for (const exclusion of triaged.exclusions) {
        const item = researchById.get(exclusion.itemId);
        if (item === undefined) continue;
        const reason: DiscoveryRejectionReason =
          exclusion.reason === "below_topical_fit"
            ? "topic_mismatch"
            : exclusion.reason === "invalid_content"
              ? "quality_rejected"
              : "capacity_limited";
        await rejectDiscoveryDiagnostics(
          reason,
          retainedUpstreamDiagnosticRefs(item),
        );
      }
      const result = [...triaged.items, ...news];
      await recordDiscoveryDiagnostics("triaged", result);
      return result;
    },
    assess: async (items) => {
      await withDiscoveryDiagnostics((tracker) => {
        tracker.beginStage("assess");
      });
      const assessed: Item[] = [];
      const maximumUncached = options.budgetPolicy?.state === "hard_stop"
        ? 0
        : options.budgetPolicy?.state === "degraded"
          ? 4
          : 24;
      let uncachedCalls = 0;
      for (const candidate of items) {
        const item = WorkflowItemSchema.parse(candidate);
        if (item.kind !== "paper" && item.kind !== "blog") {
          assessed.push(item);
          continue;
        }
        const rawResearch = workflowPayload(item).rawResearch;
        if (rawResearch === undefined) {
          throw new Error(`MISSING_RAW_RESEARCH:${item.id}`);
        }
        const canonicalId = canonicalResearchIdentity(item);
        const evidenceFingerprint = researchFingerprints(item)
          .evidenceFingerprint;
        let cachedAssessment: ResearchAssessment | null = null;
        if (options.researchRepository !== undefined) {
          try {
            cachedAssessment = await options.researchRepository
              .getCachedResearchAssessment(
                canonicalId,
                evidenceFingerprint,
                options.now(),
              );
          } catch {
            cachedAssessment = null;
          }
        }
        if (cachedAssessment !== null) {
          const topicalFit = workflowPayload(item).topicalFit;
          if (
            topicalFit !== undefined &&
            options.researchRepository !== undefined
          ) {
            try {
              await options.researchRepository.putCachedResearchAssessment(
                canonicalId,
                evidenceFingerprint,
                cachedAssessment,
                new Date(
                  Date.parse(options.now()) + 7 * 24 * 60 * 60 * 1_000,
                ).toISOString(),
                topicalFit,
              );
            } catch {
              // Legacy cache migration is opportunistic.
            }
          }
          assessed.push(withWorkflowPayload(item, {
            assessment: cachedAssessment,
          }));
          continue;
        }
        if (uncachedCalls >= maximumUncached) {
          await rejectDiscoveryDiagnostics(
            "capacity_limited",
            retainedUpstreamDiagnosticRefs(item),
          );
          continue;
        }
        uncachedCalls += 1;
        let assessment: ResearchAssessment;
        try {
          assessment = await assessResearch(
            assessmentCandidate(item, rawResearch),
            options.providers.assessment,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "ACCESS_LEVEL_OVERCLAIM"
          ) {
            await rejectDiscoveryDiagnostics(
              "quality_rejected",
              retainedUpstreamDiagnosticRefs(item),
            );
            continue;
          }
          throw error;
        }
        if (options.researchRepository !== undefined) {
          try {
            await options.researchRepository.putCachedResearchAssessment(
              canonicalId,
              evidenceFingerprint,
              assessment,
              new Date(
                Date.parse(options.now()) + 7 * 24 * 60 * 60 * 1_000,
              ).toISOString(),
              workflowPayload(item).topicalFit,
            );
          } catch {
            // Assessment cache availability must not discard paid results.
          }
        }
        assessed.push(withWorkflowPayload(item, { assessment }));
      }
      await recordDiscoveryDiagnostics("assessed", assessed);
      return assessed;
    },
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
          candidate: item,
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
      const compactResearch = research.map(withoutWorkflowEmbedding);
      const compactNews = news.map(withoutWorkflowEmbedding);
      const byId = new Map(compactNews.map((item) => [item.id, item]));
      const developments = clusterNews(compactNews, embeddings);
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
      return [...compactResearch, ...developmentItems];
    },
    shortlist: async (items) => {
      await withDiscoveryDiagnostics((tracker) => {
        tracker.beginStage("shortlist");
      });
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
        ...configuredBudgets,
        researchRadar: options.budgetPolicy?.state === "hard_stop"
          ? 0
          : options.budgetPolicy?.state === "degraded"
            ? Math.min(1, configuredBudgets.researchRadar)
            : configuredBudgets.researchRadar,
      };
      const selected = selectShortlist(
        candidates,
        scores,
        preferences,
        budgets,
      );
      const featured = selected.researchFeatured
        .slice(0, Math.min(budgets.featuredResearch, budgets.morningBrief))
        .map((item) => ({ id: item.id, section: "research" as const }));
      const reservedIds = new Set(featured.map(({ id }) => id));
      const rankedMorning = selected.morningBrief
        .filter((candidate) => !reservedIds.has(candidate.id))
        .map((candidate) =>
          "representativeItem" in candidate
            ? { id: candidate.id, section: candidate.primarySection }
            : { id: candidate.id, section: "research" as const }
        );
      const morning = [...featured, ...rankedMorning]
        .slice(0, budgets.morningBrief);
      const morningIds = new Set(morning.map(({ id }) => id));
      const radar = selected.researchRadar
        .filter((item) => !morningIds.has(item.id))
        .slice(0, Math.min(
          budgets.researchRadar,
          Math.max(0, budgets.morningBrief - morning.length),
        ))
        .map((item) => ({ id: item.id, section: "research_radar" as const }));
      const ordered = [...morning, ...radar].slice(0, budgets.morningBrief);
      const byId = new Map(parsed.map((item) => [item.id, item]));
      const selectedIds = new Set(ordered.map(({ id }) => id));
      await rejectDiscoveryDiagnostics(
        "capacity_limited",
        parsed.flatMap((item) =>
          isResearchItem(item) && !selectedIds.has(item.id)
            ? retainedUpstreamDiagnosticRefs(item)
            : []
        ),
      );
      const result = ordered.map(({ id, section }) => {
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
      await recordDiscoveryDiagnostics();
      return result;
    },
    synthesize: async (items) => {
      const summaries: Array<{
        item: Item;
        summary: StructuredSummary;
      }> = [];
      for (const candidate of providerEligibleItems(
        items,
        options.budgetPolicy,
      )) {
        const item = WorkflowItemSchema.parse(candidate);
        try {
          summaries.push({
            item,
            summary: await summarizeItem(
              sourcePacketForItem(item),
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
          });
        } catch (error) {
          if (error instanceof SummaryRejectedError) {
            if (options.store.recordSummaryRejection === undefined) {
              throw new Error("DIAGNOSTIC_STORE_UNAVAILABLE");
            }
            await options.store.recordSummaryRejection(options.runId, item.id, {
              section: synthesisSection(item),
              errors: canonicalSummaryRejectionCodes(error.errors),
              createdAt: options.now(),
            });
            continue;
          }
          throw error;
        }
      }
      return summaries;
    },
    validate: async (entries) => entries.map((entry) => {
      const parsedSummary = StructuredSummarySchema.strict().safeParse(
        entry.summary,
      );
      const sourceIds = new Set(entry.item.sourceRefs.map(({ id }) => id));
      const packet = sourcePacketForItem(entry.item);
      const validationErrors = parsedSummary.success
        ? [
            ...new Set(
              parsedSummary.data.claims.flatMap((claim) => [
                ...claim.sourceIds
                  .filter((sourceId) => !sourceIds.has(sourceId))
                  .map((sourceId) =>
                    `UNKNOWN_ITEM_SOURCE:${
                      encodeURIComponent(sourceId).slice(0, 160)
                    }`,
                  ),
                ...(!claimEvidenceMatchesAllSources(
                  claim.evidenceExcerpt,
                  claim.sourceIds,
                  packet,
                ) ? ["CLAIM_EVIDENCE_NOT_EXACT"] : []),
              ]),
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
    ...(options.loadSourceFailures === undefined
      ? {}
      : { loadSourceFailures: options.loadSourceFailures }),
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
  options: Pick<
    ProductionPipelineContextOptions,
    | "checkpointExecutor"
    | "budgetPolicy"
    | "openAlexApiKey"
    | "preferences"
    | "cleanupTerminalReservations"
  > = {},
): PipelineContext {
  const now = () => new Date().toISOString();
  const sourceFailures: string[] = [];
  const discoveryDiagnostics: DiscoveryLaneDiagnostic[] = [];
  let discoveryDiagnosticsCollectionCompleted = false;
  return createProductionPipelineContext({
    editionDate,
    runId,
    store,
    now,
    providers,
    ...options,
    researchRepository: store.repository,
    loadDiscoveryDiagnostics: async () =>
      discoveryDiagnosticsCollectionCompleted
        ? discoveryDiagnostics
        : (await store.repository.getDiscoveryDiagnosticsState(runId)) ?? [],
    sourceFailures,
    loadSourceFailures: () => store.readCollectionSourceFailures(runId),
    persistItems: async (items) => store.repository.upsertItems(items),
    collectCandidates: async () => {
      sourceFailures.length = 0;
      const sources = await store.repository.listSources();
      const source = (id: string) => {
        const match = sources.find((candidate) => candidate.id === id);
        if (match === undefined) throw new Error(`MISSING_CATALOG_SOURCE:${id}`);
        return catalogSourceInput(match);
      };
      const http = new SourceHttpClient();
      const newsCollector = createNewsCollectorFromCatalog({ http, sources });
      const publicationCollector = createPublicationCollectorFromCatalog({
        http,
        sources,
      });
      const arxivSource = source("arxiv");
      const semanticScholarSource = source("semantic-scholar");
      const openAlexSource = source("openalex");
      const researchCollector = new ResearchCollector({
        discoveryAdapters: createPaperDiscoveryAdapters(http, [
          arxivSource,
          semanticScholarSource,
          openAlexSource,
        ], options.openAlexApiKey === undefined
          ? {}
          : { openAlexApiKey: options.openAlexApiKey }),
        enrichers: [
          ...(semanticScholarSource.enabled
            ? [new SemanticScholarAdapter(http, semanticScholarSource)]
            : []),
          ...(openAlexSource.enabled
            ? [new OpenAlexAdapter(
              http,
              openAlexSource,
              undefined,
              options.openAlexApiKey === undefined
                ? {}
                : { apiKey: options.openAlexApiKey },
            )]
            : []),
        ],
        preferredInstitutions: READER_PROFILE.preferredInstitutions,
        preferredLabs: READER_PROFILE.preferredLabs,
      });
      const to = now();
      const reconsiderationFrom = new Date(
        Date.parse(to) - 7 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      const freshFrom = new Date(
        Date.parse(to) - 36 * 60 * 60 * 1_000,
      ).toISOString();
      const [news, research, publications] = await Promise.all([
        newsCollector.collect({ from: freshFrom, to }),
        researchCollector.collect({ from: reconsiderationFrom, to }),
        publicationCollector.collect({ from: reconsiderationFrom, to }),
      ]);
      discoveryDiagnostics.splice(
        0,
        discoveryDiagnostics.length,
        ...DiscoveryDiagnosticsArraySchema.parse([
          ...(research.discoveryDiagnostics ?? []),
          ...(publications.discoveryDiagnostics ?? []),
        ].sort((left, right) => left.laneId.localeCompare(right.laneId)).slice(
          0,
          64,
        )),
      );
      const succeededSourceIds = new Set([
        ...news.succeededSourceIds,
        ...research.succeededSourceIds,
        ...publications.succeededSourceIds,
      ]);
      const collectionFailures = [
        ...news.failures,
        ...research.failures,
        ...publications.failures,
      ];
      const failuresBySourceId = new Map(
        collectionFailures.map((failure) => [
          failure.sourceId,
          failure,
        ]),
      );
      for (const catalogSource of sources) {
        const failure = failuresBySourceId.get(catalogSource.id);
        if (
          failure !== undefined &&
          failure.sourceId !== "unknown-source"
        ) {
          await store.repository.recordSourceOutcome(
            failure.sourceId,
            failure.kind,
            to,
          );
        } else if (succeededSourceIds.has(catalogSource.id)) {
          await store.repository.recordSourceOutcome(
            catalogSource.id,
            "success",
            to,
          );
        }
      }
      sourceFailures.push(...boundedSourceFailureLabels(collectionFailures));
      await store.saveCollectionSourceFailures(runId, sourceFailures);
      const candidates = [
        ...research.candidates.map((candidate) =>
          RawResearchCandidateSchema.parse(candidate),
        ),
        ...news.candidates.map((candidate) =>
          RawNewsCandidateSchema.parse(candidate),
        ),
        ...publications.candidates.map((candidate) =>
          RawPublicationCandidateSchema.parse(candidate)
        ),
      ];
      discoveryDiagnosticsCollectionCompleted = true;
      return candidates;
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
        await ensurePipelineRun(
          store,
          runId,
          input.editionDate,
          new Date().toISOString(),
        );
        const preferences = await loadOrCreatePreferenceSnapshot(store, runId);
        const configured = await runtime(runId, input.editionDate);
        await runEditorialPipeline(createD1ProductionPipelineContext(
          store,
          input.editionDate,
          runId,
          configured.providers,
          {
            preferences,
            ...(configured.openAlexApiKey === undefined
              ? {}
              : { openAlexApiKey: configured.openAlexApiKey }),
            ...(configured.budgetPolicy === undefined
              ? {}
              : { budgetPolicy: configured.budgetPolicy }),
          },
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
      const preferences = await loadOrCreatePreferenceSnapshot(
        store,
        run.id,
      );
      const configured = await runtime(run.id, run.editionDate);
      await runEditorialPipeline(createD1ProductionPipelineContext(
        store,
        run.editionDate,
        run.id,
        configured.providers,
        {
          preferences,
          ...(configured.openAlexApiKey === undefined
            ? {}
            : { openAlexApiKey: configured.openAlexApiKey }),
          ...(configured.budgetPolicy === undefined
            ? {}
            : { budgetPolicy: configured.budgetPolicy }),
        },
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

function normalizedRestoredCheckpointOutput(
  step: PipelineStep,
  output: unknown,
): unknown {
  switch (step) {
    case "collect":
      return output;
    case "normalize":
    case "enrich":
    case "prefilter":
    case "assess":
    case "score":
    case "cluster":
    case "shortlist":
      return normalizedStoredWorkflowItems(
        output as readonly Item[],
        true,
      );
    case "synthesize":
    case "validate":
      return (output as readonly {
        item: Item;
        [key: string]: unknown;
      }[]).flatMap((candidate) => {
        try {
          return [{
            ...candidate,
            item: normalizedStoredWorkflowItem(candidate.item, false, true),
          }];
        } catch (error) {
          if (error instanceof InvalidPreparedCandidateTextError) return [];
          throw error;
        }
      });
    case "compose":
    case "publish":
      return output;
  }
}

function restoredCheckpointOutput<T>(
  step: PipelineStep,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  artifact: CheckpointArtifact<unknown>,
): T {
  const parsed = schema.parse(artifact.output);
  if (
    step === "collect" &&
    artifact.providerTextPreparationVersion ===
      PROVIDER_TEXT_PREPARATION_VERSION &&
    Array.isArray(parsed)
  ) {
    return parsed.map((candidate) =>
      isRawCollectedCandidate(candidate as CollectedCandidate)
        ? markPreparedRawCandidate(candidate as object)
        : candidate
    ) as T;
  }
  if (
    artifact.providerTextNormalizationVersion ===
    PROVIDER_TEXT_NORMALIZATION_VERSION
  ) {
    return parsed;
  }
  return schema.parse(normalizedRestoredCheckpointOutput(step, parsed));
}

function checkpointHasPreparedProviderText(
  step: PipelineStep,
  output: unknown,
): boolean {
  return step === "collect" && Array.isArray(output) && output.some(
    (candidate) => isPreparedRawCandidate(candidate),
  ) && output.every(
    (candidate) =>
      !isRawCollectedCandidate(candidate as CollectedCandidate) ||
      isPreparedRawCandidate(candidate),
  );
}

function checkpointHasNormalizedProviderText(step: PipelineStep): boolean {
  switch (step) {
    case "normalize":
    case "enrich":
    case "prefilter":
    case "assess":
    case "score":
    case "cluster":
    case "shortlist":
    case "synthesize":
    case "validate":
      return true;
    case "collect":
    case "compose":
    case "publish":
      return false;
  }
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
      return restoredCheckpointOutput(step, outputSchema, artifact);
    }
    const attempt = await context.store.beginAttempt(context.runId, step);
    const startedAt = Date.parse(context.now());
    let output: T;
    try {
      const executed = await execute();
      output = outputSchema.parse(executed);
      if (step === "collect" && Array.isArray(output) && Array.isArray(executed)) {
        output = output.map((candidate, index) =>
          isPreparedRawCandidate(executed[index]) &&
              typeof candidate === "object" && candidate !== null
            ? markPreparedRawCandidate(candidate)
            : candidate
        ) as T;
      }
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
      ...(checkpointHasNormalizedProviderText(step)
        ? {
            providerTextNormalizationVersion:
              PROVIDER_TEXT_NORMALIZATION_VERSION,
          }
        : {}),
      ...(checkpointHasPreparedProviderText(step, output)
        ? {
            providerTextPreparationVersion:
              PROVIDER_TEXT_PREPARATION_VERSION,
          }
        : {}),
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

async function readCheckpointOutput<T>(
  context: PipelineContext,
  step: PipelineStep,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const artifact = await context.store.readArtifact(context.runId, step);
  if (artifact === null) throw new Error(`MISSING_CHECKPOINT_ARTIFACT:${step}`);
  return restoredCheckpointOutput(step, schema, artifact);
}

async function collectAndNormalize(
  context: PipelineContext,
  run: PipelineRun,
): Promise<readonly Item[]> {
  const collected = await checkpoint(
    context,
    run,
    "collect",
    CollectedCandidatesSchema,
    context.collect,
  );
  return checkpoint(
    context,
    run,
    "normalize",
    NormalizedItemsSchema,
    () => context.normalize(collected),
    context.persistItems,
  );
}

async function advanceSelectionStages(
  context: PipelineContext,
  run: PipelineRun,
): Promise<readonly Item[]> {
  let items: readonly Item[] = await collectAndNormalize(context, run);
  let input = items;
  items = await checkpoint(
    context, run, "enrich", EnrichedItemsSchema,
    () => context.enrich(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "prefilter", PrefilteredItemsSchema,
    () => context.prefilter(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "assess", AssessedItemsSchema,
    () => context.assess(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "score", ScoredItemsSchema,
    () => context.score(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "cluster", ClusteredItemsSchema,
    () => context.cluster(input),
  );
  input = items;
  return checkpoint(
    context, run, "shortlist", ShortlistedItemsSchema,
    () => context.shortlist(input),
  );
}

export async function runEditorialPipeline(
  context: PipelineContext,
): Promise<PipelineResult> {
  let run = await currentRun(context);
  if (run.status === "published" || (run.status === "failed" && !run.retryable)) {
    return result(context.runId, run.status);
  }
  if (
    (run.status === "partial" || run.status === "failed") &&
    run.retryable
  ) {
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
    const shortlisted = await advanceSelectionStages(context, run);
    const synthesized = await checkpoint(
      context, run, "synthesize", SummaryCandidatesSchema,
      () => context.synthesize(shortlisted),
    );
    const validated = await checkpoint(
      context, run, "validate", ValidatedSummaryCandidatesSchema,
      () => context.validate(synthesized),
    );
    const normalizedForComposition = await readCheckpointOutput(
      context,
      "normalize",
      NormalizedItemsSchema,
    );
    const durableSourceFailures = context.loadSourceFailures === undefined
      ? boundedSourceFailureMetadata(context.sourceFailures ?? [])
      : boundedSourceFailureMetadata(await context.loadSourceFailures());
    const composition = await checkpoint(
      context, run, "compose", CompositionSchema,
      () => composeEdition(
        { ...context, sourceFailures: durableSourceFailures },
        validated,
        normalizedForComposition,
      ),
    );
    await checkpoint(
      context, run, "publish", CompositionSchema,
      () => publishEdition(context, composition),
    );
    const finalRun = {
      ...(await context.store.getRun(context.runId) ?? run),
      status: composition.status,
      currentStep: "publish" as const,
      retryable:
        composition.status === "partial" || composition.status === "failed",
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
    try {
      await context.cleanupTerminalReservations?.(failureCode);
    } catch {
      // The original pipeline error remains authoritative. The production
      // callback records a bounded cleanup-failure diagnostic when possible.
    }
    throw error;
  }
}
