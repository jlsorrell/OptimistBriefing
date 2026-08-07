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
