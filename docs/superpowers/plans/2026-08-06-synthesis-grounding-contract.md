# Synthesis Grounding Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:test-driven-development` for each implementation task and `superpowers:verification-before-completion` before claiming completion. Execute tasks in order; do not deploy or mutate external services.

**Goal:** Make strict extractive synthesis accept prominent prose grounded in a cited source title, while giving the single repair attempt bounded, actionable, privacy-safe validation guidance.

**Architecture:** Keep `validateSummary` as the authoritative grounding gate. Move rejection-code parsing and canonicalization into an editorial module shared by the repair prompt and workflow diagnostics. Build repair guidance only from canonical codes and fixed instructions, then append the unchanged serialized source packet. Preserve the existing initial-call-plus-one-repair-call flow and all budget, authority, access, and forecast checks.

**Tech Stack:** TypeScript, Zod, Vitest, Cloudflare Worker workflow tests.

**Design specification:** `docs/superpowers/specs/2026-08-06-synthesis-grounding-contract-design.md`

## Global constraints

- Prominent fields (`title`, `oneSentence`, `whyItMatters`, `uncertainty`) remain strictly extractive.
- A prominent provenance excerpt must occur in the title or a numbered excerpt of **every** cited source.
- Claim evidence remains excerpt-only and must occur in every cited source; source titles must not ground factual claims.
- Preserve research authority, access-level, and forecast-label validation.
- Preserve exactly one initial provider call and at most one repair call per item.
- Canonicalize all `UNKNOWN_SOURCE:<payload>` values to `UNKNOWN_SOURCE`.
- Canonicalize malformed or oversized rejection codes to `SCHEMA_INVALID:root`.
- Repair guidance is deterministic, contains at most 64 one-line entries, and is at most 16,384 UTF-8 bytes before the original source packet.
- Never include raw generated output or provider payloads in repair guidance or stored diagnostics.
- Do not add retries, provider calls, budgets, discovery changes, migrations, or external mutations.

---

## Task 1: Align prominent-field provenance with the prompt

**Files:**

- Modify: `src/editorial/validate-summary.ts`
- Test: `tests/unit/editorial/validate-summary.test.ts`

### Step 1: Write failing validator tests

Add focused tests beside the existing prominent-prose grounding cases:

```ts
it("accepts prominent provenance copied from every cited source title", () => {
  const sourceTitle = "A source title absent from excerpt bodies";
  const fixture = summaryFixture();
  const result = validateSummary(
    summaryFixture({
      title: sourceTitle,
      provenance: {
        ...fixture.provenance,
        title: {
          sourceIds: ["source-1"],
          evidenceExcerpt: sourceTitle,
        },
      },
    }),
    sourcePacketFixture({
      sources: [{
        ...sourcePacketFixture().sources[0]!,
        title: sourceTitle,
      }],
    }),
  );

  expect(result.ok).toBe(true);
});

it("rejects prominent provenance found only in an uncited source title", () => {
  const uncitedTitle = "Title supplied only by the uncited source";
  const fixture = summaryFixture();
  const result = validateSummary(
    summaryFixture({
      title: uncitedTitle,
      provenance: {
        ...fixture.provenance,
        title: {
          sourceIds: ["source-1"],
          evidenceExcerpt: uncitedTitle,
        },
      },
    }),
    sourcePacketFixture({
      sources: [
        sourcePacketFixture().sources[0]!,
        {
          ...sourcePacketFixture().sources[0]!,
          sourceId: "uncited",
          title: uncitedTitle,
          url: "https://example.com/uncited",
        },
      ],
    }),
  );

  expect(result.errors).toContain("UNGROUNDED_PROSE:title");
});

it("requires prominent provenance evidence in every cited source", () => {
  const sharedTitle = "Title supplied by only one cited source";
  const fixture = summaryFixture();
  const result = validateSummary(
    summaryFixture({
      title: sharedTitle,
      provenance: {
        ...fixture.provenance,
        title: {
          sourceIds: ["source-1", "source-2"],
          evidenceExcerpt: sharedTitle,
        },
      },
    }),
    sourcePacketFixture({
      sources: [
        {
          ...sourcePacketFixture().sources[0]!,
          title: sharedTitle,
        },
        {
          ...sourcePacketFixture().sources[0]!,
          sourceId: "source-2",
          title: "A different source title",
          url: "https://example.com/source-2",
        },
      ],
    }),
  );

  expect(result.errors).toContain("UNGROUNDED_PROSE:title");
});

it("does not allow a source title to ground a factual claim", () => {
  const sourceTitle = "A title-only factual assertion";
  const result = validateSummary(
    summaryFixture({
      claims: [{
        text: sourceTitle,
        sourceIds: ["source-1"],
        evidenceExcerpt: sourceTitle,
      }],
    }),
    sourcePacketFixture({
      sources: [{
        ...sourcePacketFixture().sources[0]!,
        title: sourceTitle,
      }],
    }),
  );

  expect(result.errors).toContain("EVIDENCE_NOT_FOUND:0");
});
```

