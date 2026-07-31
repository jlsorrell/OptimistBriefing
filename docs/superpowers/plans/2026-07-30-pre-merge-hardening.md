# Pre-Merge Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the privacy, grounding, resilience, budget, personalization,
and deployment-safety findings that keep the morning briefing pull request from
being merge-ready.

**Architecture:** Preserve the existing Cloudflare Worker, Workflow, D1, React,
and provider boundaries. Introduce small pure boundary functions for durable
evidence and source packets, then route mutable runtime concerns through typed
repository and Workflow adapters. Every behavior change is driven by a focused
negative regression before production code changes.

**Tech Stack:** TypeScript, Cloudflare Workers/Workflows/D1, Hono, Zod, OpenAI
SDK, Vitest, Cloudflare Vitest pool, Playwright.

## Global Constraints

- Copyrighted article bodies may be processed only inside collection and must
  never enter checkpoint JSON, `items.normalized_json`, audit events, or other
  durable storage.
- Durable copyrighted evidence is capped at `2_000` Unicode code points,
  normalized to single whitespace, and remains associated with its source URL.
- Newly normalized candidates default to an expiry exactly 90 days after
  `createdAt`; referenced items remain protected by the existing retention
  query.
- A generated claim is valid only when its exact evidence excerpt occurs in
  every source document named by that claim.
- Source failures expose only a source ID and one of `fetch`, `parse`, `policy`,
  `timeout`, or `unknown`; they never expose raw URLs, response bodies,
  credentials, or provider messages.
- Manual start and resume endpoints return `202` without running the editorial
  pipeline in the HTTP request.
- Recoverable minimum-coverage failures set `retryable: true` and invalidate
  from `collect` on the next attempt.
- The monthly D1 ledger is authoritative. No paid request begins unless an
  atomic conservative reservation fits under `MONTHLY_BUDGET_USD`.
- A refused budget reservation records `BUDGET_HARD_STOP`, makes the run
  retryable, and performs no provider request.
- A run uses one immutable reader-preference snapshot; missing or invalid
  optional preferences fall back to `READER_PROFILE`.
- Production deployment preserves dashboard-managed variables with
  `wrangler deploy --keep-vars`.
- Worker integration tests use compatibility date `2026-07-29`, matching
  `wrangler.jsonc`.
- Do not deploy resources, change DNS, configure Access, run remote migrations,
  or call paid model APIs while executing this plan.

---

## File Responsibility Map

- `src/sources/durable-evidence.ts`: pure conversion from transient source text
  to the bounded durable evidence representation.
- `src/sources/collection-settlement.ts`: pure failure sanitization and
  all-settled source collection helpers.
- `src/workflow/source-packet.ts`: source-specific packet construction for
  model synthesis and grounding.
- `src/workflow/manual-controls.ts`: HTTP-facing adapter for durable Workflow
  create/resume/restart operations.
- `src/models/budget-gate.ts`: request-cost upper bounds and reservation
  lifecycle used by providers.
- `src/db/d1-repository.ts`: D1 persistence for source health, preference
  snapshots, model usage, and budget reservations.
- `src/workflow/run-editorial-pipeline.ts`: editorial sequencing only; it
  consumes the new helpers and runtime snapshots.
- `src/workflow/daily-briefing-workflow.ts`: assembles the durable run context.

### Task 1: Durable Evidence Boundary and Candidate Expiry

**Files:**

- Create: `src/sources/durable-evidence.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `src/editorial/normalize.ts`
- Test: `tests/unit/sources/durable-evidence.test.ts`
- Test: `tests/integration/workflow/manual-run.test.ts`
- Test: `tests/integration/db/repository.test.ts`

**Interfaces:**

- Produces:
  `durableCollectedCandidate<T extends RawItem>(candidate: T): T`
- Produces:
  `candidateExpiry(createdAt: string, configured: unknown): string`
- Consumes: `RawItem`, `RawNewsCandidate`, and the existing normalization and
  checkpoint schemas.

- [ ] **Step 1: Write the durable-evidence unit regressions**

Add tests with a body containing a unique sentinel after code point 2,000:

```ts
const body = `${"evidence ".repeat(260)}COPYRIGHTED_BODY_TAIL`;
const durable = durableCollectedCandidate(rawNewsCandidate({
  abstract: null,
  content: body,
  metadata: { retention: "ephemeral-only" },
}));

