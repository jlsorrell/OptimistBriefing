import { z } from "zod";

import { createApp, type AuthVerifier } from "./api/app";
import {
  AuthenticationRequiredError,
  ForbiddenError,
  errorBody,
} from "./api/errors";
import {
  localJwksVerifier,
  parseAllowedEmails,
} from "./auth/access";
import { D1BriefingRepository } from "./db/d1-repository";

interface LocalEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  LOCAL_ACCESS_ISSUER: string;
  LOCAL_ACCESS_AUDIENCE: string;
  LOCAL_ALLOWED_EMAILS: string;
  LOCAL_ACCESS_JWKS_B64: string;
}

const JwksSchema = z.object({
  keys: z
    .array(
      z
        .object({
          kty: z.string().min(1),
          kid: z.string().min(1),
        })
        .passthrough(),
    )
    .min(1),
});

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Local JWKS binding must be base64url.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function localVerifier(env: LocalEnv): AuthVerifier {
  const jwks = JwksSchema.parse(
    JSON.parse(decodeBase64Url(env.LOCAL_ACCESS_JWKS_B64)),
  );
  return localJwksVerifier(jwks, {
    issuer: env.LOCAL_ACCESS_ISSUER,
    audience: env.LOCAL_ACCESS_AUDIENCE,
    allowedEmails: parseAllowedEmails(env.LOCAL_ALLOWED_EMAILS),
  });
}

function authError(error: AuthenticationRequiredError | ForbiddenError) {
  return new Response(JSON.stringify(errorBody(error)), {
    status: error.status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

export default {
  async fetch(request: Request, env: LocalEnv): Promise<Response> {
    const verifier = localVerifier(env);
    const repository = new D1BriefingRepository(env.DB);
    const app = createApp({
      repository,
      authVerifier: verifier,
      workflow: null,
    });
    const pathname = new URL(request.url).pathname;

    if (pathname === "/health" || pathname.startsWith("/api/")) {
      return app.fetch(request);
    }

    const assertion = request.headers.get("CF-Access-Jwt-Assertion");
    if (assertion === null || assertion.length === 0) {
      return authError(new AuthenticationRequiredError());
    }
    try {
      await verifier(assertion);
    } catch (error) {
      return authError(
        error instanceof ForbiddenError
          ? error
          : new AuthenticationRequiredError(),
      );
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<LocalEnv>;
