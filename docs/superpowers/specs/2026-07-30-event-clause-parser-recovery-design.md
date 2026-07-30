# Event Clause Parser Recovery — Design Specification

**Status:** Approved design  
**Date:** July 30, 2026  
**Parent plan:** Personal Morning Briefing, Task 7  
**Failure policy:** Fail open
**Amendment:** Exact-object fact clauses and organization-led headlines
approved July 30, 2026

## 1. Purpose

The morning briefing suppresses repeated news only when it can identify the
same real-world event across editions and determine that no material fact has
changed. The existing implementation derives that identity with sentence-wide
regular expressions. This works for simple prose but can bind the wrong actor or
fact when a sentence contains reporting wrappers, embedded events, or
subordinate clauses.

This recovery replaces the load-bearing sentence-wide matching with a small,
deterministic clause parser. Its job is deliberately narrow: bind an event's
subject, predicate family, object, and material facts to the same clause. When
the parser cannot do that unambiguously, the item remains eligible to appear in
the briefing.

The reader-facing priority is avoiding false suppression. Occasional repeated
stories are acceptable and can be tuned later; hiding a meaningful update is
not.

## 2. Problem Statement

Two unresolved constructions expose the architectural limitation:

1. **Embedded event**

   `Evaluation Agency announced that Model Institute adopted Frontier
   Evaluation Standard.`

   The real event is:

   `Model Institute → adopted → Frontier Evaluation Standard`

   The reporting organization must not become the subject of the adoption.

2. **Subordinate event with an unrelated fact**

   `Frontier Evaluation Standard was discussed after another policy was adopted
   and takes effect July 1.`

   The adoption and effective date belong to `another policy`, not necessarily
   to `Frontier Evaluation Standard`. The parser must not attach them to the
   standard merely because all phrases occur in one sentence.

The repeated defect pattern is caused by treating a sentence as the smallest
semantic unit. Additional exclusions in the existing regular expressions would
move the boundary but would not establish subject–predicate–object ownership.

## 3. Goals and Non-goals

### Goals

- Extract a canonical event only when one clause provides a coherent subject,
  supported event predicate, and specific event object.
- Inspect complements introduced by reporting verbs such as `announced that`
  and use the embedded event rather than the reporting wrapper.
- Separate coordinate and subordinate clauses, including `after` and `before`,
  so an event or fact does not leak into its neighboring clause.
- Attach material facts only to the event instance expressed in the same
  clause.
- After one event instance is resolved unambiguously, accept facts from a
  separate clause only when that clause explicitly names the same canonical
  event object.
- Preserve deterministic, auditable behavior suitable for a Cloudflare Worker.
- Preserve the existing `CanonicalEventInstance`,
  `ScopedNewsMaterialFact`, and `deriveNewsSignals` contracts.
- Make ambiguity explicitly non-repeatable so repeat suppression fails open.

### Non-goals

- General natural-language understanding.
- Pronoun or entity coreference resolution.
- Treating generic references such as `the policy`, `the standard`, or
  `the program` as exact event-object references.
- Dependency parsing for arbitrary English.
- Inferring unstated actors, objects, causality, or temporal relationships.
- Changing source collection, ranking weights, clustering policy, UI, or
  summarization.
- Adding a large NLP runtime or network model call to normalization.

## 4. Chosen Approach

Create a pure `event-clause-parser` module and move clause ownership decisions
into it. The parser uses a bounded grammar for the event constructions the
briefing recognizes. Existing domain-specific normalization remains responsible
for canonical event families, objects, and material-fact values.

A general-purpose NLP dependency was rejected because it would increase Worker
bundle size and operational uncertainty while making a safety-critical
suppression decision harder to audit. Disabling repeat suppression for all
complex prose was also rejected because a bounded deterministic parser can
retain useful suppression for common constructions without guessing.

## 5. Data Model

The internal parser returns clause-level records:

```ts
interface ParsedEventClause {
  sourceField: "title" | "abstract" | "content";
  sentenceIndex: number;
  clauseIndex: number;
  text: string;
  subject: string;
  predicate: SupportedEventPredicate;
  domain: string;
  object: string;
  facts: NewsMaterialFact[];
}
```

After the document has one resolved event, the parser may also return
fact-only clause records:

```ts
interface ParsedEventFactClause {
  sourceField: "title" | "abstract" | "content";
  sentenceIndex: number;
  clauseIndex: number;
  text: string;
  domain: string;
  object: string;
  facts: NewsMaterialFact[];
}
```

A fact-only record never creates event identity. It is accepted only when its
domain and explicit canonical object exactly match the document's already
resolved event instance.

This is an internal representation, not a persistence or API contract. A
record exists only when all required event fields are supported and
unambiguous. Provenance fields make clause ownership inspectable in tests and
debugging without affecting repeat identity.

The public canonical event remains:

```ts
interface CanonicalEventInstance {
  subject: string;
  domain: string;
  object: string;
}
```

## 6. Parsing Pipeline

### 6.1 Preserve source boundaries

The parser receives title, abstract, and content as distinct fields. It splits
each field into sentences while retaining source-field and sentence indexes.
It must not join the end of one field to the beginning of another.

### 6.2 Segment clauses

Each sentence is segmented at supported structural boundaries:

- semicolons;
- coordinating contrast markers such as `but`, `while`, and `whereas`;
- temporal and causal subordinate markers including `after`, `before`, and
  `because`;
- reporting complements introduced by `that`;
- supported coordinated predicates when the second predicate introduces its
  own explicit subject or object.

The segmenter retains the relationship between a wrapper and its complement but
does not copy the wrapper's subject into a complement that already has a
subject.

