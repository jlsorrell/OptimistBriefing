# Compact Cluster Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep production-sized embedding vectors out of cluster and later checkpoints while preserving semantic clustering behavior.

**Architecture:** The cluster stage will extract embeddings into its existing in-memory lookup, then pass embedding-free item copies into `clusterNews`. Research items will be compacted at the same boundary, ensuring every cluster-stage output is vector-free without changing earlier resumable checkpoints.

**Tech Stack:** TypeScript, Zod, Vitest with Cloudflare Workers pool, Cloudflare Workflows, D1, Wrangler.

## Global Constraints

- Do not change embedding dimensions, semantic thresholds, ranking behavior, or downstream schemas.
- Retain vectors through the score checkpoint so retries before clustering do not repeat a paid embedding request.
- Remove vectors from all cluster-stage outputs, including nested development items and representatives.
- Preserve the preview Worker's encrypted `OPENAI_API_KEY` and all deployed variables.
- Keep model usage within the configured `$5` monthly cap.

---

### Task 1: Compact the cluster boundary

**Files:**
- Modify: `tests/integration/workflow/manual-run.test.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`

**Interfaces:**
- Consumes: `workflowPayload(item: Item): WorkflowItemPayload`, `clusterNews(items, embeddings)`, and `PipelineContext.cluster(items)`.
- Produces: `withoutWorkflowEmbedding(item: Item): Item`, used only at the cluster boundary; `PipelineContext.cluster` continues returning `Promise<readonly Item[]>`.

- [ ] **Step 1: Write the failing regression test**

Add a production-context test that creates two world-news items sharing a named entity, supplies identical 1,536-dimensional vectors plus the profile vectors expected by enrichment, and runs `normalize`, `enrich`, `prefilter`, `score`, and `cluster`:

```ts
it("uses embeddings for clustering without retaining them in cluster output", async () => {
  const embedding = [1, ...Array<number>(1_535).fill(0)];
  const candidates = ["source-a", "source-b"].map((id) => ({
    ...fixtureItem(id, "world"),
    metadata: {
      primarySection: "world",
      sectionEligibility: ["world"],
      namedEntities: ["Example Agency"],
    },
  }));
  const context = createProductionPipelineContext({
    editionDate: "2033-02-08",
    runId: "run-compact-cluster-checkpoint",
    store: new FixtureStore(),
    now: () => now,
    providers: {
      summary: new FakeModelProvider({
        embeddingBatches: [[
          embedding,
          embedding,
          embedding,
          embedding,
          embedding,
          embedding,
        ]],
      }),
      assessment: new FakeModelProvider(),
    },
    collectCandidates: async () => candidates,
  });

  const normalized = await context.normalize(await context.collect());
  const enriched = await context.enrich(normalized);
  const scored = await context.score(await context.prefilter(enriched));
  expect(JSON.stringify(scored)).toContain('"embedding"');

  const clustered = await context.cluster(scored);

  expect(clustered).toHaveLength(1);
  expect(JSON.stringify(clustered)).not.toContain('"embedding"');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "uses embeddings for clustering without retaining them in cluster output"
```

Expected: FAIL because the serialized clustered item still contains `metadata.workflow.embedding` in the outer item and nested development items.

- [ ] **Step 3: Implement the minimal compaction helper**

Add this private helper beside `workflowPayload` and `withWorkflowPayload`:

```ts
function withoutWorkflowEmbedding(item: Item): Item {
  const { embedding: _embedding, ...workflow } = workflowPayload(item);
  return WorkflowItemSchema.parse({
    ...item,
    metadata: {
      ...item.metadata,
      workflow,
    },
  });
}
```

In `cluster`, build the embedding lookup from the parsed news items, then compact both categories before constructing developments:

```ts
const embeddings = Object.fromEntries(news.map((item) => [
  item.id,
  workflowPayload(item).embedding ?? [],
]));
const compactResearch = research.map(withoutWorkflowEmbedding);
const compactNews = news.map(withoutWorkflowEmbedding);
const byId = new Map(compactNews.map((item) => [item.id, item]));
const developments = clusterNews(compactNews, embeddings);
// ...existing scoring and itemFromDevelopment logic...
return [...compactResearch, ...developmentItems];
```

- [ ] **Step 4: Run focused and adjacent tests and verify GREEN**

Run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "uses embeddings for clustering without retaining them in cluster output"
npx vitest run tests/unit/editorial/deduplicate.test.ts tests/unit/editorial/pipeline.test.ts
npm run check
```

Expected: all commands exit `0`; the new test passes and semantic clustering tests remain green.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/workflow/run-editorial-pipeline.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: compact cluster checkpoints"
```

### Task 2: Verify, deploy, and resume the preview canary

**Files:**
- Modify temporarily: `/private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc`
- Verify only: `dist/`

**Interfaces:**
- Consumes: preview Worker `optimist-briefing-preview`, Workflow `daily-briefing-preview`, D1 database `optimist-briefing-preview`, and run ID `2026-08-02`.
- Produces: a deployed Worker version and a completed or intentionally partial live edition for `2026-08-02`.

- [ ] **Step 1: Run the complete local verification suite**

```bash
npm test
npm run test:worker
npm run check
npm run build
git diff --check
```

Expected: every command exits `0`, with no TypeScript, test, build, or whitespace failures.

- [ ] **Step 2: Correct the temporary preview deployment config**

Update the temporary config paths to `/Users/jlsor/Documents/Personal/Tools/src/worker.ts`, `/Users/jlsor/Documents/Personal/Tools/dist`, and `/Users/jlsor/Documents/Personal/Tools/src/db/migrations`. Set the non-secret variables to the values currently deployed:

```json
{
  "ASSESSMENT_MODEL": "gpt-5.6-terra",
  "SUMMARY_MODEL": "gpt-5.6-terra",
  "EMBEDDING_MODEL": "text-embedding-3-small",
  "MONTHLY_BUDGET_USD": "5",
  "ASSESSMENT_UNIT_PRICE_USD": "0.000015",
  "SUMMARY_UNIT_PRICE_USD": "0.000015",
  "EMBEDDING_UNIT_PRICE_USD": "0.00000002"
}
```

Retain the existing Access domain, audience, and allowlisted email. Do not put `OPENAI_API_KEY` in the file.

- [ ] **Step 3: Deploy while preserving encrypted secrets**

```bash
npx wrangler deploy --keep-vars --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc
```

Expected: deployment succeeds for `optimist-briefing-preview`, preserves the encrypted API key, and reports the existing D1 and Workflow bindings.

- [ ] **Step 4: Replay today's retryable canary**

```bash
npx wrangler workflows trigger daily-briefing-preview '{"editionDate":"2026-08-02","runId":"2026-08-02"}' --config /private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc
```

Poll the returned instance with `wrangler workflows instances describe` until terminal. Expected: clustering persists and execution continues through synthesis, validation, composition, and publication or a deliberate partial-edition outcome.

- [ ] **Step 5: Verify D1 state and spend**

Read `workflow_runs`, `model_usage` audit events, reservation aggregates, the `2026-08-02` edition, and checkpoint sizes. Expected: no active reservation remains; estimated cost is under `$5`; the cluster checkpoint is materially smaller than the 1,108,247-character score checkpoint; and the edition is published or partial rather than retryable.

- [ ] **Step 6: Verify the private site**

Open `https://optimist-briefing-preview.optimistindustries.workers.dev/` through the existing authenticated browser session. Expected: the current edition renders behind Cloudflare Access with no visible application error.
