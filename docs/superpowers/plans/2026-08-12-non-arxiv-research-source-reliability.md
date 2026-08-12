# Non-arXiv Research Source Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the highest-value non-arXiv research sources reliably contribute genuinely relevant candidates when they have them, without quotas, filler, relaxed editorial gates, or a permissive generic scraper.

**Architecture:** Keep the existing fail-open publication collection pipeline, but add explicit reviewed contracts for the selected feeds and lab listings. Carry a bounded pre-window observation count into diagnostics, consolidate duplicate LessWrong commentary by canonical identity, and update source endpoints through a guarded additive D1 migration. All emitted values remain ordinary `RawPublicationCandidate` records and pass through the existing normalize, route, topical-fit, quality, diversity, synthesis, grounding, and budget controls unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, Cloudflare Workers/D1, `SourceHttpClient`, `fast-xml-parser`, `linkedom`, existing provider-text normalization and editorial routing.

## Global Constraints

- Implement against the approved design in `docs/superpowers/specs/2026-08-12-non-arxiv-research-source-reliability-design.md`.
- Use strict TDD for every behavior change: write the named failing test, run it and record the intended RED, make the smallest production change, then rerun GREEN.
- Do not lower or bypass topical-fit, near-match, technical-quality, source-authority, freshness, diversity, grounding, synthesis, or model-budget gates.
- Do not reserve a non-arXiv slot or manufacture a daily quota. Zero qualified non-arXiv items is a valid result.
- Do not add model calls, generic whole-page scraping, bot-challenge bypasses, credentials, cookies, or authenticated browser dependencies.
- Keep the source catalog declarative: it may supply reviewed endpoints and URL policies, but it must not supply selectors, parser rules, collection bounds, fetch depth, or topical rules.
- Keep all application bounds static: at most 100 Papers with Code rows; at most 20 reviewed lab/feed entries and at most 5 detail fetches per lab source.
- Validate every listing, feed, detail, and redirect URL through the existing source-specific `OutboundUrlPolicy` and shared `SourceHttpClient` lifecycle.
- Provider text must use the existing normalize-once helpers. Never entity-decode or prose-normalize URLs, identifiers, timestamps, roles, category codes, or other structural fields.
- Diagnostics must remain bounded and sanitized: no bodies, excerpts, query strings, selector text, exception messages, provider stack traces, secrets, or credentials.
- Add `0012`; never edit the already-deployed `0011_split_publication_url_policies.sql`.
- Preserve custom, partial, or operator-supplied source configuration. Migration matching must use exact reviewed prior defaults and explicit absence checks.
- Do not deploy, mutate a shared D1 database, run a paid canary, or create a preview release in this implementation plan. Stop after a reviewed pull request.
- Commit after each task only when its focused tests and `npm run check` pass. Use the `codex/` branch prefix if a new branch is needed.

---

## Task 1: Add backward-compatible source observation diagnostics

**Files:**

- Modify: `src/sources/types.ts`
- Modify: `src/sources/collection-settlement.ts`
- Modify: `src/sources/rss.ts`
- Modify: `src/sources/publication-collector.ts`
- Modify: `src/sources/publication-page.ts`
- Modify: `src/sources/papers-with-code.ts`
- Modify: `tests/unit/contracts/editorial.test.ts`
- Modify: `tests/unit/sources/publication-collector.test.ts`
- Modify: `tests/integration/db/repository.test.ts`

### Contract to implement

Add an optional pre-window observation count to the persisted diagnostic, and a transient per-source observation count to collection batches:

```ts
export type CollectionSourceObservation = {
  sourceId: string;
  observed: number;
};

export type CollectionBatch<T> = {
  candidates: readonly T[];
  succeededSourceIds: readonly string[];
  failures: readonly CollectionFailure[];
  sourceObservations?: readonly CollectionSourceObservation[];
  discoveryDiagnostics?: readonly DiscoveryLaneDiagnostic[];
};
```

Extend `DiscoveryLaneDiagnosticSchema` with optional `observed`, using the same nonnegative integer and `10_000` maximum as other funnel counts. When present, enforce `discovered <= observed`. Omission must remain valid for historical diagnostics.

Extend `CollectionFailureKindSchema` and the diagnostic `outcome` enum with `unsupported_media`. Add an exported typed `UnsupportedSourceMediaTypeError` in `src/sources/types.ts`; map only that type to `unsupported_media` in `collection-settlement.ts`. Other `SyntaxError`/Zod failures remain `parse`.

Semantics:

- `observed` is the number of structurally interpretable entries before collection-window filtering, capped at `10_000`.
- `observed > 0`, `discovered === 0`, `outcome === "success"` means healthy source, no in-window candidate.
- `discovered > 0` followed by `route_excluded` means parsed but not research-routable; keep that existing rejection accounting downstream.
- An HTML/XML endpoint returning an unsupported media type throws `UnsupportedSourceMediaTypeError`; it must not look like a healthy empty source.

### TDD steps

- [ ] Add schema tests in `tests/unit/contracts/editorial.test.ts` proving historical omission parses, bounded `observed` round-trips, `discovered > observed` rejects, and `unsupported_media` is accepted only as a fixed enum value.
- [ ] Run `npx vitest run tests/unit/contracts/editorial.test.ts` and confirm RED because the new fields/outcome do not exist.
- [ ] Add `CollectionSourceObservation`, optional `CollectionBatch.sourceObservations`, `DiscoveryLaneDiagnostic.observed`, `UnsupportedSourceMediaTypeError`, and the new failure kind in `src/sources/types.ts`.
- [ ] In `collection-settlement.ts`, add `settleObservedCollectionBatch<T>()` accepting operations whose `collect()` resolves `{ candidates: readonly T[]; observed: number }`. Implement it by reusing the existing sanitized `settleSourceCollections()` error classification, returning observations only for fulfilled operations. Do not export private exception text.
- [ ] Update `RssAdapter.collect()` to use `settleObservedCollectionBatch()` and preserve each enabled feed's `interpretableEntries` count even when every entry is out of window. Return one `{sourceId, observed}` record for each fulfilled feed operation. Do not count malformed entries as observed.
- [ ] For non-null RSS bodies, accept only `application/rss+xml`, `application/atom+xml`, `application/xml`, and `text/xml` (ignoring parameters); throw `UnsupportedSourceMediaTypeError` for a missing or different content type.
- [ ] Update `mapRssCollectionBatch()` to copy `sourceObservations` unchanged.
- [ ] Add `collectWithStats(window): Promise<{ candidates: RawPublicationCandidate[]; observed: number }>` to `PublicationPageAdapter` and `PapersWithCodeAdapter`; keep `collect(window)` as a compatibility wrapper returning only candidates.
- [ ] In both page adapters, count only structurally valid, policy-approved listing rows before window filtering. For a non-null body, accept only `text/html` or `application/xhtml+xml` (ignoring parameters); throw `UnsupportedSourceMediaTypeError` for a missing or different content type.
- [ ] Extend the internal `PublicationSourceAdapter` contract in `publication-collector.ts` to return `{candidates, observed}`. Wrap page operations through `settleCollectionBatch` exactly as today, carrying a successful observed count into `publicationDiagnostic`; use RSS `sourceObservations` for RSS lanes.
- [ ] Ensure failed lanes omit `observed` rather than guessing zero. A genuinely empty successful source records `observed: 0`.
- [ ] Add publication collector tests for: out-of-window RSS (`observed > 0`, `discovered: 0`); empty valid feed (`observed: 0`); malformed feed (`parse`); unsupported media (`unsupported_media`); parsed publication followed by downstream `route_excluded`; and historical diagnostics in repository round-trip without `observed`.
- [ ] Run `npx vitest run tests/unit/contracts/editorial.test.ts tests/unit/sources/publication-collector.test.ts` and confirm GREEN.
- [ ] Run `npx vitest run --config vitest.worker.config.ts tests/integration/db/repository.test.ts` and confirm GREEN. If the sandbox rejects loopback binding, rerun the same command with the required approval; do not alter production code to work around the sandbox.
- [ ] Run `npm run check` and `git diff --check`.
- [ ] Commit: `git add src/sources/types.ts src/sources/collection-settlement.ts src/sources/rss.ts src/sources/publication-collector.ts src/sources/publication-page.ts src/sources/papers-with-code.ts tests/unit/contracts/editorial.test.ts tests/unit/sources/publication-collector.test.ts tests/integration/db/repository.test.ts && git commit -m "feat: distinguish publication source health"`

---

## Task 2: Repair Tier 1 feeds and Papers with Code, including cross-lane commentary deduplication

**Files:**

- Modify: `src/sources/papers-with-code.ts`
- Modify: `src/sources/publication-collector.ts`
- Modify: `src/editorial/research-identity.ts`
- Modify: `tests/fixtures/alignment-forum-feed.xml`
- Modify: `tests/fixtures/papers-with-code-recent.html`
- Create: `tests/fixtures/lesswrong-frontpage-feed.xml`
- Modify: `tests/unit/sources/publication-collector.test.ts`
- Modify: `tests/unit/editorial/research-identity.test.ts`
- Modify: `tests/integration/workflow/manual-run.test.ts`

