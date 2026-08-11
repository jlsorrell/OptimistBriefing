# Bounded Research Near-Match Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit a small, deterministic set of configured-topic research near-matches to deep assessment when the existing high-confidence research queue is sparse, without lowering any final publication standard.

**Architecture:** Extend the existing research-triage boundary with a second admission pass below the normal `0.50` topical-fit gate. The pass fills a combined six-candidate target from candidates at or above `0.35`, requires configured-topic evidence, orders direct technical matches before adjacent matches, and shares all existing diversity and absolute capacity limits. Add only aggregate per-lane fallback counts to the existing diagnostics pipeline and authenticated Run Status view.

**Tech Stack:** TypeScript 5.8, Zod 3, React 19, Vitest 4, Cloudflare Worker/D1 test harness.

**Design specification:** `docs/superpowers/specs/2026-08-11-bounded-research-near-match-fallback-design.md`

## Global Constraints

- The normal research topical-fit threshold remains exactly `0.50`.
- The near-match topical-fit floor is exactly `0.35`; `0.35` is included and values below it are excluded.
- The combined sparse-queue target is exactly `6` research candidates.
- The existing absolute research assessment cap remains `24`.
- Six or more normal candidates disable fallback admission.
- Fallback requires at least one configured research-topic match from bounded normalized evidence.
- Institution, laboratory, citation, popularity, or source prestige cannot establish fallback eligibility.
- Core near-matches precede adjacent near-matches; all normal candidates precede every fallback candidate.
- Existing discovery-family and publisher-domain counts are shared across both passes.
- Technical assessment, scoring, featured selection, Research Radar, synthesis, validation, grounding, coverage, and publication gates remain unchanged.
- Existing normal, degraded, and hard-stop model-budget behavior remains unchanged.
- Do not add a model call, embedding call, provider request, D1 migration, or persisted vector.
- Diagnostics remain aggregate and must not persist titles, abstracts, embeddings, phrase matches, candidate IDs, or unrestricted URLs.
- News admission, ranking, diagnostics, and coverage behavior remain unchanged.
- Use strict TDD and commit each independently reviewable task.
- Do not deploy or run a paid preview canary without separate authorization.

---

### Task 1: Two-pass research triage

**Files:**
- Modify: `src/editorial/research-triage.ts:22-47,307-396`
- Modify: `tests/unit/editorial/research-triage.test.ts:1-620`

**Interfaces:**
- Consumes: `classifyResearchRelevance(item: Item): "core" | "adjacent"` from `src/editorial/research-relevance.ts`.
- Extends: `ResearchTriageOptions` with optional `fallbackTarget?: number` and `fallbackMinimumTopicalFit?: number`.
- Produces: `ResearchTriageAdmissionRoute = "normal" | "near_match"`.
- Produces: `ResearchTriageAdmission = { itemId: string; route: ResearchTriageAdmissionRoute }`.
- Extends: `ResearchTriageResult` with `admissions: ResearchTriageAdmission[]` in the same order as `items`.
- Preserves: existing behavior when `fallbackTarget` is omitted or zero.

- [ ] **Step 1: Extend the unit fixture with evidence-controlled candidates**

Add `title?: string` to the existing `researchItem` options type. Immediately
after the current `topics` assignment, add:

```ts
const title = options.title ?? `Research candidate ${id}`;
```

Replace both literal `` `Research candidate ${id}` `` title assignments in
the returned Item and its `rawResearch` payload with the local `title` value.

- [ ] **Step 2: Write the failing sparse-queue admission tests**

Add one table-driven group under `describe("triageResearch")`:

