import {
  SignJWT,
  exportJWK,
  generateKeyPair,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ForbiddenError,
  createAccessVerifier,
  verifyAccessJwt,
} from "../../../src/auth/access";

const teamDomain = "team.example.cloudflareaccess.com";
const audience = "briefing-audience";

async function signedToken(input: {
  email: string;
  audience?: string;
  expiresAt?: string;
}) {
  const keys = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key" };
  const token = await new SignJWT({ email: input.email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(`https://${teamDomain}`)
    .setAudience(input.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime(input.expiresAt ?? "5m")
    .sign(keys.privateKey);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | RequestInfo) => {
      expect(String(url)).toBe(
        `https://${teamDomain}/cdn-cgi/access/certs`,
      );
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );

  return token;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyAccessJwt", () => {
  it("returns a normalized allowed email from a valid Access JWT", async () => {
    const token = await signedToken({ email: "Reader@Example.com" });

    await expect(
      verifyAccessJwt(token, {
        teamDomain,
        audience,
        allowedEmails: new Set(["READER@EXAMPLE.COM"]),
      }),
    ).resolves.toEqual({ email: "reader@example.com" });
  });

  it("denies a valid identity that is absent from the allowlist", async () => {
    const token = await signedToken({ email: "other@example.com" });

    await expect(
      verifyAccessJwt(token, {
        teamDomain,
        audience,
        allowedEmails: new Set(["reader@example.com"]),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects a token issued for a different audience", async () => {
    const token = await signedToken({
      email: "reader@example.com",
      audience: "different-audience",
    });

    await expect(
      verifyAccessJwt(token, {
        teamDomain,
        audience,
        allowedEmails: new Set(["reader@example.com"]),
      }),
    ).rejects.toThrow();
  });

  it("rejects a configured team domain that is not a hostname", () => {
    expect(() =>
      createAccessVerifier({
        teamDomain: "team.example.cloudflareaccess.com/path",
        audience,
        allowedEmails: new Set(["reader@example.com"]),
      }),
    ).toThrow();
  });

  it.each([
    "attacker@evil.example",
    "attacker:secret@evil.example",
  ])("rejects a configured team domain containing userinfo: %s", (teamDomain) => {
    expect(() =>
      createAccessVerifier({
        teamDomain,
        audience,
        allowedEmails: new Set(["reader@example.com"]),
      }),
    ).toThrow();
  });
});