### Contract to implement

Papers with Code must fetch exactly `https://paperswithcode.co/papers/recent`, accept only the final origin/path `paperswithcode.co/papers/recent`, inspect only the first 100 matched `li` rows, and parse this reviewed shape:

```html
<li>
  <a href="/paper/2608.10628">Paper title</a>
  <time datetime="2026-08-11">11 August 2026</time>
</li>
```

Each emitted candidate remains metadata-only, has a `/paper/` canonical URL, a normalized arXiv or `papers-with-code:*` identity, and cannot establish technical quality. `implementationAvailable` may be true only when that same row has a reviewed GitHub/GitLab/Codeberg link; absence remains false.

A nonempty HTML response with no interpretable reviewed recent-paper row throws a sanitized `SyntaxError` so diagnostics report parser drift. It must not fall back to the former homepage region or arbitrary paper links.

Treat `alignment-forum`, `lesswrong-curated`, and `lesswrong-frontpage` as commentary everywhere `publication-collector.ts` derives family/metadata. The new source itself arrives in Task 5; unit fixtures may construct it directly now.

Before commentary-to-paper attachment, consolidate commentary observations that share canonical URL or non-conflicting durable identity. The resulting commentary item must:

- use `mergeItemGroup()` and the existing deterministic `preferredItem()` ordering;
- union `sourceRefs`, `discoveryLaneIds`, and `discoveryLineage`;
- retain the Curated source reference and lane when Curated and Frontpage observe the same post;
- emit a `ResearchIdentityMerge` with `canonical_url` or the matching durable reason, allowing the existing diagnostics tracker to count `identity_merged`; and
- proceed once through the existing paper-attachment or standalone-commentary path.

Do not merge commentary with conflicting arXiv, DOI, or provider identities merely because titles are similar.

### TDD steps

- [ ] Replace `tests/fixtures/papers-with-code-recent.html` with a minimal current `/papers/recent` list containing: an arXiv row, a non-arXiv durable slug row, an out-of-window row, an off-origin link, an invalid date, and a code-link row.
- [ ] Update the current-structure Alignment Forum fixture and add a LessWrong Frontpage fixture containing one unique post plus one post duplicated in Curated.
- [ ] Update `PapersWithCodeAdapter` tests to expect the exact recent URL, final path validation, at-most-100 rows, stable identities, window filtering, off-origin isolation, and metadata-only output. Add a mutation-sensitive case where the old `Relevant papers` homepage parser yields zero.
- [ ] Run `npx vitest run tests/unit/sources/publication-collector.test.ts -t "PapersWithCodeAdapter|Alignment Forum|LessWrong"` and confirm RED against the old endpoint/parser and missing Frontpage family handling.
- [ ] Change `PAPERS_WITH_CODE_URL` to `/papers/recent`; replace heading/article discovery with a bounded `li` row parser keyed by `/paper/` links and a row-local `time`. Keep provider-text bounds and `paperIdentity()` unchanged.
- [ ] Extend `publicationFromRss()` and `publicationFamily()` to include `lesswrong-frontpage`; do not infer commentary from arbitrary source names.
- [ ] Add research-identity tests for duplicate Curated/Frontpage commentary: one standalone result, unioned lane IDs and sources, deterministic Curated provenance, exact merge record, and no merge for conflicting durable identities.
- [ ] Run `npx vitest run tests/unit/editorial/research-identity.test.ts` and confirm RED because commentary observations are currently handled independently.
- [ ] Refactor `consolidateResearchCandidates()` so commentary candidates are grouped with the same union-find/conflict rules used for papers, then feed each merged commentary item into the existing attachment/standalone loop. Add `mergeGroups` entries only where the existing downstream diagnostic accounting expects identity consolidation; verify no double `identity_merged` count.
- [ ] Update the production-context Papers with Code test in `tests/integration/workflow/manual-run.test.ts` to serve `/papers/recent` current markup and assert one relevant candidate reaches normalize/triage while an irrelevant current row is rejected by ordinary routing, not parser failure.
- [ ] Run `npx vitest run tests/unit/sources/publication-collector.test.ts tests/unit/editorial/research-identity.test.ts` and confirm GREEN.
- [ ] Run `npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "PapersWithCode|LessWrong|Alignment Forum"` and confirm GREEN.
- [ ] Run `npm run check` and `git diff --check`.
- [ ] Commit: `git add src/sources/papers-with-code.ts src/sources/publication-collector.ts src/editorial/research-identity.ts tests/fixtures/alignment-forum-feed.xml tests/fixtures/papers-with-code-recent.html tests/fixtures/lesswrong-frontpage-feed.xml tests/unit/sources/publication-collector.test.ts tests/unit/editorial/research-identity.test.ts tests/integration/workflow/manual-run.test.ts && git commit -m "fix: repair tier one research discovery"`

