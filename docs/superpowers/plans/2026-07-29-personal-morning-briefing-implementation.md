# Personal Morning Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a private, source-grounded daily research and news briefing at `optimistindustries.com` by 6:00 a.m. Eastern.

**Architecture:** A TypeScript Cloudflare Worker serves a React dashboard and JSON API, persists normalized editorial data in D1, and runs a durable Cloudflare Workflow for collection, ranking, synthesis, validation, and atomic publication. Cloudflare Access provides Google authentication; source and model integrations sit behind typed adapters so editorial logic remains deterministic and testable.

**Tech Stack:** TypeScript, Node.js 22+, Cloudflare Workers/Workflows/D1/Access, Hono, React, Vite, Zod, OpenAI TypeScript SDK behind a provider interface, fast-xml-parser, Mozilla Readability with linkedom, Vitest with Cloudflare's Workers pool, Playwright, and axe-core.

## Global Constraints

- Publish every day by 6:00 a.m. Eastern; target 5:45 a.m.
- Use `America/New_York` for edition dates and daylight-saving behavior.
- Require an explicitly allowed Google account before serving any page or API.
- Never publish an incomplete draft; keep the previous published edition visible.
- Treat language-model output as synthesis, never as a source.
- Every displayed claim must retain supporting source identifiers and links.
- Clearly distinguish reporting, analysis, opinion, research claims, and forecast signals.
- Do not bypass paywalls or retain a private archive of copyrighted article bodies.
- Keep normal monthly infrastructure and AI cost at or below $30.
- Use the approved palette: burgundy `#681F35`, rose `#C98D98`, sage `#89997D`, mustard `#C69A2D`, cream `#F7F0E5`.
- Meet WCAG AA contrast; color may not be the only carrier of meaning.
- Use strict TypeScript, runtime validation at I/O boundaries, deterministic fixtures, and test-first development.
- Do not hard-code model names; require `SUMMARY_MODEL`, `ASSESSMENT_MODEL`, and `EMBEDDING_MODEL` configuration.

---

## Delivery Sequence

The plan is one program because the subsystems share a schema and contracts, but
it has three independently demonstrable milestones:

1. **Tasks 1–4:** a private, responsive dashboard backed by D1 and fixture data.
2. **Tasks 5–9:** a manually triggered live editorial pipeline.
3. **Tasks 10–13:** scheduled, observable, evaluated, and production-ready operation.

## File and Responsibility Map

```text
package.json                         scripts and dependency manifest
tsconfig.json                        strict shared TypeScript settings
vite.config.ts                       React asset build
vitest.config.ts                     pure unit-test configuration
vitest.worker.config.ts              Cloudflare integration-test configuration
playwright.config.ts                 browser and accessibility tests
wrangler.jsonc                       Worker, D1, Workflow, assets, and schedules

src/contracts/                       cross-boundary types and Zod schemas
src/config/reader-profile.ts         initial research/news preferences
src/db/migrations/                   ordered D1 SQL migrations
src/db/repository.ts                 typed persistence interface
src/db/d1-repository.ts              D1 implementation
src/auth/access.ts                   Cloudflare Access JWT verification
src/sources/                         source adapters and source catalog
src/editorial/                       normalization, scoring, clustering, summaries
src/models/                          embedding and generation provider adapters
src/workflow/                        schedule coordinator and daily workflow
src/api/                             authenticated HTTP routes
src/worker.ts                        Worker entry point and bindings
src/web/                             React dashboard, components, and styles

tests/fixtures/                      frozen XML, JSON, HTML, and golden-set inputs
tests/unit/                          deterministic domain tests
tests/integration/                   D1, API, and Workflow tests
tests/e2e/                           authentication shell, responsive, and a11y tests
scripts/seed-dev.ts                  local fixture edition seeding
scripts/evaluate-golden-set.ts       editorial regression runner
docs/runbooks/                       deployment, source health, and recovery guides
```

### Task 1: Establish the TypeScript Worker and domain contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `src/contracts/editorial.ts`
- Create: `src/contracts/api.ts`
- Create: `tests/unit/contracts/editorial.test.ts`

**Interfaces:**
- Produces: `Item`, `SourceRef`, `ResearchAssessment`, `SummaryClaim`,
  `StructuredSummary`, `Edition`, `EditionEntry`, `RetentionReport`, and API
  response schemas.
- Produces: `ItemKind = "paper" | "blog" | "article" | "document" | "forecast"`.
- Consumes: no earlier task.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from "vitest";
import { StructuredSummarySchema } from "../../../src/contracts/editorial";

