import { createAccessVerifier, parseAllowedEmails } from "./auth/access";
import { createApp } from "./api/app";
import { internalErrorResponse } from "./api/errors";
import { D1BriefingRepository } from "./db/d1-repository";
import { createD1WorkflowLauncher } from "./workflow/run-editorial-pipeline";
import { OpenAIModelProvider } from "./models/openai-provider";

export interface Env {
  DB: D1Database;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
  ALLOWED_EMAILS: string;
  OPENAI_API_KEY: string;
  SUMMARY_MODEL: string;
  ASSESSMENT_MODEL: string;
  EMBEDDING_MODEL: string;
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
        workflow: createD1WorkflowLauncher(env.DB, {
          summary: new OpenAIModelProvider({
            apiKey: requiredBinding(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
            generationModel: requiredBinding(env.SUMMARY_MODEL, "SUMMARY_MODEL"),
            embeddingModel: requiredBinding(env.EMBEDDING_MODEL, "EMBEDDING_MODEL"),
          }),
          assessment: new OpenAIModelProvider({
            apiKey: requiredBinding(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
            generationModel: requiredBinding(env.ASSESSMENT_MODEL, "ASSESSMENT_MODEL"),
            embeddingModel: requiredBinding(env.EMBEDDING_MODEL, "EMBEDDING_MODEL"),
          }),
        }),
      });
      return app.fetch(request);
    } catch {
      return internalErrorResponse();
    }
  },
} satisfies ExportedHandler<Env>;

function requiredBinding(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}