```ts
const fallbackOptions = {
  maximum: 24,
  maximumPerFamily: 12,
  maximumPerPublisherDomain: 6,
  configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
  now: NOW,
  fallbackTarget: 6,
  fallbackMinimumTopicalFit: 0.35,
};

it("fills a sparse normal queue with core then adjacent near-matches", () => {
  const normal = Array.from({ length: 4 }, (_, index) =>
    researchItem(`normal-${index}`, {
      topicalFit: 0.8 - index / 100,
      domain: `normal-${index}.example`,
    })
  );
  const core = researchItem("fallback-core", {
    topicalFit: 0.4,
    domain: "core.example",
    normalizedText: "Capability elicitation reveals hidden model abilities.",
  });
  const adjacent = researchItem("fallback-adjacent", {
    topicalFit: 0.49,
    domain: "adjacent.example",
    normalizedText: "A broad framework for AI safety and governance.",
  });

  const result = triageResearch([...normal, adjacent, core], fallbackOptions);

  expect(result.items.map(({ id }) => id)).toEqual([
    "normal-0",
    "normal-1",
    "normal-2",
    "normal-3",
    "fallback-core",
    "fallback-adjacent",
  ]);
  expect(result.admissions).toEqual([
    ...normal.map(({ id }) => ({ itemId: id, route: "normal" as const })),
    { itemId: "fallback-core", route: "near_match" },
    { itemId: "fallback-adjacent", route: "near_match" },
  ]);
});
```

Add exact cases for:

```ts
it("applies the exact fallback and normal boundaries", () => {
  const result = triageResearch([
    researchItem("below", { topicalFit: 0.349999 }),
    researchItem("floor", { topicalFit: 0.35 }),
    researchItem("near", { topicalFit: 0.499999 }),
    researchItem("normal", { topicalFit: 0.5 }),
  ], fallbackOptions);

  expect(result.admissions).toEqual([
    { itemId: "normal", route: "normal" },
    { itemId: "near", route: "near_match" },
    { itemId: "floor", route: "near_match" },
  ]);
  expect(result.exclusions).toContainEqual({
    itemId: "below",
    reason: "below_topical_fit",
  });
});
```

Also assert:

- six normal candidates produce six `normal` admissions and no fallback;
- zero normal candidates admit at most six near-matches;
- a `0.49` candidate with `topics: []` is excluded;
- a preferred-institution candidate below `0.35` is excluded;
- a lower-scoring core candidate precedes a higher-scoring adjacent candidate;
- reversing input preserves item and admission order;
- omitting `fallbackTarget` preserves the existing `0.49` exclusion test.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts -t "fallback|near-match|sparse normal|exact fallback"
```

Expected: FAIL because `ResearchTriageResult` has no `admissions`, `ResearchTriageOptions` has no fallback fields, and below-`0.50` candidates remain excluded.

- [ ] **Step 4: Add the admission types and optional policy inputs**

In `src/editorial/research-triage.ts`, import the existing classifier and add:

```ts
import { classifyResearchRelevance } from "./research-relevance";

export type ResearchTriageAdmissionRoute = "normal" | "near_match";

export type ResearchTriageAdmission = {
  itemId: string;
  route: ResearchTriageAdmissionRoute;
};

export type ResearchTriageResult = {
  items: Item[];
  admissions: ResearchTriageAdmission[];
  exclusions: Array<{
    itemId: string;
    reason: ResearchTriageExclusionReason;
  }>;
  perFamilyCounts: Partial<Record<DiscoveryFamily, number>>;
};

fallbackTarget?: number;
fallbackMinimumTopicalFit?: number;
```

The final two lines above are appended to the existing
`ResearchTriageOptions` object type; do not replace its current required
fields.

Validate `fallbackTarget` with `validatedMaximum`. Parse the fallback floor
with `TopicalFitSchema`, and reject an enabled fallback whose floor is greater
than or equal to the normal threshold:

```ts
const fallbackTarget = validatedMaximum(
  options.fallbackTarget ?? 0,
  "fallbackTarget",
);
const fallbackMinimumTopicalFit = TopicalFitSchema.parse(
  options.fallbackMinimumTopicalFit ?? 0.35,
);
if (
  fallbackTarget > 0 &&
  fallbackMinimumTopicalFit >= minimumTopicalFit
) {
  throw new RangeError(
    "fallbackMinimumTopicalFit must be below minimumTopicalFit.",
  );
}
```

- [ ] **Step 5: Implement deterministic two-pass selection**

Partition valid candidates before selection. Use `safeParse` so a malformed
runtime entry cannot remove already valid siblings:

```ts
const normal: Item[] = [];
const fallback: Item[] = [];

