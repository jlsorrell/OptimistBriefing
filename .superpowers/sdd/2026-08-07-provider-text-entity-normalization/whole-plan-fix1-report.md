# Whole-plan Fix Round 1 Report

## Outcome

Whole-plan review findings were repaired with strict TDD. Human-readable Papers With Code, GDELT, and Federal Register text is decoded before routing and signal derivation. Structural section metadata remains raw and must validate as an edition section. Provider-text input and output bounds no longer split surrogate pairs, and the primitive coverage now explicitly protects the input cap, two-pass cap, C1 rejection, and named-apostrophe behavior.

## RED evidence

Primitive boundary and coverage command:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts -t "C1|named apos|100,000|third decode|surrogate pair"
```

Result: exit 1; the surrogate-safe truncation test failed with `A�` instead of `A`. The four explicit allowlist/bound coverage tests passed.

Structural section command:

```sh
npx vitest run tests/unit/editorial/normalize.test.ts -t "structural section metadata"
```

Result: exit 1; encoded `&#114;esearch` metadata incorrectly produced `primaryTopic: "research"`.

Papers With Code command:

```sh
npx vitest run tests/unit/sources/publication-collector.test.ts -t "topical provider text"
```

Result: exit 1; the collected title retained `&#105;` and did not provide decoded topical text to publication routing.

API-news command:

```sh
npx vitest run tests/unit/sources/news-collector.test.ts -t "GDELT provider text|Federal Register text"
```

Result: exit 1; both regressions failed because titles/evidence retained entity references before signal derivation.

Input-cap surrogate command, added during self-review:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts -t "input inspection bound"
```

Result: exit 1; the 100,000-character input cap retained a lone high surrogate.

## GREEN evidence

Targeted commands:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts -t "C1|named apos|100,000|third decode|surrogate pair"
npx vitest run tests/unit/editorial/normalize.test.ts -t "structural section metadata"
npx vitest run tests/unit/sources/publication-collector.test.ts -t "topical provider text"
npx vitest run tests/unit/sources/news-collector.test.ts -t "GDELT provider text|Federal Register text"
npx vitest run tests/unit/sources/provider-text.test.ts -t "input inspection bound"
```

Results: all exited 0; respectively 5, 1, 1, 2, and 1 targeted tests passed.

Affected focused suites:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts tests/unit/editorial/normalize.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/research-collector.test.ts tests/unit/sources/news-collector.test.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/pipeline.test.ts
```

Result: exit 0; 8 test files passed, 206 tests passed.

Typecheck:

```sh
npm run check
```

Result: exit 0; `tsc --noEmit` passed.

Diff validation:

```sh
git diff --check
```

Result: exit 0; no whitespace errors.

## Files changed

- `src/sources/provider-text.ts`
- `src/sources/papers-with-code.ts`
- `src/sources/gdelt.ts`
- `src/sources/news-collector.ts`
- `src/editorial/normalize.ts`
- `tests/unit/sources/provider-text.test.ts`
- `tests/unit/sources/publication-collector.test.ts`
- `tests/unit/sources/news-collector.test.ts`
- `tests/unit/editorial/normalize.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

## Commits

- `5872c66149e52863637a7363e87e439c3fe5e161` — `fix: normalize provider text before routing`
- Report commit: recorded in the task handoff because its SHA is created after this file is written.

## Self-review

- Papers With Code normalizes only link display text; paper URLs, identifiers, and dates retain their prior raw handling.
- GDELT normalizes only the provider title before persistence and `deriveNewsSignals`; article URL, seen date, domain, language, country, and external IDs remain raw.
- Federal Register normalizes only title and abstract before persistence and signal derivation; document number, URL, publication date, type, and external IDs remain raw.
- Structural `primarySection`/`section` values use raw whitespace normalization and must pass `EditionSectionSchema`; invalid entity-like values remain in metadata but do not create derived topics or tags.
- Both the 100,000-character inspection cap and configurable output cap iterate code-point boundaries without exceeding their UTF-16 length limits or retaining half a surrogate pair.
- Prior URL/ID boundaries, evidence precedence, topic decoding, extracted-article truncation/access classification, schemas, and evidence bounds remain covered by the affected suites.
- No trusted-HTML insertion, general sanitizer, deployment, canary, migration, or historical rewrite was added.

## Concerns

- None.

## Whole-plan Fix Round 2

This round restores Federal Register access classification from raw provider evidence presence while retaining normalized human-readable evidence. It also replaces the input-cap iterator with an exact bounded-index truncation that never reads a code unit at or beyond the configured maximum.

### RED evidence

Federal Register command:

```sh
npx vitest run tests/unit/sources/news-collector.test.ts -t "raw abstract presence"
```

Result: exit 1. A provider-present `&nbsp;` abstract normalized to `null` and was incorrectly classified as `metadata`; a raw-null abstract remained `metadata` as expected.

Exact input-cap command:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts -t "input inspection bound"
```

Result: exit 1. Output was already surrogate-safe, but instrumentation showed the string iterator consumed the scalar crossing the 100,000-code-unit boundary.

### GREEN evidence

Targeted commands:

```sh
npx vitest run tests/unit/sources/news-collector.test.ts -t "raw abstract presence"
npx vitest run tests/unit/sources/provider-text.test.ts -t "input inspection bound"
```

Results: both exited 0; one targeted test passed in each file.

Affected focused suites:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts tests/unit/editorial/normalize.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/research-collector.test.ts tests/unit/sources/news-collector.test.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/pipeline.test.ts
```

Result: exit 0; 8 test files passed, 207 tests passed.

Typecheck:

```sh
npm run check
```

The first run identified a test-only `StringIterator` generator return-type mismatch. After correcting that annotation, the fresh run exited 0 with `tsc --noEmit` passing.

Diff validation:

```sh
git diff --check
```

Result: exit 0; no whitespace errors.

### Files changed

