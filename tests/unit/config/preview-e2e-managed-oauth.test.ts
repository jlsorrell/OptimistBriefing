import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  authorizePreviewWithManagedOAuth,
  openPreviewAuthorizationURL,
  type ManagedOAuthDependencies,
} from "../../../scripts/preview-e2e/managed-oauth";
import { PREVIEW_ORIGIN } from "../../../scripts/preview-e2e/environment";

const ACCESS_TEAM_ORIGIN = "https://optimistindustries.cloudflareaccess.com";
const GENERIC_FAILURE = "Preview authorization failed; retry the command.";

interface SeenRequest {
  url: string;
  init?: RequestInit;
}

function protectedResourceMetadata(overrides: Record<string, unknown> = {}) {
  return {
    resource: `${PREVIEW_ORIGIN}/health`,
    protected: true,
    authorization_servers: [ACCESS_TEAM_ORIGIN],
    scopes_supported: ["openid", "profile"],
    bearer_methods_supported: ["header"],
    ...overrides,
  };
}

function authorizationServerMetadata(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ACCESS_TEAM_ORIGIN,
    authorization_endpoint: `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/authorize`,
    token_endpoint: `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/token`,
    registration_endpoint: `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/registration`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://developers.cloudflare.com/cloudflare-one/",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createDiscoveryDependencies(
  options: {
    challenge?: string;
    healthStatus?: number;
    protectedResource?: Record<string, unknown>;
    authorizationServer?: Record<string, unknown>;
    registration?: unknown;
  } = {},
): ManagedOAuthDependencies & { seenRequests: SeenRequest[] } {
  const seenRequests: SeenRequest[] = [];
  return {
    seenRequests,
    fetch: async (url, init) => {
      const requestURL = String(url);
      if (init === undefined) seenRequests.push({ url: requestURL });
      else seenRequests.push({ url: requestURL, init });
      if (requestURL === `${PREVIEW_ORIGIN}/health`) {
        return new Response(null, {
          status: options.healthStatus ?? 401,
          headers: {
            "www-authenticate": options.challenge ??
              `Bearer resource_metadata="${PREVIEW_ORIGIN}/.well-known/cloudflare-access-protected-resource/health"`,
          },
        });
      }
      if (requestURL === `${PREVIEW_ORIGIN}/.well-known/cloudflare-access-protected-resource/health`) {
        return jsonResponse(protectedResourceMetadata(options.protectedResource));
      }
      if (requestURL === `${ACCESS_TEAM_ORIGIN}/.well-known/oauth-authorization-server`) {
        return jsonResponse(authorizationServerMetadata(options.authorizationServer));
      }
      if (requestURL === `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/registration`) {
        return jsonResponse(options.registration ?? {});
      }
      throw new Error(`Unexpected request: ${requestURL}`);
    },
    openAuthorizationURL: async () => undefined,
  };
}

function expectGenericFailure(error: unknown, forbidden: string[] = []): boolean {
  expect(error).toMatchObject({ message: GENERIC_FAILURE });
  const message = error instanceof Error ? error.message : String(error);
  for (const value of forbidden) expect(message).not.toContain(value);
  return true;
}