---

## Task 3: Add static reviewed profiles for Anthropic, DeepMind, and Google Research

**Files:**

- Create: `src/sources/reviewed-publication-profiles.ts`
- Modify: `src/sources/publication-page.ts`
- Modify: `src/sources/publication-collector.ts`
- Create: `tests/fixtures/anthropic-research-listing.html`
- Create: `tests/fixtures/deepmind-blog-listing.html`
- Create: `tests/fixtures/deepmind-blog-detail.html`
- Create: `tests/fixtures/google-research-blog-listing.html`
- Create: `tests/unit/sources/reviewed-publication-profiles.test.ts`
- Modify: `tests/unit/sources/publication-collector.test.ts`

### Contract to implement

Create code-owned profiles keyed only by these exact IDs:

```ts
export const REVIEWED_PUBLICATION_PROFILE_IDS = [
  "anthropic",
  "google-deepmind",
  "google-research",
] as const;

export type ReviewedPublicationListingEntry = {
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string | null;
  category: string | null;
  authors: string[];
};

export type ReviewedPublicationProfile = {
  maxListingEntries: 20;
  maxDetailFetches: 5;
  parseListing(document: Document, baseUrl: string): ReviewedPublicationListingEntry[];
  parseDetailPublishedAt(document: Document): string | null;
};

export function reviewedPublicationProfile(
  sourceId: string,
): ReviewedPublicationProfile | null;
```

Profile selectors are fixed application code:

- Anthropic: anchors with `href` beginning `/research/` that contain a `time`; exclude `/research/team/`. The title is the first nonempty `h2,h3,h4,h5`; if absent, use the longest direct-child `span` value after excluding the date text and every span shorter than 12 code points. The summary is the first row-local `p`; category is the first remaining short span (at most 80 code points) that is neither title nor date. Reject the row if no title survives.
- DeepMind: `.card__inner` containing `.card__overlay-link[href^="/blog/"]`, `.card__title`, `.meta__category`, and `time`. Month-only dates are not treated as exact publication dates; the entry may proceed to a detail fetch for an exact date.
- Google Research: `a.glue-card--blog[href^="/blog/"]`, `.js-gt-item-id`, `.glue-card__eyebrow`, row-local category text.

Every profile's detail-date parser first reads a schema.org `datePublished` value from JSON-LD `BlogPosting`/`NewsArticle`, then the first `<time datetime>` value. It accepts only values that resolve to an exact calendar day; month-only values remain null.

Only the first 20 DOM nodes matched by the source profile are inspected; invalid or off-policy nodes do not cause later nodes to be pulled in. An entry is plausible for a detail fetch only if `mapResearchTopicIds([title, summary ?? "", category ?? ""])` is nonempty. Fetch at most the first 5 plausible entries in deterministic listing order. A dated plausible entry may emit without a successful detail fetch; an undated/month-only DeepMind entry may emit only after its detail page yields an exact ISO date. A nonempty reviewed listing response with zero interpretable matched rows throws a sanitized `SyntaxError` and never enters the generic fallback path.

When a reviewed profile exists, `PublicationPageAdapter` must use it and must not fall back to catalog selectors, JSON-LD, or arbitrary `<article>` inference if the reviewed structure is absent. Non-reviewed university page sources retain the existing best-effort path unchanged.

### TDD steps