for (const candidate of items) {
  const parsed = ItemSchema.safeParse(candidate);
  if (!parsed.success) continue;
  const item = parsed.data;
  if (item.normalizedText.trim().length === 0) {
    exclusions.push({ itemId: item.id, reason: "invalid_content" });
    continue;
  }
  const topicalFit = workflowTopicalFit(item);
  if (topicalFit !== null && topicalFit >= minimumTopicalFit) {
    normal.push(item);
    continue;
  }
  const hasConfiguredTopic = researchTopics(item).some((topic) =>
    options.configuredTopics.includes(topic)
  );
  if (
    fallbackTarget > 0 &&
    topicalFit !== null &&
    topicalFit >= fallbackMinimumTopicalFit &&
    hasConfiguredTopic
  ) {
    fallback.push(item);
    continue;
  }
  exclusions.push({ itemId: item.id, reason: "below_topical_fit" });
}
```

Extract the current topic-reservation, family-reservation, and ranked-fill
loops into a local `selectDiversified(candidates, limit)` closure. It must use
the shared `selectedIds`, `perFamily`, and `perDomain` maps so the fallback pass
cannot reset diversity limits. Before seeking a representative for a topic,
skip that reservation when any already selected item contains the topic:

```ts
for (const topic of options.configuredTopics) {
  if (selected.some((item) => researchTopics(item).includes(topic))) continue;
  const representative = candidates.find((item) =>
    !selectedIds.has(item.id) &&
    researchTopics(item).includes(topic) &&
    canSelect(item)
  );
  if (representative !== undefined && selected.length < limit) {
    select(representative);
  }
}
```

Retain the current `perFamily` check for family reservations, which already
prevents the fallback pass from reserving a family represented by the normal
pass.

Run the passes in this exact order:

```ts
selectDiversified(normal.sort(compareTriaged), maximum);
const normalCount = selected.length;
const fallbackCapacity = Math.max(
  0,
  Math.min(fallbackTarget - normalCount, maximum - normalCount),
);
if (fallbackCapacity > 0) {
  const core = fallback
    .filter((item) => classifyResearchRelevance(item) === "core")
    .sort(compareTriaged);
  const adjacent = fallback
    .filter((item) => classifyResearchRelevance(item) === "adjacent")
    .sort(compareTriaged);
  selectDiversified(core, selected.length + fallbackCapacity);
  selectDiversified(adjacent, normalCount + fallbackCapacity);
}
```

Capture the normal IDs before the fallback pass and return ordered admissions:

```ts
const normalIds = new Set(selected.slice(0, normalCount).map(({ id }) => id));
const admissions = selected.map(({ id }) => ({
  itemId: id,
  route: normalIds.has(id) ? "normal" as const : "near_match" as const,
}));
```

Classify unselected valid candidates with the existing family, publisher, or
queue-capacity exclusion logic. Do not expose classifier phrase matches.

- [ ] **Step 6: Run complete triage tests and type checking**

Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts
npm run check
```

Expected: all research-triage tests pass; existing callers that omit fallback
options preserve their prior selection behavior.

- [ ] **Step 7: Commit the triage boundary**

```bash
git add src/editorial/research-triage.ts tests/unit/editorial/research-triage.test.ts
git commit -m "feat: admit bounded research near matches"
```

---

### Task 2: Aggregate fallback diagnostics

**Files:**
- Modify: `src/sources/types.ts:157-221`
- Modify: `src/workflow/discovery-diagnostics.ts:1-145`
- Modify: `tests/unit/contracts/editorial.test.ts:184-259`
- Modify: `tests/unit/workflow/discovery-diagnostics.test.ts:1-160`

**Interfaces:**
- Extends: `DiscoveryLaneDiagnosticSchema` with `fallbackTriaged?: number`, bounded from `0` to `10_000`.
- Produces: `DiscoveryDiagnosticsTracker.setFallbackTriaged(refs: readonly DiscoveryDiagnosticRef[]): void`.
- Preserves: historical diagnostic objects with no `fallbackTriaged` property.
- Invariant: when present, `fallbackTriaged <= triaged`.

