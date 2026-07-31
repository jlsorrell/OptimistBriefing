import { describe, expect, it } from "vitest";

import {
  ForbiddenError,
  type AuthenticatedUser,
} from "../../../src/auth/access";
import {
  createApp,
  type AuthVerifier,
  type WorkflowLauncher,
} from "../../../src/api/app";
import type { BriefingRepository } from "../../../src/db/repository";

const allowedUser: AuthenticatedUser = { email: "reader@example.com" };

function fakeRepository(latestEdition: unknown = null): BriefingRepository {
  return {
    getLatestEdition: async () => latestEdition,
  } as BriefingRepository;
}

function fakeWorkflow(): WorkflowLauncher {
  return {
    start: async () => ({ runId: "unused" }),
    resume: async () => undefined,
  };
}

function appWith(verifier: AuthVerifier, latestEdition: unknown = null) {
  return createApp({
    repository: fakeRepository(latestEdition),
    authVerifier: verifier,
    workflow: fakeWorkflow(),
  });
}

async function json(response: Response) {
  return response.json() as Promise<{ error: { code: string; message: string } }>;
}

describe("authenticated API", () => {
  it("returns the exact unauthenticated health response", async () => {
    const response = await appWith(async () => allowedUser).request("/health");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it("denies a request without an Access assertion", async () => {
    const response = await appWith(async () => allowedUser).request(
      "/api/edition/latest",
    );

    expect(response.status).toBe(401);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  it("denies an invalid Access assertion without leaking its value", async () => {
    const assertion = "invalid-token-value";
    const response = await appWith(async () => {
      throw new Error("signature verification failed");
    }).request("/api/edition/latest", {
      headers: { "CF-Access-Jwt-Assertion": assertion },
    });

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
    expect(body).not.toContain(assertion);
  });

  it("denies a valid identity that is not on the allowlist", async () => {
    const response = await appWith(async () => {
      throw new ForbiddenError();
    }).request("/api/edition/latest", {
      headers: { "CF-Access-Jwt-Assertion": "signed-token" },
    });

    expect(response.status).toBe(403);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "AUTH_FORBIDDEN" },
    });
  });

  it("returns the latest edition to an allowed identity", async () => {
    const edition = { id: "edition-1", editionDate: "2026-07-29" };
    const response = await appWith(async () => allowedUser, edition).request(
      "/api/edition/latest",
      { headers: { "CF-Access-Jwt-Assertion": "signed-token" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(edition);
  });

  it("returns a sanitized not-found error when no edition is available", async () => {
    const response = await appWith(async () => allowedUser).request(
      "/api/edition/latest",
      { headers: { "CF-Access-Jwt-Assertion": "signed-token" } },
    );

    expect(response.status).toBe(404);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("sanitizes unexpected repository errors", async () => {
    const failingApp = createApp({
      repository: {
        getLatestEdition: async () => {
          throw new Error("database credentials failed");
        },
      } as unknown as BriefingRepository,
      authVerifier: async () => allowedUser,
      workflow: fakeWorkflow(),
    });

    const result = await failingApp.request("/api/edition/latest", {
      headers: { "CF-Access-Jwt-Assertion": "signed-token" },
    });

    expect(result.status).toBe(500);
    const body = await result.text();
    expect(JSON.parse(body)).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
    expect(body).not.toContain("database credentials failed");
  });
});