Splitting is intentionally conservative. If a boundary cannot be assigned
without changing meaning, the affected construction does not produce a
repeatable event.

### 6.3 Classify predicates

Predicates are divided into two roles:

- **Event predicates:** domain actions already recognized by the news pipeline,
  such as adopting, approving, issuing, launching, releasing, publishing, and
  taking effect.
- **Reporting predicates:** verbs such as saying, reporting, detailing, and
  announcing when they introduce another proposition.

A reporting predicate is not used as the canonical real-world event when it has
a supported complement. The parser recursively inspects the complement. If the
complement contains no supported, unambiguous event, the wrapper does not become
a substitute event solely to make the item repeatable.

### 6.4 Bind a clause-local event

The parser recognizes bounded active, passive, and headline constructions.
Subject, predicate, and object must be recoverable from the same clause:

- Active: `Model Institute adopted Frontier Evaluation Standard.`
- Passive: `Frontier Evaluation Standard was adopted by Model Institute.`
- Supported headline form: `Model Institute: Frontier Evaluation Standard
  adopted.`
- Supported organization-led headline form: `Evaluation Agency AI evaluation
  standard adopted.`

The existing entity and object canonicalization rules may be reused after the
clause identifies their spans. A generic or missing subject, multiple plausible
objects, multiple incompatible predicates, or an underspecified object makes
the clause unresolved.

### 6.5 Attach facts locally

Dates, amounts, counts, status changes, and other material facts are extracted
from either:

1. a parsed event clause that provides a complete event instance; or
2. after exactly one event instance has been resolved, a fact clause that
   explicitly names the same canonical event object.

Both paths emit `ScopedNewsMaterialFact` values associated with that exact
instance. An object-only fact clause can add facts but can never establish,
replace, or disambiguate event identity.

Facts in a sibling, wrapper, preceding, or subordinate clause are not attached
to the event unless that clause explicitly names the exact resolved event
object. A pronoun-led clause such as `It takes effect July 1`, or a generic
clause such as `The policy takes effect July 1`, is not coreference-resolved in
this recovery and therefore contributes no scoped fact.

Explicit valid `metadata.scopedMaterialFacts` continue to be accepted only when
their event instance exactly matches the single resolved canonical instance.
Legacy unscoped metadata never makes an ambiguous text construction repeatable.

### 6.6 Resolve document-level identity

After parsing all fields:

- Duplicate clause records for the same canonical tuple are collapsed.
- Exactly one distinct canonical tuple produces
  `eventInstances: [instance]`.
- Zero tuples produces `eventInstances: []`.
- More than one distinct tuple is ambiguous and produces
  `eventInstances: []`.

Only scoped facts from the event clause or an exact-object fact clause
belonging to the single resolved tuple contribute to its material-change
fingerprint. General material facts may still be retained for other editorial
uses, but they cannot influence repeat suppression without this clause
ownership.

## 7. Fail-open Semantics

Repeat suppression is allowed only when the normalized item has:

1. exactly one canonical event instance;
2. an event identity derived from a supported clause construction; and
3. no conflicting event evidence across its text fields.

If any condition fails, the normalized development is marked
`repeatable: false`. Prior-edition repeat filtering then leaves the item
eligible for ranking and publication.

Failing open is not an error state and does not lower the story's editorial
score. It means only that the system lacks enough structural confidence to hide
the story as a repeat.

## 8. Determinism and Operational Constraints

- The module is pure and performs no I/O.
- It introduces no external NLP dependency or model call.
- Output ordering is stable across input iteration and metadata key order.
- Normalization remains case-insensitive where existing contracts require it.
- Parser limits prevent unbounded recursion or pathological expression work.
- Unsupported grammar returns no event record rather than a best-effort guess.
- Parser provenance may be logged in development but is not exposed in the
  reader interface or stored unless a later observability task requires it.

## 9. Test Strategy

Implementation follows test-driven development. A table-driven grammar corpus
will cover:

- simple active, passive, colon-headline, and organization-led headline
  constructions;
- reporting wrappers with embedded `that` clauses;
- nested subjects that differ from wrapper subjects;
- `after`, `before`, `because`, `while`, `whereas`, `but`, and semicolon
  boundaries;
- multiple distinct events in one sentence or document;
- unrelated policies and incidental event objects;
- pronoun-led facts and other unsupported coreference;
- exact-object fact restatements and rejected generic-object restatements;
- dates, status changes, counts, and funding amounts;
- title, abstract, and content field boundaries;
- case and punctuation variants;
- explicit scoped metadata and ignored legacy unscoped facts.

Metamorphic tests will enforce these invariants:

- Reordering equivalent source fields does not change a unique event identity.
- Active/passive paraphrases produce the same canonical tuple.
- Adding a reporting wrapper does not change the embedded event identity.
- Adding an unrelated clause does not change the event's scoped facts.
- Adding a material fact to the same event clause changes the material
  fingerprint but not the event key.
- Adding ambiguity changes the item to `repeatable: false`.

Regression tests will retain every adversarial example accumulated during the
original Task 7 review. Full unit tests, Worker tests, typechecking, and the
production build must pass.

## 10. Completion and Review

This recovery is complete when:

1. the clause parser and its integration satisfy the approved test corpus;
2. the two remaining formal review defects are covered by failing-first
   regressions and pass;
3. no existing repeat-suppression invariant regresses;
4. the full verification suite passes; and
5. a fresh formal reviewer approves the implementation without blocking
   findings.

After approval, the original Task 7 is marked complete and work resumes at Task
8 of the morning-briefing implementation plan.
