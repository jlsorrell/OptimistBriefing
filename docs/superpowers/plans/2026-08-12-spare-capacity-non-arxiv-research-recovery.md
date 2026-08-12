# Spare-Capacity Non-arXiv Research Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover eligible non-arXiv research candidates by using otherwise idle assessment capacity and restore Google Research listing extraction without weakening any downstream editorial gate.

**Architecture:** Research triage keeps its normal pass intact, then admits at most six configured-topic near-matches into remaining places under the unchanged 24-candidate maximum. The reviewed Google Research profile gains one exact, source-owned category selector for current first-party markup; every admitted candidate continues through the existing assessment, scoring, shortlist, synthesis, validation, and grounding pipeline.

**Tech Stack:** TypeScript 5.8, Zod, Vitest 4, LinkeDOM, Cloudflare Worker/D1 integration tests, Vite 7.

## Global Constraints

- Keep the absolute research-assessment maximum at exactly `24`.
- Keep the normal topical-fit threshold at exactly `0.50` and the near-match floor at exactly `0.35`.
- Admit at most `6` near-match candidates, and never allow normal plus near-match candidates to exceed `24`.
- Preserve normal-first, core-near-match-second, adjacent-near-match-third ordering.
- Share discovery-family and publisher-domain counts across normal and near-match passes.
- Allow at most `12` candidates from one publisher domain when their normalized discovery family is `arxiv`; retain the existing limit of `6` for every other discovery family.
- Do not reserve or boost a final slot for a source, family, institution, laboratory, or media type.
- Do not add a model call, embedding call, provider request, dependency, D1 migration, public configuration field, or persistence schema.
- Do not decode or normalize structural URLs, IDs, timestamps, access levels, roles, endpoint policies, or credentials as provider display text.
- Preserve candidate-level and source-level fail-open behavior and privacy-safe aggregate diagnostics.
- Do not change news discovery, ranking, coverage, or publication behavior.
- Do not modify Georgia Tech, Stanford, or Johns Hopkins endpoint/policy contracts in this plan.
- Do not deploy preview or production during implementation; the canary requires separate authorization after merge.

## File Structure

- `src/editorial/research-triage.ts` — owns near-match eligibility, allowance, ordering, and shared diversity caps.
- `src/workflow/run-editorial-pipeline.ts` — owns the production constant and passes the internal triage option; the assessment maximum remains 24.
- `tests/unit/editorial/research-triage.test.ts` — proves the allowance formula, boundaries, ordering, caps, determinism, and mutation sensitivity.
- `tests/integration/workflow/manual-run.test.ts` — proves production-shaped Papers with Code admission, assessment ordering, diagnostics, privacy, and unchanged budget behavior.
- `tests/unit/editorial/shortlist.test.ts` — characterizes that final selection depends on score and kind, not provider family.
- `src/sources/reviewed-publication-profiles.ts` — owns the exact Google Research listing selectors and bounded category extraction.
- `tests/fixtures/google-research-blog-listing.html` — models current first-party Google Research card markup plus malformed and off-policy siblings.
- `tests/unit/sources/reviewed-publication-profiles.test.ts` — proves current and legacy category extraction, exact structural preservation, bounds, and sibling isolation.
- `tests/unit/sources/publication-collector.test.ts` — proves the reviewed profile works through the real collector and reports truthful success/failure counts.
- `docs/superpowers/reports/2026-08-12-spare-capacity-non-arxiv-research-recovery.md` — records RED/GREEN evidence, mutations, verification, review, and remaining concerns.

---

### Task 1: Replace the sparse-queue target with a bounded near-match allowance

**Files:**
- Modify: `tests/unit/editorial/research-triage.test.ts:397-810`
- Modify: `tests/integration/workflow/manual-run.test.ts:7110-7350`
- Modify: `tests/unit/editorial/shortlist.test.ts:110-330`
- Modify: `src/editorial/research-triage.ts:45-56,330-380,430-470`
- Modify: `src/workflow/run-editorial-pipeline.ts:180-181,2725-2750`