expect(durable.content).toBeNull();
expect(durable.abstract).not.toContain("COPYRIGHTED_BODY_TAIL");
expect([...durable.abstract!]).toHaveLength(2_000);
expect(durable.metadata).toMatchObject({
  retention: "ephemeral-only",
  durableEvidence: true,
});
```

Also prove non-ephemeral paper content is unchanged and whitespace is normalized
before the code-point bound is applied.

- [ ] **Step 2: Run the unit regression and observe RED**

Run:
`npm test -- tests/unit/sources/durable-evidence.test.ts`

Expected: FAIL because `src/sources/durable-evidence.ts` does not exist.

- [ ] **Step 3: Implement the pure durable boundary**

Implement:

```ts
export const MAX_DURABLE_EVIDENCE_CODE_POINTS = 2_000;

export function durableCollectedCandidate<T extends RawItem>(candidate: T): T {
  if (candidate.metadata.retention !== "ephemeral-only") return candidate;
  const normalized = (candidate.abstract ?? candidate.content ?? candidate.title)
    .replace(/\s+/gu, " ")
    .trim();
  const excerpt = [...normalized]
    .slice(0, MAX_DURABLE_EVIDENCE_CODE_POINTS)
    .join("");
  return {
    ...candidate,
    abstract: excerpt.length === 0 ? candidate.title : excerpt,
    content: null,
    metadata: { ...candidate.metadata, durableEvidence: true },
  };
}
```

Apply it inside `createProductionPipelineContext().collect` after collector
completion and before `CollectedCandidatesSchema.parse`, so the collect
checkpoint never receives the full body.

- [ ] **Step 4: Verify the unit test is GREEN**

Run:
`npm test -- tests/unit/sources/durable-evidence.test.ts`

Expected: PASS.

- [ ] **Step 5: Write checkpoint and D1 leakage regressions**

In the production-context integration test, collect an ephemeral candidate whose
body includes `COPYRIGHTED_BODY_TAIL`, run through normalization and persistence,
then assert:

```ts
expect(JSON.stringify(store.artifacts.get("run:collect")))
  .not.toContain("COPYRIGHTED_BODY_TAIL");

const row = await env.DB.prepare(
  "SELECT normalized_json, expires_at FROM items WHERE id = ?",
).bind(itemId).first<{ normalized_json: string; expires_at: string }>();

expect(row!.normalized_json).not.toContain("COPYRIGHTED_BODY_TAIL");
expect(row!.expires_at).toBe("2026-10-27T08:30:00.000Z");
```

Add a repository retention assertion that an expired selected item is preserved
while an expired unselected item is removed.

- [ ] **Step 6: Run the integration regressions and observe RED**

Run:
`npm run test:worker -- tests/integration/workflow/manual-run.test.ts tests/integration/db/repository.test.ts`

Expected: FAIL because normalized candidates still default to `expiresAt: null`.

- [ ] **Step 7: Implement deterministic candidate expiry**

In `src/editorial/normalize.ts`, add:

```ts
const CANDIDATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export function candidateExpiry(
  createdAt: string,
  configured: unknown,
): string {
  const explicit = optionalDate(configured);
  const defaultExpiry =
    new Date(Date.parse(createdAt) + CANDIDATE_RETENTION_MS).toISOString();
  return explicit !== null && Date.parse(explicit) < Date.parse(defaultExpiry)
    ? explicit
    : defaultExpiry;
}
```

Use the candidate retrieval timestamp as `createdAt` and call
`candidateExpiry(createdAt, candidate.metadata.expiresAt)` for every normalized
candidate.

- [ ] **Step 8: Verify Task 1**

Run:

```bash
npm test -- tests/unit/sources/durable-evidence.test.ts tests/unit/editorial
npm run test:worker -- tests/integration/workflow/manual-run.test.ts tests/integration/db/repository.test.ts
npm run check
```

Expected: all commands PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/sources/durable-evidence.ts src/workflow/run-editorial-pipeline.ts src/editorial/normalize.ts tests/unit/sources/durable-evidence.test.ts tests/integration/workflow/manual-run.test.ts tests/integration/db/repository.test.ts
git commit -m "fix: keep article bodies out of durable storage"
```

### Task 2: Source-Specific Synthesis and Grounding

**Files:**

