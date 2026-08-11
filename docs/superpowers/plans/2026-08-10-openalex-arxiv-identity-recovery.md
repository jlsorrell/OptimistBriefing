# OpenAlex arXiv Identity Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover omitted arXiv identities from OpenAlex landing URLs so a retryable preview run can persist an already-known paper without repeating discovery or violating the canonical-URL uniqueness constraint.

**Architecture:** Keep the behavior OpenAlex-specific. New OpenAlex observations infer an arXiv identifier from `primary_location.landing_page_url` only when `ids.arxiv` is absent or invalid; normalization applies a source-scoped fallback to older collect checkpoints only when their supplied identifiers contain neither a valid arXiv identity nor a valid DOI. Repository conflict semantics and historical rows remain unchanged.

**Tech Stack:** TypeScript 5.8, Zod 3, Vitest 4, Cloudflare Workers, D1, Cloudflare Workflows, Wrangler 4.

## Global Constraints

- Do not change the `items.canonical_url` uniqueness constraint.
- Do not re-key, delete, or rewrite historical items or editions.
- Do not infer identifiers globally; recovery applies only when `sourceId === "openalex"`.
- Preserve historical normalized/sorted DOI-or-arXiv stable selection, structural URL handling, provider-text boundaries, deduplication, model budgets, and publication rules.
- An explicit valid OpenAlex arXiv identifier takes precedence over an inferred landing-page identifier.
- A malformed or non-arXiv landing URL must retain current OpenAlex-only behavior.
- Do not repeat the completed discovery stage or create a second `2026-08-10` run.
- Deploy only to `optimist-briefing-preview`; do not change production, schedules, credentials, models, or D1 schemas.
- Use strict RED/GREEN TDD for every production behavior change.

## Final-review compatibility ruling

Normalization must determine explicit arXiv and DOI presence with
`normalizeArxivIdentifier` and `normalizeDoi`. Infer from an OpenAlex canonical
URL only when neither valid kind is supplied. Preserve the historical
arXiv-derived Item ID for supplied dual DOI+arXiv candidates, and exclude
malformed `arXiv:` or `DOI:` pseudo-identifiers from stable-ID eligibility.
This ruling supersedes any older Task 2 wording that implies global DOI-first
selection; Task 1 adapter behavior remains unchanged.

---

## File map

- `src/sources/openalex.ts`: maps new OpenAlex provider responses into raw research candidates; owns landing-page identity recovery for future observations.
- `src/editorial/normalize.ts`: converts trusted raw candidates and restored collect checkpoints into stable Items; owns the OpenAlex-only checkpoint fallback before durable ID derivation.
- `tests/unit/sources/research-collector.test.ts`: exercises the real OpenAlex discovery adapter and its inverse identity cases.
- `tests/unit/editorial/normalize.test.ts`: proves restored OpenAlex candidates converge on the same Item ID as arXiv candidates without changing other sources.
- `tests/integration/workflow/manual-run.test.ts`: proves D1 persistence accepts the checkpoint-shaped candidate when the canonical URL already belongs to the arXiv Item ID.

### Task 1: Recover identity in new OpenAlex observations

**Files:**
- Modify: `tests/unit/sources/research-collector.test.ts` in the OpenAlex discovery tests near the updated-discovery cases.
- Modify: `src/sources/openalex.ts:393-421`

**Interfaces:**
- Consumes: `normalizeArxivIdentifier(value: string): string | null` from `src/sources/identifiers.ts`.
- Produces: `OpenAlexDiscoveryAdapter.collect(window): Promise<RawItem[]>` candidates whose `externalId` and `externalIds` include a recovered normalized arXiv ID when the explicit ID is unavailable.

- [ ] **Step 1: Add the failing landing-page recovery test**

Add this test inside `describe("ResearchCollector", ...)` near the existing OpenAlex discovery tests:

```ts
it("recovers an omitted OpenAlex arXiv identity from its landing page", async () => {
  const work = {
    id: "https://openalex.org/W7197052950",
    doi: null,
    title: "Recovered OpenAlex identity",
    publication_date: "2026-07-29",
    updated_date: "2026-07-29T08:00:00.000Z",
    cited_by_count: 1,
    ids: { openalex: "https://openalex.org/W7197052950" },
    authorships: [],
    topics: [],
    abstract_inverted_index: null,
    primary_location: {
      landing_page_url: "https://arxiv.org/abs/2608.03626v2",
      source: { display_name: "arXiv" },
    },
  };
  const adapter = new OpenAlexDiscoveryAdapter(
    new SourceHttpClient({
      fetch: vi.fn(async () => Response.json({ results: [work] })),
      now: () => new Date("2026-07-29T08:30:00.000Z"),
    }),
    openAlexSource,
    { laneId: "openalex:text:identity", mode: "text", query: "alignment" },
    { apiKey: "fixture-openalex-key" },
  );

  const result = await adapter.collect(fixedWindow());

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    originalUrl: "https://arxiv.org/abs/2608.03626v2",
    externalId: "arXiv:2608.03626",
    externalIds: ["OpenAlex:W7197052950", "arXiv:2608.03626"],
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "recovers an omitted OpenAlex arXiv identity"
```

Expected: FAIL because `externalId` is `OpenAlex:W7197052950` and `externalIds` lacks `arXiv:2608.03626`.

- [ ] **Step 3: Implement the minimal adapter fallback**

In `OpenAlexDiscoveryAdapter.toRawItem`, compute the landing page before the arXiv identity and prefer the explicit parsed identity:

```ts
const doi = work.doi === null ? null : normalizeDoi(work.doi);
const landingPageUrl = work.primary_location?.landing_page_url ?? null;
const explicitArxiv = work.ids.arxiv === undefined
  ? null
  : normalizeArxivIdentifier(work.ids.arxiv);
const arxiv = explicitArxiv ?? (
  landingPageUrl === null
    ? null
    : normalizeArxivIdentifier(landingPageUrl)
);
const openAlexId = openAlexIdentifier(work.id);
const abstract = reconstructAbstract(work.abstract_inverted_index);
```

Remove the old later `landingPageUrl` declaration. Do not change original-URL or DOI selection.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "recovers an omitted OpenAlex arXiv identity"
```

Expected: PASS.

- [ ] **Step 5: Add and run inverse cases**

Add a table-driven test using the same work shape:

```ts
it.each([
  {
    caseName: "keeps a non-arXiv landing page OpenAlex-only",
    ids: { openalex: "https://openalex.org/W-NON-ARXIV" },
    landingPageUrl: "https://publisher.example/papers/non-arxiv",
    expectedExternalId: "OpenAlex:W-NON-ARXIV",
    expectedExternalIds: ["OpenAlex:W-NON-ARXIV"],
  },
  {
    caseName: "prefers the explicit arXiv identity over a conflicting landing page",
    ids: {
      openalex: "https://openalex.org/W-EXPLICIT",
      arxiv: "https://arxiv.org/abs/2608.00001v3",
    },
    landingPageUrl: "https://arxiv.org/abs/2608.99999",
    expectedExternalId: "arXiv:2608.00001",
    expectedExternalIds: ["OpenAlex:W-EXPLICIT", "arXiv:2608.00001"],
  },
  {
    caseName: "falls back when the explicit OpenAlex arXiv URL is invalid",
    ids: {
      openalex: "https://openalex.org/W-INVALID-EXPLICIT",
      arxiv: "https://publisher.example/not-an-arxiv-identifier",
    },
    landingPageUrl: "https://arxiv.org/abs/2608.00002v4",
    expectedExternalId: "arXiv:2608.00002",
    expectedExternalIds: [
      "OpenAlex:W-INVALID-EXPLICIT",
      "arXiv:2608.00002",
    ],
  },
])("$caseName", async ({ ids, landingPageUrl, expectedExternalId, expectedExternalIds }) => {
  const work = {
    id: ids.openalex,
    doi: null,
    title: "OpenAlex identity inverse",
    publication_date: "2026-07-29",
    updated_date: "2026-07-29T08:00:00.000Z",
    cited_by_count: 0,
    ids,
    authorships: [],
    topics: [],
    abstract_inverted_index: null,
    primary_location: {
      landing_page_url: landingPageUrl,
      source: { display_name: "Fixture publisher" },
    },
  };
  const adapter = new OpenAlexDiscoveryAdapter(
    new SourceHttpClient({
      fetch: vi.fn(async () => Response.json({ results: [work] })),
      now: () => new Date("2026-07-29T08:30:00.000Z"),
    }),
    openAlexSource,
    { laneId: "openalex:text:identity-inverse", mode: "text", query: "alignment" },
    { apiKey: "fixture-openalex-key" },
  );

  const result = await adapter.collect(fixedWindow());

  expect(result[0]?.externalId).toBe(expectedExternalId);
  expect(result[0]?.externalIds).toEqual(expectedExternalIds);
});
```

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "landing page|explicit"
```

