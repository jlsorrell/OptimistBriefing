# Event Clause Parser Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sentence-wide repeat-identity matching with a deterministic, fail-open clause parser that binds event actors, objects, and material facts to the same clause.

**Architecture:** Add a pure `event-clause-parser` module that owns sentence/clause segmentation, reporting-complement handling, bounded event-construction parsing, and clause-level provenance. Inject the existing news-domain canonicalization and material-fact extraction as pure semantic callbacks, then integrate parsed clauses into `news-signals.ts` while preserving all public schemas and downstream contracts.

**Tech Stack:** TypeScript 5.8, Vitest 3, Zod 3, existing Vite/Cloudflare Worker build; no new runtime dependency.

## Global Constraints

- Failure policy is fail open: ambiguous or unsupported text must produce no canonical event instance, which leaves the development `repeatable: false`.
- Repeat suppression requires exactly one unambiguous canonical event tuple across title, abstract, and content.
- Subject, supported event predicate, event object, and scoped material facts must belong to the same parsed clause.
- After one canonical event is resolved, a separate fact clause may contribute
  scoped facts only when it explicitly names the exact same canonical event
  object and domain.
- Reporting wrappers with a supported `that` complement use the embedded event; the wrapper actor must not replace the embedded subject.
- Split `after`, `before`, `because`, `while`, `whereas`, `but`, and semicolon clauses conservatively.
- Do not perform pronoun or entity coreference resolution.
- Generic references such as `the policy`, `the standard`, and `the program`
  are not exact-object fact clauses.
- Preserve `CanonicalEventInstance`, `ScopedNewsMaterialFact`, `deriveCanonicalEventInstances`, `deriveMaterialFacts`, `deriveScopedMaterialFacts`, and `deriveNewsSignals` public contracts.
- Keep general unscoped material facts available for editorial use, but never use them for repeat suppression without exact clause ownership.
- Explicit `metadata.scopedMaterialFacts` are accepted only when their event instance exactly matches the single text-derived event instance.
- Legacy unscoped metadata facts never establish or alter repeat identity.
- The parser is pure, deterministic, and performs no I/O or model calls.
- Add no NLP or other runtime dependency.
- Limit complement recursion to 3 levels and parsed clause candidates to 16 per sentence; exceeding either limit returns no event for the affected sentence.
- Do not change collectors, source ranking, clustering weights, summarization, UI, or persistence schemas.

---

## File Map

- Create `src/sources/event-clause-parser.ts`
  - Owns source-field preservation, sentence splitting, conservative clause
    segmentation, reporting-complement traversal, bounded active/passive/headline
    parsing, and stable clause records.
- Create `tests/unit/sources/event-clause-parser.test.ts`
  - Unit-tests the syntax engine with small deterministic semantic callbacks.
- Create `tests/unit/sources/news-signals.test.ts`
  - Tests the real news-domain integration and the two formal-review defects.
- Modify `src/sources/news-signals.ts`
  - Supplies subject/object/fact semantics to the parser, replaces the existing
    sentence-wide tuple/fact-scoping logic, and preserves exported wrappers.
- Modify `src/sources/event-clause-parser.ts` in Task 2
  - Adds exact-object fact-clause parsing and the safe organization-led headline
    form discovered during integration; neither may weaken fail-open identity.
- Modify `tests/unit/sources/event-clause-parser.test.ts` in Task 2
  - Adds failing-first coverage for those two bounded grammar extensions.
- Modify `tests/unit/editorial/pipeline.test.ts`
  - Adds end-to-end fail-open and repeat-fingerprint regressions at the
    normalize/cluster boundary.

---

### Task 1: Pure event clause parser

**Files:**
- Create: `src/sources/event-clause-parser.ts`
- Create: `tests/unit/sources/event-clause-parser.test.ts`

**Interfaces:**
- Consumes:
  - `CanonicalEventDomain`, `CanonicalEventInstance`, and `NewsMaterialFact`
    from `src/sources/types.ts`.
- Produces:

