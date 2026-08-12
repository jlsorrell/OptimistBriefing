# Dynamic Preview End-to-End Content Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authenticated, read-only preview content suite validate whichever published edition `/api/edition/latest` currently returns while retaining deterministic coverage for seeded and sparse edition shapes.

**Architecture:** Add a pure test-side parser for the latest-edition fields the suite consumes, then a Playwright comparator that derives date, section, entry, source-host, and conditional-label expectations from that parsed edition. Keep live-state verification separate from deterministic route-fulfilled fixtures; outside those helpers, update only preview diagnostics metadata and the rehearsal runbook.

**Tech Stack:** TypeScript 5.8, Zod 3, Playwright, Vitest, React-rendered preview UI, Cloudflare Access Managed OAuth preview harness.

## Global Constraints

- Do not change Worker, API, database, editorial, authentication, or production behavior.
- Do not reseed, delete, rewrite, or otherwise mutate preview D1 data.
- Do not add an expected-edition-date environment variable or another manually maintained freshness setting.
- Do not weaken editorial, accessibility, responsive, Access, or canary-evidence checks.
- Keep authorization codes, PKCE values, bearer credentials, cookies, and browser storage memory-only; never log or commit them.
- Keep the bearer token restricted to the exact preview origin; do not add browser-global HTTP headers.
- Preserve exact `/api/runs` before/after equality as the executable no-mutation proof.
- Missing, empty, HTTP-error, or malformed latest editions fail; never fall back to July 29.
- Derive hosts only from card-rendered sections; `morning_brief` intentionally has no source list.
- Compare deduplicated expected and rendered source-host sets for exact equality.
- Sparse editions omit empty sections instead of fabricating placeholders.
- Do not deploy, migrate, start a Workflow, call a live model, or modify production.

---

### Task 1: Pure latest-edition test contract

**Files:**
- Create: `tests/preview-e2e/edition-contract.ts`
- Create: `tests/unit/config/preview-edition-contract.test.ts`

**Interfaces:**
- Consumes: `fixtureEdition(): EditionWithEntries` from `scripts/seed-dev.ts` and existing Zod.
- Produces: `PREVIEW_SECTIONS`, `PREVIEW_SECTION_LABELS`, `PreviewSection`, `PreviewSourceRef`, `PreviewEntry`, `PreviewEdition`, `parsePreviewEdition(body: unknown): PreviewEdition`, `formatPreviewEditionDate(editionDate: string): string`, and `expectedCardSourceHosts(entries: readonly PreviewEntry[]): string[]`.
- Error contract: every rejection begins with `Preview edition contract:` and includes its first failing path.

- [ ] **Step 1: Write the parser and derivation tests before the module exists**