**Interfaces:**
- Consumes: `triageResearch(items: readonly Item[], options: ResearchTriageOptions): ResearchTriageResult` and the existing `DiscoveryDiagnosticsTracker` fallback count.
- Produces: `ResearchTriageOptions.nearMatchAllowance?: number`; `ResearchTriageOptions.maximumPerPublisherDomainByFamily?: Partial<Record<DiscoveryFamily, number>>`; production constants `RESEARCH_NEAR_MATCH_ALLOWANCE = 6` and `RESEARCH_ARXIV_PUBLISHER_DOMAIN_MAXIMUM = 12`; unchanged admission route values `"normal" | "near_match"`.

- [ ] **Step 1: Rename the test option and write allowance-focused unit regressions before production edits**

In `tests/unit/editorial/research-triage.test.ts`, rename every focused fallback option from `fallbackTarget` to `nearMatchAllowance`. Replace the obsolete six-normal suppression assertion with this shape:

```ts
it("uses spare capacity after seven normal candidates qualify", () => {
  const normal = Array.from({ length: 7 }, (_, index) =>
    researchItem(`normal-${index}`, {
      topicalFit: 0.9 - index / 100,
      domain: `normal-${index}.example`,
    })
  );
  const nearMatches = Array.from({ length: 3 }, (_, index) =>
    researchItem(`pwc-${index}`, {
      family: "official-publication",
      topicalFit: 0.49 - index / 100,
      domain: `pwc-${index}.example`,
      normalizedText: "Capability elicitation reveals hidden model abilities.",
    })
  );

  const result = triageResearch([...nearMatches, ...normal], fallbackOptions);

  expect(result.items.map(({ id }) => id)).toEqual([
    ...normal.map(({ id }) => id),
    ...nearMatches.map(({ id }) => id),
  ]);
  expect(result.admissions.slice(7)).toEqual(
    nearMatches.map(({ id }) => ({ itemId: id, route: "near_match" })),
  );
});
```

Set `maximumPerPublisherDomainByFamily: { arxiv: 12 }` in
`fallbackOptions`. Add two explicit source-specific ceiling tests:

```ts
it("allows twelve arXiv candidates from arxiv.org", () => {
  const candidates = Array.from({ length: 13 }, (_, index) =>
    researchItem(`arxiv-${String(index).padStart(2, "0")}`, {
      family: "arxiv",
      topicalFit: 0.9,
      domain: "arxiv.org",
    })
  );
  const result = triageResearch(candidates, {
    ...fallbackOptions,
    maximumPerFamily: 24,
  });

  expect(result.items).toHaveLength(12);
  expect(result.exclusions).toContainEqual({
    itemId: "arxiv-12",
    reason: "publisher_domain_cap",
  });
});

it("keeps every non-arXiv publisher domain capped at six", () => {
  const candidates = Array.from({ length: 7 }, (_, index) =>
    researchItem(`bibliographic-${index}`, {
      family: "bibliographic",
      topicalFit: 0.9,
      domain: "openalex.org",
    })
  );
  const result = triageResearch(candidates, fallbackOptions);

  expect(result.items).toHaveLength(6);
  expect(result.exclusions).toContainEqual({
    itemId: "bibliographic-6",
    reason: "publisher_domain_cap",
  });
});
```

Add exact absolute-cap cases with diversity caps set high enough not to mask the behavior:

```ts
it.each([
  { normalCount: 20, expectedFallback: 4 },
  { normalCount: 24, expectedFallback: 0 },
])("admits $expectedFallback near-matches after $normalCount normal candidates", ({
  normalCount,
  expectedFallback,
}) => {
  const normal = Array.from({ length: normalCount }, (_, index) =>
    researchItem(`normal-${index}`, {
      topicalFit: 0.9,
      domain: `normal-${index}.example`,
    })
  );
  const fallback = Array.from({ length: 6 }, (_, index) =>
    researchItem(`near-${index}`, {
      topicalFit: 0.4,
      domain: `near-${index}.example`,
      normalizedText: "Capability elicitation reveals hidden model abilities.",
    })
  );
  const result = triageResearch([...fallback, ...normal], {
    ...fallbackOptions,
    maximumPerFamily: 24,
    maximumPerPublisherDomain: 24,
  });

  expect(result.items).toHaveLength(normalCount + expectedFallback);
  expect(result.admissions.filter(({ route }) => route === "near_match"))
    .toHaveLength(expectedFallback);
  expect(result.exclusions.filter(({ reason }) => reason === "queue_capacity"))
    .toHaveLength(6 - expectedFallback);
});
```

