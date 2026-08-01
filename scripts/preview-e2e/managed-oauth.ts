import { spawn as spawnChild } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { PREVIEW_ORIGIN } from "./environment";

const ACCESS_TEAM_ORIGIN = "https://optimistindustries.cloudflareaccess.com";
const GENERIC_FAILURE = "Preview authorization failed; retry the command.";
const RESOURCE_METADATA_URL = `${PREVIEW_ORIGIN}/.well-known/cloudflare-access-protected-resource/health`;
const AUTHORIZATION_SERVER_METADATA_URL = `${ACCESS_TEAM_ORIGIN}/.well-known/oauth-authorization-server`;

interface ProtectedResourceMetadata {
  resource: string;
  protected: boolean;
  authorization_servers: string[];
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
}

export type ManagedOAuthStage =
  | "preview discovery"
  | "resource metadata"
  | "authorization-server metadata"
  | "client registration"
  | "waiting for browser authorization callback"
  | "token exchange"
  | "authenticated health validation"
  | "authorization complete";

export interface ManagedOAuthDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  openAuthorizationURL?: (url: string) => Promise<void>;
  reportStage?: (stage: ManagedOAuthStage) => void;
  setAuthorizationTimeout?: (handler: () => void, milliseconds: number) => NodeJS.Timeout;
  clearAuthorizationTimeout?: (timeout: NodeJS.Timeout) => void;
}

export interface BrowserOpenDependencies {
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    arguments_: string[],
    options: { stdio: "ignore" },
  ) => { once(event: "spawn" | "error", listener: (error?: Error) => void): unknown };
}

function failure(): Error {
  return new Error(GENERIC_FAILURE);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isExactOriginURL(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === origin;
  } catch {
    return false;
  }
}

function parseResourceMetadataURL(header: string | null): string {
  const match = header?.match(/(?:^|[\s,])resource_metadata="([^"\\]+)"/i);
  if (match?.[1] !== RESOURCE_METADATA_URL) throw failure();
  return match[1];
}

function assertProtectedResourceMetadata(value: unknown): asserts value is ProtectedResourceMetadata {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as ProtectedResourceMetadata).resource !== `${PREVIEW_ORIGIN}/health` ||
    (value as ProtectedResourceMetadata).protected !== true ||
    !isStringArray((value as ProtectedResourceMetadata).authorization_servers) ||
    (value as ProtectedResourceMetadata).authorization_servers.length !== 1 ||
    (value as ProtectedResourceMetadata).authorization_servers[0] !== ACCESS_TEAM_ORIGIN
  ) {
    throw failure();
  }
}

function assertAuthorizationServerMetadata(value: unknown): asserts value is AuthorizationServerMetadata {
  if (value === null || typeof value !== "object") throw failure();
  const metadata = value as AuthorizationServerMetadata;
  if (
    metadata.issuer !== ACCESS_TEAM_ORIGIN ||
    !isExactOriginURL(metadata.authorization_endpoint, ACCESS_TEAM_ORIGIN) ||
    !isExactOriginURL(metadata.token_endpoint, ACCESS_TEAM_ORIGIN) ||
    !isExactOriginURL(metadata.registration_endpoint, ACCESS_TEAM_ORIGIN) ||
    !isStringArray(metadata.response_types_supported) ||
    !metadata.response_types_supported.includes("code") ||
    !isStringArray(metadata.grant_types_supported) ||
    !metadata.grant_types_supported.includes("authorization_code") ||
    !isStringArray(metadata.token_endpoint_auth_methods_supported) ||
    !metadata.token_endpoint_auth_methods_supported.includes("none") ||
    !isStringArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw failure();
  }
}

async function readJSON(response: Response): Promise<unknown> {
  if (!response.ok) throw failure();
  try {
    return await response.json();
  } catch {
    throw failure();
  }
}

function requestOptions(signal: AbortSignal | undefined, options: RequestInit = {}): RequestInit {
  return signal === undefined ? options : { ...options, signal };
}

function randomBase64URL(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function validateRegistration(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { client_id?: unknown }).client_id !== "string" ||
    (value as { client_id: string }).client_id.length === 0
  ) {
    throw failure();
  }
  return (value as { client_id: string }).client_id;
}

function validateToken(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { access_token?: unknown }).access_token !== "string" ||
    (value as { access_token: string }).access_token.length === 0 ||
    typeof (value as { token_type?: unknown }).token_type !== "string" ||
    (value as { token_type: string }).token_type.toLowerCase() !== "bearer"
  ) {
    throw failure();
  }
  return (value as { access_token: string }).access_token;
}

function isExactHealthyResponse(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    (value as { status?: unknown }).status === "ok"
  );
}

interface LoopbackCallback {
  redirectURI: string;
  callback: Promise<string>;
  close: () => Promise<void>;
}

