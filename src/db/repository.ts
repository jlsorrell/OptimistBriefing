import { z } from "zod";

import { READER_PROFILE } from "../config/reader-profile";
import type {
  ArchiveSearchPage,
  EditionPage,
} from "../contracts/api";
import {
  EditionSectionSchema,
  SourceRefSchema,
  type Edition,
  type EditionEntry,
  type EditionSection,
  type EditionWithEntries,
  type EditionMetadata,
  type Item,
  type ItemScore,
  type ResearchAssessment,
  type RetentionReport,
  type SourceRef,
  type StructuredSummary,
} from "../contracts/editorial";
import type {
  CollectionFailureKind,
  DiscoveryDiagnosticsState,
  DiscoveryLaneDiagnostic,
  DiscoveryObservation,
} from "../sources/types";
import { DiscoveryLaneDiagnosticSchema } from "../sources/types";
import type { BudgetReservation } from "../models/budget-gate";

export type EditionListInput = {
  limit: number;
  cursor: string | null;
  editionDateNotAfter?: string;
};

export type ArchiveSearchInput = {
  query: string | null;
  topic: string | null;
  author: string | null;
  institution: string | null;
  source: string | null;
  section: EditionSection | null;
  limit: number;
  cursor: string | null;
  saved?: boolean;
  editionDateNotAfter?: string;
};

export type FeedbackAction =
  | "save"
  | "unsave"
  | "more_like_this"
  | "less_like_this";

export type FeedbackReason =
  | "topic"
  | "quality"
  | "source"
  | "depth"
  | "repetitive"
  | "too_incremental"
  | "other";

export type FeedbackInput = {
  itemId: string;
  action: FeedbackAction;
  reason: FeedbackReason | null;
};

export type FeedbackRecord = FeedbackInput & {
  id: string;
  adjustments: readonly FeedbackAdjustment[];
  createdAt: string;
};

export type PreferenceDimension = "topic" | "source";

export type FeedbackAdjustment = {
  dimension: PreferenceDimension;
  key: string;
  delta: number;
  resultingWeight: number;
};

export type PreferenceValues = {
  topicWeights: Record<string, number>;
  sourceWeights: Record<string, number>;
  institutionWeights: Record<string, number>;
  sectionBudgets: Partial<Record<EditionSection, number>>;
};

export type ReaderPreferences = PreferenceValues & {
  baseline: PreferenceValues;
  feedbackHistory: readonly FeedbackRecord[];
};

export type PreferenceUpdateInput = PreferenceValues;

export type SourceHealth = "unknown" | "healthy" | "degraded" | "failing";
export type DiscoveryMechanism =
  | "api"
  | "rss"
  | "page"
  | "search"
  | "manual";

export type SourceRecord = {
  id: string;
  canonicalName: string;
  canonicalUrl: string;
  role: SourceRef["role"];
  trustPrior: number;
  enabled: boolean;
  restrictions: Record<string, unknown>;
  discoveryMechanism: DiscoveryMechanism;
  sectionEligibility: readonly EditionSection[];
  lastSuccessAt: string | null;
  healthStatus: SourceHealth;
};

export type CreateSourceInput = Omit<
  SourceRecord,
  "lastSuccessAt" | "healthStatus"
>;

export type UpdateSourceInput = Partial<
  Omit<CreateSourceInput, "id">
>;

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "retryable"
  | "published"
  | "partial"
  | "failed";

export type WorkflowRun = {
  id: string;
  editionDate: string;
  status: WorkflowRunStatus;
  currentStep: string | null;
  retryable: boolean;
  attemptCount: number;
  failureCode: string | null;
  estimatedCostUsd: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowCheckpointStatus = {
  step: string;
  state: "completed";
  attempts: number;
  itemCount: number;
};

export type WorkflowFailure = {
  step: string;
  attempt: number;
  reason: string;
};

export type WorkflowRunDetail = WorkflowRun & {
  checkpoints: readonly WorkflowCheckpointStatus[];
  failures: readonly WorkflowFailure[];
  sourceFailures: readonly string[];
  discoveryDiagnostics: readonly DiscoveryLaneDiagnostic[];
  rejectedSummaryReasons: readonly string[];
  publishedAt: string | null;
  estimatedMonthlyCostUsd: number;
};

export type ModelUsageRecord = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  embeddingCount: number;
  unitPriceUsd: number;
  estimatedCostUsd: number;
};