Keep the existing boundary, zero-normal six-candidate maximum, core-first, shared family/publisher, and reversed-input cases, changing only the option name and expectations required by the approved semantics.

- [ ] **Step 2: Add a production-shaped workflow RED case**

In `tests/integration/workflow/manual-run.test.ts`, rename the existing sparse
fallback case to `uses spare capacity after seven normal candidates qualify`
and change it into seven normal arXiv candidates plus three near-match Papers
with Code candidates. Use `SparseResearchEmbeddingProvider` markers so normal
candidates embed to `0.8` and Papers with Code candidates embed to `0.4`:

```ts
const normal = Array.from({ length: 7 }, (_, index) => ({
  ...rawResearchCandidate(`2608.${String(40_000 + index)}`, `NORMAL_FIT normal ${index}`),
  abstract: `NORMAL_FIT. Mechanistic interpretability for model oversight ${index}.`,
  metadata: {
    discoveryFamily: "arxiv",
    discoveryLaneIds: ["arxiv:daily"],
  },
}));
const papersWithCode = Array.from({ length: 3 }, (_, index): RawResearchCandidate => ({
  ...rawResearchCandidate(`pwc-${index}`, `NEAR_FIT Papers with Code ${index}`),
  sourceId: "papers-with-code-co",
  sourceName: "Papers with Code",
  sourceRole: "blog",
  originalUrl: `https://paperswithcode.com/paper/example-${index}`,
  externalId: `paperswithcode:example-${index}`,
  externalIds: [`paperswithcode:example-${index}`],
  abstract: `NEAR_FIT. Capability elicitation reveals hidden model abilities ${index}.`,
  metadata: {
    discoveryFamily: "official-publication",
    discoveryLaneIds: ["papers-with-code-co:page"],
  },
}));
```

Seed one aggregate diagnostic for `arxiv:daily` and one for
`papers-with-code-co:page`, with each lane's `discovered` count matching its
candidate count. Provide ten valid assessment objects. Assert:

```ts
expect(prefiltered).toHaveLength(10);
expect(prefiltered.slice(0, 7).every(({ normalizedText }) =>
  normalizedText.includes("NORMAL_FIT")
)).toBe(true);
expect(prefiltered.slice(7).map((item) => item.sourceRefs[0]?.id))
  .toEqual(["papers-with-code-co", "papers-with-code-co", "papers-with-code-co"]);
expect(assessed).toHaveLength(10);
expect(persistedDiagnostics).toEqual(expect.arrayContaining([
  expect.objectContaining({
    laneId: "papers-with-code-co:page",
    triaged: 3,
    fallbackTriaged: 3,
    assessed: 3,
  }),
]));
```

Serialize diagnostics and assert they do not contain candidate titles, abstracts, embeddings, complete Papers with Code URLs, or the `NORMAL_FIT`/`NEAR_FIT` markers.

- [ ] **Step 3: Add final-selection characterizations with no source reservation**

In `tests/unit/editorial/shortlist.test.ts`, construct arXiv and non-arXiv paper items whose only material difference is score and discovery metadata. Assert a higher-scoring non-arXiv paper wins a one-place featured budget, while a lower-scoring non-arXiv paper loses:

```ts
it("ranks non-arXiv research by editorial score without a source reservation", () => {
  const arxiv = itemWithText("arxiv", "Mechanistic interpretability for transformers");
  const nonArxiv = itemWithText("non-arxiv", "Mechanistic interpretability for transformers");
  nonArxiv.metadata.discoveryFamily = "official-publication";

  const winning = shortlist(
    [arxiv, nonArxiv],
    [researchScore(arxiv.id, 0.8), researchScore(nonArxiv.id, 0.9)],
    preferences,
    { ...budgets, featuredResearch: 1, researchRadar: 0 },
  );
  const losing = shortlist(
    [arxiv, nonArxiv],
    [researchScore(arxiv.id, 0.9), researchScore(nonArxiv.id, 0.8)],
    preferences,
    { ...budgets, featuredResearch: 1, researchRadar: 0 },
  );

  expect(winning.researchFeatured.map(({ id }) => id)).toEqual(["non-arxiv"]);
  expect(losing.researchFeatured.map(({ id }) => id)).toEqual(["arxiv"]);
});
```

This is a characterization guard; it may already pass before the admission fix and must remain green throughout the task.

- [ ] **Step 4: Run the focused RED tests**

Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts tests/unit/editorial/shortlist.test.ts
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "uses spare capacity after seven normal candidates"
```

