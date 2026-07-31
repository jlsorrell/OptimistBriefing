import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
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

export type AccessJwksVerifierOptions = {
  issuer: string;
  audience: string;
  allowedEmails: ReadonlySet<string>;
  jwks: JWTVerifyGetKey;
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
  return createAccessJwksVerifier({
    issuer: `https://${teamDomain}`,
    audience: options.audience,
    allowedEmails: options.allowedEmails,
    jwks: createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    ),
  });
}

export async function verifyAccessJwt(
  token: string,
  options: AccessVerifierOptions,
): Promise<AuthenticatedUser> {
  const teamDomain = normalizedTeamDomain(options.teamDomain);
  return verifyAccessJwtWithJwks(token, {
    issuer: `https://${teamDomain}`,
    audience: options.audience,
    allowedEmails: options.allowedEmails,
    jwks: createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    ),
  });
}

export function createAccessJwksVerifier(
  options: AccessJwksVerifierOptions,
): AuthVerifier {
  const issuer = z.string().url().parse(options.issuer);
  const audience = NonemptyStringSchema.parse(options.audience);
  const allowedEmails = new Set(
    Array.from(options.allowedEmails, normalizedEmail),
  );
  if (allowedEmails.size === 0) {
    throw new Error("ALLOWED_EMAILS must include at least one email");
  }
  return (token) =>
    verifyAccessJwtWithJwks(token, {
      issuer,
      audience,
      allowedEmails,
      jwks: options.jwks,
    });
}

export async function verifyAccessJwtWithJwks(
  token: string,
  options: AccessJwksVerifierOptions,
): Promise<AuthenticatedUser> {
  const { payload } = await jwtVerify(token, options.jwks, {
    audience: NonemptyStringSchema.parse(options.audience),
    issuer: z.string().url().parse(options.issuer),
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

export function localJwksVerifier(
  jwks: JSONWebKeySet,
  options: Omit<AccessJwksVerifierOptions, "jwks">,
): AuthVerifier {
  return createAccessJwksVerifier({
    ...options,
    jwks: createLocalJWKSet(jwks),
  });
}