- Create: `src/workflow/source-packet.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Test: `tests/unit/workflow/source-packet.test.ts`
- Test: `tests/integration/workflow/manual-run.test.ts`

**Interfaces:**

- Produces: `sourcePacketForItem(item: Item): SourcePacket`
- Consumes: `WorkflowItemPayloadSchema`, `NewsDevelopment`, `Item`, and
  `SourcePacket` from the existing synthesis contracts.

- [ ] **Step 1: Write an adversarial packet regression**

Build a two-item development where source A contains `fact only from A` and
source B contains `different fact from B`. Assert:

```ts
const packet = sourcePacketForItem(clusteredItem);
expect(packet.sources.find(({ sourceId }) => sourceId === "source-a")!.excerpts)
  .toEqual([{ number: 1, text: "fact only from A" }]);
expect(packet.sources.find(({ sourceId }) => sourceId === "source-b")!.excerpts)
  .toEqual([{ number: 1, text: "different fact from B" }]);
```

Also assert source-specific title, URL, access level, role, and retrieval time.

- [ ] **Step 2: Run the packet test and observe RED**

Run:
`npm test -- tests/unit/workflow/source-packet.test.ts`

Expected: FAIL because `sourcePacketForItem` does not exist.

- [ ] **Step 3: Implement packet construction**

For a research item, create a document from the item itself. For a news
development, group `development.items` by each original source reference and
append only that item's bounded `normalizedText` to the matching source:

```ts
const grouped = new Map<string, SourceDocument>();
for (const developmentItem of development.items) {
  for (const source of developmentItem.sourceRefs) {
    const current = grouped.get(source.id);
    const excerpt = {
      number: (current?.excerpts.length ?? 0) + 1,
      text: developmentItem.normalizedText.slice(0, 4_000) ||
        developmentItem.title,
    };
    grouped.set(source.id, {
      sourceId: source.id,
      role: source.role,
      title: developmentItem.title,
      url: source.url,
      retrievedAt: source.retrievedAt,
      accessLevel: developmentItem.accessLevel,
      excerpts: [...(current?.excerpts ?? []), excerpt],
    });
  }
}
```

Sort documents by `sourceId`, cap them at 12, and cap excerpts at four per
source. Replace the private `packet()` call in synthesis with
`sourcePacketForItem()`.

- [ ] **Step 4: Verify packet tests are GREEN**

Run:
`npm test -- tests/unit/workflow/source-packet.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the wrong-source grounding regression**

Use a fake provider that returns a claim with evidence `fact only from A` but
`sourceIds: ["source-b"]`. Run the production context through synthesis and
validation:

```ts
expect(validated).toMatchObject([{
  valid: false,
  validationErrors: expect.arrayContaining(["CLAIM_EVIDENCE_NOT_EXACT"]),
}]);
```

- [ ] **Step 6: Run the integration regression and observe RED**

Run:
`npm run test:worker -- tests/integration/workflow/manual-run.test.ts`

Expected: FAIL because the current aggregate packet lets source B expose source
A evidence.

- [ ] **Step 7: Keep validation source-local**

Update validation lookup so a claim's evidence excerpt must occur in every
source document named by `claim.sourceIds`. Do not fall back to aggregate item
text or another source document.

- [ ] **Step 8: Verify and commit Task 2**

Run:

```bash
npm test -- tests/unit/workflow/source-packet.test.ts tests/unit/synthesis
npm run test:worker -- tests/integration/workflow/manual-run.test.ts
npm run check
```

Expected: all commands PASS.

Commit:

```bash
git add src/workflow/source-packet.ts src/workflow/run-editorial-pipeline.ts tests/unit/workflow/source-packet.test.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: preserve per-source synthesis evidence"
```

### Task 3: Fail-Open Collection and Source Health

**Files:**

- Create: `src/sources/collection-settlement.ts`
- Modify: `src/sources/types.ts`
- Modify: `src/sources/rss.ts`
- Modify: `src/sources/research-collector.ts`
- Modify: `src/sources/news-collector.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/db/d1-repository.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Test: `tests/unit/sources/collection-settlement.test.ts`
- Test: `tests/integration/db/repository.test.ts`
- Test: `tests/integration/workflow/manual-run.test.ts`

**Interfaces:**

- Produces:
  `CollectionFailure = { sourceId: string; kind: CollectionFailureKind }`
- Produces:
  `settleSourceCollections<T>(operations: readonly SourceCollection<T>[]): Promise<{ values: T[]; failures: CollectionFailure[] }>`
- Produces:
  `BriefingRepository.recordSourceOutcome(sourceId, outcome, occurredAt)`
- Consumes: existing source IDs from catalog records; no raw exception text is
  persisted.

- [ ] **Step 1: Write settlement unit regressions**

Test one success and one rejected operation:

```ts
const result = await settleSourceCollections([
  { sourceId: "ap", collect: async () => ["ok"] },
  { sourceId: "reuters", collect: async () => {
    throw new SourceFetchError({
      sourceId: "reuters",
      status: null,
      retryable: true,
      failureKind: "transport",
      reason: "secret URL",
    });
  } },
]);