- [ ] Add sanitized fixtures that capture only the semantic source structure listed above, plus drift siblings: navigation links, product/hiring entries, an undated Anthropic link, a DeepMind month-only card with exact detail date, an off-policy URL, and malformed rows.
- [ ] Add `reviewed-publication-profiles.test.ts` with exact extraction, ordering, provider-text bounds, structural URL/date preservation, invalid-row isolation, and no generic fallback on drift.
- [ ] Run `npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts` and confirm RED because the module does not exist.
- [ ] Implement the profile module with small per-source parser functions and a fixed map. Use `boundProviderText()` for display/evidence fields and ordinary URL resolution only; do not call a text normalizer on `url` or date values.
- [ ] Add an optional `ReviewedPublicationProfile` constructor argument to `PublicationPageAdapter`; prefer the reviewed path when non-null. Keep the existing constructor behavior for all callers that omit it.
- [ ] Split reviewed collection into three bounded phases: parse/validate at most 20 rows; compute topical plausibility with `mapResearchTopicIds`; fetch at most 5 detail pages using `articleUrlPolicy`. Do not let a failed detail fetch remove a different healthy row.
- [ ] Reuse `extractReadableArticle()` for bounded detail text and `parseDetailPublishedAt()` for an exact date when the listing lacks one. Preserve catalog `contentUse`, `paywall`, and retention metadata.
- [ ] In `createPublicationCollectorFromCatalog()`, call `reviewedPublicationProfile(source.id)` and pass the returned profile only to `PublicationPageAdapter`. Ignore `source.restrictions.listing` for those three reviewed IDs; keep it for Tier 3 sources.
- [ ] Add collector tests proving each reviewed source emits a relevant row, skips product/navigation/off-policy rows, caps detail requests at five, and fails open independently when one detail fetch rejects.
- [ ] Add a mutation-sensitive test proving removal of `mapResearchTopicIds` would exceed the five-fetch bound or fetch an unrelated row.
- [ ] Run `npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts` and confirm GREEN.
- [ ] Run `npm run check` and `git diff --check`.
- [ ] Commit: `git add src/sources/reviewed-publication-profiles.ts src/sources/publication-page.ts src/sources/publication-collector.ts tests/fixtures/anthropic-research-listing.html tests/fixtures/deepmind-blog-listing.html tests/fixtures/deepmind-blog-detail.html tests/fixtures/google-research-blog-listing.html tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts && git commit -m "feat: add reviewed lab publication profiles"`

---

## Task 4: Add the bounded OpenAI official-feed contract

**Files:**

- Create: `src/sources/reviewed-publication-feed.ts`
- Modify: `src/sources/rss.ts`
- Modify: `src/sources/publication-collector.ts`
- Create: `tests/fixtures/openai-news-feed.xml`
- Create: `tests/fixtures/openai-research-detail.html`
- Create: `tests/unit/sources/reviewed-publication-feed.test.ts`
- Modify: `tests/unit/sources/publication-collector.test.ts`

### Contract to implement

Add bounded feed categories without changing structural URL/date handling:

```ts
type NormalizedFeedEntry = {
  // existing fields
  categories: string[];
};
```

`RssAdapter` should copy at most 16 bounded `<category>`/Atom category terms into `RawItem.metadata.feedCategories`; the values are provider-controlled labels, not routing authority. Preserve `mapRssCollectionBatch()` behavior and all non-OpenAI feed semantics.

Extend `ConfiguredFeed` with an optional code-owned `maxEntries` field validated as an integer from 1 through 100. The RSS parser slices the raw entry array before normalization when this value is present. Catalog JSON is never spread into this field. All existing feed callers omit it; the OpenAI factory passes the literal `20`.

Create an `OpenAiPublicationFeedAdapter` implementing the internal publication source adapter contract. It must:

- accept only source ID `openai` and exact feed endpoint `https://openai.com/news/rss.xml` under the catalog feed policy;
- inspect at most the first 20 structurally valid feed entries;
- use title, bounded summary, and categories with `mapResearchTopicIds()` to select at most 5 deterministic detail fetches;
- validate all item/detail URLs under the OpenAI article policy;
- use `extractReadableArticle()` for detail content;
- emit ordinary `RawPublicationCandidate` values with `discoveryFamily: "official-publication"` and lane `openai:rss`;
- allow ordinary `routePublication()` to exclude company, product, and generic policy posts; and
- never fall back to `https://openai.com/research/` or a generic page parser if the feed fails.

An in-window metadata row can emit without a successful detail fetch when it has a valid title, URL, date, and bounded summary. Metadata-only or secondary evidence does not bypass primary-source grounding later.

### TDD steps