Expected: all selected cases PASS. Keep the fixture body explicit in the final test rather than introducing a production-only helper.

- [ ] **Step 6: Run the complete source test file**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts
```

Expected: every test in the file passes.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/sources/openalex.ts tests/unit/sources/research-collector.test.ts
git commit -m "fix: recover OpenAlex arXiv landing identities"
```

### Task 2: Recover identity while restoring existing collect checkpoints

**Files:**
- Modify: `tests/unit/editorial/normalize.test.ts` inside `describe("research normalization", ...)`.
- Modify: `src/editorial/normalize.ts:377-390`

**Interfaces:**
- Consumes: `normalizeArxivIdentifier(value: string): string | null` and the raw candidate fields `sourceId`, `originalUrl`, `externalId`, and `externalIds`.
- Produces: `normalizeCandidate(candidate): Item` with source-scoped arXiv recovery, valid explicit-identity gating, and baseline-compatible stable Item ID derivation.

- [ ] **Step 1: Add the failing checkpoint-shaped identity test**

```ts
it("restores an OpenAlex-only checkpoint candidate to the arXiv durable item identity", () => {
  const arxiv = normalizeCandidate(candidate({
    sourceId: "arxiv",
    sourceName: "arXiv",
    originalUrl: "https://arxiv.org/abs/2608.03626",
    externalId: "arXiv:2608.03626",
    externalIds: ["arXiv:2608.03626"],
  }));
  const openAlex = normalizeCandidate(candidate({
    sourceId: "openalex",
    sourceName: "OpenAlex",
    sourceRole: "analysis",
    originalUrl: "https://arxiv.org/abs/2608.03626",
    externalId: "OpenAlex:W7197052950",
    externalIds: ["OpenAlex:W7197052950"],
    metadata: { discoveryFamily: "bibliographic" },
  }));

  expect(openAlex.id).toBe(arxiv.id);
  expect(openAlex.metadata.externalIds).toEqual([
    "arXiv:2608.03626",
    "OpenAlex:W7197052950",
  ].sort((left, right) => left.localeCompare(right)));
  expect(openAlex.canonicalUrl).toBe("https://arxiv.org/abs/2608.03626");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/editorial/normalize.test.ts -t "restores an OpenAlex-only checkpoint candidate"
```

Expected: FAIL because the OpenAlex-derived Item ID differs from the arXiv-derived Item ID.

- [ ] **Step 3: Implement the source-scoped normalization fallback**

Move `canonicalUrl` construction before `externalIds`, then include a recovered ID only for OpenAlex:

```ts
const canonicalUrl = candidateCanonicalUrl(
  candidate.originalUrl,
  candidate.metadata,
);
const suppliedExternalIds = [
  candidate.externalId,
  ...candidate.externalIds,
];
const hasExplicitArxiv = suppliedExternalIds.some(
  (identifier) => normalizeArxivIdentifier(identifier) !== null,
);
const hasExplicitDoi = suppliedExternalIds.some(
  (identifier) => normalizeDoi(identifier) !== null,
);
const restoredOpenAlexArxiv =
  candidate.sourceId === "openalex" &&
    !hasExplicitArxiv &&
    !hasExplicitDoi
  ? normalizeArxivIdentifier(canonicalUrl)
  : null;
const externalIds = uniqueSorted(
  [
    ...suppliedExternalIds,
    ...(restoredOpenAlexArxiv === null ? [] : [restoredOpenAlexArxiv]),
  ].map(canonicalIdentifier),
);
```

