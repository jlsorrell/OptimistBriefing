# Task 3 — Entity-normalization regression gate

## Final Round 19 verification status

**PASS** at the final Round 19 worktree. The resulting
commit SHA is recorded in the task handoff after this report is written.

Fresh sandbox-safe acceptance evidence and the focused unsandboxed Worker/D1
production regressions are green. The earlier usage-window rejection happened
before Vitest started and is retained in the Round 19 engineering report only
as historical execution context; it is not final evidence or a current blocker.

## Fresh sandbox-safe Round 19 evidence

1. Strict TDD seam selection:

   ```sh
   npx vitest run tests/unit/workflow/composition-provider-text.test.ts tests/unit/sources/research-collector.test.ts -t "composition provider-text lifecycle|rebrands only a schema-cloned prepared research candidate"
   ```

   Result: PASS (2 files; 3 selected tests, 62 skipped). The rebrand test first
   failed because the helper did not exist; the composition selection first
   failed because the lifecycle module did not exist.
2. Affected sandbox-safe suites:

   ```sh
   npx vitest run tests/unit/editorial tests/unit/workflow tests/unit/sources
   ```

   Result: PASS (22 files; 560 tests).
3. Remaining non-Worker suite excluding the unrelated managed-OAuth fixture:

   ```sh
   npx vitest run --exclude tests/unit/config/preview-e2e-managed-oauth.test.ts
   ```

   Result: PASS (40 files; 789 tests).
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

## Fresh Worker/D1 Round 19 evidence

After the execution window restored, the final focused production command was:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "preserves the ResearchCollector prepared contract through D1 production assembly and restore|promotes a legacy D1 compose before a failed publish and restores it byte-stably|round trips current compose and publish provider-text envelopes through D1|does not promote or publish a legacy D1 compose with an invalid required source name"
```

Result: PASS (1 Worker file; 4 selected D1 tests passed, 96 skipped). This
covers the real ResearchCollector-to-D1 assembly and restore, append-only legacy
compose promotion across a failed publish and fresh retry, current compose and
publish envelope storage/stage legality, and invalid required source-name
isolation. The run emitted only existing third-party missing-sourcemap warnings.

The affected full Worker checkpoint suites also passed:

```sh
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts
```

Result: PASS (2 Worker files; 142 tests). This includes genuine unchunked
legacy-row promotion and newest logical checkpoint-group selection by append
order, plus the pre-existing D1 chunk integrity and resume regressions.

## Definitive source-path audit

The scoped `main...final Round 19` audit contains 21 changed production source
paths:

- `src/editorial/assess-research.ts`
- `src/editorial/cluster.ts`
- `src/editorial/deduplicate.ts`
- `src/editorial/editorial-signals.ts`
- `src/editorial/normalize.ts`
- `src/editorial/research-identity.ts`
- `src/editorial/route-publication.ts`
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
their prior paths. Round 19 adds no schema migration, deployment, OAuth,
credential-handling, historical-row mutation, or canary behavior. Compose
promotion is append-only in the existing audit-event store.

## Remaining acceptance gap

None for the Round 19 scoped seams. A fresh full `npm test` and unfiltered
`npm run test:worker` were not required for this bounded repair; the final
focused and affected Worker/D1 regressions plus the 789-test non-OAuth gate,
affected suites, typecheck, evaluation, and build provide the recorded
acceptance evidence.
