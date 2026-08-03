# Final fix report — research AI discovery

Date: 2026-08-03
Branch: `codex/research-ai-discovery-implementation`
Reviewed base: `4c7868ce0042653c1fe276390b74fc4b292b9657`
Scope: all eight Important and both Minor findings in `final-review-findings.md`
Final fix commit: the commit containing this report, with subject `fix: close final research discovery review findings`

## Method and baseline

I read the approved design, implementation plan, final review findings, and SDD
progress ledger before editing. Each reviewed behavior was reproduced with a
focused failing test before its implementation was changed. The initial clean
baseline, run with the loopback permission required by the managed OAuth and
Worker harnesses, was:

- `npm test`: 38 files, 639/639 tests passed.
- `npm run test:worker`: 9 files, 156/156 tests passed.
- A sandbox-only Worker attempt failed with `listen EPERM 127.0.0.1`; this was
  an environment restriction, not a product failure, so loopback suites were
  subsequently run with the required local-listener permission.

No remote Cloudflare state, production secrets, or deployments were touched.

## Important 1 — PapersWithCode production wiring

### RED

Command:

`npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts -t "collects the enabled PapersWithCode catalog source through the production context"`

The production context never called the PapersWithCode fetch path: the fetch
spy received 0 calls where 1 was required. This demonstrated that the catalog
entry existed but the production publication collector still treated it as a
generic blog lane.

### Implementation

- Added the custom `PapersWithCodeAdapter` to the production publication
  collector factory.
- Kept PapersWithCode in the commentary discovery family while permitting its
  catalog role to remain `analysis`, rather than weakening generic blog-role
  validation.
- Preserved the existing generic publication adapter behavior for every other
  catalog source.

### GREEN

- Focused production-context test: 1 passed, 38 skipped.
- Adjacent publication-collector suite: 9/9 passed.
- The test proves a raw PapersWithCode publication is returned, the
  `papers-with-code-co:page` diagnostic is healthy, and the real catalog/factory
  path—not a hand-wired fixture adapter—is exercised.

Files: `src/sources/publication-collector.ts`,
`tests/integration/workflow/manual-run.test.ts`.

## Important 2 — ordinary-news and research reconsideration windows

### RED

Two focused failures established both halves of the defect:

1. The production context returned both Reuters and Alignment Forum for
   four-day-old fixtures, while only the research publication should survive
   the ordinary-news freshness window.
2. The OpenAlex updated-work regression returned 0 candidates where 1
   old-published, recently-updated work was required.

Commands used the focused production-context and OpenAlex tests in
`manual-run.test.ts` and `research-collector.test.ts`.

### Implementation

- Production collection now supplies a 36-hour `freshFrom` window to ordinary
  news and a seven-day `reconsiderationFrom` window to research and publication
  collectors.
- OpenAlex now has three explicit updated-work lanes, one per configured
  research topic, in addition to its text and institution lanes.
- Updated lanes use OpenAlex `updated_date`/`to_updated_date` filters,
  `updated_date:desc` sorting, and exact local timestamp filtering. Ordinary
  lanes continue to filter solely by publication date.
- The query construction was checked against the current official OpenAlex
  filter and sort documentation.

### GREEN

- Production window regression: 1 passed, 39 skipped.
- OpenAlex updated-work regression: 1 passed, 40 skipped.
- Adjacent research-collector suite at that checkpoint: 41/41 passed.
- Expected OpenAlex work requests increased from 4 to 7 and search requests
  from 3 to 6, with exactly 3 updated lanes asserted.

Files: `src/workflow/run-editorial-pipeline.ts`, `src/sources/openalex.ts`,
`src/sources/paper-discovery.ts`, and the corresponding integration/unit tests.

## Important 3 — direct and transitive research identity conflicts

### RED

Two adversarial tests each collapsed 2 papers into 1 before the fix:

- A transitive A–B–C bridge where A and C had conflicting arXiv IDs but B
  shared lower-precedence DOI/provider identities.
- A same-source pair with the same DOI but distinct arXiv IDs.

### Implementation

- Identity components now carry aggregate arXiv, DOI, and recognized-provider
  identity sets.
- Every union applies the required precedence: disjoint nonempty arXiv sets
  block the union; otherwise disjoint nonempty DOI sets block it; otherwise
  disjoint nonempty recognized-provider sets block it.
- The raw same-source merge uses the same precedence and rechecks the evolving
  representative before accepting later transitive matches.

### GREEN

- Focused conflict tests: 2 passed, 54 skipped.
- Adjacent identity, deduplication, normalization, and research-collector
  suites: 73/73 passed.

Files: `src/editorial/research-identity.ts`,
`src/sources/research-collector.ts`, and their unit tests.

## Important 4 — stable commentary evidence fingerprints

### RED

Changing only retrieval/observation timestamps changed the evidence fingerprint
from `evidence:1aarno2` to `evidence:151uo00`, incorrectly reopening unchanged
old evidence.

### Implementation

The commentary fingerprint now projects only stable evidence-bearing fields:
source ID, role, title, URL, access level, excerpt, related paper IDs, and the
implementation-available signal. Retrieval, observation, and last-seen
timestamps—and arbitrary volatile metadata—are excluded.

### GREEN

- Focused fingerprint tests: 2 passed, 17 skipped.
- Adjacent triage and identity suites: 33/33 passed.
- Timestamp-only mutations remain stable, while excerpt and
  `implementationAvailable` changes invalidate the evidence fingerprint.

Files: `src/editorial/research-triage.ts`,
`tests/unit/editorial/research-triage.test.ts`.

## Important 5 — claim-level authority in mixed-source packets

### RED

The mixed-source adversarial summary produced no validation errors even though
only commentary supported the claim and an unrelated primary source merely
shared generic evidence. The expected error was
`PRIMARY_RESEARCH_SOURCE_REQUIRED:0`. Two controls already passed: a genuinely
primary-supported assertion and an exactly attributed commentary assertion.

### Implementation

- Authority is now evaluated over sources that support the claim assertion,
  not every cited source that happens to contain the evidence excerpt.
- Unattributed research claims require primary-research support.
- Commentary-only support remains allowed only for exact, named attribution
  using the existing attribution rules.

### GREEN

- Focused adversarial/control set: 3 passed, 80 skipped.
- Adjacent summary-validation and source-packet suites: 84/84 passed.

Files: `src/editorial/validate-summary.ts`,
`tests/unit/editorial/validate-summary.test.ts`.

## Important 6 — byte-safe provider data, checkpoints, and observations

### RED

This finding used several RED steps:

- Provider contracts initially accepted a 501-character title; the same test
  also covers excessive external IDs, a 4,001-character abstract, metadata
  over 64 KiB, and—added during self-review—a 2,049-character related-paper ID.
- The real 500-item Worker stress run failed in
  `D1PipelineStore.saveCheckpoint` with
  `D1_ERROR: string or blob too big: SQLITE_TOOBIG`.
- After chunking, a follow-up assertion showed that
  `workflow.rawResearch.abstract` still duplicated `normalizedText`.

The original stress artifact's reconstructed legacy single-row maximum was
4,471,308 UTF-8 bytes, above D1's 2,097,152-byte limit.

### Implementation

- Provider-facing IDs, names, titles, URLs, abstracts, contents, arrays,
  structured news fields, and metadata now have explicit limits. Metadata is
  checked by UTF-8 encoded JSON size and must be JSON-serializable.
- Discovery observations have bounded IDs, fingerprints, and external-ID
  arrays; each observation remains a separate D1 row, safely below the row
  limit.
- Research workflow payloads retain compact raw scoring metadata but remove
  duplicate abstract/content text. The selected item's `normalizedText` is
  rehydrated only ephemerally when constructing an assessment source packet.
