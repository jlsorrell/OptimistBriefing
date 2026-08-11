# Tiered Research Relevance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill featured Research slots with direct technical-interest matches first, then use strong broader AI-safety work only when direct matches do not fill the available capacity.

**Architecture:** Add a deterministic relevance classifier that labels already routed research as `core` or `adjacent` from bounded normalized evidence. Preserve existing embedding, assessment, score, and quality gates; change only featured Research selection order and append one bounded human-readable reason to selected items.

**Tech Stack:** TypeScript 5.8, Zod 3, existing editorial Item/ItemScore contracts, Vitest 4, golden-set evaluator.

**Design specification:** `docs/superpowers/specs/2026-08-07-research-relevance-and-source-reliability-design.md`

## Global Constraints

- Core means a concrete match to one of the reader's approved technical-interest families.
- Generic `AI safety`, `alignment`, `governance`, `evaluation`, `AI ethics`, or `interpretability` alone does not establish core relevance.
- Ambiguous acronyms such as `MPC`, `FHE`, and `ZKP` require machine-learning or cryptographic context.
- Every adjacent candidate must pass the same topical-fit, technical-quality, authority, access, grounding, score, and freshness gates as a core candidate.
- Core candidates consume featured Research capacity before adjacent candidates, even when an adjacent candidate has a higher aggregate score.
- Adjacent candidates fill remaining capacity when fewer than three qualified core papers are available.
- Featured Research remains capped at `3`; budgets are maxima, not quotas.
- Do not add an LLM call, embedding call, schema migration, provider request, or persisted vector.
- Preserve existing topic diversity within each tier and deterministic tie-breaking.
- Research Radar behavior remains score-based after featured IDs are removed.
- Use strict TDD and commit each independently passing task.
- Do not deploy or run a paid preview canary without separate authorization.

---

### Task 1: Deterministic relevance-tier classifier

**Files:**
- Create: `src/editorial/research-relevance.ts`
- Create: `tests/unit/editorial/research-relevance.test.ts`

**Interfaces:**
- Produces: `ResearchRelevanceTierSchema = z.enum(["core", "adjacent"])`.
- Produces: `ResearchRelevanceTier`.
- Produces: `classifyResearchRelevance(item: Item): ResearchRelevanceTier`.
- Produces: `researchRelevanceReason(tier): string`.

- [ ] **Step 1: Write the failing classifier table tests**

Create a small `paper(text, primaryTopic)` Item fixture and use table tests:

```ts
it.each([
  ["Mechanistic analysis of internal concept representations during training", "alignment-interpretability"],
  ["A theoretical model of phase transitions in neural scaling laws", "alignment-interpretability"],
  ["Eliciting hidden capabilities from sandbagging language models", "alignment-interpretability"],
  ["AI safety via debate as a scalable oversight protocol", "alignment-interpretability"],
  ["A game-theoretic model of strategic multi-agent learning", "alignment-interpretability"],
  ["Cryptographic verification of neural network inference", "oversight-governance"],
  ["A secure evaluation framework for frontier models", "oversight-governance"],
  ["Zero-knowledge proofs for machine-learning model evaluation", "secure-computation-ml"],
] as const)("classifies %s as core", (text, topic) => {
  expect(classifyResearchRelevance(paper(text, topic))).toBe("core");
});

it.each([
  "Expert perspectives on AI safety and ethics",
  "A governance framework for responsible artificial intelligence",
  "Interpretability challenges in modern AI",
  "Evaluation practices for aligned systems",
  "MPC performance for database transactions",
] as const)("keeps broader or ambiguous work adjacent: %s", (text) => {
  expect(classifyResearchRelevance(
    paper(text, "alignment-interpretability"),
  )).toBe("adjacent");
});
```

Also test full-text evidence, title-only evidence, NFKC/case normalization,
secure-computation co-occurrence, invalid non-research kinds, and exact reason
strings:

```ts
expect(researchRelevanceReason("core"))
  .toBe("Direct technical-interest match.");
expect(researchRelevanceReason("adjacent"))
  .toBe("Broader research match used as fallback.");
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run tests/unit/editorial/research-relevance.test.ts
```

Expected: FAIL because the classifier module does not exist.

- [ ] **Step 3: Implement bounded positive-evidence families**

Create `src/editorial/research-relevance.ts` with normalized bounded text and
explicit predicates:

```ts
import { z } from "zod";
import { ItemSchema, type Item } from "../contracts/editorial";

export const ResearchRelevanceTierSchema = z.enum(["core", "adjacent"]);
export type ResearchRelevanceTier = z.infer<typeof ResearchRelevanceTierSchema>;

const CORE_EVIDENCE_LIMIT = 20_000;

function searchable(item: Item): string {
  return [item.title, item.primaryTopic, item.normalizedText]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .slice(0, CORE_EVIDENCE_LIMIT);
}

const directPredicates: readonly ((text: string) => boolean)[] = [
  (text) => /\b(?:internal|latent|distributed|concept) representations?\b/.test(text) &&
    /\b(?:training|learning|model|network|transformer)\b/.test(text),
  (text) => /\b(?:mechanistic interpretability|representation-level interpretability)\b/.test(text),
  (text) => /\b(?:theor(?:y|etical)|mathematical model|phase transition)\b/.test(text) &&
    /\b(?:emergen(?:ce|t)|learning dynamics|scaling law|neural scaling)\b/.test(text),
  (text) => /\b(?:capabilit(?:y|ies) elicitation|hidden capabilities|latent capabilities|sandbagging)\b/.test(text),
  (text) => /\b(?:ai safety via debate|debate protocol|debate-based oversight)\b/.test(text),
  (text) => /\bgame[- ]theoretic\b/.test(text) && /\bmulti[- ]agent\b/.test(text),
  (text) => /\b(?:cryptographic verification|proof[- ]of[- ]learning|verifiable training|verifiable inference)\b/.test(text) &&
    /\b(?:training|inference|provenance|evaluation|model|learning)\b/.test(text),
  (text) => /\b(?:secure|verifiable) evaluation frameworks?\b/.test(text) &&
    /\b(?:ai|model|machine learning|neural network|frontier)\b/.test(text),
  (text) => /\b(?:fully homomorphic encryption|homomorphic encryption|multi[- ]?party computation|zero[- ]knowledge proofs?|functional encryption|\bfhe\b|\bmpc\b|\bzkp\b)\b/.test(text) &&
    /\b(?:machine learning|neural network|model training|model inference|secure inference)\b/.test(text),
];

export function classifyResearchRelevance(input: Item): ResearchRelevanceTier {
  const item = ItemSchema.parse(input);
  if (item.kind !== "paper" && item.kind !== "blog") {
    throw new TypeError("Research relevance requires a paper or blog item.");
  }
  const text = searchable(item);
  return directPredicates.some((predicate) => predicate(text))
    ? "core"
    : "adjacent";
}

export function researchRelevanceReason(tier: ResearchRelevanceTier): string {
  return ResearchRelevanceTierSchema.parse(tier) === "core"
    ? "Direct technical-interest match."
    : "Broader research match used as fallback.";
}
```

Keep predicates free of global regex state. Do not read authors, institutions,
source prestige, citation counts, model output, or embeddings.

- [ ] **Step 4: Verify and commit the classifier**

Run:

```bash
npx vitest run tests/unit/editorial/research-relevance.test.ts
npm run check
git add src/editorial/research-relevance.ts tests/unit/editorial/research-relevance.test.ts
git commit -m "feat: classify direct and adjacent research relevance"
```

Expected: all classifier tests and type checking pass.

---

### Task 2: Core-first featured Research selection

**Files:**
- Modify: `src/editorial/shortlist.ts`
- Modify: `tests/unit/editorial/shortlist.test.ts`

**Interfaces:**
- Consumes: Task 1 `classifyResearchRelevance`.
- Preserves: `shortlist(...)` signature and `Shortlist` result schema.
- Produces: core-first ordering only for `researchFeatured`.

- [ ] **Step 1: Write failing featured-selection tests**

Extend the item fixture with a final evidence argument and add a convenience
wrapper:

```ts
function item(
  id: string,
  primaryTopic: string,
  kind: Item["kind"] = "paper",
  metadata: Record<string, unknown> = {},
  normalizedText = `Text ${id}`,
): Item {
  const section = typeof metadata.section === "string" ? metadata.section : null;
  return {
    id,
    kind,
    canonicalUrl: `https://example.com/${id}`,
    title: `Title ${id}`,
    publishedAt: NOW,
    sourceRefs: [{
      id: `source-${id}`,
      name: `Source ${id}`,
      url: `https://example.com/${id}`,
      role: kind === "forecast" ? "forecast" : "primary",
      retrievedAt: NOW,
    }],
    accessLevel: "abstract",
    primaryTopic,
    tags: [primaryTopic],
    normalizedText,
    metadata: kind === "paper" || kind === "blog" || section === null
      ? metadata
      : { ...metadata, primarySection: section, sectionEligibility: [section] },
    createdAt: NOW,
    expiresAt: null,
  };
}