Expected: the new triage option is rejected or ignored and the unit/workflow allowance assertions fail because the old formula admits zero near-matches after seven normal candidates. The shortlist characterization passes.

- [ ] **Step 5: Implement the minimal allowance contract and production wiring**

In `src/editorial/research-triage.ts`, change the option and local variable:

```ts
export type ResearchTriageOptions = {
  maximum: number;
  maximumPerFamily: number;
  maximumPerPublisherDomain: number;
  configuredTopics: readonly string[];
  now: string;
  minimumTopicalFit?: number;
  nearMatchAllowance?: number;
  fallbackMinimumTopicalFit?: number;
  maximumPerPublisherDomainByFamily?: Partial<
    Record<DiscoveryFamily, number>
  >;
};

const nearMatchAllowance = validatedMaximum(
  options.nearMatchAllowance ?? 0,
  "nearMatchAllowance",
);
```

After `NonnegativeIntegerSchema`, define and use a strict runtime schema for
the family overrides:

```ts
const PublisherDomainMaximumByFamilySchema = z.object({
  arxiv: NonnegativeIntegerSchema.optional(),
  bibliographic: NonnegativeIntegerSchema.optional(),
  "official-publication": NonnegativeIntegerSchema.optional(),
  commentary: NonnegativeIntegerSchema.optional(),
}).strict();

const maximumPerPublisherDomainByFamily =
  PublisherDomainMaximumByFamilySchema.parse(
    options.maximumPerPublisherDomainByFamily ?? {},
  );
const publisherDomainMaximum = (item: Item): number =>
  maximumPerPublisherDomainByFamily[discoveryFamily(item)] ??
  maximumPerPublisherDomain;
```

Use the candidate's applicable ceiling inside `canSelect`:

```ts
(perDomain.get(publisherDomain(item)) ?? 0) < publisherDomainMaximum(item)
```

Use `nearMatchAllowance > 0` in the existing eligibility and threshold-validation branches. Replace only the capacity formula:

```ts
const fallbackCapacity = Math.max(
  0,
  Math.min(nearMatchAllowance, maximum - normalCount),
);
```

Leave `selectDiversified`, shared `perFamily`/`perDomain` maps, normal selection, core/adjacent partitioning, and admissions unchanged.

In `src/workflow/run-editorial-pipeline.ts`, rename and pass the production constant:

```ts
const RESEARCH_NEAR_MATCH_ALLOWANCE = 6;
const RESEARCH_ARXIV_PUBLISHER_DOMAIN_MAXIMUM = 12;
const RESEARCH_FALLBACK_MINIMUM_TOPICAL_FIT = 0.35;

// In prefilter options:
nearMatchAllowance: RESEARCH_NEAR_MATCH_ALLOWANCE,
maximumPerPublisherDomainByFamily: {
  arxiv: RESEARCH_ARXIV_PUBLISHER_DOMAIN_MAXIMUM,
},
```

Do not change `maximum: 24`, the default
`maximumPerPublisherDomain: 6`, any non-arXiv publisher ceiling, assessment
reservation logic, or budget-state logic.

- [ ] **Step 6: Run focused GREEN and type verification**

Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts tests/unit/editorial/shortlist.test.ts
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "uses spare capacity after seven normal candidates|preserves fallback priority under degraded budget"
npm run check
git diff --check
```

Expected: all selected tests pass, TypeScript accepts only `nearMatchAllowance`, the workflow admits ten candidates in normal mode, and degraded/hard-stop behavior remains unchanged.

- [ ] **Step 7: Mutation-check the formula and shared diversity contract**

Temporarily restore the old capacity expression:

```ts
Math.min(nearMatchAllowance - normalCount, maximum - normalCount)
```

Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts -t "uses spare capacity after seven normal candidates|admits .* near-matches after"
```