Use the test file's existing fixtures as shown instead of introducing broad new fixture infrastructure. The first fixture's source title must not also occur in its excerpts, so the regression is real. The two-source test must cite both sources and put the evidence in only one of them.

### Step 2: Run the focused tests and confirm RED

Run:

```bash
npx vitest run tests/unit/editorial/validate-summary.test.ts
```

Expected: the title-provenance acceptance test fails with `UNGROUNDED_PROSE:title`; existing claim behavior remains green.

### Step 3: Implement the smallest validator change

Add a helper near the existing normalized-evidence helpers:

```ts
function prominentEvidenceMatchesSource(
  evidence: string,
  source: SourcePacket["sources"][number],
): boolean {
  const normalizedEvidence = normalizedText(evidence);
  if (normalizedEvidence.length === 0) {
    return false;
  }
  return [source.title, ...source.excerpts.map(({ text }) => text)]
    .some((candidate) =>
      normalizedText(candidate).includes(normalizedEvidence)
    );
}
```

In the prominent-field loop, replace the excerpt-only `evidenceSources` test with an all-cited-sources match:

```ts
const evidenceSources =
  normalizedEvidence.length === 0
    ? []
    : citedSources.filter((source) =>
        prominentEvidenceMatchesSource(
          provenance.evidenceExcerpt,
          source,
        )
      );
const evidenceMatchesEveryCitedSource =
  citedSources.length > 0 &&
  evidenceSources.length === citedSources.length;

if (
  !evidenceMatchesEveryCitedSource ||
  !extractivelySupports(
    prose,
    provenance.evidenceExcerpt,
    citedSources,
    forecast,
  )
) {
  errors.push(`UNGROUNDED_PROSE:${field}`);
}
```

Do not change claim validation helpers or access-level source selection.

### Step 4: Run focused and adjacent tests

Run:

```bash
npx vitest run tests/unit/editorial/validate-summary.test.ts tests/unit/editorial/summarize.test.ts
```

Expected: all tests pass.

### Step 5: Commit

```bash
git add src/editorial/validate-summary.ts tests/unit/editorial/validate-summary.test.ts
git commit -m "fix: align prominent summary provenance"
```

---

## Task 2: Add canonical rejection codes and bounded repair guidance

**Files:**

- Create: `src/editorial/summary-rejection-code.ts`
- Create: `src/editorial/summary-repair-guidance.ts`
- Modify: `src/editorial/summarize.ts`
- Modify: `src/workflow/types.ts`
- Modify: `src/workflow/run-editorial-pipeline.ts`
- Test: `tests/unit/editorial/summarize.test.ts`
- Test: `tests/integration/workflow/manual-run.test.ts`

### Step 1: Write failing unit tests for canonicalization and guidance

In `tests/unit/editorial/summarize.test.ts`, import the new public helpers and add cases covering:

```ts
expect(canonicalSummaryRejectionCodes([
  "UNKNOWN_SOURCE:secret%40example.com",
  "UNKNOWN_SOURCE:another-value",
  "UNGROUNDED_PROSE:title",
  "UNGROUNDED_PROSE:title",
])).toEqual(["UNGROUNDED_PROSE:title", "UNKNOWN_SOURCE"]);

expect(canonicalSummaryRejectionCodes([
  "not-a-code",
  `UNKNOWN_SOURCE:${"x".repeat(1_000)}`,
])).toEqual(["SCHEMA_INVALID:root", "UNKNOWN_SOURCE"]);

const guidance = buildSummaryRepairGuidance([
  "UNGROUNDED_PROSE:title",
  "UNKNOWN_SOURCE:anything-sensitive",
]);
expect(guidance).toContain("UNGROUNDED_PROSE:title");
expect(guidance).toContain("copy the field exactly");
expect(guidance).toContain("UNKNOWN_SOURCE");
expect(guidance).not.toContain("anything-sensitive");
expect(guidance.split("\n")).toHaveLength(2);
expect(new TextEncoder().encode(guidance).byteLength).toBeLessThanOrEqual(16_384);
```

Add a test with more than 64 distinct canonical inputs and a byte-pressure test. Both must return a deterministic bounded fallback containing only `SCHEMA_INVALID:root` and its fixed instruction. Also prove that one malformed value maps to `SCHEMA_INVALID:root` without discarding other valid codes.

Update the repair-call test to assert:

```ts
expect(provider.generateRequests[1]?.sourcePacket).toContain(
  "VALIDATION ERRORS AND REQUIRED REPAIRS",
);
expect(provider.generateRequests[1]?.sourcePacket).toContain(
  "UNKNOWN_SOURCE",
);
expect(provider.generateRequests[1]?.sourcePacket).not.toContain(
  "UNKNOWN_SOURCE:unknown",
);
expect(provider.generateRequests[1]?.sourcePacket).toContain(
  "ORIGINAL SOURCE PACKET",
);
expect(provider.generateRequests).toHaveLength(2);
```

Update the typed-rejection test to expect `UNKNOWN_SOURCE` rather than `UNKNOWN_SOURCE:unknown`, while preserving the schema-error assertion and exactly-two-call assertion. Keep the existing injected-source-ID privacy test green. Test malformed and oversized raw values directly through `canonicalSummaryRejectionCodes`, because `validateSummary` deliberately percent-encodes and bounds the errors it creates.

### Step 2: Write a failing workflow diagnostic test

Beside the existing `UNKNOWN_SOURCE` rejection test in `tests/integration/workflow/manual-run.test.ts`, make the recorder assertion require the shared deterministic result:

```ts
expect(JSON.parse(event!.event_json).errors).toEqual([
  "CLAIM_EVIDENCE_NOT_EXACT",
  "EVIDENCE_NOT_FOUND:0",
  "UNGROUNDED_CLAIM:0",
  "UNKNOWN_SOURCE",
]);
```

The existing `UnknownSourceThenAcceptanceProvider` supplies the payload-bearing unknown source on both the initial and repair attempts, so this exact assertion proves the workflow boundary redacts, deduplicates, and sorts the final error set. Retain all current assertions that the malicious raw and encoded payloads are absent from the event JSON.

### Step 3: Run focused tests and confirm RED

Run:

```bash
npx vitest run tests/unit/editorial/summarize.test.ts
npm run test:worker -- tests/integration/workflow/manual-run.test.ts
```

Expected: imports or new expectations fail because the canonicalizer and guidance builder do not exist yet.

### Step 4: Create the shared rejection-code module

Move the schema from `src/workflow/types.ts` into `src/editorial/summary-rejection-code.ts` and export it back through the workflow module for compatibility:

```ts
import { z } from "zod";

const MAX_REJECTION_CODES = 64;
const MAX_RAW_CODE_LENGTH = 200;
const FALLBACK_CODE = "SCHEMA_INVALID:root" as const;

export const SummaryRejectionCodeSchema = z.string()
  .min(1)
  .max(MAX_RAW_CODE_LENGTH)
  .regex(/^(?:SCHEMA_INVALID:[A-Za-z0-9_.-]+|UNKNOWN_SOURCE|EMPTY_EVIDENCE:\d+|EVIDENCE_NOT_FOUND:\d+|CLAIM_EVIDENCE_NOT_EXACT|UNGROUNDED_CLAIM:\d+|PRIMARY_RESEARCH_SOURCE_REQUIRED:\d+|ACCESS_LEVEL_OVERCLAIM|UNGROUNDED_PROSE:(?:title|oneSentence|whyItMatters|uncertainty)|EMPTY_UNCERTAINTY|FORECAST_LABEL_MISSING)$/);

export type SummaryRejectionCode = z.infer<
  typeof SummaryRejectionCodeSchema
>;

export function canonicalSummaryRejectionCodes(
  errors: readonly string[],
): SummaryRejectionCode[] {
  if (errors.length === 0) {
    return [FALLBACK_CODE];
  }
  const normalized = errors.map((error): SummaryRejectionCode => {
    const withoutPayload = error.startsWith("UNKNOWN_SOURCE:")
      ? "UNKNOWN_SOURCE"
      : error;
    const parsed = SummaryRejectionCodeSchema.safeParse(withoutPayload);
    return parsed.success ? parsed.data : FALLBACK_CODE;
  });
  const distinct = [...new Set(normalized)].sort();
  return distinct.length <= MAX_REJECTION_CODES
    ? distinct
    : [FALLBACK_CODE];
}
```

Keep the behavior above exact: collapse every payload-bearing unknown-source code before validation; map each other invalid or oversized raw value individually to the fallback; preserve other valid codes; deduplicate and sort; and replace the whole result with the fallback only if the distinct canonical set is empty or over 64.

In `src/workflow/types.ts`, remove the local schema definition and re-export/import the shared schema:

```ts
export { SummaryRejectionCodeSchema } from
  "../editorial/summary-rejection-code";
import { SummaryRejectionCodeSchema } from
  "../editorial/summary-rejection-code";
```

### Step 5: Create deterministic repair guidance

In `src/editorial/summary-repair-guidance.ts`, define constants:

```ts
const MAX_GUIDANCE_LINES = 64;
const MAX_GUIDANCE_BYTES = 16_384;
const FALLBACK_GUIDANCE =
  "SCHEMA_INVALID:root — return a complete object matching the schema; use only supplied source IDs and exact source wording.";

const PROMINENT_INSTRUCTION =
  "copy the field exactly from its provenance evidence; that evidence must occur in the title or a numbered excerpt of every cited source";

export function buildSummaryRepairGuidance(
  errors: readonly string[],
): string {
  const codes = canonicalSummaryRejectionCodes(errors);
  const lines = codes.map((code) => `${code} — ${instructionFor(code)}`);
  const guidance = lines.join("\n");
  return lines.length <= MAX_GUIDANCE_LINES &&
    new TextEncoder().encode(guidance).byteLength <= MAX_GUIDANCE_BYTES
      ? guidance
      : FALLBACK_GUIDANCE;
}
```

Implement `instructionFor` as a total switch/prefix mapping over these families:

- `SCHEMA_INVALID:*`: return a complete schema-valid object.
- `UNKNOWN_SOURCE`: use only IDs present in the source packet.
- `EMPTY_EVIDENCE:*`: provide non-whitespace evidence copied from the cited numbered excerpt.
- `EVIDENCE_NOT_FOUND:*`: copy claim evidence from a numbered excerpt in every cited source.
- `CLAIM_EVIDENCE_NOT_EXACT`: make claim text an exact extractive match to its evidence.
- `UNGROUNDED_CLAIM:*`: copy claim text exactly from evidence found in every cited source.
- `PRIMARY_RESEARCH_SOURCE_REQUIRED:*`: cite an eligible primary research source for the research claim.
- `ACCESS_LEVEL_OVERCLAIM`: do not imply access beyond supplied access levels.
- `UNGROUNDED_PROSE:*`: use `PROMINENT_INSTRUCTION` and name the field from the code.
- `EMPTY_UNCERTAINTY`: copy a non-empty uncertainty statement from supplied source wording.
- `FORECAST_LABEL_MISSING`: add the literal `Forecast, not fact.` label while keeping remaining prose extractive.

The mapping must use only fixed strings plus a schema-validated field/index. It must never interpolate an unvalidated raw error or provider output.

### Step 6: Wire guidance into summarization

