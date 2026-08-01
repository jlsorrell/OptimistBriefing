# Access-Protected Preview Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate, read-only Playwright harness that authenticates interactively through Google and Cloudflare Access, tests the deployed preview at desktop/tablet/mobile sizes, and deletes all temporary authentication state.

**Architecture:** A strict environment module pins the only allowed preview origin and validates temporary paths. An injected orchestration layer owns cleanup and exit-code propagation, while a Node/Playwright adapter performs headed authentication and launches a separate preview configuration. Preview specs never import the local JWT helper and never mutate data.

**Tech Stack:** Node.js 24, TypeScript, Playwright, Vitest, axe-core, Cloudflare Access.

## Global Constraints

- The only permitted target is `https://optimist-briefing-preview.optimistindustries.workers.dev`.
- Reject HTTP, userinfo, ports, other hosts, non-root base paths, queries, and fragments before browser launch.
- Store Access state only below an OS temporary directory created with prefix `optimist-preview-e2e-`; directory mode is `0700`, storage-state mode is `0600`.
- Never print or commit Google credentials, Access cookies, JWTs, storage state, traces, screenshots, or video.
- Preview Playwright sets `trace`, `screenshot`, and `video` to `off` and writes runner output below the ephemeral directory.
- Preview tests are read-only: no feedback, preference writes, admin requests, Workflow triggers, D1 mutations, or OpenAI requests.
- Keep the existing local Playwright configuration and local signed-JWT behavior intact.
- Production remains blocked by the unavailable real nonallowed-Google-account test and still requires explicit user approval.

---

### Task 1: Strict Preview Environment Boundary

**Files:**
- Create: `scripts/preview-e2e/environment.ts`
- Create: `tests/unit/config/preview-e2e-environment.test.ts`

**Interfaces:**
- Produces: `PREVIEW_ORIGIN: string`
- Produces: `PREVIEW_TEMP_PREFIX: string`
- Produces: `resolvePreviewBaseURL(value: string | undefined): string`
- Produces: `assertAuthenticationNavigation(value: string): void`
- Produces: `resolvePreviewRuntimeEnvironment(env: NodeJS.ProcessEnv): { baseURL: string; tempDirectory: string; storageStatePath: string }`
- Produces: `assertTemporaryDirectory(path: string, systemTempDirectory?: string): string`
- Produces: `normalizeChildExitCode(code: number | null, signal: NodeJS.Signals | null): number`

- [ ] **Step 1: Write the failing environment tests**

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PREVIEW_ORIGIN,
  assertAuthenticationNavigation,
  assertTemporaryDirectory,
  normalizeChildExitCode,
  resolvePreviewBaseURL,
  resolvePreviewRuntimeEnvironment,
} from "../../../scripts/preview-e2e/environment";

