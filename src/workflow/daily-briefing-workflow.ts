import type { Env } from "../worker";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { D1BriefingRepository } from "../db/d1-repository";
import { CostLedger } from "../models/cost-ledger";
import { OpenAIModelProvider } from "../models/openai-provider";
import { pruneExpiredData } from "../maintenance/retention";
import { shouldRunAt } from "./schedule";
import {
  D1PipelineStore,
  createD1ProductionPipelineContext,
  runEditorialPipeline,
} from "./run-editorial-pipeline";
import type { PipelineStep } from "./types";

export type RunParams = {
  editionDate?: string;
  runId?: string;
};

type WorkflowStepLike = {
  do<T>(
    name: string,
    config: { timeout: string; retries: { limit: number; delay: string; backoff: "exponential" } },
    operation: () => Promise<T>,
  ): Promise<T>;
};

const CHECKPOINT_OPTIONS = {
  timeout: "10 minutes",
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" as const },
};

export function runCheckpointWithWorkflowStep<T>(
  step: WorkflowStepLike,
  checkpoint: PipelineStep,
  operation: () => Promise<T>,
): Promise<T> {
  return step.do(checkpoint, CHECKPOINT_OPTIONS, operation);
}

function numberBinding(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export class DailyBriefingWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep): Promise<unknown> {
    const now = event.timestamp;
    const repository = new D1BriefingRepository(this.env.DB);
    const requestedDate = event.payload.editionDate;
    const provisional = shouldRunAt(now, "America/New_York", { status: "missing" });
    const editionDate = requestedDate ?? provisional.editionDate;
    const existing = await repository.getWorkflowRun(editionDate);
    const decision = shouldRunAt(now, "America/New_York", {
      status: existing?.status ?? "missing",
    });
    if (requestedDate === undefined && !decision.run) return decision;
    if (existing?.status === "published") return decision;

    const ledger = new CostLedger({
      monthlyLimitUsd: numberBinding(this.env.MONTHLY_BUDGET_USD, "MONTHLY_BUDGET_USD"),
      unitPricesUsd: {
        [this.env.SUMMARY_MODEL]: numberBinding(this.env.SUMMARY_UNIT_PRICE_USD, "SUMMARY_UNIT_PRICE_USD"),
        [this.env.ASSESSMENT_MODEL]: numberBinding(this.env.ASSESSMENT_UNIT_PRICE_USD, "ASSESSMENT_UNIT_PRICE_USD"),
        [this.env.EMBEDDING_MODEL]: numberBinding(this.env.EMBEDDING_UNIT_PRICE_USD, "EMBEDDING_UNIT_PRICE_USD"),
      },
    });
    for (const record of await repository.listMonthlyModelUsage(monthStart(now))) {
      ledger.record({
        provider: record.provider,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        embeddingCount: record.embeddingCount,
      });
    }
    const runId = event.payload.runId ?? editionDate;
    const recordUsage = async (usage: {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      embeddingCount: number;
    }) => {
      const record = ledger.record(usage);
      await repository.recordModelUsage(runId, record);
    };
    const providerOptions = {
      apiKey: this.env.OPENAI_API_KEY,
      embeddingModel: this.env.EMBEDDING_MODEL,
      onUsage: recordUsage,
    };
    const context = createD1ProductionPipelineContext(
      new D1PipelineStore(this.env.DB),
      editionDate,
      runId,
      {
        summary: new OpenAIModelProvider({
          ...providerOptions,
          generationModel: this.env.SUMMARY_MODEL,
        }),
        assessment: new OpenAIModelProvider({
          ...providerOptions,
          generationModel: this.env.ASSESSMENT_MODEL,
        }),
      },
      {
        budgetPolicy: ledger.policy,
        checkpointExecutor: (checkpoint, operation) =>
          runCheckpointWithWorkflowStep(step as unknown as WorkflowStepLike, checkpoint, operation),
      },
    );
    const result = await runEditorialPipeline(context);
    if (result.status === "published" || result.status === "partial") {
      await pruneExpiredData(repository, new Date().toISOString());
    }
    return result;
  }
}
