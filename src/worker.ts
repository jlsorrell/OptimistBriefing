import { createAccessVerifier, parseAllowedEmails } from "./auth/access";
import { createApp } from "./api/app";
import { internalErrorResponse } from "./api/errors";
import { D1BriefingRepository } from "./db/d1-repository";
import { createDurableWorkflowLauncher } from "./workflow/manual-controls";
import { coordinateScheduledBriefing } from "./workflow/schedule";
import type { RunParams } from "./workflow/daily-briefing-workflow";
export { DailyBriefingWorkflow } from "./workflow/daily-briefing-workflow";
export { coordinateScheduledBriefing };

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
        workflow: createDurableWorkflowLauncher(env.DB, env.DAILY_BRIEFING),
      });
      return app.fetch(request);
    } catch {
      return internalErrorResponse();
    }
  },
  async scheduled(_controller, env: Env): Promise<void> {
    const repository = new D1BriefingRepository(env.DB);
    await coordinateScheduledBriefing({
      listRuns: () => repository.listWorkflowRuns(),
      workflow: env.DAILY_BRIEFING,
    }, new Date());
  },
} satisfies ExportedHandler<Env>;

function requiredBinding(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}
