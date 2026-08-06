# Canary Shortlist and Synthesis Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reserve up to three qualified featured-research slots in the eight-item briefing and expose bounded, idempotent synthesis-rejection codes on Run Status.

**Architecture:** Keep quality selection in `editorial/shortlist.ts`, but change production shortlist assembly so its already-qualified featured research is reserved before the global morning ranking fills remaining capacity. Add a schema-bounded summary-rejection event to the existing D1 audit stream; synthesis records it after a failed repair, and the Run Status detail reader folds sanitized section-qualified codes into `rejectedSummaryReasons`.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers and D1, React, Vitest with `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Preserve topical-fit minimum `0.5` and technical-quality minimum `0.5`.
- Preserve the three-item featured-research maximum and eight-item morning-brief maximum.
- Preserve all source-policy, grounding, coverage, publication, and model-budget gates.
- Do not add a summary fallback, model retry, token-budget increase, migration, or public API shape change.
- Persist no prompt, source excerpt, generated output, credential, URL, title, raw item ID, or unrestricted exception text in rejection diagnostics.
- Use the raw item ID only transiently to derive the collision-safe deterministic audit digest; retain item identity only through the digest-backed key and keep it out of event JSON.
- Preview deployment, a paid canary, and production promotion each remain separately approval-gated.

## File Map

- Modify `src/workflow/run-editorial-pipeline.ts`: reserve featured research, record rejected summaries, and persist D1 audit events.
- Modify `src/workflow/types.ts`: define the bounded rejection-event contract and optional store interface.
- Modify `src/db/d1-repository.ts`: expose sanitized rejection codes in existing run detail.
- Modify `tests/integration/workflow/manual-run.test.ts`: cover shortlist and synthesis behavior.
- Modify `tests/integration/db/repository.test.ts`: cover detail parsing and sanitization.
- Modify `tests/integration/api/preferences.test.ts`: cover authenticated API redaction.

---

### Task 1: Reserve Qualified Featured Research

**Files:**
- Modify: `src/workflow/run-editorial-pipeline.ts:2205-2284`
- Test: `tests/integration/workflow/manual-run.test.ts:3189-3280`

**Interfaces:**
- Consumes: existing `Shortlist.researchFeatured`, `Shortlist.morningBrief`, `Shortlist.researchRadar`, and `SectionBudgets`.
- Produces: unchanged `PipelineContext.shortlist(items): Promise<readonly Item[]>`.

- [ ] **Step 1: Write the failing high-news-score reservation test**

Add a production-context test with four qualifying papers and enough higher-scoring news to fill all eight globally ranked positions. Assert:

```ts
expect(shortlisted).toHaveLength(8);
expect(shortlisted.filter(
  (item) => item.kind === "paper" || item.kind === "blog",
)).toHaveLength(3);
expect(shortlisted.slice(0, 3).map((item) => item.metadata.section))
  .toEqual(["research", "research", "research"]);
expect(new Set(shortlisted.map(({ id }) => id)).size).toBe(8);
```

Run the same clustered input in forward and reverse order and assert identical
selected IDs, proving the existing deterministic score/timestamp/ID ordering is
preserved.

- [ ] **Step 2: Write failing sparse and zero-qualified cases**

Use table-driven zero-, one-, and two-paper cases. The zero case must fail `minimumTechnicalQuality`; the others must pass both quality gates:

```ts
it.each([
  { qualified: 0, expectedResearch: 0 },
  { qualified: 1, expectedResearch: 1 },
  { qualified: 2, expectedResearch: 2 },
])("reserves only $expectedResearch qualified research slots", async ({
  expectedResearch,
}) => {
  const shortlisted = await context.shortlist(clustered);
  expect(shortlisted.filter(isResearchFixture)).toHaveLength(expectedResearch);
  expect(shortlisted.length).toBeLessThanOrEqual(8);
});
```

- [ ] **Step 3: Run focused tests to verify RED**

```bash
npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts -t "reserves qualified featured research|reserves only" --reporter=dot
```

Expected: FAIL because the score-ranked morning brief can consume all eight slots.

- [ ] **Step 4: Implement deterministic reserved-first assembly**

Replace the current `morning`/`radar` assembly inside production `shortlist` with:

```ts
const featured = selected.researchFeatured
  .slice(0, Math.min(budgets.featuredResearch, budgets.morningBrief))
  .map((item) => ({ id: item.id, section: "research" as const }));
