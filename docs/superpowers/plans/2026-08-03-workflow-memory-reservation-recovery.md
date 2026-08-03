# Workflow Memory and Reservation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent synthesis memory exhaustion by bounding live checkpoint data and release exact-run model-budget reservations after an exhausted Workflow failure.

**Architecture:** Filter checkpoint rows by requested step in D1, advance editorial item stages through one replaceable live reference, and reload normalized data only when composition needs it. Add an idempotent exact-run reservation cleanup callback to the outer terminal failure path plus a migration for reservations already stranded on non-running runs.

**Tech Stack:** TypeScript, Cloudflare Workers and Workflows, D1/SQLite migrations, Zod, Vitest with `@cloudflare/vitest-pool-workers`, Wrangler.

## Global Constraints

- Preserve all source selection, scoring, shortlist, prompt, model, output-token, grounding, coverage, authentication, publication, and monthly-budget behavior.
- Checkpoint SQL must remain parameterized by run ID, event type, and pipeline step.
- Keep existing chunk validation, ordering, schemas, attempt accounting, retries, persistence, and failure labels for returned target-step records.
- Terminal cleanup may update only `status = 'reserved'` reservations belonging to the exact run ID.
- Never modify reconciled/released reservations or reservations belonging to another run.
- Temporary provider transport retries and temporary Workflow step retries must not trigger run-level cleanup.
- Cleanup failure must never replace or conceal the original pipeline failure.
- Audit records must be bounded and must not contain SQL, provider bodies, reservation IDs, authentication details, or secrets.
- The user accepts a small undercounting risk: exact-run reservations remaining after an exhausted platform failure are released rather than conservatively charged.
- The migration may release `reserved` rows only for owning runs with status `retryable`, `partial`, `failed`, or `published`; it must not affect `pending` or `running` runs.
- Deploy preview with `--keep-vars`; never inspect, replace, or print `OPENAI_API_KEY`.
- Do not start, resume, restart, or replay a canary or any other paid model operation.

---

### Task 1: Filter checkpoint reads by requested step

**Files:**
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Test: `tests/integration/workflow/resume.test.ts`

**Interfaces:**
- Consumes: `D1PipelineStore.readArtifact(runId: string, step: PipelineStep)`.
- Produces: the same `CheckpointArtifact<unknown> | null` contract while D1 returns only valid JSON rows whose `$.step` equals the bound step.

- [ ] **Step 1: Add a failing cross-step isolation regression**

Add this test near the existing D1 checkpoint tests in
`tests/integration/workflow/resume.test.ts`:

```ts
it("does not transfer malformed checkpoint rows from another step", async () => {
  const runId = "step-filtered-checkpoint";
  const store = createD1PipelineStore(env.DB);
  await store.createRun({
    id: runId,
    editionDate: "2036-04-08",
    status: "running",
    currentStep: "shortlist",
    retryable: false,
    attemptCount: 1,
    estimatedCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    failureCode: null,
  });
  const shortlisted = [item("filtered-shortlist", "research")];
  await store.saveCheckpoint(runId, "shortlist", {
    output: shortlisted,
    attempts: 1,
    durationMs: 10,
    itemCount: 1,
    estimatedCostUsd: 0,
  });
  await env.DB.prepare(
    `INSERT INTO audit_events (
      id, run_id, event_type, event_json, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    "malformed-unrelated-checkpoint",
    runId,
    "workflow_checkpoint",
    "{malformed unrelated checkpoint",
    "2036-04-08T09:01:00.000Z",
  ).run();

  await expect(store.readArtifact(runId, "shortlist")).resolves.toMatchObject({
    output: shortlisted,
    itemCount: 1,
  });
});
```

This uses a malformed row with no valid step identity. The target shortlist row
is valid and must remain readable without transferring or parsing the unrelated
record.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
npm run test:worker -- --run tests/integration/workflow/resume.test.ts -t "does not transfer malformed checkpoint rows" --reporter=dot
```

Expected: FAIL with `INVALID_CHECKPOINT_RECORD` because the current query
returns every checkpoint row for the run.

- [ ] **Step 3: Filter checkpoint rows in D1**

In `D1PipelineStore.readArtifact`, replace the broad checkpoint query with:

```ts
const records = await this.db.prepare(
  `SELECT event_json FROM audit_events
   WHERE run_id = ?
     AND event_type = ?
     AND json_valid(event_json) = 1
     AND json_extract(event_json, '$.step') = ?
   ORDER BY created_at DESC, id DESC`,
).bind(
  runId,
  "workflow_checkpoint",
  step,
).all<{ event_json: string }>();
```

