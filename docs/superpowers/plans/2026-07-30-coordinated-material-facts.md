# Coordinated Material Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent material status and date facts from leaking across explicit `and` coordination while preserving same-object fact suffixes.

**Architecture:** Extend the pure clause parser's shared segmenter with a material-predicate vocabulary and a conservative explicit-right-owner test. Event and fact-only parsing continue to consume the same bounded clause candidates, so no downstream fallback or interface change is required.

**Tech Stack:** TypeScript 5.8, Vitest 3, existing Cloudflare Worker/Vite build; no new dependency.

## Global Constraints

- Failure policy is fail open.
- Split `and` only when both sides contain recognized material predicates and
  the right side explicitly introduces its own organization subject or event
  object.
- Do not split a shared-object suffix such as `adopted and takes effect July 1`.
- Do not resolve pronouns or generic object references.
- Material fact clauses never create event identity.
- Preserve all existing parser and news-signal interfaces and limits.
- Add no sentence-wide fallback, dependency, I/O, model call, or unrelated
  source/ranking/UI/persistence change.

---

### Task 1: Complete conservative material coordination

**Files:**
- Modify: `src/sources/event-clause-parser.ts`
- Modify: `tests/unit/sources/event-clause-parser.test.ts`
- Modify: `tests/unit/sources/news-signals.test.ts`

**Interfaces:**
- Consumes unchanged:
  - `parseEventClauses(...)`
  - `parseEventFactClauses(...)`
  - `deriveNewsSignals(...)`
- Produces no new exported interface.
- The shared internal clause segmenter recognizes explicit coordinated
  material propositions before either parser extracts identity or facts.

- [ ] **Step 1: Add failing parser regressions for coordinated material facts**

In `tests/unit/sources/event-clause-parser.test.ts`, add a table-driven test
using the existing parser semantics and resolved frontier-standard instance:

```ts
it.each([
  "delayed",
  "postponed",
  "blocked",
  "rejected",
  "withdrawn",
  "repealed",
])(
  "isolates an unrelated %s status from an exact-object date",
  (status) => {
    const parsed = parseEventFactClauses({
      text: {
        title:
          `Another policy was ${status}, and ` +
          "Frontier Evaluation Standard takes effect July 1, 2027",
      },
      eventFamilies: ["evaluation-standards"],
      eventInstance: {
        subject: "model-institute",
        domain: "governance-event",
        object: "frontier-evaluation-standard",
      },
      semantics: materialStatusSemantics,
    });

    expect(parsed.flatMap(({ facts }) => facts)).toEqual([{
      kind: "date",
      key: "effective-date",
      value: "2027-07-01",
    }]);
  },
);
```

`materialStatusSemantics` must reuse the existing object callback and return
literal status/date facts found in its received clause. Its purpose is to prove
the parser supplies only the owned clause to the callback, not to duplicate
production news-signal normalization.

Add the reverse-order case:

```ts
it("isolates an exact-object date from a later unrelated status", () => {
  const parsed = parseEventFactClauses({
    text: {
      title:
        "Frontier Evaluation Standard takes effect July 1, 2027, and " +
        "another policy was blocked",
    },
    eventFamilies: ["evaluation-standards"],
    eventInstance: {
      subject: "model-institute",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    },
    semantics: materialStatusSemantics,
  });

  expect(parsed.flatMap(({ facts }) => facts)).toEqual([{
    kind: "date",
    key: "effective-date",
    value: "2027-07-01",
  }]);
});
```

- [ ] **Step 2: Add failing real-semantics and preservation regressions**

In `tests/unit/sources/news-signals.test.ts`, add:

```ts
it.each([
  "delayed",
  "postponed",
  "blocked",
  "rejected",
  "withdrawn",
  "repealed",
])(
  "does not leak coordinated %s status to the exact event object",
  (status) => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        `Another policy was ${status}, and ` +
        "Frontier Evaluation Standard takes effect July 1, 2027",
    });

    expect(result.scopedMaterialFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "proposed" }),
        expect.objectContaining({ value: "2027-07-01" }),
      ]),
    );
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          value:
            status === "postponed" ? "delayed" :
            status === "rejected" ? "blocked" :
            status === "repealed" ? "withdrawn" :
            status,
        }),
      ]),
    );
  },
);

it("preserves same-object adopted and effective facts", () => {
  const result = signals({
    title:
      "Evaluation Agency adopts Frontier Evaluation Standard",
    abstract:
      "Frontier Evaluation Standard was adopted and takes effect July 1, 2027",
  });

  expect(result.scopedMaterialFacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "adopted" }),
      expect.objectContaining({ value: "2027-07-01" }),
    ]),
  );
});
```

Add a pronoun-led right-clause case and assert that it contributes no scoped
date.