export type ReserveModelBudgetInput = {
  reservationId: string;
  runId: string;
  monthStart: string;
  maximumCostMicrousd: number;
  monthlyLimitMicrousd: number;
  reservedAt: string;
};

export type ReconcileModelBudgetInput = {
  reservationId: string;
  runId: string;
  actualCostMicrousd: number;
  reconciledAt: string;
};

export type ReleaseModelBudgetInput = {
  reservationId: string;
  runId: string;
  releasedAt: string;
};

export type ReleaseRunModelBudgetInput = {
  runId: string;
  releasedAt: string;
};

export type ReleasedRunModelBudget = {
  releasedReservations: number;
  releasedMaximumCostMicrousd: number;
};

export type TerminalModelBudgetCleanupAuditInput = ReleasedRunModelBudget & {
  runId: string;
  failureCode: "WORKER_MEMORY_LIMIT" | "PIPELINE_TERMINAL_FAILURE";
  outcome: "released" | "failed";
  occurredAt: string;
};

export class RepositoryValidationError extends Error {
  readonly code = "REPOSITORY_VALIDATION_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryValidationError";
  }
}

export class SourceAlreadyExistsError extends Error {
  readonly code = "SOURCE_ALREADY_EXISTS";

  constructor() {
    super("A source with that canonical URL already exists.");
    this.name = "SourceAlreadyExistsError";
  }
}

export class SourceIdAlreadyExistsError extends Error {
  readonly code = "SOURCE_ID_ALREADY_EXISTS";