Delete the old later `canonicalUrl` declaration. Do not alter identifiers for any other source.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run tests/unit/editorial/normalize.test.ts -t "restores an OpenAlex-only checkpoint candidate"
```

Expected: PASS.

- [ ] **Step 5: Add a non-OpenAlex inverse assertion**

Extend the same test or add a separate one:

```ts
const unrelated = normalizeCandidate(candidate({
  sourceId: "custom-provider",
  sourceName: "Custom Provider",
  originalUrl: "https://arxiv.org/abs/2608.03626",
  externalId: "custom:W7197052950",
  externalIds: ["custom:W7197052950"],
}));

expect(unrelated.id).not.toBe(arxiv.id);
expect(unrelated.metadata.externalIds).toEqual(["custom:W7197052950"]);
```

Run:

```bash
npx vitest run tests/unit/editorial/normalize.test.ts
```

Expected: all normalization tests PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/editorial/normalize.ts tests/unit/editorial/normalize.test.ts
git commit -m "fix: restore OpenAlex checkpoint identities"
```

### Task 3: Prove D1 persistence survives the historical canonical URL

**Files:**
- Modify: `tests/integration/workflow/manual-run.test.ts` near the existing production normalization and D1 persistence tests.

**Interfaces:**
- Consumes: `createProductionPipelineContext`, `D1BriefingRepository.upsertItems`, and the Task 2 `normalizeCandidate` behavior.
- Produces: a Worker/D1 regression proving one canonical URL remains one row and retains both arXiv and OpenAlex identifiers.

- [ ] **Step 1: Add the D1 regression**

```ts
it("persists a restored OpenAlex checkpoint candidate over its existing arXiv item", async () => {
  const repository = new D1BriefingRepository(env.DB);
  const arxivRaw: RawResearchCandidate = {
    kind: "paper",
    sourceId: "arxiv",
    sourceName: "arXiv",
    sourceRole: "primary",
    title: "Stable identity paper",
    originalUrl: "https://arxiv.org/abs/2608.03626",
    externalId: "arXiv:2608.03626",
    externalIds: ["arXiv:2608.03626"],
    publishedAt: "2026-08-08T12:00:00.000Z",
    retrievedAt: "2026-08-10T09:00:00.000Z",
    accessLevel: "abstract",
    authors: [],
    institutions: [],
    abstract: "Stable identity evidence.",
    content: null,
    relatedPaperIds: [],
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics: [],
    metadata: { discoveryFamily: "arxiv" },
  };
  const stored = normalizeCandidate(arxivRaw);
  await repository.upsertItems([stored]);

  const restored = normalizeCandidate({
    ...arxivRaw,
    sourceId: "openalex",
    sourceName: "OpenAlex",
    sourceRole: "analysis",
    externalId: "OpenAlex:W7197052950",
    externalIds: ["OpenAlex:W7197052950"],
    metadata: { discoveryFamily: "bibliographic" },
  });

  expect(restored.id).toBe(stored.id);
  await expect(repository.upsertItems([restored])).resolves.toBeUndefined();
  const rows = await env.DB.prepare(
    "SELECT id, normalized_json FROM items WHERE canonical_url = ?",
  ).bind("https://arxiv.org/abs/2608.03626").all<{
    id: string;
    normalized_json: string;
  }>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0]?.id).toBe(stored.id);
  expect(JSON.parse(rows.results[0]!.normalized_json).metadata.externalIds)
    .toEqual(expect.arrayContaining([
      "arXiv:2608.03626",
      "OpenAlex:W7197052950",
    ]));
});
```

- [ ] **Step 2: Mutation-check the regression**

Temporarily remove the OpenAlex normalization fallback added in Task 2 and run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "persists a restored OpenAlex checkpoint candidate"
```

Expected: FAIL before the upsert assertion because the IDs differ, or fail with the same `items.canonical_url` uniqueness error observed in preview. Restore the Task 2 implementation immediately after confirming RED.

- [ ] **Step 3: Run the restored GREEN regression**

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "persists a restored OpenAlex checkpoint candidate"
```

Expected: PASS with one D1 row and both durable identifiers.

- [ ] **Step 4: Run affected suites**

```bash
npx vitest run tests/unit/sources/research-collector.test.ts tests/unit/editorial/normalize.test.ts
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts
npm run check
```

