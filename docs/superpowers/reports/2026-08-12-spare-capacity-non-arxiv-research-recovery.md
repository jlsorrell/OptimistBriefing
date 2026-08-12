# Spare-Capacity Non-arXiv Research Recovery Report

## Scope

Approved design base: `a2f38f43f2ea90e5f212b7a622e9f3bcb0181051`.

Implementation commits:

- `800cf39fc12f79bdb9209105546bc44ed6acbcb8` — `fix: use spare research assessment capacity`
- `f4ac6cb056441b4bbfe05fc870716a821c843829` — `fix: restore Google Research discovery`

The final tree changes these files relative to `a2f38f4`:

- `docs/superpowers/plans/2026-08-12-spare-capacity-non-arxiv-research-recovery.md`
- `docs/superpowers/reports/2026-08-12-spare-capacity-non-arxiv-research-recovery.md`
- `docs/superpowers/specs/2026-08-12-spare-capacity-non-arxiv-research-recovery-design.md`
- `src/editorial/research-triage.ts`
- `src/sources/reviewed-publication-profiles.ts`
- `src/workflow/run-editorial-pipeline.ts`
- `tests/fixtures/google-research-blog-listing.html`
- `tests/integration/workflow/manual-run.test.ts`
- `tests/unit/editorial/research-triage.test.ts`
- `tests/unit/editorial/shortlist.test.ts`
- `tests/unit/sources/publication-collector.test.ts`
- `tests/unit/sources/reviewed-publication-profiles.test.ts`

Task 3 corrected the relevance-first Worker assertion from six to twelve
selected arXiv candidates. This matches the approved arXiv-specific
publisher-domain cap (12); the RED received 12, not 6, and the corrected test
still requires every assessed candidate to be relevance-qualified.

## RED evidence

Task 1:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts tests/unit/editorial/shortlist.test.ts
```

exited `1`: 2 files, 44 passed / 9 failed. The allowance tests, including
`uses spare capacity after seven normal candidates qualify`, received no
near-matches because `nearMatchAllowance` was ignored; `allows twelve arXiv
candidates from arxiv.org` received six. This proves the obsolete
`min(fallbackTarget - normalCount, maximum - normalCount)` semantics and the
absence of the arXiv family override. The no-reservation shortlist
characterization passed.

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "uses spare capacity after seven normal candidates"
```

first hit sandbox-only `listen EPERM` on `127.0.0.1`; the identical approved
localhost run exited `1`: 1 failed / 136 skipped. `uses spare capacity after
seven normal candidates qualify` expected ten prefiltered candidates and
received six, proving the old sparse-target behavior at the production
assessment boundary.

Task 2:

```bash
npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts -t "Google Research|reviewed lab profile|reviewed list category"
```

exited `1`: 2 files, 4 failed / 80 skipped. The failures were `extracts Google
Research cards while isolating malformed siblings`, `prefers an explicit Google
category and otherwise takes the first reviewed list category`, `does not treat
unrelated list items as Google Research categories`, and `collects current
Google Research list-category entries and skips navigation, product, and
off-policy siblings`. Current list-item cards were dropped because only legacy
explicit category selectors were accepted.

Task 3's first approved full Worker run:

```bash
npm run test:worker
```

exited `1`: 1 failed / 339 passed. `uses relevance-first research triage before
assessment` expected six but received twelve at
`tests/integration/workflow/manual-run.test.ts:7095`. Its 21
relevance-qualified arXiv candidates correctly reach the approved arXiv ceiling
of 12. The test expectation was updated at prefilter, assessment-packet, and
assessed-result boundaries; no production behavior changed.

## GREEN evidence

