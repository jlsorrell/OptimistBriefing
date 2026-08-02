# Research and AI Discovery Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden research and AI discovery across paper APIs, official publications, Alignment Forum, LessWrong, and PapersWithCode.co while ranking the complete pool before paid assessment and preserving the existing quality floor.

**Architecture:** Independent source adapters produce bounded paper, publication, and commentary candidates with explicit discovery-family provenance. The pipeline joins candidates by durable paper identity, routes publications by content, embeds the complete normalized pool for scalar relevance, retains a diverse queue of at most 24 research candidates, and only then performs cached or paid technical assessment. D1 stores bounded discovery observations, assessment cache entries, and per-lane diagnostics for seven-day reconsideration and run inspection.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers and Workflows, D1/SQLite migrations, Vitest with Cloudflare's Workers pool, `fast-xml-parser`, `linkedom`, existing model-provider interfaces.

## Global Constraints

- Preserve research score weights exactly: topical fit `0.35`, technical quality `0.30`, research signal `0.15`, novelty `0.10`, serious attention `0.10`.
- Preserve minimum topical fit `0.5`, minimum technical quality `0.5`, three featured research items, and six research-radar items.
- Use a 36-hour fresh window and a seven-day reconsideration window.
- Bound the merged research discovery pool at 500 pre-deduplication candidates per run.
- Bound the normal deep-assessment queue at 24 candidates; one discovery family may supply at most 12 and one publisher domain at most 6. Release unused reservations.
- Under degraded budget policy, admit at most four uncached research assessments. Under hard-stop policy, admit no uncached paid assessment; cached valid assessments may still be used.
- Research embeddings are transient. Persist scalar topical fit, but never persist a research embedding after the enrich checkpoint output is produced.
- Alignment Forum, LessWrong, PapersWithCode.co, analysis, opinion, blog, and forecast sources never corroborate factual claims.
- Classify official-lab publications by retrieved content: technical result to Research, governance or evaluation-policy development to AI Policy, and product/capability release to Technology.
- Preserve fail-open source settlement, strict outbound URL policies, sanitized failure labels, source health tracking, and the existing edition publication quality floor.
- Do not add unrestricted general-web search or a new required secret.
- Use existing dependencies; do not add an HTML, RSS, database, or model SDK.

---

### Task 1: Add discovery contracts and catalog sources

**Files:**
- Modify: `src/sources/types.ts`
- Modify: `src/workflow/types.ts`
- Create: `src/db/migrations/0007_research_discovery_sources.sql`
- Create: `tests/integration/db/research-discovery-source-migration.test.ts`
- Modify: `tests/unit/contracts/editorial.test.ts`

**Interfaces:**
- Produces: `DiscoveryFamily`, `DiscoveryWindowKind`, `RawPublicationCandidate`, `DiscoveryObservation`, and `DiscoveryLaneDiagnostic` Zod schemas and inferred types.
- Produces: `DiscoverySourceAdapter extends SourceAdapter` with stable `laneId` and `discoveryFamily` fields while retaining the catalog-backed `sourceId` used by settlement and source health.
- Produces: catalog sources `alignment-forum`, `lesswrong-curated`, and `papers-with-code-co`.
- Consumes: existing `RawItemSchema`, `SourceRefSchema`, `EditionSectionSchema`, and source-catalog JSON conventions.

- [ ] **Step 1: Write failing contract tests**

Add tests that accept a bounded publication candidate and reject an unknown discovery family, a publication with more than 16 related paper IDs, a diagnostic with negative counts, and an observation whose `observedAt` is not an ISO timestamp.

```ts
expect(RawPublicationCandidateSchema.parse({
  kind: "publication",
  sourceId: "alignment-forum",
  sourceName: "Alignment Forum",
  sourceRole: "blog",
  title: "A new result on debate",
  originalUrl: "https://www.alignmentforum.org/posts/example/result",
  externalId: "example",
  externalIds: ["example"],
  publishedAt: "2026-08-01T12:00:00.000Z",
  retrievedAt: "2026-08-02T09:00:00.000Z",
  accessLevel: "secondary",
  authors: ["Ada Example"],
  institutions: [],
  abstract: "We analyze debate under strategic incentives.",
  content: null,
  relatedPaperIds: [],
  sectionEligibility: ["research", "research_radar"],
  discoveryFamily: "commentary",
  metadata: {},
})).toMatchObject({ kind: "publication", discoveryFamily: "commentary" });
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npm test -- --run tests/unit/contracts/editorial.test.ts`

Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Implement the source contracts**

Add these exact schema domains:

```ts
export const DiscoveryFamilySchema = z.enum([
  "arxiv",
  "bibliographic",
  "official-publication",
  "commentary",
]);
export const DiscoveryWindowKindSchema = z.enum(["fresh", "reconsideration"]);
export const RawPublicationCandidateSchema = RawItemSchema
  .omit({ kind: true })
  .extend({
    kind: z.literal("publication"),
    sectionEligibility: z.array(EditionSectionSchema).min(1),
    discoveryFamily: DiscoveryFamilySchema,
    relatedPaperIds: z.array(z.string().min(1)).max(16),
  });
```