- [ ] **Step 1: Write failing schema compatibility tests**

In `tests/unit/contracts/editorial.test.ts`, add:

```ts
it("accepts bounded fallback triage counts and treats omission as zero", () => {
  const historical = {
    laneId: "openalex:topic",
    sourceId: "openalex",
    discoveryFamily: "bibliographic" as const,
    discovered: 10,
    deduplicated: 8,
    triaged: 3,
    assessed: 2,
    outcome: "success" as const,
  };

  expect(
    DiscoveryLaneDiagnosticSchema.parse(historical).fallbackTriaged ?? 0,
  ).toBe(0);
  expect(DiscoveryLaneDiagnosticSchema.parse({
    ...historical,
    fallbackTriaged: 2,
  }).fallbackTriaged).toBe(2);
  expect(DiscoveryLaneDiagnosticSchema.safeParse({
    ...historical,
    fallbackTriaged: 4,
  }).success).toBe(false);
});
```

Add negative, fractional, and `10_001` cases.

- [ ] **Step 2: Write failing tracker tests**

In `tests/unit/workflow/discovery-diagnostics.test.ts`, add:

```ts
it("records a bounded fallback subset and replaces it on prefilter replay", () => {
  const tracker = new DiscoveryDiagnosticsTracker([
    diagnostic("openalex:topic", 5),
  ]);
  const triaged = [
    { laneId: "openalex:topic", identity: "paper-1" },
    { laneId: "openalex:topic", identity: "paper-2" },
    { laneId: "openalex:topic", identity: "paper-3" },
  ];
  tracker.beginStage("prefilter");
  tracker.setStage("triaged", triaged);
  tracker.setFallbackTriaged(triaged.slice(1));

  expect(tracker.snapshot()[0]).toMatchObject({
    triaged: 3,
    fallbackTriaged: 2,
  });

  const replay = new DiscoveryDiagnosticsTracker(tracker.state());
  replay.beginStage("prefilter");
  replay.setStage("triaged", triaged.slice(0, 1));
  replay.setFallbackTriaged([]);
  expect(replay.snapshot()[0]).toMatchObject({
    triaged: 1,
    fallbackTriaged: 0,
  });
});
```

Also assert unknown lanes and duplicate identities do not inflate the count and
serialized state contains no identity strings.

- [ ] **Step 3: Run focused diagnostics tests and confirm RED**

Run:

```bash
npx vitest run tests/unit/contracts/editorial.test.ts tests/unit/workflow/discovery-diagnostics.test.ts -t "fallback"
```

Expected: FAIL because the strict schema rejects `fallbackTriaged` and the
tracker has no `setFallbackTriaged` method.

- [ ] **Step 4: Extend the bounded diagnostic schema**

Add an optional field rather than a defaulted field so historical records keep
their byte shape:

```ts
fallbackTriaged: z.number().int().nonnegative().max(10_000).optional(),
```

Insert that field immediately after `triaged`. Extend the existing
`superRefine` callback, after its funnel loop, with:

```ts
  if (
    diagnostic.fallbackTriaged !== undefined &&
    diagnostic.fallbackTriaged > diagnostic.triaged
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fallbackTriaged cannot exceed triaged.",
      path: ["fallbackTriaged"],
    });
  }
```

- [ ] **Step 5: Implement fallback counting in the tracker**

Add:

```ts
setFallbackTriaged(refs: readonly DiscoveryDiagnosticRef[]): void {
  const identities = this.identitiesByLane(refs);
  this.diagnostics = this.diagnostics.map((diagnostic) =>
    DiscoveryLaneDiagnosticSchema.parse({
      ...diagnostic,
      fallbackTriaged: Math.min(
        diagnostic.triaged,
        identities.get(diagnostic.laneId)?.size ?? 0,
      ),
    })
  );
}
```