- [ ] **Step 3: Run the focused suites and verify RED**

Run:

```bash
npx vitest run tests/unit/sources/event-clause-parser.test.ts tests/unit/sources/news-signals.test.ts
```

Expected: the new status-family cases fail because the left and right
propositions are still delivered as one fact clause; all prior tests remain
green.

- [ ] **Step 4: Implement the minimal shared segmentation rule**

In `src/sources/event-clause-parser.ts`:

1. Keep the existing supported event-predicate expression unchanged.
2. Add word-bounded internal material date and predicate expressions covering:

```ts
const MATERIAL_DATE =
  "(?:20\\d{2}-\\d{2}-\\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2}(?:,\\s+20\\d{2})?)";

const MATERIAL_PREDICATE = new RegExp(
  `\\b(?:propos(?:e|es|ed)|introduc(?:e|es|ed)|adopt(?:s|ed)?|approv(?:e|es|ed)|pass(?:es|ed)?|launch(?:es|ed)?|releas(?:e|es|ed)|publish(?:es|ed)|unveil(?:s|ed)?|issu(?:e|es|ed)|announc(?:e|es|ed)|updat(?:e|es|ed)|delay(?:s|ed)?|postpon(?:e|es|ed)|reject(?:s|ed)?|block(?:s|ed)?|withdraw(?:s|n)?|repeal(?:s|ed)?|effective|takes?\\s+effect|deadline(?:\\s+is|\\s+of)?|by\\s+${MATERIAL_DATE})\\b`,
  "i",
);
```

3. At each candidate `and` boundary, require `MATERIAL_PREDICATE` on both the
   left and right spans.
4. Require the trimmed right span to begin with either:
   - an explicit organization phrase ending in an approved organization
     suffix; or
   - an explicit event-object phrase recognized by the parser's bounded
     object-shape grammar.
5. Reject right spans beginning with `it`, `this`, `that`, `they`, `these`,
   `those`, `he`, or `she`.
6. When all conditions hold, split into two clause candidates. Otherwise retain
   the original clause, except existing unsafe-coordination rejection remains
   in force.
7. Apply the existing 16-candidate cap after material coordination.

The optional determiner for an explicit organization owner must accept exactly
`The` or `the`; the following organization phrase retains its existing
capitalization and five-token bound.

Do not infer whether a generic phrase refers to the resolved event. Exact
domain/object matching remains the semantic callback's responsibility.

- [ ] **Step 5: Run focused suites and verify GREEN**

Run:

```bash
npx vitest run tests/unit/sources/event-clause-parser.test.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/pipeline.test.ts
```

Expected: all focused tests pass; the same-object preservation case retains
both facts.

- [ ] **Step 6: Run complete verification**

Run separately:

```bash
npm test
npm run test:worker
npm run check
npm run build
git diff --check
```

Expected:

- all unit tests pass;
- all Worker tests pass;
- TypeScript and production build pass;
- whitespace check prints no errors.

- [ ] **Step 7: Commit**

```bash
git add src/sources/event-clause-parser.ts tests/unit/sources/event-clause-parser.test.ts tests/unit/sources/news-signals.test.ts
git commit -m "fix: isolate coordinated material facts"
```

---

## Final Review Amendment

The user approved this amendment after final review found that the original
literal regex did not fully express the approved design.

Before the final fix wave, add failing parser and real-semantics regressions
for:

1. `Unblocked Safety Rule` not matching the `blocked` predicate or causing a
   false split; coordinated distinct objects must remain ambiguous.
2. Each missing supported action—`issued`, `announced`, and `updated`—on the
   unrelated side of an exact-object material clause.
3. Forward and reverse `by July 1, 2027` deadline ownership.
4. Reverse coordination whose explicit right owner begins with sentence-
   internal lowercase `the Evaluation Agency`.

Observe the tests fail before implementation. Then:

- replace the unbounded material regex with the word-bounded
  `MATERIAL_DATE`/`MATERIAL_PREDICATE` definitions above;
- accept `[Tt]he` only as the optional organization-owner determiner;
- preserve the existing organization capitalization/token bound and all
  previous coordination behavior.

Run the focused parser/news-signal/pipeline suites and the complete verification
matrix. Append the final fix evidence to the task report and commit with:

```bash
git add src/sources/event-clause-parser.ts tests/unit/sources/event-clause-parser.test.ts tests/unit/sources/news-signals.test.ts
git commit -m "fix: bound coordinated material grammar"
```

---

## Review Gate

A fresh reviewer must inspect the task diff and verdict the previously open
coordination finding. Critical or Important findings enter the normal
subagent-driven fix loop. After a clean review and fresh full verification,
mark the parent Event Clause Parser Recovery and original morning-briefing Task
7 complete, referencing this follow-up commit.