const reservedIds = new Set(featured.map(({ id }) => id));
const rankedMorning = selected.morningBrief
  .filter((candidate) => !reservedIds.has(candidate.id))
  .map((candidate) =>
    "representativeItem" in candidate
      ? { id: candidate.id, section: candidate.primarySection }
      : { id: candidate.id, section: "research" as const }
  );
const morning = [...featured, ...rankedMorning]
  .slice(0, budgets.morningBrief);
const morningIds = new Set(morning.map(({ id }) => id));
const radar = selected.researchRadar
  .filter((item) => !morningIds.has(item.id))
  .slice(0, Math.min(
    budgets.researchRadar,
    Math.max(0, budgets.morningBrief - morning.length),
  ))
  .map((item) => ({ id: item.id, section: "research_radar" as const }));
const ordered = [...morning, ...radar].slice(0, budgets.morningBrief);
```

Keep selection reasons, research tiers, diagnostics, compact checkpoints, and hard-stop/degraded radar behavior unchanged.

- [ ] **Step 5: Run focused and adjacent tests to verify GREEN**

```bash
npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts -t "reserves qualified featured research|reserves only|uses bounded preference section budgets|keeps three featured research items" --reporter=dot
npm test -- --run tests/unit/editorial/shortlist.test.ts tests/unit/editorial/pipeline.test.ts
```

Expected: PASS; up to three qualifying papers survive and total output remains at most eight.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/workflow/run-editorial-pipeline.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: reserve featured research in briefing shortlist"
```

---

### Task 2: Persist Bounded, Idempotent Synthesis Rejections

**Files:**
- Modify: `src/workflow/types.ts:130-185`
- Modify: `src/workflow/run-editorial-pipeline.ts:525-735,2286-2316`
- Test: `tests/integration/workflow/manual-run.test.ts:2510-2585`

**Interfaces:**
- Produces: `SummaryRejectionCodeSchema`, digest-only `SummaryRejectionEventSchema`, `SummaryRejectionEvent`, and optional `PipelineStore.recordSummaryRejection(runId, itemId, event): Promise<void>` whose raw `itemId` argument is transient only.
- Consumes: `SummaryRejectedError.errors`, the item section, and existing `audit_events`.

- [ ] **Step 1: Write failing persistence, continuation, and privacy tests**

Use a real `D1PipelineStore` and a provider that rejects one item after repair but accepts the next. Assert the accepted item remains and exactly one audit event exists:

```ts
expect(summaries.map(({ item }) => item.id)).toEqual([acceptedItem.id]);
expect(JSON.parse(events.results[0]!.event_json)).toEqual({
  section: "world",
  errors: expect.arrayContaining(["CLAIM_EVIDENCE_NOT_EXACT"]),
  createdAt: now,
});
```

Assert serialized event text excludes the raw item ID—including URL- and
credential-shaped IDs—the item title, source text, URL, raw provider output,
and a seeded secret marker.

- [ ] **Step 2: Write failing idempotency and bounds tests**

Run synthesis twice for the same run/item and expect one `summary_rejected` row. Directly call the store method with an invalid section, 65 errors, and a 201-character error; each must reject before SQL execution.

Add a fixture store whose `recordSummaryRejection` rejects with
`DIAGNOSTIC_WRITE_FAILED`; assert `context.synthesize` rejects with that error
instead of silently dropping the diagnostic failure.

Add a store without `recordSummaryRejection`; after a `SummaryRejectedError`,
assert synthesis rejects with the bounded constant
`DIAGNOSTIC_STORE_UNAVAILABLE`. Normal non-rejection paths remain unchanged.

- [ ] **Step 3: Run focused tests to verify RED**

