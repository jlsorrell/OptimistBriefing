# Research-First Partial Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect the three highest-priority research slots, retain minimally diverse news when it survives existing quality gates, and publish an honest partial edition whenever validated research survives without complete news coverage.

**Architecture:** Preserve the existing shortlist scores and section limits. Expose the complete score-ordered morning candidate list alongside the existing capped `morningBrief`, then use a small pure workflow helper to admit featured research, one nonlocal candidate, one local candidate, and finally the remaining globally ranked candidates. Change composition status classification so research is the only mandatory publication requirement; missing news remains visible in metadata and produces `partial`, not `failed`.

**Tech Stack:** TypeScript 5.8, Zod 3, Vitest 4, Cloudflare Workers, D1, Cloudflare Workflows, Wrangler 4.

## Global Constraints

- Research remains mandatory and is admitted before news.
- Keep the existing maximum of three featured-research entries and total morning capacity of eight.
- Do not lower research or news quality thresholds, restore rejected candidates, synthesize filler, or add model calls.
- Preserve the current global score/date/ID ordering for all non-reserved capacity.
- Preserve research-radar admission only for capacity left after the morning selection.
- Preserve `missingSections` and `sourceFailures` exactly as coverage diagnostics; do not hide missing news.
- A news-only or empty edition must remain `failed` and unpublished.
- Do not change URLs, identifiers, source roles, access levels, provider-text normalization, model budgets, schemas, migrations, credentials, schedules, or source policies.
- Do not repair AP, Reuters, or GDELT in this change; source reliability is a separate follow-on project.
- Use strict RED/GREEN TDD for every production behavior change.
- Do not deploy, trigger a paid canary, mutate remote D1, push, or open a pull request without separate user authorization after implementation and review.

## File Map

- `src/editorial/shortlist.ts`: owns score ordering and section-limited candidate families; will expose the full eligible morning ranking without changing the existing capped `morningBrief` contract.
- `src/workflow/research-first-morning.ts`: new pure admission helper for featured research, one nonlocal candidate, one local candidate, and global fill.
- `src/workflow/run-editorial-pipeline.ts`: wires the pure helper into the production shortlist stage and leaves radar handling unchanged.
- `src/workflow/compose-edition.ts`: classifies any validated research-bearing incomplete edition as `partial`.
- `tests/unit/editorial/shortlist.test.ts`: proves the full ranking retains an eligible nonlocal candidate below the old cutoff.
- `tests/unit/workflow/research-first-morning.test.ts`: proves deterministic canary-shaped admission, capacity bounds, ordering, and inverse cases.
- `tests/integration/workflow/manual-run.test.ts`: proves real production shortlist wiring and publication semantics through the Worker/D1 test harness.
- `docs/superpowers/specs/2026-08-11-research-first-partial-briefing-design.md`: approved design; update only the ranking implementation note discovered during planning.

---

### Task 1: Preserve the complete eligible morning ranking

**Files:**
- Modify: `src/editorial/shortlist.ts`
- Modify: `tests/unit/editorial/shortlist.test.ts`
- Modify: `docs/superpowers/specs/2026-08-11-research-first-partial-briefing-design.md`

**Interfaces:**
- Extend `Shortlist` with `rankedMorningCandidates: (Item | NewsDevelopment)[]`.
- Keep `morningBrief` capped by `budgets.morningBrief`; no existing consumer receives more selected items.
- `rankedMorningCandidates` is an internal decision surface, not a persisted artifact or schema.

- [ ] **Step 1: Add a failing full-ranking regression**

In `tests/unit/editorial/shortlist.test.ts`, add a canary-shaped case using the existing `item`, `development`, `researchScore`, and `newsScore` helpers. Create three qualifying research papers, five high-scoring local developments, and one slightly lower-scoring world development. Use the normal eight-entry budget.