Expected: all selected tests and typecheck PASS. If the Worker test cannot bind loopback inside the sandbox, rerun that exact command with approved unsandboxed execution; do not alter the test to bypass the runtime.

- [ ] **Step 5: Commit Task 3**

```bash
git add tests/integration/workflow/manual-run.test.ts
git commit -m "test: cover OpenAlex canonical identity persistence"
```

### Task 4: Review, full verification, and preview rehearsal

**Files:**
- Verify: all Task 1-3 files and commits.
- Reuse temporarily: `/private/tmp/optimist-briefing-preview.wrangler.jsonc`
- Do not modify: production configuration, D1 migrations, schedules, or secrets.

**Interfaces:**
- Consumes: the complete Task 1-3 implementation and the existing isolated preview Worker/D1/Workflow bindings.
- Produces: a reviewed preview deployment and one resumed `2026-08-10` Workflow instance.

- [ ] **Step 1: Run complete local verification**

```bash
npm test
npm run test:worker
npm run check
npm run evaluate
npm run build
git diff --check HEAD~3 HEAD
```

Expected: all tests pass; evaluator precision@5 remains at least `0.80`; build and diff checks pass. Existing third-party sourcemap warnings may remain but no new warnings are accepted.

- [ ] **Step 2: Perform a read-only code review**

Review the exact Task 1-3 diff for:

- OpenAlex-only scope at both recovery sites;
- valid explicit-ID gating and historical dual-ID compatibility;
- no provider-text decoding of URLs;
- no repository, schema, migration, budget, schedule, or production changes;
- mutation-sensitive RED/GREEN evidence; and
- current collect-checkpoint compatibility.

Do not deploy until the review has no Critical or Important findings.

- [ ] **Step 3: Rebuild and dry-run the isolated preview**

```bash
npm run build
npx wrangler deploy --dry-run --config /private/tmp/optimist-briefing-preview.wrangler.jsonc
```

Expected bindings: Worker `optimist-briefing-preview`, D1 UUID `823bdf63-e52b-4e66-aa83-99523a6241d6`, and Workflow `daily-briefing-preview`. The config must contain no routes, cron triggers, secrets, or inline variables.

- [ ] **Step 4: Deploy preview with preserved variables**

```bash
npx wrangler deploy --keep-vars --config /private/tmp/optimist-briefing-preview.wrangler.jsonc
```

Record the new version ID from the deploy output, then list versions and verify
that the first entry has that exact ID:

```bash
npx wrangler versions list --name optimist-briefing-preview
```

Expected: existing `OPENAI_API_KEY`, `OPENALEX_API_KEY`, model variables, $5 monthly budget, Access variables, D1 binding, and Workflow binding remain present. Do not print secret values.

- [ ] **Step 5: Restart only the existing Workflow instance**

First confirm the instance is terminal and the D1 run is `retryable` at `collect` with a completed collect checkpoint. Then run:

```bash
npx wrangler workflows instances restart daily-briefing-preview 2026-08-10 --config /private/tmp/optimist-briefing-preview.wrangler.jsonc
```

Do not use `/api/admin/runs` and do not create another dated run. The restarted Workflow must reuse the persisted collect checkpoint; verify the discovery checkpoint row count and checkpoint ID remain unchanged.

- [ ] **Step 6: Monitor acceptance criteria**

Use the authenticated `/run-status` page plus bounded D1 aggregate queries to confirm:

- normalize completes without a canonical-URL collision;
- collect is not repeated;
- later checkpoints advance and the run reaches `published`, `partial`, or a new evidence-backed terminal failure;
- model reservations are reconciled or released;
- run and monthly estimated costs remain under the configured cap;
- Research and Research Radar preserve core-before-adjacent ordering;
- no rendered title, summary, or source name contains literal numeric entity artifacts; and
- Alignment Forum, LessWrong, MIT, OpenAlex, Semantic Scholar, arXiv, and Papers with Code outcomes are recorded without exposing private response data.

- [ ] **Step 7: Clean up and report**

Remove `/private/tmp/optimist-briefing-preview.wrangler.jsonc` after all preview verification is complete. Report the preview Worker version, run terminal status, publication status, research/source observations, cost, and any follow-up reliability issues. Do not push, open a pull request, or deploy production unless the user separately requests it.
