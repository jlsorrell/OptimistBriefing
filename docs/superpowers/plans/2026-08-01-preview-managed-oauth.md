# Preview Managed OAuth Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate the deployed preview with Cloudflare Access Managed OAuth through the user's ordinary browser and run the existing 39 responsive Playwright checks without persisting or leaking OAuth credentials.

**Architecture:** A focused Managed OAuth module discovers Cloudflare endpoints, dynamically registers an exact loopback callback, performs authorization-code + PKCE, validates the callback, and returns an in-memory bearer token. The harness passes that token only to its Playwright child; a custom fixture adds it only to exact preview-origin requests while the existing ephemeral directory owns nonsecret test output and cleanup.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Playwright, Cloudflare Access Managed OAuth, OAuth 2.0 authorization code flow, PKCE-S256.

## Global Constraints

- Target only `https://optimist-briefing-preview.optimistindustries.workers.dev` and authorization server `https://optimistindustries.cloudflareaccess.com`.
- Bind the callback only to `127.0.0.1` on an operating-system-assigned port and accept only `GET /callback` once.
- Discover OAuth metadata from the preview's `401` response and validate every discovered endpoint as HTTPS on the exact Access team origin.
- Require authorization code, public client authentication `none`, and PKCE method `S256` before opening the browser.
- Use cryptographically random PKCE verifier and state values; validate exact returned state before exchanging the code.
- Keep authorization codes, PKCE values, access tokens, and refresh tokens in memory only. Never print or write them.
- Attach the bearer only to requests whose origin exactly equals the preview origin; never configure a browser-global header that can reach other origins.
- Preserve one-worker execution, read-only preview tests, disabled traces/screenshots/video, identity-bound temporary cleanup, and generic redacted failure output.
- Keep the existing local Playwright configuration and signed-JWT E2E behavior intact.
- Production remains blocked by the unavailable real nonallowed-Google-account test and still requires explicit user approval.

---

### Task 1: Managed OAuth Authorization Client

**Files:**
- Create: `scripts/preview-e2e/managed-oauth.ts`
- Create: `tests/unit/config/preview-e2e-managed-oauth.test.ts`

**Interfaces:**
- Consumes: exact preview origin from `scripts/preview-e2e/environment.ts` and an `AbortSignal`.
- Produces: `authorizePreviewWithManagedOAuth(input: { baseURL: string }, dependencies?: ManagedOAuthDependencies, signal?: AbortSignal): Promise<string>` returning only the opaque access token.
- Produces: `openPreviewAuthorizationURL(url: string, dependencies?: BrowserOpenDependencies): Promise<void>` for the Node adapter.

- [ ] **Step 1: Add failing discovery and capability tests**

Create table-driven Vitest cases using complete literal Cloudflare-shaped responses. Exercise the real exported authorization function with a fetch double only at the external network boundary. Verify it:

```ts
expect(seenRequests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
  [`${PREVIEW_ORIGIN}/health`, "GET"],
  [`${PREVIEW_ORIGIN}/.well-known/cloudflare-access-protected-resource/health`, "GET"],
  [`${ACCESS_TEAM_ORIGIN}/.well-known/oauth-authorization-server`, "GET"],
  [`${ACCESS_TEAM_ORIGIN}/cdn-cgi/access/oauth/registration`, "POST"],
]);
```

