# Task 2 Report: Normalize collected display and evidence text

Status before commit: ready to commit.

## Scope completed

- Added central persistence, RSS, and direct-page regressions for decimal and double-encoded provider text entities.
- Routed provider display and evidence text through `normalizeProviderText` in editorial normalization, RSS collection, publication-page display extraction, article extraction, and direct-page news collection.
- Kept raw whitespace handling for external identifier fallback, JSON-LD URLs, and selected publication dates so those values are not entity-decoded.
- Preserved RSS evidence bounds by passing `MAX_PROVIDER_EVIDENCE_CHARACTERS` to the shared normalizer.

## TDD evidence

RED command:

```sh
npx vitest run tests/unit/editorial/normalize.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/news-collector.test.ts -t "entit|WAMU|provider"
```

Result: exit 1. All three new regressions failed for the expected missing behavior: central title still contained `&#8216;`, the direct-page title still contained `&#8217;`, and RSS title/abstract still contained literal numeric or double-encoded apostrophe references.

GREEN command:

```sh
npx vitest run tests/unit/sources/provider-text.test.ts tests/unit/editorial/normalize.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/news-collector.test.ts
```

Result: exit 0; 4 test files passed, 56 tests passed.

Typecheck command:

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

- `src/editorial/normalize.ts`
- `src/sources/rss.ts`
- `src/sources/publication-page.ts`
- `src/sources/article-extractor.ts`
- `src/sources/news-collector.ts`
- `tests/unit/editorial/normalize.test.ts`
- `tests/unit/sources/publication-collector.test.ts`
- `tests/unit/sources/news-collector.test.ts`
- `.superpowers/sdd/2026-08-07-provider-text-entity-normalization/task-2-report.md`

## Self-review

- Verified the shared helper is only applied to provider text fields, not outbound URLs, external IDs, credentials, metadata keys, or date parsing after date selection.
- Confirmed RSS description retains its existing evidence-length maximum and all focused/adjacent tests remain green.
- Confirmed decoded title, abstract/content-derived material text, and persisted `normalizedText` share the same precedence and decoded representation.

## Concerns

- None. The required Task 1 helper supplies the two-pass, 100,000-character, allowlisted-decoding bounds.

## Commit

Planned message: `fix: normalize provider text before persistence`.

This report is written before the commit as required; the resulting commit SHA is recorded in the task handoff.