```ts
it("retains eligible candidates below the capped morning cutoff", () => {
  const research = [
    itemWithText("research-a", "Mechanistic interpretability for oversight"),
    itemWithText("research-b", "Capability elicitation for hidden abilities"),
    itemWithText("research-c", "Debate-based oversight for language models"),
  ];
  const local = Array.from({ length: 5 }, (_, index) =>
    development(item(`local-${index + 1}`, "baltimore", "article", {
      section: "baltimore",
    })),
  );
  const world = development(item("world-reserve", "world", "article", {
    section: "world",
  }));
  const candidates = [...research, ...local, world];
  const scores = [
    researchScore("research-a", 0.99),
    researchScore("research-b", 0.98),
    researchScore("research-c", 0.97),
    ...local.map((candidate, index) =>
      newsScore(candidate.id, 0.96 - index * 0.01),
    ),
    newsScore(world.id, 0.90),
  ];

  const result = shortlist(candidates, scores, preferences, budgets);

  expect(result.morningBrief).toHaveLength(8);
  expect(result.morningBrief.map(({ id }) => id)).not.toContain(world.id);
  expect(result.rankedMorningCandidates.map(({ id }) => id)).toEqual([
    "research-a",
    "research-b",
    "research-c",
    ...local.map(({ id }) => id),
    world.id,
  ]);
});
```

If the precise research order differs because topic diversity precedes total score, make all three papers use distinct configured topics and assert the actual deterministic order explicitly. Do not weaken the assertion to `arrayContaining`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/editorial/shortlist.test.ts -t "retains eligible candidates below the capped morning cutoff"
```

Expected: FAIL at compile/runtime because `rankedMorningCandidates` does not exist.

- [ ] **Step 3: Expose the full ranking without changing the capped list**

In `src/editorial/shortlist.ts`, extend the type:

```ts
export type Shortlist = {
  morningBrief: (Item | NewsDevelopment)[];
  rankedMorningCandidates: (Item | NewsDevelopment)[];
  researchFeatured: Item[];
  researchRadar: Item[];
  world: NewsDevelopment[];
  technology: NewsDevelopment[];
  aiPolicy: NewsDevelopment[];
  dmv: NewsDevelopment[];
  baltimore: NewsDevelopment[];
  forecastSignals: NewsDevelopment[];
  exclusions: ShortlistExclusion[];
};
```

Replace the inline capped call with an uncapped local followed by the current cap:

```ts
const rankedMorningCandidates = uniqueMorningBrief(
  featured,
  [
    ...world,
    ...technology,
    ...aiPolicy,
    ...local,
    ...forecastSignals,
  ],
);
const morningBrief = rankedMorningCandidates.slice(0, budgets.morningBrief);
```

Return both arrays. Do not change `uniqueMorningBrief`, its score/date/ID comparator, or any section limit.

- [ ] **Step 4: Verify GREEN and existing shortlist behavior**

Run:

```bash
npx vitest run tests/unit/editorial/shortlist.test.ts
npm run check
```

Expected: all shortlist tests and typecheck PASS; existing `morningBrief` length/order assertions remain unchanged.

- [ ] **Step 5: Correct the approved design's implementation note**

In the Selection Design section, replace the sentence saying the capped `morningBrief` alone is sufficient with:

```md
The shortlist calculation already computes the complete global score/date/ID
order before applying the morning cap. It will expose that full eligible order
as an internal, non-persisted decision surface while retaining the existing
capped `morningBrief` output. Section lists identify coverage-family IDs, and
the workflow selects the first matching ID from the full ranking without
rescoring or inventing a second tie-break rule.
```

- [ ] **Step 6: Review and commit Task 1**

Run:

```bash
git diff --check
git diff -- src/editorial/shortlist.ts tests/unit/editorial/shortlist.test.ts docs/superpowers/specs/2026-08-11-research-first-partial-briefing-design.md
git add src/editorial/shortlist.ts tests/unit/editorial/shortlist.test.ts docs/superpowers/specs/2026-08-11-research-first-partial-briefing-design.md
git commit -m "refactor: expose complete morning ranking"
```

Expected: one focused commit; no production behavior changes yet.

---

### Task 2: Assemble the morning briefing with research-first coverage admission

**Files:**
- Create: `src/workflow/research-first-morning.ts`
- Create: `tests/unit/workflow/research-first-morning.test.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `tests/integration/workflow/manual-run.test.ts`