Update `GROUNDING_SYSTEM_PROMPT` and the JSON-schema provenance descriptions to say explicitly:

```text
For each prominent field, provenance evidence must appear in the title or a numbered excerpt of every cited source.
For each factual claim, evidence must appear in a numbered excerpt of every cited source; source titles alone do not ground claims.
```

Replace `repairPacket` with:

```ts
function repairPacket(
  errors: readonly string[],
  sourcePacket: string,
): string {
  return [
    "VALIDATION ERRORS AND REQUIRED REPAIRS",
    buildSummaryRepairGuidance(errors),
    "",
    "ORIGINAL SOURCE PACKET",
    sourcePacket,
  ].join("\n");
}
```

Canonicalize the final union before throwing:

```ts
throw new SummaryRejectedError(
  canonicalSummaryRejectionCodes([
    ...initialValidation.errors,
    ...repairValidation.errors,
  ]),
);
```

Do not change provider request count, model, schema name, token limits, or retry behavior.

### Step 7: Reuse canonicalization at workflow boundaries

Delete `normalizedSummaryRejectionErrors` from `src/workflow/run-editorial-pipeline.ts`. Import `canonicalSummaryRejectionCodes` and use it in both places:

```ts
const valid = SummaryRejectionEventSchema.parse({
  ...event,
  errors: canonicalSummaryRejectionCodes(event.errors),
});
```

and:

```ts
errors: canonicalSummaryRejectionCodes(error.errors),
```

Do not change audit-event identity, event JSON shape, retention, or Run Status behavior.

### Step 8: Run focused and adjacent tests

Run:

```bash
npx vitest run tests/unit/editorial/summarize.test.ts tests/unit/editorial/validate-summary.test.ts
npm run test:worker -- tests/integration/workflow/manual-run.test.ts
```

Expected: all tests pass, including exactly-two-call repair assertions and canonical diagnostic storage.

### Step 9: Commit

```bash
git add src/editorial/summary-rejection-code.ts src/editorial/summary-repair-guidance.ts src/editorial/summarize.ts src/workflow/types.ts src/workflow/run-editorial-pipeline.ts tests/unit/editorial/summarize.test.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: add bounded summary repair guidance"
```

---

## Task 3: Add a canary-like synthesis regression

**Files:**

- Modify: `tests/integration/workflow/manual-run.test.ts`

### Step 1: Write the integration regression test

Add a provider near `ConcurrencyTrackingSummaryProvider`:

```ts
class TitleRepairingSummaryProvider implements ModelProvider {
  readonly requests: GenerateObjectRequest[] = [];

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    return texts.map(() => [1, 0]);
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    this.requests.push(input);
    const sourceId = packetValue(input.sourcePacket, "source_id");
    const title = packetValue(input.sourcePacket, "title");
    const evidence = packetExcerpt(input.sourcePacket);
    const repairing = input.sourcePacket.startsWith(
      "VALIDATION ERRORS AND REQUIRED REPAIRS",
    );
    const provenance = {
      sourceIds: [sourceId],
      evidenceExcerpt: repairing ? title : evidence,
    };
    return {
      title: repairing ? title : "Unsupported paraphrased headline",
      oneSentence: evidence,
      whyItMatters: evidence,
      uncertainty: evidence,
      claims: [{
        text: evidence,
        sourceIds: [sourceId],
        evidenceExcerpt: evidence,
      }],
      accessLevel: packetAccessLevel(input.sourcePacket),
      provenance: {
        title: provenance,
        oneSentence: {
          sourceIds: [sourceId],
          evidenceExcerpt: evidence,
        },
        whyItMatters: {
          sourceIds: [sourceId],
          evidenceExcerpt: evidence,
        },
        uncertainty: {
          sourceIds: [sourceId],
          evidenceExcerpt: evidence,
        },
      },
    };
  }
}
```

Because the repair packet contains the original source packet below the guidance, the existing anchored multiline `packetValue` and `packetExcerpt` helpers should still locate source fields. Confirm this in the test instead of adding a second parser.