Create `tests/unit/config/preview-edition-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { fixtureEdition } from "../../../scripts/seed-dev";
import {
  expectedCardSourceHosts,
  formatPreviewEditionDate,
  parsePreviewEdition,
  PREVIEW_SECTION_LABELS,
  PREVIEW_SECTIONS,
} from "../../preview-e2e/edition-contract";

function sparseEdition() {
  const seeded = fixtureEdition();
  const editionId = "edition-2026-08-09";
  return {
    ...seeded,
    id: editionId,
    editionDate: "2026-08-09",
    runId: "run-2026-08-09",
    status: "partial",
    readingMinutes: 20,
    publishedAt: "2026-08-09T10:04:00.000Z",
    createdAt: "2026-08-09T10:00:00.000Z",
    entries: seeded.entries
      .filter(({ section }) => section === "research" || section === "baltimore")
      .map((entry) => ({ ...entry, editionId })),
  };
}

describe("preview edition contract", () => {
  it("parses the seeded edition and derives its complete card host set", () => {
    const edition = parsePreviewEdition(fixtureEdition());
    expect(edition.editionDate).toBe("2026-07-29");
    expect(formatPreviewEditionDate(edition.editionDate)).toBe(
      "Wednesday, July 29, 2026",
    );
    expect(expectedCardSourceHosts(edition.entries)).toEqual([
      "apnews.com",
      "arxiv.org",
      "polymarket.com",
      "www.anthropic.com",
      "www.nist.gov",
      "www.reuters.com",
      "www.thebaltimorebanner.com",
      "wtop.com",
    ]);
  });

  it("parses a newer sparse partial edition without inventing sections or hosts", () => {
    const edition = parsePreviewEdition(sparseEdition());
    expect(formatPreviewEditionDate(edition.editionDate)).toBe(
      "Sunday, August 9, 2026",
    );
    expect(new Set(edition.entries.map(({ section }) => section))).toEqual(
      new Set(["research", "baltimore"]),
    );
    expect(expectedCardSourceHosts(edition.entries)).toEqual([
      "arxiv.org",
      "www.anthropic.com",
      "www.thebaltimorebanner.com",
    ]);
  });

  it("exports canonical order and headings", () => {
    expect(PREVIEW_SECTIONS).toEqual([
      "morning_brief", "research", "research_radar", "world", "technology",
      "ai_policy", "dmv", "baltimore", "forecast",
    ]);
    expect(PREVIEW_SECTION_LABELS).toEqual({
      morning_brief: "Morning brief",
      research: "Research",
      research_radar: "On the radar",
      world: "World",
      technology: "Technology",
      ai_policy: "AI policy",
      dmv: "DMV",
      baltimore: "Baltimore",
      forecast: "Forecast signals",
    });
  });

  const valid = fixtureEdition();
  const firstEntry = valid.entries[0]!;
  const firstSource = firstEntry.sourceRefs[0]!;
  it.each([
    ["non-object response", null],
    ["missing entries", { editionDate: "2026-07-29" }],
    ["empty entries", { ...valid, entries: [] }],
    ["invalid calendar date", { ...valid, editionDate: "2026-02-30" }],
    ["unknown section", { ...valid, entries: [{ ...firstEntry, section: "unknown" }] }],
    ["empty entry id", { ...valid, entries: [{ ...firstEntry, id: "" }] }],
    ["invalid source URL", {
      ...valid,
      entries: [{ ...firstEntry, sourceRefs: [{ ...firstSource, url: "file:///tmp/source" }] }],
    }],
    ["unknown source role", {
      ...valid,
      entries: [{ ...firstEntry, sourceRefs: [{ ...firstSource, role: "owner" }] }],
    }],
  ])("rejects %s with a bounded contract error", (_name, body) => {
    expect(() => parsePreviewEdition(body)).toThrow(/^Preview edition contract:/);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run tests/unit/config/preview-edition-contract.test.ts`

Expected: FAIL because `tests/preview-e2e/edition-contract.ts` does not exist.

- [ ] **Step 3: Implement the narrow contract and derivations**

Create `tests/preview-e2e/edition-contract.ts`:

```ts
import { z } from "zod";

export const PREVIEW_SECTIONS = [
  "morning_brief", "research", "research_radar", "world", "technology",
  "ai_policy", "dmv", "baltimore", "forecast",
] as const;
export type PreviewSection = (typeof PREVIEW_SECTIONS)[number];

export const PREVIEW_SECTION_LABELS: Readonly<Record<PreviewSection, string>> = {
  morning_brief: "Morning brief",
  research: "Research",
  research_radar: "On the radar",
  world: "World",
  technology: "Technology",
  ai_policy: "AI policy",
  dmv: "DMV",
  baltimore: "Baltimore",
  forecast: "Forecast signals",
};

const calendarDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value;
  }, "must be a real YYYY-MM-DD calendar date");

const httpURL = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use HTTP or HTTPS");

const sourceRefSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  url: httpURL,
  role: z.enum(["primary", "reporting", "analysis", "opinion", "blog", "forecast"]),
}).passthrough();
const entrySchema = z.object({
  id: z.string().trim().min(1),
  section: z.enum(PREVIEW_SECTIONS),
  position: z.number().int().nonnegative(),
  selectionReasons: z.array(z.string()),
  sourceRefs: z.array(sourceRefSchema),
  summary: z.object({ title: z.string().trim().min(1) }).passthrough(),
}).passthrough();
const editionSchema = z.object({
  editionDate: calendarDate,
  entries: z.array(entrySchema).min(1),
}).passthrough();

export type PreviewSourceRef = z.infer<typeof sourceRefSchema>;
export type PreviewEntry = z.infer<typeof entrySchema>;
export type PreviewEdition = z.infer<typeof editionSchema>;

export function parsePreviewEdition(body: unknown): PreviewEdition {
  const parsed = editionSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const path = issue.path.length === 0 ? "response" : issue.path.join(".");
  throw new TypeError(`Preview edition contract: ${path} ${issue.message}`);
}

export function formatPreviewEditionDate(editionDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${editionDate}T12:00:00.000Z`));
}