**Interfaces:**

```ts
export type MorningSelection = {
  id: string;
  section: EditionSection;
};

export function assembleResearchFirstMorning(
  selected: Shortlist,
  budgets: Pick<SectionBudgets, "morningBrief" | "featuredResearch">,
): MorningSelection[];
```

The helper must be deterministic, preserve the full ranking for fill slots, never duplicate IDs, and return no more than `morningBrief` entries.

- [ ] **Step 1: Add the pure-helper RED tests**

Create `tests/unit/workflow/research-first-morning.test.ts`. Reuse actual `Item` and `NewsDevelopment` fixtures, but construct the `Shortlist` explicitly so the admission contract is isolated from score calculation.

Define these local factories at the top of the test file:

```ts
import { describe, expect, it } from "vitest";

import type { Item } from "../../../src/contracts/editorial";
import {
  clusterNews,
  type NewsDevelopment,
} from "../../../src/editorial/cluster";
import type { Shortlist } from "../../../src/editorial/shortlist";
import { assembleResearchFirstMorning } from
  "../../../src/workflow/research-first-morning";

const NOW = "2026-08-11T09:00:00.000Z";

function item(
  id: string,
  section: "research" | "world" | "technology" | "ai_policy" | "dmv" | "baltimore" | "forecast",
): Item {
  const research = section === "research";
  return {
    id,
    kind: research ? "paper" : section === "forecast" ? "forecast" : "article",
    canonicalUrl: `https://example.com/${id}`,
    title: `Title ${id}`,
    publishedAt: NOW,
    sourceRefs: [{
      id: `source-${id}`,
      name: `Source ${id}`,
      url: `https://example.com/${id}`,
      role: section === "forecast" ? "forecast" : research ? "primary" : "reporting",
      retrievedAt: NOW,
    }],
    accessLevel: "abstract",
    primaryTopic: section,
    tags: [section],
    normalizedText: `Evidence ${id}`,
    metadata: research ? {} : {
      primarySection: section,
      sectionEligibility: [section],
    },
    createdAt: NOW,
    expiresAt: null,
  };
}

function research(id: string): Item {
  return item(id, "research");
}

function news(
  id: string,
  section: "world" | "technology" | "ai_policy" | "dmv" | "baltimore" | "forecast",
): NewsDevelopment {
  const value = clusterNews([item(id, section)], {})[0];
  if (value === undefined) throw new Error(`Missing development ${id}.`);
  return value;
}

