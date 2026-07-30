import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { importJWK, SignJWT, type JWK } from "jose";

export async function signedLocalAssertion(
  overrides: { audience?: string; issuer?: string } = {},
) {
  const privateJwk = JSON.parse(
    await readFile(".wrangler/local-access-private.jwk", "utf8"),
  ) as JWK;
  const privateKey = await importJWK(privateJwk, "RS256");
  return new SignJWT({ email: "reader@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "local-integration-key" })
    .setIssuer(overrides.issuer ?? "https://local-access.optimist.invalid")
    .setAudience(overrides.audience ?? "optimist-briefing-local")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

export async function authenticateLocalPage(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({
    "CF-Access-Jwt-Assertion": await signedLocalAssertion(),
  });
}
