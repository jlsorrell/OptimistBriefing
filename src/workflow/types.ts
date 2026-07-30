import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
  Item,
  StructuredSummary,
} from "../contracts/editorial";

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
  readCheckpoint(runId: string, step: PipelineStep): Promise<boolean>;
  saveCheckpoint(
    runId: string,
    step: PipelineStep,
    artifact: CheckpointArtifact,
  ): Promise<void>;
  readArtifact<T>(
    runId: string,
    step: PipelineStep,
  ): Promise<CheckpointArtifact<T> | null>;
  createDraft(edition: Edition): Promise<void>;
  replaceEntries(editionId: string, entries: readonly EditionEntry[]): Promise<void>;
  publish(editionId: string, status: "published" | "partial"): Promise<void>;
  getLatestEdition(): Promise<EditionWithEntries | null>;
};

export type SummaryCandidate = {
  item: Item;
  summary: StructuredSummary;
};

export type ValidatedSummaryCandidate = SummaryCandidate & {
  valid: boolean;
  validationErrors?: readonly string[];
};

export type PipelineContext = {
  editionDate: string;
  runId: string;
  store: PipelineStore;
  now: () => string;
  collect: () => Promise<readonly Item[]>;
  normalize: (items: readonly Item[]) => Promise<readonly Item[]>;
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