Create eight normalized items using the existing raw-candidate fixtures: two primary research papers and six news items. These fixtures already give each source a title that is absent from its excerpt. Normalize through the production context, then call only `context.synthesize(normalized)`:

```ts
const provider = new TitleRepairingSummaryProvider();
const context = createProductionPipelineContext({
  editionDate: "2033-03-13",
  runId: "canary-like-title-repair",
  store: new FixtureStore(),
  now: () => now,
  providers: {
    summary: provider,
    assessment: new FakeModelProvider(),
  },
  collectCandidates: async () => [
    rawResearchCandidate(
      "2607.30001",
      "Research title Alpha absent from the abstract",
      20,
    ),
    rawResearchCandidate(
      "2607.30002",
      "Research title Beta absent from the abstract",
      10,
    ),
    rawNewsCandidate("canary-world", "world"),
    rawNewsCandidate("canary-technology", "technology"),
    rawNewsCandidate("canary-ai-policy", "ai_policy"),
    rawNewsCandidate("canary-dmv", "dmv"),
    rawNewsCandidate("canary-baltimore", "baltimore"),
    rawNewsCandidate("canary-world-second", "world"),
  ],
});
const normalized = await context.normalize(await context.collect());

const summaries = await context.synthesize(normalized);

expect(summaries).toHaveLength(8);
expect(summaries.filter(({ item }) => item.kind === "paper")).toHaveLength(2);
expect(provider.requests).toHaveLength(16);
expect(provider.requests.filter(({ sourcePacket }) =>
  sourcePacket.startsWith("VALIDATION ERRORS AND REQUIRED REPAIRS")
)).toHaveLength(8);
expect(summaries.every(({ summary, item }) =>
  summary.title === item.title
)).toBe(true);
```

Assert the research count, not research positions: shortlist reservation ordering is already covered elsewhere, and this regression targets synthesis acceptance and repair behavior.

### Step 2: Run the focused regression and confirm GREEN

Run:

```bash
npm run test:worker -- tests/integration/workflow/manual-run.test.ts -t "repairs canary-like extractive titles"
```

Expected: the regression passes because Tasks 1–2 have already aligned title provenance and added the actionable repair packet. This task adds canary-shaped coverage; it does not introduce another production behavior change.

### Step 3: Make only fixture-level corrections

If the integration fixture needs adjustment, change only fixture construction or assertions. Do not weaken validation and do not add provider calls. The final test must still exercise:

- eight items;
- two primary-research items;
- one failed initial synthesis per item;
- one successful repair per item;
- exact title extraction from source titles;
- sixteen total calls.

### Step 4: Run adjacent workflow tests

Run:

```bash
npm run test:worker -- tests/integration/workflow/manual-run.test.ts
```

Expected: all workflow integration tests pass, including sequential synthesis, rejection diagnostics, and reservation accounting.

### Step 5: Commit

```bash
git add tests/integration/workflow/manual-run.test.ts
git commit -m "test: cover canary-like title repair"
```

---

## Task 4: Verify the branch without external mutation

**Files:**

- Verification only

### Step 1: Run static checks

```bash
npm run check
```

Expected: exit 0.

### Step 2: Run unit tests and record the accepted OAuth baseline separately

```bash
npm test
```

Expected: all new and relevant editorial tests pass. If the repository still reports the known managed-browser OAuth baseline, it must be exactly 13 OAuth-only failures with the associated unhandled rejection; any other failure is a regression and must be fixed before continuing. Record the new passing-test count from this run rather than copying an old count.

### Step 3: Run the full Worker suite

```bash
npm run test:worker
```

Expected: all Worker tests pass.

### Step 4: Run evaluation and build

```bash
npm run evaluate
npm run build
```

Expected: both exit 0.

### Step 5: Inspect scope and whitespace

```bash
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
```

Expected: no whitespace errors; only the approved spec, plan, validator, repair-code/guidance, prompt/diagnostic wiring, and tests appear. The working tree is clean after commits.

### Step 6: Stop at the approval boundary

Report verification evidence and request the user's next instruction. Do **not** push, open a pull request, deploy the preview Worker, run a paid canary, mutate D1, modify secrets, or touch production without separate authorization.