export function expectedCardSourceHosts(entries: readonly PreviewEntry[]): string[] {
  return [...new Set(entries
    .filter(({ section }) => section !== "morning_brief")
    .flatMap(({ sourceRefs }) => sourceRefs.map(({ url }) => new URL(url).hostname))
  )].sort();
}
```

- [ ] **Step 4: Run focused and type gates**

Run:

```bash
npx vitest run tests/unit/config/preview-edition-contract.test.ts
npm run check
git diff --check
```

Expected: PASS; the diff check emits no output.

- [ ] **Step 5: Commit the pure contract**

```bash
git add tests/preview-e2e/edition-contract.ts tests/unit/config/preview-edition-contract.test.ts
git commit -m "test: define dynamic preview edition contract"
```

---

### Task 2: Contract-driven rendering and deterministic preview fixtures

**Files:**
- Create: `tests/preview-e2e/rendered-edition.ts`
- Modify: `tests/preview-e2e/content.spec.ts:1-260`

**Interfaces:**
- Consumes: Task 1 exports, authenticated `getPreviewJSON`, and `fixtureEdition()`.
- Produces: `expectRenderedPreviewEdition(page: Page, edition: PreviewEdition): Promise<void>` for exact page/API comparison.
- Preserves: route headings, `/api/sources` non-empty, `/api/runs` equality, layered-research labels, official-lab section separation, and empty-section omission.

- [ ] **Step 1: Record the existing live RED evidence**

Run: `npm run test:e2e:preview`

Complete ordinary-browser Managed OAuth approval if prompted. Expected: authentication and `/health` succeed, then content fails because latest is newer than `2026-07-29`. Retain only numeric exit status and safe diagnostics; retain no URLs, callback parameters, tokens, cookies, storage, screenshots, traces, or video.

- [ ] **Step 2: Add seeded, sparse, and mismatched-title cases importing the absent comparator**

At the top of `tests/preview-e2e/content.spec.ts`, add:

```ts
import { fixtureEdition } from "../../scripts/seed-dev";
import { parsePreviewEdition } from "./edition-contract";
import { expectRenderedPreviewEdition } from "./rendered-edition";

function sparsePreviewEdition() {
  const seeded = fixtureEdition();
  const editionId = "edition-2026-08-09";
  return {
    ...seeded,
    id: editionId,
    editionDate: "2026-08-09",
    runId: "run-2026-08-09",
    status: "partial" as const,
    readingMinutes: 20,
    publishedAt: "2026-08-09T10:04:00.000Z",
    createdAt: "2026-08-09T10:00:00.000Z",
    entries: seeded.entries
      .filter(({ section }) => section === "research" || section === "baltimore")
      .map((entry) => ({ ...entry, editionId })),
  };
}