- `src/sources/news-collector.ts`
- `src/sources/provider-text.ts`
- `tests/unit/sources/news-collector.test.ts`
- `tests/unit/sources/provider-text.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Commit

Planned message: `fix: preserve provider access and exact text bounds`. The resulting SHA is recorded in the task handoff.

### Self-review

- Federal Register access level uses only the original nullable/optional abstract presence; decoded abstract remains the sole value persisted and supplied to `deriveNewsSignals`.
- A provider-present entity-only abstract can normalize to `null` without downgrading the prior `secondary` access classification; a raw-null/absent abstract remains `metadata`.
- Input truncation reads only `maximum - 1` to detect a boundary high surrogate, drops that high surrogate without inspecting the following unit, and otherwise slices at the exact maximum.
- Complete surrogate pairs fully inside the cap remain intact; output never exceeds the existing numeric bounds.
- All Whole-plan Fix Round 1 behavior and earlier URL/ID, evidence precedence, topic, schema, and extraction/access invariants remain covered by the affected suites.

### Concerns

- None.

## Whole-plan Fix Round 3

This round removes raw provider display text from the retained research workflow payload, normalizes Polymarket questions before news-signal derivation, and reports normalization truncation caused by NFKC expansion so extracted-article access classification remains conservative.

### RED evidence

Provider-text and source regressions:

```sh
npm test -- --run tests/unit/sources/provider-text.test.ts tests/unit/sources/news-collector.test.ts
```

Result: exit 1; three new regressions failed for the expected reasons. The detailed normalization API did not exist, the encoded Polymarket question reached the candidate unchanged, and 60,000 `ﬃ` ligatures expanded to the 100,000-character cap without marking the article partial.

Research workflow regression:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "persists compact normalized research display text"
```

Result: exit 1 after the required localhost permission was granted. The normalized Item retained entity-encoded `metadata.venue` and `metadata.topics`, omitted normalized preferred-institution matches, and still retained the raw research payload. The first sandboxed attempt could not bind the Worker test port (`EPERM`).

Pre-commit review then identified NFKC/schema-bound and legacy-Item bypass gaps. Their RED commands were:

```sh
npx vitest run tests/unit/sources/news-collector.test.ts -t "bounds Polymarket questions"
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "bounds normalized research display fields|recompacts legacy Item workflow research"
```

Results: both exited 1. An in-bound 200-ligature Polymarket question expanded past the 500-character title schema; expanded research title/name arrays likewise failed compact reconstruction; and an already-formed legacy `Item` retained encoded display/evidence fields and arbitrary `rawResearch.metadata`.

A final reviewer edge-case regression added entity-only author and institution names to the expanding research case. Its targeted Worker run exited 1 because normalized empty strings violated the provider-name minimum during compact reconstruction; filtering empty normalized names made the same command exit 0.

### GREEN evidence

Affected unit suites:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts tests/unit/editorial/normalize.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/research-collector.test.ts tests/unit/sources/news-collector.test.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/pipeline.test.ts tests/unit/workflow/source-packet.test.ts
```

Result: exit 0; 9 test files passed, 212 tests passed.

Full manual workflow integration suite:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts
```

Result: exit 0; 1 test file passed, 65 tests passed. The run emitted existing third-party missing-sourcemap warnings, but no test failures.

Static verification:

```sh
npm run check
npm run build
git diff --check
```

Results: all exited 0; `tsc --noEmit` passed, Vite built 53 modules, and the diff contained no whitespace errors.

The repository-wide `npm test` command was also run. It completed with 39 files and 746 tests passing, but exited 1 because 13 isolated tests in `tests/unit/config/preview-e2e-managed-oauth.test.ts` fail at authorization-server metadata/registration before reaching their expected later stages. Running that file alone reproduced the same 13 failures; neither the OAuth source nor its tests are changed by this round.

### Files changed

- `src/editorial/normalize.ts`
- `src/sources/article-extractor.ts`
- `src/sources/polymarket.ts`
- `src/sources/provider-text.ts`
- `src/workflow/run-editorial-pipeline.ts`
- `tests/integration/workflow/manual-run.test.ts`
- `tests/unit/sources/news-collector.test.ts`
- `tests/unit/sources/provider-text.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Commit

Planned message: `fix: normalize retained provider research text`. The resulting SHA is recorded in the task handoff.

### Self-review

- The retained `workflow.rawResearch` object is rebuilt from an explicit allowlist. Title, source name, authors, institutions, topics, and preferred-institution matches come from the normalized Item; abstract/content are null; arbitrary raw metadata is removed.
- Raw research source IDs, URLs, external IDs, publication/retrieval dates, access level, related IDs, and citation counts retain their collected values. The integration regression verifies the object after a D1 round trip and then assesses that persisted Item.
- Known human-readable Item metadata fields `venue` and `topics`, plus generated provenance source names, are explicitly overwritten with normalized values. No recursive metadata normalization was introduced.
- The assessment packet is produced from normalized compact display fields and normalized Item evidence and is asserted not to contain a numeric entity reference.
- Polymarket normalizes only the human-readable question and uses the same decoded value for persistence and signal derivation. Market URLs/IDs/dates, probability metadata, liquidity, and resolution source are unchanged; forecasts retain the `forecast` primary section while their configured `ai_policy` eligibility and decoded AI-policy evidence remain available.
- Provider title/name-class display fields are bounded to 500 characters after decoding and NFKC, preventing compatibility expansion from violating the raw-candidate schemas. The same bound is applied to Polymarket questions before candidate parsing.
- Provider author and institution arrays discard entries that normalize to empty text before compact raw-schema reconstruction.
- Already-formed `Item` inputs now pass through the same explicit display/evidence normalization for title, source names, normalized text, and known metadata arrays; any existing research workflow payload is rebuilt through the compact allowlist before later stages.
- `normalizeProviderTextDetailed` preserves the existing `normalizeProviderText` API while reporting input/output truncation, including NFKC expansion. Article extraction marks the selected Readability or fallback text partial whenever that result reports truncation.
- The 100,000-character bound, code-point-safe truncation, Readability/fallback precedence, short-text classification, URL/ID boundaries, and prior provider decoding behavior remain covered by the affected suites.
- No deployment, canary, migration, history rewrite, recursive sanitizer, or unrelated OAuth change was performed.

### Concerns

- The repository-wide unit command remains red only in the isolated managed-OAuth test file described above; the scoped unit, integration, typecheck, build, and diff checks all pass.

## Whole-plan Fix Round 4

This round closes the legacy retry boundaries left by Round 3: completed checkpoint artifacts are normalized in memory before downstream use, fix-base Items preserve workflow-only preferred-institution matches, oversized legacy metadata arrays are bounded deterministically, and known provenance source names are decoded without altering structural provenance fields.

### RED evidence

The Round 4 regressions were added before production changes and run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "normalizes legacy completed checkpoints|recompacts legacy Item workflow research|bounds oversized legacy research metadata arrays"
```