- [ ] Add a feed fixture with: one relevant research post, one relevant policy post, one product post, one off-policy URL, one invalid date, and enough relevant rows to prove the five-detail cap.
- [ ] Add unit tests for bounded category extraction in ordinary RSS and for the OpenAI adapter's 20/5 bounds, deterministic order, strict policies, detail fail-open behavior, and zero page fallback calls.
- [ ] Run `npx vitest run tests/unit/sources/reviewed-publication-feed.test.ts tests/unit/sources/publication-collector.test.ts -t "OpenAI|feed categor"` and confirm RED because the adapter/category contract is absent.
- [ ] Extend RSS entry normalization to collect bounded category labels and enforce the code-owned `ConfiguredFeed.maxEntries` before entry parsing. Store categories only in `metadata.feedCategories`; do not add them to IDs, URLs, dates, or author fields.
- [ ] Implement `OpenAiPublicationFeedAdapter` by composing the existing `RssAdapter` for feed parsing and adding the reviewed 20-entry/5-detail selection layer. Do not implement a second XML parser.
- [ ] In `createPublicationCollectorFromCatalog()`, special-case only source ID `openai` with discovery mechanism `rss` to build this adapter. A malformed OpenAI record becomes the existing failed adapter; it must not block other lanes.
- [ ] Add route assertions proving the research post can reach research routing and the product post does not become research merely because it is first-party OpenAI content.
- [ ] Run `npx vitest run tests/unit/sources/reviewed-publication-feed.test.ts tests/unit/sources/publication-collector.test.ts` and confirm GREEN.
- [ ] Run `npm run check` and `git diff --check`.
- [ ] Commit: `git add src/sources/reviewed-publication-feed.ts src/sources/rss.ts src/sources/publication-collector.ts tests/fixtures/openai-news-feed.xml tests/fixtures/openai-research-detail.html tests/unit/sources/reviewed-publication-feed.test.ts tests/unit/sources/publication-collector.test.ts && git commit -m "feat: add reviewed OpenAI research feed"`

---

## Task 5: Add guarded migration `0012_non_arxiv_research_sources.sql`

**Files:**

- Create: `src/db/migrations/0012_non_arxiv_research_sources.sql`
- Create: `tests/integration/db/non-arxiv-research-source-migration.test.ts`
- Modify: `tests/integration/db/research-discovery-source-migration.test.ts`

### Migration contract

Create the new source with a unique canonical URL equal to its exact feed endpoint:

```sql
INSERT OR IGNORE INTO sources (...)
VALUES (
  'lesswrong-frontpage',
  'LessWrong Frontpage',
  'https://www.lesswrong.com/feed.xml?view=frontpage&karmaThreshold=20',
  'blog', 0.8, 1,
  '{... "discoveryMechanism":"rss", ...}',
  NULL, 'unknown'
);
```

Its `feedUrl` must be the same URL. Its feed policy permits only `www.lesswrong.com`, port `""`, prefix `/feed.xml`; its article policy permits only `www.lesswrong.com`, port `""`, prefix `/posts/`.

Guarded exact-default updates:

- Papers with Code: old page `https://paperswithcode.co/?order_by=date_published` -> `https://paperswithcode.co/papers/recent`; preserve the existing strict host/path policy unless absent, and do not overwrite a custom/partial split policy.
- Google DeepMind: old page `https://deepmind.google/discover/blog/` -> `https://deepmind.google/blog/`; endpoint and article policies permit only `deepmind.google`, port `""`, prefix `/blog/`.
- OpenAI: old reviewed 0011 page `https://openai.com/research/index/publication/` -> feed `https://openai.com/news/rss.xml`; set `discoveryMechanism: "rss"`; feed policy permits only `/news/rss.xml`; article policy retains only `/index/` and `/research/` on `openai.com`.
- Anthropic and Google Research: add missing split policies only when both are absent and the endpoint equals the known catalog default. Anthropic endpoint `/research`, article prefix `/research/`; Google Research endpoint/article prefix `/blog/`.

Every update must require all fields it changes to be absent or exactly equal to the reviewed prior default. Run source-specific exact updates before any generic absent-field fill. Do not mutate explicit-equal legacy-looking values when their sibling split field or endpoint is custom; absence semantics govern.

### TDD steps