describe("StructuredSummarySchema", () => {
  it("rejects a factual claim without supporting sources", () => {
    const result = StructuredSummarySchema.safeParse({
      title: "A material development",
      oneSentence: "A policy changed.",
      whyItMatters: "The change affects evaluation.",
      uncertainty: "Implementation timing is unknown.",
      claims: [{ text: "The policy changed.", sourceIds: [] }],
      accessLevel: "full_text",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the contract test and verify the expected failure**

Run: `npm test -- tests/unit/contracts/editorial.test.ts`

Expected: FAIL because `src/contracts/editorial.ts` does not exist.

- [ ] **Step 3: Add the project manifest and strict compiler configuration**

```json
{
  "name": "optimist-briefing",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "check": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "dev": "vite",
    "deploy": "npm run build && wrangler deploy"
  },
  "dependencies": {
    "@hono/zod-validator": "^0.7.0",
    "@mozilla/readability": "^0.6.0",
    "fast-xml-parser": "^5.0.0",
    "hono": "^4.0.0",
    "jose": "^6.0.0",
    "linkedom": "^0.18.0",
    "openai": "^5.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@axe-core/playwright": "^4.0.0",
    "@cloudflare/vite-plugin": "^1.0.0",
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.0.0",
    "@playwright/test": "^1.0.0",
    "@testing-library/react": "^16.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "jsdom": "^26.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.8.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

Set `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`useUnknownInCatchVariables` to `true` in `tsconfig.json`. Let `npm install`
create and pin `package-lock.json`; do not hand-edit the lockfile.

- [ ] **Step 4: Implement the shared schemas**

```ts
import { z } from "zod";

export const SourceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  role: z.enum(["primary", "reporting", "analysis", "opinion", "blog", "forecast"]),
  retrievedAt: z.string().datetime(),
});

export const SummaryClaimSchema = z.object({
  text: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
  evidenceExcerpt: z.string().min(1).max(800),
});

export const StructuredSummarySchema = z.object({
  title: z.string().min(1),
  oneSentence: z.string().min(1),
  whyItMatters: z.string().min(1),
  uncertainty: z.string().min(1),
  claims: z.array(SummaryClaimSchema).min(1),
  accessLevel: z.enum(["metadata", "abstract", "full_text", "secondary"]),
});

export type StructuredSummary = z.infer<typeof StructuredSummarySchema>;
```

Define the remaining types in the same file with exact discriminants and
database-safe string dates. API schemas import these types rather than
redeclaring them.

- [ ] **Step 5: Run unit tests and type checking**

Run: `npm test -- tests/unit/contracts/editorial.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: exit code 0.

- [ ] **Step 6: Commit the foundation**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts src/contracts tests/unit/contracts
git commit -m "chore: establish briefing TypeScript contracts"
```

### Task 2: Create the D1 schema and repository boundary

**Files:**
- Create: `src/db/migrations/0001_initial.sql`
- Create: `src/db/repository.ts`
- Create: `src/db/d1-repository.ts`
- Create: `tests/integration/db/repository.test.ts`
- Create: `vitest.worker.config.ts`
- Create: `wrangler.jsonc`
- Modify: `package.json`

**Interfaces:**
- Consumes: contracts from Task 1.
- Produces: `BriefingRepository` with `upsertItems`, `saveScores`,
  `saveSummary`, `createDraftEdition`, `publishEdition`, `getLatestEdition`,
  `recordFeedback`, `getPreferences`, and `getWorkflowRun`.
- Produces: `D1BriefingRepository`.

- [ ] **Step 1: Write a failing atomic-publication integration test**

```ts
it("does not expose draft editions and atomically exposes published editions", async () => {
  const repo = new D1BriefingRepository(env.DB);
  const draft = await repo.createDraftEdition("2026-07-29", "run-1");

  expect(await repo.getLatestEdition()).toBeNull();

  await repo.replaceEditionEntries(draft.id, [fixtureEditionEntry()]);
  await repo.publishEdition(draft.id, "2026-07-29T09:45:00.000Z", "published");

  expect((await repo.getLatestEdition())?.status).toBe("published");
});
```

- [ ] **Step 2: Run the Worker test and verify the expected failure**

Run: `npm run test:worker -- tests/integration/db/repository.test.ts`

Expected: FAIL because the migration and repository do not exist.

- [ ] **Step 3: Add the normalized schema**

Create tables named exactly:

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  trust_prior REAL NOT NULL DEFAULT 0.5,
  enabled INTEGER NOT NULL DEFAULT 1,
  restrictions_json TEXT NOT NULL DEFAULT '{}',
  last_success_at TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown'
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published_at TEXT,
  content_access_level TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE editions (
  id TEXT PRIMARY KEY,
  edition_date TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','partial','failed')),
  reading_minutes INTEGER,
  published_at TEXT,
  created_at TEXT NOT NULL
);
```

The same migration must also create `item_sources`, `paper_metadata`, `clusters`,
`scores`, `summaries`, `summary_claims`, `edition_entries`, `preferences`,
`feedback`, `workflow_runs`, and `audit_events`, with foreign keys and indexes on
edition date, item publication time, source health, section/order, and run status.
Create an `items_fts` FTS5 virtual table over title and normalized searchable
text, plus insert/update/delete triggers that keep it synchronized with `items`.

- [ ] **Step 4: Define and implement the repository**

```ts
export interface BriefingRepository {
  upsertItems(items: readonly Item[]): Promise<void>;
  saveScores(scores: readonly ItemScore[]): Promise<void>;
  saveSummary(itemId: string, summary: StructuredSummary): Promise<void>;
  createDraftEdition(editionDate: string, runId: string): Promise<Edition>;
  replaceEditionEntries(editionId: string, entries: readonly EditionEntry[]): Promise<void>;
  publishEdition(
    editionId: string,
    publishedAt: string,
    status: "published" | "partial",
  ): Promise<void>;
  getLatestEdition(): Promise<EditionWithEntries | null>;
  getEditionByDate(editionDate: string): Promise<EditionWithEntries | null>;
  listEditions(input: EditionListInput): Promise<EditionPage>;
  searchArchive(input: ArchiveSearchInput): Promise<ArchiveSearchPage>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  getPreferences(): Promise<ReaderPreferences>;
  listSources(): Promise<readonly SourceRecord[]>;
  createSource(input: CreateSourceInput): Promise<SourceRecord>;
  updateSource(sourceId: string, input: UpdateSourceInput): Promise<SourceRecord>;
  getWorkflowRun(runId: string): Promise<WorkflowRun | null>;
  pruneExpiredData(now: string): Promise<RetentionReport>;
}
```

Use prepared statements for all values. Implement publication with
`D1Database.batch()` so entry replacement and status transition succeed or fail
together. `getLatestEdition` treats both `published` and `partial` as visible and
orders them by edition date. Repository methods return parsed contract types,
never raw D1 rows.

- [ ] **Step 5: Apply the migration in the test pool and run integration tests**

Add `"test:worker": "vitest run --config vitest.worker.config.ts"` to
`package.json` alongside the Worker test configuration.

Run: `npm run test:worker -- tests/integration/db/repository.test.ts`

Expected: PASS, including the draft-visibility assertion.

- [ ] **Step 6: Commit the persistence layer**

```bash
git add package.json wrangler.jsonc vitest.worker.config.ts src/db tests/integration/db
git commit -m "feat: add atomic D1 briefing repository"
```

### Task 3: Add Cloudflare Access verification and the API shell

**Files:**
- Create: `src/auth/access.ts`
- Create: `src/api/app.ts`
- Create: `src/api/errors.ts`
- Create: `src/worker.ts`
- Create: `tests/unit/auth/access.test.ts`
- Create: `tests/integration/api/auth.test.ts`

**Interfaces:**
- Consumes: `BriefingRepository` from Task 2.
- Produces: `verifyAccessJwt(token, options): Promise<AuthenticatedUser>`.
- Produces: `createApp({ repository, authVerifier, workflow }): Hono<AppEnv>`.

- [ ] **Step 1: Write failing authentication tests**

```ts
it("denies a valid Google identity that is not on the allowlist", async () => {
  const verifier = createTestVerifier({ email: "other@example.com" });
  const app = createApp({
    repository: fakeRepo(),
    authVerifier: verifier,
    workflow: fakeWorkflow(),
  });
  const response = await app.request("/api/edition/latest", {
    headers: { "CF-Access-Jwt-Assertion": "signed-token" },
  });
  expect(response.status).toBe(403);
});

it("denies a request without an Access assertion", async () => {
  const app = createApp({
    repository: fakeRepo(),
    authVerifier: createTestVerifier(),
    workflow: fakeWorkflow(),
  });
  expect((await app.request("/api/edition/latest")).status).toBe(401);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/unit/auth/access.test.ts`

Expected: FAIL because `verifyAccessJwt` does not exist.

- [ ] **Step 3: Implement JWT verification**

```ts
export type AccessVerifierOptions = {
  teamDomain: string;
  audience: string;
  allowedEmails: ReadonlySet<string>;
};

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
  const email = z.string().email().parse(payload.email).toLowerCase();
  if (!options.allowedEmails.has(email)) throw new ForbiddenError();
  return { email };
}
```

Normalize the configured allowlist to lowercase. Return JSON errors with stable
codes `AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, and
`INTERNAL_ERROR`. Never return token contents or stack traces.

- [ ] **Step 4: Build the Hono shell and health route**

`GET /health` remains outside the application auth middleware and returns only:

```json
{"status":"ok"}
```

All `/api/*` routes require verified identity. `src/worker.ts` constructs the D1
repository and app from Worker bindings. Tests inject fakes; production code has
no authentication bypass flag.

- [ ] **Step 5: Run authentication and Worker integration tests**

Run: `npm test -- tests/unit/auth/access.test.ts`

Expected: PASS.

Run: `npm run test:worker -- tests/integration/api/auth.test.ts`

Expected: PASS for missing, invalid, unauthorized, and allowed identities.

- [ ] **Step 6: Commit the authenticated API shell**

```bash
git add src/auth src/api src/worker.ts tests/unit/auth tests/integration/api
git commit -m "feat: protect briefing API with Access identity"
```

### Task 4: Deliver the fixture-backed dashboard milestone

**Files:**
- Create: `index.html`
- Create: `playwright.config.ts`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`
- Create: `src/web/api-client.ts`
- Create: `src/web/styles/tokens.css`
- Create: `src/web/styles/global.css`
- Create: `src/web/components/EditionView.tsx`
- Create: `src/web/components/PaperCard.tsx`
- Create: `src/web/components/NewsClusterCard.tsx`
- Create: `src/web/components/Sidebar.tsx`
- Create: `src/web/components/FeedbackActions.tsx`
- Create: `src/web/components/ReadingProgress.tsx`
- Create: `scripts/seed-dev.ts`
- Create: `tests/unit/web/EditionView.test.tsx`
- Create: `tests/e2e/dashboard.spec.ts`
- Modify: `src/api/app.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GET /api/edition/latest` returning `EditionWithEntries`.
- Produces: responsive reader shell and typed `BriefingApiClient`.

- [ ] **Step 1: Write a failing rendering test**

```tsx
it("renders provenance, access level, uncertainty, and feedback controls", () => {
  render(<EditionView edition={fixtureEdition()} />);
  expect(screen.getByText("Abstract only")).toBeTruthy();
  expect(screen.getByText(/Reasons for skepticism/i)).toBeTruthy();
  expect(screen.getByRole("link", { name: /Open paper/i }).getAttribute("href"))
    .toBe("https://arxiv.org/abs/fixture");
  expect(screen.getByRole("button", { name: "More like this" })).toBeTruthy();
});
```

- [ ] **Step 2: Verify the rendering test fails**

Run: `npm test -- tests/unit/web/EditionView.test.tsx`

Expected: FAIL because the React components do not exist.

- [ ] **Step 3: Seed a complete representative edition**

`scripts/seed-dev.ts` must insert:

- three morning-brief bullets
- one featured abstract-only paper with two claims and two sources
- one radar paper
- one world cluster with two reports
- one AI-policy cluster with a primary document
- one DMV item and one Baltimore item
- one Polymarket signal labeled `forecast`

Use fixed IDs and timestamps so screenshots and tests are stable.
Add `"seed:dev": "tsx scripts/seed-dev.ts"` to `package.json`.

- [ ] **Step 4: Implement the dashboard**

Use semantic landmarks and the approved tokens:

```css
:root {
  --burgundy: #681f35;
  --rose: #c98d98;
  --sage: #89997d;
  --mustard: #c69a2d;
  --cream: #f7f0e5;
  --ink: #302d2c;
  --focus: #175cd3;
}
```

Desktop has a compact sidebar. Below `760px`, use a single reading column and a
menu button with an accessible name. Preserve visible keyboard focus. Use text
labels and icons together for source role, forecast status, saved state, and
feedback state. `ReadingProgress` stores and restores the last visible entry ID
under `briefing-progress:<edition-date>` in local storage. The footer renders the
required arXiv acknowledgement verbatim.

- [ ] **Step 5: Add latest-edition and archive-list API routes**

Implement:

```text
GET /api/edition/latest
GET /api/editions?cursor=<opaque>&limit=20
GET /api/editions/:editionDate
```

Validate `limit` as an integer from 1 through 50. Encode the cursor as opaque
base64url JSON containing the last edition date; reject malformed cursors with
`VALIDATION_FAILED`.

- [ ] **Step 6: Run component, API, and browser tests**

Run: `npm test -- tests/unit/web/EditionView.test.tsx`

Expected: PASS.

Run: `npm run test:worker -- tests/integration/api`

Expected: PASS.

Run: `npm run test:e2e -- tests/e2e/dashboard.spec.ts`

Expected: PASS at desktop and mobile viewport projects.

- [ ] **Step 7: Commit the first demonstrable milestone**

```bash
git add src/web src/api scripts/seed-dev.ts tests/unit/web tests/e2e
git commit -m "feat: add private fixture-backed briefing dashboard"
```

### Task 5: Implement research and research-blog collection

**Files:**
- Create: `src/config/reader-profile.ts`
- Create: `src/sources/types.ts`
- Create: `src/sources/http-client.ts`
- Create: `src/sources/arxiv.ts`
- Create: `src/sources/semantic-scholar.ts`
- Create: `src/sources/openalex.ts`
- Create: `src/sources/rss.ts`
- Create: `src/sources/paper-content.ts`
- Create: `src/sources/research-collector.ts`
- Create: `tests/fixtures/arxiv-response.xml`
- Create: `tests/fixtures/semantic-scholar-paper.json`
- Create: `tests/fixtures/openalex-work.json`
- Create: `tests/fixtures/research-blog.xml`
- Create: `tests/unit/sources/research-collector.test.ts`

**Interfaces:**
- Produces: `SourceAdapter.collect(window: CollectionWindow): Promise<RawItem[]>`.
- Produces: `ResearchCollector.collect(window): Promise<RawResearchCandidate[]>`.
- Consumes: reader profile and source catalog records.

- [ ] **Step 1: Write failing collector tests from frozen responses**

```ts
it("records abstract-only access without claiming full-paper access", async () => {
  const candidates = await collectorWithFixtures().collect(fixedWindow());
  const paper = candidates.find((candidate) => candidate.externalId === "arXiv:2607.00001");
  expect(paper?.accessLevel).toBe("abstract");
  expect(paper?.authors).toEqual(["Ada Example", "Grace Example"]);
});

it("associates a blog post with its discussed arXiv paper", async () => {
  const candidates = await collectorWithFixtures().collect(fixedWindow());
  expect(candidates.find((item) => item.kind === "blog")?.relatedPaperIds)
    .toContain("arXiv:2607.00001");
});
```

- [ ] **Step 2: Verify the collector tests fail**

Run: `npm test -- tests/unit/sources/research-collector.test.ts`

Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement a bounded HTTP client**

`SourceHttpClient.get()` must enforce a 15-second timeout, a 5 MB response limit,
an identifying `User-Agent`, conditional requests using ETag/Last-Modified, and
bounded retry for `429`, `502`, `503`, and `504`. It must honor `Retry-After` and
return a typed `SourceFetchError` containing source ID, status, retryability, and
no response body.

- [ ] **Step 4: Implement arXiv, Semantic Scholar, OpenAlex, and RSS adapters**

Use arXiv for discovery, then enrich discovered identifiers in batches.
Normalize institutional aliases before applying preferred-institution signals.
The RSS adapter accepts configured feeds rather than embedding lab URLs in code.
For every candidate, preserve retrieval time, original URL, external IDs, and
the exact content access level. `paper-content.ts` retrieves arXiv HTML only when
the source record permits body retrieval, bounds it with `SourceHttpClient`, and
extracts the paper body with Readability. It falls back to the abstract and marks
the item `abstract` when HTML is unavailable or extraction fails; it never
upgrades access based on a PDF link alone.

- [ ] **Step 5: Encode the initial reader profile**

`reader-profile.ts` exports immutable topic descriptions, positive example
phrases, preferred institutions, preferred labs, geographic interests, and
section budgets copied from the approved design. It contains no secret or user
email.

- [ ] **Step 6: Run research collector tests**

Run: `npm test -- tests/unit/sources/research-collector.test.ts`

Expected: PASS without network access.

- [ ] **Step 7: Commit research discovery**

```bash
git add src/config src/sources tests/fixtures tests/unit/sources
git commit -m "feat: collect and enrich research candidates"
```

### Task 6: Implement news, local, article, and forecast collection

**Files:**
- Create: `src/sources/gdelt.ts`
- Create: `src/sources/polymarket.ts`
- Create: `src/sources/article-extractor.ts`
- Create: `src/sources/news-collector.ts`
- Create: `src/db/migrations/0002_source_catalog.sql`
- Create: `tests/fixtures/gdelt-response.json`
- Create: `tests/fixtures/polymarket-markets.json`
- Create: `tests/fixtures/article.html`
- Create: `tests/fixtures/local-news.xml`
- Create: `tests/unit/sources/news-collector.test.ts`

**Interfaces:**
- Produces: `NewsCollector.collect(window): Promise<RawNewsCandidate[]>`.
- Produces: `extractReadableArticle(html, url): ExtractedArticle`.
- Consumes: `SourceHttpClient`, RSS adapter, and source catalog.

- [ ] **Step 1: Write failing source-role and extraction tests**

```ts
it("labels Polymarket data as forecast and never as corroborating reporting", async () => {
  const items = await newsCollectorWithFixtures().collect(fixedWindow());
  const market = items.find((item) => item.kind === "forecast");
  expect(market?.sourceRole).toBe("forecast");
  expect(market?.canCorroborateFacts).toBe(false);
});

it("extracts article text while excluding navigation and scripts", () => {
  const article = extractReadableArticle(articleFixture, "https://example.com/story");
  expect(article.text).toContain("The reported development");
  expect(article.text).not.toContain("Subscribe now");
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/unit/sources/news-collector.test.ts`

Expected: FAIL because the news adapters do not exist.

- [ ] **Step 3: Seed the editable source catalog**

Migration `0002_source_catalog.sql` inserts stable IDs and role labels for:

- Reuters, AP, NPR, The Economist
- NIST, Federal Register, Congress.gov, and relevant Maryland/DC/Virginia
  government sources
- WYPR, The Baltimore Banner, Baltimore Brew, WTOP, Maryland Matters, and WAMU
- GDELT, Monitoring the Situation, and Polymarket
- official research blogs for preferred universities and laboratories

Set paywall and content-use restrictions explicitly. Use `INSERT OR IGNORE` so
local customization survives later migrations.

- [ ] **Step 4: Implement news discovery and readable extraction**

GDELT supplies discovery URLs, not article truth. Direct feeds and pages retain
their configured source roles. `extractReadableArticle` uses linkedom and Mozilla
Readability, rejects non-HTML content, strips scripts/forms/navigation, returns
at most 100,000 characters, and records whether extraction was full, partial, or
metadata-only.

- [ ] **Step 5: Implement material forecast changes**

Store current probability, prior probability, absolute change, retrieval time,
liquidity when available, and resolution source. Select a forecast signal only
when it passes configured liquidity and absolute-change thresholds. The UI copy
must include "Forecast, not fact."

- [ ] **Step 6: Run news collector tests**

Run: `npm test -- tests/unit/sources/news-collector.test.ts`

Expected: PASS without network access.

- [ ] **Step 7: Commit news discovery**

```bash
git add src/sources src/db/migrations/0002_source_catalog.sql tests/fixtures tests/unit/sources
git commit -m "feat: collect news local and forecast signals"
```

### Task 7: Normalize, deduplicate, cluster, and rank candidates

**Files:**
- Create: `src/editorial/normalize.ts`
- Create: `src/editorial/deduplicate.ts`
- Create: `src/editorial/cluster.ts`
- Create: `src/editorial/research-score.ts`
- Create: `src/editorial/news-score.ts`
- Create: `src/editorial/shortlist.ts`
- Create: `tests/unit/editorial/research-score.test.ts`
- Create: `tests/unit/editorial/deduplicate.test.ts`
- Create: `tests/unit/editorial/shortlist.test.ts`

**Interfaces:**
- Produces: `normalizeCandidate(raw): Item`.
- Produces: `deduplicateItems(items): DeduplicationResult`.
- Produces: `clusterNews(items, embeddings): NewsCluster[]`.
- Produces: `scoreResearch(input): ItemScore`.
- Produces: `shortlist(items, scores, preferences, budgets): Shortlist`.
- Consumes: optional `ResearchAssessment` from Task 8; absent assessment is
  neutral, never zero.

- [ ] **Step 1: Write failing scoring and diversity tests**

```ts
it("caps affiliation at fifteen percent of the research score", () => {
  const score = scoreResearch(researchScoreFixture({
    topicalFit: 0,
    technicalQuality: 0,
    researchSignal: 1,
    novelty: 0,
    seriousAttention: 0,
  }));
  expect(score.total).toBe(0.15);
});

it("does not penalize a new paper for missing citation data", () => {
  const missing = scoreResearch(researchScoreFixture({ seriousAttention: null }));
  const neutral = scoreResearch(researchScoreFixture({ seriousAttention: 0.5 }));
  expect(missing.total).toBe(neutral.total);
});

it("reserves shortlist space for distinct configured topics", () => {
  const result = shortlist(overrepresentedInterpretabilityItems(), scores(), prefs(), budgets());
  expect(new Set(result.researchFeatured.map((item) => item.primaryTopic)).size)
    .toBeGreaterThan(1);
});
```

- [ ] **Step 2: Verify the editorial tests fail**

Run: `npm test -- tests/unit/editorial`

Expected: FAIL because the editorial functions do not exist.

- [ ] **Step 3: Implement canonicalization and duplicate detection**

Canonicalize tracking parameters, DOI/arXiv identifiers, source syndication
URLs, normalized titles, and publication times. Exact identifiers merge
deterministically. Near duplicates require title similarity plus compatible
publication windows; record the merge reason and retain all source references.

- [ ] **Step 4: Implement scoring**

Research weights are exactly `0.35`, `0.30`, `0.15`, `0.10`, and `0.10`.
Normalize every component to `[0,1]`, use `0.5` for unavailable new-paper
attention, store components separately, and generate selection reasons from
component values rather than free-form model text.

News scoring stores public importance, personal relevance, source quality,
corroboration, recency, geography, and novelty separately. A forecast source
contributes zero corroboration.

- [ ] **Step 5: Implement clustering and section budgets**

Cluster news by semantic similarity, named entities, canonical primary document,
and publication window. Enforce the approved section ranges as maximums, not
quotas. Reject clusters that repeat a development already covered in the
previous edition unless material facts changed.

- [ ] **Step 6: Run all pure editorial tests**

Run: `npm test -- tests/unit/editorial`

Expected: PASS.

- [ ] **Step 7: Commit deterministic editorial selection**

```bash
git add src/editorial tests/unit/editorial
git commit -m "feat: rank cluster and shortlist briefing items"
```

### Task 8: Add model assessment, embeddings, synthesis, and grounding validation

**Files:**
- Create: `src/models/provider.ts`
- Create: `src/models/openai-provider.ts`
- Create: `src/models/fake-provider.ts`
- Create: `src/editorial/assess-research.ts`
- Create: `src/editorial/summarize.ts`
- Create: `src/editorial/validate-summary.ts`
- Create: `tests/unit/editorial/validate-summary.test.ts`
- Create: `tests/unit/editorial/summarize.test.ts`

**Interfaces:**
- Produces: `ModelProvider.embed(texts): Promise<number[][]>`.
- Produces: `ModelProvider.generateObject(request): Promise<unknown>`.
- Produces: `assessResearch(candidate, provider): Promise<ResearchAssessment>`.
- Produces: `summarizeItem(packet, provider): Promise<StructuredSummary>`.
- Produces: `validateSummary(summary, packet): ValidationResult`.

- [ ] **Step 1: Write failing grounding tests**

```ts
it("rejects a claim whose source is absent from the supplied packet", () => {
  const result = validateSummary(
    summaryFixture({ claims: [{ text: "Claim", sourceIds: ["unknown"], evidenceExcerpt: "Claim" }] }),
    sourcePacketFixture({ sourceIds: ["source-1"] }),
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("UNKNOWN_SOURCE:unknown");
});

it("rejects full-paper wording when only an abstract was supplied", () => {
  const result = validateSummary(
    summaryFixture({ accessLevel: "full_text" }),
    sourcePacketFixture({ accessLevel: "abstract" }),
  );
  expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
});
```

- [ ] **Step 2: Verify the grounding tests fail**

Run: `npm test -- tests/unit/editorial/validate-summary.test.ts`

Expected: FAIL because validation does not exist.

- [ ] **Step 3: Define and implement the provider interface**

```ts
export interface ModelProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  generateObject(input: {
    model: string;
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    system: string;
    sourcePacket: string;
    maxOutputTokens: number;
  }): Promise<unknown>;
}
```

`OpenAIModelProvider` receives API key and model names through Worker secrets and
bindings, calls the official SDK, records token usage, and returns unknown data
for Zod validation. It retries only transport, rate-limit, and server errors.
Schema or grounding failure is handled by the editorial layer, not hidden inside
the provider. `FakeModelProvider` returns queued deterministic values in tests.

- [ ] **Step 4: Implement bounded source packets and structured prompts**

Source packets contain source ID, role, title, URL, retrieval time, access level,
and numbered excerpts. They exclude navigation, credentials, unrelated page
content, and previous model prose. The system prompt explicitly requires:

```text
Use only the supplied source packet.
Every factual claim must cite one or more supplied source IDs.
State uncertainty and disagreement.
Do not imply full-paper access when access_level is abstract or metadata.
Return only data matching the supplied JSON schema.
```

- [ ] **Step 5: Implement validation and one controlled repair attempt**

Validate schema, source membership, nonempty evidence, evidence-excerpt presence
in normalized source text, access-level honesty, required uncertainty, and
forecast labels. On failure, make one repair call containing only validation
errors and the original packet. If repair fails, return a rejected summary with
machine-readable reasons; never publish it.

- [ ] **Step 6: Run assessment, synthesis, and grounding tests**

Run: `npm test -- tests/unit/editorial`

Expected: PASS, including malformed JSON, unknown citation, empty uncertainty,
access overclaim, and successful repair cases.

- [ ] **Step 7: Commit grounded synthesis**

```bash
git add src/models src/editorial tests/unit/editorial
git commit -m "feat: add grounded model synthesis and validation"
```

### Task 9: Assemble a manually triggered end-to-end editorial run

**Files:**
- Create: `src/workflow/types.ts`
- Create: `src/workflow/run-editorial-pipeline.ts`
- Create: `src/workflow/compose-edition.ts`
- Create: `src/workflow/publish-edition.ts`
- Create: `tests/integration/workflow/manual-run.test.ts`
- Modify: `src/api/app.ts`
- Modify: `src/worker.ts`

**Interfaces:**
- Produces: `runEditorialPipeline(context): Promise<PipelineResult>`.
- Produces: `POST /api/admin/runs` and `POST /api/admin/runs/:runId/resume`.
- Consumes: collectors, repository, editorial functions, and model provider.

- [ ] **Step 1: Write a failing end-to-end fixture-run test**

```ts
it("collects, validates, and atomically publishes one edition", async () => {
  const result = await runEditorialPipeline(fixturePipelineContext());
  expect(result.status).toBe("published");
  const latest = await fixtureRepo.getLatestEdition();
  expect(latest?.entries.some((entry) => entry.section === "research")).toBe(true);
  expect(latest?.entries.every((entry) => entry.summary.validationStatus === "valid"))
    .toBe(true);
});
```

- [ ] **Step 2: Verify the integration test fails**

Run: `npm run test:worker -- tests/integration/workflow/manual-run.test.ts`

Expected: FAIL because the pipeline orchestrator does not exist.

- [ ] **Step 3: Implement the pipeline with persisted checkpoints**

Use checkpoint names exactly:

```text
collect
normalize
enrich
prefilter
assess
score
cluster
shortlist
synthesize
validate
compose
publish
```

Before each step, read `workflow_runs`. After success, persist step output
references, attempt count, duration, item counts, and estimated model cost. A
resume skips completed steps and uses stored artifacts. Every write uses the
edition date and run ID to prevent duplicates.

- [ ] **Step 4: Implement composition and partial-edition rules**

Compose six to eight morning-brief entries from already validated section
summaries. Permit `partial` only when at least one research item, one nonlocal
news cluster, and one DMV/Baltimore item remain valid. Record missing sections
and source failures in edition metadata. Otherwise leave the draft unpublished.

- [ ] **Step 5: Add authenticated manual-run endpoints**

Only the allowed user may start or resume a run. Starting an existing edition
date returns `409 RUN_ALREADY_EXISTS`; resume requires a retryable failed or
partial run. Write an `audit_events` record for each action.

- [ ] **Step 6: Test success, resume, and failed-publication behavior**

Run: `npm run test:worker -- tests/integration/workflow/manual-run.test.ts`

Expected: PASS for complete publication, source-partial publication, failed
minimum coverage, interrupted resume, idempotent retry, and prior-edition
preservation.

- [ ] **Step 7: Commit the live manual pipeline**

```bash
git add src/workflow src/api src/worker.ts tests/integration/workflow
git commit -m "feat: run and publish the editorial pipeline"
```

### Task 10: Add feedback, preferences, saves, archive search, and run status

**Files:**
- Create: `src/api/routes/feedback.ts`
- Create: `src/api/routes/preferences.ts`
- Create: `src/api/routes/archive.ts`
- Create: `src/api/routes/runs.ts`
- Create: `src/api/routes/sources.ts`
- Create: `src/web/pages/ArchivePage.tsx`
- Create: `src/web/pages/PreferencesPage.tsx`
- Create: `src/web/pages/RunStatusPage.tsx`
- Create: `src/web/pages/SavedPage.tsx`
- Create: `tests/integration/api/preferences.test.ts`
- Create: `tests/unit/web/PreferencesPage.test.tsx`
- Modify: `src/db/repository.ts`
- Modify: `src/db/d1-repository.ts`
- Modify: `src/web/App.tsx`

**Interfaces:**
- Produces: feedback and preference mutation endpoints.
- Produces: authenticated source catalog read/create/update endpoints.
- Produces: archive query `q`, `topic`, `author`, `institution`, `source`,
  `section`, and opaque cursor filters.
- Consumes: existing edition, score, feedback, preference, and workflow records.

- [ ] **Step 1: Write failing explicit-preference tests**

```ts
it("records less-like-this with a reason and exposes the resulting weight", async () => {
  await repo.recordFeedback({
    itemId: "paper-1",
    action: "less_like_this",
    reason: "too_incremental",
  });
  const preferences = await repo.getPreferences();
  expect(preferences.feedbackHistory[0]?.reason).toBe("too_incremental");
});

it("reset restores the approved baseline profile", async () => {
  await client.resetPreferences();
  expect((await client.getPreferences()).topics).toEqual(baselineReaderProfile.topics);
});
```

- [ ] **Step 2: Verify preference tests fail**

Run: `npm run test:worker -- tests/integration/api/preferences.test.ts`

Expected: FAIL because preference routes are absent.

- [ ] **Step 3: Implement stable mutation contracts**

```text
POST /api/feedback
  {itemId, action: "save"|"unsave"|"more_like_this"|"less_like_this", reason?}

GET /api/preferences
PUT /api/preferences
POST /api/preferences/reset
GET /api/archive
GET /api/runs
GET /api/runs/:runId
GET /api/sources
POST /api/sources
PUT /api/sources/:sourceId
```

Validate reason values against `topic`, `quality`, `source`, `depth`,
`repetitive`, `too_incremental`, and `other`. Store the raw action and resulting
explicit weight delta. Passive views do not change preferences.

Source creation requires canonical name, HTTPS canonical URL, role, section
eligibility, discovery mechanism, trust prior from `0` through `1`, restrictions,
and enabled state. Updating a source records an audit event. Duplicate canonical
URLs return `409 SOURCE_ALREADY_EXISTS`. This makes new feeds and blogs
configurable without a code deployment.

- [ ] **Step 4: Build archive, preferences, saves, and status pages**

The preferences page shows baseline and feedback-derived adjustments separately.
Every adjustment can be removed. Run status shows checkpoint state, attempts,
source failures, rejected summary reasons, publish time, and estimated monthly
cost without exposing source packets or secrets.

- [ ] **Step 5: Run repository, API, and component tests**

Run: `npm run test:worker -- tests/integration/api/preferences.test.ts`

Expected: PASS.

Run: `npm test -- tests/unit/web/PreferencesPage.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit reader controls**

```bash
git add src/api/routes src/web/pages src/web/App.tsx src/db tests/integration/api tests/unit/web
git commit -m "feat: add archive feedback and briefing controls"
```

### Task 11: Schedule the durable Cloudflare Workflow and enforce the budget

**Files:**
- Create: `src/workflow/daily-briefing-workflow.ts`
- Create: `src/workflow/schedule.ts`
- Create: `src/models/cost-ledger.ts`
- Create: `src/maintenance/retention.ts`
- Create: `tests/unit/workflow/schedule.test.ts`
- Create: `tests/unit/models/cost-ledger.test.ts`
- Create: `tests/unit/maintenance/retention.test.ts`
- Create: `tests/integration/workflow/resume.test.ts`
- Modify: `wrangler.jsonc`
- Modify: `src/worker.ts`

**Interfaces:**
- Produces: `DailyBriefingWorkflow extends WorkflowEntrypoint<Env, RunParams>`.
- Produces: `shouldRunAt(instant, timeZone, runState): ScheduleDecision`.
- Produces: `BudgetPolicy` with warning, degraded, and hard-stop states.
- Produces: `pruneExpiredData(repository, now): Promise<RetentionReport>`.

- [ ] **Step 1: Write failing daylight-saving and budget tests**

```ts
it.each([
  ["2026-07-29T08:30:00Z", true],
  ["2026-01-29T08:30:00Z", false],
  ["2026-01-29T09:30:00Z", true],
  ["2026-01-29T10:30:00Z", true],
])("evaluates %s in America/New_York", (instant, expected) => {
  expect(shouldRunAt(new Date(instant), "America/New_York", noPublishedRun()).run)
    .toBe(expected);
});

it("reduces radar depth at ninety percent without degrading featured summaries", () => {
  expect(policyForSpend(27, 30)).toEqual({
    state: "degraded",
    radarSummaryTokens: 120,
    featuredSummaryTokens: 900,
  });
});

it("deletes expired candidates and logs without deleting published edition items", async () => {
  const report = await pruneExpiredData(retentionFixtureRepo(), fixedNow);
  expect(report.deletedUnselectedCandidates).toBe(2);
  expect(report.deletedDiagnosticLogs).toBe(3);
  expect(await retentionFixtureRepo().getEditionByDate("2026-07-28")).not.toBeNull();
});
```

- [ ] **Step 2: Verify schedule and budget tests fail**

Run: `npm test -- tests/unit/workflow/schedule.test.ts tests/unit/models/cost-ledger.test.ts`

Expected: FAIL because the schedule and ledger do not exist.

- [ ] **Step 3: Configure Workflow schedules**

Add schedules `30 8 * * *`, `30 9 * * *`, and `30 10 * * *` to the Workflow
binding. The coordinator runs only in the local `04:00`–`05:50` window, exits if
the edition is published, and resumes a retryable run. Use the local edition date
as the Workflow instance ID.

- [ ] **Step 4: Implement durable steps and bounded retries**

Wrap every Task 9 checkpoint in `step.do()` with explicit timeout and retry
configuration. Do not wrap the whole edition in one step. Persist D1 checkpoint
state in addition to Workflow state so manual recovery and the status page agree.

- [ ] **Step 5: Implement cost accounting**

Record provider, model, input tokens, output tokens, embedding count, configured
unit price, and estimated cost for every call. At 70% monthly spend, expose a
warning. At 90%, shorten only radar summaries and reduce radar count. At the
configured hard limit, skip optional radar generation and publish eligible
featured/news content; do not make unbudgeted calls.

- [ ] **Step 6: Implement retention enforcement**

After a successful publication, call `BriefingRepository.pruneExpiredData()` to
delete unselected candidates whose `expires_at` has passed, workflow details
older than 90 days, and diagnostic logs older than 30 days. Never delete an item
referenced by an edition, save, feedback record, or summary claim. Return counts
for the run-status page and record an audit event.

- [ ] **Step 7: Run schedule, cost, retention, and resume tests**

Run: `npm test -- tests/unit/workflow tests/unit/models tests/unit/maintenance`

Expected: PASS.

Run: `npm run test:worker -- tests/integration/workflow/resume.test.ts`

Expected: PASS after injected failure at every checkpoint.

- [ ] **Step 8: Commit scheduled operation**

```bash
git add src/workflow src/models/cost-ledger.ts src/maintenance wrangler.jsonc src/worker.ts tests
git commit -m "feat: schedule durable budgeted briefing runs"
```

### Task 12: Add golden-set evaluation, accessibility, and operational regression gates

**Files:**
- Create: `tests/golden/research-candidates.json`
- Create: `tests/golden/news-clusters.json`
- Create: `tests/golden/expected-rankings.json`
- Create: `tests/golden/expected-grounding.json`
- Create: `scripts/evaluate-golden-set.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/e2e/mobile.spec.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run evaluate` with a nonzero exit on threshold regression.
- Produces: CI gate for type checking, unit, Worker integration, golden-set, build,
  and browser tests.

- [ ] **Step 1: Create a failing golden-set evaluation**

The fixture set must include:

- a highly relevant strong paper
- a preferred-institution but weak incremental paper
- a strong unfamiliar-institution paper
- a new paper with no citations
- an abstract-only paper
- duplicate wire stories
- conflicting credible reports
- opinion presented with factual language
- sensational low-value coverage
- a Polymarket movement with no corroborating report
- separate DMV and Baltimore stories

Assert minimum precision-at-5 of `0.8`, all required high-value items above all
known distractors, duplicate-cluster recall of `1.0`, and zero accepted claims
with missing supporting source IDs.

- [ ] **Step 2: Run the evaluation and verify it fails before the command exists**

Run: `npm run evaluate`

Expected: FAIL because `evaluate` is not yet defined.

- [ ] **Step 3: Implement the deterministic evaluation runner**

The script reads versioned fixtures, calls the same normalization, scoring,
clustering, shortlist, and validation functions used in production, prints each
metric, and exits `1` when any threshold fails. It uses `FakeModelProvider`; CI
must not make paid or network model calls.

- [ ] **Step 4: Add accessibility and responsive tests**

Use axe on Today, Archive, Preferences, and Run Status. Assert no serious or
critical violations, visible keyboard focus, labeled navigation, forecast text
labels, and usable layouts at `390x844`, `768x1024`, and `1440x900`.

- [ ] **Step 5: Add CI**

CI runs, in order:

```text
npm ci
npx playwright install --with-deps chromium
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
npm run test:e2e
```

Cache only the npm download cache. Upload Playwright traces only on failure. No
production secrets are available to CI.

- [ ] **Step 6: Run the complete local verification suite**

Run every CI command in the same order.

Expected: all exit code 0 and the golden-set report meets every threshold.

- [ ] **Step 7: Commit evaluation and CI gates**

```bash
git add tests/golden tests/e2e scripts/evaluate-golden-set.ts package.json .github/workflows/ci.yml
git commit -m "test: gate briefing quality and accessibility"
```

### Task 13: Configure production, document runbooks, and perform launch verification

**Files:**
- Create: `.dev.vars.example`
- Create: `docs/runbooks/deployment.md`
- Create: `docs/runbooks/source-health.md`
- Create: `docs/runbooks/failed-edition.md`
- Create: `docs/runbooks/cost-control.md`
- Create: `docs/runbooks/privacy-and-retention.md`
- Create: `README.md`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: reproducible Cloudflare deployment and operator procedures.

- [ ] **Step 1: Document exact required configuration**

`.dev.vars.example` lists names only, with safe descriptions:

```dotenv
OPENAI_API_KEY=
SUMMARY_MODEL=
ASSESSMENT_MODEL=
EMBEDDING_MODEL=
CLOUDFLARE_ACCESS_TEAM_DOMAIN=
CLOUDFLARE_ACCESS_AUDIENCE=
ALLOWED_EMAILS=
MONTHLY_AI_BUDGET_USD=30
```

The deployment runbook explains how to set each value with `wrangler secret put`
or nonsecret Worker variables. It instructs the operator to choose currently
available models and record their unit prices in cost configuration before the
first live run; the application refuses startup when required model or price
configuration is absent.

- [ ] **Step 2: Document external account changes as user-approved checkpoints**

The deployment runbook separates commands from external control-plane actions:

1. Create or select the Cloudflare account.
2. Add `optimistindustries.com` as a Cloudflare zone.
3. Review imported DNS records.
4. Ask the user before changing GoDaddy nameservers.
5. Create the D1 database and Workflow binding.
6. Create Google OAuth credentials for Cloudflare Access.
7. Create a deny-by-default Access application and allow only the approved email.
8. Ask the user before the first production deployment.

No plan executor may infer permission to change nameservers or deploy to
production merely from permission to implement code.

- [ ] **Step 3: Write recovery, source-health, retention, and cost runbooks**

Include exact status-page checks, relevant `wrangler` log commands, retry/resume
API actions, criteria for disabling a bad source, how to restore the previous
edition, 90/30-day retention jobs, and the 70/90/100% budget actions.

- [ ] **Step 4: Verify local production build and migration**

Run: `npm ci`

Run: `npm run check`

Run: `npm test`

Run: `npm run test:worker`

Run: `npm run evaluate`

Run: `npm run build`

Run against a temporary local D1 database:
`wrangler d1 migrations apply optimist-briefing --local`

Expected: all commands succeed and all migrations apply once; a second migration
run reports no pending migrations.

- [ ] **Step 5: Perform an authenticated preview rehearsal**

After the user approves creation of preview resources:

1. Deploy a preview Worker with production-like bindings.
2. Confirm `/health` returns only `{"status":"ok"}`.
3. Confirm an unauthenticated request to the application is denied by Access.
4. Confirm a nonallowed Google account is denied.
5. Confirm the allowed Google account can view the fixture edition.
6. Trigger a live-source draft without publishing it.
7. Review source health, ranking, summaries, grounding, and estimated cost.
8. Publish the preview edition and run Playwright against the preview URL.

- [ ] **Step 6: Perform the production launch only after explicit approval**

After the preview is accepted and the user approves nameserver and deployment
changes:

1. Change GoDaddy nameservers to the values provided by Cloudflare.
2. Wait for Cloudflare to report the zone active.
3. Apply remote D1 migrations.
4. Set production secrets and variables.
5. Deploy the saved, verified commit.
6. Enable the Access policy before exposing the briefing routes.
7. Trigger one manual run and verify atomic publication.
8. Verify Workflow schedules are present.
9. Confirm the next valid morning run publishes by 6:00 a.m. Eastern.

- [ ] **Step 7: Commit the production runbooks**

```bash
git add .dev.vars.example README.md wrangler.jsonc docs/runbooks
git commit -m "docs: add briefing deployment and operations runbooks"
```

## Final Verification

Run:

```text
npm ci
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
npm run test:e2e
git status --short
```

Expected:

- every command exits successfully
- golden-set thresholds pass
- browser tests pass at all configured viewports
- `git status --short` is empty
- the latest production edition is authenticated, source-linked, and published
  by 6:00 a.m. Eastern