function shortlistFixture(input: {
  ranked: readonly (Item | NewsDevelopment)[];
  featured?: readonly Item[];
  world?: readonly NewsDevelopment[];
  technology?: readonly NewsDevelopment[];
  aiPolicy?: readonly NewsDevelopment[];
  dmv?: readonly NewsDevelopment[];
  baltimore?: readonly NewsDevelopment[];
  forecast?: readonly NewsDevelopment[];
}): Shortlist {
  return {
    morningBrief: [...input.ranked.slice(0, 8)],
    rankedMorningCandidates: [...input.ranked],
    researchFeatured: [...(input.featured ?? [])],
    researchRadar: [],
    world: [...(input.world ?? [])],
    technology: [...(input.technology ?? [])],
    aiPolicy: [...(input.aiPolicy ?? [])],
    dmv: [...(input.dmv ?? [])],
    baltimore: [...(input.baltimore ?? [])],
    forecastSignals: [...(input.forecast ?? [])],
    exclusions: [],
  };
}
```

The primary regression must model the observed failure:

```ts
it("keeps research first and admits nonlocal news below a local-heavy cutoff", () => {
  const researchA = research("research-a");
  const researchB = research("research-b");
  const researchC = research("research-c");
  const locals = Array.from({ length: 5 }, (_, index) =>
    news(`local-${index + 1}`, "baltimore"),
  );
  const worldReserve = news("world-reserve", "world");
  const selected = shortlistFixture({
    ranked: [
      researchA,
      researchB,
      researchC,
      ...locals,
      worldReserve,
    ],
    featured: [researchA, researchB, researchC],
    world: [worldReserve],
    baltimore: locals,
  });

  expect(assembleResearchFirstMorning(selected, {
    morningBrief: 8,
    featuredResearch: 3,
  })).toEqual([
    { id: "research-a", section: "research" },
    { id: "research-b", section: "research" },
    { id: "research-c", section: "research" },
    { id: "world-reserve", section: "world" },
    { id: "local-1", section: "baltimore" },
    { id: "local-2", section: "baltimore" },
    { id: "local-3", section: "baltimore" },
    { id: "local-4", section: "baltimore" },
  ]);
});
```

Add these inverse cases:

1. no nonlocal candidate: featured research, best local, then global fill;
2. no local candidate: featured research, best nonlocal, then global fill;
3. no news: featured research only;
4. capacity smaller than reservations: featured research consumes capacity first;
5. zero capacity: empty array;
6. candidate present in multiple section arrays: emitted once;
7. forecast candidate: never satisfies local/nonlocal reservation but remains eligible during global fill;
8. shuffled section arrays with the same full ranking: identical output, proving the full rank is authoritative.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/workflow/research-first-morning.test.ts
```

Expected: FAIL because the module/function does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

Create `src/workflow/research-first-morning.ts`:

```ts
import type { EditionSection } from "../contracts/editorial";
import type {
  SectionBudgets,
  Shortlist,
} from "../editorial/shortlist";

export type MorningSelection = {
  id: string;
  section: EditionSection;
};

function selectionFor(
  candidate: Shortlist["rankedMorningCandidates"][number],
): MorningSelection {
  return "representativeItem" in candidate
    ? { id: candidate.id, section: candidate.primarySection }
    : { id: candidate.id, section: "research" };
}

function ids(values: readonly { id: string }[]): ReadonlySet<string> {
  return new Set(values.map(({ id }) => id));
}

export function assembleResearchFirstMorning(
  selected: Shortlist,
  budgets: Pick<SectionBudgets, "morningBrief" | "featuredResearch">,
): MorningSelection[] {
  const maximum = Math.max(0, budgets.morningBrief);
  const result: MorningSelection[] = [];
  const selectedIds = new Set<string>();
  const ranked = selected.rankedMorningCandidates.map(selectionFor);
  const nonlocalIds = ids([
    ...selected.world,
    ...selected.technology,
    ...selected.aiPolicy,
  ]);
  const localIds = ids([...selected.dmv, ...selected.baltimore]);

  const admit = (candidate: MorningSelection | undefined): void => {
    if (
      candidate === undefined ||
      result.length >= maximum ||
      selectedIds.has(candidate.id)
    ) return;
    result.push(candidate);
    selectedIds.add(candidate.id);
  };

  for (const item of selected.researchFeatured.slice(
    0,
    Math.min(budgets.featuredResearch, maximum),
  )) {
    admit({ id: item.id, section: "research" });
  }
  admit(ranked.find((candidate) => nonlocalIds.has(candidate.id)));
  admit(ranked.find((candidate) => localIds.has(candidate.id)));
  for (const candidate of ranked) admit(candidate);

  return result;
}
```

Do not sort inside this helper and do not select from section-array order.

- [ ] **Step 4: Verify helper GREEN**

Run:

```bash
npx vitest run tests/unit/workflow/research-first-morning.test.ts
npm run check
```