- [ ] Build a dedicated migration test helper that applies migrations only through `0011` into `env.UPGRADE_DB`, then executes `0012` directly so the SQL itself can be run twice without the migration ledger skipping it.
- [ ] Add fresh-install assertions for all five affected records and the new LessWrong source, including unique canonical URLs, mechanisms, exact endpoints, exact feed/article policies, source order independence, and catalog readability through `D1BriefingRepository`.
- [ ] Add parameterized upgrade tests for every exact known prior default.
- [ ] Add preservation tests for: custom endpoint; custom feed policy; custom article policy; only one split field present; explicit-equal legacy policy with a custom sibling; absent source row; pre-existing `lesswrong-frontpage`; and a canonical-URL collision.
- [ ] Add raw-SQL-twice idempotence asserting identical rows after the second execution.
- [ ] Run `npx vitest run --config vitest.worker.config.ts tests/integration/db/non-arxiv-research-source-migration.test.ts` and confirm RED because migration `0012` is absent.
- [ ] Implement the migration with source-specific `UPDATE ... WHERE` guards and `INSERT OR IGNORE`. Do not edit 0011 or historical migrations.
- [ ] Update the older discovery migration test only where final-current catalog expectations changed; preserve its historical 0007-specific upgrade assertions.
- [ ] Mutation-check each `WHERE` guard by temporarily removing one endpoint/policy/absence predicate and confirm the corresponding preservation test fails; restore the SQL before proceeding.
- [ ] Run `npx vitest run --config vitest.worker.config.ts tests/integration/db/non-arxiv-research-source-migration.test.ts tests/integration/db/research-discovery-source-migration.test.ts tests/integration/db/publication-url-policy-migration.test.ts` and confirm GREEN.
- [ ] Run `npm run check` and `git diff --check`.
- [ ] Commit: `git add src/db/migrations/0012_non_arxiv_research_sources.sql tests/integration/db/non-arxiv-research-source-migration.test.ts tests/integration/db/research-discovery-source-migration.test.ts && git commit -m "feat: migrate reviewed research sources"`

---

## Task 6: Prove the production D1 pipeline preserves editorial quality and fail-open isolation

**Files:**

- Modify: `tests/integration/workflow/manual-run.test.ts`
- Modify: `tests/unit/editorial/route-publication.test.ts`
- Modify: `tests/unit/web/RunStatusPage.test.tsx`
- Modify only if required by a failing backward-compatibility test: `src/web/pages/RunStatusPage.tsx`

### Acceptance scenarios

Use `createD1ProductionPipelineContext()` with migrated catalog rows and deterministic mocked HTTP. Do not bypass the real collectors, normalize/route path, research identity consolidation, discovery tracker, shortlist, synthesis, or grounding seams.

Add these scenarios:

1. **Relevant non-arXiv candidate available:** an Anthropic or DeepMind reviewed listing contains a directly relevant, substantive in-window research result. It reaches research triage with the official-publication lane and still requires ordinary assessment/grounding.
2. **Quiet healthy source:** a valid current listing/feed has interpretable rows outside the seven-day window. Diagnostic is `success`, `observed > 0`, `discovered: 0`; no filler is selected.
3. **Parsed but unroutable:** a current OpenAI product post or LessWrong broad mention is discovered, then receives `route_excluded`; the lane is not mislabeled fetch/parse failure.
4. **Parser drift:** reviewed selectors are absent in a nonempty response. The lane reports `parse`, persists no provider body/text, and other arXiv/non-arXiv lanes continue.
5. **Unsupported media:** reviewed page/feed responds with a disallowed media type. The lane reports `unsupported_media`, and the run continues.
6. **Duplicate commentary:** Curated and Frontpage return the same post. Exactly one candidate reaches the research identity output with both lane/source references and one identity-merge rejection count.
7. **Metadata index boundary:** Papers with Code discovers a relevant primary-paper identity but cannot be synthesized as primary evidence unless the existing paper-resolution/grounding path supplies the primary document.
8. **No quota:** every non-arXiv lane is healthy but irrelevant/quiet. Research may contain only arXiv or be empty; no thresholds, slots, or model calls change.

### TDD steps

- [ ] Add route-publication unit characterizations for relevant commentary, generic alignment mention, relevant official-lab result, official product post, and metadata-only Papers with Code identity. These lock existing editorial thresholds rather than changing them.
- [ ] Add D1 production-context tests for the eight scenarios above. Assert exact bounded diagnostics and absence of response bodies, excerpts, query strings, selector text, and exception messages in serialized audit artifacts.
- [ ] Run the focused route and Worker tests and confirm RED only for missing source contracts/diagnostic distinctions—not because fixtures bypass required grounding.
- [ ] If a test exposes a genuine wiring gap, make the smallest change in the owning adapter/collector file from Tasks 1–4. Do not alter scoring, routing thresholds, assessment prompts, shortlist budgets, or grounding validators.
- [ ] Add `RunStatusPage` unit coverage proving historical diagnostics without `observed` still render and new outcomes/counts render as bounded labels. Change the component only if the test reveals an actual compatibility gap.
- [ ] Run `npx vitest run tests/unit/editorial/route-publication.test.ts tests/unit/web/RunStatusPage.test.tsx` and confirm GREEN.
- [ ] Run `npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "non-arXiv|reviewed publication|quiet source|duplicate commentary|unsupported media"` and confirm GREEN.
- [ ] Run the full Worker suite: `npm run test:worker`.
- [ ] Run the full non-Worker suite: `npm test`.
- [ ] Run `npm run check`, `npm run evaluate`, `npm run build`, and `git diff --check`.
- [ ] Commit: `git add tests/integration/workflow/manual-run.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/web/RunStatusPage.test.tsx src/web/pages/RunStatusPage.tsx && git commit -m "test: verify non-arxiv research reliability"`. If `src/web/pages/RunStatusPage.tsx` was untouched, omit it from `git add`.