Reject missing/malformed `resource_metadata`, a resource other than `${PREVIEW_ORIGIN}/health`, a different authorization server, non-HTTPS or off-origin endpoints, missing `authorization_code`, missing `none`, missing `S256`, and missing registration endpoint. Each rejection must use one generic message that excludes response bodies and token-like fixtures.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/config/preview-e2e-managed-oauth.test.ts
```

Expected: FAIL because `managed-oauth.ts` or its exports do not exist.

- [ ] **Step 3: Implement strict discovery and validation**

In `managed-oauth.ts`, define exact constants and small validators. Parse the quoted `resource_metadata` value from `WWW-Authenticate`, resolve no relative URLs, and require exact origins. Accept the complete Cloudflare metadata shapes while selecting only these fields:

```ts
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
```

Every network request receives the supplied abort signal. Convert network, JSON, status, and validation failures into `new Error("Preview authorization failed; retry the command.")` without including upstream data.

- [ ] **Step 4: Add failing PKCE, registration, callback, and token tests**

Use a real ephemeral loopback listener created by the production function. The injected browser opener receives the authorization URL, checks literal query parameters, then performs a real local `GET` to the encoded `redirect_uri` with the supplied `state` and a fixture code. Verify:

```ts
expect(registrationBody).toEqual({
  redirect_uris: [redirectURI],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
  resource: PREVIEW_ORIGIN,
});
expect(tokenBody.get("grant_type")).toBe("authorization_code");
expect(tokenBody.get("redirect_uri")).toBe(redirectURI);
expect(tokenBody.get("client_id")).toBe("registered-client-id");
expect(tokenBody.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
```

Independently derive the S256 challenge in the test and compare it to the authorization URL. Cover wrong state, missing code, OAuth callback error, non-GET request, wrong path, duplicate callback, timeout, abort, malformed registration/token responses, token type other than bearer, and unsuccessful authenticated `/health` validation. Assert that failure messages do not contain code, verifier, state, access token, refresh token, or response-body fixtures.

- [ ] **Step 5: Run the focused tests and verify RED**

Run the same focused Vitest command. Expected: new tests fail because registration, callback, PKCE, and exchange are not implemented.

- [ ] **Step 6: Implement the minimal full authorization flow**

Use `randomBytes`, `createHash("sha256")`, and base64url encoding. Create the loopback server with `createServer`, call `listen(0, "127.0.0.1")`, derive the callback URI from the assigned numeric port with path `/callback`, impose a 300,000 ms authorization deadline, and close it on every terminal path. Register a public client, build the authorization URL with `response_type=code`, `client_id`, exact `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, exact `resource`, and random `state`.

Exchange the accepted code as `application/x-www-form-urlencoded`. Require a nonempty string `access_token` and case-insensitive bearer token type. Discard any returned refresh token. Validate `${PREVIEW_ORIGIN}/health` with `Authorization: Bearer <token>` and require status 200 plus the exact JSON value `{ status: "ok" }` before returning the token.

Implement ordinary-browser launch without a shell:

```ts
darwin:  spawn("/usr/bin/open", [authorizationURL], { stdio: "ignore" })
win32:   spawn("rundll32.exe", ["url.dll,FileProtocolHandler", authorizationURL], { stdio: "ignore" })
other:   spawn("xdg-open", [authorizationURL], { stdio: "ignore" })
```

Resolve after the launcher reports `spawn`; reject a launcher error generically. Do not print the URL or child output.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the focused Vitest command. Expected: PASS with no warnings or secret-bearing output.

- [ ] **Step 8: Commit Task 1**

```bash
git add scripts/preview-e2e/managed-oauth.ts tests/unit/config/preview-e2e-managed-oauth.test.ts
git commit -m "feat: add preview managed OAuth client"
```

---

### Task 2: Harness and Exact-Origin Playwright Integration

**Files:**
- Create: `tests/preview-e2e/fixtures.ts`
- Create: `tests/unit/config/preview-e2e-auth-fixture.test.ts`
- Modify: `scripts/preview-e2e/harness.ts`
- Modify: `scripts/preview-e2e/node-runtime.ts`
- Modify: `scripts/preview-e2e/environment.ts`
- Modify: `playwright.preview.config.ts`
- Modify: `tests/unit/config/preview-e2e-harness.test.ts`
- Modify: `tests/unit/config/preview-e2e-node-runtime.test.ts`
- Modify: `tests/unit/config/preview-e2e-environment.test.ts`
- Modify: `tests/unit/config/preview-e2e-wiring.test.ts`
- Modify: `tests/preview-e2e/access.spec.ts`
- Modify: `tests/preview-e2e/content.spec.ts`
- Modify: `tests/preview-e2e/responsive-accessibility.spec.ts`
- Modify: `docs/runbooks/preview-rehearsal.md`

**Interfaces:**
- Consumes: `authorizePreviewWithManagedOAuth({ baseURL }, dependencies, signal): Promise<string>` from Task 1.
- Produces: `resolvePreviewAccessToken(value: string | undefined): string` with a generic validation error and no token echo.
- Produces: custom preview `test`, `expect`, and same-origin request helper from `tests/preview-e2e/fixtures.ts`.
- Produces: child-only `OPTIMIST_PREVIEW_ACCESS_TOKEN`; removes preview `storageState` from the Managed OAuth path.

- [ ] **Step 1: Write failing harness and environment tests**

Update the harness contract so authorization returns a token and the suite receives it only in its explicit child environment:

```ts
authorizePreview(input: { baseURL: string }, signal: AbortSignal): Promise<string>;
runPreviewSuite(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<number>;
```

Assert the exact sequence `create temp → authorize → run suite → cleanup`, that authorization failure skips the suite, that abort still joins authorization before cleanup, and that the suite environment contains the exact base URL, protected temp directory, and access token but no storage-state path. Add environment tests for missing, empty, whitespace, newline-bearing, and implausibly long tokens; failures must not echo the input.

- [ ] **Step 2: Write failing exact-origin fixture tests**

Define a pure exported helper used by the fixture and assert literal behavior:

```ts
expect(headersForPreviewRequest(`${PREVIEW_ORIGIN}/archive`, token, { accept: "text/html" }))
  .toEqual({ accept: "text/html", authorization: `Bearer ${token}` });
expect(headersForPreviewRequest("https://example.com/pixel", token, { accept: "image/*" }))
  .toEqual({ accept: "image/*" });
expect(headersForPreviewRequest(`${PREVIEW_ORIGIN}.evil.example/`, token, {}))
  .toEqual({});
```

Also test that the same-origin request helper rejects absolute off-origin URLs before invoking Playwright's API request context.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npx vitest run \
  tests/unit/config/preview-e2e-harness.test.ts \
  tests/unit/config/preview-e2e-node-runtime.test.ts \
  tests/unit/config/preview-e2e-environment.test.ts \
  tests/unit/config/preview-e2e-wiring.test.ts \
  tests/unit/config/preview-e2e-auth-fixture.test.ts
```

Expected: FAIL on the new token-returning harness and missing fixture behavior.

- [ ] **Step 4: Implement harness token transport and remove storage state**

Change `runPreviewHarness` to retain the token only in a local variable, set `OPTIMIST_PREVIEW_ACCESS_TOKEN` only on the child environment object, and clear the local reference in `finally`. Keep the existing signal joining and identity-bound temp cleanup.

Change the Node dependencies to call Task 1 authorization with the normal-browser launcher. Delete Playwright-controlled authentication, storage-state capture, and obsolete storage-state validation code and tests. Keep child buffering/redaction and bounded termination unchanged.

Change `resolvePreviewRuntimeEnvironment` to validate only the exact base URL, protected temporary directory, and access token. Reject tokens outside 16–4096 printable non-whitespace characters or containing CR/LF using one generic message. Remove `storageState` from `playwright.preview.config.ts`.

- [ ] **Step 5: Implement the preview fixture and update specs**

Extend Playwright's base test with an automatic page fixture that installs a route before each test. For exact preview-origin requests, continue with original headers plus lowercase `authorization: Bearer <token>`; continue off-origin requests with no added header. Export `test` and `expect` from the fixture.

Provide `getPreviewJSON(page, path)` that accepts only relative paths resolving to the exact preview origin and calls `page.context().request.get` with the bearer header. Update all preview specs to import from the fixture and replace direct authenticated `page.context().request` usage with the helper. Keep the signed-out request deliberately unauthenticated.

Update the signed-out Access assertion for Managed OAuth: status 401 and a `WWW-Authenticate` value containing a resource-metadata URL on the exact preview origin. Do not assert or log any bearer value.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the focused Vitest command from Step 3. Expected: PASS.

- [ ] **Step 7: Update the preview runbook**

Document that the runner opens the user's ordinary browser, Managed OAuth must allow loopback clients, credentials remain in memory, bearer injection is exact-origin, and the old Playwright-controlled Google login/storage-state description no longer applies. Preserve the nonallowed-account production blocker.

- [ ] **Step 8: Run complete local verification**

Run sequentially:

```bash
npm run check
npm test
npm run test:worker
npm run test:e2e
npm run build
npm run evaluate
PREVIEW_LIST_DIR=$(mktemp -d "${TMPDIR%/}/optimist-preview-e2e-list-XXXXXX")
chmod 700 "$PREVIEW_LIST_DIR"
OPTIMIST_PREVIEW_BASE_URL=https://optimist-briefing-preview.optimistindustries.workers.dev \
OPTIMIST_PREVIEW_TEMP_DIR="$PREVIEW_LIST_DIR" \
OPTIMIST_PREVIEW_ACCESS_TOKEN=synthetic-preview-token-1234 \
npx playwright test --config playwright.preview.config.ts --list
rmdir "$PREVIEW_LIST_DIR"
git diff --check
```

Expected: all local gates pass; preview discovery lists exactly 39 tests across desktop, tablet, and mobile; no real preview or OAuth network call occurs in this step.

- [ ] **Step 9: Commit Task 2**

```bash
git add scripts/preview-e2e tests/unit/config tests/preview-e2e playwright.preview.config.ts docs/runbooks/preview-rehearsal.md
git commit -m "feat: authenticate preview through managed OAuth"
```

---

### Task 3: Live Managed OAuth Rehearsal and Evidence

**Files:**
- Modify: `.superpowers/sdd/2026-08-01-preview-managed-oauth/task-3-report.md`
- Modify: `.superpowers/sdd/2026-08-01-preview-managed-oauth/progress.md`

**Interfaces:**
- Consumes: `npm run test:e2e:preview` from Tasks 1–2 and the live Cloudflare Access application.
- Produces: live evidence for OAuth authorization, cleanup, and 39-test responsive coverage. No tracked product file changes are required.

- [ ] **Step 1: Run the live preview harness**

Run:

```bash
npm run test:e2e:preview
```

Expected: the ordinary browser opens Cloudflare Access; the user completes Google login; the callback succeeds; `/health` validates; and all 39 preview tests pass.

- [ ] **Step 2: Verify cleanup and secret hygiene**

After the process exits, confirm no `optimist-preview-e2e-*` directory remains directly below the real OS temporary directory. Confirm `git status --short` contains no generated auth files or Playwright artifacts. Do not inspect, print, or retain access or refresh tokens.

- [ ] **Step 3: Record evidence**

Record only command names, exit codes, test counts, cleanup result, and any generic failure category in the task report and ledger. Never include authorization URLs, callback query strings, codes, state, PKCE values, tokens, cookies, or response bodies.