async function createLoopbackCallback(state: string, signal?: AbortSignal): Promise<LoopbackCallback> {
  let settleCallback: ((result: { code?: string; error?: Error }) => void) | undefined;
  let completed = false;
  const callback = new Promise<string>((resolve, reject) => {
    settleCallback = ({ code, error }) => {
      if (error !== undefined) reject(error);
      else if (code !== undefined) resolve(code);
      else reject(failure());
    };
  });
  const finish = (result: { code?: string; error?: Error }) => {
    if (completed) return;
    completed = true;
    settleCallback?.(result);
  };
  const server = createServer((request, response) => {
    const requestURL = new URL(request.url ?? "", "http://127.0.0.1");
    if (completed || request.method !== "GET" || requestURL.pathname !== "/callback") {
      response.statusCode = 400;
      response.end();
      finish({ error: failure() });
      return;
    }
    if (
      requestURL.searchParams.get("state") !== state ||
      requestURL.searchParams.get("error") !== null ||
      requestURL.searchParams.get("code") === null ||
      requestURL.searchParams.get("code") === ""
    ) {
      response.statusCode = 400;
      response.end();
      finish({ error: failure() });
      return;
    }
    response.statusCode = 204;
    response.end();
    finish({ code: requestURL.searchParams.get("code")! });
  });
  const failServer = () => finish({ error: failure() });
  server.once("error", failServer);
  const abort = () => finish({ error: failure() });
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (address === null || typeof address === "string" || !Number.isInteger(address.port)) {
      throw failure();
    }
    return {
      redirectURI: `http://127.0.0.1:${address.port}/callback`,
      callback,
      close: async () => {
        signal?.removeEventListener("abort", abort);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      },
    };
  } catch {
    signal?.removeEventListener("abort", abort);
    server.close();
    throw failure();
  }
}

export async function openPreviewAuthorizationURL(
  authorizationURL: string,
  dependencies: BrowserOpenDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const commandAndArguments: [string, string[]] = platform === "darwin"
    ? ["/usr/bin/open", [authorizationURL]]
    : platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", authorizationURL]]
      : ["xdg-open", [authorizationURL]];
  const spawn = dependencies.spawn ?? spawnChild;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(failure());
      }
    };
    try {
      const child = spawn(commandAndArguments[0], commandAndArguments[1], { stdio: "ignore" });
      child.once("error", fail);
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    } catch {
      fail();
    }
  });
}

export async function authorizePreviewWithManagedOAuth(
  input: { baseURL: string },
  dependencies: ManagedOAuthDependencies = {},
  signal?: AbortSignal,
): Promise<string> {
  let loopback: LoopbackCallback | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    if (input.baseURL !== PREVIEW_ORIGIN || signal?.aborted) throw failure();
    const fetchImplementation = dependencies.fetch ?? fetch;
    dependencies.reportStage?.("preview discovery");
    const health = await fetchImplementation(`${PREVIEW_ORIGIN}/health`, requestOptions(signal));
    if (health.status !== 401) throw failure();
    const resourceMetadataURL = parseResourceMetadataURL(health.headers.get("www-authenticate"));
    dependencies.reportStage?.("resource metadata");
    const protectedResource = await readJSON(await fetchImplementation(resourceMetadataURL, requestOptions(signal)));
    assertProtectedResourceMetadata(protectedResource);
    dependencies.reportStage?.("authorization-server metadata");
    const authorizationServer = await readJSON(await fetchImplementation(
      AUTHORIZATION_SERVER_METADATA_URL,
      requestOptions(signal),
    ));
    assertAuthorizationServerMetadata(authorizationServer);
    const verifier = randomBase64URL(48);
    const state = randomBase64URL(32);
    loopback = await createLoopbackCallback(state, signal);
    dependencies.reportStage?.("client registration");
    const registration = await readJSON(await fetchImplementation(
      authorizationServer.registration_endpoint,
      requestOptions(signal, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [loopback.redirectURI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          resource: PREVIEW_ORIGIN,
        }),
      }),
    ));
    const clientID = validateRegistration(registration);
    const authorizationURL = new URL(authorizationServer.authorization_endpoint);
    authorizationURL.search = new URLSearchParams({
      response_type: "code",
      client_id: clientID,
      redirect_uri: loopback.redirectURI,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
      resource: PREVIEW_ORIGIN,
      state,
    }).toString();
    dependencies.reportStage?.("waiting for browser authorization callback");
    const setAuthorizationTimeout = dependencies.setAuthorizationTimeout ?? setTimeout;
    const timeoutCallback = loopback.callback.then(
      (code) => code,
      () => { throw failure(); },
    );
    const deadline = new Promise<never>((_, reject) => {
      timeout = setAuthorizationTimeout(() => {
        void loopback?.close();
        reject(failure());
      }, 300_000);
    });
    const browserOpening = (dependencies.openAuthorizationURL ?? openPreviewAuthorizationURL)(
      authorizationURL.href,
    );
    const [, code] = await Promise.all([browserOpening, Promise.race([timeoutCallback, deadline])]);
    const clearAuthorizationTimeout = dependencies.clearAuthorizationTimeout ?? clearTimeout;
    if (timeout === undefined) throw failure();
    clearAuthorizationTimeout(timeout);
    timeout = undefined;
    dependencies.reportStage?.("token exchange");
    const token = validateToken(await readJSON(await fetchImplementation(
      authorizationServer.token_endpoint,
      requestOptions(signal, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: loopback.redirectURI,
          client_id: clientID,
          code_verifier: verifier,
        }).toString(),
      }),
    )));
    dependencies.reportStage?.("authenticated health validation");
    const validatedHealth = await fetchImplementation(`${PREVIEW_ORIGIN}/health`, requestOptions(signal, {
      headers: { authorization: `Bearer ${token}` },
    }));
    if (validatedHealth.status !== 200 || !isExactHealthyResponse(await readJSON(validatedHealth))) {
      throw failure();
    }
    dependencies.reportStage?.("authorization complete");
    return token;
  } catch {
    throw failure();
  } finally {
    if (timeout !== undefined) {
      const clearAuthorizationTimeout = dependencies.clearAuthorizationTimeout ?? clearTimeout;
      clearAuthorizationTimeout(timeout);
    }
    await loopback?.close();
  }
}