Result: exit 1; all three targeted tests failed for the expected reasons:

- a completed pre-assessment checkpoint supplied encoded research title, source name, and evidence to the model packet and retained arbitrary raw metadata;
- a fix-base-shaped Item without `metadata.preferredInstitutionMatches` lost its normalized workflow-only match, while its known provenance source name remained encoded;
- four 70-entry legacy metadata arrays caused `RawResearchCandidateSchema` reconstruction to reject values above the 64-entry provider bound.

Pre-commit review then identified two additional checkpoint-boundary gaps. Two more regressions were added before their production fixes and run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "normalizes a completed collect Item only once|normalizes nested development Items"
```

Result: exit 1; both tests failed for the expected reasons:

- a triple-encoded completed collect Item was normalized again during the normalize stage, decoding it twice instead of exactly once;
- restored shortlist `workflow.development.items` and `representativeItem` remained encoded in the synthesis source packet.

The follow-up review found that the first marker location was provider-controlled top-level metadata. The nested-development regression was tightened to inject that colliding field while removing the trusted workflow marker; it failed before the marker was moved into the strict workflow payload, proving that arbitrary metadata could previously bypass normalization.

### GREEN evidence

The original targeted command exited 0 with all 3 tests passing after the fixes. The two review-driven tests also exited 0, and the combined Round 4 command exited 0 with all 5 tests passing.

Affected unit suites:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts tests/unit/editorial/normalize.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/editorial/research-triage.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/research-collector.test.ts tests/unit/sources/news-collector.test.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/pipeline.test.ts tests/unit/workflow/source-packet.test.ts tests/unit/workflow/schedule.test.ts
```

Result: exit 0; 11 test files passed, 249 tests passed.

Full manual workflow integration suite:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts
```

The first full run exposed a test-fixture compatibility regression: the restore helper added an empty workflow payload to research Items that had no workflow, causing 12 stage-schema failures. After preserving workflow absence on restore, a second run exposed 3 remaining failures. Root-cause tracing found that passing the two-argument boundary helper directly to `Array.map` treated each item index as the `ensureWorkflow` flag. Replacing that function reference with a one-argument wrapper fixed the actual callback-arity defect. After the review-driven regressions and fixes, the fresh final run exited 0; all 69 tests passed. Runs emitted existing third-party missing-sourcemap warnings only.

Static verification:

```sh
npm run check
npm run build
git diff --check
```

Results: all exited 0; `tsc --noEmit` passed, Vite built 53 modules, and the diff contained no whitespace errors.

### Files changed

- `src/workflow/run-editorial-pipeline.ts`
- `src/workflow/types.ts`
- `tests/integration/workflow/manual-run.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Commit

Planned message: `fix: normalize legacy workflow checkpoints`. The resulting SHA is recorded in the task handoff.

### Self-review

- Completed `collect`, item-stage, synthesis, and validation checkpoint outputs pass through one idempotent in-memory normalization boundary after their original stage schema parses. A reserved version inside the strict workflow payload marks the completed boundary so resumed collect Items are not decoded again by the normalize stage. Provider-controlled top-level metadata cannot spoof it, and aggregate Items are trusted only when their representative and every nested development Item carry the validated marker. The separate normalize-artifact read used for composition passes through the same boundary.
- Restored clustered and shortlisted Items also normalize the known nested `workflow.development.items` and `representativeItem` boundaries, plus the development title and display-only source names, before synthesis consumes them.
- Historical checkpoint artifacts are not rewritten. The resume regression asserts the stored legacy normalize artifact still contains its original raw metadata while the new assessment artifact and model packet are normalized.
- Restore normalization preserves the absence of a workflow payload for non-production fixture/custom Items. Collected stored Items still request a workflow payload at the normal collection-to-normalization boundary, preserving Round 3 behavior.
- The compact research payload prefers normalized Item metadata matches when that array exists; otherwise it normalizes and retains the legacy workflow candidate's preferred-institution matches. The regression uses an actual fix-base shape with no injected metadata copy and verifies the surviving single match produces a `0.65` research signal during scoring.
- Authors, institutions, provider topics, and preferred-institution matches are normalized, empty-filtered, stable first-occurrence deduplicated, and capped using `MAX_PROVIDER_ARRAY_ITEMS`. The oversized regression verifies exactly the first 64 entries survive in order.
- Only the known `metadata.provenance[].sourceName` display field is normalized. Entity-like structural source ID and percent-encoded URL, plus role, access level, retrieval date, and corroboration flag, remain byte-for-byte unchanged.
- The checkpoint boundary covers both fixture and D1-backed checkpoint implementations through their shared orchestration path and revalidates normalized results against the original stage schema.
- Round 3 Polymarket and detailed NFKC/extractor behavior is unchanged and remains covered by the affected suites.
- No historical database rows, deployment, canary, migration, history, or unrelated OAuth code was changed.

### Concerns

- The final reviewer follow-up did not return within its bounded interval and was stopped. The reviewer-raised marker collision is covered by a tightened red/green regression, and the fresh affected, integration, typecheck, build, and diff checks all pass. Worker runs emit existing third-party missing-sourcemap warnings.

## Whole-plan Fix Round 5

Round 5 replaces Item-owned normalization trust with an orchestration-owned checkpoint envelope. Legacy artifacts remain readable without a migration, fresh provider Items cannot authorize a normalization bypass, and current artifact graphs—including workflow-less nested development Items—are restored byte-stably without another decode.

### RED evidence

Four required regressions were added before production changes and run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "ignores a fresh Item's spoofed|trusts a current synthesis envelope|promotes a legacy checkpoint graph|marks normalized checkpoints"
```

Result: exit 1; all four tests failed for their intended reasons:

- a fresh schema-valid Item carrying the Round 4 workflow marker bypassed normalization and retained triple-encoded title, source name, and evidence;
- a current-version synthesis artifact was decoded again because the checkpoint envelope was ignored, changing workflow-less nested display text;
- the first downstream checkpoint written from a legacy restored graph had no trusted envelope version;
- the normalize checkpoint had no current marker, although the raw collect checkpoint correctly had none.

### GREEN evidence

The same focused command exited 0 with all 4 tests passing. The combined Round 4 and Round 5 boundary command exited 0 with all 9 tests passing.

Affected unit suites:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts tests/unit/editorial/normalize.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/editorial/research-triage.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/research-collector.test.ts tests/unit/sources/news-collector.test.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/pipeline.test.ts tests/unit/workflow/source-packet.test.ts tests/unit/workflow/schedule.test.ts
```

