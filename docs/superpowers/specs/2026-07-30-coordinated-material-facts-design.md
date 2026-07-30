# Coordinated Material Facts — Design Specification

**Status:** Approved design  
**Date:** July 30, 2026  
**Parent recovery:** Event Clause Parser Recovery  
**Failure policy:** Fail open

## 1. Purpose

Close the remaining clause-ownership gap in repeat suppression. A sentence may
coordinate two fact-bearing propositions with `and`; without a safe boundary,
status and date facts from different event objects can be extracted together
and attached to the one exact object named later in the sentence.

The motivating construction is:

`Another policy was delayed, and Frontier Evaluation Standard takes effect
July 1.`

The standard may receive the effective date. It must not receive the unrelated
policy's `delayed` status.

## 2. Chosen Rule

Add a conservative material-coordination boundary. Split at `and` only when:

1. both sides contain a recognized material predicate; and
2. the right side introduces its own explicit organization subject or event
   object; and
3. the right side is not pronoun-led.

Recognized material predicates include:

- event identity actions already supported by the parser;
- proposed/introduced;
- adopted/approved/passed;
- launched/released/published/unveiled;
- delayed/postponed;
- rejected/blocked;
- withdrawn/repealed;
- effective/takes effect;
- explicit deadline constructions.

The split happens in the shared bounded segmentation path before event or
fact-clause parsing. Both parsers therefore see the same clause ownership.

## 3. Required Behavior

### Split

- `Another policy was delayed, and Frontier Evaluation Standard takes effect
  July 1.`
- `Frontier Evaluation Standard takes effect July 1, and another policy was
  blocked.`
- `Evaluation Agency delayed Community Research Program and Model Institute
  adopted Frontier Evaluation Standard.`

### Do not split

- `Frontier Evaluation Standard was adopted and takes effect July 1.`
  The second predicate shares the explicitly named object.
- `Frontier Evaluation Standard was delayed and later adopted.`
  No second explicit subject or object is introduced.
- `Another policy was delayed, and it takes effect July 1.`
  Pronoun coreference remains unsupported.

### Fail open

When coordinated text contains multiple distinct event identities, preserve
both tuples so document-level resolution returns no canonical event instance.
When segmentation cannot safely establish ownership, reject the affected
sentence rather than select one tuple.

## 4. Scope

- Modify only the pure clause parser and focused parser/news-signal tests.
- Preserve every public parser and news-signal interface.
- Preserve the existing complement, headline, source-field, recursion, and
  clause-count behavior.
- Add no dependency, I/O, model call, ranking change, or sentence-wide
  fallback.

## 5. Test Matrix

Tests must be written and observed failing before implementation:

1. `delayed` on the left and exact-object effective date on the right do not
   combine.
2. Exact-object effective date on the left and `blocked` on the right do not
   combine.
3. Table-driven terminal statuses cover `delayed`, `postponed`, `blocked`,
   `rejected`, `withdrawn`, and `repealed`.
4. A same-object `adopted and takes effect` clause retains both facts.
5. Coordinated distinct actor/object event identities remain ambiguous and
   fail open.
6. Pronoun-led right clauses do not gain exact-object ownership.

The focused parser and news-signal suites, full unit suite, Worker suite,
TypeScript check, production build, and whitespace check must all pass.

## 6. Completion

The follow-up is complete only when a fresh reviewer confirms:

- all recognized material-status families participate in conservative
  coordination;
- same-object fact suffixes remain intact;
- no new sentence-wide or coreference fallback exists; and
- the previously open final-review finding is addressed without new
  Critical or Important breakage.