Expected: all new tests PASS.

- [ ] **Step 5: Wire the helper into the production shortlist stage**

In `src/workflow/run-editorial-pipeline.ts`, import `assembleResearchFirstMorning`. Replace the current `featured`, `reservedIds`, `rankedMorning`, and `morning` block with:

```ts
const morning = assembleResearchFirstMorning(selected, budgets);
const morningIds = new Set(morning.map(({ id }) => id));
```

Leave the existing radar calculation, diagnostic rejection, `ordered` cap, ID lookup, section metadata, selection reasons, and research-tier assignment unchanged.

- [ ] **Step 6: Add a production-wiring RED/GREEN regression**

In `tests/integration/workflow/manual-run.test.ts`, add a test beside `reserves qualified featured research ahead of higher-scoring news` that drives the real `createProductionPipelineContext` stages through `context.shortlist`.

Use three qualifying research papers, five distinct high-scoring Baltimore/DMV candidates, and a lower-scoring world candidate that is present in the section-limited candidate pool but falls below the old eight-entry global cutoff. Assert exactly:

```ts
expect(shortlisted).toHaveLength(8);
expect(shortlisted.slice(0, 3).map(({ metadata }) => metadata.section))
  .toEqual(["research", "research", "research"]);
expect(shortlisted.map(({ metadata }) => metadata.section))
  .toContain("world");
expect(shortlisted.map(({ metadata }) => metadata.section))
  .toContain("baltimore");
expect(new Set(shortlisted.map(({ id }) => id)).size).toBe(8);
```

Also run the same candidates in reverse input order and assert identical selected ID order. Tune only fixture evidence/signals needed to reproduce the score ordering; do not alter production weights or thresholds.

Run first against the pre-wiring code to prove RED (world absent), then after wiring to prove GREEN:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "admits nonlocal news below a local-heavy cutoff"
```

If Miniflare reports `listen EPERM 127.0.0.1` in the sandbox, rerun the identical command with the approved unsandboxed test permission. Do not replace the Worker test with a weaker mock.

- [ ] **Step 7: Run affected selection suites**

Run:

```bash
npx vitest run tests/unit/editorial/shortlist.test.ts tests/unit/workflow/research-first-morning.test.ts
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "featured research|local-heavy cutoff|authoritative morning brief"
npm run check
git diff --check
```

Expected: all selected tests PASS; no duplicate IDs, capacity overflow, or radar regression.

- [ ] **Step 8: Review and commit Task 2**

Inspect the complete diff and explicitly confirm there is no new sorting, score calculation, model call, persisted field, or diagnostic suppression.

```bash
git diff --check
git diff -- src/workflow/research-first-morning.ts src/workflow/run-editorial-pipeline.ts tests/unit/workflow/research-first-morning.test.ts tests/integration/workflow/manual-run.test.ts
git add src/workflow/research-first-morning.ts src/workflow/run-editorial-pipeline.ts tests/unit/workflow/research-first-morning.test.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: preserve research-first news coverage"
```

---

### Task 3: Publish incomplete research briefings as partial

**Files:**
- Modify: `src/workflow/compose-edition.ts`
- Modify: `tests/integration/workflow/manual-run.test.ts`

**Behavior matrix:**

| Validated entries | Missing coverage | Status |
|---|---|---|
| 6–8 with research, nonlocal, local | none | `published` |
| research + local | `nonlocal_news` | `partial` |
| research + nonlocal | `dmv_or_baltimore` | `partial` |
| research only | both news labels | `partial` |
| news only | `research` | `failed` |
| none | all labels | `failed` |

- [ ] **Step 1: Add direct composition RED cases**

Near the existing direct `composeEdition` tests in `tests/integration/workflow/manual-run.test.ts`, add a table-driven status test. Use `fixtureItem`, `fixtureSummary`, and `fixturePipelineContext`; pass all candidate Items as `persistedItems`.

```ts
it.each([
  {
    name: "research with local but no nonlocal news",
    sections: ["research", "dmv"],
    status: "partial",
    missingSections: ["nonlocal_news"],
  },
  {
    name: "research with nonlocal but no local news",
    sections: ["research", "world"],
    status: "partial",
    missingSections: ["dmv_or_baltimore"],
  },
  {
    name: "research only",
    sections: ["research"],
    status: "partial",
    missingSections: ["nonlocal_news", "dmv_or_baltimore"],
  },
  {
    name: "news only",
    sections: ["world", "dmv"],
    status: "failed",
    missingSections: ["research"],
  },
  {
    name: "no valid entries",
    sections: [],
    status: "failed",
    missingSections: ["research", "nonlocal_news", "dmv_or_baltimore"],
  },
])("classifies $name", async ({ sections, status, missingSections }) => {
  const items = sections.map((section, index) =>
    fixtureItem(`composition-${section}-${index}`, section),
  );
  const composition = await composeEdition(
    fixturePipelineContext({ runId: `compose-${sections.join("-") || "empty"}` }),
    items.map((item) => ({
      item,
      summary: fixtureSummary(item),
      valid: true,
    })),
    items,
  );

  expect(composition.status).toBe(status);
  expect(composition.missingSections).toEqual(missingSections);
  expect(composition.edition.metadata?.missingSections).toEqual(missingSections);
});
```

The existing six-entry complete publication test remains the `published` case. Do not manufacture six duplicate entries for the new incomplete cases.

- [ ] **Step 2: Run the selected composition tests and verify RED**

Run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "classifies research|classifies news|classifies no valid|collects, validates"
```