Define `DiscoveryObservationSchema` with run ID, canonical identity, source ID, family, window kind, timestamps, content/evidence fingerprints, joined external IDs, and routing result `research | technology | ai_policy | excluded`. Define `DiscoveryLaneDiagnosticSchema` with lane ID, family/source ID, nonnegative `discovered`, `deduplicated`, `triaged`, and `assessed` counts, plus `success | fetch | parse | policy | timeout | unknown` outcome. Add `RawPublicationCandidateSchema` to `CollectedCandidateSchema`. Do not add `publication` to `ItemKindSchema`; every publication must route before normalization.

Add this adapter contract beside `SourceAdapter`:

```ts
export interface DiscoverySourceAdapter extends SourceAdapter {
  readonly laneId: string;
  readonly discoveryFamily: DiscoveryFamily;
}
```

`sourceId` must always remain a real source-catalog ID so existing settlement, source health, and URL-policy lookups continue to work. `laneId` is the unique per-query/per-mechanism diagnostic identity.

- [ ] **Step 4: Write the failing migration test**

Test that migration `0007_research_discovery_sources.sql` creates the three sources with these exact endpoints and roles:

```ts
expect(source("alignment-forum")).toMatchObject({
  role: "blog",
  discoveryMechanism: "rss",
  sectionEligibility: ["research", "research_radar"],
});
expect(source("lesswrong-curated").restrictions.feedUrl)
  .toBe("https://www.lesswrong.com/feed.xml?view=curated");
expect(source("papers-with-code-co").restrictions.pageUrl)
  .toBe("https://paperswithcode.co/?order_by=date_published");
```

Also verify rerunning the migration is idempotent and existing official publication rows receive a strict `urlPolicy`. Use these host/path pairs: `research.stanford.edu:/news`, `vcresearch.berkeley.edu:/news`, `research.harvard.edu:/`, `news.mit.edu:/rss/`, `www.cmu.edu:/news/`, `research.upenn.edu:/news/`, `hub.jhu.edu:/topics/research/`, `research.utexas.edu:/news`, `research.gatech.edu:/news`, `research.google:/blog/`, `deepmind.google:/discover/blog/`, `www.anthropic.com:/research`, and `openai.com:/research/`.

- [ ] **Step 5: Run the migration test and verify RED**

Run: `npm run test:worker -- --run tests/integration/db/research-discovery-source-migration.test.ts`

Expected: FAIL because migration `0007` is absent.

- [ ] **Step 6: Implement the idempotent catalog migration**

Insert the three new sources with `INSERT OR IGNORE`. Use `https://www.alignmentforum.org/feed.xml?view=frontpage` for Alignment Forum, the LessWrong URL above, and the PapersWithCode.co URL above. Set `bodyRetrieval` to `permitted`, `paywall` to `none`, `contentUse` to `ephemeral-summarization` for the forums and `discovery-metadata-only` for PapersWithCode.co. Set `canCorroborateFacts` to `false` for all three. Add strict allowed hosts, ports `['']`, and path prefixes. Update each existing official publication source with its host/path policy only when `urlPolicy` is absent.

- [ ] **Step 7: Run Task 1 tests**

Run: `npm test -- --run tests/unit/contracts/editorial.test.ts`

Run: `npm run test:worker -- --run tests/integration/db/research-discovery-source-migration.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/sources/types.ts src/workflow/types.ts src/db/migrations/0007_research_discovery_sources.sql tests/unit/contracts/editorial.test.ts tests/integration/db/research-discovery-source-migration.test.ts
git commit -m "feat: add research discovery contracts and sources"
```

### Task 2: Implement multi-lane paper discovery

**Files:**
- Modify: `src/sources/arxiv.ts`
- Modify: `src/sources/semantic-scholar.ts`
- Modify: `src/sources/openalex.ts`
- Create: `src/sources/paper-discovery.ts`
- Modify: `src/sources/research-collector.ts`
- Create: `tests/fixtures/semantic-scholar-search.json`
- Create: `tests/fixtures/semantic-scholar-recommendations.json`
- Create: `tests/fixtures/openalex-discovery.json`
- Modify: `tests/unit/sources/research-collector.test.ts`

**Interfaces:**
- Produces: `createPaperDiscoveryAdapters(http, sources): readonly DiscoverySourceAdapter[]`.
- Produces: `SemanticScholarDiscoveryAdapter` and `OpenAlexDiscoveryAdapter` returning `RawItem[]` with `kind: "paper"`.
- Consumes: `READER_PROFILE.researchTopics`, versioned Semantic Scholar seed IDs, strict provider URL policies, and `ResearchCollector` fail-open settlement.

- [ ] **Step 1: Write failing targeted-arXiv tests**

Assert that the factory creates three arXiv adapters and that each request retains the category constraint while adding the configured topic expression. Assert that a paper returned by two arXiv lanes retains one candidate after collection-level identity merging.

```ts
expect(requestQueries).toHaveLength(3);
expect(requestQueries.every((query) => query.includes("cat:cs."))).toBe(true);
expect(requestQueries.join(" ")).toContain("interpretability");
expect(requestQueries.join(" ")).toContain("provenance");
expect(requestQueries.join(" ")).toContain("homomorphic encryption");
```

