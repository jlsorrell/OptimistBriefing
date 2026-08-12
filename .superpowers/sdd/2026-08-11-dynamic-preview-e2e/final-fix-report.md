# Dynamic Preview E2E Final Fix Report

## Scope and base

- Worktree: `/Users/jlsor/Documents/Personal/Tools/.worktrees/dynamic-preview-e2e`
- Required base and observed starting HEAD: `7e17d81a5035a7d539afa7113eb6691b0bb6e681`
- Scope: preview tests and the two prescribed Dynamic Preview E2E documents only
- No `src/`, OAuth, Worker/API/DB/migration/Wrangler/deployment, credential, or remote-state changes

## Root cause

`expectRenderedPreviewEdition` extracted every `[data-entry-id]` element's aggregate
`textContent` and used `toContain(entry.summary.title)`. A rendered title with extra
text therefore passed, and title text elsewhere in the card could also satisfy the
check. The entry ID and order assertion was already exact and was preserved.

## TDD evidence

The regression mutation is: keep the API-derived IDs and order unchanged, render the
morning title exactly, and append ` — rendered mismatch` to the research card's
`h3`. The test requires the comparator promise to reject. The root document is
fulfilled by the test before any network request, so this evidence did not use
Managed OAuth or contact the protected preview.

An initial local-integration diagnostic was not counted as RED because it rejected
at the authenticated page-heading gate rather than at title comparison. The final
self-contained fixture isolated the comparator and produced the required RED.

### RED

Command (environment values shown as safe placeholders; the token was synthetic):

```bash
OPTIMIST_PREVIEW_TEMP_DIR=<protected-temp-dir> \
OPTIMIST_PREVIEW_ACCESS_TOKEN=<synthetic-test-token> \
npx playwright test --config playwright.preview.config.ts \
  tests/preview-e2e/content.spec.ts --project desktop \
  --grep "rejects a rendered title"
```

Result: exit 1.

```text
Error: expect(received).rejects.toThrow()
Received promise resolved instead of rejected
Resolved to value: undefined
1 failed
```

This proves the old whole-card containment comparator accepted the mismatched
rendered title.

### GREEN

After the minimal comparator change, the identical focused command returned exit 0:

```text
[desktop] › tests/preview-e2e/content.spec.ts › rejects a rendered title that differs from the API title
1 passed (6.0s)
```

The all-project focused rerun also returned exit 0:

```text
Running 3 tests using 1 worker
3 passed (17.5s)
```

## Code and documentation changes

- `tests/preview-e2e/rendered-edition.ts`
  - Keeps exact entry ID/order comparison.
  - Locates `strong` for every `morning_brief` entry and `h3` for every card-rendered entry.
  - Uses awaited exact `toHaveText(entry.summary.title)` equality on each title element.
- `tests/preview-e2e/content.spec.ts`
  - Adds the deterministic negative routed-page fixture with equal IDs/order and one mismatched card title.
  - Exercises a valid morning `strong` and rejects extra text in a research `h3`.
- `docs/superpowers/specs/2026-08-11-dynamic-preview-e2e-design.md`
  - Requires exact title-element equality and documents the negative fixture.
- `docs/superpowers/plans/2026-08-11-dynamic-preview-e2e.md`
  - Shows the corrected comparator and deterministic rejection test; removes the containment implementation.

## Verification

| Command | Result |
| --- | --- |
| Focused preview mismatch test, desktop RED | expected failure: promise resolved instead of rejected |
| Focused preview mismatch test, desktop GREEN | 1 passed |
| Focused preview mismatch test, desktop/tablet/mobile | 3 passed |
| `npx vitest run tests/unit/config/preview-edition-contract.test.ts tests/unit/config/preview-e2e-safe-reporter.test.ts` | 2 files, 87 tests passed |
| `npm run check` | exit 0 |
| `npm run test:e2e` | 39 passed |
| `git diff --check` | exit 0, no output |

The final `content.spec.ts` length is 289 lines, below the safe reporter's existing
400-line bound; the focused safe-reporter suite passed without changing that bound.

## Self-review

- Exact IDs and section-local ordering remain unchanged and executable.
- Every matching entry receives one exact title assertion on its real title-bearing element.
- `morning_brief` uses `strong`; all remaining canonical sections use `h3`.
- The negative fixture differs only in one rendered title while IDs and order match.
- The old comparator demonstrably passed the mutation; the new comparator rejects it.
- Searches found no remaining `toContain(entry.summary.title)`, aggregate-title
  `textContent`, or “contain the API title” instruction in the scoped test/docs.
- Diff review shows only the four requested test/docs files plus this report.

## Auth-dependent gate not run

`npm run test:e2e:preview` was deliberately not run because it invokes Managed OAuth
and requires protected-preview authorization. Per the task constraint, no OAuth flow
or credential handling was attempted. The self-contained preview-project regression
and full local E2E suite cover the executable fix without weakening authentication;
the controller's already-green authenticated preview acceptance remains the remote
gate.