  constructor() {
    super("A source with that identifier already exists.");
    this.name = "SourceIdAlreadyExistsError";
  }
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

function jsonMutationError(
  context: string,
  path: string,
  message: string,
  cause?: unknown,
): RepositoryValidationError {
  return new RepositoryValidationError(
    `${context} at ${path}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function arrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function toJsonValue(
  value: unknown,
  context: string,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw jsonMutationError(
        context,
        path,
        "numbers must be finite",
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw jsonMutationError(
      context,
      path,
      `${typeof value} is not a JSON value`,
    );
  }
  if (ancestors.has(value)) {
    throw jsonMutationError(context, path, "cyclic values are not JSON");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") {
          throw jsonMutationError(
            context,
            path,
            "symbol keys are not JSON",
          );
        }
        if (key !== "length" && !arrayIndexKey(key, value.length)) {
          throw jsonMutationError(
            context,
            `${path}.${key}`,
            "non-index array properties are not JSON",
          );
        }
      }

      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw jsonMutationError(
            context,
            `${path}[${index}]`,
            "sparse array entries are not exact JSON values",
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw jsonMutationError(
            context,
            `${path}[${index}]`,
            "array accessors and non-enumerable entries are not JSON",
          );
        }
        result.push(
          toJsonValue(
            descriptor.value,
            context,
            `${path}[${index}]`,
            ancestors,
          ),
        );
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw jsonMutationError(
        context,
        path,
        "only plain objects are JSON mutation values",
      );
    }

    const result = Object.create(null) as {
      [key: string]: JsonValue;
    };
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw jsonMutationError(
          context,
          path,
          "symbol keys are not JSON",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw jsonMutationError(
          context,
          `${path}.${key}`,
          "accessors and non-enumerable properties are not JSON",
        );
      }
      result[key] = toJsonValue(
        descriptor.value,
        context,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RepositoryValidationError) {
      throw error;
    }
    throw jsonMutationError(
      context,
      path,
      "could not inspect JSON mutation value",
      error,
    );
  } finally {
    ancestors.delete(value);
  }
}

export function serializeJsonMutation(
  value: unknown,
  context: string,
): string {
  const jsonValue = toJsonValue(value, context, "$", new WeakSet());
  const parsed = JsonValueSchema.safeParse(jsonValue);
  if (!parsed.success) {
    throw new RepositoryValidationError(
      `${context}: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return JSON.stringify(jsonValue);
}

export const FeedbackActionSchema = z.enum([
  "save",
  "unsave",
  "more_like_this",
  "less_like_this",
]);

export const FeedbackReasonSchema = z.enum([
  "topic",
  "quality",
  "source",
  "depth",
  "repetitive",
  "too_incremental",
  "other",
]);

export const FeedbackInputSchema = z.object({
  itemId: z.string().min(1),
  action: FeedbackActionSchema,
  reason: FeedbackReasonSchema.nullable(),
}).strict();

export const FeedbackAdjustmentSchema = z.object({
  dimension: z.enum(["topic", "source"]),
  key: z.string().min(1),
  delta: z.number().finite(),
  resultingWeight: z.number().finite(),
}).strict();

export const FeedbackRecordSchema = FeedbackInputSchema.extend({
  id: z.string().min(1),
  adjustments: z.array(FeedbackAdjustmentSchema),
  createdAt: z.string().datetime(),
}).strict();

const FiniteWeightMapSchema = z.record(
  z.string(),
  z.number().finite(),
);

export const PreferenceValuesSchema = z.object({
  topicWeights: FiniteWeightMapSchema,
  sourceWeights: FiniteWeightMapSchema,
  institutionWeights: FiniteWeightMapSchema,
  sectionBudgets: z.record(
    EditionSectionSchema,
    z.number().finite().nonnegative(),
  ),
}).strict();

export const ReaderPreferencesSchema = PreferenceValuesSchema.extend({
  baseline: PreferenceValuesSchema,
  feedbackHistory: z.array(FeedbackRecordSchema),
}).strict();

export const PreferenceUpdateInputSchema = PreferenceValuesSchema;

export function approvedBaselinePreferences(): PreferenceValues {
  return {
    topicWeights: Object.fromEntries(
      READER_PROFILE.researchTopics.map((topic) => [topic.id, 1]),
    ),
    sourceWeights: {},
    institutionWeights: Object.fromEntries(
      [
        ...READER_PROFILE.preferredInstitutions,
        ...READER_PROFILE.preferredLabs,
      ].map((institution) => [institution, 1]),
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
  };
}

export const SourceHealthSchema = z.enum([
  "unknown",
  "healthy",
  "degraded",
  "failing",
]);

export const DiscoveryMechanismSchema = z.enum([
  "api",
  "rss",
  "page",
  "search",
  "manual",
]);

export const SourceRecordSchema = z.object({
  id: z.string().trim().min(1),
  canonicalName: z.string().trim().min(1),
  canonicalUrl: z.string().trim().url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  }, "Canonical source URL must be HTTPS without credentials or a fragment"),
  role: SourceRefSchema.shape.role,
  trustPrior: z.number().finite().min(0).max(1),
  enabled: z.boolean(),
  restrictions: z.record(z.string(), z.unknown()),
  discoveryMechanism: DiscoveryMechanismSchema,
  sectionEligibility: z.array(EditionSectionSchema),
  lastSuccessAt: z.string().datetime().nullable(),
  healthStatus: SourceHealthSchema,
}).strict();

export const CreateSourceInputSchema = SourceRecordSchema.omit({
  lastSuccessAt: true,
  healthStatus: true,
}).extend({
  sectionEligibility: z.array(EditionSectionSchema).min(1),
}).strict();

export const UpdateSourceInputSchema = CreateSourceInputSchema.omit({
  id: true,
}).partial().strict();

export const WorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "retryable",
  "published",
  "partial",
  "failed",
]);

export const WorkflowRunSchema = z.object({
  id: z.string().min(1),
  editionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: WorkflowRunStatusSchema,
  currentStep: z.string().min(1).nullable(),
  retryable: z.boolean(),
  attemptCount: z.number().int().nonnegative(),
  failureCode: z.string().min(1).nullable(),
  estimatedCostUsd: z.number().finite().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const WorkflowRunDetailSchema = WorkflowRunSchema.extend({
  checkpoints: z.array(z.object({
    step: z.string().min(1),
    state: z.literal("completed"),
    attempts: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
  }).strict()),
  failures: z.array(z.object({
    step: z.string().min(1),
    attempt: z.number().int().positive(),
    reason: z.string().min(1),
  }).strict()),
  sourceFailures: z.array(z.string().min(1)),
  discoveryDiagnostics: z.array(
    DiscoveryLaneDiagnosticSchema.superRefine((diagnostic, context) => {
      for (const field of ["laneId", "sourceId"] as const) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(diagnostic[field])) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Diagnostic identifiers must use the public ID format.",
            path: [field],
          });
        }
      }
    }),
  ).max(64),
  rejectedSummaryReasons: z.array(z.string().min(1)),
  publishedAt: z.string().datetime().nullable(),
  estimatedMonthlyCostUsd: z.number().finite().nonnegative(),
}).strict();