Result: exit 0; 11 test files passed, 249 tests passed.

Full manual workflow integration suite:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts
```

Result: exit 0; all 73 tests passed. The run emitted existing third-party missing-sourcemap warnings only.

Static verification:

```sh
npm run check
npm run build
git diff --check
```

Results: all exited 0 after correcting three test-only concrete-store annotations; `tsc --noEmit` passed, Vite built 53 modules, and the diff contained no whitespace errors.

### Files changed

- `src/workflow/run-editorial-pipeline.ts`
- `src/workflow/types.ts`
- `tests/integration/workflow/manual-run.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Commit

Planned message: `fix: trust provider normalization checkpoint envelope`. The resulting SHA is recorded in the task handoff.

### Self-review

- `CheckpointArtifact` has one optional, literal-valued provider-text normalization version. Missing values remain valid legacy records; no database column, historical event, or stored artifact is rewritten.
- D1 artifact parsing still rejects unknown or missing base fields, validates the optional version, rejects a normalization marker on `collect`, and requires chunked artifacts to agree on the envelope version before merging.
- Orchestration writes the current envelope only for `normalize` through `validate`. Raw `collect` and non-Item `compose`/`publish` artifacts are never labeled provider-text normalized.
- Restore first parses the original stage schema. A current trusted envelope returns that parsed graph unchanged. A missing legacy envelope normalizes the known Item graph once in memory and revalidates it; the stored legacy artifact remains unchanged.
- The separate normalize-artifact read used by composition consumes the full checkpoint envelope and therefore follows the same current-versus-legacy decision.
- Collect restoration deliberately preserves raw candidates and Items. Fresh entry into the normalize stage always invokes Item normalization, including after a collect retry.
- The old workflow marker remains schema-compatible only as inert legacy data. `workflowPayload` removes it whenever a workflow is rebuilt, and no code consults it for trust or bypass decisions.
- Envelope-level idempotence preserves workflow absence in fixture/custom Items and nested development Items. Current synthesis restoration is tested twice and remains byte-stable.
- A legacy normalize artifact is tested across two resumes: the first downstream artifact receives the current envelope, the historical artifact retains its original bytes, and restoring the new artifact does not decode again.
- Round 3/4 compaction, preferred-institution fallback, array bounds, provenance display-only normalization, and nested development traversal remain covered by the combined regressions and full suite.
- No deployment, canary, database migration, history rewrite, or unrelated source change was performed.

### Concerns

- None. Worker runs emit existing third-party missing-sourcemap warnings.

## Whole-plan Fix Round 11

Round 11 removes a second provider-text boundary from legacy clustered and
shortlisted development restoration. Rebuilt aggregate roots are now mapped
only from the already-normalized canonical development and representative, so
their display text, evidence, sources, derived section, score, and routing stay
aligned. No deployment, migration, historical rewrite, or unrelated change was
made.

### RED evidence

The cluster and shortlist regressions use a triple-layer title that becomes the
literal Technology keyword `software` only if the aggregate root is normalized
twice, plus similarly layered evidence and source display names:

```sh
npm run test:worker -- tests/integration/workflow/manual-run.test.ts -t "through exactly one text boundary"
```

The initial sandboxed run could not bind the Worker test port (`EPERM`). After
the required localhost permission was granted, the command exited 1 with both
regressions failing. In each case the canonical nested development retained
`World agency reviews &#115;oftware safeguards` and routed `world`, while the
aggregate root became `World agency reviews software safeguards` and routed
`technology`.

### Implementation

- Added `storedItemFromNormalizedDevelopment`, a schema-only mapper for an
  already-normalized development. It copies the representative's structural
  Item fields, maps canonical development ID/document/title/evidence/sources,
  and assigns representative tags plus development topic/section without any
  entity decoding, NFKC, or provider-text normalization.
- Legacy development refresh now normalizes each nested Item once, rebuilds the
  canonical development, and uses that mapper directly. It no longer passes
  the assembled aggregate root back through `normalizedStoredItem`.
- Stored aggregate workflow state is retained for score replay and shortlist
  state, while canonical representative metadata replaces stale item-derived
  fields. Development scoring is recomputed from the rebuilt development and
  shortlist routing remains aligned with its primary section.
- Audited the other development/root construction path and replaced its
  duplicate constructor with the same schema-only mapper. The sole
  `developmentFromItems` caller remains legacy restoration; both fresh and
  restored root construction are now no-decode mappings.

### GREEN evidence

Final focused cluster/shortlist command:

```sh
npm run test:worker -- tests/integration/workflow/manual-run.test.ts -t "through exactly one text boundary"
```

Result: exit 0; both targeted regressions passed. They assert the entire rebuilt
development equals a fresh canonical development, root title/text/source refs/
tags/topic/section match the canonical development and representative, the
inert entity references remain, the development score is freshly replayed, no
false Technology route occurs, and a subsequent current-envelope restore is
byte-stable.

Affected source/editorial/workflow suites:

```sh
npx vitest run tests/unit/editorial tests/unit/workflow tests/unit/sources
```

Result: exit 0; 21 files and 517 tests passed.

Full Worker suite:

```sh
npm run test:worker
```

Result: exit 0; 11 files and 220 tests passed. It emitted only the existing
third-party missing-sourcemap warnings.

Remaining non-Worker suite excluding the unrelated managed-OAuth fixture:

```sh
npx vitest run --exclude tests/unit/config/preview-e2e-managed-oauth.test.ts
```

Result: exit 0; 39 files and 746 tests passed.

Static, evaluation, build, and diff verification:

```sh
npm run check
npm run evaluate
npm run build
git diff --check
```

Results: all exited 0. TypeScript passed, every golden relevance/identity/
routing/grounding check passed, Vite built 53 modules, and the diff contained
no whitespace errors.

### Files changed