```ts
export type EventTextFields = Readonly<{
  title: string;
  abstract?: string | null;
  content?: string | null;
}>;

export type EventObjectCandidate = Readonly<{
  domain: CanonicalEventDomain;
  object: string;
}>;

export interface EventClauseSemantics {
  canonicalSubject(subjectText: string): string | null;
  eventObjects(
    objectText: string,
    eventFamilies: readonly string[],
    subject: string,
  ): readonly EventObjectCandidate[];
  materialFacts(
    clauseText: string,
    eventInstance: CanonicalEventInstance,
  ): readonly NewsMaterialFact[];
}

export interface ParsedEventClause {
  sourceField: "title" | "abstract" | "content";
  sentenceIndex: number;
  clauseIndex: number;
  text: string;
  predicate:
    | "proposed"
    | "introduced"
    | "adopted"
    | "approved"
    | "launched"
    | "released"
    | "unveiled"
    | "published"
    | "issued"
    | "announced"
    | "updated";
  subject: string;
  domain: CanonicalEventDomain;
  object: string;
  facts: NewsMaterialFact[];
}

export function parseEventClauses(input: {
  text: EventTextFields;
  eventFamilies: readonly string[];
  semantics: EventClauseSemantics;
}): ParsedEventClause[];
```

- Task 2 relies on `parseEventClauses` returning stable records ordered by
  `title`, `abstract`, `content`, then sentence and clause index.

- [ ] **Step 1: Create the focused tests for simple constructions and stable provenance**

Create `tests/unit/sources/event-clause-parser.test.ts` with shared deterministic
semantics and assertions for active, passive, headline, and source-field
behavior:

```ts
import { describe, expect, it } from "vitest";

import {
  parseEventClauses,
  type EventClauseSemantics,
} from "../../../src/sources/event-clause-parser";

const semantics: EventClauseSemantics = {
  canonicalSubject(subjectText) {
    const match =
      /(Evaluation Agency|Model Institute|Funding Agency)/i.exec(subjectText);
    return match?.[1]
      ?.toLocaleLowerCase("en-US")
      .replace(/\s+/g, "-") ?? null;
  },
  eventObjects(objectText) {
    const candidates = [
      ["frontier-evaluation-standard", "governance-event", /Frontier Evaluation Standard/i],
      ["community-research-program", "funding-event", /Community Research Program/i],
    ] as const;
    return candidates.flatMap(([object, domain, pattern]) =>
      pattern.test(objectText) ? [{ object, domain }] : [],
    );
  },
  materialFacts(clauseText) {
    return /takes effect July 1, 2027/i.test(clauseText)
      ? [{
          kind: "date" as const,
          key: "effective-date",
          value: "2027-07-01",
        }]
      : [];
  },
};

describe("parseEventClauses", () => {
  it.each([
    [
      "Model Institute adopted Frontier Evaluation Standard",
      "model-institute",
    ],
    [
      "Frontier Evaluation Standard was adopted by Model Institute",
      "model-institute",
    ],
    [
      "Model Institute: Frontier Evaluation Standard adopted",
      "model-institute",
    ],
  ])("parses a supported construction: %s", (title, subject) => {
    const parsed = parseEventClauses({
      text: { title },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toMatchObject([{
      sourceField: "title",
      sentenceIndex: 0,
      clauseIndex: 0,
      predicate: "adopted",
      subject,
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
  });

  it("keeps title, abstract, and content provenance separate", () => {
    const parsed = parseEventClauses({
      text: {
        title: "Model Institute adopted Frontier Evaluation Standard.",
        abstract: "Model Institute adopted Frontier Evaluation Standard.",
        content: "Model Institute adopted Frontier Evaluation Standard.",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed.map(({ sourceField }) => sourceField)).toEqual([
      "title",
      "abstract",
      "content",
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails for the missing module**

Run:

```bash
npx vitest run tests/unit/sources/event-clause-parser.test.ts
```

Expected: FAIL because `src/sources/event-clause-parser.ts` does not exist.

- [ ] **Step 3: Add reporting-complement, subordinate-clause, ambiguity, fact, and limit tests**

Extend the same test file with these exact cases:

```ts
it("uses the explicit subject inside a reporting complement", () => {
  const parsed = parseEventClauses({
    text: {
      title:
        "Evaluation Agency announced that Model Institute adopted Frontier Evaluation Standard",
    },
    eventFamilies: ["evaluation-standards"],
    semantics,
  });

  expect(parsed).toMatchObject([{
    predicate: "adopted",
    subject: "model-institute",
    domain: "governance-event",
    object: "frontier-evaluation-standard",
  }]);
});