- D1 checkpoints are encoded first and greedily chunked into atomic batch rows
  capped at 1,500,000 UTF-8 bytes. Chunks carry checkpoint ID, index, and count;
  reads validate completeness/order and reconstruct through the stage schema.
  Legacy single-row checkpoint records remain readable.
- A single oversized non-array value or item fails with a bounded, typed
  checkpoint error before D1 is called, rather than reaching SQLite with an
  unsafe value.

### GREEN

- Focused provider-bound contract: 1 passed, 9 skipped; the later
  related-paper-ID self-review RED is also green.
- Focused 500-item Worker test: 1 passed, 40 skipped at its checkpoint.
- Measured maximum chunk row: 1,498,736 UTF-8 bytes, below the 1,500,000 hard
  cap and D1's 2 MiB limit.
- The test reconstructs all 12 pipeline steps; preserves all 500 collected
  candidates and the selected 24 candidates; verifies every selected
  `SELECTED_EVIDENCE_*` marker survives assessment/readback; and confirms no
  research embedding appears from enrich through shortlist.

Files: `src/sources/types.ts`, `src/workflow/run-editorial-pipeline.ts`,
`tests/unit/contracts/editorial.test.ts`,
`tests/integration/workflow/manual-run.test.ts`.

## Important 7 — cached hard-stop reuse without paid model calls

### RED

- A real `OpenAIModelProvider` configured with `authorize => null` threw
  `BudgetHardStopError: BUDGET_HARD_STOP` from `embed` before cache lookup.
- The repository compatibility test failed because
  `getCachedResearchTopicalFit` did not exist.

### Implementation

- New assessment-cache writes may store a backward-compatible JSON envelope
  containing the assessment plus its stable scalar topical fit, keyed by the
  same canonical ID and evidence fingerprint.
- Legacy bare assessment JSON remains readable and returns `topicalFit = null`.
  A normal cached read with a newly computed fit opportunistically migrates the
  legacy value.
- At `hard_stop`, enrichment performs no embeddings. It loads only exact,
  unexpired cached fits; uncached research and all news are dropped at this
  stage. The existing topical-fit gate still runs, so cache reuse does not
  weaken relevance requirements.
- Assessment then loads the exact cached assessment. The 24/4/0 uncached call
  caps and no-filler quality floor remain unchanged.

### GREEN

- Real-provider hard-stop integration: 1 passed, 41 skipped.
- Result retained: 1 cached research item at topical fit 0.95.
- Counters: embed 0, generate 0, authorization 0, transport 0, usage records 0.
- Repository compatibility: 1 passed, 33 skipped. A legacy bare assessment is
  returned unchanged with null fit; the new envelope returns the unchanged
  assessment plus fit 0.91.
- The adjacent stale hard-stop test was updated to assert the new correct
  behavior: uncached items are removed before enrichment/model work.

Files: `src/db/repository.ts`, `src/db/d1-repository.ts`,
`src/workflow/run-editorial-pipeline.ts`, and integration tests.

## Important 8 — bounded OpenAlex abstract reconstruction

### RED

Three hostile provider cases were all admitted as real OpenAlex candidates:
a sparse position of 999,999, 2,001 distinct words sharing one position, and
129 positions for one word. Each focused case expected the healthy arXiv
sibling only but also received `OpenAlex:W260899999`.

### Implementation

- The inverted index caps distinct words (2,000), total tokens (2,000),
  positions per word (128), maximum position (4,095), word length (200), and
  reconstructed output (4,000 characters).
- Structural caps are checked before constructing the sorted entry list. This
  self-review refinement prevents a response that already violates an array
  cap from being flattened a second time.
- Reconstruction sorts bounded `{position, word}` entries and streams unique
  positions into a dense word list. It never allocates through the maximum
  provider-supplied position.

### GREEN

- Focused hostile-index set: 4 passed, 42 skipped (the fourth case is an
  oversized reconstructed output).