- `src/workflow/run-editorial-pipeline.ts`
- `tests/integration/workflow/manual-run.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Self-review

- The mapper performs only object construction and `ItemSchema.parse`; it has
  no normalization helper call and does not recursively rewrite metadata.
- Aggregate title, normalized text, source references, tags, primary topic,
  primary section, and section eligibility all come directly from the rebuilt
  development or its representative. Top-level URL/access/time/provenance
  structure comes from that representative.
- The regression's expected once-normalized strings are literal, and the title
  is deliberately routing-sensitive: a hidden second decode necessarily turns
  `&#115;oftware` into `software` and changes `world` to `technology`.
- Both missing-envelope entry stages are covered. The second restore uses the
  trusted current artifact envelope and compares the entire root byte-for-byte
  to the once-restored value.
- Existing development score components are replayed rather than trusted from
  the stale aggregate. Structural source IDs, URLs, roles, dates, access, and
  canonical document values are not decoded.

### Concerns

- None. Worker runs emit existing third-party missing-sourcemap warnings.

## Whole-plan Fix Round 10

Round 10 closes the remaining stored-Item, legacy development aggregate,
source-packet structural text, and legacy tag gaps. It retains the Round 7–9
single provider-text decode boundary and makes no deployment, database
migration, history rewrite, or unrelated OAuth change.

### RED evidence

The direct stored-Item sibling regression was first run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "isolates an entity-only stored Item"
```

Result: exit 1; the entity-only Item title became an empty string inside
`normalizedStoredItem` and raised a generic Zod minimum-length error, aborting
its valid sibling rather than reaching the typed candidate rejection path.

The missing-envelope normalize checkpoint regression was first run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "drops only an entity-empty Item from a legacy normalize checkpoint"
```

Result: exit 1; checkpoint graph restoration aborted on the first invalid Item
instead of retaining the schema-valid sibling.

The corrected stage-valid cluster and shortlist fixtures were first run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "rebuilds a stale legacy.*development"
```

Result: exit 1; both fixtures failed with the same empty-title Zod error before
they could remove the invalid representative. The fixtures contain stale but
schema-valid aggregate title, entities, event families, material facts,
event-instance, primary section, editorial signals, development key, and facts
fingerprint values.

The legacy research/news checkpoint regression was extended with encoded stale
Item tags. It failed because research retained `research` and
`stale&#45;topic` rather than the fresh normalized configured-topic tags; the
news fixture similarly retained its stale section literal.

The packet fallback matrix was first run with:

```sh
npx vitest run tests/unit/workflow/source-packet.test.ts
```

Result: exit 1; NUL and C1-only commentary were treated as nonempty evidence.
The line-separator and lone-surrogate cases already fell through because trim
or code-point truncation emptied them, and remain explicit regression cases.

### Implementation

- Added a required stored-title helper that uses the existing bounded provider
  normalization and throws only `InvalidPreparedCandidateTextError` when the
  normalized title is empty. Direct normalize catches this typed error, keeps
  valid siblings, and records `quality_rejected` when discovery lineage exists.
  Other Zod, URL, and structural failures still propagate.
- Legacy checkpoint array restoration now flat-maps only the typed invalid-text
  case for Item, synthesize, and validate graphs. Empty or invalid unrelated
  structures are not swallowed.
- Exposed `developmentFromItems`, a minimal schema-validated wrapper around the
  existing deterministic fresh cluster aggregate builder. It does not decide
  membership and performs no provider-text transformation. Legacy development
  restoration normalizes and filters nested Items, drops the aggregate if none
  survive, deterministically reselects the representative, and rebuilds every
  aggregate-consumed field through this canonical path.
- Rebuilt aggregate Items use the surviving representative's structural
  source/access/provenance values and the development's derived ID, document,
  title, section, sources, and evidence. Existing score components are replayed
  through `scoreNewsDevelopment`, and existing shortlist section routing is
  aligned with the rebuilt primary section.
- Editorial-signal fallback now deduplicates and sorts primary document URLs,
  matching fresh normalization when both singular and plural metadata carry
  the same structural URL.
- Legacy research tags are rebuilt from configured topics. Legacy news tags are
  rebuilt from refreshed section eligibility and primary section. Unverifiable
  legacy `metadata.tags` is omitted rather than entity-decoded, so stale literal
  topic/section tags cannot survive the refresh.
- Added a no-decode packet-text sanitizer. Each fallback candidate is scalar-
  safe truncated, rejected if it contains C0/C1 controls or U+2028/U+2029,
  whitespace-normalized, and independently bounded. Commentary evidence falls
  back to normalized Item evidence, then title; source titles and development
  excerpts use the same structural rules.

### GREEN evidence

Affected source/editorial/workflow suites:

```sh
npx vitest run tests/unit/editorial tests/unit/workflow tests/unit/sources
```

Result: exit 0; 21 files and 517 tests passed.

The complete manual workflow suite passed all 83 tests, including both legacy
cluster/shortlist restoration variants. The final full Worker run was:

```sh
npm run test:worker
```

Result: exit 0; 11 files and 220 tests passed. It emitted only the existing
third-party missing-sourcemap warnings.

Remaining non-Worker suite excluding the unrelated managed-OAuth fixture:

```sh
npx vitest run --exclude tests/unit/config/preview-e2e-managed-oauth.test.ts
```

Result: exit 0; 39 files and 746 tests passed.

Static, evaluation, build, and diff verification:

```sh
npm run check
npm run evaluate
npm run build
git diff --check
```

Results: all exited 0. TypeScript passed, the golden evaluation passed every
relevance/identity/routing/grounding check, Vite built 53 modules, and the diff
contained no whitespace errors.

### Files changed