```bash
npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts -t "records bounded synthesis rejections|keeps synthesis rejection events idempotent" --reporter=dot
```

Expected: FAIL because synthesis currently discards rejection codes.

- [ ] **Step 4: Add the shared event contract**

In `src/workflow/types.ts` add:

```ts
export const SummaryRejectionCodeSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^(?:SCHEMA_INVALID:[A-Za-z0-9_.-]+|UNKNOWN_SOURCE:[A-Za-z0-9%._~-]+|EMPTY_EVIDENCE:\d+|EVIDENCE_NOT_FOUND:\d+|CLAIM_EVIDENCE_NOT_EXACT|UNGROUNDED_CLAIM:\d+|PRIMARY_RESEARCH_SOURCE_REQUIRED:\d+|ACCESS_LEVEL_OVERCLAIM|UNGROUNDED_PROSE:(?:title|oneSentence|whyItMatters|uncertainty)|EMPTY_UNCERTAINTY|FORECAST_LABEL_MISSING)$/);

export const SummaryRejectionEventSchema = z.object({
  section: EditionSectionSchema,
  errors: z.array(SummaryRejectionCodeSchema).min(1).max(64),
  createdAt: z.string().datetime(),
}).strict();

export type SummaryRejectionEvent = z.infer<
  typeof SummaryRejectionEventSchema
>;
```

Extend `PipelineStore` with optional `recordSummaryRejection(runId, itemId,
event)` so focused in-memory stores remain compatible. The `itemId` parameter
must never become part of `SummaryRejectionEventSchema` or persisted JSON.

- [ ] **Step 5: Implement D1 persistence**

Parse the digest-only payload with `SummaryRejectionEventSchema`, deduplicate and
sort errors, derive a collision-safe SHA-256 key transiently from length-prefixed
run and item IDs, and insert only the digest-backed key and digest-only JSON:

```ts
await this.db.prepare(
  `INSERT OR IGNORE INTO audit_events (
    id, run_id, event_type, event_json, created_at
  ) VALUES (?, ?, 'summary_rejected', ?, ?)`,
).bind(
  await summaryRejectionAuditId(runId, itemId),
  runId,
  JSON.stringify({ ...valid, errors: [...new Set(valid.errors)].sort() }),
  valid.createdAt,
).run();
```

Do not catch D1 errors; diagnostic persistence failure must fail closed. The
raw item ID must not be serialized into or otherwise retained by D1.

- [ ] **Step 6: Record rejection codes from synthesis**

Derive section from shortlisted `metadata.section`, with `research` or `newsSection(item)` fallback for direct-context tests. In the existing catch:

```ts
if (error instanceof SummaryRejectedError) {
  if (options.store.recordSummaryRejection === undefined) {
    throw new Error("DIAGNOSTIC_STORE_UNAVAILABLE");
  }
  await options.store.recordSummaryRejection(options.runId, item.id, {
    section: synthesisSection(item),
    errors: [...new Set(error.errors)].slice(0, 64),
    createdAt: options.now(),
  });
  continue;
}
```

Do not change `summarizeItem`, retries, validation, or model options.

- [ ] **Step 7: Run focused and synthesis tests to verify GREEN**

```bash
npm run test:worker -- --run tests/integration/workflow/manual-run.test.ts -t "records bounded synthesis rejections|keeps synthesis rejection events idempotent|runs paid synthesis calls sequentially|rejects evidence copied from the wrong cited source" --reporter=dot
npm test -- --run tests/unit/editorial/summarize.test.ts tests/unit/workflow/source-packet.test.ts
```

