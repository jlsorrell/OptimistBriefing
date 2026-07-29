import {
  createRemoteJWKSet,
  jwtVerify,
} from "jose";
import { z } from "zod";

import { ForbiddenError } from "../api/errors";
import type { AuthenticatedUser, AuthVerifier } from "../api/app";

export { ForbiddenError } from "../api/errors";
export type { AuthenticatedUser } from "../api/app";

export type AccessVerifierOptions = {
  teamDomain: string;
  audience: string;
  allowedEmails: ReadonlySet<string>;
};

const EmailSchema = z.string().email();
const NonemptyStringSchema = z.string().trim().min(1);

function normalizedEmail(email: string): string {
  return EmailSchema.parse(email.trim()).toLowerCase();
}

function normalizedTeamDomain(teamDomain: string): string {
  const value = NonemptyStringSchema.parse(teamDomain);
  const url = new URL(`https://${value}`);
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("CLOUDFLARE_ACCESS_TEAM_DOMAIN must be a hostname");
  }
  return url.hostname;
}

export function parseAllowedEmails(value: string): ReadonlySet<string> {
  const entries = value.split(",");
  if (entries.length === 0) {
    throw new Error("ALLOWED_EMAILS must include at least one email");
  }

  return new Set(entries.map(normalizedEmail));
}

export function createAccessVerifier(
  options: AccessVerifierOptions,
): AuthVerifier {
  const teamDomain = normalizedTeamDomain(options.teamDomain);
  const audience = NonemptyStringSchema.parse(options.audience);
  const allowedEmails = new Set(
    Array.from(options.allowedEmails, normalizedEmail),
  );
  if (allowedEmails.size === 0) {
    throw new Error("ALLOWED_EMAILS must include at least one email");
  }

  return (token) =>
    verifyAccessJwt(token, { teamDomain, audience, allowedEmails });
}

export async function verifyAccessJwt(
  token: string,
  options: AccessVerifierOptions,
): Promise<AuthenticatedUser> {
  const jwks = createRemoteJWKSet(
    new URL(`https://${options.teamDomain}/cdn-cgi/access/certs`),
  );
  const { payload } = await jwtVerify(token, jwks, {
    audience: options.audience,
    issuer: `https://${options.teamDomain}`,
  });
  const email = normalizedEmail(EmailSchema.parse(payload.email));
  const allowedEmails = new Set(
    Array.from(options.allowedEmails, normalizedEmail),
  );
  if (!allowedEmails.has(email)) {
    throw new ForbiddenError();
  }
  return { email };
}
