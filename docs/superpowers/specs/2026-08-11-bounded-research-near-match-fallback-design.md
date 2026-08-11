# Bounded Research Near-Match Fallback Design

**Date:** 2026-08-11
**Status:** Approved for implementation planning

## Problem

The 2026-08-11 preview canary published successfully, but its Research section
contained only one paper. Research discovery itself was not uniformly sparse:
OpenAlex produced 101 candidates, 63 after deduplication, and Semantic Scholar
produced 17 candidates, 7 after deduplication. Only one candidate reached
relevance triage and deep assessment.

The immediate bottleneck is the existing `0.50` topical-fit threshold. It is a
useful high-confidence admission rule, but treating it as the only path into
assessment makes the Research section brittle when embedding scores for
otherwise plausible papers fall slightly below the threshold. Lowering the
global threshold would increase noise on busy days and would weaken a rule that
currently works well for high-confidence matches.

## User decision

Keep the existing `0.50` topical-fit gate as the normal admission path. On
sparse mornings, spend a small bounded amount of additional assessment budget
on the strongest configured-topic near-matches. These candidates remain
subject to every existing technical-quality, evidence, grounding, and
publication requirement.

Research remains the briefing's main priority. Broader adjacent work may be
considered when direct technical matches are insufficient, but the system must
not publish weak work merely to fill a quota.

## Goals

- Preserve the precision of the current `0.50` normal admission path.
- Give strong near-matches a bounded route to technical assessment when the
  normal research queue is sparse.
- Aim for an assessment pool of six research candidates when enough eligible
  evidence exists, providing room for up to three featured papers after later
  quality failures.
- Prefer direct technical-interest matches before broader adjacent AI-safety,
  alignment, oversight, or governance work.
- Keep the existing 24-candidate absolute research assessment cap and all
  budget-degradation behavior.
- Preserve discovery-family, publisher-domain, and configured-topic diversity.
- Make fallback use observable through aggregate privacy-safe diagnostics.
- Keep ordering deterministic and retries byte-stable.

## Non-goals

- Guaranteeing three published Research items every day.
- Lowering technical-quality, evidence, source-authority, synthesis,
  validation, or grounding standards.
- Increasing the 24-candidate assessment cap.
- Adding another embedding request, an LLM relevance reranker, a provider
  request, or a model-generated admission decision.
- Allowing institution or laboratory prestige to establish relevance.
- Making unavailable providers a hard dependency.
- Rewriting prior candidates, checkpoints, diagnostics, or editions.
- Changing news admission, ranking, coverage, or publication behavior.

## Considered approaches

### 1. Reserved near-match assessment lane — chosen

Retain the current normal gate and use a second deterministic pass only when
fewer than six research candidates qualify normally. The pass may admit enough
eligible near-matches to bring the combined assessment queue to six.

This preserves precision on busy days, bounds sparse-day cost, and uses the
existing technical assessment as the final quality filter.

### 2. Lower the global topical-fit threshold

Changing the single threshold from `0.50` to a lower value is simpler, but it
would admit more weakly related candidates even when many high-confidence
papers are available. It also provides no explicit priority between direct and
adjacent fallback work.

### 3. Add a model-based relevance reranker

A model reranker could interpret nuanced abstracts, but it would add cost,
latency, nondeterminism, another provider failure boundary, and a new paid call
before technical assessment. The current problem does not justify that
complexity.

## Admission policy

### Normal candidates

A research candidate is normally eligible when it satisfies all existing
prefilter requirements, including:

- nonempty bounded normalized evidence;
- topical fit of at least `0.50`;
- current freshness or reconsideration eligibility;
- current source, identity, routing, and policy requirements; and
- the existing family, publisher, and queue-capacity controls.

Normal candidates are selected first using the current deterministic topic and
discovery-family reservation behavior followed by topical fit, bounded source
priors, recency, and stable identity tie-breaking.

### Near-match candidates

The near-match pass runs only when fewer than six normal research candidates
were selected. A candidate is eligible for this pass only when all of the
following are true:

1. it was not already selected normally;
2. it has a topical fit of at least `0.35` and below `0.50`;
3. it has nonempty bounded normalized evidence;
4. its normalized evidence maps to at least one configured research topic;
5. it remains within the same family and publisher diversity limits as the
   normal queue; and
6. it satisfies every other existing prefilter requirement.

A preferred institution, preferred laboratory, citation count, popularity,
or source reputation cannot make an otherwise ineligible candidate a
near-match. Those signals may break ties only after topical eligibility is
established under the existing bounded priors.

### Direct and adjacent ordering

Eligible near-matches are classified with the existing deterministic research
relevance classifier:

- `core` means concrete evidence for one of the reader's specific technical
  interest families; and
- `adjacent` means a broader configured-topic match that lacks sufficient
  evidence for `core`.

The fallback pass selects `core` candidates first. If capacity remains, it
selects `adjacent` candidates using the same deterministic ranking. A
higher-scoring adjacent candidate cannot consume a fallback place ahead of an
eligible core candidate.

### Capacity and budget behavior

Let `normalCount` be the number of normally selected research candidates.
Fallback capacity is:

```text
max(0, min(6 - normalCount, 24 - normalCount))
```

Therefore:

