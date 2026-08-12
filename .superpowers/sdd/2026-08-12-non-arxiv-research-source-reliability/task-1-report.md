# Task 1 — Source observation diagnostics

## RED evidence

1. `npx vitest run tests/unit/contracts/editorial.test.ts` initially failed
   **2 of 25 tests** as intended. `DiscoveryLaneDiagnosticSchema` rejected the
   unknown `observed` key, and the outcome enum rejected
   `unsupported_media`.
2. The focused detail-media regression initially failed with an empty failure
   list instead of `[{ sourceId: "example-lab", kind: "unsupported_media" }]`:
   `npx vitest run tests/unit/sources/publication-collector.test.ts -t "does not hide unsupported publication detail media"`.
   This showed that `PublicationPageAdapter` was swallowing the typed media
   error from a fetched detail page.

## Implementation summary

- Added optional bounded `DiscoveryLaneDiagnostic.observed`, preserving
  historical omission and rejecting `discovered > observed` when supplied.
- Added the fixed `unsupported_media` failure/outcome enum value and typed
  `UnsupportedSourceMediaTypeError`. Settlement maps only that type to the new
  kind and continues to expose only sanitized source ID/kind pairs.
- Added transient per-source observations and `settleObservedCollectionBatch`,
  which shares the existing settled, sanitized error path and emits an
  observation only for fulfilled operations.
- RSS now validates permitted XML media types, retains structurally
  interpretable entries observed before window filtering, accepts empty valid
  RSS feeds as zero observations, and preserves observations through mapping.
- Publication page and Papers with Code adapters now expose
  `collectWithStats`; existing `collect` methods remain compatibility wrappers.
  They count only structurally valid, policy-approved rows before filtering,
  validate HTML media types, and cap reported observations at 10,000.
- Publication collection uses successful RSS observations or successful page
  stats for diagnostics, leaving failed lanes without a guessed observation.

## Files changed

- `src/sources/types.ts`
- `src/sources/collection-settlement.ts`
- `src/sources/rss.ts`
- `src/sources/publication-collector.ts`
- `src/sources/publication-page.ts`
- `src/sources/papers-with-code.ts`
- `tests/unit/contracts/editorial.test.ts`
- `tests/unit/sources/publication-collector.test.ts`
- `tests/integration/db/repository.test.ts`
- `.superpowers/sdd/2026-08-12-non-arxiv-research-source-reliability/task-1-report.md`

## Verification

- RED: `npx vitest run tests/unit/contracts/editorial.test.ts` → 1 file,
  25 tests; 2 expected failures for missing `observed` and
  `unsupported_media`.
- RED: `npx vitest run tests/unit/sources/publication-collector.test.ts -t "does not hide unsupported publication detail media"` → 1 expected failure
  before rethrowing the typed error.
- GREEN: `npx vitest run tests/unit/contracts/editorial.test.ts tests/unit/sources/publication-collector.test.ts` → **2 files, 65 tests passed**.
- GREEN: `npx vitest run --config vitest.worker.config.ts tests/integration/db/repository.test.ts` → sandboxed attempt was blocked by managed loopback
  `listen EPERM`; exact approved rerun passed **1 file, 37 tests**.
- `npm run check` → passed (`tsc --noEmit`).
- `git diff --check` → passed.

## Self-review against the brief

- [x] Optional `observed` has the same nonnegative integer/10,000 bound as
  funnel counts; legacy diagnostics still parse; `discovered <= observed` is
  enforced only when observed exists.
- [x] `CollectionSourceObservation` and optional
  `CollectionBatch.sourceObservations` are backward compatible.
- [x] `unsupported_media` is a fixed enum value; only the typed media error
  maps to it. Syntax and Zod errors still map to `parse`.
- [x] Settlement returns source observations only after a fulfilled collection
  and carries no exception text.
- [x] RSS records pre-window structural observations, including healthy
  nonempty out-of-window and empty-feed states; malformed feeds remain parse
  failures; RSS/XML media is explicitly validated.
- [x] Page and Papers with Code stats count structural, policy-approved rows
  before window filtering, preserve `collect` compatibility, and validate HTML
  media for listing and fetched detail bodies.
- [x] Publication diagnostics include successful observations only; failed
  lanes omit them; existing downstream route-exclusion behavior remains
  separate and covered.
- [x] Contract, collector, and repository tests cover all requested states,
  including historical repository round-trip omission.
- [x] No editorial routing/quality threshold changes, migrations (including
  `0011`), deployment/shared database/canary actions, or unsanitized provider
  error details were added.

## Concerns

- The approved Worker integration run emits pre-existing transitive dependency
  sourcemap notices from `htmlparser2` packages. The suite itself passed with
  no test failures.

## Fix round 1 — RSS envelopes without channels

### Review request and evidence

The reviewer requested a regression for an object-form RSS document with no
`channel`, such as `<rss><version>2.0</version></rss>`, asserting that it is a
sanitized `parse` failure rather than a healthy empty feed.

The test was added before any production edit. The current production code
already contained the required guard:

```ts
if (rss !== null && "channel" in rss) {
  return asArray(record(rss.channel)?.item);
}
```

Thus the requested mutation was already rejected: no product RED existed and
no production change was appropriate. The added black-box regression exercised
the real RSS adapter and collector boundary rather than the helper internals.

### GREEN evidence

`npx vitest run tests/unit/sources/publication-collector.test.ts -t "reports an RSS envelope without a channel as parse"`

Result: **1 test passed, 40 skipped**.

### Fix-round files

- `tests/unit/sources/publication-collector.test.ts`
- `.superpowers/sdd/2026-08-12-non-arxiv-research-source-reliability/task-1-report.md`

### Self-review

- [x] The exact malformed envelope now has regression coverage at the public
  collection boundary.
- [x] The regression asserts an observable parse failure and omission of an
  invented observation, not private parsing structure.
- [x] No production edit was made because the reported behavior was already
  correct.
- [x] No editorial thresholds, migrations, deployment/shared DB/canary, or
  diagnostic-sanitization behavior changed.