for (const [name, fixture] of [
  ["seeded July 29 edition", fixtureEdition()],
  ["newer sparse partial edition", sparsePreviewEdition()],
] as const) {
  test(`renders the ${name} from its API contract`, async ({ page }) => {
    const runsBefore = await readArray(page, "/api/runs");
    await page.route("**/api/edition/latest", async (route) => {
      await route.fulfill({ json: fixture });
    });
    await expectRenderedPreviewEdition(page, parsePreviewEdition(fixture));
    expect(await readArray(page, "/api/runs")).toEqual(runsBefore);
  });
}

test("rejects a rendered title that differs from the API title", async ({
  page,
}) => {
  const seeded = fixtureEdition();
  const morningEntry = seeded.entries.find(({ section }) =>
    section === "morning_brief"
  );
  const researchEntry = seeded.entries.find(({ section }) =>
    section === "research"
  );
  if (morningEntry === undefined || researchEntry === undefined) {
    throw new Error("Preview fixture lacks title-rendering examples");
  }
  const apiEdition = {
    ...seeded,
    entries: [morningEntry, { ...researchEntry, sourceRefs: [] }],
  };
  await page.route((url) => url.pathname === "/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <h1>The day, thoughtfully distilled.</h1>
        <p class="header-date">Wednesday, July 29, 2026</p>
        <section id="morning_brief">
          <div class="section-heading">
            <h2>Morning brief</h2>
            <span>1 item</span>
          </div>
          <div data-entry-id="${morningEntry.id}">
            <strong>${morningEntry.summary.title}</strong>
          </div>
        </section>
        <section id="research">
          <div class="section-heading">
            <h2>Research</h2>
            <span>1 item</span>
          </div>
          <article data-entry-id="${researchEntry.id}">
            <h3>${researchEntry.summary.title} — rendered mismatch</h3>
          </article>
        </section>
      `,
    });
  });

  await expect(
    expectRenderedPreviewEdition(page, parsePreviewEdition(apiEdition)),
  ).rejects.toThrow();
});
```

- [ ] **Step 3: Confirm RED before the comparator exists**

Run: `npm run check`

Expected: FAIL because `tests/preview-e2e/rendered-edition.ts` does not exist.

- [ ] **Step 4: Implement the exact page/API comparator**

Create `tests/preview-e2e/rendered-edition.ts`:

```ts
import { expect, type Page } from "@playwright/test";

import {
  expectedCardSourceHosts,
  formatPreviewEditionDate,
  PREVIEW_SECTION_LABELS,
  PREVIEW_SECTIONS,
  type PreviewEdition,
} from "./edition-contract";

export async function expectRenderedPreviewEdition(
  page: Page,
  edition: PreviewEdition,
): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", {
    level: 1,
    name: "The day, thoughtfully distilled.",
  })).toBeVisible();
  await expect(page.locator(".header-date")).toHaveText(
    formatPreviewEditionDate(edition.editionDate),
  );

  for (const section of PREVIEW_SECTIONS) {
    const expected = edition.entries.filter((entry) => entry.section === section);
    const renderedSection = page.locator(`section#${section}`);
    if (expected.length === 0) {
      await expect(renderedSection).toHaveCount(0);
      continue;
    }
    await expect(renderedSection).toBeVisible();
    await expect(renderedSection.getByRole("heading", {
      level: 2,
      name: PREVIEW_SECTION_LABELS[section],
    })).toBeVisible();
    await expect(renderedSection.locator(".section-heading > span")).toHaveText(
      `${expected.length} ${expected.length === 1 ? "item" : "items"}`,
    );
    const renderedEntries = renderedSection.locator("[data-entry-id]");
    const renderedEntryIds = await renderedEntries.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-entry-id"))
    );
    expect(renderedEntryIds).toEqual(
      expected.map(({ id }) => id),
    );
    for (const [index, entry] of expected.entries()) {
      const title = renderedEntries.nth(index).locator(
        section === "morning_brief" ? "strong" : "h3",
      );
      await expect(title).toHaveText(entry.summary.title);
    }
  }

  const renderedHosts = [...new Set(await page.locator(".source-list a")
    .evaluateAll((links) => links.map((link) =>
      new URL((link as HTMLAnchorElement).href).hostname
    )))].sort();
  expect(renderedHosts).toEqual(expectedCardSourceHosts(edition.entries));

  const researchPrimaryCount = edition.entries
    .filter(({ section }) => section === "research" || section === "research_radar")
    .flatMap(({ sourceRefs }) => sourceRefs)
    .filter(({ role }) => role === "primary").length;
  await expect(page.getByText("Primary source", { exact: true }))
    .toHaveCount(researchPrimaryCount);

  const forecastCount = edition.entries
    .filter(({ section }) => section === "forecast").length;
  await expect(page.getByText("Forecast, not fact", { exact: true }))
    .toHaveCount(forecastCount);
}
```

- [ ] **Step 5: Replace fixed live assertions with parsed latest data**

Delete `sectionHeadings`, `sourceHosts`, the local preview types, and `previewEdition()`. Replace the first test with:

```ts
test("shows the latest published edition and leaves run state unchanged", async ({
  page,
}) => {
  const runsBefore = await readArray(page, "/api/runs");
  const sources = await readArray(page, "/api/sources");
  expect(sources.length).toBeGreaterThan(0);

  const response = await getPreviewJSON(page, "/api/edition/latest");
  expect(response.status()).toBe(200);
  const edition = parsePreviewEdition(await response.json());
  await expectRenderedPreviewEdition(page, edition);

  for (const [path, heading] of routeHeadings) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading }))
      .toBeVisible();
  }
  expect(await readArray(page, "/api/runs")).toEqual(runsBefore);
});
```

Do not catch parser errors. A non-200 response fails its status assertion; malformed 200 data fails with `Preview edition contract:`.

- [ ] **Step 6: Decouple layered rendering from remote contents**

In `renders layered research context and omits empty sections without mutation`, replace the live fetch and `previewEdition()` call with:

```ts
const base = fixtureEdition();
```

Import `EditionEntry` and `EditionWithEntries` from `src/contracts/editorial.ts`. Retain construction and assertions for `Independent implementation located.`, `Substantive expert commentary located.`, `Research blog`, distinct Technology/AI Policy item IDs and cards, every section count, omitted Forecast, and exact `/api/runs` equality.

- [ ] **Step 7: Run type, parser, and local browser gates**

Run:

```bash
npm run check
npx vitest run tests/unit/config/preview-edition-contract.test.ts
npm run test:e2e
git diff --check
```

Expected: all pass; diff check emits no output.

- [ ] **Step 8: Commit contract-driven rendering**

```bash
git add tests/preview-e2e/content.spec.ts tests/preview-e2e/rendered-edition.ts
git commit -m "test: derive preview checks from latest edition"
```

---

### Task 3: Safe diagnostics, runbook, and authenticated acceptance

**Files:**
- Modify: `scripts/preview-e2e/safe-reporter.ts:9-15`
- Modify: `tests/unit/config/preview-e2e-safe-reporter.test.ts:20-120`
- Modify: `docs/runbooks/preview-rehearsal.md:21-36,72-91`

**Interfaces:**
- Consumes: final `tests/preview-e2e/content.spec.ts` line count and existing safe diagnostic format.
- Produces: reviewed content-test source/error maximum `400`, a guard proving the file stays within it, and current-latest runbook language.
- Preserves: allowed projects/files/statuses, generic failure copy, secret-free output, OAuth lifecycle, canary approvals, and production blocker.

- [ ] **Step 1: Add a failing safe-reporter coverage test**

Add beside the fixture-line coverage test:

```ts
it("keeps the content error-line allowlist large enough for the complete test", () => {
  const contentLineCount = readFileSync(
    resolve(process.cwd(), "tests/preview-e2e/content.spec.ts"),
    "utf8",
  ).trimEnd().split("\n").length;

  expect(contentLineCount).toBeLessThanOrEqual(400);
  expect(formatPreviewTestDiagnostic({
    project: "desktop",
    file: "tests/preview-e2e/content.spec.ts",
    line: contentLineCount,
    errorSource: "test",
    errorLine: contentLineCount,
    status: "failed",
  })).toBe(
    `OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/content.spec.ts line=${contentLineCount} errorSource=test errorLine=${contentLineCount} status=failed`,
  );
  expect(formatPreviewTestDiagnostic({
    project: "desktop",
    file: "tests/preview-e2e/content.spec.ts",
    line: 401,
    errorSource: "none",
    errorLine: 0,
    status: "failed",
  })).toBeUndefined();
});
```

- [ ] **Step 2: Confirm safe-reporter RED**

Run: `npx vitest run tests/unit/config/preview-e2e-safe-reporter.test.ts`

Expected: FAIL because valid content-test locations exceed the current maximum `65`.

- [ ] **Step 3: Raise only the reviewed content-file bound**

In `scripts/preview-e2e/safe-reporter.ts`, change only:

```ts
"tests/preview-e2e/content.spec.ts": 400,
```

In both table-driven unit-test matrices, make `400` the accepted content boundary and `401` the rejected boundary. Do not alter access, responsive-accessibility, or fixture bounds; do not add filenames or diagnostic fields.

- [ ] **Step 4: Update the preview rehearsal runbook**

Apply these exact documentation changes:

- replace `All 42 tests are read-only` with `All preview tests are read-only`;
- state that content fetches current `/api/edition/latest` and requires homepage date, present sections, counts, entries, source hosts, and conditional labels to agree;
- state that empty sections are omitted and valid in sparse or partial editions;
- state that route-fulfilled cases preserve seeded July 29 and richer layered Research/Technology/AI Policy coverage independently of live contents;
- leave deployment approvals, the canary checklist, secret-free evidence, and the nonallowed-account production blocker unchanged.

- [ ] **Step 5: Run focused and repository gates**

Run:

```bash
npx vitest run tests/unit/config/preview-edition-contract.test.ts tests/unit/config/preview-e2e-safe-reporter.test.ts tests/unit/config/preview-e2e-auth-fixture.test.ts
npm test
npm run test:worker
npm run check
npm run evaluate
npm run build
npm run test:e2e
git diff --check
git status --short --branch
```

Expected: every command passes; evaluator precision@5 meets its configured floor; git status contains no test artifact, token, cookie, browser storage, or generated auth file.

- [ ] **Step 6: Run authenticated long-lived preview acceptance**

Run: `npm run test:e2e:preview`

Complete ordinary-browser Google authorization if prompted. Expected: OAuth discovery, registration, authorization, exchange, and authenticated health succeed; desktop, tablet, and mobile pass against the current canary edition; runner exits `0`, removes its mode-`0700` temporary directory, and leaves `/api/runs` unchanged.

Retain only total test count, project names, numeric exit status, allowed-session and signed-out results, and run count before/after. Do not inspect, print, or retain authorization URLs, callback parameters, codes, verifiers, state, tokens, credentials, cookies, browser storage, screenshots, traces, or video.

- [ ] **Step 7: Confirm final scope and commit**

Run:

```bash
git diff --name-only 61b77c0a87d20df86d05166ea1a6c80a2e948551..HEAD
git diff --check
git status --short --branch
```

No file under `src/`, no migration, no Wrangler configuration, and no deployment file may change. Commit:

```bash
git add scripts/preview-e2e/safe-reporter.ts tests/unit/config/preview-e2e-safe-reporter.test.ts docs/runbooks/preview-rehearsal.md
git commit -m "docs: describe dynamic preview rehearsal"
```

- [ ] **Step 8: Perform the post-commit completion check**

Run:

```bash
git status --short --branch
git log -4 --oneline
git diff --check main..HEAD
```

Expected: clean feature branch, design/contract/rendering/runbook commits present, and no whitespace errors.