describe("preview managed OAuth discovery", () => {
  it("discovers the exact preview and Access endpoints before a malformed registration response", async () => {
    const dependencies = createDiscoveryDependencies({ registration: { response_body_fixture: "hidden" } });

    await expect(authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
    )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, ["hidden"]));

    expect(dependencies.seenRequests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
      [`${PREVIEW_ORIGIN}/health`, "GET"],
      [`${PREVIEW_ORIGIN}/.well-known/cloudflare-access-protected-resource/health`, "GET"],
      [`${ACCESS_TEAM_ORIGIN}/.well-known/oauth-authorization-server`, "GET"],
      [`${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/registration`, "POST"],
    ]);
  });

  it.each([200, 302, 500])("rejects a %i health response before discovery", async (healthStatus) => {
    const dependencies = createDiscoveryDependencies({ healthStatus });

    await expect(authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
    )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error));

    expect(dependencies.seenRequests.map(({ url }) => url)).toEqual([
      `${PREVIEW_ORIGIN}/health`,
    ]);
  });

  const discoveryFailures = [
    {
      name: "missing resource metadata challenge",
      options: { challenge: "Bearer realm=\"preview\"" },
      forbidden: ["preview"],
    },
    {
      name: "a malformed resource metadata challenge",
      options: { challenge: "Bearer resource_metadata=https://example.test/metadata" },
      forbidden: ["example.test"],
    },
    {
      name: "a resource other than preview health",
      options: { protectedResource: { resource: `${PREVIEW_ORIGIN}/other` } },
      forbidden: ["other"],
    },
    {
      name: "a different authorization server",
      options: { protectedResource: { authorization_servers: ["https://example.test"] } },
      forbidden: ["example.test"],
    },
    {
      name: "a non-HTTPS authorization endpoint",
      options: { authorizationServer: { authorization_endpoint: "http://optimistindustries.cloudflareaccess.com/authorize" } },
      forbidden: ["http://"],
    },
    {
      name: "an off-origin token endpoint",
      options: { authorizationServer: { token_endpoint: "https://example.test/token" } },
      forbidden: ["example.test"],
    },
    {
      name: "missing authorization_code capability",
      options: { authorizationServer: { grant_types_supported: ["implicit"] } },
      forbidden: ["implicit"],
    },
    {
      name: "missing public-client capability",
      options: { authorizationServer: { token_endpoint_auth_methods_supported: ["client_secret_basic"] } },
      forbidden: ["client_secret_basic"],
    },
    {
      name: "missing S256 capability",
      options: { authorizationServer: { code_challenge_methods_supported: ["plain"] } },
      forbidden: ["plain"],
    },
    {
      name: "a missing registration endpoint",
      options: { authorizationServer: { registration_endpoint: "" } },
      forbidden: ["registration"],
    },
  ];

  for (const testCase of discoveryFailures) {
    it(`rejects ${testCase.name} without exposing upstream data`, async () => {
      const dependencies = createDiscoveryDependencies(testCase.options);

      await expect(authorizePreviewWithManagedOAuth(
        { baseURL: PREVIEW_ORIGIN },
        dependencies,
      )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, testCase.forbidden));
    });
  }
});

function createAuthorizationDependencies(options: {
  callback?: (url: URL) => Promise<void>;
  registration?: unknown;
  token?: unknown;
  validatedHealth?: Response;
} = {}): ManagedOAuthDependencies & {
  seenRequests: SeenRequest[];
  registrationBodies: unknown[];
  tokenBodies: URLSearchParams[];
  authorizationURLs: URL[];
  stages: string[];
} {
  const seenRequests: SeenRequest[] = [];
  const registrationBodies: unknown[] = [];
  const tokenBodies: URLSearchParams[] = [];
  const authorizationURLs: URL[] = [];
  const stages: string[] = [];
  return {
    seenRequests,
    registrationBodies,
    tokenBodies,
    authorizationURLs,
    stages,
    reportStage: (stage) => { stages.push(stage); },
    fetch: async (url, init) => {
      const requestURL = String(url);
      if (init === undefined) seenRequests.push({ url: requestURL });
      else seenRequests.push({ url: requestURL, init });
      if (requestURL === `${PREVIEW_ORIGIN}/health`) {
        if (new Headers(init?.headers).get("authorization") !== null) {
          return options.validatedHealth ?? jsonResponse({ status: "ok" });
        }
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${PREVIEW_ORIGIN}/.well-known/cloudflare-access-protected-resource/health"`,
          },
        });
      }
      if (requestURL === `${PREVIEW_ORIGIN}/.well-known/cloudflare-access-protected-resource/health`) {
        return jsonResponse(protectedResourceMetadata());
      }
      if (requestURL === `${ACCESS_TEAM_ORIGIN}/.well-known/oauth-authorization-server`) {
        return jsonResponse(authorizationServerMetadata());
      }
      if (requestURL === `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/registration`) {
        registrationBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(options.registration ?? { client_id: "registered-client-id" });
      }
      if (requestURL === `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/token`) {
        tokenBodies.push(new URLSearchParams(String(init?.body)));
        return jsonResponse(options.token ?? {
          access_token: "access-token-fixture",
          token_type: "Bearer",
          refresh_token: "refresh-token-fixture",
        });
      }
      throw new Error(`Unexpected request: ${requestURL}`);
    },
    openAuthorizationURL: async (value) => {
      const url = new URL(value);
      authorizationURLs.push(url);
      if (options.callback !== undefined) await options.callback(url);
    },
  };
}