function itemWithText(id: string, text: string): Item {
  return item(id, "alignment-interpretability", "paper", {}, text);
}
```

Then add:

```ts
it("selects a lower-scoring core paper before a higher-scoring adjacent paper", () => {
  const core = item("core", "alignment-interpretability", "paper", {},
    "Capability elicitation for hidden language-model abilities");
  const adjacent = item("adjacent", "alignment-interpretability", "paper", {},
    "Expert perspectives on AI safety and ethics");
  const result = shortlist(
    [adjacent, core],
    [researchScore(adjacent.id, 0.99), researchScore(core.id, 0.75)],
    preferences,
    { ...budgets, featuredResearch: 1 },
  );
  expect(result.researchFeatured.map(({ id }) => id)).toEqual([core.id]);
});

it("fills unused featured capacity with the best adjacent papers", () => {
  const candidates = [
    itemWithText("core", "Capability elicitation for hidden model abilities"),
    itemWithText("adjacent-high", "A broad framework for AI safety"),
    itemWithText("adjacent-low", "Expert perspectives on AI ethics"),
  ];
  const result = shortlist(
    candidates,
    [
      researchScore("core", 0.7),
      researchScore("adjacent-high", 0.95),
      researchScore("adjacent-low", 0.8),
    ],
    preferences,
    budgets,
  );
  expect(result.researchFeatured.map(({ id }) => id))
    .toEqual(["core", "adjacent-high", "adjacent-low"]);
});
```

Add cases for three core candidates excluding a higher-scoring adjacent paper,
topic diversity within core, deterministic reversed-input ordering, an empty
qualified pool, and unchanged topical-fit/technical-quality exclusions.

- [ ] **Step 2: Run shortlist tests and confirm RED**

Run:

```bash
npx vitest run tests/unit/editorial/shortlist.test.ts -t "core|adjacent|direct|fallback"
```

Expected: current score-only `diverseResearch` selects the higher-scoring
adjacent paper first.

- [ ] **Step 3: Implement tiered featured selection**

Import the classifier. Replace the featured call with a helper whose output is
still score-ordered inside each tier:

```ts
function featuredResearch(
  ranked: readonly RankedResearch[],
  configuredTopics: readonly string[],
  maximum: number,
): RankedResearch[] {
  const core = ranked.filter(({ item }) =>
    classifyResearchRelevance(item) === "core"
  );
  const adjacent = ranked.filter(({ item }) =>
    classifyResearchRelevance(item) === "adjacent"
  );
  const selectedCore = diverseResearch(core, configuredTopics, maximum);
  const selectedIds = new Set(selectedCore.map(({ item }) => item.id));
  const remaining = Math.max(0, maximum - selectedCore.length);
  const selectedAdjacent = diverseResearch(
    adjacent.filter(({ item }) => !selectedIds.has(item.id)),
    configuredTopics,
    remaining,
  );
  return [...selectedCore, ...selectedAdjacent];
}
```

Use this helper only for paper `featuredCandidates`. Keep radar construction
from all remaining qualified research and keep existing quality gates before
classification. Do not globally re-sort the concatenated result, because that
would allow an adjacent score to move ahead of core.

- [ ] **Step 4: Verify and commit selection behavior**

Run:

```bash
npx vitest run tests/unit/editorial/shortlist.test.ts tests/unit/editorial/pipeline.test.ts
npm run check
git add src/editorial/shortlist.ts tests/unit/editorial/shortlist.test.ts
git commit -m "feat: prioritize core research in featured slots"
```

Expected: all shortlist and pipeline unit tests pass; section maxima and
quality-gate tests are unchanged.

---

### Task 3: Bounded selection reasons and pipeline regression

**Files:**
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Modify: `tests/unit/editorial/pipeline.test.ts`
- Modify only if evaluator expectations intentionally change: `tests/golden/expected-rankings.json`

**Interfaces:**
- Consumes: Task 1 `classifyResearchRelevance` and `researchRelevanceReason`.
- Preserves: Workflow payload version `1`, `selectionReasons` maximum `16`, and edition entry contracts.

- [ ] **Step 1: Write failing pipeline reason tests**

Add a pipeline shortlist fixture containing one direct paper and two broader
qualified papers. Assert selected featured IDs are core-first and:

```ts
expect(workflowPayload(coreSelected).selectionReasons)
  .toContain("Direct technical-interest match.");
expect(workflowPayload(adjacentSelected).selectionReasons)
  .toContain("Broader research match used as fallback.");
expect(workflowPayload(newsSelected).selectionReasons)
  .not.toContain("Broader research match used as fallback.");