- In every case the adapter fails open, retains the healthy arXiv sibling,
  emits only `{sourceId: "openalex", kind: "parse"}`, and leaks none of the
  hostile provider content into public results.

Files: `src/sources/openalex.ts`,
`tests/unit/sources/research-collector.test.ts`.

## Minor 1 — preserve timeout outcomes

### RED

The HTTP deadline test received `failureKind: "transport"` instead of
`"timeout"`, and settlement returned `{kind: "fetch"}` instead of
`{kind: "timeout"}`. Focused result: 2 failed, 50 skipped.

### Implementation and GREEN

`SourceFetchError` now includes a tagged timeout kind. Request and response-body
catch paths consult the internal abort signal, and collection settlement maps
that tag to the public timeout outcome without exposing private error details.

Focused result: 2 passed, 50 skipped.

Files: `src/sources/http-client.ts`,
`src/sources/collection-settlement.ts`, and their tests.

## Minor 2 — distinct lineage and monotone diagnostic funnels

### RED

One commentary item was attached to two distinct papers. The commentary lane
reported downstream counts of 2 despite `discovered = 1`; the expected count
was 1 at deduplicated, triaged, and assessed. Separately, the diagnostic schema
accepted the impossible 1→2→2→2 funnel.

### Implementation

- Normalization records bounded upstream lineage tuples containing lane,
  source, discovery family, and stable upstream item ID.
- Deduplication and commentary attachment union those lineage records.
- Each diagnostic stage counts distinct matching upstream lineage keys and is
  capped by the preceding stage.
- Observation family is selected from the contributing source's lineage, with
  a legacy commentary/source-role fallback, rather than inherited from the
  merged winner.
- Schema validation now enforces
  `assessed <= triaged <= deduplicated <= discovered`; public diagnostic ID
  validation remains intact.

### GREEN

- Adversarial Worker diagnostic test: 1 passed, 41 skipped. The paper lane is
  2→2→2→2; the one commentary lineage is 1→1→1→1 even though attached twice.
  ArXiv observations remain `arxiv`; copied PapersWithCode observations remain
  `commentary`.
- Funnel contract test: 1 passed, 10 skipped.

Files: `src/editorial/deduplicate.ts`,
`src/editorial/research-identity.ts`, `src/sources/types.ts`,
`src/db/repository.ts`, `src/workflow/run-editorial-pipeline.ts`, and tests.

## Final verification

The consolidated verification pass on the completed implementation produced:

- `npm run check` — PASS (`tsc --noEmit`).
- `npm test` — PASS, 38 files and 654/654 tests.
- `npm run test:worker` — PASS, 9 files and 160/160 tests.
- `npm run evaluate` — PASS: precision@5 1.00; required research ordering,
  discovery families, identity joins, routes, triage, quality gates, windows,
  grounding, and local-section expectations all matched; duplicate-cluster
  recall 1.00; no accepted claim lacked supporting source IDs.
- `npm run build` — PASS, Vite transformed 53 modules and emitted the client
  production bundle.
- `git diff --check` — PASS.

Loopback-dependent commands were run with the local-listener permission needed
by the repository's test harness. Sourcemap warnings in the Worker suite refer
to missing upstream package source files and did not affect test outcomes.

## Self-review and residual concerns

The final diff was reviewed for source security, cache backward compatibility,
D1 row safety, fail-open behavior, score/gate preservation, and diagnostics
privacy. Two gaps found during that pass were fixed before commit: OpenAlex now
checks structural limits before entry expansion, and publication
`relatedPaperIds` reuse the bounded provider-ID schema.

No known functional review finding remains open. Deliberate fail-safe behavior
remains: an individually valid checkpoint value that still exceeds the
1,500,000-byte application cap is rejected before persistence, and a hard-stop
run without an exact cached topical fit discards that candidate rather than
spending, weakening the gate, or inserting filler.