When `setStage("triaged", ...)` runs, set `fallbackTriaged: 0` in the same
parsed object. This ensures a retry cannot retain a stale fallback count before
the current prefilter pass records its subset.

- [ ] **Step 6: Run the full diagnostics and contract suites**

Run:

```bash
npx vitest run tests/unit/contracts/editorial.test.ts tests/unit/workflow/discovery-diagnostics.test.ts
npm run check
```

Expected: all tests pass; historical diagnostics remain accepted without a
new serialized property.

- [ ] **Step 7: Commit aggregate diagnostics support**

```bash
git add src/sources/types.ts src/workflow/discovery-diagnostics.ts tests/unit/contracts/editorial.test.ts tests/unit/workflow/discovery-diagnostics.test.ts
git commit -m "feat: track research fallback admissions"
```

---

### Task 3: Production pipeline admission and budget ordering

**Files:**
- Modify: `src/workflow/run-editorial-pipeline.ts:2376-2394,2714-2750`
- Modify: `tests/integration/workflow/manual-run.test.ts:4300-4950,6840-6965,7220-7430`

**Interfaces:**
- Consumes: Task 1 `triageResearch(...).admissions` and fallback options.
- Consumes: Task 2 `DiscoveryDiagnosticsTracker.setFallbackTriaged(refs)`.
- Produces: production policy constants `RESEARCH_FALLBACK_TARGET = 6` and `RESEARCH_FALLBACK_MINIMUM_TOPICAL_FIT = 0.35` scoped to `run-editorial-pipeline.ts`.
- Preserves: `PipelineContext.prefilter(items): Promise<readonly Item[]>`.

- [ ] **Step 1: Add a deterministic embedding fixture for sparse research**

In `manual-run.test.ts`, add a test-only provider that assigns known cosine
similarities while returning identical unit profile vectors:

```ts
class SparseResearchEmbeddingProvider extends GroundedProductionProvider {
  override async embed(texts: readonly string[]): Promise<readonly number[][]> {
    return texts.map((text) => {
      const fit = text.includes("NORMAL_FIT")
        ? 0.8
        : text.includes("NEAR_FIT")
          ? 0.4
          : text.includes("BELOW_FLOOR")
            ? 0.3
            : 1;
      return [fit, Math.sqrt(1 - fit * fit)];
    });
  }
}
```

Profile texts contain none of the sentinel strings and therefore receive
`[1, 0]`; the resulting cosine similarity equals the fixture's requested fit.

- [ ] **Step 2: Write the failing production-shaped sparse-funnel test**

Create one lane with one normal candidate, five eligible near-matches, three
below-floor candidates, and one near-fit candidate whose configured-topic
metadata becomes empty after normalization. Use six valid assessment fixture
responses.