- `src/editorial/cluster.ts`
- `src/editorial/editorial-signals.ts`
- `src/workflow/run-editorial-pipeline.ts`
- `src/workflow/source-packet.ts`
- `tests/integration/workflow/manual-run.test.ts`
- `tests/unit/workflow/source-packet.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Self-review

- The aggregate wrapper calls the private fresh aggregate builder directly;
  it cannot drift on named entities, event families, facts, event instance,
  repeatability, keys, fingerprints, signals, source evidence, dates, or count
  derivation. Its input is Item-schema validated and nonempty before rebuild.
- Invalid nested Items are caught only by the dedicated required-text error.
  The representative is selected from surviving normalized Items; an empty
  development raises that same typed error so only that top-level aggregate is
  omitted.
- The cluster and shortlist regressions compare the entire rebuilt development
  to a fresh `clusterNews` result, not a hand-selected subset, and assert the
  root ID/title/topic/tags plus absence of encoded stale literals.
- Packet sanitization never calls the entity decoder. It applies the same
  forbidden structural ranges as `SourcePacketSchema` before independent
  fallback selection and code-point-safe bounds.
- Current normalization envelopes still bypass legacy refresh. Structural
  nested Item URLs, source IDs, dates, roles, access levels, and provenance are
  not decoded or rewritten.

### Concerns

- The managed-OAuth fixture remains outside the requested non-OAuth
  verification boundary and no OAuth file was touched.
- Worker runs emit existing third-party missing-sourcemap warnings.

## Whole-plan Fix Round 9

Round 9 makes provider-text normalization fail open per candidate, refreshes
stale derived state only when restoring legacy Item checkpoints without a
normalization envelope, and restores the intended source-packet evidence
fallback order. No database migration, deployment, history rewrite, or
unrelated OAuth change was made.

### RED evidence

The GDELT and research sibling-isolation regressions were first run with:

```sh
npx vitest run tests/unit/sources/news-collector.test.ts tests/unit/sources/research-collector.test.ts
```

Result: exit 1; 2 intended failures and 103 surrounding passes. GDELT retained
the entity-only title as an empty candidate, while final research preparation
threw and aborted the successful lane rather than retaining its valid sibling.

The production custom/legacy normalization regression was first run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "isolates an empty prepared title"
```

Result: exit 1; the entity-only title caused the production collect stage to
throw a Zod minimum-length error. The same regression also requires a malformed
structural URL to continue throwing and now verifies the lane's
`quality_rejected` diagnostic.

The source-packet fallback regressions were first run with:

```sh
npx vitest run tests/unit/workflow/source-packet.test.ts
```

Result: exit 1; 2 intended failures and 1 surrounding pass. Both an empty
commentary excerpt and a lone low surrogate skipped normalized evidence and
fell directly back to the title.

The legacy checkpoint regression was extended with stale research fingerprints
and stale research/news signal fields, then run against the real pipeline
restoration path. It failed because the stale fingerprints survived into the
assessment cache key and stale literal entity signal values survived
restoration. The news expectations compare routing fields, editorial signals,
and clustering against a fresh normalized Item.

### Implementation

- Added `InvalidPreparedCandidateTextError` as the sole catchable signal for a
  title that becomes unusable after provider-text preparation. GDELT, research
  collection, production collection, and the raw normalization loop omit only
  that candidate; unrelated schema, URL, and infrastructure errors still
  propagate. Valid siblings continue through the lane/stage.
- Production discovery diagnostics now own `quality_rejected` at normalize and
  count rejected custom candidates when lineage is available. Research
  collection records the same reason against each affected discovery lane.
- Scoped derived-state refresh to legacy checkpoint restoration when the
  provider-text normalization envelope is absent. It deletes stored research
  content/evidence fingerprints, recomputes the normalized title and research
  topic identity, invalidates research news-signal arrays, derives news
  classification/entities/events/facts from the once-normalized title and
  evidence, and reconstructs editorial signal records from the refreshed Item.
  Current in-memory Items and current envelopes retain their existing derived
  state, preserving compact checkpoint clustering.
- Structural provenance, access levels, source and canonical URLs, IDs, and
  dates remain unchanged. Generic metadata is not recursively decoded.
- Source packets separately apply code-point-safe truncation to commentary and
  Item evidence. Empty/whitespace/surrogate-only commentary falls back to
  bounded `normalizedText`, then to the title only if that evidence is also
  empty.

### GREEN evidence

Affected unit/editorial/workflow suites:

```sh
npx vitest run tests/unit/sources tests/unit/editorial tests/unit/workflow
```

Result: exit 0; 21 files and 514 tests passed.

Full Worker suite:

```sh
npm run test:worker
```

Result: exit 0; 11 files and 216 tests passed. The run emitted only the existing
third-party missing-sourcemap warnings.

Remaining non-Worker suite excluding the unrelated managed-OAuth fixture:

```sh
npx vitest run --exclude tests/unit/config/preview-e2e-managed-oauth.test.ts
```

Result: exit 0; 39 files and 743 tests passed.

Static, evaluation, build, and diff verification:

```sh
npm run check
npm run evaluate
npm run build
git diff --check
```

Results: all exited 0. TypeScript passed, the golden evaluation passed every
relevance/identity/routing/grounding check, Vite built 53 modules, and the diff
contained no whitespace errors.

### Files changed

- `src/editorial/normalize.ts`
- `src/sources/gdelt.ts`
- `src/sources/research-collector.ts`
- `src/sources/types.ts`
- `src/workflow/run-editorial-pipeline.ts`
- `src/workflow/source-packet.ts`
- `tests/integration/workflow/manual-run.test.ts`
- `tests/unit/sources/news-collector.test.ts`
- `tests/unit/sources/research-collector.test.ts`
- `tests/unit/workflow/source-packet.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Self-review

- Catch sites match the dedicated invalid-text class, not generic Zod or
  adapter failures, so structural and infrastructure errors are not hidden.
- The legacy refresh flag is passed only by missing-envelope checkpoint
  restoration, including nested clustered Items. A full Worker regression
  caught and prevented accidental refresh of current in-memory Items.
- Fingerprints are removed before cache identity is requested. The regression
  captures the repository's actual evidence-fingerprint argument and proves it
  equals the refreshed Item's fingerprint rather than the stale literal.
- Research signal arrays are invalidated because Item-only research checkpoints
  do not retain a trustworthy raw abstract/content split. News fields are
  rebuilt from normalized title/evidence plus bounded known section metadata.
- No new entity-decoding pass was added. Derived fields consume the already
  normalized Item strings.

### Concerns

- The repository-wide `npm test` command still has 13 failures confined to the
  pre-existing managed-OAuth fixture. Authorization-server metadata is rejected
  before the mocked registration stage; this round does not touch OAuth code or
  tests. All 743 other non-Worker tests pass.
- Worker runs emit existing third-party missing-sourcemap warnings.

## Whole-plan Fix Round 8

Round 8 closes three post-preparation correctness gaps without changing the Round 7 Symbol or checkpoint-envelope lifecycle: Item identity keys no longer entity-decode prepared display text, legacy author keys are always freshly derived or cleared, and the shared truncator sanitizes malformed UTF-16 throughout its bounded prefix.

### RED evidence

Prepared-title identity and dedup regressions were added and run with:

```sh
npx vitest run tests/unit/editorial/normalize.test.ts tests/unit/editorial/research-identity.test.ts tests/unit/editorial/deduplicate.test.ts
```

Result: exit 1; research identity and news dedup each false-merged an Item whose visible prepared title retained `&#8217;` with an otherwise distinct plain title. The central `normalizedTitle` assertion passed immediately because Round 7 already used a no-decode internal key there.