it.each(["after", "before", "because", "while", "whereas", "but"])(
  "does not leak an event or fact across %s",
  (boundary) => {
    const parsed = parseEventClauses({
      text: {
        title:
          `Frontier Evaluation Standard was discussed ${boundary} ` +
          "another policy was adopted and takes effect July 1, 2027",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toEqual([]);
  },
);

it("keeps a same-clause material fact with its event", () => {
  const parsed = parseEventClauses({
    text: {
      title:
        "Model Institute adopted Frontier Evaluation Standard, " +
        "which takes effect July 1, 2027",
    },
    eventFamilies: ["evaluation-standards"],
    semantics,
  });

  expect(parsed[0]?.facts).toEqual([{
    kind: "date",
    key: "effective-date",
    value: "2027-07-01",
  }]);
});

it("returns no record when one clause has multiple event objects", () => {
  const parsed = parseEventClauses({
    text: {
      title:
        "Model Institute adopted Frontier Evaluation Standard and " +
        "launched Community Research Program",
    },
    eventFamilies: ["evaluation-standards", "funding-budget"],
    semantics,
  });

  expect(parsed).toEqual([]);
});

it("does not resolve a pronoun-led fact clause", () => {
  const parsed = parseEventClauses({
    text: {
      title: "Model Institute adopted Frontier Evaluation Standard.",
      abstract: "It takes effect July 1, 2027.",
    },
    eventFamilies: ["evaluation-standards"],
    semantics,
  });

  expect(parsed[0]?.facts).toEqual([]);
});

it("fails open when reporting complements exceed three levels", () => {
  const parsed = parseEventClauses({
    text: {
      title:
        "Evaluation Agency announced that Model Institute reported that " +
        "Evaluation Agency said that Model Institute announced that " +
        "Evaluation Agency adopted Frontier Evaluation Standard",
    },
    eventFamilies: ["evaluation-standards"],
    semantics,
  });

  expect(parsed).toEqual([]);
});
```

- [ ] **Step 4: Implement the pure parser with bounded, conservative segmentation**

Create `src/sources/event-clause-parser.ts` with the interfaces above and these
implementation rules:

```ts
const MAX_COMPLEMENT_DEPTH = 3;
const MAX_CLAUSES_PER_SENTENCE = 16;

const ACTIVE_EVENT =
  /^(?<subject>.+?)\s+(?<predicate>proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|announces?|announced|updates?|updated)\b(?<objectText>.+)$/i;

const PASSIVE_EVENT =
  /^(?<objectText>.+?)\s+(?:was|is|has been|had been)\s+(?<predicate>proposed|introduced|adopted|approved|launched|released|unveiled|published|issued|announced|updated)\s+by\s+(?<subject>[^.!?]+)$/i;

const HEADLINE_EVENT =
  /^(?<subject>.+?):\s*(?<objectText>.+?)\s+(?<predicate>proposed|introduced|adopted|approved|launched|released|unveiled|published|issued|announced|updated)$/i;

const REPORTING_COMPLEMENT =
  /\b(?:says?|said|reports?|reported|details?|detailed|confirms?|confirmed|announces?|announced)\s+that\s+/i;

const CLAUSE_BOUNDARY =
  /;\s*|,\s*(?=(?:after|before|because|while|whereas|but)\b)|\s+(?=(?:after|before|because|while|whereas|but)\b)/i;
```

Implement the parser in this order:

1. Iterate non-empty fields in the fixed order `title`, `abstract`, `content`.
2. Split each field with the existing sentence boundary behavior:
   `/(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z])/`.
3. Strip only known leading discourse markers.
4. Recursively follow a `REPORTING_COMPLEMENT`; parse the complement instead of
   the wrapper, and reject the sentence when depth would exceed 3.
5. Split supported subordinate/contrast boundaries, remove their leading marker,
   and reject the sentence if it produces more than 16 candidates.
6. Parse each candidate against passive, headline, then active patterns.
7. Normalize the predicate to the past-tense union in `ParsedEventClause`.
8. Ask `canonicalSubject` to resolve only the captured subject span.
9. Ask `eventObjects` to resolve only the captured object span. Require exactly
   one candidate.
10. Reject a candidate when its subject begins with a pronoun or when multiple
    supported event predicates remain in its object span.
11. Construct a `CanonicalEventInstance` from the resolved top-level fields and
    call `materialFacts` with only that instance and the successfully parsed
    clause text.
12. Return records in field/sentence/clause order without cross-clause
    coreference or inferred subjects.

For the relative clause `, which takes effect ...`, retain that phrase with the
immediately preceding event clause solely for fact extraction. Do not treat
standalone `it`, `this`, `that`, `they`, `these`, `those`, `he`, or `she`
clauses as continuations.

- [ ] **Step 5: Run the parser tests and make them pass**

Run:

```bash
npx vitest run tests/unit/sources/event-clause-parser.test.ts
```

Expected: all parser tests PASS.

- [ ] **Step 6: Run static verification for the new module**

Run:

```bash
npm run check
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit the pure parser**

```bash
git add src/sources/event-clause-parser.ts tests/unit/sources/event-clause-parser.test.ts
git commit -m "feat: add bounded event clause parser"
```

---

### Task 2: Integrate clause ownership into repeat suppression

**Files:**
- Create: `tests/unit/sources/news-signals.test.ts`
- Modify: `src/sources/event-clause-parser.ts`
- Modify: `tests/unit/sources/event-clause-parser.test.ts`
- Modify: `src/sources/news-signals.ts:24-64`
- Modify: `src/sources/news-signals.ts:101-175`
- Modify: `src/sources/news-signals.ts:465-640`
- Modify: `src/sources/news-signals.ts:824-862`
- Modify: `src/sources/news-signals.ts:1002-1068`
- Modify: `tests/unit/editorial/pipeline.test.ts:1107-1500`

**Interfaces:**
- Consumes:
  - `parseEventClauses`, `EventTextFields`, and `ParsedEventClause` from Task 1.
  - Existing `eventObjectCandidates`, `canonicalInstanceSubject`,
    `normalizedEventObject`, and material-fact normalization rules.
- Produces:
  - `parseEventFactClauses(...)`, which returns fact-only records for clauses
    that explicitly name a provided resolved event object.
  - Unchanged `deriveCanonicalEventInstances(...)`.
  - Unchanged `deriveMaterialFacts(...)`.
  - Unchanged `deriveScopedMaterialFacts(...)`.
  - Unchanged `deriveNewsSignals(...)`.
  - A single text-derived event instance and only its same-clause scoped facts,
    or empty arrays when the text is ambiguous.

The Task 2 parser extension has this exact interface:

```ts
export interface ParsedEventFactClause {
  sourceField: "title" | "abstract" | "content";
  sentenceIndex: number;
  clauseIndex: number;
  text: string;
  domain: CanonicalEventDomain;
  object: string;
  facts: NewsMaterialFact[];
}

export function parseEventFactClauses(input: {
  text: EventTextFields;
  eventFamilies: readonly string[];
  eventInstance: CanonicalEventInstance;
  semantics: EventClauseSemantics;
}): ParsedEventFactClause[];
```

- [ ] **Step 1: Write real-semantics regressions for the two review defects**

Create `tests/unit/sources/news-signals.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { deriveNewsSignals } from "../../../src/sources/news-signals";

function signals(input: {
  title: string;
  abstract?: string | null;
  content?: string | null;
}) {
  return deriveNewsSignals({
    kind: "article",
    title: input.title,
    abstract: input.abstract,
    content: input.content,
    originalUrl: "https://example.com/story",
    sectionEligibility: ["ai_policy"],
    metadata: { primarySection: "ai_policy" },
    preferredSection: "ai_policy",
  });
}

describe("news event clause integration", () => {
  it("binds an embedded event to the embedded subject", () => {
    const result = signals({
      title:
        "Evaluation Agency announced that Model Institute adopted " +
        "Frontier Evaluation Standard",
    });

    expect(result.eventInstances).toEqual([{
      subject: "model-institute",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
    expect(result.scopedMaterialFacts).toEqual([
      expect.objectContaining({
        kind: "status",
        key: "event-status",
        value: "adopted",
      }),
    ]);
  });

  it("does not attach a subordinate policy event or date to the standard", () => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        "Frontier Evaluation Standard was discussed after another policy " +
        "was adopted and takes effect July 1, 2026",
    });

    expect(result.eventInstances).toEqual([{
      subject: "evaluation-agency",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
    expect(result.scopedMaterialFacts).toEqual([
      expect.objectContaining({
        kind: "status",
        key: "event-status",
        value: "proposed",
      }),
    ]);
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "adopted" }),
        expect.objectContaining({ value: "2026-07-01" }),
      ]),
    );
  });
});
```

- [ ] **Step 2: Add integration tests for same-clause facts, conflicts, metadata, and field order**

Extend `tests/unit/sources/news-signals.test.ts`:

```ts
it("keeps status, amount, and date facts in the exact funding clause", () => {
  const result = signals({
    title: "Funding Agency launches Community Research Program",
    abstract:
      "Funding Agency launched Community Research Program with $100 million " +
      "in funding, effective December 1, 2026",
    content:
      "Another program had $125 million in funding before it took effect July 1, 2027",
  });

  expect(result.scopedMaterialFacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "status", value: "released" }),
      expect.objectContaining({ kind: "amount", value: "100000000" }),
      expect.objectContaining({ kind: "date", value: "2026-12-01" }),
    ]),
  );
  expect(result.scopedMaterialFacts).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "125000000" }),
      expect.objectContaining({ value: "2027-07-01" }),
    ]),
  );
});

it("returns no canonical instance for conflicting text-derived events", () => {
  const result = signals({
    title:
      "Evaluation Agency proposes Frontier Evaluation Standard",
    abstract:
      "Model Institute adopted Model Transparency Rule",
  });

  expect(result.eventInstances).toEqual([]);
  expect(result.scopedMaterialFacts).toEqual([]);
});

it("accepts only explicitly scoped metadata for the resolved text event", () => {
  const result = deriveNewsSignals({
    kind: "article",
    title:
      "Evaluation Agency proposes Frontier Evaluation Standard",
    abstract: null,
    content: null,
    originalUrl: "https://example.com/scoped",
    sectionEligibility: ["ai_policy"],
    metadata: {
      primarySection: "ai_policy",
      materialFacts: [{
        kind: "status",
        key: "event-status",
        value: "adopted",
      }],
      scopedMaterialFacts: [{
        kind: "date",
        key: "deadline-date",
        value: "2026-12-01",
        eventInstance: {
          subject: "evaluation-agency",
          domain: "governance-event",
          object: "frontier-evaluation-standard",
        },
      }],
    },
    preferredSection: "ai_policy",
  });

  expect(result.scopedMaterialFacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "proposed" }),
      expect.objectContaining({ value: "2026-12-01" }),
    ]),
  );
  expect(result.scopedMaterialFacts).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "adopted" }),
    ]),
  );
});

it("resolves the same unique tuple regardless of which field repeats it", () => {
  const titleOnly = signals({
    title:
      "Evaluation Agency adopts Frontier Evaluation Standard",
  });
  const repeatedInContent = signals({
    title:
      "Evaluation Agency adopts Frontier Evaluation Standard",
    content:
      "Evaluation Agency adopted Frontier Evaluation Standard",
  });

  expect(repeatedInContent.eventInstances).toEqual(
    titleOnly.eventInstances,
  );
});
```

- [ ] **Step 3: Run the new integration tests and confirm the old implementation fails**

Run:

```bash
npx vitest run tests/unit/sources/news-signals.test.ts
```

Expected: FAIL on the embedded-subject and subordinate-fact regressions.

- [ ] **Step 4: Extend the parser with exact-object fact clauses and the safe headline form**

Before modifying parser production code, add these tests to
`tests/unit/sources/event-clause-parser.test.ts` and run them to observe the
expected missing-export/headline failures:

```ts
import {
  parseEventClauses,
  parseEventFactClauses,
  type EventClauseSemantics,
} from "../../../src/sources/event-clause-parser";

it("parses an organization-led headline with an explicit actor and object", () => {
  const parsed = parseEventClauses({
    text: {
      title:
        "Evaluation Agency Frontier Evaluation Standard adopted",
    },
    eventFamilies: ["evaluation-standards"],
    semantics,
  });

  expect(parsed).toMatchObject([{
    predicate: "adopted",
    subject: "evaluation-agency",
    domain: "governance-event",
    object: "frontier-evaluation-standard",
  }]);
});

it("extracts facts from a clause that names the exact resolved object", () => {
  const parsed = parseEventFactClauses({
    text: {
      title:
        "Frontier Evaluation Standard takes effect July 1, 2027",
    },
    eventFamilies: ["evaluation-standards"],
    eventInstance: {
      subject: "model-institute",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    },
    semantics,
  });

  expect(parsed).toEqual([{
    sourceField: "title",
    sentenceIndex: 0,
    clauseIndex: 0,
    text:
      "Frontier Evaluation Standard takes effect July 1, 2027",
    domain: "governance-event",
    object: "frontier-evaluation-standard",
    facts: [{
      kind: "date",
      key: "effective-date",
      value: "2027-07-01",
    }],
  }]);
});

it.each([
  "It takes effect July 1, 2027",
  "The policy takes effect July 1, 2027",
  "Community Research Program takes effect July 1, 2027",
])("rejects a non-exact fact reference: %s", (title) => {
  const parsed = parseEventFactClauses({
    text: { title },
    eventFamilies: ["evaluation-standards", "funding-budget"],
    eventInstance: {
      subject: "model-institute",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    },
    semantics,
  });

  expect(parsed).toEqual([]);
});
```

Run:

```bash
npx vitest run tests/unit/sources/event-clause-parser.test.ts
```

Expected RED: `parseEventFactClauses` is missing and the organization-led
headline produces no parsed event.

Then extend `src/sources/event-clause-parser.ts`:

1. Add the exported `ParsedEventFactClause` interface and
   `parseEventFactClauses` signature specified in this task's Interfaces block.
2. Add a separate organization-led headline pattern whose captured subject ends
   in `Agency`, `Institute`, `University`, `Department`, `Commission`,
   `Administration`, `Company`, `Laboratory`, or `Lab`. Keep the existing colon
   headline form.
3. Match passive, colon headline, organization-led headline, then active.
4. Reuse the existing bounded field/sentence/clause segmentation for fact
   clauses.
5. Reject pronoun-led clauses before semantic callbacks.
6. Call `semantics.eventObjects` with the individual clause. Require exactly one
   candidate whose `domain` and `object` exactly equal the supplied
   `eventInstance`.
7. Call `semantics.materialFacts` only after that exact match and return no
   record when it produces no facts.
8. Never use a fact-only clause to create or change a
   `CanonicalEventInstance`.

Run the focused parser test again. Expected GREEN: all parser tests pass,
including the new headline and exact-object cases.

- [ ] **Step 5: Extract clause-local fact parsing without changing general facts**

In `src/sources/news-signals.ts`, perform a mechanical extraction from
`deriveMaterialFacts`: move the existing statements beginning with
`const facts: NewsMaterialFact[] = []` through the date-matching loop into
`extractMaterialFacts(sourceText: string)`. Replace the existing normalization
tail with this complete shared helper:

```ts
function uniqueMaterialFacts(
  facts: readonly NewsMaterialFact[],
): NewsMaterialFact[] {
  const uniqueFacts = new Map<string, NewsMaterialFact>();
  for (const fact of facts) {
    const normalizedFact = {
      ...fact,
      value:
        fact.kind === "number" || fact.kind === "amount"
          ? normalizeNumberFact(fact.value)
          : fact.kind === "date"
            ? normalizeDateFact(fact.value)
            : fact.value.toLocaleLowerCase("en-US").trim(),
    };
    uniqueFacts.set(
      `${normalizedFact.kind}\u0000${normalizedFact.key}\u0000${normalizedFact.value}`,
      normalizedFact,
    );
  }
  return [...uniqueFacts.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key) ||
      left.value.localeCompare(right.value),
  );
}
```

End the extracted function with `return uniqueMaterialFacts(facts)`. Do not
change the status, count, amount, or date regular expressions during this
mechanical step.

Then preserve the public unscoped behavior:

```ts
export function deriveMaterialFacts(
  text: MaterialTextInput,
  metadata: Readonly<Record<string, unknown>>,
  eventInstance: CanonicalEventInstance | null = null,
): NewsMaterialFact[] {
  if (eventInstance === null) {
    return extractMaterialFacts(combinedText(text));
  }

  const eventFamilies = deriveEventFamilies(text, metadata);
  const clauses = parseNewsEventClauses(text, eventFamilies);
  return scopedFactsForInstance(
    clauses,
    parseNewsEventFactClauses(
      text,
      eventFamilies,
      eventInstance,
    ),
    eventInstance,
  );
}
```

Do not read `metadata.materialFacts` in either branch.

- [ ] **Step 6: Add the domain-semantics adapter and stable tuple resolution**

Import Task 1:

```ts
import {
  parseEventClauses,
  parseEventFactClauses,
  type EventClauseSemantics,
  type EventTextFields,
  type ParsedEventClause,
  type ParsedEventFactClause,
} from "./event-clause-parser";
```

Add these internal helpers:

```ts
function eventTextFields(input: MaterialTextInput): EventTextFields {
  if (typeof input === "string") return { title: input };
  return {
    title: input[0] ?? "",
    abstract: input[1] ?? null,
    content: input[2] ?? null,
  };
}

function newsClauseSemantics(): EventClauseSemantics {
  return {
    canonicalSubject(subjectText) {
      return canonicalInstanceSubject(
        deriveNamedEntities(subjectText, {}),
      );
    },
    eventObjects(objectText, families, subject) {
      return eventObjectCandidates(objectText, families)
        .map((candidate) => ({
          ...candidate,
          object: normalizedEventObject(candidate.object, subject),
        }))
        .filter(
          ({ object }) =>
            object !== "generic-governance-instrument",
        );
    },
    materialFacts(clauseText) {
      return extractMaterialFacts(clauseText);
    },
  };
}

function parseNewsEventClauses(
  text: MaterialTextInput,
  eventFamilies: readonly string[],
): ParsedEventClause[] {
  return parseEventClauses({
    text: eventTextFields(text),
    eventFamilies,
    semantics: newsClauseSemantics(),
  });
}

function parseNewsEventFactClauses(
  text: MaterialTextInput,
  eventFamilies: readonly string[],
  eventInstance: CanonicalEventInstance,
): ParsedEventFactClause[] {
  return parseEventFactClauses({
    text: eventTextFields(text),
    eventFamilies,
    eventInstance,
    semantics: newsClauseSemantics(),
  });
}

function canonicalInstances(
  clauses: readonly ParsedEventClause[],
): CanonicalEventInstance[] {
  const instances = new Map(
    clauses.map(({ subject, domain, object }) => [
      `${subject}\u0000${domain}\u0000${object}`,
      { subject, domain, object },
    ]),
  );
  return instances.size === 1 ? [...instances.values()] : [];
}
```

The parser must receive only captured subject and object spans; never pass a
whole sentence to `canonicalSubject` or `eventObjects`.

- [ ] **Step 7: Replace sentence-wide event and scoped-fact derivation**

Update the exported wrappers:

```ts
export function deriveCanonicalEventInstances(
  input: MaterialTextInput,
  _metadata: Readonly<Record<string, unknown>>,
  _namedEntities: readonly string[],
  eventFamilies: readonly string[],
): CanonicalEventInstance[] {
  return canonicalInstances(
    parseNewsEventClauses(input, eventFamilies),
  );
}

function scopedFactsForInstance(
  clauses: readonly ParsedEventClause[],
  factClauses: readonly ParsedEventFactClause[],
  eventInstance: CanonicalEventInstance,
): NewsMaterialFact[] {
  return uniqueMaterialFacts(
    [
      ...clauses.filter((candidate) =>
        candidate.subject === eventInstance.subject &&
        candidate.domain === eventInstance.domain &&
        candidate.object === eventInstance.object,
      ),
      ...factClauses.filter((candidate) =>
        candidate.domain === eventInstance.domain &&
        candidate.object === eventInstance.object,
      ),
    ].flatMap(({ facts }) => facts),
  );
}
```

Refactor the existing fact deduplication/sort tail into
`uniqueMaterialFacts(facts)` and use it for both general and scoped facts.

Add the shared scoped helper and preserve the exported wrapper:

```ts
function sameEventInstance(
  left: CanonicalEventInstance,
  right: CanonicalEventInstance,
): boolean {
  return left.subject === right.subject &&
    left.domain === right.domain &&
    left.object === right.object;
}

function scopedMaterialFactsForResolvedEvent(input: {
  clauses: readonly ParsedEventClause[];
  factClauses: readonly ParsedEventFactClause[];
  metadata: Readonly<Record<string, unknown>>;
  eventInstances: readonly CanonicalEventInstance[];
}): ScopedNewsMaterialFact[] {
  if (input.eventInstances.length !== 1) return [];
  const eventInstance = input.eventInstances[0];
  if (eventInstance === undefined) return [];

  const explicit = Array.isArray(input.metadata.scopedMaterialFacts)
    ? input.metadata.scopedMaterialFacts.flatMap(
        (entry): ScopedNewsMaterialFact[] => {
          const parsed = ScopedNewsMaterialFactSchema.safeParse(entry);
          return parsed.success &&
            sameEventInstance(
              parsed.data.eventInstance,
              eventInstance,
            )
            ? [parsed.data]
            : [];
        },
      )
    : [];
  const derived = scopedFactsForInstance(
    input.clauses,
    input.factClauses,
    eventInstance,
  ).map((fact) => ({ ...fact, eventInstance }));
  const unique = new Map(
    [...explicit, ...derived].map((fact) => [
      `${fact.kind}\u0000${fact.key}\u0000${fact.value}`,
      fact,
    ]),
  );
  return [...unique.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key) ||
      left.value.localeCompare(right.value),
  );
}

export function deriveScopedMaterialFacts(
  text: MaterialTextInput,
  metadata: Readonly<Record<string, unknown>>,
  eventInstances: readonly CanonicalEventInstance[],
): ScopedNewsMaterialFact[] {
  const eventFamilies = deriveEventFamilies(text, metadata);
  const clauses = parseNewsEventClauses(text, eventFamilies);
  const eventInstance = eventInstances.length === 1
    ? eventInstances[0] ?? null
    : null;
  return scopedMaterialFactsForResolvedEvent({
    clauses,
    factClauses: eventInstance === null
      ? []
      : parseNewsEventFactClauses(
          text,
          eventFamilies,
          eventInstance,
        ),
    metadata,
    eventInstances,
  });
}
```

Delete the superseded `eventTuplesForSentence`,
`referencesExactEventInstance`, `regexPhrase`, and `materialFactClauses`
functions. Do not retain a second sentence-wide fallback.

- [ ] **Step 8: Resolve identity before the bounded fact-clause pass**

Inside `deriveNewsSignals`, replace independent tuple/fact parsing with one
clause parse:

```ts
const parsedEventClauses = parseNewsEventClauses(
  materialText,
  eventFamilies,
);
const eventInstances = canonicalInstances(parsedEventClauses);
const eventInstance = eventInstances.length === 1
  ? eventInstances[0] ?? null
  : null;
const parsedEventFactClauses = eventInstance === null
  ? []
  : parseNewsEventFactClauses(
      materialText,
      eventFamilies,
      eventInstance,
    );
const scopedMaterialFacts = scopedMaterialFactsForResolvedEvent({
  clauses: parsedEventClauses,
  factClauses: parsedEventFactClauses,
  metadata: input.metadata,
  eventInstances,
});
const materialFacts = extractMaterialFacts(combinedText(materialText));
```

Keep the exported wrapper functions for compatibility, but use shared internal
helpers so `deriveNewsSignals` does not parse the same text more than once.

- [ ] **Step 9: Run the source-level tests and make them pass**

Run:

```bash
npx vitest run tests/unit/sources/event-clause-parser.test.ts tests/unit/sources/news-signals.test.ts
```

Expected: all parser and real-semantics integration tests PASS.

- [ ] **Step 10: Add end-to-end fail-open and fingerprint regressions**

Append two tests to `tests/unit/editorial/pipeline.test.ts` using its existing
`rawNews`, `normalizeCandidate`, and `clusterNews` helpers:

```ts
it("fails open for unsupported or conflicting clause ownership", () => {
  const ambiguous = normalizeCandidate(
    rawNews("ambiguous-clause", {
      title:
        "Evaluation Agency and Model Institute discussed Frontier Evaluation Standard",
      abstract:
        "It was adopted and takes effect July 1, 2027",
      content: null,
      primaryDocumentUrl: null,
      namedEntities: [],
    }),
  );

  const development = clusterNews([ambiguous], {})[0];

  expect(development?.eventInstance).toBeNull();
  expect(development?.repeatable).toBe(false);
});

it("changes only the material fingerprint for a same-event clause update", () => {
  const development = (sourceId: string, date: string) =>
    clusterNews([
      normalizeCandidate(
        rawNews(sourceId, {
          title:
            "Evaluation Agency adopts Frontier Evaluation Standard",
          abstract:
            "Evaluation Agency adopted Frontier Evaluation Standard, " +
            `which takes effect ${date}`,
          content: null,
          primaryDocumentUrl: null,
          namedEntities: [],
        }),
      ),
    ], {})[0];

  const december = development("effective-december", "December 1, 2026");
  const january = development("effective-january", "January 1, 2027");

  expect(december?.repeatable).toBe(true);
  expect(january?.repeatable).toBe(true);
  expect(december?.developmentKey).toBe(january?.developmentKey);
  expect(december?.materialFactsFingerprint).not.toBe(
    january?.materialFactsFingerprint,
  );
});
```

- [ ] **Step 11: Run the editorial pipeline regression suite**

Run:

```bash
npx vitest run tests/unit/editorial/pipeline.test.ts
```

Expected: all editorial pipeline tests PASS, including all adversarial Task 7
cases accumulated before this recovery.

- [ ] **Step 12: Run full project verification**

Run each command separately:

```bash
npm test
npm run test:worker
npm run check
npm run build
git diff --check
```

Expected:

- all unit tests PASS;
- all Worker tests PASS;
- TypeScript check PASS;
- Vite production build PASS;
- `git diff --check` prints no errors.

- [ ] **Step 13: Commit the integration**

```bash
git add src/sources/news-signals.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/pipeline.test.ts
git commit -m "fix: bind repeat identity to event clauses"
```

---

## Formal Review and Parent-plan Handoff

After both task commits:

1. Dispatch a fresh final reviewer with the approved design, this plan, task
   reports, and the complete recovery diff.
2. Require explicit review of the two original defects, fail-open behavior,
   same-clause fact ownership, public contract preservation, and absence of a
   sentence-wide fallback.
3. Address any blocking finding with a failing regression first.
4. Run the full verification suite again after the final accepted change.
5. Mark the recovery task complete in its own SDD ledger.
6. Update the original morning-briefing SDD ledger so Task 7 is complete,
   referencing the recovery commits and verification evidence.
7. Resume the original implementation plan at Task 8.