```ts
it("assesses a bounded configured-topic fallback when the normal research queue is sparse", async () => {
  const laneId = "openalex:sparse-fallback";
  const candidate = (
    id: string,
    marker: "NORMAL_FIT" | "NEAR_FIT" | "BELOW_FLOOR",
    topicalEvidence = "Mechanistic interpretability for model oversight",
  ): RawResearchCandidate => ({
    ...rawResearchCandidate(id, `${marker} ${topicalEvidence}`),
    sourceId: "openalex",
    sourceName: "OpenAlex",
    originalUrl: `https://openalex.org/works/${id}`,
    externalId: `openalex:${id}`,
    externalIds: [`openalex:${id}`],
    abstract: `${marker}. ${topicalEvidence}. The paper reports a concrete method.`,
    topics: topicalEvidence === "Unrelated materials theorem"
      ? []
      : ["Interpretability"],
    metadata: {
      discoveryFamily: "bibliographic",
      discoveryLaneIds: [laneId],
    },
  });
  const candidates = [
    candidate("W-normal", "NORMAL_FIT"),
    ...Array.from({ length: 5 }, (_, index) =>
      candidate(`W-near-${index}`, "NEAR_FIT")
    ),
    candidate("W-topicless", "NEAR_FIT", "Unrelated materials theorem"),
    ...Array.from({ length: 3 }, (_, index) =>
      candidate(`W-below-${index}`, "BELOW_FLOOR")
    ),
  ];
  let persistedDiagnostics: DiscoveryDiagnosticsState["diagnostics"] = [];
  const researchRepository = {
    getDiscoveryObservations: async () => [],
    upsertDiscoveryObservations: async () => undefined,
    getCachedResearchAssessment: async () => null,
    putCachedResearchAssessment: async () => undefined,
    recordDiscoveryDiagnostics: async (
      _runId: string,
      diagnostics: DiscoveryDiagnosticsState["diagnostics"],
    ) => {
      persistedDiagnostics = structuredClone(diagnostics);
    },
  };
  const initialDiagnostic = {
    laneId,
    sourceId: "openalex",
    discoveryFamily: "bibliographic" as const,
    discovered: candidates.length,
    deduplicated: 0,
    triaged: 0,
    assessed: 0,
    outcome: "success" as const,
    rejectionCounts: {},
  };
  const context = createProductionPipelineContext({
    editionDate: "2033-03-14",
    runId: "sparse-research-fallback",
    store: new FixtureStore(),
    now: () => now,
    providers: {
      summary: new SparseResearchEmbeddingProvider(),
      assessment: new FakeModelProvider({
        generatedObjects: Array.from({ length: 6 }, () => researchAssessment),
      }),
    },
    collectCandidates: async () => candidates,
    loadDiscoveryDiagnostics: () => [initialDiagnostic],
    researchRepository,
  });

  const normalized = await context.normalize(await context.collect());
  const enriched = await context.enrich(normalized);
  const prefiltered = await context.prefilter(enriched);
  const assessed = await context.assess(prefiltered);

  expect(prefiltered).toHaveLength(6);
  expect(prefiltered[0]?.normalizedText).toContain("NORMAL_FIT");
  expect(prefiltered.slice(1).every(({ normalizedText }) =>
    normalizedText.includes("NEAR_FIT")
  )).toBe(true);
  expect(assessed).toHaveLength(6);
  expect(persistedDiagnostics[0]?.fallbackTriaged).toBe(5);
});
```

Expected persisted lane funnel: discovered/deduplicated counts reflect the
fixture, `triaged: 6`, `fallbackTriaged: 5`, and `assessed: 6`. Assert the JSON
does not contain `NORMAL_FIT`, `NEAR_FIT`, `BELOW_FLOOR`, titles, abstracts, or
embedding arrays.

- [ ] **Step 3: Write the failing degraded-budget priority test**

Create two normal candidates, two core near-matches, and two adjacent
near-matches. Use `budgetPolicy.state = "degraded"`, whose current assessment
cap is four. Assert the assessment provider receives exactly the two normal
candidates followed by the two core near-matches; adjacent near-matches remain
unassessed. Also run the same input under `hard_stop` with no cache and assert
zero assessment calls.

- [ ] **Step 4: Run the focused Worker tests and confirm RED**

Run:

```bash
npx vitest run tests/integration/workflow/manual-run.test.ts -t "bounded configured-topic fallback|fallback priority"
```

If the sandbox rejects the Worker loopback listener, rerun the exact command
with the repository's approved unsandboxed test permission. Expected product
RED: only the normal candidate reaches prefilter and `fallbackTriaged` is
absent.

- [ ] **Step 5: Wire the exact production policy into prefilter**

Add module-local constants:

```ts
const RESEARCH_FALLBACK_TARGET = 6;
const RESEARCH_FALLBACK_MINIMUM_TOPICAL_FIT = 0.35;
```

Pass them to triage:

```ts
const triaged = triageResearch(research, {
  maximum: 24,
  maximumPerFamily: 12,
  maximumPerPublisherDomain: 6,
  configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
  now: options.now(),
  minimumTopicalFit:
    READER_PROFILE.researchQualityGates.minimumTopicalFit,
  fallbackTarget: RESEARCH_FALLBACK_TARGET,
  fallbackMinimumTopicalFit:
    RESEARCH_FALLBACK_MINIMUM_TOPICAL_FIT,
});
```

Derive the fallback subset from ordered admissions:

```ts
const fallbackIds = new Set(
  triaged.admissions
    .filter(({ route }) => route === "near_match")
    .map(({ itemId }) => itemId),
);
const fallbackItems = triaged.items.filter(({ id }) => fallbackIds.has(id));
```

- [ ] **Step 6: Extend the diagnostics writer with a fallback subset**

Change the local writer signature without changing `PipelineContext`:

```ts
const recordDiscoveryDiagnostics = async (
  field?: "deduplicated" | "triaged" | "assessed",
  items: readonly Item[] = [],
  fallbackItems: readonly Item[] = [],
): Promise<void> => {
  await withDiscoveryDiagnostics(async (tracker) => {
    if (field !== undefined) {
      tracker.setStage(
        field,
        stageDiagnosticRefs(items, field === "assessed"),
      );
    }
    if (field === "triaged") {
      tracker.setFallbackTriaged(stageDiagnosticRefs(fallbackItems));
    }
    await discoveryDiagnosticsWriter!(
      options.runId,
      tracker.snapshot(),
      tracker.state().rejectionCountsByStage,
    );
  });
};
```

Call:

```ts
await recordDiscoveryDiagnostics("triaged", result, fallbackItems);
```

Do not attach the admission route to Item metadata, assessment packets,
summaries, or edition entries.

- [ ] **Step 7: Run focused and affected workflow suites**

Run:

```bash
npx vitest run tests/integration/workflow/manual-run.test.ts -t "bounded configured-topic fallback|fallback priority|relevance-first research triage|hard-stop|degraded"
npx vitest run tests/unit/editorial/research-triage.test.ts tests/unit/workflow/discovery-diagnostics.test.ts
npm run check
```

Expected: fallback tests pass; existing relevance-first, degraded, and
hard-stop behavior remains green.

- [ ] **Step 8: Commit production wiring**

```bash
git add src/workflow/run-editorial-pipeline.ts tests/integration/workflow/manual-run.test.ts
git commit -m "feat: assess sparse research near matches"
```

---

### Task 4: Durable and visible aggregate diagnostics

**Files:**
- Modify: `tests/integration/db/repository.test.ts:1570-1740`
- Modify: `src/web/pages/RunStatusPage.tsx:185-225`
- Modify: `tests/unit/web/RunStatusPage.test.tsx:210-265`

**Interfaces:**
- Consumes: optional `DiscoveryLaneDiagnostic.fallbackTriaged` from Task 2.
- Preserves: the existing workflow-run detail API and D1 JSON storage.
- Produces: an authenticated Run Status table column labeled `Fallback`.
- Historical display: missing `fallbackTriaged` renders as `0`.

- [ ] **Step 1: Write the failing D1 round-trip test**

Extend the repository diagnostic fixture with:

```ts
{
  laneId: "openalex:alignment",
  sourceId: "openalex",
  discoveryFamily: "bibliographic",
  discovered: 10,
  deduplicated: 8,
  triaged: 6,
  fallbackTriaged: 5,
  assessed: 4,
  outcome: "success",
  rejectionCounts: {},
}
```

After `recordDiscoveryDiagnostics`, assert
`getWorkflowRunDetail(runId).discoveryDiagnostics` returns
`fallbackTriaged: 5`. Query the stored audit JSON and assert it contains the
number but none of the test candidate titles, abstracts, IDs, or embeddings.

- [ ] **Step 2: Write the failing Run Status rendering tests**

In `RunStatusPage.test.tsx`, add one current diagnostic with
`fallbackTriaged: 2` and one historical diagnostic without the field. Assert
the table has a `Fallback` header and the corresponding cells render `2` and
`0`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
npx vitest run tests/integration/db/repository.test.ts tests/unit/web/RunStatusPage.test.tsx -t "fallback|discovery diagnostics"
```