describe("preview E2E environment", () => {
  it("defaults to and accepts only the canonical preview origin", () => {
    expect(resolvePreviewBaseURL(undefined)).toBe(PREVIEW_ORIGIN);
    expect(resolvePreviewBaseURL(`${PREVIEW_ORIGIN}/`)).toBe(PREVIEW_ORIGIN);
  });

  it.each([
    "http://optimist-briefing-preview.optimistindustries.workers.dev",
    "https://user@optimist-briefing-preview.optimistindustries.workers.dev",
    "https://optimist-briefing-preview.optimistindustries.workers.dev:8443",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/archive",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/?debug=1",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/#today",
    "https://optimistindustries.com",
    "https://another-worker.optimistindustries.workers.dev",
  ])("rejects unsafe target %s", (value) => {
    expect(() => resolvePreviewBaseURL(value)).toThrow(
      "Preview E2E may only target the isolated preview origin",
    );
  });

  it("allows only the preview, Access team, and Google account origins during login", () => {
    expect(() => assertAuthenticationNavigation("about:blank")).not.toThrow();
    expect(() => assertAuthenticationNavigation(`${PREVIEW_ORIGIN}/health`)).not.toThrow();
    expect(() => assertAuthenticationNavigation("https://optimistindustries.cloudflareaccess.com/cdn-cgi/access/login/example")).not.toThrow();
    expect(() => assertAuthenticationNavigation("https://accounts.google.com/v3/signin/accountchooser")).not.toThrow();
    expect(() => assertAuthenticationNavigation("https://example.com/login")).toThrow(
      "Authentication left the approved origins",
    );
  });

  it("requires the exact storage-state child of the runner temp directory", () => {
    const tempDirectory = join(tmpdir(), "optimist-preview-e2e-unit");
    const storageStatePath = join(tempDirectory, "storage-state.json");
    expect(resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    })).toEqual({ baseURL: PREVIEW_ORIGIN, tempDirectory, storageStatePath });
    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: join(tempDirectory, "..", "state.json"),
    })).toThrow("Preview storage state must be the protected temporary file");
  });

  it("rejects broad or unrelated cleanup targets", () => {
    expect(() => assertTemporaryDirectory(tmpdir())).toThrow(
      "Refusing unsafe preview cleanup target",
    );
    expect(() => assertTemporaryDirectory(join(tmpdir(), "unrelated"))).toThrow(
      "Refusing unsafe preview cleanup target",
    );
  });

  it("preserves child exit codes and maps signals to failure", () => {
    expect(normalizeChildExitCode(0, null)).toBe(0);
    expect(normalizeChildExitCode(7, null)).toBe(7);
    expect(normalizeChildExitCode(null, "SIGTERM")).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run tests/unit/config/preview-e2e-environment.test.ts`

Expected: FAIL because `scripts/preview-e2e/environment.ts` does not exist.

- [ ] **Step 3: Implement the minimal strict environment module**

```ts
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const PREVIEW_ORIGIN =
  "https://optimist-briefing-preview.optimistindustries.workers.dev";
export const PREVIEW_TEMP_PREFIX = "optimist-preview-e2e-";

export function resolvePreviewBaseURL(value: string | undefined): string {
  const url = new URL(value ?? PREVIEW_ORIGIN);
  if (url.origin !== PREVIEW_ORIGIN || url.username !== "" ||
      url.password !== "" || url.port !== "" || url.pathname !== "/" ||
      url.search !== "" || url.hash !== "") {
    throw new Error("Preview E2E may only target the isolated preview origin");
  }
  return url.origin;
}

export function assertAuthenticationNavigation(value: string): void {
  if (value === "about:blank") return;
  const origin = new URL(value).origin;
  if (![PREVIEW_ORIGIN, "https://optimistindustries.cloudflareaccess.com",
        "https://accounts.google.com"].includes(origin)) {
    throw new Error("Authentication left the approved origins");
  }
}

export function assertTemporaryDirectory(
  path: string,
  systemTempDirectory = tmpdir(),
): string {
  const candidate = resolve(path);
  if (dirname(candidate) !== resolve(systemTempDirectory) ||
      !basename(candidate).startsWith(PREVIEW_TEMP_PREFIX)) {
    throw new Error("Refusing unsafe preview cleanup target");
  }
  return candidate;
}

export function resolvePreviewRuntimeEnvironment(env: NodeJS.ProcessEnv) {
  const baseURL = resolvePreviewBaseURL(env.OPTIMIST_PREVIEW_BASE_URL);
  const rawTempDirectory = env.OPTIMIST_PREVIEW_TEMP_DIR;
  const rawStorageState = env.OPTIMIST_PREVIEW_STORAGE_STATE;
  if (rawTempDirectory === undefined || rawStorageState === undefined) {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  const tempDirectory = assertTemporaryDirectory(rawTempDirectory);
  const storageStatePath = resolve(rawStorageState);
  if (storageStatePath !== join(tempDirectory, "storage-state.json")) {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  return { baseURL, tempDirectory, storageStatePath };
}

export function normalizeChildExitCode(
  code: number | null,
  _signal: NodeJS.Signals | null,
): number {
  return code ?? 1;
}
```

- [ ] **Step 4: Run focused test and verify GREEN**

Run: `npx vitest run tests/unit/config/preview-e2e-environment.test.ts`

Expected: PASS. Run `npm test` and confirm the existing unit suite remains green.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/preview-e2e/environment.ts tests/unit/config/preview-e2e-environment.test.ts
git commit -m "test: enforce preview harness boundaries"
```

---

### Task 2: Ephemeral Authentication Runner

**Files:**
- Create: `scripts/preview-e2e/harness.ts`
- Create: `scripts/preview-e2e/node-runtime.ts`
- Create: `scripts/run-preview-e2e.ts`
- Create: `tests/unit/config/preview-e2e-harness.test.ts`
- Create: `tests/unit/config/preview-e2e-node-runtime.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 environment helpers
- Produces: `PreviewHarnessDependencies`
- Produces: `runPreviewHarness(env, dependencies): Promise<number>`
- Produces: `createNodePreviewHarnessDependencies(): PreviewHarnessDependencies`
- Produces npm script: `test:e2e:preview`

- [ ] **Step 1: Write failing orchestration tests**

Use injected `vi.fn` dependencies to prove three behaviors: success calls
authentication then Playwright then cleanup exactly once; authentication failure
skips Playwright and still cleans once; Playwright exit code `4` is returned
unchanged and cleanup still runs.

The success assertion must verify this exact authentication input:

```ts
expect(deps.captureAccessState).toHaveBeenCalledWith({
  baseURL: "https://optimist-briefing-preview.optimistindustries.workers.dev",
  storageStatePath: join(tempDirectory, "storage-state.json"),
});
```

- [ ] **Step 2: Run orchestration test and verify RED**

Run: `npx vitest run tests/unit/config/preview-e2e-harness.test.ts`

Expected: FAIL because `runPreviewHarness` does not exist.

- [ ] **Step 3: Implement injected orchestration with idempotent cleanup**

```ts
export async function runPreviewHarness(
  env: NodeJS.ProcessEnv,
  dependencies: PreviewHarnessDependencies,
): Promise<number> {
  const baseURL = resolvePreviewBaseURL(env.OPTIMIST_PREVIEW_BASE_URL);
  const tempDirectory = await dependencies.createTempDirectory();
  const storageStatePath = join(tempDirectory, "storage-state.json");
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= dependencies.removeTempDirectory(tempDirectory);
    return cleanupPromise;
  };
  const unregister = dependencies.registerSignalCleanup(cleanup);
  try {
    await dependencies.captureAccessState({ baseURL, storageStatePath });
    return await dependencies.runPreviewSuite({
      ...env,
      OPTIMIST_PREVIEW_BASE_URL: baseURL,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    });
  } finally {
    unregister();
    await cleanup();
  }
}
```

- [ ] **Step 4: Run orchestration test and verify GREEN**

Run: `npx vitest run tests/unit/config/preview-e2e-harness.test.ts`

Expected: PASS for success, authentication failure, and child failure.

- [ ] **Step 5: Write failing Node-runtime tests**

Use the real filesystem under a test-created temporary parent to verify
directory mode `0700`, storage-state mode `0600`, exact-prefix cleanup, and
cleanup-before-signal relay. Inject `cleanup` and `relaySignal` into the signal
handler test; do not send a real process signal.

- [ ] **Step 6: Run Node-runtime test and verify RED**

Run: `npx vitest run tests/unit/config/preview-e2e-node-runtime.test.ts`

Expected: FAIL because `node-runtime.ts` does not exist.

- [ ] **Step 7: Implement the real Node/Playwright adapter**

Create the temp directory with `mkdtemp(join(tmpdir(), PREVIEW_TEMP_PREFIX))`,
`chmod` it to `0o700`, and validate it before recursive cleanup. Authentication
must attach a main-frame navigation listener that calls
`assertAuthenticationNavigation`. Race an unexpected-origin rejection against
the successful return to `/health`. Replace Playwright timeout/navigation errors
with a concise retry error that does not include the current URL or an error
cause. The successful path uses:

```ts
const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/health`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(`${baseURL}/health`, { timeout: 300_000 });
  await page.waitForFunction(
    () => document.body.textContent?.trim() === '{"status":"ok"}',
    undefined,
    { timeout: 300_000 },
  );
  await context.storageState({ path: storageStatePath });
  await chmod(storageStatePath, 0o600);
} finally {
  await browser.close();
}
```

Launch the suite with `npx playwright test --config playwright.preview.config.ts`
using inherited stdio and only the three preview environment values added by the
harness. Resolve the child promise with `normalizeChildExitCode`.

- [ ] **Step 8: Add top-level runner and package command**

```ts
process.exitCode = await runPreviewHarness(
  process.env,
  createNodePreviewHarnessDependencies(),
);
```

Add `"test:e2e:preview": "node --import tsx scripts/run-preview-e2e.ts"` to
`package.json`.

- [ ] **Step 9: Verify Task 2 and commit**

Run the two focused runner tests, then `npm test` and `npm run check`. Commit:

```bash
git add package.json scripts/run-preview-e2e.ts scripts/preview-e2e tests/unit/config/preview-e2e-harness.test.ts tests/unit/config/preview-e2e-node-runtime.test.ts
git commit -m "feat: add ephemeral preview auth runner"
```

---

### Task 3: Separate Preview Playwright Configuration

**Files:**
- Create: `playwright.preview.config.ts`
- Create: `tests/unit/config/preview-e2e-wiring.test.ts`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `resolvePreviewRuntimeEnvironment(process.env)`
- Produces: Playwright projects `desktop`, `tablet`, and `mobile`
- Produces: preview-only `testDir: "./tests/preview-e2e"`

- [ ] **Step 1: Write failing wiring test**

Read the four configuration files and assert:

```ts
expect(packageJson.scripts["test:e2e:preview"]).toBe(
  "node --import tsx scripts/run-preview-e2e.ts",
);
expect(tsconfig.include).toContain("playwright.preview.config.ts");
expect(vitestConfig).toContain('"tests/preview-e2e/**"');
expect(previewConfig).toContain('testDir: "./tests/preview-e2e"');
expect(previewConfig).toContain('trace: "off"');
expect(previewConfig).toContain('screenshot: "off"');
expect(previewConfig).toContain('video: "off"');
expect(previewConfig).not.toContain("webServer");
```

- [ ] **Step 2: Run wiring test and verify RED**

Run: `npx vitest run tests/unit/config/preview-e2e-wiring.test.ts`

Expected: FAIL because the preview config and wiring do not exist.

- [ ] **Step 3: Implement preview configuration**

```ts
import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

import { resolvePreviewRuntimeEnvironment } from "./scripts/preview-e2e/environment";

const runtime = resolvePreviewRuntimeEnvironment(process.env);

export default defineConfig({
  testDir: "./tests/preview-e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  outputDir: join(runtime.tempDirectory, "test-results"),
  use: {
    baseURL: runtime.baseURL,
    storageState: runtime.storageStatePath,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
  ],
});
```

- [ ] **Step 4: Wire TypeScript and Vitest boundaries**

Add `playwright.preview.config.ts` to `tsconfig.json`'s `include` array. Add
`"tests/preview-e2e/**"` to Vitest's exclusions so `npm test` never contacts the
live preview.

- [ ] **Step 5: Verify GREEN and commit**

Run the focused wiring test and `npm run check`. Commit:

```bash
git add playwright.preview.config.ts tsconfig.json vitest.config.ts tests/unit/config/preview-e2e-wiring.test.ts
git commit -m "test: isolate preview Playwright configuration"
```

---

### Task 4: Read-Only Preview Coverage

**Files:**
- Create: `tests/preview-e2e/access.spec.ts`
- Create: `tests/preview-e2e/content.spec.ts`
- Create: `tests/preview-e2e/responsive-accessibility.spec.ts`

**Interfaces:**
- Consumes: authenticated `storageState` from the preview config
- Consumes: cookie-free `request.newContext()` for the signed-out check
- Produces: read-only preview evidence across all three projects

- [ ] **Step 1: Add Access boundary tests**

```ts
import { expect, request, test } from "@playwright/test";

test("signed-out health requests are challenged by Access", async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Access boundary is viewport-independent");
  if (baseURL === undefined) throw new Error("Preview base URL is required");
  const anonymous = await request.newContext({ baseURL });
  try {
    const response = await anonymous.get("/health", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = response.headers().location;
    expect(location).toBeDefined();
    expect(new URL(location ?? "", baseURL).hostname).toBe(
      "optimistindustries.cloudflareaccess.com",
    );
  } finally {
    await anonymous.dispose();
  }
});

test("authenticated health is exact", async ({ page }) => {
  const response = await page.goto("/health");
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toHaveText('{"status":"ok"}');
});
```

- [ ] **Step 2: Add fixed-edition and read-only route tests**

`content.spec.ts` asserts the `2026-07-29` edition, headline
`The day, thoughtfully distilled.`, Research/World/AI policy/DMV/Baltimore
sections, `Primary source`, `Forecast, not fact`, and external `arxiv.org`,
`reuters.com`, and `thebaltimorebanner.com` links. It visits `/archive`,
`/preferences`, `/run-status`, and `/saved` and checks their level-one headings.

Use `page.context().request` for `/api/sources` and `/api/runs`. Assert sources
is a nonempty array. Capture the runs array before and after the content checks
and assert equality so the file proves it did not start a Workflow.

- [ ] **Step 3: Add responsive and accessibility tests**

For `/`, `/archive`, `/preferences`, and `/run-status`, assert:

```ts
await expect.poll(() => page.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
)).toBe(true);
```

On mobile, open `Open briefing menu`, verify `Briefing sections`, choose
Research, and confirm navigation closes and `.reader-layout` is `block`. On
desktop/tablet, verify the menu is hidden, navigation is visible, and
`.reader-layout` is `grid`.

Run `AxeBuilder` on Today, Archive, Preferences, and Run Status and assert the
filtered serious/critical violation list is empty. Do not call
`page.screenshot` or enable Playwright artifacts.

- [ ] **Step 4: List preview suite without authentication**

Run:

```bash
env OPTIMIST_PREVIEW_BASE_URL=https://optimist-briefing-preview.optimistindustries.workers.dev \
  OPTIMIST_PREVIEW_TEMP_DIR=/private/tmp/optimist-preview-e2e-list \
  OPTIMIST_PREVIEW_STORAGE_STATE=/private/tmp/optimist-preview-e2e-list/storage-state.json \
  npx playwright test --config playwright.preview.config.ts --list
```

Expected: all Access, content, responsive, and accessibility tests are listed
under desktop, tablet, and mobile; no browser or network request starts.

- [ ] **Step 5: Run local regressions and commit**

Run `npm test` and `npm run test:e2e`. Commit:

```bash
git add tests/preview-e2e
git commit -m "test: cover Access-protected preview"
```

---

### Task 5: Runbook, Review, and Live Preview Evidence

**Files:**
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Documents: `npm run test:e2e:preview`
- Documents: ephemeral authentication and cleanup guarantees
- Documents: unresolved nonallowed-account production blocker

- [ ] **Step 1: Update preview rehearsal runbook**

Replace the paragraph saying the harness is missing with the exact command
`npm run test:e2e:preview`. Document that headed Chromium opens for Google
authentication, `/health` is validated, state is OS-temporary, artifacts are
disabled, and all tests are read-only. Retain the explicit statement that a
real nonallowed Google login has not been tested and blocks production.

- [ ] **Step 2: Run complete local verification matrix**

Run independently and require exit code zero:

```bash
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
npm run test:e2e
git diff --check
```

- [ ] **Step 3: Verify repository hygiene**

Run `git status --short`. Search tracked work for the literal names
`CF_Authorization`, `storage-state`, `client_secret`, and `refresh_token`, then
inspect every match. Expected: only source/test documentation identifiers; no
real value, storage-state file, report, screenshot, trace, or video exists.

- [ ] **Step 4: Commit runbook change**

```bash
git add docs/runbooks/deployment.md
git commit -m "docs: add protected preview rehearsal"
```

- [ ] **Step 5: Request independent code review**

Use `superpowers:requesting-code-review` on the complete branch. Resolve every
correctness or security finding and rerun focused tests after each fix.

- [ ] **Step 6: Run live preview harness after review**

Run: `npm run test:e2e:preview`

Expected: headed Chromium opens; the user completes Google login; the runner
confirms `/health`, closes the auth browser, runs desktop/tablet/mobile tests,
returns zero, and removes the temporary directory.

- [ ] **Step 7: Reconfirm remote state sequentially**

Run these one at a time because concurrent Wrangler OAuth requests previously
produced transient authentication failures:

```bash
npx wrangler d1 migrations list DB --remote --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc
npx wrangler workflows describe daily-briefing-preview
npx wrangler workflows instances list daily-briefing-preview
```

Expected: no pending migrations; Workflow bound to
`optimist-briefing-preview`; no Workflow instances before or after the harness.

- [ ] **Step 8: Produce production-readiness report**

Report exact local and preview test counts, the three viewport projects, Access
allow/signed-out evidence, Worker version, D1 migration status, Workflow
instance count, cleanup evidence, and git commit. Mark the unavailable real
nonallowed Google identity test unresolved. Do not request or infer production
approval.

---

## Final Verification Checklist

- [ ] Every new helper was introduced by a test that failed for the intended reason.
- [ ] Focused tests passed after each minimal implementation.
- [ ] All six local verification commands pass.
- [ ] Independent review completed with no unresolved findings.
- [ ] Live preview suite passes on desktop, tablet, and mobile.
- [ ] Signed-out requests are challenged and the approved account is allowed.
- [ ] Temporary auth state and Playwright output are absent after the run.
- [ ] D1 has no pending migrations and the Workflow has no instances.
- [ ] The nonallowed-account login remains explicitly blocked.
- [ ] No production deploy, DNS change, live AI request, or Workflow trigger occurred.