Expected before the change: the research-bearing cases with missing coverage return `failed`; news-only, empty, and complete cases retain their expected behavior.

- [ ] **Step 3: Implement research-mandatory status classification**

In `src/workflow/compose-edition.ts`, replace only the final booleans:

```ts
const complete =
  entries.length >= 6 &&
  entries.length <= 8 &&
  missing.length === 0;
const hasResearch = entries.some((entry) => entry.section === "research");
const partial = !complete && hasResearch;
```

Keep the existing ternary return, entry slicing, missing-section calculation, source failures, and persisted metadata unchanged. `research_radar` alone does not satisfy the mandatory featured-research rule.

- [ ] **Step 4: Verify direct composition GREEN**

Rerun the command from Step 2. Expected: every matrix row PASS.

- [ ] **Step 5: Convert the real research-only pipeline regression**

Replace `leaves a failed minimum draft unpublished and preserves the prior edition` with `publishes a research-only partial edition with honest missing coverage`.

Keep the synthesis override that permits only the `research` item, but change assertions to:

```ts
await expect(runEditorialPipeline(context)).resolves.toMatchObject({
  status: "partial",
  missingSections: ["nonlocal_news", "dmv_or_baltimore"],
});
await expect(context.store.getLatestEdition()).resolves.toMatchObject({
  runId: "run-research-only-partial",
  status: "partial",
  metadata: {
    missingSections: ["nonlocal_news", "dmv_or_baltimore"],
  },
  entries: [expect.objectContaining({ section: "research" })],
});
```

Retain the existing prior edition setup and additionally assert the new partial, rather than the prior edition, is latest. This proves useful research becomes visible without deleting history.

Keep `fails six valid entries when they omit required coverage` unchanged and rerun it to prove news-only editions still fail with `MINIMUM_COVERAGE_FAILED`.

- [ ] **Step 6: Run the full publication boundary tests**