```

Also assert no abstract text, matched phrase, embedding, or classifier rule is
copied into the reason list and the list remains at most 16 entries.

- [ ] **Step 2: Run the focused pipeline test and confirm RED**

Run:

```bash
npx vitest run tests/unit/editorial/pipeline.test.ts -t "technical-interest|fallback|core-first"
```

Expected: selection order is correct after Task 2, but the bounded tier reason
is absent.

- [ ] **Step 3: Append one constant reason at the shortlist boundary**

Change the existing reason construction:

```ts
const reasons = [
  ...selectionReasons(item).slice(
    0,
    item.kind === "paper" || item.kind === "blog" ? 15 : 16,
  ),
  ...(item.kind === "paper" || item.kind === "blog"
    ? [researchRelevanceReason(classifyResearchRelevance(item))]
    : []),
];
```

Do not add a new workflow field, D1 column, or public rendering component. The
existing authenticated artifact and edition-entry selection reasons carry the
constant label.

- [ ] **Step 4: Run focused tests and evaluation**

Run:

```bash
npx vitest run tests/unit/editorial/research-relevance.test.ts tests/unit/editorial/shortlist.test.ts tests/unit/editorial/pipeline.test.ts
npm run evaluate
```

Expected: focused tests pass. If golden ranking order changes, inspect every
changed case: accept only changes where a core paper moves ahead of an adjacent
paper while all quality-gate exclusions remain identical. Record those exact
IDs in the commit message body before changing `expected-rankings.json`.

- [ ] **Step 5: Commit pipeline labeling**

Run:

```bash
git add src/workflow/run-editorial-pipeline.ts tests/unit/editorial/pipeline.test.ts tests/golden/expected-rankings.json
git commit -m "feat: explain research relevance tier selection"
```

If the golden file is unchanged, stage only the two TypeScript files.

---

### Task 4: Full relevance regression gate

**Files:**
- Verify only; modify a file only when a failing test identifies a regression caused by Tasks 1–3.

**Interfaces:**
- Produces: an independently mergeable core-first relevance stage.

- [ ] **Step 1: Run the full verification ladder**

Run:

```bash
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
git diff --check
```

Expected: all commands pass; model call counts, cost estimates, discovery lane
counts, and publication/authentication behavior remain unchanged.

- [ ] **Step 2: Inspect scope and score invariants**

Run:

```bash
git diff main...HEAD -- src/editorial src/workflow/run-editorial-pipeline.ts tests/unit/editorial tests/golden
rg -n "minimumTopicalFit|minimumTechnicalQuality|featuredResearch: 3" src/config src/editorial
```

Expected: quality thresholds and the featured maximum remain unchanged; no new
provider/model call, migration, vector persistence, or UI rendering path was
added.

- [ ] **Step 3: Commit only test-driven corrections**

If verification required a scoped correction, stage its exact files, rerun the
previously failing command, and commit with:

```bash
git commit -m "test: complete tiered research regression coverage"
```

If no correction was needed, do not create an empty commit.

---

### Task 5: Combined staged integration checkpoint

**Files:**
- Verify the completed branches from all four `2026-08-07` plans; do not modify deployment configuration.

**Interfaces:**
- Consumes: provider-text normalization, split publication policies, provider scheduling, and tiered relevance.
- Produces: one local verification record before requesting preview deployment authorization.

- [ ] **Step 1: Confirm all four stage heads are present**

Run:

```bash
git log --oneline --decorate -20
git status --short --branch
```

Expected: the working tree is clean and contains the implementation commits
from all four plans. If stages were developed in separate branches, merge them
through their reviewed pull requests before continuing; do not use a local
conflict-resolution merge as a substitute for review.

- [ ] **Step 2: Run the combined local verification ladder**

Run:

```bash
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
git diff --check origin/main...HEAD
```

Expected: every command passes with no entity artifacts in fixtures, no valid
Alignment Forum/MIT policy rejection, bounded provider concurrency, and
core-first featured selection.

- [ ] **Step 3: Review combined invariants**

Run:

```bash
rg -n "dangerouslySetInnerHTML|innerHTML\s*=" src
rg -n "minimumTopicalFit|minimumTechnicalQuality|featuredResearch: 3" src/config src/editorial
git diff --stat origin/main...HEAD
```

Expected: no trusted-HTML path exists, quality gates and the three-slot maximum
are unchanged, and there are no deployment-secret or production mutations.

- [ ] **Step 4: Pause for preview authorization**

Report the local evidence and ask separately for authorization to deploy the
reviewed build to preview and run one scoped briefing. The preview check must
confirm source outcomes, core-before-adjacent ordering, absence of literal
numeric entities, reservation reconciliation, run cost, monthly cap, and
publication result. Production promotion remains a later user decision.
