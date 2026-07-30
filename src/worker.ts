import { createAccessVerifier, parseAllowedEmails } from "./auth/access";
import { createApp } from "./api/app";
import { internalErrorResponse } from "./api/errors";
import { D1BriefingRepository } from "./db/d1-repository";
import { createD1WorkflowLauncher } from "./workflow/run-editorial-pipeline";
import { shouldRunAt } from "./workflow/schedule";
import {
  createBudgetedPipelineRuntimeFactory,
  type RunParams,
} from "./workflow/daily-briefing-workflow";
export { DailyBriefingWorkflow } from "./workflow/daily-briefing-workflow";

export interface Env {
  DB: D1Database;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
  ALLOWED_EMAILS: string;
  OPENAI_API_KEY: string;
  SUMMARY_MODEL: string;
  ASSESSMENT_MODEL: string;
  EMBEDDING_MODEL: string;
  MONTHLY_BUDGET_USD: string;
  SUMMARY_UNIT_PRICE_USD: string;
  ASSESSMENT_UNIT_PRICE_USD: string;
  EMBEDDING_UNIT_PRICE_USD: string;
  DAILY_BRIEFING: Workflow<RunParams>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      requiredBinding(env.ASSESSMENT_MODEL, "ASSESSMENT_MODEL");
      const app = createApp({
        repository: new D1BriefingRepository(env.DB),
        authVerifier: createAccessVerifier({
          teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
          audience: env.CLOUDFLARE_ACCESS_AUDIENCE,
          allowedEmails: parseAllowedEmails(env.ALLOWED_EMAILS),
        }),
        workflow: createD1WorkflowLauncher(
          env.DB,
          createBudgetedPipelineRuntimeFactory(env),
        ),
      });
      return app.fetch(request);
    } catch {
      return internalErrorResponse();
    }
  },
  async scheduled(_controller, env: Env): Promise<void> {
    await coordinateScheduledBriefing(env, new Date());
  },
} satisfies ExportedHandler<Env>;

export async function coordinateScheduledBriefing(
  env: Pick<Env, "DB" | "DAILY_BRIEFING">,
  now: Date,
): Promise<void> {
    const initial = shouldRunAt(now, "America/New_York", { status: "missing" });
    if (!initial.run) return;
    const repository = new D1BriefingRepository(env.DB);
    const run = (await repository.listWorkflowRuns()).find(
      (candidate) => candidate.editionDate === initial.editionDate,
    ) ?? null;
    const decision = shouldRunAt(now, "America/New_York", {
      status: run?.status ?? "missing",
    });
    if (!decision.run) return;
    if (run?.retryable) {
      const instance = await env.DAILY_BRIEFING.get(initial.editionDate);
      const state = await instance.status();
      if (state.status === "unknown") {
        await env.DAILY_BRIEFING.create({
          id: initial.editionDate,
          params: { editionDate: initial.editionDate, runId: run.id },
          retention: { successRetention: "90 days", errorRetention: "90 days" },
        });
      } else if (state.status === "paused") {
        await instance.resume();
      } else if (state.status !== "running" && state.status !== "queued") {
        await instance.restart();
      }
      return;
    }
    if (run !== null) return;
    await env.DAILY_BRIEFING.create({
      id: initial.editionDate,
      params: { editionDate: initial.editionDate, runId: initial.editionDate },
      retention: { successRetention: "90 days", errorRetention: "90 days" },
    });
}

function requiredBinding(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}