- [ ] **Step 2: Run the targeted-arXiv test and verify RED**

Run: `npm test -- --run tests/unit/sources/research-collector.test.ts -t "targeted arXiv"`

Expected: FAIL because only one broad adapter exists.

- [ ] **Step 3: Implement targeted arXiv configuration**

Export `ARXIV_TOPIC_QUERIES` from `paper-discovery.ts` as three immutable `{ laneId, query }` records. Each query must combine `cat:cs.AI OR cat:cs.LG OR cat:cs.CL OR cat:cs.CR` with quoted terms for the associated reader-profile family. Give each adapter a unique lane ID (`arxiv:alignment-interpretability`, `arxiv:oversight-governance`, `arxiv:secure-ml`) while keeping `sourceId: "arxiv"` for settlement, catalog policy, source health, and returned item provenance. Add collection-level paper identity merging so repeated arXiv/DOI candidates do not multiply.

- [ ] **Step 4: Write failing Semantic Scholar and OpenAlex discovery tests**

Cover recent search, recommendations from versioned seeds, result limits, date filtering, provider fields, institution metadata, malformed provider responses, and a failed discovery adapter that does not erase arXiv candidates. Require these external IDs when present:

```ts
expect(candidate.externalIds).toEqual(expect.arrayContaining([
  "SemanticScholar:paper-id",
  "arXiv:2608.00001",
  "DOI:10.1000/example",
]));
```

- [ ] **Step 5: Run provider-discovery tests and verify RED**

Run: `npm test -- --run tests/unit/sources/research-collector.test.ts -t "bibliographic discovery"`

Expected: FAIL because both providers are enrichment-only.

- [ ] **Step 6: Implement Semantic Scholar discovery**

Use only `https://api.semanticscholar.org/graph/v1/paper/search/bulk` and `https://api.semanticscholar.org/recommendations/v1/papers`. Request bounded fields `paperId,externalIds,title,abstract,authors,year,publicationDate,venue,citationCount,influentialCitationCount,fieldsOfStudy,url`. Store this exact versioned immutable starter set in `paper-discovery.ts`, with one seed for each configured topic family:

```ts
export const SEMANTIC_SCHOLAR_SEED_SET_V1 = [
  { family: "alignment", paperId: "ARXIV:2209.10652", title: "Toy Models of Superposition" },
  { family: "oversight-governance", paperId: "ARXIV:2103.05633", title: "Proof-of-Learning: Definitions and Practice" },
  { family: "secure-ml", paperId: "ARXIV:1801.05507", title: "Gazelle: A Low Latency Framework for Secure Neural Network Inference" },
] as const;
```

Search and recommendation failures settle independently, using unique `laneId` values and catalog `sourceId: "semantic-scholar"`. No API key is required by configuration; continue to accept provider throttling as a sanitized fetch failure.

- [ ] **Step 7: Implement OpenAlex discovery**

Use only `https://api.openalex.org/institutions` to resolve the exact configured institution/lab names and `https://api.openalex.org/works` to discover works. Cache resolved OpenAlex institution IDs for the duration of one collection run; unresolved names fail open and do not widen the query. Run one recent-text query per research topic family and one preferred-institution query batch using the resolved IDs. Request `id,doi,title,publication_date,updated_date,cited_by_count,ids,authorships,topics,abstract_inverted_index,primary_location`. Reconstruct an abstract only from the returned inverted index. Apply the seven-day bound locally even when provider filters are present. Use unique `laneId` values and catalog `sourceId: "openalex"`; mark every returned item `discoveryFamily: "bibliographic"` in metadata. Extend the existing OpenAlex URL-policy test so only `/institutions` and `/works` paths are accepted.

- [ ] **Step 8: Wire all paper adapters into `ResearchCollector`**

Replace the production-only single `ArxivAdapter` construction with `createPaperDiscoveryAdapters`. Keep existing Semantic Scholar and OpenAlex enrichers after discovery. Enforce a stable limit of 100 candidates per paper lane. Sort adapter results by `laneId`, then publication date descending and canonical identity ascending, so response completion timing cannot affect output. The shared 500-candidate cap is applied in Task 6 after routed official publications and commentary join the pool; do not consume all 500 slots inside the paper collector.

- [ ] **Step 9: Run Task 2 tests**

Run: `npm test -- --run tests/unit/sources/research-collector.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add src/sources/arxiv.ts src/sources/semantic-scholar.ts src/sources/openalex.ts src/sources/paper-discovery.ts src/sources/research-collector.ts tests/fixtures/semantic-scholar-search.json tests/fixtures/semantic-scholar-recommendations.json tests/fixtures/openalex-discovery.json tests/unit/sources/research-collector.test.ts
git commit -m "feat: discover papers across research providers"
```

### Task 3: Collect and route official publications and commentary