Expected: the repository round trip passes only after Task 2 schema support,
while the UI assertion fails because no `Fallback` column exists.

- [ ] **Step 4: Render the aggregate fallback count**

In the discovery diagnostics table, add:

```tsx
<th scope="col">Fallback</th>
```

between `Triaged` and `Assessed`, and add:

```tsx
<td>{diagnostic.fallbackTriaged ?? 0}</td>
```

in the matching row position. Do not add tooltips, titles, candidate links, or
evidence details.

- [ ] **Step 5: Run repository and web suites**

Run:

```bash
npx vitest run tests/integration/db/repository.test.ts tests/unit/web/RunStatusPage.test.tsx
npm run check
```

Expected: current and historical diagnostics render, repository persistence is
unchanged except for the optional aggregate, and type checking passes.

- [ ] **Step 6: Commit durable visibility**

```bash
git add tests/integration/db/repository.test.ts src/web/pages/RunStatusPage.tsx tests/unit/web/RunStatusPage.test.tsx
git commit -m "feat: show research fallback diagnostics"
```

---

### Task 5: Whole-feature verification and review

**Files:**
- Review: all files changed by Tasks 1-4
- Update only if verification evidence needs correction: `docs/superpowers/plans/2026-08-11-bounded-research-near-match-fallback.md`