expect(result.values).toEqual(["ok"]);
expect(result.failures).toEqual([{ sourceId: "reuters", kind: "fetch" }]);
expect(JSON.stringify(result)).not.toContain("secret URL");
```

Add a test that an arbitrary exception maps to `unknown` and a malformed source
ID is replaced by `unknown-source`.

- [ ] **Step 2: Run settlement tests and observe RED**

Run:
`npm test -- tests/unit/sources/collection-settlement.test.ts`

Expected: FAIL because the settlement module does not exist.

- [ ] **Step 3: Implement typed settlement**

Define:

```ts
export const CollectionFailureKindSchema = z.enum([
  "fetch", "parse", "policy", "timeout", "unknown",
]);

export type SourceCollection<T> = {
  sourceId: string;
  collect(): Promise<readonly T[]>;
};
```

Use `Promise.allSettled`, flatten fulfilled values, and map known
`SourceFetchError.failureKind` values to the bounded schema. Never copy
`error.message`.

- [ ] **Step 4: Verify settlement tests are GREEN**

Run:
`npm test -- tests/unit/sources/collection-settlement.test.ts`

Expected: PASS.

- [ ] **Step 5: Write adapter fail-open regressions**

Add:

- an RSS test with one malformed feed and one valid feed;
- a research test with one failed discovery adapter and one successful adapter;
- a research test where one optional enricher fails and prior candidates remain;
  and
- a NewsCollector test where one discovery adapter fails and direct/local
  results remain.

Each collector returns `{ candidates, failures }` through a new
`CollectionBatch<T>` contract:

```ts
export type CollectionBatch<T> = {
  candidates: readonly T[];
  succeededSourceIds: readonly string[];
  failures: readonly CollectionFailure[];
};
```

- [ ] **Step 6: Run adapter tests and observe RED**

Run:
`npm test -- tests/unit/sources`

Expected: FAIL because collectors are still all-or-nothing and return arrays.

- [ ] **Step 7: Implement collector settlement**

Update `SourceAdapter`, `ResearchEnricher`, and `NewsSourceAdapter` orchestration
to settle at the narrowest source boundary. RSS settles each feed separately.
Research settles discovery adapters separately and retains the prior candidate
array if an enricher rejects. News settles direct, discovery, and forecast
adapters independently. Include successful source IDs even when a healthy
source returns zero candidates. Preserve deterministic source/catalog order in
returned candidates, successful IDs, and failures.

- [ ] **Step 8: Add and test source-health persistence**

Extend `BriefingRepository`:

```ts
recordSourceOutcome(
  sourceId: string,
  outcome: "success" | CollectionFailureKind,
  occurredAt: string,
): Promise<void>;
```

Implement success as `health_status = 'healthy'` and
`last_success_at = occurredAt`. Map one failure to `degraded`; preserve
`last_success_at`. Map a repeated failure when the current state is `degraded`
to `failing`.

Run:
`npm run test:worker -- tests/integration/db/repository.test.ts`

Expected after implementation: PASS with assertions for healthy, degraded,
failing, and unknown source rejection.

- [ ] **Step 9: Wire production failures into composition**

In `createD1ProductionPipelineContext`, keep one mutable
`CollectionFailure[]`. After collection, record each success/failure outcome and
append sanitized IDs in the form `${sourceId}:${kind}`. Pass the same mutable
array as `sourceFailures` so composition sees failures accumulated after context
creation.

Add a production-context regression with one failed feed and enough remaining
research, nonlocal, and DMV/Baltimore items. Assert publication continues and
edition metadata contains only the sanitized failure.

- [ ] **Step 10: Verify and commit Task 3**

Run:

```bash
npm test -- tests/unit/sources
npm run test:worker -- tests/integration/db/repository.test.ts tests/integration/workflow/manual-run.test.ts
npm run check
```

Expected: all commands PASS.

Commit:

```bash
git add src/sources src/db/repository.ts src/db/d1-repository.ts src/workflow/run-editorial-pipeline.ts tests/unit/sources tests/integration/db/repository.test.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: isolate source collection failures"
```

### Task 4: Durable Manual Controls and Coverage Recovery

**Files:**

- Create: `src/workflow/manual-controls.ts`
- Modify: `src/worker.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `src/workflow/schedule.ts`
- Test: `tests/integration/api/preferences.test.ts`
- Test: `tests/integration/workflow/manual-run.test.ts`
- Test: `tests/integration/workflow/resume.test.ts`