Expected: the seven-normal and 20-normal assertions fail. Restore the approved expression.

Then temporarily create fresh family/domain maps for the fallback pass or bypass `canSelect` for fallback candidates. Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts -t "shared fallback diversity|family|publisher"
```

Expected: at least one shared-cap regression fails. Restore the implementation and rerun the full focused GREEN commands from Step 6.

Finally, temporarily ignore `maximumPerPublisherDomainByFamily` so all families
use six, then temporarily apply 12 globally. Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts -t "allows twelve arXiv|keeps every non-arXiv"
```

Expected: the first mutation fails the arXiv assertion and the second mutation
fails the non-arXiv assertion. Restore the source-specific lookup and rerun the
focused GREEN commands from Step 6.

- [ ] **Step 8: Commit the admission contract**

```bash
git add src/editorial/research-triage.ts src/workflow/run-editorial-pipeline.ts tests/unit/editorial/research-triage.test.ts tests/unit/editorial/shortlist.test.ts tests/integration/workflow/manual-run.test.ts
git diff --cached --check
git commit -m "fix: use spare research assessment capacity"
```

---

### Task 2: Repair the reviewed Google Research category contract

**Files:**
- Modify: `tests/fixtures/google-research-blog-listing.html`
- Modify: `tests/unit/sources/reviewed-publication-profiles.test.ts:185-235`
- Modify: `tests/unit/sources/publication-collector.test.ts:320-420`
- Modify: `src/sources/reviewed-publication-profiles.ts:190-225`

**Interfaces:**
- Consumes: `reviewedPublicationProfile("google-research")`, `providerTitle`, `ReviewedPublicationListingEntry.category`, and `PublicationPageAdapter.collectWithStats`.
- Produces: the same `ReviewedPublicationProfile` interface; no new public type. Current `.glue-card__link-list__item` markup supplies the first nonempty bounded category only after the existing explicit category selectors.

- [ ] **Step 1: Change the Google fixture to current first-party markup**

In `tests/fixtures/google-research-blog-listing.html`, replace the valid Research card's old label with the current structure:

```html
<ul class="glue-card__link-list">
  <li class="glue-card__link-list__item">Research</li>
  <li class="glue-card__link-list__item">Machine intelligence</li>
</ul>
```

Retain one valid legacy `.glue-card__label` Product sibling, one malformed reviewed card, navigation markup, and the structural query/path cases already in the fixture.

- [ ] **Step 2: Add source-profile RED assertions for exact selector behavior**

Keep the existing Google fixture expectation at `category: "Research"`. Add inline cases:

```ts
it("prefers an explicit Google category and otherwise takes the first reviewed list category", () => {
  const profile = reviewedPublicationProfile("google-research")!;
  const entries = profile.parseListing(documentFrom(`<!doctype html>
    <a class="glue-card--blog" href="/blog/current">
      <span class="js-gt-item-id">Current category contract</span>
      <span class="glue-card__eyebrow">2026-08-02</span>
      <ul class="glue-card__link-list">
        <li class="glue-card__link-list__item">AI safety</li>
        <li class="glue-card__link-list__item">Systems</li>
      </ul>
    </a>
    <a class="glue-card--blog" href="/blog/legacy">
      <span class="js-gt-item-id">Legacy category contract</span>
      <span class="glue-card__eyebrow">2026-08-02</span>
      <span class="glue-card__label">Research</span>
      <ul class="glue-card__link-list">
        <li class="glue-card__link-list__item">Ignored fallback</li>
      </ul>
    </a>`), "https://research.google/blog/");

  expect(entries.map(({ category }) => category)).toEqual(["AI safety", "Research"]);
});
```

Add a negative case in which an unrelated `<li>Research</li>` outside
`.glue-card__link-list__item` does not satisfy the required category. Put a
healthy reviewed sibling beside it and assert only the healthy sibling
survives. Keep URL and `publishedAt` equality assertions exact.

- [ ] **Step 3: Run the focused parser and collector RED tests**

Run:

```bash
npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts -t "Google Research|reviewed lab profile|reviewed list category"
```