**Files:**
- Create: `src/sources/publication-page.ts`
- Create: `src/sources/publication-collector.ts`
- Create: `src/editorial/route-publication.ts`
- Create: `src/sources/papers-with-code.ts`
- Modify: `src/sources/rss.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Create: `tests/fixtures/papers-with-code-recent.html`
- Create: `tests/fixtures/official-research-listing.html`
- Create: `tests/unit/sources/publication-collector.test.ts`
- Create: `tests/unit/editorial/route-publication.test.ts`

**Interfaces:**
- Produces: `PublicationCollector.collect(window): Promise<CollectionBatch<RawPublicationCandidate>>`.
- Produces: `routePublication(candidate): RawResearchCandidate | RawNewsCandidate | null`.
- Produces: `PapersWithCodeAdapter.collect(window): Promise<RawPublicationCandidate[]>`.
- Consumes: catalog RSS/page configuration, `mapResearchTopicIds`, existing news-signal derivation, and strict source URL policies.

- [ ] **Step 1: Write failing publication-collection tests**

Use fixtures to verify RSS and page collection for official labs, Alignment Forum, and LessWrong. Require bounded full-text stripping, related arXiv extraction, author/date parsing, source eligibility, and `canCorroborateFacts: false` provenance.

```ts
expect(result.candidates[0]).toMatchObject({
  kind: "publication",
  discoveryFamily: "commentary",
  relatedPaperIds: ["arXiv:2608.00001"],
  sourceRole: "blog",
});
```

- [ ] **Step 2: Run publication-collection tests and verify RED**

Run: `npm test -- --run tests/unit/sources/publication-collector.test.ts`

Expected: FAIL because the collector is absent.

- [ ] **Step 3: Implement reusable publication collection**

Extract stable page parsing behavior into `PublicationPageAdapter`: parse JSON-LD `BlogPosting`, `NewsArticle`, and `ItemList` first, then configured selectors, then `<article>` fallback. It may return at most 20 items per page source and may fetch at most 10 permitted detail pages. Extend `RssAdapter` through an option or pure mapper rather than duplicating its parser. `PublicationCollector` accepts all enabled `role: "blog"` sources with Research, Technology, or AI Policy eligibility and settles each independently.

- [ ] **Step 4: Write failing PapersWithCode.co tests**

Use server-rendered markup containing `/paper/2608.00001`, `/paper/98456`, title, and date. Assert that arXiv-shaped paths yield normalized arXiv IDs, opaque paths remain PapersWithCode IDs, off-origin links are dropped, and all output is discovery-only.

- [ ] **Step 5: Run the PapersWithCode.co test and verify RED**

Run: `npm test -- --run tests/unit/sources/publication-collector.test.ts -t "PapersWithCode"`

Expected: FAIL because the dedicated adapter is absent.

- [ ] **Step 6: Implement `PapersWithCodeAdapter`**

Pin the origin to `https://paperswithcode.co` and page path to `/`. Parse the server-rendered `Relevant papers` list and `/paper/<id>` links. Return at most 100 discovery records, set `discoveryFamily: "commentary"`, and store `implementationAvailable: true` only when an identifiable code link exists in retrieved permitted markup. Never convert a leaderboard number into a factual paper claim.

- [ ] **Step 7: Write failing routing tests**

Cover these exact routes:

```ts
expect(routePublication(technicalPaperPost).kind).toBe("paper");
expect(routePublication(governancePost)).toMatchObject({
  kind: "article",
  metadata: { primarySection: "ai_policy" },
});
expect(routePublication(productPost)).toMatchObject({
  kind: "article",
  metadata: { primarySection: "technology" },
});
expect(routePublication(ambiguousOfficialLabPost)).toMatchObject({
  metadata: { primarySection: "technology" },
});
expect(routePublication(ambiguousIndependentPost)).toBeNull();
```

- [ ] **Step 8: Run routing tests and verify RED**

Run: `npm test -- --run tests/unit/editorial/route-publication.test.ts`

Expected: FAIL because routing is absent.

- [ ] **Step 9: Implement deterministic publication routing**

Use explicit arXiv/DOI/paper links and `mapResearchTopicIds` plus study/method/result vocabulary for Research. Reuse governance and technology signals from `news-signals.ts` for AI Policy and Technology. A routed research publication becomes a `RawResearchCandidate` with neutral citation fields and its discovery metadata. A routed news publication becomes a non-corroborating `RawNewsCandidate`. Apply the ordered fallback rules from the design; do not call a model.

- [ ] **Step 10: Route publications before normalization**

Update `normalizedCandidate`/the normalize stage so `RawPublicationCandidate` is routed before `normalizeCandidate`. Excluded publications disappear deterministically. Feed routed research into research enrichment and routed news into existing news normalization and clustering.

- [ ] **Step 11: Run Task 3 tests**

Run: `npm test -- --run tests/unit/sources/publication-collector.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/sources/news-signals.test.ts`

Expected: PASS.

- [ ] **Step 12: Commit Task 3**

```bash
git add src/sources/publication-page.ts src/sources/publication-collector.ts src/editorial/route-publication.ts src/sources/papers-with-code.ts src/sources/rss.ts src/workflow/run-editorial-pipeline.ts tests/fixtures/papers-with-code-recent.html tests/fixtures/official-research-listing.html tests/unit/sources/publication-collector.test.ts tests/unit/editorial/route-publication.test.ts
git commit -m "feat: collect and route research publications"
```

### Task 4: Join cross-source research identity and attach commentary

