import { z } from "zod";

import {
  EditionSectionSchema,
  ItemSchema,
  ItemScoreSchema,
  ResearchAssessmentSchema,
} from "../contracts/editorial";
import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
  Item,
  StructuredSummary,
} from "../contracts/editorial";
import {
  NewsDevelopmentSchema,
} from "../editorial/cluster";
import { NewsScoreSchema } from "../editorial/news-score";
import {
  RawNewsCandidateSchema,
  RawResearchCandidateSchema,
} from "../sources/types";
import type { BudgetPolicy } from "../models/cost-ledger";
import type { ReaderPreferences } from "../db/repository";

export const PIPELINE_STEPS = [
  "collect",
  "normalize",
  "enrich",
  "prefilter",
  "assess",
  "score",
  "cluster",
  "shortlist",
  "synthesize",
  "validate",
  "compose",
  "publish",
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type PipelineStatus = "published" | "partial" | "failed" | "retryable";

export const CollectedCandidateSchema = z.union([
  ItemSchema,
  RawResearchCandidateSchema,
  RawNewsCandidateSchema,
]);

export type CollectedCandidate = z.infer<typeof CollectedCandidateSchema>;

export const WorkflowItemPayloadSchema = z.object({
  version: z.literal(1),
  rawResearch: RawResearchCandidateSchema.optional(),
  embedding: z.array(z.number().finite()).min(1).max(4_096).optional(),
  topicalFit: z.number().finite().min(0).max(1).optional(),
  personalRelevance: z.number().finite().min(0).max(1).optional(),
  assessment: ResearchAssessmentSchema.strict().optional(),
  researchScore: ItemScoreSchema.strict().optional(),
  newsScore: NewsScoreSchema.strict().optional(),
  development: NewsDevelopmentSchema.strict().optional(),
  developmentScore: NewsScoreSchema.strict().optional(),
  section: EditionSectionSchema.optional(),
  researchTier: z.enum(["featured", "radar"]).optional(),
  selectionReasons: z.array(z.string().min(1).max(300)).max(16).optional(),
}).strict();

export type WorkflowItemPayload = z.infer<
  typeof WorkflowItemPayloadSchema
>;

export const WorkflowItemSchema = ItemSchema.superRefine((item, context) => {
  const workflow = item.metadata.workflow;
  if (workflow === undefined) return;
  const parsed = WorkflowItemPayloadSchema.safeParse(workflow);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => {
      context.addIssue({
        ...issue,
        path: ["metadata", "workflow", ...issue.path],
      });
    });
  }
});

export type PipelineRun = {
  id: string;
  editionDate: string;
  status: "pending" | "running" | PipelineStatus;
  currentStep: PipelineStep | null;
  retryable: boolean;
  attemptCount: number;
  estimatedCostUsd: number;
  createdAt: string;
  updatedAt: string;
  failureCode?: string | null;
};

export type PipelineCheckpointExecutor = <T>(
  step: PipelineStep,
  execute: () => Promise<T>,
) => Promise<T>;

export type CheckpointArtifact<T = unknown> = {
  output: T;
  attempts: number;
  durationMs: number;
  itemCount: number;
  estimatedCostUsd: number;
};

export type PipelineStore = {
  getRun(runId: string): Promise<PipelineRun | null>;
  createRun(run: PipelineRun): Promise<void>;
  saveRun(run: PipelineRun): Promise<void>;
  readPreferenceSnapshot(runId: string): Promise<ReaderPreferences | null>;
  savePreferenceSnapshot(
    runId: string,
    preferences: ReaderPreferences,
  ): Promise<void>;
  readCheckpoint(runId: string, step: PipelineStep): Promise<boolean>;
  saveCheckpoint(
    runId: string,
    step: PipelineStep,
    artifact: CheckpointArtifact,
  ): Promise<void>;
  readArtifact(
    runId: string,
    step: PipelineStep,
  ): Promise<CheckpointArtifact<unknown> | null>;
  beginAttempt(runId: string, step: PipelineStep): Promise<number>;
  failAttempt(runId: string, step: PipelineStep, attempt: number, error: string): Promise<void>;
  invalidateFrom(runId: string, step: PipelineStep): Promise<void>;
  createDraft(edition: Edition): Promise<void>;
  replaceEntries(editionId: string, entries: readonly EditionEntry[]): Promise<void>;
  publish(editionId: string, status: "published" | "partial"): Promise<void>;
  getLatestEdition(): Promise<EditionWithEntries | null>;
  persistEdition(
    edition: Edition,
    entries: readonly EditionEntry[],
    status: "draft" | "published" | "partial",
  ): Promise<Edition>;
};

export type SummaryCandidate = {
  item: Item;
  summary: StructuredSummary;
};

export type ValidatedSummaryCandidate = SummaryCandidate & {
  valid: boolean;
  validationErrors?: readonly string[] | undefined;
};

export type PipelineContext = {
  editionDate: string;
  runId: string;
  store: PipelineStore;
  now: () => string;
  collect: () => Promise<readonly CollectedCandidate[]>;
  normalize: (
    items: readonly CollectedCandidate[],
  ) => Promise<readonly Item[]>;
  persistItems?: (items: readonly Item[]) => Promise<void>;
  enrich: (items: readonly Item[]) => Promise<readonly Item[]>;
  prefilter: (items: readonly Item[]) => Promise<readonly Item[]>;
  assess: (items: readonly Item[]) => Promise<readonly Item[]>;
  score: (items: readonly Item[]) => Promise<readonly Item[]>;
  cluster: (items: readonly Item[]) => Promise<readonly Item[]>;
  shortlist: (items: readonly Item[]) => Promise<readonly Item[]>;
  synthesize: (items: readonly Item[]) => Promise<readonly SummaryCandidate[]>;
  validate: (
    entries: readonly SummaryCandidate[],
  ) => Promise<readonly ValidatedSummaryCandidate[]>;
  estimateCostUsd?: (step: PipelineStep, output: unknown) => number;
  sourceFailures?: readonly string[];
  checkpointExecutor?: PipelineCheckpointExecutor;
  budgetPolicy?: BudgetPolicy;
};

export type CompositionResult = {
  edition: Edition;
  entries: readonly EditionEntry[];
  status: "published" | "partial" | "failed";
  missingSections: readonly string[];
  sourceFailures: readonly string[];
};

export type PipelineResult = {
  runId: string;
  status: "published" | "partial" | "failed";
  missingSections: readonly string[];
};