export const DiscoveryDiagnosticsSchema =
  WorkflowRunDetailSchema.shape.discoveryDiagnostics;

export interface BriefingRepository {
  upsertDiscoveryObservations(
    observations: readonly DiscoveryObservation[],
  ): Promise<void>;
  getDiscoveryObservations(
    canonicalIds: readonly string[],
    since: string,
    excludingRunId: string,
  ): Promise<readonly DiscoveryObservation[]>;
  getCachedResearchAssessment(
    canonicalId: string,
    evidenceFingerprint: string,
    now: string,
  ): Promise<ResearchAssessment | null>;
  getCachedResearchTopicalFit?(
    canonicalId: string,
    evidenceFingerprint: string,
    now: string,
  ): Promise<number | null>;
  putCachedResearchAssessment(
    canonicalId: string,
    evidenceFingerprint: string,
    assessment: ResearchAssessment,
    expiresAt: string,
    topicalFit?: number,
  ): Promise<void>;
  upsertItems(items: readonly Item[]): Promise<void>;
  saveScores(scores: readonly ItemScore[]): Promise<void>;
  saveSummary(itemId: string, summary: StructuredSummary): Promise<void>;
  createDraftEdition(editionDate: string, runId: string, metadata?: EditionMetadata): Promise<Edition>;
  replaceEditionEntries(
    editionId: string,
    entries: readonly EditionEntry[],
  ): Promise<void>;
  publishEdition(
    editionId: string,
    publishedAt: string,
    status: "published" | "partial",
  ): Promise<void>;
  persistEdition(
    editionDate: string,
    runId: string,
    entries: readonly EditionEntry[],
    status: "draft" | "published" | "partial",
    metadata: EditionMetadata,
  ): Promise<Edition>;
  getLatestEdition(
    editionDateNotAfter?: string,
  ): Promise<EditionWithEntries | null>;
  getEditionByDate(
    editionDate: string,
  ): Promise<EditionWithEntries | null>;
  listEditions(input: EditionListInput): Promise<EditionPage>;
  searchArchive(input: ArchiveSearchInput): Promise<ArchiveSearchPage>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  getPreferences(): Promise<ReaderPreferences>;
  updatePreferences(input: PreferenceUpdateInput): Promise<ReaderPreferences>;
  removeFeedbackAdjustment(feedbackId: string): Promise<ReaderPreferences>;
  resetPreferences(): Promise<ReaderPreferences>;
  listSources(): Promise<readonly SourceRecord[]>;
  recordSourceOutcome(
    sourceId: string,
    outcome: "success" | CollectionFailureKind,
    occurredAt: string,
  ): Promise<void>;
  createSource(input: CreateSourceInput): Promise<SourceRecord>;
  updateSource(
    sourceId: string,
    input: UpdateSourceInput,
    actorEmail: string,
  ): Promise<SourceRecord>;
  listWorkflowRuns(): Promise<readonly WorkflowRun[]>;
  getWorkflowRun(runId: string): Promise<WorkflowRun | null>;
  getWorkflowRunDetail(runId: string): Promise<WorkflowRunDetail | null>;
  getDiscoveryDiagnosticsState(
    runId: string,
  ): Promise<DiscoveryDiagnosticsState | null>;
  recordDiscoveryDiagnostics(
    runId: string,
    diagnostics: readonly DiscoveryLaneDiagnostic[],
    rejectionCountsByStage?: DiscoveryDiagnosticsState["rejectionCountsByStage"],
  ): Promise<void>;
  recordModelUsage(runId: string, usage: ModelUsageRecord): Promise<void>;
  listMonthlyModelUsage(monthStart: string): Promise<readonly ModelUsageRecord[]>;
  reserveModelBudget(
    input: ReserveModelBudgetInput,
  ): Promise<BudgetReservation | null>;
  reconcileModelBudget(input: ReconcileModelBudgetInput): Promise<void>;
  releaseModelBudget(input: ReleaseModelBudgetInput): Promise<void>;
  releaseRunModelBudget(
    input: ReleaseRunModelBudgetInput,
  ): Promise<ReleasedRunModelBudget>;
  recordTerminalModelBudgetCleanup(
    input: TerminalModelBudgetCleanupAuditInput,
  ): Promise<void>;
  recordRetentionAudit(now: string, report: RetentionReport): Promise<void>;
  pruneExpiredData(now: string): Promise<RetentionReport>;
}