Expected: PASS; rejection is audited, next item proceeds, and only one bounded row exists.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/workflow/types.ts src/workflow/run-editorial-pipeline.ts tests/integration/workflow/manual-run.test.ts
git commit -m "feat: audit bounded synthesis rejections"
```

---

### Task 3: Surface Sanitized Rejection Codes on Run Status

**Files:**
- Modify: `src/db/d1-repository.ts:2200-2350`
- Test: `tests/integration/db/repository.test.ts:1540-1725`
- Test: `tests/integration/api/preferences.test.ts:900-990`

**Interfaces:**
- Consumes: `summary_rejected` JSON validated by `SummaryRejectionEventSchema`.
- Produces: existing `WorkflowRunDetail.rejectedSummaryReasons`; no API/React prop changes.

- [ ] **Step 1: Write failing repository-detail tests**

Insert valid, duplicate, and malformed rejection rows. Assert unique safe codes are section-qualified and malformed/unsafe rows yield the generic label:

```ts
expect((await repo.getWorkflowRunDetail(runId))?.rejectedSummaryReasons)
  .toEqual([
    "REDACTED_REJECTION",
    "world:CLAIM_EVIDENCE_NOT_EXACT",
    "world:UNGROUNDED_PROSE:whyItMatters",
  ]);
```

Also assert no seeded secret appears in serialized detail.

- [ ] **Step 2: Write the failing authenticated API test**

Extend the existing run-detail redaction fixture with digest-only
`summary_rejected`. Assert `/api/runs/:runId` includes the safe code but excludes
raw item identity—including URL- and credential-shaped IDs—title, source text,
URL, raw output, and secret markers.

- [ ] **Step 3: Run focused tests to verify RED**

```bash
npm run test:worker -- --run tests/integration/db/repository.test.ts tests/integration/api/preferences.test.ts -t "summary rejection|redacts private diagnostics" --reporter=dot
```

Expected: FAIL because run detail does not read `summary_rejected`.

- [ ] **Step 4: Parse and sanitize rejection events**

Import `SummaryRejectionEventSchema` beside `PIPELINE_STEPS`, include `summary_rejected` in the audit query, then handle it before checkpoint parsing:

```ts
if (event.event_type === "summary_rejected") {
  const rejection = SummaryRejectionEventSchema.safeParse(parsed);
  if (!rejection.success) {
    rejectedSummaryReasons.push("REDACTED_REJECTION");
    continue;
  }
  rejectedSummaryReasons.push(...rejection.data.errors.map((reason) =>
    publicLabel(
      `${rejection.data.section}:${reason}`,
      "REDACTED_REJECTION",
    )
  ));
  continue;
}
```

Retain checkpoint rejection parsing and final `uniqueStrings` sanitization. Never return `itemId`.

- [ ] **Step 4a: Include rejection events in workflow-artifact retention**

Add `summary_rejected` to both 90-day workflow-artifact count/delete event-type
lists. Extend the workflow-artifact retention integration fixture and assert the
event is included in `deletedWorkflowArtifacts` and absent after pruning.

- [ ] **Step 5: Run repository, API, and UI tests to verify GREEN**

```bash
npm run test:worker -- --run tests/integration/db/repository.test.ts tests/integration/api/preferences.test.ts -t "summary rejection|redacts private diagnostics" --reporter=dot
npm test -- --run tests/unit/web/RunStatusPage.test.tsx
```

Expected: PASS; the existing Run Status list renders the new safe codes without component changes.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/db/d1-repository.ts tests/integration/db/repository.test.ts tests/integration/api/preferences.test.ts
git commit -m "feat: expose sanitized synthesis rejection codes"
```

---

### Task 4: Full Local Verification and Approval Gate

**Files:**
- Verify only; do not deploy or mutate preview/production.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: verification evidence and a deployment-ready local branch.

- [ ] **Step 1: Run static checks**

```bash
npm run check
```

Expected: TypeScript exits `0` with no errors.

- [ ] **Step 2: Run all unit and Worker tests**

```bash
npm test
npm run test:worker
```

Expected: zero failures.

- [ ] **Step 3: Build production assets**

```bash
npm run build
```

Expected: exit `0` with generated assets.

- [ ] **Step 4: Review the complete diff**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short --branch
```

Expected: only approved docs, shortlist logic, bounded diagnostics, and tests differ; worktree is clean.

- [ ] **Step 5: Stop before external changes**

Report exact test counts and changed files. Do not push, open a pull request, deploy preview, start a canary, or modify production without separate approval.