function authorizationCallbackURL(url: URL, values: Record<string, string>): string {
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  for (const [key, value] of Object.entries(values)) callback.searchParams.set(key, value);
  return callback.href;
}

function s256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

describe("preview managed OAuth authorization", () => {
  it("registers a PKCE public client, receives a loopback callback, exchanges it, and validates the bearer token", async () => {
    const dependencies = createAuthorizationDependencies({
      callback: async (authorizationURL) => {
        expect(authorizationURL.origin).toBe(ACCESS_TEAM_ORIGIN);
        expect(authorizationURL.pathname).toBe("/cdn-cgi/access/oauth/authorize");
        expect(authorizationURL.searchParams.get("response_type")).toBe("code");
        expect(authorizationURL.searchParams.get("client_id")).toBe("registered-client-id");
        expect(authorizationURL.searchParams.get("resource")).toBe(PREVIEW_ORIGIN);
        expect(authorizationURL.searchParams.get("code_challenge_method")).toBe("S256");
        const verifier = authorizationURL.searchParams.get("code_verifier");
        expect(verifier).toBeNull();
        const challenge = authorizationURL.searchParams.get("code_challenge")!;
        const state = authorizationURL.searchParams.get("state")!;
        expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
        await fetch(authorizationCallbackURL(authorizationURL, {
          state,
          code: "authorization-code-fixture",
        }));
      },
    });

    await expect(authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
    )).resolves.toBe("access-token-fixture");

    const authorizationURL = dependencies.authorizationURLs[0]!;
    const redirectURI = authorizationURL.searchParams.get("redirect_uri")!;
    const state = authorizationURL.searchParams.get("state")!;
    const challenge = authorizationURL.searchParams.get("code_challenge")!;
    const verifier = dependencies.tokenBodies[0]!.get("code_verifier")!;
    expect(redirectURI).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(dependencies.registrationBodies[0]).toEqual({
      redirect_uris: [redirectURI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      resource: PREVIEW_ORIGIN,
    });
    expect(dependencies.tokenBodies[0]!.get("grant_type")).toBe("authorization_code");
    expect(dependencies.tokenBodies[0]!.get("redirect_uri")).toBe(redirectURI);
    expect(dependencies.tokenBodies[0]!.get("client_id")).toBe("registered-client-id");
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(challenge).toBe(s256(verifier));
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(dependencies.stages).toEqual([
      "preview discovery",
      "resource metadata",
      "authorization-server metadata",
      "client registration",
      "waiting for browser authorization callback",
      "token exchange",
      "authenticated health validation",
      "authorization complete",
    ]);
    expect(dependencies.seenRequests).toHaveLength(6);
    expect(dependencies.seenRequests.every(({ init }) => init?.redirect === "manual")).toBe(true);
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects a %i token redirect without following it",
    async (status) => {
      const dependencies = createAuthorizationDependencies({
        callback: async (url) => {
          await fetch(authorizationCallbackURL(url, {
            state: url.searchParams.get("state")!,
            code: "code-fixture",
          }));
        },
      });
      const baseFetch = dependencies.fetch!;
      let followedRedirectRequests = 0;
      dependencies.fetch = async (url, init) => {
        if (String(url) !== `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/token`) {
          return baseFetch(url, init);
        }
        if (init?.redirect !== "manual") {
          followedRedirectRequests += 1;
          return jsonResponse({ access_token: "redirected-token-fixture", token_type: "Bearer" });
        }
        return new Response(null, {
          status,
          headers: { location: "https://example.test/redirect-target" },
        });
      };

      await expect(authorizePreviewWithManagedOAuth(
        { baseURL: PREVIEW_ORIGIN },
        dependencies,
      )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, [
        "example.test",
        "redirected-token-fixture",
      ]));
      expect(followedRedirectRequests).toBe(0);
      expect(dependencies.stages.at(-1)).toBe("token exchange");
    },
  );

  it.each([
    {
      name: "client registration",
      options: { registration: { registration_body_fixture: "registration-body" } },
      lastStage: "client registration",
    },
    {
      name: "browser authorization callback",
      options: { callback: async () => { throw new Error("callback-secret-fixture"); } },
      lastStage: "waiting for browser authorization callback",
    },
    {
      name: "token exchange",
      options: {
        callback: async (url: URL) => {
          await fetch(authorizationCallbackURL(url, {
            state: url.searchParams.get("state")!,
            code: "code-secret-fixture",
          }));
        },
        token: { token_body_fixture: "token-secret-fixture" },
      },
      lastStage: "token exchange",
    },
    {
      name: "authenticated health validation",
      options: {
        callback: async (url: URL) => {
          await fetch(authorizationCallbackURL(url, {
            state: url.searchParams.get("state")!,
            code: "code-secret-fixture",
          }));
        },
        validatedHealth: jsonResponse({ status: "health-secret-fixture" }),
      },
      lastStage: "authenticated health validation",
    },
  ])("localizes a $name failure to the last fixed stage", async ({ options, lastStage }) => {
    const dependencies = createAuthorizationDependencies(options);

    await expect(authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
    )).rejects.toThrow(GENERIC_FAILURE);

    expect(dependencies.stages.at(-1)).toBe(lastStage);
    expect(dependencies.stages).not.toContain("authorization complete");
  });

  const callbackFailures: Array<{
    name: string;
    callback: (url: URL) => Promise<void>;
    forbidden: string[];
  }> = [
    {
      name: "a wrong callback state",
      callback: async (url) => { await fetch(authorizationCallbackURL(url, { state: "wrong-state", code: "code-fixture" })); },
      forbidden: ["wrong-state", "code-fixture"],
    },
    {
      name: "a missing callback code",
      callback: async (url) => { await fetch(authorizationCallbackURL(url, { state: url.searchParams.get("state")! })); },
      forbidden: [],
    },
    {
      name: "an OAuth callback error",
      callback: async (url) => { await fetch(authorizationCallbackURL(url, { state: url.searchParams.get("state")!, error: "access_denied" })); },
      forbidden: ["access_denied"],
    },
    {
      name: "a non-GET callback",
      callback: async (url) => {
        await fetch(authorizationCallbackURL(url, { state: url.searchParams.get("state")!, code: "code-fixture" }), { method: "POST" });
      },
      forbidden: ["code-fixture"],
    },
    {
      name: "a callback on the wrong path",
      callback: async (url) => {
        const callback = new URL(authorizationCallbackURL(url, { state: url.searchParams.get("state")!, code: "code-fixture" }));
        callback.pathname = "/other";
        await fetch(callback);
      },
      forbidden: ["code-fixture"],
    },
  ];

  for (const testCase of callbackFailures) {
    it(`rejects ${testCase.name} without exposing callback secrets`, async () => {
      const dependencies = createAuthorizationDependencies({ callback: testCase.callback });

      await expect(authorizePreviewWithManagedOAuth(
        { baseURL: PREVIEW_ORIGIN },
        dependencies,
      )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, testCase.forbidden));
    });
  }

  it.each(["state", "code", "error"])(
    "rejects a duplicated callback %s parameter",
    async (parameter) => {
      const dependencies = createAuthorizationDependencies({
        callback: async (url) => {
          const callback = new URL(authorizationCallbackURL(url, {
            state: url.searchParams.get("state")!,
            code: "code-fixture",
          }));
          callback.searchParams.append(parameter, "duplicate-fixture");
          await fetch(callback);
        },
      });

      await expect(authorizePreviewWithManagedOAuth(
        { baseURL: PREVIEW_ORIGIN },
        dependencies,
      )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, ["duplicate-fixture"]));
      expect(dependencies.tokenBodies).toHaveLength(0);
    },
  );

  it("rejects duplicate callbacks before exchanging a code", async () => {
    const dependencies = createAuthorizationDependencies({
      callback: async (url) => {
        const callbackURL = authorizationCallbackURL(url, {
          state: url.searchParams.get("state")!,
          code: "code-fixture",
        });
        await Promise.allSettled([fetch(callbackURL), fetch(callbackURL)]);
      },
    });

    await expect(authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
    )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, ["code-fixture"]));
    expect(dependencies.tokenBodies).toHaveLength(0);
  });

  it("closes the callback listener before releasing a code for token exchange", async () => {
    const lifecycle: string[] = [];
    const dependencies = createAuthorizationDependencies({
      callback: async (url) => {
        const callbackURL = authorizationCallbackURL(url, {
          state: url.searchParams.get("state")!,
          code: "code-fixture",
        });
        await fetch(callbackURL);
        await new Promise((resolve) => setTimeout(resolve, 40));
        try {
          await fetch(callbackURL);
          lifecycle.push("listener-reachable");
        } catch {
          lifecycle.push("listener-closed");
        }
      },
    });
    const baseFetch = dependencies.fetch!;
    dependencies.fetch = async (url, init) => {
      if (String(url) === `${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/token`) {
        lifecycle.push("token-exchange");
      }
      return baseFetch(url, init);
    };

    await expect(authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
    )).resolves.toBe("access-token-fixture");
    expect(lifecycle).toEqual(["listener-closed", "token-exchange"]);
  });

  it("rejects malformed registration, token, bearer type, and health validation responses generically", async () => {
    const callback = async (url: URL) => {
      await fetch(authorizationCallbackURL(url, {
        state: url.searchParams.get("state")!,
        code: "code-fixture",
      }));
    };
    const cases = [
      { options: { registration: { registration_body_fixture: "registration-body" } }, forbidden: ["registration-body"] },
      { options: { token: { token_body_fixture: "token-body" } }, forbidden: ["token-body", "code-fixture"] },
      { options: { token: { access_token: "access-token-fixture", token_type: "mac" } }, forbidden: ["access-token-fixture"] },
      { options: { validatedHealth: jsonResponse({ status: "not-ok", health_body_fixture: "health-body" }) }, forbidden: ["health-body", "access-token-fixture"] },
      { options: { validatedHealth: jsonResponse({ status: "ok" }, 201) }, forbidden: ["access-token-fixture"] },
      { options: { validatedHealth: jsonResponse({ status: "ok" }, 403) }, forbidden: ["access-token-fixture"] },
    ];

    for (const testCase of cases) {
      const dependencies = createAuthorizationDependencies({ ...testCase.options, callback });
      await expect(authorizePreviewWithManagedOAuth(
        { baseURL: PREVIEW_ORIGIN },
        dependencies,
      )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, [
        ...testCase.forbidden,
        "refresh-token-fixture",
      ]));
    }
  });

  it("rejects an aborted authorization without exposing the abort reason", async () => {
    const controller = new AbortController();
    controller.abort("abort-fixture");
    const dependencies = createAuthorizationDependencies();

    await expect(authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
      controller.signal,
    )).rejects.toSatisfy((error: unknown) => expectGenericFailure(error, ["abort-fixture"]));
  });

  it("uses an exact five-minute callback deadline", async () => {
    const dependencies = createAuthorizationDependencies();
    const timeout = vi.fn();
    dependencies.setAuthorizationTimeout = timeout;

    const authorization = authorizePreviewWithManagedOAuth(
      { baseURL: PREVIEW_ORIGIN },
      dependencies,
    );
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledOnce());
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 300_000);
    timeout.mock.calls[0]![0]();

    await expect(authorization).rejects.toSatisfy((error: unknown) => expectGenericFailure(error));
  });

  it("opens URLs through the platform launcher without a shell", async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => child);
    const opening = openPreviewAuthorizationURL("https://example.test/authorize", {
      platform: "darwin",
      spawn,
    });
    child.emit("spawn");

    await expect(opening).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith("/usr/bin/open", ["https://example.test/authorize"], {
      stdio: "ignore",
    });
  });
});
