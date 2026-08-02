# Task 3 implementation report

## Status

Complete. Official publication and commentary candidates are collected under a publication-only contract, then deterministically routed to research/news or excluded before `normalizeCandidate`. The production collector is active only for enabled eligible `role: "blog"` catalog sources. PapersWithCode.co remains a dedicated discovery-only adapter and is not cross-source-attached in this task.

## Interface clarification

The brief fixed `PublicationCollector.collect` but did not fix construction. Before activation, the parent confirmed the existing catalog-factory pattern:

- `createPublicationCollectorFromCatalog({ http, sources }): PublicationCollector`
- `PublicationCollector` remains dependency-injectable.
- The factory activates only enabled `role: "blog"` sources eligible for `research`, `research_radar`, `technology`, or `ai_policy`.
- Production settles publications independently alongside news and paper discovery, then routes every publication before normalization.

## Implementation and files

- `src/sources/publication-page.ts`
  - Added JSON-LD-first parsing for `BlogPosting`, `NewsArticle`, and `ItemList`, configured-selector fallback, then semantic `<article>` fallback.
  - Enforced 20 listing items and 10 permitted detail fetches per source.
  - Reused the existing readable-article extraction and transient-extraction policy, with strict outbound URL checks and fail-open detail retrieval.
- `src/sources/publication-collector.ts`
  - Added dependency-injectable collection and `createPublicationCollectorFromCatalog`.
  - Added enabled/blog/section eligibility filtering, stable ordering, source-independent settlement, and publication provenance.
- `src/sources/rss.ts`
  - Exported the existing arXiv extraction helper and added a pure collection-batch mapper so publication RSS uses the established XML parser.
- `src/sources/papers-with-code.ts`
  - Added the pinned `https://paperswithcode.co/` page adapter, on-origin `/paper/<id>` filtering, normalized arXiv/opaque provider IDs, 100-record cap, and discovery-only code availability metadata.
- `src/editorial/route-publication.ts`
  - Added deterministic ordered routing using explicit identifiers/links, `mapResearchTopicIds`, study/method/result vocabulary, and existing news-signal derivation.
  - Routed research has neutral citation fields; routed news is non-corroborating; ambiguous independent commentary is excluded.
- `src/workflow/run-editorial-pipeline.ts`
  - Activated independently settled production publication collection.
  - Added the mandatory pre-normalization route/exclude boundary and retained routed research in `workflow.rawResearch` for research enrichment/assessment.
- `src/sources/durable-evidence.ts`
  - Extended the existing ephemeral-evidence sanitizer to the staged publication contract before collection checkpoints.
- `tests/fixtures/official-research-listing.html`
- `tests/fixtures/papers-with-code-recent.html`
- `tests/unit/sources/publication-collector.test.ts`
- `tests/unit/editorial/route-publication.test.ts`
- `tests/integration/workflow/manual-run.test.ts`
  - Updated the production-context fetch fixture for Task 2's Semantic Scholar/OpenAlex discovery endpoints so its intended sanitized failure set remains precisely `reuters:fetch`.

No dependency was added, and Task 4 cross-source commentary/PapersWithCode attachment was not implemented.

## Exact RED evidence

1. Publication collection:
   - Command: `npm test -- --run tests/unit/sources/publication-collector.test.ts`
   - Result: 1 failed suite, 0 tests. `Cannot find module '../../../src/sources/publication-collector'` at the new collector import.
2. PapersWithCode.co:
   - Command: `npm test -- --run tests/unit/sources/publication-collector.test.ts -t "PapersWithCode"`
   - Result: 1 failed suite, 0 tests. `Cannot find module '../../../src/sources/papers-with-code'` at the dedicated adapter import.
3. Publication routing:
   - Command: `npm test -- --run tests/unit/editorial/route-publication.test.ts`
   - Result: 1 failed suite, 0 tests. `Cannot find module '../../../src/editorial/route-publication'` at the router import.
4. Pipeline closure:
   - Command: `npm test -- --run tests/unit/editorial/route-publication.test.ts -t "before item normalization"`
   - Result: 1 failed, 6 skipped. `RawItemSchema` rejected `kind: "publication"` inside `normalizeCandidate`, with `Invalid enum value. Expected 'paper' | 'blog' | 'article' | 'document' | 'forecast', received 'publication'`.