The legacy checkpoint regression was changed to omit `metadata.authors` while supplying an encoded stale `normalizedAuthors`, then run through the real Worker resume path. Result: exit 1; the stale array survived instead of becoming empty. The regression also constructs two authorless Items from the restored result and proves downstream consolidation must not use that stale identity.

The truncator matrix was run with:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts
```

Result: exit 1; three intended cases failed: a lone low surrogate at the boundary, a lone low surrogate in the interior, and a lone high surrogate at exact input length. Valid pairs, split pairs, zero bound, and bounded inspection characterized the existing correct behavior.

An author-fallback mutation check temporarily restored the old decoding helper and ran the new focused regression. It failed by false-merging the inert third-layer author with the plain author; restoring the prepared helper made the same test pass.

### Implementation

- Added explicit `normalizePreparedTitleKey` and `normalizePreparedAuthorKey` helpers. They preserve the existing NFKC, case, punctuation/symbol, and whitespace key semantics but never entity-decode.
- Central `normalizedTitle` and `normalizedAuthors`, research identity, news title similarity/dedup, exact paper-title comparison, and missing-derived-author fallbacks all use the prepared helpers. The raw-compatible `normalizeTitleKey` and `normalizeAuthorKey` APIs remain available only for genuinely raw callers.
- Legacy restore now assigns `metadata.normalizedAuthors` on every Item. Once-normalized authors produce fresh sorted keys; absent authors produce `[]`, replacing any stale or encoded derived array without decoding it.
- `truncateProviderTextAtCodePointBoundary` now scans at most `maximum` UTF-16 code units, copies ordinary units, copies only complete high+low pairs wholly inside the bound, and drops unpaired high or low surrogates anywhere in the inspected prefix. It performs no entity decode or Unicode normalization and emits no more than the requested number of code units.

### Verification

Focused key and truncator suites: 4 files and 61 tests passed.

Focused Worker legacy/assessment selection: 3 tests passed; 75 unrelated tests were skipped.

Affected source/editorial/workflow suites:

```sh
npx vitest run tests/unit/sources tests/unit/editorial tests/unit/workflow
```

Result: exit 0; 21 files and 510 tests passed.

Full Worker suite:

```sh
npm run test:worker
```

Result: exit 0; 11 files and 215 tests passed, with only existing third-party missing-sourcemap warnings.

Static, evaluation, build, and diff checks:

```sh
npm run check
npm run evaluate
npm run build
git diff --check
```

Results: all exited 0; TypeScript passed, every golden relevance/identity/routing/grounding check passed, Vite built 53 modules, and the diff contained no whitespace errors.

### Self-review

- A repository-wide usage audit leaves raw `normalizeTitleKey`/`normalizeAuthorKey` definitions unused by post-preparation production paths. Every Item identity, title-similarity, dedup, and derived-author consumer uses the no-decode helpers.
- Triple-layer title regressions assert both the visible inert entity and the literal hand-derived key (`interpretability 8217 boundary`), then verify no research or news false merge.
- The author regression removes the normal derived-key field so it exercises the real fallback path; it does not merely assert fresh normalization metadata.
- Legacy tests cover both branches: encoded authors replace a stale key with `legacy author`, while missing authors replace an encoded stale key with `[]` and cannot influence consolidation.
- The surrogate tests cover low surrogates at boundary and interior, high surrogate at exact length, valid and split pairs, maximum zero, the existing 4,000/100,000 assessment boundaries, source-packet/commentary consumers through the Worker suite, and instrumented proof that `charCodeAt` never receives an index at or beyond the maximum.
- Checkpoint envelope fields, preparation Symbol behavior, schemas, publication routing, preferred-institution matching, structural metadata, database state, and deployment scope are unchanged.

### Concerns

- None. Worker runs emit existing third-party missing-sourcemap warnings.

## Whole-plan Fix Round 7

Round 7 makes provider-text preparation an orchestration-owned, normalize-once lifecycle rather than an adapter-by-adapter convention. Raw human text is bounded before collection persistence, decoded at most twice in one preparation boundary, routed only after that preparation, and then mapped to Items without another entity pass. Structural URLs, IDs, dates, roles, access flags, and arbitrary metadata remain untouched.

### RED evidence

Regressions were added before the corresponding production changes. The first focused run was:

```sh
npx vitest run tests/unit/sources/news-collector.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/research-collector.test.ts
```

Result: exit 1; 3 intended failures and 117 surrounding passes. GDELT and RSS triple-encoded text decoded through a third lifecycle pass, and `&#83;tanford` neither normalized nor matched the preferred institution.

