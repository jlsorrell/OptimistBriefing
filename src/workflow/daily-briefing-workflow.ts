import type { Env } from "../worker";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { D1BriefingRepository } from "../db/d1-repository";
import { CostLedger } from "../models/cost-ledger";
import { OpenAIModelProvider } from "../models/openai-provider";
import { pruneExpiredData } from "../maintenance/retention";
import { shouldRunAt } from "./schedule";
import {
  D1PipelineStore,
  createD1ProductionPipelineContext,
  runEditorialPipeline,
  type PipelineRuntimeFactory,
} from "./run-editorial-pipeline";
import type { PipelineStep } from "./types";

export const RunParamsSchema = z.object({
  editionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  runId: z.string().min(1).max(200).optional(),
}).strict();

export type RunParams = z.infer<typeof RunParamsSchema>;

const PositiveMoneyBindingSchema = z.string().trim().min(1).max(40)
  .transform(Number)
  .refine((value) => Number.isFinite(value) && value > 0 && value <= 1_000_000);
const MonthlyBudgetBindingSchema = z.string().trim().min(1).max(40)
  .transform(Number)
  .refine((value) => Number.isFinite(value) && value > 0 && value <= 30);

export const ScheduledModelConfigSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).max(4_096),
  SUMMARY_MODEL: z.string().min(1).max(200),
  ASSESSMENT_MODEL: z.string().min(1).max(200),
  EMBEDDING_MODEL: z.string().min(1).max(200),
  MONTHLY_BUDGET_USD: MonthlyBudgetBindingSchema,
  SUMMARY_UNIT_PRICE_USD: PositiveMoneyBindingSchema,
  ASSESSMENT_UNIT_PRICE_USD: PositiveMoneyBindingSchema,
  EMBEDDING_UNIT_PRICE_USD: PositiveMoneyBindingSchema,
}).strict();

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

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function createBudgetedPipelineRuntimeFactory(
  env: Pick<
    Env,
    | "DB"
    | "OPENAI_API_KEY"
    | "SUMMARY_MODEL"
    | "ASSESSMENT_MODEL"
    | "EMBEDDING_MODEL"
    | "MONTHLY_BUDGET_USD"
    | "SUMMARY_UNIT_PRICE_USD"
    | "ASSESSMENT_UNIT_PRICE_USD"
    | "EMBEDDING_UNIT_PRICE_USD"
  >,
  clock: () => Date = () => new Date(),
): PipelineRuntimeFactory {
  const config = ScheduledModelConfigSchema.parse({
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    SUMMARY_MODEL: env.SUMMARY_MODEL,
    ASSESSMENT_MODEL: env.ASSESSMENT_MODEL,
    EMBEDDING_MODEL: env.EMBEDDING_MODEL,
    MONTHLY_BUDGET_USD: env.MONTHLY_BUDGET_USD,
    SUMMARY_UNIT_PRICE_USD: env.SUMMARY_UNIT_PRICE_USD,
    ASSESSMENT_UNIT_PRICE_USD: env.ASSESSMENT_UNIT_PRICE_USD,
    EMBEDDING_UNIT_PRICE_USD: env.EMBEDDING_UNIT_PRICE_USD,
  });
  return async ({ runId }) => {
    const repository = new D1BriefingRepository(env.DB);
    const ledger = new CostLedger({
      monthlyLimitUsd: config.MONTHLY_BUDGET_USD,
      unitPricesUsd: {
        [config.SUMMARY_MODEL]: config.SUMMARY_UNIT_PRICE_USD,
        [config.ASSESSMENT_MODEL]: config.ASSESSMENT_UNIT_PRICE_USD,
        [config.EMBEDDING_MODEL]: config.EMBEDDING_UNIT_PRICE_USD,
      },
    });
    for (const record of await repository.listMonthlyModelUsage(monthStart(clock()))) {
      ledger.record(record);
    }
    const recordUsage = async (usage: Parameters<CostLedger["record"]>[0]) => {
      await repository.recordModelUsage(runId, ledger.record(usage));
    };
    const providerOptions = {
      apiKey: config.OPENAI_API_KEY,
      embeddingModel: config.EMBEDDING_MODEL,
      onUsage: recordUsage,
    };
    return {
      providers: {
        summary: new OpenAIModelProvider({
          ...providerOptions,
          generationModel: config.SUMMARY_MODEL,
        }),
        assessment: new OpenAIModelProvider({
          ...providerOptions,
          generationModel: config.ASSESSMENT_MODEL,
        }),
      },
      budgetPolicy: ledger.policy,
    };
  };
}

export class DailyBriefingWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep): Promise<unknown> {
    const now = event.timestamp;
    const repository = new D1BriefingRepository(this.env.DB);
    const params = RunParamsSchema.parse(event.payload);
    const requestedDate = params.editionDate;
    const provisional = shouldRunAt(now, "America/New_York", { status: "missing" });
    const editionDate = requestedDate ?? provisional.editionDate;
    const existing = await repository.getWorkflowRun(editionDate);
    const decision = shouldRunAt(now, "America/New_York", {
      status: existing?.status ?? "missing",
    });
    if (requestedDate === undefined && !decision.run) return decision;
    if (existing?.status === "published") return decision;

    const runId = params.runId ?? editionDate;
    const runtime = await createBudgetedPipelineRuntimeFactory(
      this.env,
      () => now,
    )({ runId, editionDate });
    const context = createD1ProductionPipelineContext(
      new D1PipelineStore(this.env.DB),
      editionDate,
      runId,
      runtime.providers,
      {
        ...(runtime.budgetPolicy === undefined
          ? {}
          : { budgetPolicy: runtime.budgetPolicy }),
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