Run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "source-partial|research-only partial|omit required coverage|collects, validates"
npm run check
git diff --check
```

Expected:

- complete six-entry edition: `published`;
- three-entry research/nonlocal/local edition: `partial`;
- research-only edition: persisted `partial` with both news labels;
- six news-only entries: `failed`, no latest edition;
- failed status still maps to `MINIMUM_COVERAGE_FAILED`; partial does not.

- [ ] **Step 7: Review and commit Task 3**

```bash
git diff --check
git diff -- src/workflow/compose-edition.ts tests/integration/workflow/manual-run.test.ts
git add src/workflow/compose-edition.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: publish research-first partial briefings"
```

Expected: no schema, repository, UI, or run-control changes; existing partial persistence handles the new classification.

---

### Task 4: Complete verification and review before any deployment

**Files:**
- Modify only if a test exposes an in-scope defect.
- Do not modify reports merely to make a failing gate appear green.

- [ ] **Step 1: Run focused unit suites**

```bash
npx vitest run tests/unit/editorial/shortlist.test.ts tests/unit/workflow/research-first-morning.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the complete non-Worker suite**

```bash
npm test
```

Expected: all files/tests PASS. If a managed-OAuth sandbox fixture fails, rerun the identical command with the already-approved unsandboxed permission and report both outputs; do not exclude the file.

- [ ] **Step 3: Run the complete Worker/D1 suite**

```bash
npm run test:worker
```

Expected: all Worker/D1 tests PASS. If Miniflare reports loopback `EPERM`, rerun the identical command unsandboxed.

- [ ] **Step 4: Run static, editorial, and build gates**

```bash
npm run check
npm run evaluate
npm run build
git diff --check 8708034..HEAD
```

Expected:

- typecheck PASS;
- evaluator PASS with precision@5 at or above 0.80 and all research/routing/grounding assertions green;
- Vite production build PASS;
- diff check produces no output.

- [ ] **Step 5: Run mutation-sensitive spot checks**

Temporarily restore the old featured-plus-capped-global-fill block in the working tree and run:

```bash
npx vitest run tests/unit/workflow/research-first-morning.test.ts -t "local-heavy cutoff"
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "local-heavy cutoff"
```

Expected: both regressions FAIL because the world candidate disappears. Restore the implementation with `apply_patch` (never `git checkout --` or reset).

Temporarily restore `const partial = !complete && missing.length === 0;` and run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "research-only partial|classifies research"
```

Expected: the research-only and missing-news research cases FAIL. Restore the approved implementation with `apply_patch`.

- [ ] **Step 6: Rerun touched gates after mutation restoration**

```bash
npx vitest run tests/unit/workflow/research-first-morning.test.ts
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "local-heavy cutoff|research-only partial|omit required coverage"
npm run check
git diff --check 8708034..HEAD
```

Expected: PASS and clean diff check.

- [ ] **Step 7: Request independent read-only code review**

Review the exact diff `8708034..HEAD` for:

- research-first ordering and capacity bounds;
- full-ranking versus capped-list lifecycle;
- no candidate duplication;
- no quality-threshold, score, model-call, or persistence drift;
- missing-section truthfulness;
- research-only partial and news-only failure semantics;
- test mutation sensitivity and exact verification evidence.

Address every Critical or Important finding with RED/GREEN coverage, then rerun all affected and full gates. Do not commit review fixes without verification.

- [ ] **Step 8: Create the final reviewed commit only if needed**

If review fixes or test-strength changes remain uncommitted:

```bash
git add <reviewed-files-only>
git commit -m "test: harden research-first briefing policy"
```

Then confirm:

```bash
git status --short
git log --oneline 8708034..HEAD
git diff --check 8708034..HEAD
```

Expected: clean worktree and only the reviewed implementation commits.

- [ ] **Step 9: Stop before external changes**

Report:

- commit SHAs;
- exact focused/full test counts;
- evaluator and build results;
- independent review verdict;
- confirmation that production, preview, remote D1, schedules, source policies, secrets, and model budgets were not changed.

Ask for separate authorization before pushing, opening a pull request, deploying preview, or starting a new paid canary. If preview is later approved, create a fresh edition-date run rather than modifying the completed `2026-08-10` audit history.