**Interfaces:**
- Consumes: the complete Tasks 1-4 feature.
- Produces: verified implementation evidence ready for preview deployment review.

- [ ] **Step 1: Run the complete non-Worker test suite**

```bash
npm test
```

Expected: every test passes. If the sandbox blocks an approved OAuth or
loopback fixture, rerun the exact command with the repository's established
unsandboxed permission and record both results.

- [ ] **Step 2: Run the complete Worker/D1 suite**

```bash
npm run test:worker
```

Expected: every Worker/D1 test passes. Use the approved unsandboxed rerun only
for a confirmed loopback permission failure.

- [ ] **Step 3: Run static, evaluator, build, and diff gates**

```bash
npm run check
npm run evaluate
npm run build
git diff --check HEAD~4..HEAD
```

Expected:

- TypeScript exits `0`;
- evaluator precision remains at or above its configured `0.80` floor;
- Vite build exits `0`; and
- diff check has no output.

- [ ] **Step 4: Run privacy and scope scans**

```bash
rg -n "dangerouslySetInnerHTML|innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write" src
rg -n "fallbackTriaged|near_match|fallbackTarget|fallbackMinimumTopicalFit" src tests
git diff --name-only 8133a53..HEAD
```

Expected: no trusted-HTML match; fallback terms occur only in triage,
diagnostics, pipeline, authenticated Run Status, and their tests; no source
adapter, model-provider, OAuth, secret, deployment, or migration file changed.

- [ ] **Step 5: Perform mutation-sensitive checks**

Temporarily change the production fallback floor from `0.35` to `0.50` and run
the sparse-funnel test; it must fail because fallback admissions disappear.
Restore the floor. Temporarily remove the configured-topic requirement and run
the triage fallback test; it must fail because the topicless candidate is
admitted. Restore the requirement and rerun both focused tests green.

- [ ] **Step 6: Request independent code review**

Use `superpowers:requesting-code-review` against the exact Task 1-4 commit
range. Require the reviewer to check:

- normal queue ordering is unchanged;
- exact `0.35`, `0.50`, `6`, and `24` boundaries;
- core-before-adjacent fallback ordering;
- shared family/publisher caps;
- degraded and hard-stop behavior;
- replay-safe fallback diagnostics;
- historical schema compatibility; and
- absence of provider text, embeddings, identities, or unrestricted URLs in
  diagnostics.

- [ ] **Step 7: Address findings and rerun affected gates**

Use `superpowers:receiving-code-review` before changing code. Reproduce each
accepted Critical or Important finding with a failing test, implement the
smallest fix, rerun focused and complete affected suites, and commit the fix
separately. Do not accept a finding solely because it was suggested.

- [ ] **Step 8: Verify the final repository state**

```bash
git status --short --branch
git log --oneline -6
git diff --check 8133a53..HEAD
```

Expected: clean worktree, only reviewed commits after design commit `8133a53`,
and no diff-check output. Stop before deployment and request separate preview
authorization.