5. Combined production collectors:
   - Command: `npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts`
   - Result: 1 failed, 64 passed. `restores sanitized source failures when a fresh context resumes past collect` expected `["reuters:fetch"]` but received `["openalex:fetch", "reuters:fetch", "semantic-scholar:fetch"]`.
   - Root cause: intentionally stale test fixture after Task 2. The test enabled Semantic Scholar and OpenAlex, but its fetch double handled only their legacy enrichment paths. Their newly activated search/recommendation/institution/work discovery requests hit the fixture's `Unexpected production-context URL` branch and were correctly sanitized as fetch failures. Task 3 added no unexpected publication-source activity.

## Exact GREEN evidence

- Publication collection: `npm test -- --run tests/unit/sources/publication-collector.test.ts` — 1 file, 3 tests passed at the initial GREEN; final file has 6 tests passed after selector/fallback/cap coverage was added.
- PapersWithCode.co: `npm test -- --run tests/unit/sources/publication-collector.test.ts -t "PapersWithCode"` — 1 passed, 3 skipped.
- Routing: `npm test -- --run tests/unit/editorial/route-publication.test.ts` — 1 file, 6 tests passed at routing GREEN.
- Pipeline closure: `npm test -- --run tests/unit/editorial/route-publication.test.ts -t "before item normalization"` — 1 passed, 6 skipped.
- Required focused suite: `npm test -- --run tests/unit/sources/publication-collector.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/sources/news-signals.test.ts` — 3 files, 41 tests passed.
- Related unit suites: `npm test -- --run tests/unit/sources/rss.test.ts tests/unit/sources/news-collector.test.ts tests/unit/sources/research-collector.test.ts tests/unit/sources/durable-evidence.test.ts tests/unit/editorial/deduplicate.test.ts tests/unit/editorial/pipeline.test.ts tests/unit/workflow/schedule.test.ts` — 6 discovered files, 123 tests passed.
- Broad unit verification: `npm test -- --exclude tests/unit/config/preview-e2e-managed-oauth.test.ts` — 33 files, 540 tests passed.
- Focused combined-collector integration: `npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts -t "restores sanitized source failures"` — 1 passed, 33 skipped after the fixture returned valid empty responses for all Task 2 discovery endpoints.
- Workflow integration: `npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts` — 2 files, 65 tests passed.
- Type check: `npm run check` — `tsc --noEmit` exited 0.
- Build: `npm run build` — Vite built 53 modules successfully.
- `git diff --check` — exited 0.

## Evidence that publication cannot reach normalization

The pipeline-boundary regression passes three `RawPublicationCandidate` values through `createProductionPipelineContext.collect` and `normalize`: a topical paper post, an AI-governance post, and ambiguous independent commentary. It asserts that the output kinds are exactly `paper` and `article`, that no output can have `kind: "publication"`, that the paper retains a routed `RawResearchCandidate` in `metadata.workflow.rawResearch`, and that the ambiguous publication disappears.

The implementation enforces the same boundary in `normalizedCandidate`: it first parses `RawPublicationCandidateSchema`, calls `routePublication`, returns `null` for exclusion, and only then invokes `normalizeCandidate` on the routed research/news value. The RED stack trace proves the prior code passed `publication` into `RawItemSchema`; the GREEN regression proves that path is closed.

## Self-review

- Collection uses the catalog as a ceiling, never as item-level route evidence. Disabled, non-blog, and section-ineligible sources are ignored by the production factory.
- RSS parsing is not duplicated; it uses `RssAdapter` plus a pure mapper. Source fetch/parse failures settle without aborting other sources.
- Page URLs, redirects, feed links, detail links, and PapersWithCode paper links remain inside strict source policies. Detail fetch policy failures drop only the affected item; other detail failures retain listing metadata.
- Retrieved bodies use the existing readable-article extractor. Ephemeral full text is sanitized by the existing durable-evidence path before checkpoint persistence.
- PapersWithCode output never stores leaderboard prose/numbers as claims, never fetches detail pages, and marks implementation availability only for identifiable GitHub/GitLab/Codeberg links present in retrieved markup.
- Routing order matches the design: topical substantive/identified research, eligible governance, eligible technology, ambiguous official-lab Technology fallback, then exclusion. It calls no model.
- News routes use `deriveNewsSignals` and remain `canCorroborateFacts: false`; research routes preserve discovery metadata with null citation counts.
- Existing edition maxima, ranking, clustering, and evidence behavior were not changed.

## Concerns

- Full `npm test -- --run tests/unit` produced 13 failures in `tests/unit/config/preview-e2e-managed-oauth.test.ts` during authorization-server metadata setup (565 of 578 tests passed). Task 3 does not touch that code; this is the same existing suite concern recorded in Task 2.
- The first worker command inside the sandbox could not bind `127.0.0.1` (`EPERM`); the approved unsandboxed rerun produced the integration result above.
