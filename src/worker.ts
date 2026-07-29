import { createAccessVerifier, parseAllowedEmails } from "./auth/access";
import { createApp } from "./api/app";
import { internalErrorResponse } from "./api/errors";
import { D1BriefingRepository } from "./db/d1-repository";

export interface Env {
  DB: D1Database;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
  ALLOWED_EMAILS: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const app = createApp({
        repository: new D1BriefingRepository(env.DB),
        authVerifier: createAccessVerifier({
          teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
          audience: env.CLOUDFLARE_ACCESS_AUDIENCE,
          allowedEmails: parseAllowedEmails(env.ALLOWED_EMAILS),
        }),
        workflow: null,
      });
      return app.fetch(request);
    } catch {
      return internalErrorResponse();
    }
  },
} satisfies ExportedHandler<Env>;