**Files:**
- Create: `src/editorial/research-identity.ts`
- Modify: `src/editorial/normalize.ts`
- Modify: `src/editorial/deduplicate.ts`
- Modify: `src/sources/research-collector.ts`
- Create: `tests/unit/editorial/research-identity.test.ts`
- Create: `tests/unit/editorial/normalize.test.ts`
- Modify: `tests/unit/editorial/deduplicate.test.ts`

**Interfaces:**
- Produces: `canonicalResearchIdentity(candidate): string`.
- Produces: `consolidateResearchCandidates(candidates): { papers; standaloneCommentary; merges }`.
- Produces: attached commentary metadata with source ID, role, title, URL, retrieved timestamp, access level, excerpt, and related paper IDs.
- Consumes: normalized DOI/arXiv/provider IDs, conservative title keys, author overlap, and explicit commentary links.

- [ ] **Step 1: Write failing identity tests**

Test merge priority arXiv ID, DOI, provider mapping, canonical URL, and conservative title plus author overlap. Test that title similarity alone does not join unrelated papers and that commentary never replaces primary paper text or access level.

```ts
expect(consolidated.papers[0]).toMatchObject({
  accessLevel: "abstract",
  metadata: {
    attachedCommentary: [expect.objectContaining({ sourceId: "alignment-forum" })],
  },
});
expect(consolidated.standaloneCommentary).toHaveLength(0);
```

- [ ] **Step 2: Run identity tests and verify RED**

Run: `npm test -- --run tests/unit/editorial/research-identity.test.ts`

Expected: FAIL because cross-source consolidation is absent.

- [ ] **Step 3: Implement canonical paper identity**

Return `arxiv:<normalized>`, then `doi:<normalized>`, then a sorted recognized provider ID, then canonical URL. Title fallback requires a normalized exact title key plus at least one normalized author match or an explicit `relatedPaperIds` link. Store every merged source in stable order. Keep paper source evidence separate from attached commentary metadata.

- [ ] **Step 4: Implement commentary attachment and duplicate suppression**

Attach a commentary candidate only when it explicitly identifies the paper or meets the title-plus-author rule. Preserve unlinked, substantive commentary as a standalone `blog` candidate. Add attached commentary sources to `Item.sourceRefs` with role `blog`, but keep `metadata.primaryResearchSourceIds` as the only source IDs eligible to ground paper-result claims.

- [ ] **Step 5: Run identity and dedup tests**

Run: `npm test -- --run tests/unit/editorial/research-identity.test.ts tests/unit/editorial/deduplicate.test.ts tests/unit/editorial/normalize.test.ts`

Expected: PASS, including the existing test that does not near-merge a paper and commentary merely because their text is related.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/editorial/research-identity.ts src/editorial/normalize.ts src/editorial/deduplicate.ts src/sources/research-collector.ts tests/unit/editorial/research-identity.test.ts tests/unit/editorial/deduplicate.test.ts tests/unit/editorial/normalize.test.ts
git commit -m "feat: consolidate cross-source research identity"
```

### Task 5: Persist discovery observations and assessment cache

**Files:**
- Create: `src/db/migrations/0008_discovery_observations.sql`
- Modify: `src/db/repository.ts`
- Modify: `src/db/d1-repository.ts`
- Modify: `src/maintenance/retention.ts`
- Modify: `tests/integration/db/repository.test.ts`
- Modify: `tests/unit/maintenance/retention.test.ts`

**Interfaces:**
- Produces repository methods:
  - `upsertDiscoveryObservations(observations: readonly DiscoveryObservation[]): Promise<void>`
  - `getDiscoveryObservations(canonicalIds: readonly string[], since: string, excludingRunId: string): Promise<readonly DiscoveryObservation[]>`
  - `getCachedResearchAssessment(canonicalId: string, evidenceFingerprint: string, now: string): Promise<ResearchAssessment | null>`
  - `putCachedResearchAssessment(canonicalId: string, evidenceFingerprint: string, assessment: ResearchAssessment, expiresAt: string): Promise<void>`
- Consumes: canonical research identity and content/evidence fingerprints from Task 4.

- [ ] **Step 1: Write failing repository tests**

Test idempotent observation upsert, source-specific observation history, bounded lookup, exact fingerprint cache hits, cache misses after evidence change, rejection of malformed JSON, and retention deletion.

```ts
await repository.putCachedResearchAssessment(
  "arxiv:2608.00001",
  "evidence:v1",
  assessment,
  "2026-11-01T00:00:00.000Z",
);
await expect(repository.getCachedResearchAssessment(
  "arxiv:2608.00001",
  "evidence:v1",
  "2026-08-02T09:00:00.000Z",
)).resolves.toEqual(assessment);
await expect(repository.getCachedResearchAssessment(
  "arxiv:2608.00001",
  "evidence:v2",
  "2026-08-02T09:00:00.000Z",
)).resolves.toBeNull();
```

- [ ] **Step 2: Run repository tests and verify RED**

Run: `npm run test:worker -- --run tests/integration/db/repository.test.ts`

Expected: FAIL because the tables and methods are absent.

- [ ] **Step 3: Add bounded D1 tables**

Create `discovery_observations` keyed by `(run_id, canonical_id, source_id, evidence_fingerprint)` with family, window kind, published/retrieved/observed timestamps, content fingerprint, joined IDs JSON, route, and expiry. This makes writes idempotent within a workflow run while preserving source-specific history across runs. Create `research_assessment_cache` keyed by `(canonical_id, evidence_fingerprint)` with strict assessment JSON, created timestamp, and expiry. Add indexes on observation time, observation canonical identity, observation run ID, and both expiry columns.

- [ ] **Step 4: Implement validated repository methods**

Use Zod validation before every mutation and after every JSON read. Chunk `IN` queries to at most 50 canonical IDs. `getDiscoveryObservations` must exclude the current run ID so workflow retries compare against prior runs without suppressing their own reconsideration candidates. `getCachedResearchAssessment` must include `expires_at > now` in SQL; pass `now` as an explicit method argument to keep tests deterministic. Extend retention reports and pruning to include both tables without changing published-edition immutability.

- [ ] **Step 5: Run Task 5 tests**

Run: `npm run test:worker -- --run tests/integration/db/repository.test.ts`

Run: `npm test -- --run tests/unit/maintenance/retention.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/db/migrations/0008_discovery_observations.sql src/db/repository.ts src/db/d1-repository.ts src/maintenance/retention.ts tests/integration/db/repository.test.ts tests/unit/maintenance/retention.test.ts
git commit -m "feat: cache research discovery evidence"
```

### Task 6: Add reconsideration and relevance-first triage

**Files:**
- Create: `src/editorial/research-triage.ts`
- Modify: `src/workflow/types.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `src/workflow/daily-briefing-workflow.ts`
- Create: `tests/unit/editorial/research-triage.test.ts`
- Modify: `tests/integration/workflow/manual-run.test.ts`
- Modify: `tests/unit/workflow/schedule.test.ts`