Do not change chunk grouping or `parseCheckpointArtifact`. A valid returned row
with an invalid target-step artifact must continue to fail with the existing
`INVALID_CHECKPOINT_ARTIFACT:<step>` or chunk error.

- [ ] **Step 4: Verify GREEN and existing chunk behavior**

Run:

```bash
npm run test:worker -- --run tests/integration/workflow/resume.test.ts -t "does not transfer malformed checkpoint rows|chunks oversized D1 checkpoints|reconstructs chunked" --reporter=dot
```

Expected: all selected tests PASS.

- [ ] **Step 5: Run the focused Worker file and static checks**

Run:

```bash
npm run test:worker -- --run tests/integration/workflow/resume.test.ts --reporter=dot
npm run check
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/run-editorial-pipeline.ts tests/integration/workflow/resume.test.ts
git commit -m "fix: filter workflow checkpoint reads"
```

---

### Task 2: Scope live stage outputs through synthesis

**Files:**
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Test: `tests/integration/workflow/resume.test.ts`
- Test: `tests/integration/workflow/manual-run.test.ts`

**Interfaces:**
- Produces: `collectAndNormalize(context, run): Promise<readonly Item[]>`.
- Produces: `advanceSelectionStages(context, run): Promise<readonly Item[]>` returning only the shortlist.
- Produces: `readCheckpointOutput(context, step, schema): Promise<T>` for schema-validated artifact reload.
- Preserves: `runEditorialPipeline(context): Promise<PipelineResult>` and every public pipeline interface.

- [ ] **Step 1: Track explicit normalized-artifact reloads in the test store**

Extend `ResumeStore` in `tests/integration/workflow/resume.test.ts`:

```ts
readonly artifactReads: PipelineStep[] = [];

async readArtifact(runId: string, step: PipelineStep) {
  this.artifactReads.push(step);
  return this.artifacts.get(`${runId}:${step}`) ?? null;
}
```

Then add:

```ts
it("reloads normalized data only when composition needs it", async () => {
  const context = resumableContext("publish");
  context.checkpointExecutor = async (_step, execute) => execute();

  await runEditorialPipeline(context);

  expect(context.store.artifactReads).toEqual(["normalize"]);
  expect(context.store.runs.get(context.runId)?.currentStep).toBe("publish");
});
```

The fixture store's `readCheckpoint` does not call `readArtifact`, so this list
records only the new explicit composition reload.

- [ ] **Step 2: Run the reload test and verify RED**

Run:

```bash
npm run test:worker -- --run tests/integration/workflow/resume.test.ts -t "reloads normalized data only" --reporter=dot
```

Expected: FAIL because the current pipeline retains the original normalized
array and never explicitly reloads it.

- [ ] **Step 3: Add a schema-validated checkpoint reload helper**

Add near `checkpoint` in `src/workflow/run-editorial-pipeline.ts`:

```ts
async function readCheckpointOutput<T>(
  context: PipelineContext,
  step: PipelineStep,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const artifact = await context.store.readArtifact(context.runId, step);
  if (artifact === null) throw new Error(`MISSING_CHECKPOINT_ARTIFACT:${step}`);
  return schema.parse(artifact.output);
}
```

Use the existing imported `PipelineStep` type or the exact
`(typeof PIPELINE_STEPS)[number]` alias already used by the file; do not create a
second step union.

- [ ] **Step 4: Extract collection and normalization**

Add:

```ts
async function collectAndNormalize(
  context: PipelineContext,
  run: PipelineRun,
): Promise<readonly Item[]> {
  const collected = await checkpoint(
    context,
    run,
    "collect",
    CollectedCandidatesSchema,
    context.collect,
  );
  return checkpoint(
    context,
    run,
    "normalize",
    NormalizedItemsSchema,
    () => context.normalize(collected),
    context.persistItems,
  );
}
```

Returning the normalization promise ends the helper frame after normalization;
the collected array is not carried into later stages.

- [ ] **Step 5: Advance through one replaceable item reference**

Add:

```ts
async function advanceSelectionStages(
  context: PipelineContext,
  run: PipelineRun,
): Promise<readonly Item[]> {
  let items: readonly Item[] = await collectAndNormalize(context, run);
  let input = items;
  items = await checkpoint(
    context, run, "enrich", EnrichedItemsSchema,
    () => context.enrich(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "prefilter", PrefilteredItemsSchema,
    () => context.prefilter(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "assess", AssessedItemsSchema,
    () => context.assess(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "score", ScoredItemsSchema,
    () => context.score(input),
  );
  input = items;
  items = await checkpoint(
    context, run, "cluster", ClusteredItemsSchema,
    () => context.cluster(input),
  );
  input = items;
  return checkpoint(
    context, run, "shortlist", ShortlistedItemsSchema,
    () => context.shortlist(input),
  );
}
```

The `items` and `input` bindings are overwritten after each completed stage;
the helper must not introduce separately named variables for all stage outputs.

- [ ] **Step 6: Rewire the pipeline and reload normalization for composition**

Replace the eight individual stage constants in `runEditorialPipeline` with:

```ts
const shortlisted = await advanceSelectionStages(context, run);
```

After `validated` and immediately before loading durable source failures, add:

```ts
const normalizedForComposition = await readCheckpointOutput(
  context,
  "normalize",
  NormalizedItemsSchema,
);
```

Pass `normalizedForComposition` into `composeEdition`.

- [ ] **Step 7: Verify the memory-oriented structural test is GREEN**

Run the Step 2 command.

Expected: PASS with exactly one explicit `normalize` artifact read.

- [ ] **Step 8: Verify stage semantics and synthesis behavior**

Run:

```bash
npm run test:worker -- --run tests/integration/workflow/resume.test.ts tests/integration/workflow/manual-run.test.ts -t "reloads normalized data only|runs paid synthesis calls sequentially|reconciles a saved D1 checkpoint|resumes from every checkpoint" --reporter=dot
```

Expected: selected tests PASS; synthesis remains sequential and checkpoint
resume does not repeat provider work.

- [ ] **Step 9: Run the complete affected Worker files and static checks**

Run:

```bash
npm run test:worker -- --run tests/integration/workflow/resume.test.ts tests/integration/workflow/manual-run.test.ts --reporter=dot
npm run check
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 10: Commit**

```bash
git add src/workflow/run-editorial-pipeline.ts tests/integration/workflow/resume.test.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: bound live workflow stage data"
```

---

### Task 3: Release terminal run reservations and migrate stranded rows

**Files:**
- Create: `src/db/migrations/0010_release_terminal_model_reservations.sql`
- Create: `tests/integration/db/model-budget-terminal-cleanup-migration.test.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/db/d1-repository.ts`
- Modify: `src/workflow/types.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `src/workflow/daily-briefing-workflow.ts`
- Test: `tests/integration/db/repository.test.ts`
- Test: `tests/integration/workflow/resume.test.ts`

**Interfaces:**
- Produces: `ReleaseRunModelBudgetInput { runId: string; releasedAt: string }`.
- Produces: `ReleasedRunModelBudget { releasedReservations: number; releasedMaximumCostMicrousd: number }`.
- Produces: `D1BriefingRepository.releaseRunModelBudget(input): Promise<ReleasedRunModelBudget>`.
- Produces: `D1BriefingRepository.recordTerminalModelBudgetCleanup(input): Promise<void>` with bounded success/failure audit data.
- Produces: optional `PipelineContext.cleanupTerminalReservations(failureCode: string): Promise<void>`.
- Produces: `createD1TerminalReservationCleanup(...)` used by the production Workflow context.

- [ ] **Step 1: Add repository input/result types**

Add to `src/db/repository.ts` beside the existing reservation types:

```ts
export type ReleaseRunModelBudgetInput = {
  runId: string;
  releasedAt: string;
};

export type ReleasedRunModelBudget = {
  releasedReservations: number;
  releasedMaximumCostMicrousd: number;
};

export type TerminalModelBudgetCleanupAuditInput = ReleasedRunModelBudget & {
  runId: string;
  failureCode: string;
  outcome: "released" | "failed";
  occurredAt: string;
};
```

Add these methods to `BriefingRepository`:

```ts
releaseRunModelBudget(
  input: ReleaseRunModelBudgetInput,
): Promise<ReleasedRunModelBudget>;
recordTerminalModelBudgetCleanup(
  input: TerminalModelBudgetCleanupAuditInput,
): Promise<void>;
```

- [ ] **Step 2: Add a failing exact-run idempotency test**

In `tests/integration/db/repository.test.ts`, seed two runs and reservations in
all three states, then assert the new method changes only target reserved rows:

```ts
it("releases only one run's reserved model budget idempotently", async () => {
  const repository = new D1BriefingRepository(env.DB);
  const createdAt = "2036-02-10T09:00:00.000Z";
  for (const [runId, date] of [
    ["terminal-budget-run", "2036-02-10"],
    ["other-budget-run", "2036-02-11"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) VALUES (?, ?, 'retryable', 'shortlist', 1, 1, ?, 0, ?, ?)`,
    ).bind(runId, date, "Worker exceeded memory limit.", createdAt, createdAt)
      .run();
  }
  const reservations = [
    { id: "target-a", runId: "terminal-budget-run", maximum: 99_450, status: "reserved", actual: null },
    { id: "target-b", runId: "terminal-budget-run", maximum: 101_850, status: "reserved", actual: null },
    { id: "target-reconciled", runId: "terminal-budget-run", maximum: 80_000, status: "reconciled", actual: 20_000 },
    { id: "other-reserved", runId: "other-budget-run", maximum: 120_000, status: "reserved", actual: null },
  ] as const;
  await env.DB.batch(reservations.map((reservation) => env.DB.prepare(
    `INSERT INTO model_budget_reservations (
      id, run_id, month_start, maximum_cost_microusd,
      actual_cost_microusd, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    reservation.id,
    reservation.runId,
    "2036-02-01T00:00:00.000Z",
    reservation.maximum,
    reservation.actual,
    reservation.status,
    createdAt,
    createdAt,
  )));

  await expect(repository.releaseRunModelBudget({
    runId: "terminal-budget-run",
    releasedAt: "2036-02-10T09:05:00.000Z",
  })).resolves.toEqual({
    releasedReservations: 2,
    releasedMaximumCostMicrousd: 201_300,
  });
  await expect(repository.releaseRunModelBudget({
    runId: "terminal-budget-run",
    releasedAt: "2036-02-10T09:06:00.000Z",
  })).resolves.toEqual({
    releasedReservations: 0,
    releasedMaximumCostMicrousd: 0,
  });
  expect(await env.DB.prepare(
    `SELECT id, status FROM model_budget_reservations
     WHERE id IN ('target-a', 'target-b', 'target-reconciled', 'other-reserved')
     ORDER BY id`,
  ).all()).toMatchObject({ results: [
    { id: "other-reserved", status: "reserved" },
    { id: "target-a", status: "released" },
    { id: "target-b", status: "released" },
    { id: "target-reconciled", status: "reconciled" },
  ] });

  await repository.recordTerminalModelBudgetCleanup({
    runId: "terminal-budget-run",
    failureCode: "Worker exceeded memory limit.",
    outcome: "released",
    occurredAt: "2036-02-10T09:06:00.000Z",
    releasedReservations: 2,
    releasedMaximumCostMicrousd: 201_300,
  });
  const audit = await env.DB.prepare(
    `SELECT event_json, expires_at FROM audit_events
     WHERE run_id = ? AND event_type = ?`,
  ).bind(
    "terminal-budget-run",
    "model_budget_terminal_cleanup",
  ).first<{ event_json: string; expires_at: string }>();
  expect(audit).not.toBeNull();
  expect(JSON.parse(audit!.event_json)).toEqual({
    failureCode: "Worker exceeded memory limit.",
    outcome: "released",
    releasedReservations: 2,
    releasedMaximumCostMicrousd: 201_300,
  });
  expect(audit!.expires_at).toBe("2036-03-11T09:06:00.000Z");

  await expect(repository.recordTerminalModelBudgetCleanup({
    runId: "terminal-budget-run",
    failureCode: "x".repeat(201),
    outcome: "failed",
    occurredAt: "2036-02-10T09:07:00.000Z",
    releasedReservations: 0,
    releasedMaximumCostMicrousd: 0,
  })).rejects.toThrow("Invalid terminal model budget cleanup audit");
});
```

- [ ] **Step 3: Run the repository test and verify RED**

Run:

```bash
npm run test:worker -- --run tests/integration/db/repository.test.ts -t "releases only one run's reserved" --reporter=dot
```

Expected: TypeScript/test failure because `releaseRunModelBudget` does not
exist.

- [ ] **Step 4: Implement exact-run release and bounded audit persistence**

Add strict Zod schemas beside the existing budget schemas in
`src/db/d1-repository.ts`. Implement `releaseRunModelBudget` by first selecting
the target aggregate and then updating with the same exact predicate:

```ts
async releaseRunModelBudget(
  input: ReleaseRunModelBudgetInput,
): Promise<ReleasedRunModelBudget> {
  const valid = validated(
    ReleaseRunModelBudgetInputSchema,
    input,
    "Invalid run model budget release",
  );
  const aggregate = await this.db.prepare(
    `SELECT COUNT(*) AS releasedReservations,
            COALESCE(SUM(maximum_cost_microusd), 0)
              AS releasedMaximumCostMicrousd
     FROM model_budget_reservations
     WHERE run_id = ? AND status = 'reserved'`,
  ).bind(valid.runId).first<ReleasedRunModelBudget>();
  const result = await this.db.prepare(
    `UPDATE model_budget_reservations
     SET status = 'released', updated_at = ?
     WHERE run_id = ? AND status = 'reserved'`,
  ).bind(valid.releasedAt, valid.runId).run();
  const releasedReservations = result.meta.changes ?? 0;
  return {
    releasedReservations,
    releasedMaximumCostMicrousd:
      releasedReservations === 0
        ? 0
        : aggregate?.releasedMaximumCostMicrousd ?? 0,
  };
}
```

Because a run has one sequential Workflow owner, the pre-update aggregate and
update share the same exact predicate. Validate the returned integers before
returning them.

Implement `recordTerminalModelBudgetCleanup` as one bounded
`audit_events` insert with `event_type = 'model_budget_terminal_cleanup'` and
JSON containing only `outcome`, `releasedReservations`,
`releasedMaximumCostMicrousd`, and the bounded `failureCode`. Set `expires_at`
to 30 days after `occurredAt`, matching the existing bounded audit-retention
policy.

- [ ] **Step 5: Verify repository GREEN**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 6: Add failing terminal-cleanup pipeline tests**

Add `cleanupTerminalReservations` to `PipelineContext` in
`src/workflow/types.ts`:

```ts
cleanupTerminalReservations?: (failureCode: string) => Promise<void>;
```

In `tests/integration/workflow/resume.test.ts`, add:

```ts
it("cleans terminal reservations after exhausted synthesis failure", async () => {
  const context = resumableContext("publish");
  const cleanup = vi.fn(async () => undefined);
  context.cleanupTerminalReservations = cleanup;
  context.synthesize = async () => {
    throw new Error("Worker exceeded memory limit.");
  };
  context.checkpointExecutor = async (_step, execute) => execute();

  await expect(runEditorialPipeline(context)).rejects.toThrow(
    "Worker exceeded memory limit.",
  );
  expect(cleanup).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledWith("Worker exceeded memory limit.");
});

it("does not mask the pipeline error when terminal cleanup fails", async () => {
  const context = resumableContext("publish");
  context.cleanupTerminalReservations = async () => {
    throw new Error("MODEL_BUDGET_CLEANUP_FAILED");
  };
  context.synthesize = async () => {
    throw new Error("ORIGINAL_SYNTHESIS_FAILURE");
  };
  context.checkpointExecutor = async (_step, execute) => execute();

  await expect(runEditorialPipeline(context)).rejects.toThrow(
    "ORIGINAL_SYNTHESIS_FAILURE",
  );
});

it("does not clean reservations when a temporary step retry succeeds", async () => {
  const context = resumableContext("publish");
  const cleanup = vi.fn(async () => undefined);
  context.cleanupTerminalReservations = cleanup;
  let attempts = 0;
  const synthesize = context.synthesize;
  context.synthesize = async (items) => {
    attempts += 1;
    if (attempts === 1) throw new Error("TEMPORARY_SYNTHESIS_FAILURE");
    return synthesize(items);
  };
  context.checkpointExecutor = async (_step, execute) => {
    try {
      return await execute();
    } catch {
      return execute();
    }
  };

  await expect(runEditorialPipeline(context)).resolves.toMatchObject({
    runId: context.runId,
  });
  expect(cleanup).not.toHaveBeenCalled();
});
```

Also import `createD1TerminalReservationCleanup` from
`daily-briefing-workflow.ts` and add direct callback tests:

```ts
it("releases and audits terminal D1 reservations", async () => {
  const releaseRunModelBudget = vi.fn(async () => ({
    releasedReservations: 3,
    releasedMaximumCostMicrousd: 300_750,
  }));
  const recordTerminalModelBudgetCleanup = vi.fn(async () => undefined);
  const cleanup = createD1TerminalReservationCleanup(
    { releaseRunModelBudget, recordTerminalModelBudgetCleanup },
    {
      runId: "terminal-cleanup-run",
      clock: () => new Date("2036-02-10T09:05:00.000Z"),
    },
  );

  await cleanup("Worker exceeded memory limit.");

  expect(releaseRunModelBudget).toHaveBeenCalledWith({
    runId: "terminal-cleanup-run",
    releasedAt: "2036-02-10T09:05:00.000Z",
  });
  expect(recordTerminalModelBudgetCleanup).toHaveBeenCalledWith({
    runId: "terminal-cleanup-run",
    failureCode: "Worker exceeded memory limit.",
    outcome: "released",
    occurredAt: "2036-02-10T09:05:00.000Z",
    releasedReservations: 3,
    releasedMaximumCostMicrousd: 300_750,
  });
});

it("records only a generic diagnostic when terminal release fails", async () => {
  const releaseError = new Error("private repository details");
  const releaseRunModelBudget = vi.fn(async () => {
    throw releaseError;
  });
  const recordTerminalModelBudgetCleanup = vi.fn(async () => undefined);
  const cleanup = createD1TerminalReservationCleanup(
    { releaseRunModelBudget, recordTerminalModelBudgetCleanup },
    {
      runId: "terminal-cleanup-run",
      clock: () => new Date("2036-02-10T09:05:00.000Z"),
    },
  );

  await expect(cleanup("PUBLIC_FAILURE_CODE")).rejects.toBe(releaseError);
  expect(recordTerminalModelBudgetCleanup).toHaveBeenCalledWith({
    runId: "terminal-cleanup-run",
    failureCode: "PUBLIC_FAILURE_CODE",
    outcome: "failed",
    occurredAt: "2036-02-10T09:05:00.000Z",
    releasedReservations: 0,
    releasedMaximumCostMicrousd: 0,
  });
  expect(JSON.stringify(recordTerminalModelBudgetCleanup.mock.calls))
    .not.toContain("private repository details");
});

it("treats a success-audit write failure as best effort", async () => {
  const releaseRunModelBudget = vi.fn(async () => ({
    releasedReservations: 1,
    releasedMaximumCostMicrousd: 99_450,
  }));
  const recordTerminalModelBudgetCleanup = vi.fn(async () => {
    throw new Error("AUDIT_WRITE_FAILED");
  });
  const cleanup = createD1TerminalReservationCleanup(
    { releaseRunModelBudget, recordTerminalModelBudgetCleanup },
    {
      runId: "terminal-cleanup-run",
      clock: () => new Date("2036-02-10T09:05:00.000Z"),
    },
  );

  await expect(cleanup("PIPELINE_FAILED")).resolves.toBeUndefined();
  expect(recordTerminalModelBudgetCleanup).toHaveBeenCalledOnce();
});
```

- [ ] **Step 7: Run the terminal tests and verify RED**

Run:

```bash
npm run test:worker -- --run tests/integration/workflow/resume.test.ts -t "cleans terminal reservations|does not mask|temporary step retry|terminal D1 reservations|generic diagnostic|success-audit" --reporter=dot
```

Expected: RED because the outer catch does not call cleanup and the production
callback export does not exist yet. The temporary-retry control is expected to
remain green once the new export is present.

- [ ] **Step 8: Invoke cleanup without masking the original error**

In the `runEditorialPipeline` catch, save the retryable run exactly as today,
then add:

```ts
try {
  await context.cleanupTerminalReservations?.(failureCode);
} catch {
  // The original pipeline error remains authoritative. The production
  // callback records a bounded cleanup-failure diagnostic when possible.
}
throw error;
```

Do not call cleanup from `checkpoint`, the provider retry loop, or
`runCheckpointWithWorkflowStep`.

- [ ] **Step 9: Build the production cleanup callback**

Export from `src/workflow/daily-briefing-workflow.ts`:

```ts
export function createD1TerminalReservationCleanup(
  repository: Pick<
    D1BriefingRepository,
    "releaseRunModelBudget" | "recordTerminalModelBudgetCleanup"
  >,
  options: { runId: string; clock: () => Date },
): NonNullable<PipelineContext["cleanupTerminalReservations"]> {
  return async (failureCode) => {
    const occurredAt = options.clock().toISOString();
    let released: ReleasedRunModelBudget;
    try {
      released = await repository.releaseRunModelBudget({
        runId: options.runId,
        releasedAt: occurredAt,
      });
    } catch (error) {
      try {
        await repository.recordTerminalModelBudgetCleanup({
          runId: options.runId,
          failureCode,
          outcome: "failed",
          occurredAt,
          releasedReservations: 0,
          releasedMaximumCostMicrousd: 0,
        });
      } catch {
        // Preserve the original cleanup error for the pipeline's bounded catch.
      }
      throw error;
    }
    try {
      await repository.recordTerminalModelBudgetCleanup({
        runId: options.runId,
        failureCode,
        outcome: "released",
        occurredAt,
        ...released,
      });
    } catch {
      // Reservation release succeeded. Its success audit is best effort and
      // must not be mislabeled as a failed release.
    }
  };
}
```

Import the `PipelineContext` and `ReleasedRunModelBudget` types. When creating
the D1 production context in `DailyBriefingWorkflow.run`, pass:

```ts
cleanupTerminalReservations: createD1TerminalReservationCleanup(repository, {
  runId,
  clock: () => new Date(),
}),
```

Add the option to `ProductionPipelineContextOptions`, copy it into the object
returned by `createProductionPipelineContext`, and include it in the options
`Pick` accepted by `createD1ProductionPipelineContext`. Do not supply it from
test/default or manual-run contexts.

- [ ] **Step 10: Verify terminal cleanup behavior is GREEN**

Run the Step 7 command.

Expected: all six tests PASS, including exact callback aggregation, generic
release-failure diagnostics, and best-effort success auditing.

- [ ] **Step 11: Add a failing migration safety/idempotency test**

Create `tests/integration/db/model-budget-terminal-cleanup-migration.test.ts`.
Use `env.UPGRADE_DB`, apply migrations whose name is less than
`0010_release_terminal_model_reservations.sql`, seed one run for each status
`pending`, `running`, `retryable`, `partial`, `failed`, and `published`, and seed
one `reserved` reservation per run plus one `reconciled` reservation. Apply
`0010` twice and assert:

```ts
expect(statusByRun).toMatchObject({
  pending: "reserved",
  running: "reserved",
  retryable: "released",
  partial: "released",
  failed: "released",
  published: "released",
});
expect(reconciledStatus).toBe("reconciled");
expect(statusesAfterSecondApply).toEqual(statusesAfterFirstApply);
```

Use the `requiredMigration` pattern from
`tests/integration/db/source-feed-refresh-migration.test.ts`; do not duplicate
the migration SQL inside the test.

- [ ] **Step 12: Run the migration test and verify RED**

Run:

```bash
npm run test:worker -- --run tests/integration/db/model-budget-terminal-cleanup-migration.test.ts --reporter=dot
```

Expected: FAIL with `Required test migration is missing:
0010_release_terminal_model_reservations.sql`.

- [ ] **Step 13: Add the one-time migration**

Create `src/db/migrations/0010_release_terminal_model_reservations.sql`:

```sql
UPDATE model_budget_reservations
SET status = 'released',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'reserved'
  AND EXISTS (
    SELECT 1
    FROM workflow_runs
    WHERE workflow_runs.id = model_budget_reservations.run_id
      AND workflow_runs.status IN (
        'retryable', 'partial', 'failed', 'published'
      )
  );
```

- [ ] **Step 14: Run the migration test and verify GREEN**

Run:

```bash
npm run test:worker -- --run tests/integration/db/model-budget-terminal-cleanup-migration.test.ts --reporter=dot
```

Expected: PASS, including second application.

- [ ] **Step 15: Run affected suites and static checks**

Run:

```bash
npm run test:worker -- --run tests/integration/db/repository.test.ts tests/integration/db/model-budget-terminal-cleanup-migration.test.ts tests/integration/workflow/resume.test.ts --reporter=dot
npm run check
git diff --check
```

Expected: all commands exit `0`; normal reservation and Workflow resume tests
remain green.

- [ ] **Step 16: Commit**

```bash
git add src/db/migrations/0010_release_terminal_model_reservations.sql tests/integration/db/model-budget-terminal-cleanup-migration.test.ts src/db/repository.ts src/db/d1-repository.ts src/workflow/types.ts src/workflow/run-editorial-pipeline.ts src/workflow/daily-briefing-workflow.ts tests/integration/db/repository.test.ts tests/integration/workflow/resume.test.ts
git commit -m "fix: release terminal model reservations"
```

---

### Task 4: Verify, deploy, migrate, and inspect without a canary

**Files:**
- Verify: all Task 1–3 tracked files
- Create: `.superpowers/sdd/2026-08-03-workflow-memory-reservation-recovery/progress.md`
  (git-ignored execution ledger)

**Interfaces:**
- Consumes: preview Worker `optimist-briefing-preview`, Workflow `daily-briefing-preview`, D1 database `823bdf63-e52b-4e66-aa83-99523a6241d6`, and preview config `/private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc`.
- Produces: a deployed Worker version, applied `0010` migration, and read-only evidence that terminal reservations were released without changing the failed run or starting a Workflow.

- [ ] **Step 1: Run the full local gate**

Run application tests and typecheck in parallel when supported:

```bash
npm test -- --reporter=dot
npm run check
```

Then run:

```bash
npm run test:worker -- --reporter=dot
npm run evaluate
npm run build
git diff --check
git status --short
```

Expected: every command exits `0`; no unexpected tracked changes; production
assets exist in `dist`.

- [ ] **Step 2: Capture the exact pre-migration reservation and run state**

Run read-only queries:

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT status, COUNT(*) AS reservations, SUM(maximum_cost_microusd) AS maximum_cost_microusd FROM model_budget_reservations WHERE run_id = '2026-08-01' GROUP BY status ORDER BY status"
```

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT id, edition_date, status, current_step, retryable, failure_code, estimated_cost_usd FROM workflow_runs WHERE id = '2026-08-01'"
```

Capture global no-new-work baselines:

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT (SELECT COUNT(*) FROM workflow_runs) AS workflow_runs, (SELECT COUNT(*) FROM editions) AS editions, (SELECT COUNT(*) FROM model_budget_reservations) AS reservations, (SELECT COUNT(*) FROM audit_events WHERE event_type = 'model_usage') AS model_usage_events"
```

Capture all currently eligible terminal reservations:

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT r.id, r.status AS run_status, COUNT(*) AS reservations, SUM(b.maximum_cost_microusd) AS maximum_cost_microusd FROM model_budget_reservations b JOIN workflow_runs r ON r.id = b.run_id WHERE b.status = 'reserved' AND r.status IN ('retryable','partial','failed','published') GROUP BY r.id, r.status ORDER BY r.id"
```

Expected precondition: three `reserved` rows totaling `300750` micro-USD; the
run remains retryable at shortlist with the memory-limit failure. If the state
has changed, stop and report rather than guessing or rewriting rows.

- [ ] **Step 3: Deploy with secrets preserved**

Run:

```bash
npx wrangler deploy \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --keep-vars
```

Expected: deployment succeeds and prints a new Worker version ID. Do not print
or inspect `OPENAI_API_KEY`.

- [ ] **Step 4: Apply the migration to preview D1**

Run:

```bash
npx wrangler d1 migrations apply optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc
```

Expected: `0010_release_terminal_model_reservations.sql` applies exactly once.
Do not execute ad hoc UPDATE statements.

- [ ] **Step 5: Verify reservation cleanup and unchanged run state**

Repeat all four Step 2 queries.

Expected:

- the three former synthesis rows are `released`, not `reserved`;
- their total maximum remains auditable as `300750` micro-USD;
- reconciled rows and recorded model usage remain unchanged;
- run `2026-08-01` remains retryable at shortlist with the original failure and
  `$0.19377516` recorded cost; and
- the global counts of `workflow_runs`, editions, reservations, and model-usage
  events exactly match the pre-migration baseline; and
- the eligible-terminal-reservations query returns no rows.

Also query active-run safety:

```bash
npx wrangler d1 execute optimist-briefing-preview --remote \
  --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc \
  --command "SELECT r.id, r.status AS run_status, b.status AS reservation_status, COUNT(*) AS reservations FROM model_budget_reservations b JOIN workflow_runs r ON r.id = b.run_id WHERE r.status IN ('pending','running') GROUP BY r.id, r.status, b.status ORDER BY r.id, b.status"
```

Expected: any active-run reservation remains `reserved`.

- [ ] **Step 6: Verify the authenticated site without form submission**

Open or reload:

```text
https://optimist-briefing-preview.optimistindustries.workers.dev/run-status
```

Confirm the page renders and still shows the August 1 failed/retryable run.
Do not change the edition date, click `Start canary run`, call the admin POST,
or resume the run.

- [ ] **Step 7: Record the deployment and finish read-only checks**

Append the Worker version, migration result, before/after reservation counts,
unchanged run state, active-run safety result, browser verification, and explicit
zero-new-run/zero-new-model-cost confirmation to
`.superpowers/sdd/2026-08-03-workflow-memory-reservation-recovery/progress.md`
using `apply_patch`.

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: the tracked worktree is clean and no empty operational commit is
created.
