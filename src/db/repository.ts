import { z } from "zod";

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
  type Item,
  type ItemScore,
  type RetentionReport,
  type SourceRef,
  type StructuredSummary,
} from "../contracts/editorial";

export type EditionListInput = {
  limit: number;
  cursor: string | null;
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
  createdAt: string;
};

export type ReaderPreferences = {
  topicWeights: Record<string, number>;
  sourceWeights: Record<string, number>;
  institutionWeights: Record<string, number>;
  sectionBudgets: Partial<Record<EditionSection, number>>;
  feedbackHistory: readonly FeedbackRecord[];
};

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

export class RepositoryValidationError extends Error {
  readonly code = "REPOSITORY_VALIDATION_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryValidationError";
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
});

export const FeedbackRecordSchema = FeedbackInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
});

const FiniteWeightMapSchema = z.record(
  z.string(),
  z.number().finite(),
);

export const ReaderPreferencesSchema = z.object({
  topicWeights: FiniteWeightMapSchema,
  sourceWeights: FiniteWeightMapSchema,
  institutionWeights: FiniteWeightMapSchema,
  sectionBudgets: z.record(
    EditionSectionSchema,
    z.number().finite().nonnegative(),
  ),
  feedbackHistory: z.array(FeedbackRecordSchema),
});

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
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  canonicalUrl: z.string().url(),
  role: SourceRefSchema.shape.role,
  trustPrior: z.number().finite().min(0).max(1),
  enabled: z.boolean(),
  restrictions: z.record(z.string(), z.unknown()),
  discoveryMechanism: DiscoveryMechanismSchema,
  sectionEligibility: z.array(EditionSectionSchema),
  lastSuccessAt: z.string().datetime().nullable(),
  healthStatus: SourceHealthSchema,
});

export const CreateSourceInputSchema = SourceRecordSchema.omit({
  lastSuccessAt: true,
  healthStatus: true,
});

export const UpdateSourceInputSchema = CreateSourceInputSchema.omit({
  id: true,
}).partial();

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
});

export interface BriefingRepository {
  upsertItems(items: readonly Item[]): Promise<void>;
  saveScores(scores: readonly ItemScore[]): Promise<void>;
  saveSummary(itemId: string, summary: StructuredSummary): Promise<void>;
  createDraftEdition(editionDate: string, runId: string): Promise<Edition>;
  replaceEditionEntries(
    editionId: string,
    entries: readonly EditionEntry[],
  ): Promise<void>;
  publishEdition(
    editionId: string,
    publishedAt: string,
    status: "published" | "partial",
  ): Promise<void>;
  getLatestEdition(): Promise<EditionWithEntries | null>;
  getEditionByDate(
    editionDate: string,
  ): Promise<EditionWithEntries | null>;
  listEditions(input: EditionListInput): Promise<EditionPage>;
  searchArchive(input: ArchiveSearchInput): Promise<ArchiveSearchPage>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  getPreferences(): Promise<ReaderPreferences>;
  listSources(): Promise<readonly SourceRecord[]>;
  createSource(input: CreateSourceInput): Promise<SourceRecord>;
  updateSource(
    sourceId: string,
    input: UpdateSourceInput,
  ): Promise<SourceRecord>;
  getWorkflowRun(runId: string): Promise<WorkflowRun | null>;
  pruneExpiredData(now: string): Promise<RetentionReport>;
}