**Interfaces:**
- Produces: `boundResearchDiscoveryPool(items, maximum = 500)` with deterministic per-family reservations and released unused capacity.
- Produces: `triageResearch(items, options): ResearchTriageResult` with selected items, exclusions, and per-family counts.
- Produces: `classifyDiscoveryWindow(candidate, priorObservations, now): "fresh" | "reconsideration" | null`.
- Consumes: scalar topical fit, discovery families, publisher domain, topic IDs, evidence fingerprints, cache methods, and `BudgetPolicy`.

- [ ] **Step 1: Write failing pure triage tests**

Cover the shared 500 pre-deduplication cap, four discovery-family reservations, topical-fit gate, 24 normal cap, 4 degraded uncached cap, 0 hard-stop uncached cap, 12-per-family cap, 6-per-domain cap, topic reservations, deterministic tie-breaking, and unused-reservation release.

```ts
const selected = triageResearch(candidates, {
  maximum: 24,
  maximumPerFamily: 12,
  maximumPerPublisherDomain: 6,
  configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
});
expect(selected.items).toHaveLength(24);
expect(maximumFamilyCount(selected.items)).toBeLessThanOrEqual(12);
expect(maximumDomainCount(selected.items)).toBeLessThanOrEqual(6);
```

- [ ] **Step 2: Run triage tests and verify RED**

Run: `npm test -- --run tests/unit/editorial/research-triage.test.ts`

Expected: FAIL because triage is absent.

- [ ] **Step 3: Implement deterministic triage**

Implement `boundResearchDiscoveryPool` before identity merging: sort each of the four configured discovery families by published/updated time descending, bounded source/institution prior descending, then stable canonical key ascending. Reserve `floor(500 / 4) = 125` slots per family, release unused slots, and fill released capacity from the same deterministic ordering across all remaining candidates. Then filter invalid content and topical fit for `triageResearch`. Sort triage candidates by topical fit, preferred-source/institution prior, recency, then stable item ID. Select one best qualified representative per configured topic, then fill while enforcing family and publisher caps. Release topic and family reservations that have no qualified candidates. Return explicit exclusion reasons without changing existing shortlist exclusion contracts.

- [ ] **Step 4: Write failing reconsideration tests**

Test that a candidate inside 36 hours is fresh, an unchanged four-day-old candidate is absent, and a four-day-old candidate with a changed content or evidence fingerprint is reconsidered. Test that a changed discovery source alone is not a qualifying signal when canonical identity and evidence are unchanged. Test that observations written by the current run do not change selection when the same workflow run retries.

- [ ] **Step 5: Implement the two-window selector**

Collect the seven-day provider window once. Route publication candidates, apply `boundResearchDiscoveryPool`, and only then consolidate identity. Label candidates from the last 36 hours fresh. For older candidates, compare canonical identity and fingerprints against observations since `now - 7 days`, excluding observations whose `runId` equals the current run; include only new content/evidence fingerprints. Persist observations after selection. The run-scoped primary key and exclusion rule make the write idempotent and preserve identical selection when the same workflow run retries.

- [ ] **Step 6: Write failing pipeline tests for ranking before assessment**

Create 30 research candidates where the first nine are irrelevant and later candidates are relevant. Assert that assessment calls target the relevant triaged queue rather than arrival order. Assert that the enrich artifact contains scalar topical fit but no research `metadata.workflow.embedding`.

- [ ] **Step 7: Run pipeline tests and verify RED**

Run: `npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts -t "relevance-first research triage"`