- six or more normal candidates disable the fallback pass;
- four normal candidates allow at most two near-matches;
- zero normal candidates allow at most six near-matches; and
- the combined queue never exceeds the existing absolute maximum of 24.

The assessment stage retains its current normal, degraded, and hard-stop model
budgets. Normal candidates always precede fallback candidates, and core
fallback candidates precede adjacent fallback candidates, so reduced budgets
consume the most defensible candidates first. Cached assessment reuse remains
unchanged. This design creates no new reservation type or independent budget.

## Architecture and data flow

1. Discovery, normalization, identity joining, freshness handling, and
   embedding run unchanged.
2. Research triage parses candidates once and partitions otherwise valid
   candidates into normal, near-match, and rejected pools from their transient
   topical-fit score.
3. The existing diversified selector fills the normal queue under the current
   maximum, family cap, publisher cap, configured-topic reservations, and
   deterministic tie-breakers.
4. If the normal queue has fewer than six candidates, the near-match selector
   fills only the remaining target capacity. It shares the already-consumed
   family and publisher counts rather than resetting diversity limits.
5. The triage result returns selected items in assessment priority order and a
   transient admission route (`normal` or `near_match`) for diagnostics.
6. Deep assessment, research scoring, core-first featured selection, Research
   Radar selection, synthesis, grounding validation, composition, and
   publication run unchanged.

The fallback policy belongs in the research-triage boundary rather than the
embedding provider or shortlist. Embedding remains a measurement primitive;
triage owns admission and diversity; shortlist continues to operate only on
assessed, scored candidates.

## Diagnostics and privacy

Existing per-lane `triaged` counts continue to include every selected research
candidate. Add an optional bounded `fallbackTriaged` count whose default is
zero for historical diagnostics. The normal-admission count is derivable as
`triaged - fallbackTriaged`.

Rejections below `0.35` retain the existing sanitized topic-mismatch category.
Eligible near-matches excluded by family, publisher, target, or absolute
capacity retain the existing capacity-limited category. No new diagnostic
stores titles, abstracts, embeddings, phrase matches, model output, complete
provider URLs, or candidate identifiers.

The Run Status detail may report aggregate normal and fallback counts, but it
must not expose the evidence that triggered a configured-topic or core match.

## Failure behavior

- Candidate parsing or eligibility failure excludes only that candidate.
- A near-match selection defect must not remove or reorder the already selected
  normal queue.
- Sparse or failed providers do not relax the `0.35` hard floor or any later
  quality gate.
- Zero eligible near-matches leaves the assessment queue sparse.
- Assessment failure or rejection of a near-match behaves exactly like failure
  or rejection of a normal candidate.
- Retry restores preserve the selected order and admission diagnostics without
  recomputing provider text or making additional discovery requests.
- Historical diagnostics lacking `fallbackTriaged` parse as zero.

## Compatibility

- No D1 schema migration is required.
- Existing Item, score, assessment, summary, and edition contracts remain
  unchanged.
- Any diagnostic schema extension is additive and defaults missing
  `fallbackTriaged` values to zero.
- Existing checkpoints remain readable. The admission route is operational
  metadata for the active run and is not required to reinterpret historical
  items or editions.
- Existing cached topical-fit and assessment records remain valid.

## Testing

Implementation follows strict test-driven development.

### Unit coverage

- six or more normal candidates prevent fallback admission;
- four normal candidates admit at most two eligible near-matches;
- zero normal candidates admit at most six eligible near-matches;
- scores below `0.35` never enter the assessment queue;
- `0.35` is included and `0.50` uses the normal route;
- candidates without a configured-topic match never use the fallback route;
- institution or laboratory preference alone cannot qualify a candidate;
- core near-matches precede higher-scoring adjacent near-matches;
- adjacent near-matches fill remaining target capacity;
- normal candidates precede every fallback candidate;
- family and publisher counts are shared across both passes;
- configured-topic diversity remains deterministic;
- reversed input produces identical output;
- malformed candidates fail individually without changing normal output; and
- aggregate diagnostics distinguish fallback admissions without recording
  provider text or embeddings.

### Workflow coverage

- a production-shaped funnel with many deduplicated candidates and one normal
  admission sends eligible near-matches to assessment up to the six-candidate
  target;
- later technical assessment can reject every fallback candidate without
  lowering publication standards;
- degraded budget assesses the normal queue before core fallback and core
  fallback before adjacent fallback;
- hard-stop behavior makes no new paid calls and reuses only valid cached
  assessments;
- checkpoint restore and retry preserve order and aggregate diagnostics; and
- news candidates and news diagnostics remain unchanged.

### Acceptance canary

After separate deployment authorization, a preview canary is acceptable when:

- normally admitted candidates remain first and unchanged;
- eligible near-matches appear only when the normal queue has fewer than six;
- no more than six combined candidates are admitted solely to reach the sparse
  queue target;
- no candidate below `0.35` or without configured-topic evidence is assessed
  through the fallback path;
- the Research section may still contain fewer than three items when later
  quality or grounding gates reject candidates;
- all model reservations reconcile within the existing budget;
- diagnostics report bounded normal/fallback counts and contain no candidate
  evidence; and
- production remains untouched until the preview result is reviewed.

## Success criteria

This design succeeds when sparse research mornings evaluate a broader but
still defensible candidate set, while busy mornings, cost ceilings, privacy
boundaries, and final publication quality behave exactly as before.