Expected: the current fixture's Research card is dropped, the new current-category unit case omits its first entry, and the real collector either reports Google Research parse failure or lacks the expected candidate.

- [ ] **Step 4: Implement a narrow Google category helper**

In `src/sources/reviewed-publication-profiles.ts`, add a source-local helper:

```ts
function googleResearchCategory(row: Element): string | null {
  const explicit = providerTitle(
    row.querySelector(
      ".glue-card__label, .glue-card__category, [data-category]",
    )?.textContent,
  );
  if (explicit !== null) return explicit;
  return Array.from(
    row.querySelectorAll(".glue-card__link-list__item"),
  )
    .map((element) => providerTitle(element.textContent))
    .find((value): value is string => value !== null) ?? null;
}
```

Use only this helper in `googleResearchListing`:

```ts
const category = googleResearchCategory(row);
```

Do not add a generic `li`, text-search, schema, or metadata fallback. Do not
change row selection, title, date, URL resolution, 20-row bound, detail-fetch
bound, or malformed-row isolation.

- [ ] **Step 5: Run focused GREEN and verify structural boundaries**

Run:

```bash
npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts
npm run check
git diff --check
rg -n "providerTitle\(.*(url|href|date|datetime)|providerEvidence\(.*(url|href|date|datetime)" src/sources/reviewed-publication-profiles.ts
```

Expected: both source suites pass; TypeScript and diff checks pass; the structural-normalizer scan returns no matches.

- [ ] **Step 6: Mutation-check selector precision and precedence**

Temporarily replace `.glue-card__link-list__item` with `.glue-card__link-list li`. Run:

```bash
npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts -t "unrelated|reviewed list category"
```

Expected: the unrelated-list negative test fails. Restore the exact selector.

Temporarily return the current list category before checking the explicit selectors. Run:

```bash
npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts -t "prefers an explicit Google category"
```

Expected: the legacy precedence assertion fails. Restore explicit-first behavior and rerun Step 5.

- [ ] **Step 7: Commit the parser repair**

```bash
git add src/sources/reviewed-publication-profiles.ts tests/fixtures/google-research-blog-listing.html tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts
git diff --cached --check
git commit -m "fix: restore Google Research discovery"
```

---

### Task 3: Verify the integrated research funnel and publish the evidence report

**Files:**
- Create: `docs/superpowers/reports/2026-08-12-spare-capacity-non-arxiv-research-recovery.md`
- Review only: every production and test file changed in Tasks 1–2

**Interfaces:**
- Consumes: the two committed deliverables from Tasks 1–2.
- Produces: a reviewable evidence report; no production interface or behavior.

- [ ] **Step 1: Run the complete focused research/source suite**

Run:

```bash
npx vitest run tests/unit/editorial/research-triage.test.ts tests/unit/editorial/shortlist.test.ts tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts
npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "spare capacity|fallback priority|non-ArXiv|reviewed publication"
```

Expected: all selected tests pass. If the Worker command encounters the known sandbox loopback `EPERM`, rerun the identical command only after the normal approval mechanism grants localhost execution; do not alter tests to avoid the sandbox.

- [ ] **Step 2: Run repository-wide verification**

Run, in this order:

```bash
npm test
npm run test:worker
npm run check
npm run evaluate
npm run build
git diff --check a2f38f4..HEAD
```

Expected:

- all ordinary and Worker tests pass;
- TypeScript exits zero;
- the evaluator reports precision@5 at or above `0.80` and every listed assertion passes;
- Vite builds successfully; and
- the complete implementation diff contains no whitespace errors.

If `npm test` or `npm run test:worker` fails only because the sandbox forbids its local listener, rerun the identical command through the normal approval mechanism and record both outputs. Any functional failure must be investigated rather than waived.

- [ ] **Step 3: Run privacy, safety, scope, and cost-bound scans**

Run:

```bash
rg -n "dangerouslySetInnerHTML|innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write" src tests
rg -n "maximum:\s*(30|40|48)|RESEARCH_.*MAXIMUM\s*=\s*(30|40|48)" src
rg -n "Georgia Tech|gatech|Stanford|Johns Hopkins|jhu" src/editorial/research-triage.ts src/workflow/run-editorial-pipeline.ts src/sources/reviewed-publication-profiles.ts
git diff a2f38f4..HEAD -- src/workflow/discovery-diagnostics.ts src/sources/types.ts src/db | rg "^\+.*(title|abstract|normalizedText|embedding|paperswithcode\.com/paper)"
git status --short
```