---

## Task 7: Final safety audit, documentation, and independent review

**Files:**

- Create: `docs/superpowers/reports/2026-08-12-non-arxiv-research-source-reliability.md`
- Modify if commands or source-health semantics are documented there: `README.md`

### TDD/verification steps

- [ ] Audit the final diff against every approved design goal and non-goal. In the report, make a table mapping each source (`alignment-forum`, `lesswrong-curated`, `lesswrong-frontpage`, `papers-with-code-co`, `anthropic`, `google-deepmind`, `google-research`, `openai`) to endpoint, static parser, entry/detail bounds, URL policies, content/access behavior, and focused tests.
- [ ] Record each RED command and its intended failure, each GREEN command and count, mutation checks, migration preservation cases, and any approved sandbox reruns. Do not claim a suite passed without fresh output from the final tree.
- [ ] Run `rg -n "dangerouslySetInnerHTML|innerHTML\\s*=|outerHTML\\s*=|insertAdjacentHTML|document\\.write" src` and require zero new trusted/dynamic HTML matches.
- [ ] Run targeted structural scans: `rg -n "normalizeProviderText|normalizedProviderSignalText|boundProviderText" src/sources` and manually confirm no URL, ID, date, role, token, credential, or secret assignment is passed through prose normalization.
- [ ] Run `rg -n "TODO|FIXME|placeholder|similar to|implement later" docs/superpowers/reports/2026-08-12-non-arxiv-research-source-reliability.md src/sources tests` and remove any plan/report placeholder introduced by this work.
- [ ] Verify migration history with `git diff 1110484..HEAD -- src/db/migrations/0011_split_publication_url_policies.sql`; require no output.
- [ ] Rerun final gates on exact HEAD: `npm test`, `npm run test:worker`, `npm run check`, `npm run evaluate`, `npm run build`, and `git diff --check 5486b75..HEAD`.
- [ ] Request a fresh read-only code review using `superpowers:requesting-code-review`. The reviewer must inspect spec compliance, URL-policy boundaries, parser bounds, fail-open isolation, diagnostic privacy, migration preservation, duplicate identity behavior, and evidence claims.
- [ ] Address every Critical or Important finding with strict RED/GREEN coverage and rerun all affected/full gates. Re-review the final diff. Do not waive a real finding because existing tests pass.
- [ ] Commit the report and any accurate README adjustment: `git add docs/superpowers/reports/2026-08-12-non-arxiv-research-source-reliability.md README.md && git commit -m "docs: report non-arxiv source reliability"`. If `README.md` was untouched, omit it from `git add`.
- [ ] Confirm `git status --short` is clean and the branch contains only reviewed commits based on `5486b75`.
- [ ] Use `superpowers:finishing-a-development-branch` to push the branch and create a ready pull request. The PR description must state explicitly: no deployment, no shared D1 migration execution, no paid canary, and zero non-arXiv results remains acceptable on quiet days.

## Definition of done

- All Tier 1 and Tier 2 source contracts have current, sanitized fixtures and mutation-sensitive unit coverage.
- A relevant candidate from at least one reviewed non-arXiv source reaches the real research triage path in the production-context test.
- Healthy quiet, parsed-unroutable, fetch/timeout, policy, unsupported-media, and parse-drift states are distinguishable in bounded diagnostics.
- LessWrong Curated and Frontpage duplicates consolidate deterministically with both provenance lanes retained.
- Existing editorial and grounding controls are unchanged and explicitly characterized.
- Migration 0012 preserves custom/partial/equal-looking operator configuration and is raw-SQL idempotent.
- Full unit, Worker, type, evaluator, and build gates pass on the exact final commit.
- Independent review reports no remaining Critical or Important findings.
- A reviewed PR is open; preview deployment and a paid canary remain separate, user-authorized follow-up work.