All Worker commands that require a local listener first ran in the sandbox.
`listen EPERM: operation not permitted 127.0.0.1` was rerun unchanged only with
approved localhost access.

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/editorial/research-triage.test.ts tests/unit/editorial/shortlist.test.ts tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts` | exit `0`; 4 files, 137/137 tests passed (twice, including after correction). |
| `npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "spare capacity|fallback priority|non-ArXiv|reviewed publication"` | sandbox `EPERM`; approved identical run exit `0`; 1 file, 5 passed / 132 skipped. |
| `npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "uses relevance-first research triage before assessment"` | approved run exit `0`; 1 passed / 136 skipped. |
| `npm run test:worker` | sandbox `EPERM`; post-correction approved run exit `0`; 13 files, 340/340 tests passed. |
| `npm test` | sandbox run exit `1`; 46 files passed and the 13 listener-dependent managed-OAuth tests failed after metadata validation because the sandbox denied their `127.0.0.1` callback bind. The identical approved run exited `0`; 47 files, 1056/1056 tests passed. |
| `npm run check` | exit `0`; `tsc --noEmit` had no diagnostics. |
| `npm run evaluate` | exit `0`; precision@5 `1.00` (minimum `0.80`) and every listed assertion passed. |
| `npm run build` | exit `0`; Vite transformed 53 modules and built successfully. |
| `git diff --check a2f38f4..HEAD` and `git diff --check dca0aa36d27720fb9d7e1f2108a7f97ba13e4e1a..HEAD` | both exit `0`; no whitespace errors. |

The sandbox failure's last reported stage was authorization-server metadata
because `authorizePreviewWithManagedOAuth` validates that metadata and then
immediately opens its callback server on `127.0.0.1`, before reporting client
registration. The sandbox-denied bind therefore surfaced as 13 downstream
assertion failures plus one unhandled rejection rather than a raw top-level
`listen EPERM`. The identical approved command proves this is a local-listener
permission boundary, not a functional managed-OAuth failure.

## Mutation evidence

1. The old `nearMatchAllowance - normalCount` formula made `uses spare capacity
   after seven normal candidates qualify` and `admits .* near-matches after`
   fail: the seven-normal case selected no near matches and the 20-normal case
   selected 20 rather than 24. The approved formula was restored and focused
   GREEN rerun.
2. Final review found the original shared-map mutation evidence was not
   load-bearing: clearing both maps still let `preserves legacy normal ordering
   and shared fallback diversity` pass because one spare slot and prior topic
   coverage already chose the same fallback. Separate regressions now leave
   spare queue capacity while exhausting, respectively, a family cap and a
   publisher-domain cap during the normal pass. Clearing the maps before the
   fallback pass made both tests fail by admitting `near-match`; the shared maps
   were restored and focused GREEN rerun.
3. Ignoring the family override made `allows twelve arXiv|keeps every non-arXiv`
   fail because arXiv stopped at six; applying 12 globally made the non-arXiv
   assertion fail by admitting all seven bibliographic candidates. The
   normalized-discovery-family lookup was restored and focused GREEN rerun.
4. Replacing `.glue-card__link-list__item` with `.glue-card__link-list li` made
   `unrelated|reviewed list category` fail by admitting an unrelated list item.
   The exact selector was restored.
5. Returning a list category before an explicit category made `prefers an
   explicit Google category` fail: the legacy row became `Ignored fallback`
   rather than `Research`. Explicit-first behavior was restored and the full
   focused source suite, typecheck, and diff check passed.
6. Removing deterministic exclusion sorting made the reversed-input regression
   fail: forward exclusions were `excluded-b`, `excluded-a` instead of the
   required stable `excluded-a`, `excluded-b`. Sorting was restored.

Fix-round GREEN verification:

- The four-file focused unit/source suite passed 139/139 tests.
- `npm run check` and `git diff --check` exited `0`.
- The final identical approved `npm test` run, now including the two added
  regressions, passed 47 files and 1058/1058 tests. The earlier approved
  1056/1056 result above is the exact rerun that corrected the original
  sandbox-failure diagnosis before the new tests were added.

## Safety and privacy audit

- Production remains `maximum: 24`; the 30/40/48 cap scan returned no matches.
  The allowance is six, and its formula caps normal plus near-match admissions
  at 24.
- The shortlist regression proves no source-family or final-slot reservation:
  a non-arXiv item wins one featured slot only with the higher editorial score
  and loses with the lower score.
- The dynamic/trusted HTML sink scan found no match in `src` or `tests`.
  Google parsing is source-local, exact-selector, explicit-first, and treats
  URLs and dates as structural fields.
- The added-line diagnostics/schema/store scan found no persisted title,
  abstract, normalized text, embedding, or full Papers with Code candidate URL.
  The workflow fixture serializes diagnostics and asserts those values and its
  markers are absent.
- The university-policy scan found no Georgia Tech, Stanford, or Johns Hopkins
  match. Manual complete-diff review found no news path, D1 migration, model
  provider, budget ledger, public config, OAuth, structural URL-normalization,
  or deployment-file change.
- No migration, deployment, push, preview, or production canary was performed.

## Independent review

An initial read-only review verified the production allowance, cap, diagnostics,
and Google parser behavior. Final whole-branch review found no production defect
but identified inaccurate loopback evidence and two non-load-bearing test seams.
Fix round 1 corrected the evidence, added explicit cross-pass cap regressions,
and made reversed-input exclusions observable. Mutation runs above prove each
new assertion detects its targeted break.

## Concerns and follow-up

Correctness concerns for this scoped change: None.

Approved Worker runs emit existing third-party `htmlparser2` missing-source-map
warnings. The full unit suite requires approved local-listener permission in the
restricted sandbox. The exact diagnostic rerun passed 1056/1056 before the two
new regressions; final verification passed 1058/1058.
Georgia Tech, Stanford, and Johns Hopkins endpoint-policy work remains a
separately scoped follow-up; this change deliberately does not alter it.