Expected:

- the dynamic/trusted HTML scan has no production sink match;
- no assessment maximum was raised to 30, 40, or 48;
- the scoped production diff contains no university-policy edits;
- the added-line diagnostics/schema/store scan returns no newly persisted private candidate text, embeddings, or complete Papers with Code candidate URLs; and
- the worktree contains only the planned report before its commit.

Manually confirm the production diff changes no news code path, D1 migration, model provider, budget ledger, public config, OAuth path, structural URL normalization, or deployment file.

- [ ] **Step 4: Write the evidence report**

Create `docs/superpowers/reports/2026-08-12-spare-capacity-non-arxiv-research-recovery.md` with these fully populated sections:

```markdown
# Spare-Capacity Non-arXiv Research Recovery Report

## Scope
Record base `a2f38f4`, every implementation commit SHA, and the exact changed-file list from `git diff --name-only a2f38f4..HEAD`.

## RED evidence
Record every RED command, failing test name, assertion mismatch, and the old formula or parser behavior it proves.

## GREEN evidence
Record exact focused-unit, Worker, full-test, typecheck, evaluator, build, and diff commands, test totals, and exit statuses.

## Mutation evidence
Record the old-formula, diversity-reset, broad-selector, and selector-precedence mutations with the exact failing tests, then record restoration and GREEN reruns.

## Safety and privacy audit
Record evidence for the 24-call cap, absence of final source reservations, absence of private diagnostics and structural normalization, unchanged university policies, and absence of migrations or deployments.

## Independent review
Record the reviewer verdict and every finding/fix. If the reviewer reports no findings, write `No findings`.

## Concerns and follow-up
Record existing third-party warnings and the separately scoped university endpoint-policy work. Write `None` for correctness concerns if none remain.
```

Do not leave unresolved markers or unverified claims. Include exact test counts and exit statuses from Steps 1–3.

- [ ] **Step 5: Request a fresh independent read-only review**

Ask the reviewer to inspect `a2f38f4..HEAD` for:

- exact compliance with the approved design;
- old target semantics surviving under another name;
- overflow beyond 24 or six near-matches;
- changed normal ordering, family/publisher caps, degraded/hard-stop behavior, or cached-assessment behavior;
- an arXiv-family publisher ceiling other than 12, a non-arXiv ceiling other than six, or an override chosen from URL/display-name text rather than normalized discovery family;
- Google selector overreach, arbitrary-list fallback, structural-field normalization, or healthy-empty misclassification;
- source-family bonus or final-slot reservation;
- privacy leakage in diagnostics or reports; and
- test assertions that can pass without exercising the production boundary.

Require findings to be ranked Critical, Important, or Minor with file/line evidence. Do not commit while a Critical or Important finding remains.

- [ ] **Step 6: Address review findings with strict RED/GREEN**

For every valid Critical or Important finding:

1. add the smallest regression test that fails on the reviewed commit;
2. run it and record RED;
3. make the minimal fix;
4. rerun focused and affected suites;
5. request a read-only re-review; and
6. update the evidence report.

Minor findings may be fixed or explicitly deferred only when they do not affect correctness, privacy, cost, or the approved contract.

- [ ] **Step 7: Re-run final exact-tree verification and commit the report/fixes**

Run again on the final tree:

```bash
npm test
npm run test:worker
npm run check
npm run evaluate
npm run build
git diff --check a2f38f4..HEAD
git status --short
```

Then commit only reviewed changes:

```bash
git add docs/superpowers/reports/2026-08-12-spare-capacity-non-arxiv-research-recovery.md
git add src tests
git diff --cached --check
git commit -m "test: verify non-arxiv research recovery"
```

If the review required no code or test changes after Tasks 1–2, the final commit contains only the evidence report and uses:

```bash
git commit -m "docs: report non-arxiv research recovery"
```

Do not amend prior commits, rewrite history, push, create a pull request, apply a D1 migration, or deploy within this plan.