**Interfaces:**

- Produces:
  `createDurableWorkflowLauncher(db: D1Database, workflow: ScheduledWorkflowBinding): WorkflowLauncher`
- Consumes: the existing `WorkflowLauncher`, `D1PipelineStore`,
  `ScheduledWorkflowBinding`, and `DAILY_BRIEFING` binding.

- [ ] **Step 1: Write manual-start and resume regressions**

Assert manual start:

```ts
const response = await app.request("/api/admin/runs", request);
expect(response.status).toBe(202);
expect(workflow.created).toEqual([{
  id: "2026-07-30",
  params: { editionDate: "2026-07-30", runId: "2026-07-30" },
  retention: { successRetention: "90 days", errorRetention: "90 days" },
}]);
expect(provider.calls).toBe(0);
```

Assert concurrent manual and scheduler starts resolve to one Workflow instance
and one pending D1 run. Assert resume chooses `resume`, `restart`, or `create`
for paused, terminal, or unknown instance state.

- [ ] **Step 2: Run manual-control regressions and observe RED**

Run:
`npm run test:worker -- tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts`

Expected: FAIL because the Worker uses the inline D1 launcher.

- [ ] **Step 3: Implement the durable launcher**

`start()` creates the pending D1 run using `runId = editionDate`, then invokes:

```ts
await workflow.create({
  id: input.editionDate,
  params: { editionDate: input.editionDate, runId: input.editionDate },
  retention: { successRetention: "90 days", errorRetention: "90 days" },
});
```

Map D1 uniqueness or Workflow duplicate-instance errors to
`WorkflowRunAlreadyExistsError`. Record `manual_run_started` with the sanitized
actor email after the durable instance is accepted.

`resume()` loads the D1 run, verifies `retryable`, obtains the Workflow by
`run.editionDate`, and applies the same state transition rules as the scheduler.
It never calls `runEditorialPipeline`.

- [ ] **Step 4: Wire Worker fetch to the durable launcher**

Replace `createD1WorkflowLauncher(env.DB, runtimeFactory)` with
`createDurableWorkflowLauncher(env.DB, env.DAILY_BRIEFING)`. Keep model-provider
construction exclusively inside `DailyBriefingWorkflow.run`.

- [ ] **Step 5: Verify manual-control regressions are GREEN**

Run:
`npm run test:worker -- tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts tests/integration/api/preferences.test.ts`

Expected: PASS.

- [ ] **Step 6: Write failed-coverage recovery regression**

Run a context that first lacks local coverage and returns `failed`, then makes
local content available. Assert:

```ts
expect(first.status).toBe("failed");
expect(context.store.runs.get(runId)).toMatchObject({
  status: "failed",
  retryable: true,
  failureCode: "MINIMUM_COVERAGE_FAILED",
});
await expect(runEditorialPipeline(context)).resolves.toMatchObject({
  status: "published",
});
expect(context.store.invalidatedFrom).toEqual([runId, "collect"]);
```

- [ ] **Step 7: Run recovery test and observe RED**

Run:
`npm run test:worker -- tests/integration/workflow/resume.test.ts`

Expected: FAIL because failed coverage is currently terminal.

- [ ] **Step 8: Implement recoverable coverage**

At pipeline entry, invalidate from `collect` for every non-published run with
`retryable: true`. At finalization set:

```ts
retryable:
  composition.status === "partial" || composition.status === "failed",
failureCode:
  composition.status === "failed" ? "MINIMUM_COVERAGE_FAILED" : null,
```

Keep published runs terminal and preserve the previous published edition until
the recovered edition is atomically published.

- [ ] **Step 9: Verify and commit Task 4**

Run:

```bash
npm run test:worker -- tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts tests/integration/api/preferences.test.ts
npm test -- tests/unit/workflow
npm run check
```

Expected: all commands PASS.

Commit:

```bash
git add src/workflow/manual-controls.ts src/worker.ts src/workflow/run-editorial-pipeline.ts src/workflow/schedule.ts tests/integration/api/preferences.test.ts tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts
git commit -m "fix: route manual runs through durable workflows"
```

### Task 5: Atomic Live Budget Enforcement

**Files:**

