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
export type DiscoveryMechanism = "api" | "rss" | "search" | "manual";

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
