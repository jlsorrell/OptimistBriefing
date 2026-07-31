# SDD ledger — plan: docs/superpowers/plans/2026-07-29-personal-morning-briefing-implementation.md
Task 1: review open — provenance source-ID validation; plan decision required for OpenAI/Zod compatibility and premature test:worker script
Task 1: fix round 1/5 (3 addressed, 0 open — provenance validation; dependency compatibility; Worker test script timing; commits be62679..78bacf0)
Task 1: minor (deferred): npm audit reports five high-severity transitive findings; final review must triage production exposure
Task 1: complete (commits c50d4a3..78bacf0, review clean)
Task 2: fix round 1/5 (2 addressed, 0 open — strict D1 boolean parsing; JSON mutation validation; commits a03a0b9..26bb530)
Task 2: complete (commits a158196..26bb530, review clean)
Task 3: minor (deferred): add production-verifier coverage for expired and bad-signature JWTs; final review must triage
Task 3: fix round 1/5 (1 addressed, 0 open — reject URL userinfo in Access team-domain configuration; commits 166d8a0..d98690e)
Task 3: complete (commits 26bb530..d98690e, review clean)
Task 4: minor (deferred): associate the mobile menu with aria-controls and restore focus after navigation; final review must triage
Task 4: fix round 1/5 (3 addressed, 0 open — runnable authenticated local dashboard stack; qualifying corroboration; header focus contrast; commits bb6ef32..f1659a1)
Task 4: complete (commits d98690e..f1659a1, review clean)
Task 5: minor (deferred): carry full-text retrieval timestamp and final verified URL in provenance; final review must triage
Task 5: minor (deferred): apply OpenAlex author enrichment; final review must triage
Task 5: minor (deferred): broaden HTTP/provider edge-case regression coverage beyond the Important fixes; final review must triage
Task 5: minor (deferred): cancel redirect response bodies even when Location parsing or policy validation throws; final review must triage
Task 5: minor (deferred): document Cloudflare private-network resolution guarantees or strengthen configurable feed-host allowlisting; final review must triage
Task 5: fix round 1/5 (4 addressed, 0 open — outbound URL/redirect trust; revised-paper discovery; canonical identifiers; 304 access-level handling; commits a903756..88a35fa)
Task 5: complete (commits f1659a1..88a35fa, review clean)
Task 6: minor (deferred): compare GDELT and Polymarket timestamps by parsed epoch rather than ISO lexical order; final review must triage
Task 6: minor (deferred): derive UI forecast labeling from entry kind/source role as well as section; final review must triage
Task 6: minor (deferred): audit source-catalog paywall and content-use classifications against source terms before production; final review must triage
Task 6: fix round 1/5 (4 addressed, 2 open — GDELT timestamps; Gamma parsing/status; typed catalog paths; URL authority; extraction completeness; RSS metadata regression; commits c79093e..d6f84bd)
Task 6: fix round 2/5 (2 addressed, 1 open — bounded listing discovery; transport fallback; canonical MTS host policy; commits d6f84bd..ab16607)
Task 6: fix round 3/5 (0 addressed, 1 open — canonical MTS works for fresh DBs but lacks ordered upgrade; commits ab16607..b46bf46)
Task 6: fix round 4/5 (0 addressed, 1 open — ordered MTS upgrade omitted one committed legacy seed variant; commits b46bf46..fb5566f)
Task 6: fix round 5/5 (1 addressed, 0 open — exact d6f84bd MTS legacy variant upgraded safely; commits fb5566f..da00e97)
Task 6: complete (commits 88a35fa..da00e97, review clean)
Task 7: minor (deferred): make normalizeCandidate enforce kind-specific raw candidate invariants including forecast non-corroboration; final review must triage
Task 7: minor (deferred): expand canonical tracking-parameter removal beyond the initial set; final review must triage
Task 7: minor (deferred): replace 32-bit FNV item/cluster IDs with collision-resistant deterministic keys; final review must triage
Task 7: fix round 1/5 (2 addressed, 2 open — development pipeline composition; source signal propagation; topic mapping; component quality gates; commits dc6e80c..73ce55f)
Task 7: fix round 2/5 (1 addressed, 1 open — dedupe signal union and production routing; repeat identity/fingerprint remained source-sensitive; commits 73ce55f..8a3f6ce)
Task 7: fix round 3/5 (0 addressed, 1 open — source-invariant repeat semantics remained insufficiently event-specific; commits 8a3f6ce..c1e1db0)
Task 7: fix round 4/5 (0 addressed, 1 open — event-instance and scoped-fact model still had predicate/fact binding gaps; commits c1e1db0..505df9b)
Task 7: fix round 5/5 (1 addressed, 2 open — legacy unscoped fact rebinding fixed; nested-predicate subject binding and after/before clause fact binding remain Important; commits 505df9b..85c995e)
Task 7: blocked after 5/5 fix rounds — do not build publication pipeline on unresolved repeat-suppression parser; formal reviewer verdict at 85c995e is Needs fixes
Task 7: recovery completed — fail-open clause parser and coordinated material-fact follow-up resolved both blocked defects and subsequent adversarial review findings (commits e06c896..c54654a)
Task 7: complete (commits da00e97..c54654a, review clean; 205/205 unit tests, 44/44 Worker tests, TypeScript check, production build, and diff check passing)
Task 8: contract decision — preserve `summarizeItem(...): Promise<StructuredSummary>`; after one failed repair throw exported `SummaryRejectedError` with readonly machine-readable errors; `SourcePacket` is an exported bounded type shared by synthesis and validation
Task 8: review open — 2 Critical and 5 Important grounding/access/packet-boundary findings; fix round 1/5 dispatched from commit de70476
Task 8: fix round 1/5 (4 addressed, 5 open — access/prose relevance; research access upper bound; query/Unicode packet safety; total repair encoding; commits de70476..de4d731)
Task 8: fix round 2/5 dispatched from commit de4d731
Task 8: fix round 2/5 (3 addressed, 2 open, 1 new Important — prominent grounding contradiction; bare credential markers; over-broad primary access authority; commits de4d731..89b9e51)
Task 8: fix round 3/5 dispatched from commit 89b9e51
Task 8: fix round 3/5 (1 addressed, 2 open — uncertainty provenance/empty evidence; camelCase credential keys; commits 89b9e51..3e78b8e)
Task 8: fix round 4/5 dispatched from commit 3e78b8e
Task 8: fix round 4/5 (2 addressed, 1 open, 1 new Important — nested credential values; extractive/forecast-label conflict; commits 3e78b8e..f65ef7b)
Task 8: fix round 5/5 dispatched from commit f65ef7b
Task 8: fix round 5/5 (2 addressed, 0 open — bounded nested credential inspection; narrow forecast-label grounding exemption; commits f65ef7b..8772b93)
Task 8: complete (commits c54654a..8772b93, review clean; 300/300 unit tests, 44/44 Worker tests, TypeScript check, production build, and diff check passing)
Task 9: review open — 3 Critical and 6 Important pipeline/idempotency/production-binding findings; fix round 1/5 active from commit 58a15b4
Task 9: scope decision — authorize additive `editions.metadata_json`, strict edition metadata contracts, D1 repository read/write support, and directly relevant migration/repository tests so missing sections and source failures persist transactionally
Task 9: fix round 1/5 (6 addressed, 3 open, 1 new Critical — real middle-stage production wiring; step-specific checkpoint validation; D1 recovery/failure coverage; migration default compatibility; commits 58a15b4..3df2637)
Task 9: fix round 2/5 active from commit 3df2637
Task 9: fix round 2/5 (1 addressed, 3 open, 1 new Important — real middle stages; complete compose artifact schema; D1 recovery coverage; exact legacy metadata handling; commits 3df2637..6cc5e94)
Task 9: fix round 3/5 active from commit 6cc5e94
Task 9: fix round 3/5 (0 addressed, 4 open — implementer blocked on in-scope richer artifact rewrite; no code changes)
Task 9: fix round 4/5 assigned to fresh implementer from commit 6cc5e94
Task 9: fix round 4/5 (4 addressed, 0 inherited open, 1 new Important — multi-source item upsert catalog/link collisions; commits 6cc5e94..fbbd4c0)
Task 9: fix round 5/5 active from commit fbbd4c0; scope restricted to D1 multi-source upsert plus regression
Task 9: fix round 5/5 (1 addressed, 0 open — preserve full normalized provenance while deduplicating relational source links without canonical URL collisions; commits fbbd4c0..a12b899)
Task 9: complete (commits 8772b93..a12b899, review clean; 300/300 unit tests, 64/64 Worker tests, TypeScript check, production build, and base-to-HEAD diff check passing)
Task 10: scope decision — authorize `src/api/app.ts` solely to mount the five new Task 10 route modules beneath the existing authenticated `/api/*` middleware
Task 10: review open — 1 Critical, 9 Important, and 3 Minor reader-control/search/redaction findings; fix round 1/5 active from commit abc961f
Task 10: scope decision — additionally authorize existing feedback/card/sidebar components and `src/contracts/api.ts` for persistent UI actions, navigation, and stable source-conflict errors; no migration
Task 10: fix round 1/5 (7 finding groups addressed, 0 open — safe diagnostics; persistent feedback/saves; coherent preference deltas/reset; editable preferences; archive search/filter pagination; strict audited source conflicts; run-status navigation; commits abc961f..b054661)
Task 10: complete (commits a12b899..b054661, review clean; 310/310 unit tests, 83/83 Worker tests, TypeScript check, production build, and base-to-HEAD diff check passing)
Task 11: scope decision — authorize checkpoint-hook/budget changes in the existing pipeline, provider usage metadata, bounded synthesis-token options, and dedicated repository model-usage/retention methods/tests; existing audit/workflow tables are sufficient, so no migration
Task 11: review open — 3 Critical and 4 Important/spec-gap findings in cost-record compatibility, manual budget coverage, hard-stop timing/tokens, step retry boundaries, retention exclusions, budget caps, and every-checkpoint resume coverage; fix round 1/5 active from cc0e3d
Task 11: fix round 1/5 (7 addressed, 1 open, 1 evidence-only — cached radar can bypass tightened budget on retry; coordinator post-fix evidence unavailable in Worker harness; commits cc0e3d..f76795a)
Task 11: fix round 2/5 active from commit f76795a
Task 11: fix round 2/5 (1 addressed, 0 review findings open — current budget is reapplied before paid resumed stages and zero-token calls are suppressed; commit 28ced58)
Task 11: fix round 3/5 active from commit 28ced58 — controller Worker regression found degraded radar selected by rank but discarded by stale pre-ranking tier
Task 11: fix round 3/5 (1 addressed, 0 open — ranked shortlist roles now authoritatively relabel featured/radar items; commit 4071b74)
Task 11: complete (commits b054661..4071b74, review clean; 330/330 unit tests, 104/104 Worker tests, TypeScript check, production build, and base-to-HEAD diff check passing)
Task 12: active from commit 4071b74 — golden-set evaluation, accessibility/mobile coverage, and CI gates dispatched
Task 12: controller browser fix — mobile accessibility/touch-target RED resolved; tablet gate exposed and resolved ReadingProgress duplicate-node, payload-vs-DOM order, overlapping-card, and end-of-document defects (commit 7c7496d)
Task 12: complete (commits 4071b74..7c7496d, review clean; precision@5 1.00, required ordering yes, duplicate recall 1.00, missing supporting source IDs 0; 333/333 unit, 104/104 Worker, 39/39 E2E, TypeScript check, production build, and diff check passing)
Task 13: active from commit 7c7496d — repository-local production configuration, runbooks, migration rehearsal, and launch verification dispatched; external DNS/OAuth/resource/deploy actions explicitly excluded
Task 13: launch-blocker scope expansion — Task 11 pruning removed 90-day workflow runs but left artifact-bearing checkpoint/attempt audit events orphaned indefinitely; authorize explicit 90-day workflow-artifact deletion/reporting with focused TDD while preserving model/source/admin audit history
Task 13: review round 1 (1 Important, 1 Minor addressed — preview D1 migration/fixture path; honest preview Playwright blocker; attributable source audit query; commits 30f1620..21fec08)
Task 13: complete (commits 7c7496d..8a5e360, review clean; five migrations applied once and second run empty; 333/333 unit tests, 104/104 Worker tests, 39/39 E2E tests, evaluation/typecheck/build/Wrangler dry-run/diff check passing; external resource/DNS/OAuth/secret/deploy actions not performed)
Task 13: review round 1 — 1 Important and 1 Minor runbook finding addressed: preview D1 migration/fixed-fixture seed made explicit; local-only Playwright limitation now blocks production until a separate Access-capable preview harness passes; source audit query made attributable (commit 21fec08)
Task 13: complete (commits 7c7496d..21fec08, independent review approved; 333/333 unit, 104/104 Worker, 39/39 E2E, golden metrics passing, TypeScript check, production build, Wrangler assets/Workflow/D1 dry-run, two-pass local migrations, and diff check passing; no external actions performed)