- Create: `src/db/migrations/0006_model_budget_reservations.sql`
- Create: `src/models/budget-gate.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/db/d1-repository.ts`
- Modify: `src/models/provider.ts`
- Modify: `src/models/openai-provider.ts`
- Modify: `src/workflow/daily-briefing-workflow.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Test: `tests/unit/models/budget-gate.test.ts`
- Test: `tests/unit/models/openai-provider.test.ts`
- Test: `tests/integration/db/repository.test.ts`
- Test: `tests/integration/workflow/resume.test.ts`

**Interfaces:**

- Produces:
  `ModelBudgetRequest = { model: string; maximumBillableUnits: number }`
- Produces:
  `BudgetReservation = { id: string; maximumCostMicrousd: number }`
- Produces repository methods `reserveModelBudget`, `reconcileModelBudget`, and
  `releaseModelBudget`.
- Consumes configured model unit prices and `MONTHLY_BUDGET_USD`.

- [ ] **Step 1: Write pure request-bound regressions**

Test that generation uses UTF-8 byte length plus `maxOutputTokens`, embedding
uses UTF-8 byte length plus input count, and USD is rounded upward to integer
microdollars:

```ts
expect(maximumGenerationUnits("évidence", 900))
  .toBe(new TextEncoder().encode("évidence").length + 900);
expect(maximumEmbeddingUnits(["one", "two"]))
  .toBe(new TextEncoder().encode("onetwo").length + 2);
