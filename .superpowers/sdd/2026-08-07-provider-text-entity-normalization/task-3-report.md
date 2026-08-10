# Task 3 — Entity-normalization regression gate

## Final Round 21 pre-commit verification status

**PASS, including independent review.** Round 21 adds one central checkpoint
cross-marker invariant and a genuine D1 matrix for presentation-only shortlist,
synthesize, and validate artifacts. No production display/evidence mapper,
structural field path, database schema, deployment configuration, or historical
row was changed.

### Fresh Round 21 evidence

1. Strict RED/GREEN D1 matrix:

   ```sh
   npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "presentation-only"
   ```

   RED: all 9 selected cases failed—three public writers accepted, three public
   readers returned, and three pipeline resumes advanced past malformed
   presentation-only state. GREEN: all 9 passed, 109 skipped.
2. Valid marker lattice:

   ```sh
   npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "presentation-only|promotes legacy shortlist presentation|promotes legacy synthesize presentation|revalidates and promotes transformed legacy validate presentation|presentation envelope outside|inconsistent presentation envelopes|current presentation envelope through"
   ```

   Result: PASS (15 selected tests; 103 skipped). Normalization-only legacy
   migration, wrong-stage error ordering, mixed-chunk rejection, and both-
   current multi-chunk byte stability remain intact.
3. Affected unit suites: PASS (22 files; 574 tests).
4. Remaining non-Worker suite excluding the unrelated managed-OAuth fixture:
   PASS (40 files; 803 tests).
5. Full `npm run test:worker`: PASS (11 files; 255 tests), with only existing
   third-party missing-sourcemap warnings.
6. `npm run check`: PASS. `npm run evaluate`: PASS (precision@5 `1.00`, minimum
   `0.80`, every assertion passed). `npm run build`: PASS (Vite 7.3.6; 53
   modules). `git diff --check`: PASS.
7. Trusted-HTML and targeted structural provider-normalizer misuse scans: no
   matches.

### Round 21 audit

The only production change is the checkpoint parser in
`src/workflow/run-editorial-pipeline.ts`; the existing whole-plan source audit
therefore remains 23 production paths. Presentation-only state is rejected at
the shared D1 write/read parser before restore or append-only promotion. Fully
legacy, normalization-only, and both-current artifacts retain their existing
semantics. Structural URLs, identifiers, dates, roles, access levels, claim
source IDs, and arbitrary metadata are never transformed by the rejection.

The fresh independent review found no Critical, Important, or Minor issues and
returned `Ready to commit`. No Round 21 commit, deployment, migration, history
rewrite, or historical-row mutation has been performed.

## Final Round 20 pre-commit verification status

**PASS, including independent review** at the final Round 20 worktree. The
review found no Critical, Important, or Minor issues and returned `Ready to
commit`. Per the approved stop point, no Round 20 commit has been created yet.

Fresh sandbox-safe acceptance evidence and the focused unsandboxed Worker/D1
production regressions are green. No fresh gate was blocked by the earlier
usage window; that historical Round 19 event is not claimed as Round 20
evidence.

## Fresh sandbox-safe Round 20 evidence

1. Focused presentation and source-name boundaries:

   ```sh
   npx vitest run tests/unit/editorial/summarize.test.ts tests/unit/editorial/normalize.test.ts tests/unit/workflow/source-packet.test.ts tests/unit/workflow/composition-provider-text.test.ts
   ```

   Result: PASS (4 files; 85 tests). Strict RED evidence for generated/repair
   summary presentation, source-name normalization and packet safety, and
   composition reuse is recorded in the Round 20 engineering report.
2. Affected sandbox-safe suites:

   ```sh
   npx vitest run tests/unit/editorial tests/unit/workflow tests/unit/sources
   ```

   Result: PASS (22 files; 574 tests).
3. Remaining non-Worker suite excluding the unrelated managed-OAuth fixture:

   ```sh
   npx vitest run --exclude tests/unit/config/preview-e2e-managed-oauth.test.ts
   ```

   Result: PASS (40 files; 803 tests).
4. `npm run check` — PASS (`tsc --noEmit`).
5. `npm run evaluate` — PASS (precision@5 `1.00`, minimum `0.80`; every
   relevance, identity, routing, discovery, grounding, and DMV/Baltimore
   assertion passed).
6. `npm run build` — PASS (Vite 7.3.6; 53 modules).
7. `git diff --check` — PASS (no output).
8. Trusted-HTML scan,
   `rg -n "dangerouslySetInnerHTML|innerHTML\\s*=" src` — no matches (exit 1).
9. Targeted provider-normalizer misuse scan against URL, external-ID,
   credential, password, and secret argument names — no matches (exit 1).

## Fresh Worker/D1 Round 20 evidence

The final focused production command was:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "isolates a packet-unsafe current source name|promotes legacy shortlist presentation|promotes legacy synthesize presentation|revalidates and promotes transformed legacy validate presentation|rejects a normalized envelope on a D1 (compose|publish) checkpoint|presentation envelope outside|inconsistent presentation envelopes|current presentation envelope through"
```

Result: PASS (1 Worker file; 9 selected tests passed, 100 skipped). This covers
production per-candidate unsafe source-name isolation, append-only legacy
shortlist/synthesize/validate promotion and retry stability, legacy validate
revalidation, normalization and presentation marker legality, mixed-chunk
rejection, and current multi-chunk byte stability. The run emitted only
existing third-party missing-sourcemap warnings.

The affected full Worker checkpoint suites also passed:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts
```

Result: PASS (2 Worker files; 151 tests). This includes the complete prior D1
checkpoint/resume coverage plus all Round 20 lifecycle regressions.

## Definitive source-path audit

The scoped `main...Round 20 worktree` audit contains 23 changed production source
paths:

- `src/editorial/assess-research.ts`
- `src/editorial/cluster.ts`
- `src/editorial/deduplicate.ts`
- `src/editorial/editorial-signals.ts`
- `src/editorial/normalize.ts`
- `src/editorial/research-identity.ts`
- `src/editorial/route-publication.ts`
- `src/editorial/summarize.ts`
- `src/editorial/summary-provider-text.ts`
- `src/sources/article-extractor.ts`
- `src/sources/gdelt.ts`
- `src/sources/news-collector.ts`
- `src/sources/papers-with-code.ts`
- `src/sources/polymarket.ts`
- `src/sources/provider-text.ts`
- `src/sources/publication-page.ts`
- `src/sources/research-collector.ts`
- `src/sources/rss.ts`
- `src/sources/types.ts`
- `src/workflow/composition-provider-text.ts`
- `src/workflow/run-editorial-pipeline.ts`
- `src/workflow/source-packet.ts`
- `src/workflow/types.ts`

The audit confirms provider normalization remains confined to bounded
display/evidence and versioned workflow-artifact lifecycles. Structural URLs,
identifiers, dates, access levels, citation counts, and credentials retain
their prior paths. Round 20 adds no schema migration, deployment, OAuth,
credential-handling, historical-row mutation, or canary behavior. Presentation
and composition promotion are append-only in the existing audit-event store.

## Remaining acceptance gap

No verification or review gap remains for the Round 20 scoped seams. The
worktree is deliberately uncommitted at the approved pre-commit stop point. A
fresh full `npm test` and unfiltered `npm run test:worker` were not required for
this bounded repair; the final focused and affected Worker/D1 regressions plus
the 803-test non-OAuth gate, affected suites, typecheck, evaluation, build,
diff, and scans provide the recorded acceptance evidence.