The Worker routing regression was then run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "prepares publication text before routing"
```

Result: exit 1; the encoded interpretability publication was dropped because routing ran before provider-text preparation.

Provider-bound and safe-truncation tests initially failed at import time because the undecoded bounding and public code-point-safe truncation helpers did not yet exist. The legacy checkpoint regression was extended to require normalized attached commentary, editorial signal display names, recomputed author identity keys, refreshed configured/primary topics, source-packet evidence, and successful triage while preserving an entity-like arbitrary structural value.

### Implementation

- Added an internal Symbol brand for prepared raw candidates. `prepareRawCandidateForPipeline` performs the sole bounded entity decode for raw display/evidence fields; `normalizePreparedCandidate` maps prepared text without decoding again. The public `normalizeCandidate` composes the two for compatibility.
- Added a distinct `providerTextPreparationVersion` checkpoint envelope valid only on `collect`. Production collection prepares every raw candidate after durable-evidence compaction. Schema clones are rebranded in memory, current collect restores rebrand only when the trusted envelope is present, and legacy collect artifacts remain unbranded so normalize prepares them once. D1 chunk groups must agree on both preparation and normalization versions.
- Publication candidates are prepared before `routePublication`; routing schema clones are rebranded before Item mapping. No provider-controlled metadata or persisted Item field can authorize the bypass.
- RSS, GDELT, Federal Register, Papers with Code, Polymarket, direct-page, publication-page, and article-extractor paths now persist undecoded, NFKC-normalized, post-expansion bounded raw text. Transient decoded copies feed routing/signal derivation only. Explicit persisted limits are title/name 500, evidence/excerpt 4,000, and content 100,000 code units, with surrogate-pair-safe endings.
- Research collection prepares the full candidate before institution aliasing, so encoded Stanford becomes `Stanford`, matches the preferred set, and retains existing scoring semantics without a later decode.
- Legacy Item normalization now covers only known display fields in `attachedCommentary`, `editorialSignals`, provenance, source references, venue, and approved text arrays. It recomputes `normalizedAuthors`, `configuredTopics`, and `primaryTopic` from the once-normalized title/topics/evidence. IDs, URLs, dates, roles, access, and unknown metadata remain unchanged.
- Assessment candidate construction, assessment packets, workflow source packets, and attached-commentary excerpt construction use one shared code-point-safe truncator. It never entity-decodes and cannot retain a lone high or low surrogate at the 4,000 or 100,000 boundaries.

### GREEN evidence

Affected unit/editorial/workflow suites:

```sh
npx vitest run tests/unit/sources tests/unit/editorial tests/unit/workflow
```

Result: exit 0; 21 files and 499 tests passed.

Full Worker suite:

```sh
npm run test:worker
```

Result: exit 0; 11 files and 215 tests passed. The run emitted only the existing third-party missing-sourcemap warnings.

Remaining non-Worker suite excluding the unrelated managed-OAuth fixture:

```sh
npx vitest run --exclude tests/unit/config/preview-e2e-managed-oauth.test.ts
```

Result: exit 0; 39 files and 728 tests passed.

Static, evaluation, build, and diff verification:

```sh
npm run check
npm run evaluate
npm run build
git diff --check
```

Results: all exited 0. TypeScript passed, the golden evaluation passed every relevance/identity/routing/grounding check, Vite built 53 modules, and the diff contained no whitespace errors.

### Self-review

- The preparation brand is non-enumerable and module-private; it disappears from JSON. Only the checkpoint envelope carries lifecycle state across persistence, so candidates and Items do not gain provider-spoofable marker fields.
- Preparation happens after durable evidence policy so decoding cannot cause discarded full bodies to leak into checkpoints. Post-NFKC bounds are applied before raw schemas persist adapter outputs and again at the central custom-candidate boundary.
- Blank-but-present evidence retains fail-closed precedence through a canonical blank prepared value, while absent evidence still falls back to title. Federal Register access classification continues to use raw field presence even when normalized evidence is empty.
- Current prepared collect checkpoints restore byte-stably and never receive the normalized-Item marker. Normalize through validate retain the Round 5 normalized envelope. Legacy artifacts are not rewritten.
- Legacy arrays are normalized once, then reused directly for author keys and topic mapping; derived identity and triage fields do not trigger hidden extra entity passes.
- Structural invariants are explicitly covered for URL query bytes, external IDs, publication dates, and arbitrary metadata. The allowlist does not recurse through generic metadata.
- No database migration, historical rewrite, deployment, canary, or unrelated OAuth implementation change was made.

### Concerns

- The repository-wide `npm test` command has 13 failures confined to the pre-existing `tests/unit/config/preview-e2e-managed-oauth.test.ts` fixture: authorization-server metadata is rejected before the mocked registration stage, and its callback timing assertions consequently fail. This round does not touch OAuth code or tests. All other 728 non-Worker tests, all 215 Worker tests, typecheck, evaluation, build, and diff checks pass.
- Worker runs emit existing third-party missing-sourcemap warnings.

## Whole-plan Fix Round 6

Round 6 closes the scoped review's D1 coverage gap with characterization tests against the real checkpoint parser, audit-event storage, chunk serialization, and chunk merge paths. No implementation defect was found, so production code is unchanged.

### Characterization evidence

Three D1-backed tests were added before any production change and run with:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "rejects a normalized envelope on a D1 collect|rejects D1 checkpoint chunks with inconsistent|round trips a current normalization envelope"
```

Result: exit 0; all 3 tests passed immediately against the Round 5 implementation. This is recorded as immediate-green characterization coverage rather than a fabricated bugfix RED cycle.

The tests exercise these public/storage behaviors:

- `D1PipelineStore.saveCheckpoint` rejects a `collect` artifact carrying `providerTextNormalizationVersion` and persists no checkpoint row;
- two real `workflow_checkpoint` audit rows in one chunk group, one legacy and one current, cause `D1PipelineStore.readArtifact` to reject with `INVALID_CHECKPOINT_CHUNKS:normalize`;
- a 500-item current normalize artifact is split into multiple D1 rows, every row retains version `1`, and `readArtifact` reconstructs the exact artifact including its envelope version.

Mutation rationale: the first test fails if the collect-stage parser guard is removed, the second fails if chunk-version agreement is removed, and the third fails if serialization or chunk merging drops the trusted envelope.

### Verification

Full D1/manual workflow suite:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts
```

Result: exit 0; all 76 tests passed.

Round 4/5 checkpoint-boundary selection: exit 0; all 9 tests passed.

Affected unit suites: exit 0; 11 test files and 249 tests passed.

Static verification:

```sh
npm run check
npm run build
git diff --check
```

Results: all exited 0; `tsc --noEmit` passed, Vite built 53 modules, and the diff contained no whitespace errors.

### Files changed

- `tests/integration/workflow/manual-run.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/whole-plan-fix1-report.md`

### Commit

Planned message: `test: cover D1 normalization checkpoint envelopes`. The resulting SHA is recorded in the task handoff.

### Self-review

- All three regressions use `createD1PipelineStore(env.DB)` and the real D1 audit schema; none use `FixtureStore`, private parser exports, or parser mocks.
- The inconsistent-chunk test inserts only the corrupt external state that the public writer cannot produce, then verifies rejection through the public reader.
- The normal round-trip test proves actual chunking by requiring more than one persisted checkpoint row before asserting exact artifact reconstruction.
- Literal expected version values and exact restored artifacts are derived independently of serializer/parser helpers.
- No production file, schema, deployment, database migration, history, or unrelated test was changed.

### Concerns

- None. Worker runs emit existing third-party missing-sourcemap warnings.