Expected: FAIL because `applyResearchBudget` still truncates before embedding and assessment.

- [ ] **Step 8: Integrate transient embeddings and cached assessment**

Remove pre-embedding `applyResearchBudget`. Embed the complete bounded pool in batches, compute scalar topical fit/personal relevance, and remove research vectors before returning enrich output. Keep news vectors until clustering. Run `triageResearch` in prefilter. In assess, load an exact fingerprint cache entry first; save successful new assessments. Under hard stop, drop uncached research candidates. Under degraded state, allow at most four uncached calls. Expand the monthly reservation calculation to cover 500 embedding inputs and 24 assessment calls without raising the configured monthly dollar limit.

- [ ] **Step 9: Update checkpoint validation**

Require `topicalFit` but forbid persisted research embeddings from enrich onward. Continue requiring news embeddings until cluster. Preserve assessment, score, section, and selection-reason requirements at their existing stages.

- [ ] **Step 10: Run Task 6 tests**

Run: `npm test -- --run tests/unit/editorial/research-triage.test.ts tests/unit/workflow/schedule.test.ts`

Run: `npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts`

Expected: PASS, including bounded checkpoint-size assertions.

- [ ] **Step 11: Commit Task 6**

```bash
git add src/editorial/research-triage.ts src/workflow/types.ts src/workflow/run-editorial-pipeline.ts src/workflow/daily-briefing-workflow.ts tests/unit/editorial/research-triage.test.ts tests/integration/workflow/manual-run.test.ts tests/unit/workflow/schedule.test.ts
git commit -m "feat: rank research before model assessment"
```

### Task 7: Add bounded commentary/code signals and run diagnostics