expect(maximumCostMicrousd(3, 0.0000004)).toBe(2);
```

These bounds deliberately overestimate tokens.

- [ ] **Step 2: Run bound tests and observe RED**

Run:
`npm test -- tests/unit/models/budget-gate.test.ts`

Expected: FAIL because `budget-gate.ts` does not exist.

- [ ] **Step 3: Implement pure conservative bounds**

Export `maximumGenerationUnits`, `maximumEmbeddingUnits`, and
`maximumCostMicrousd(units, unitPriceUsd)`. Validate finite nonnegative inputs
and use `Math.ceil(units * unitPriceUsd * 1_000_000)`.

- [ ] **Step 4: Verify pure tests are GREEN**

Run:
`npm test -- tests/unit/models/budget-gate.test.ts`

Expected: PASS.

- [ ] **Step 5: Write D1 atomic-reservation regressions**

Migration `0006_model_budget_reservations.sql` creates:

```sql
CREATE TABLE model_budget_reservations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  month_start TEXT NOT NULL,
  maximum_cost_microusd INTEGER NOT NULL CHECK (maximum_cost_microusd >= 0),
  actual_cost_microusd INTEGER CHECK (actual_cost_microusd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'reconciled', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_model_budget_reservations_month
  ON model_budget_reservations (month_start, status);
```

Start two reservations concurrently where only one fits. Assert exactly one
returns a reservation and the sum of reserved plus reconciled cost never exceeds
the limit. Assert reconciliation replaces the maximum with actual cost and
release contributes zero.

- [ ] **Step 6: Run repository tests and observe RED**

Run:
`npm run test:worker -- tests/integration/db/repository.test.ts`

Expected: FAIL because the migration and repository methods do not exist.

- [ ] **Step 7: Implement atomic D1 reservation lifecycle**

Use one conditional `INSERT ... SELECT` statement:

```sql
INSERT INTO model_budget_reservations (
  id, run_id, month_start, maximum_cost_microusd, actual_cost_microusd,
  status, created_at, updated_at
)
SELECT ?, ?, ?, ?, NULL, 'reserved', ?, ?
WHERE (
  SELECT COALESCE(SUM(
    CASE
      WHEN status = 'reserved' THEN maximum_cost_microusd
      WHEN status = 'reconciled' THEN actual_cost_microusd
      ELSE 0
    END
  ), 0)
  FROM model_budget_reservations
  WHERE month_start = ?
) + ? <= ?
```

Return `null` when `meta.changes !== 1`. Reconcile and release only rows owned by
the supplied run ID and currently in `reserved`.

- [ ] **Step 8: Verify repository tests are GREEN**

Run:
`npm run test:worker -- tests/integration/db/repository.test.ts`

Expected: PASS.

- [ ] **Step 9: Write provider authorization regressions**

Extend `OpenAIModelProviderOptions` with:

```ts
authorize?: (request: ModelBudgetRequest) =>
  Promise<BudgetReservation | null>;
reconcile?: (reservation: BudgetReservation, usage: ModelUsage) =>
  Promise<void>;
release?: (reservation: BudgetReservation) => Promise<void>;
```

Assert authorization runs before `fetch`, a `null` reservation throws
`BudgetHardStopError("BUDGET_HARD_STOP")` with zero fetch calls, success
reconciles once, and transport failure releases once.

- [ ] **Step 10: Run provider tests and observe RED**

Run:
`npm test -- tests/unit/models/openai-provider.test.ts`

Expected: FAIL because the provider has no authorization lifecycle.

- [ ] **Step 11: Implement provider reservation lifecycle**

Compute the conservative request before calling the SDK. Authorize once for the
logical provider call, retain the reservation across transport retries,
reconcile after usage is available, and release only when the logical call
terminates without recorded usage.

- [ ] **Step 12: Make paid pipeline stages sequential**

Replace `Promise.all` in assessment and synthesis with ordered loops. Inject the
D1-backed authorization callbacks from
`createBudgetedPipelineRuntimeFactory`. Load live monthly usage before every
reservation; do not reuse the start-of-run `BudgetPolicy` as authorization.

When `BudgetHardStopError` reaches the pipeline, persist a retryable run with
`failureCode: "BUDGET_HARD_STOP"` and rethrow so Workflow retry behavior remains
observable.

- [ ] **Step 13: Verify hard-stop behavior**

Run:

```bash
npm test -- tests/unit/models
npm run test:worker -- tests/integration/db/repository.test.ts tests/integration/workflow/resume.test.ts
npm run check
```

Expected: all commands PASS, including a regression proving zero provider calls
after the rejected reservation.

- [ ] **Step 14: Commit Task 5**

```bash
git add src/db/migrations/0006_model_budget_reservations.sql src/models/budget-gate.ts src/db/repository.ts src/db/d1-repository.ts src/models/provider.ts src/models/openai-provider.ts src/workflow/daily-briefing-workflow.ts src/workflow/run-editorial-pipeline.ts tests/unit/models tests/integration/db/repository.test.ts tests/integration/workflow/resume.test.ts
git commit -m "fix: reserve model spend before provider calls"
```

### Task 6: Preference Snapshots and Selection Reasons

**Files:**

- Modify: `src/workflow/types.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `src/workflow/daily-briefing-workflow.ts`
- Modify: `src/workflow/compose-edition.ts`
- Modify: `src/db/d1-repository.ts`
- Test: `tests/integration/workflow/manual-run.test.ts`
- Test: `tests/integration/workflow/resume.test.ts`

**Interfaces:**

- Produces:
  `D1PipelineStore.readPreferenceSnapshot(runId): Promise<ReaderPreferences | null>`
- Produces:
  `D1PipelineStore.savePreferenceSnapshot(runId, preferences): Promise<void>`
- Adds `preferences: ReaderPreferences` to `ProductionPipelineContextOptions`.
- Consumes `BriefingRepository.getPreferences()` and existing preference
  weights/budgets.

- [ ] **Step 1: Write preference-snapshot regressions**

Start a run with alignment topic weight `2`, mutate stored preferences to `0`
after the collect checkpoint, then resume. Assert the same alignment candidate
remains favored. Start a new run and assert the new weight applies.

Also assert:

```ts
expect(persistedEdition.entries[0]!.selectionReasons)
  .toEqual(shortlistedSelectionReasons);
```

- [ ] **Step 2: Run preference regressions and observe RED**

Run:
`npm run test:worker -- tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts`

Expected: FAIL because production ranking uses only `READER_PROFILE` and
composition substitutes a generic reason.

- [ ] **Step 3: Persist the bounded snapshot**

Store a `preference_snapshot` audit event attached to the run with
`ReaderPreferencesSchema.parse(preferences)`. Read the newest snapshot by run ID.
Audit-event retention already follows the run's 90-day artifact policy.

In `DailyBriefingWorkflow.run`, load the existing snapshot or read current
repository preferences and save one before creating the production context.
Pass the parsed immutable snapshot into the context.

- [ ] **Step 4: Apply the snapshot deterministically**

Adjust research topical relevance by the candidate primary-topic weight and
news personal relevance by the average configured topic and source weights,
clamped to `[0, 1]`. Merge supported `preferences.sectionBudgets` over
`READER_PROFILE.sectionBudgets` after integer bounds validation.

Use source enablement from the catalog as before; do not reinterpret preference
weights as source authorization.

- [ ] **Step 5: Preserve calculated reasons**

In composition, parse `WorkflowItemPayloadSchema` and assign:

```ts
selectionReasons:
  workflow.success && (workflow.data.selectionReasons?.length ?? 0) > 0
    ? [...(workflow.data.selectionReasons ?? [])]
    : ["Selected by the editorial shortlist."],
```

Do not emit the previous generic `Validated for this edition.` string.

- [ ] **Step 6: Verify and commit Task 6**

Run:

```bash
npm run test:worker -- tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts
npm test -- tests/unit/editorial tests/unit/workflow
npm run evaluate
npm run check
```

Expected: all commands PASS and golden evaluation remains at or above its
committed thresholds.

Commit:

```bash
git add src/workflow/types.ts src/workflow/run-editorial-pipeline.ts src/workflow/daily-briefing-workflow.ts src/workflow/compose-edition.ts src/db/d1-repository.ts tests/integration/workflow/manual-run.test.ts tests/integration/workflow/resume.test.ts
git commit -m "fix: apply stable reader preferences to ranking"
```

### Task 7: Deployment and Compatibility Safeguards

**Files:**

- Modify: `package.json`
- Modify: `vitest.worker.config.ts`
- Test: `tests/unit/config/deployment-safety.test.ts`

**Interfaces:**

- Produces no runtime interface.
- Consumes `package.json`, `wrangler.jsonc`, and `vitest.worker.config.ts`.

- [ ] **Step 1: Write configuration parity regressions**

Read the three configuration files and assert:

```ts
expect(packageJson.scripts.deploy)
  .toBe("npm run build && wrangler deploy --keep-vars");
expect(workerCompatibilityDate).toBe(wrangler.compatibility_date);
expect(workerCompatibilityDate).toBe("2026-07-29");
```

Parse the TypeScript configuration with a narrow regular expression for
`compatibilityDate` so the test does not execute Vitest configuration.

- [ ] **Step 2: Run the configuration test and observe RED**

Run:
`npm test -- tests/unit/config/deployment-safety.test.ts`

Expected: FAIL because the deployment script omits `--keep-vars` and the Worker
test date is `2025-09-01`.

- [ ] **Step 3: Apply the exact safe configuration**

Set:

```json
"deploy": "npm run build && wrangler deploy --keep-vars"
```

and:

```ts
compatibilityDate: "2026-07-29",
```

- [ ] **Step 4: Verify Task 7**

Run:

```bash
npm test -- tests/unit/config/deployment-safety.test.ts
npm run test:worker
npm run check
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add package.json vitest.worker.config.ts tests/unit/config/deployment-safety.test.ts
git commit -m "fix: align safe deployment configuration"
```

### Task 8: Whole-Branch Verification and PR Update

**Files:**

- Modify only files required by validated review findings.
- Update: `.superpowers/sdd/2026-07-30-pre-merge-hardening/progress.md`
  (git-ignored execution ledger)

**Interfaces:**

- Consumes all prior task commits.
- Produces a reviewed branch update pushed to pull request `#1`.

- [ ] **Step 1: Run the complete local gate**

Run:

```bash
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
npm run test:e2e
git diff --check origin/main...HEAD
```

Expected:

- TypeScript exits `0`;
- all unit, Worker, and E2E tests pass;
- evaluation precision, ordering, duplicate recall, grounding, and geography
  gates pass;
- production build exits `0`; and
- diff check emits no output.

- [ ] **Step 2: Run leakage scans**

Run:

```bash
git grep -n "COPYRIGHTED_BODY_TAIL" -- src docs/runbooks
git ls-files | rg '(^|/)(\\.dev\\.vars|.*\\.pem|.*\\.key|.*\\.sqlite3?|.*\\.db)$'
```

Expected: neither command reports committed leakage. The sentinel is permitted
only inside test fixtures and assertions, never generated artifacts,
production source, or runbooks.

- [ ] **Step 3: Request independent whole-branch review**

Provide the reviewer:

- base SHA `705b8754e447abbcf570464943ba0fe56342d8e3`;
- final HEAD;
- the approved design;
- this plan;
- task reports and per-task review verdicts; and
- the complete diff package.

Require separate verdicts for spec compliance and code quality. Fix every
Critical and Important finding, then request one scoped re-review.

- [ ] **Step 4: Push the reviewed branch**

```bash
git push origin feature/morning-briefing
```

Expected: the existing pull request updates without force-push.

- [ ] **Step 5: Update pull request status**

Keep PR `#1` as a draft until GitHub CI is green and the final reviewer reports
no Critical or Important findings. Then mark it ready:

```bash
gh pr ready 1
gh pr view 1 --json url,isDraft,state,statusCheckRollup
```

Expected: `isDraft` is `false`, state is `OPEN`, and required checks are
successful. Do not deploy production resources.