**Files:**
- Modify: `src/editorial/research-score.ts`
- Modify: `src/editorial/validate-summary.ts`
- Modify: `src/workflow/source-packet.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/db/d1-repository.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `src/web/pages/RunStatusPage.tsx`
- Modify: `tests/unit/editorial/research-score.test.ts`
- Modify: `tests/unit/editorial/validate-summary.test.ts`
- Modify: `tests/integration/db/repository.test.ts`
- Modify: `tests/integration/workflow/manual-run.test.ts`

**Interfaces:**
- Produces: `deriveResearchContextSignals(candidate): { implementationAvailability; substantiveCommentary; seriousAttention }`.
- Produces: `SourcePacket.sources[].sourceName` and `.evidenceKind` with exact values `primary-research | commentary | news-evidence`.
- Produces: `recordDiscoveryDiagnostics(runId, diagnostics)` and `WorkflowRunDetail.discoveryDiagnostics`.
- Consumes: attached commentary, PapersWithCode.co metadata, primary research source IDs, and Task 6 triage counts.

- [ ] **Step 1: Write failing score and validation tests**

Assert that implementation and substantive commentary produce bounded selection reasons and serious-attention changes, never technical-quality changes. Assert that vote/comment counts alone do not increase quality. Assert that a paper-result claim citing only a blog source is invalid. Assert that a commentary-only claim is allowed only when the claim text explicitly names its commentary source and uses one of `argues`, `notes`, `suggests`, `critiques`, or `interprets` as the attribution verb.

```ts
expect(withContext.technicalQuality).toBe(withoutContext.technicalQuality);
expect(withContext.seriousAttention).toBeGreaterThan(withoutContext.seriousAttention);
expect(validateSummary(blogOnlyPaperResult, paperPacket)).toMatchObject({
  ok: false,
  errors: expect.arrayContaining(["PRIMARY_RESEARCH_SOURCE_REQUIRED:0"]),
});
```

- [ ] **Step 2: Run score and validation tests and verify RED**

Run: `npm test -- --run tests/unit/editorial/research-score.test.ts tests/unit/editorial/validate-summary.test.ts`

Expected: FAIL because the context signals and primary-source rule are absent.

- [ ] **Step 3: Implement bounded context signals**

Map implementation availability and substantive linked commentary into `seriousAttention` only. Keep missing signals neutral. Add human-readable reasons `Independent implementation located.` and `Substantive expert commentary located.` when applicable. Do not change `RESEARCH_SCORE_WEIGHTS`.

- [ ] **Step 4: Harden research source packets and validation**

Add required `sourceName` and `evidenceKind` to each packet source. For research items, set IDs from `metadata.primaryResearchSourceIds` to `primary-research` and attached blog IDs to `commentary`; use `news-evidence` for existing news packets. Preserve excerpts and attribution. In `validateSummary`, a research claim passes when it cites at least one `primary-research` source. A claim citing only commentary passes only when its normalized text contains that cited source's normalized name or title plus one of the exact attribution verbs `argues`, `notes`, `suggests`, `critiques`, or `interprets`; otherwise return `PRIMARY_RESEARCH_SOURCE_REQUIRED:<claimIndex>`. This rule does not alter access-level checks or allow commentary to ground a paper result.

- [ ] **Step 5: Write failing diagnostics tests**

Test audit upsert, strict bounded arrays, counts per family/source, source-outcome sanitization, workflow-detail exposure, and Run Status rendering. The UI should render only counts and sanitized labels.

- [ ] **Step 6: Implement discovery diagnostics**

Store a single upserted `discovery_diagnostics:<runId>` audit event with at most 64 lane records. Update it after collection, deduplication, triage, and assessment. Extend `WorkflowRunDetailSchema`, D1 read logic, API response, and Run Status page with a compact table: lane, discovered, deduplicated, triaged, assessed, outcome. Never store bodies, provider errors, credentials, or arbitrary URLs.

- [ ] **Step 7: Run Task 7 tests**

Run: `npm test -- --run tests/unit/editorial/research-score.test.ts tests/unit/editorial/validate-summary.test.ts`

Run: `npm run test:worker -- --run tests/integration/db/repository.test.ts tests/integration/workflow/manual-run.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add src/editorial/research-score.ts src/editorial/validate-summary.ts src/workflow/source-packet.ts src/db/repository.ts src/db/d1-repository.ts src/workflow/run-editorial-pipeline.ts src/web/pages/RunStatusPage.tsx tests/unit/editorial/research-score.test.ts tests/unit/editorial/validate-summary.test.ts tests/integration/db/repository.test.ts tests/integration/workflow/manual-run.test.ts
git commit -m "feat: explain research discovery signals"
```

### Task 8: Add golden evaluation, end-to-end coverage, and rollout documentation

**Files:**
- Modify: `tests/golden/research-candidates.json`
- Modify: `tests/golden/expected-rankings.json`
- Modify: `scripts/evaluate-golden-set.ts`
- Modify: `tests/preview-e2e/content.spec.ts`
- Modify: `docs/runbooks/source-health.md`
- Modify: `docs/runbooks/preview-rehearsal.md`

**Interfaces:**
- Produces: a versioned golden corpus covering every approved discovery and routing behavior.
- Produces: preview acceptance instructions for source-family coverage, checkpoint sizes, model cost, and quality-floor behavior.
- Consumes: all adapters, routing, identity, caching, triage, scoring, and diagnostics from Tasks 1–7.

- [ ] **Step 1: Add failing golden cases**

Add these cases with explicit expected ordering and exclusions:

- highly relevant, technically strong non-preferred-institution paper;
- prestigious but irrelevant paper;
- topical but technically weak paper;
- the same paper from arXiv, Semantic Scholar, OpenAlex, and PapersWithCode.co;
- official-lab technical result, product release, and policy announcement;
- linked Alignment Forum commentary;
- popular but unsupported LessWrong commentary;
- a newly coded four-day-old paper; and
- a noisy AI product headline.

Require the strong relevant paper to outrank prestige, the weak paper to fail its gate, duplicates to produce one paper, and the three official-lab posts to route to three sections.

- [ ] **Step 2: Run the evaluator and verify RED**

Run: `npm run evaluate`

Expected: FAIL until the evaluator consumes discovery family, routing, commentary, and implementation signals.

- [ ] **Step 3: Extend the golden evaluator**

Evaluate discovery joins, routing, triage admission, final research scoring, selection reasons, and quality-gate exclusions. Print only fixture IDs and component scores; do not print fixture body text.

- [ ] **Step 4: Add preview E2E assertions**

Assert that a preview edition can render a featured paper with attached commentary and implementation labels, that Technology and AI Policy retain distinct official-lab items, and that no empty or below-floor section is fabricated.

- [ ] **Step 5: Update runbooks**

Document the four discovery families, source catalog controls, exact source-failure semantics, 36-hour/seven-day windows, cache invalidation by fingerprint, assessment caps, diagnostic counts, and a preview-canary checklist. Include the acceptance rule that at least two independent research discovery families must succeed before treating the canary as representative; do not convert it into a new publication requirement.

- [ ] **Step 6: Run complete verification**

Run: `npm test`

Run: `npm run test:worker`

Run: `npm run evaluate`

Run: `npm run check`

Run: `npm run build`

Run: `git diff --check`

Expected: every command exits zero. OAuth and Workers suites that bind `127.0.0.1` must run with loopback-listener permission in restricted environments.

- [ ] **Step 7: Commit Task 8**

```bash
git add tests/golden/research-candidates.json tests/golden/expected-rankings.json scripts/evaluate-golden-set.ts tests/preview-e2e/content.spec.ts docs/runbooks/source-health.md docs/runbooks/preview-rehearsal.md
git commit -m "test: verify layered research discovery"
```

## Final Review and Preview Canary

- [ ] Dispatch a whole-branch code review covering source policy, claim grounding, D1 bounds, model cost, cache correctness, and deterministic ranking.
- [ ] Address review findings and rerun the complete verification sequence.
- [ ] Deploy to the isolated preview Worker with `--keep-vars`; never read or replace the stored OpenAI secret.
- [ ] Apply migrations `0007` and `0008` only to the preview D1 database first.
- [ ] Run one manual preview workflow and record source-family outcomes, candidate counts, assessment count, checkpoint byte lengths, model cost, publication status, and quality-floor reason.
- [ ] Confirm at least two independent research discovery families succeeded, non-arXiv candidates reached triage, no research item was assessed by arrival order, cluster and shortlist checkpoints contain no embeddings, and sparse input still preserves the quality floor.
- [ ] After canary review, use `superpowers:finishing-a-development-branch` to offer local merge, pull request, or preserved branch.
