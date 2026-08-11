# Research-First Partial Briefing Design

## Goal

Publish a useful daily briefing whenever validated research survives, while
keeping research the highest-priority content and treating news coverage as an
optional completeness improvement rather than a publication veto.

## Context and Root Cause

The resumed `2026-08-10` preview run successfully restored its existing
386-candidate collect checkpoint and advanced through every pipeline stage.
The editorial run nevertheless ended with `MINIMUM_COVERAGE_FAILED`.

The run had enough nonlocal material before shortlisting:

- normalize: 77 world items, 1 technology item, 30 local items, and 241 papers;
- cluster: 71 world developments, 1 technology development, 30 local
  developments, and 7 research items;
- shortlist: 3 research items and 5 local items.

The shortlisting integration reserves up to three featured-research items and
then fills the remaining morning capacity from a single global score order.
The five highest-scoring news developments were local, so all available
nonlocal developments were crowded out. Composition then rejected the edition
because it requires research, nonlocal news, and DMV/Baltimore coverage. This
made the selection policy capable of constructing an edition guaranteed to
fail the publication policy.

Current AP, Reuters, and GDELT access failures reduce source redundancy but did
not cause this specific failure: dozens of nonlocal developments reached the
selection boundary. Source endpoint reliability is therefore a separate
follow-on project.

## Product Rules

1. Research is mandatory and remains the primary briefing content.
2. Up to three featured-research slots remain reserved before news selection.
3. News is optional. Missing news coverage must not suppress an otherwise
   useful research briefing.
4. When suitable news exists, the selector should prefer a minimally diverse
   mix instead of allowing one news geography to crowd out every other news
   category.
5. Existing research, news-score, source-policy, and summary-grounding gates
   remain unchanged.
6. The system must not create filler, lower quality thresholds, or make extra
   model calls to satisfy coverage.

## Selection Design

The pipeline integration that turns the section-aware `Shortlist` into the
final morning list will use deterministic coverage-aware admission.

1. Admit featured research first, up to the smaller of the configured featured
   research budget and morning capacity.
2. If capacity remains, admit the highest-ranked nonlocal news development
   across `world`, `technology`, and `ai_policy`.
3. If capacity remains, admit the highest-ranked local development across
   `dmv` and `baltimore`.
4. Fill all remaining capacity from the existing score-ranked morning
   candidates, excluding already admitted IDs.
5. Admit research-radar items only into capacity still unused after the morning
   list, as today.

The `morningBrief` list produced by `shortlist()` already provides the global
score/date/ID order. The section lists identify which IDs belong to each
coverage family. The integration selects the first matching ID from
`morningBrief`, so it can choose each representative without rescoring or
inventing a second tie-break rule. If a coverage family has no candidate, its
reservation consumes no slot.

This design does not impose strict quotas for world, technology, and AI policy.
It guarantees one nonlocal representative when any exists, preserves a local
representative when any exists, and lets quality ranking decide the rest.

## Composition and Publication Design

Composition continues to calculate and persist these missing-coverage labels:

- `research`;
- `nonlocal_news`;
- `dmv_or_baltimore`.

Status rules become:

- `failed`: no validated research entry survives;
- `published`: 6–8 validated entries survive and no coverage label is missing;
- `partial`: at least one validated research entry survives, but the edition is
  smaller than six entries or one or more news-coverage labels are missing.

A partial edition is persisted and visible through the existing publication
path. Its `missingSections` and `sourceFailures` metadata remain authoritative.
The existing run-level partial retryability behavior is unchanged, allowing a
later explicit retry without hiding the useful edition already produced.

News-only editions still fail because they do not meet the mandatory research
rule.

## Data Flow and Boundaries

No new persisted schema, migration, configuration field, provider call, or
model prompt is required.

The only behavior boundaries that change are:

1. final morning-list assembly after the existing `shortlist()` result; and
2. status classification in `composeEdition()`.

All upstream collection, normalization, enrichment, scoring, clustering,
research relevance, and shortlist quality decisions remain unchanged. All
downstream summary validation, edition persistence, Access protection, budget
accounting, and run diagnostics remain unchanged.

## Failure and Safety Behavior

- A missing or failed news source is recorded exactly as it is today.
- A news candidate rejected by score, access, schema, or grounding is not
  restored merely to satisfy coverage.
- A rejected research summary can still make the edition fail when no other
  validated research survives.
- A partial result does not trigger additional synthesis or repair calls beyond
  the existing per-candidate behavior.
- Missing-section metadata must reflect validated edition entries, not the
  earlier shortlist.
- No URL, identifier, source role, provenance, access level, or structural
  metadata normalization changes are in scope.

## Test Design

### Selection regression

Create a canary-shaped case with three qualifying research items, at least one
world development, at least one local development, and enough higher-scoring
local developments to fill every remaining slot under the old algorithm.
Assert that:

- all three featured-research items remain first;
- the best nonlocal and best local developments are admitted;
- no ID is duplicated;
- total output stays within the configured morning budget;
- remaining slots preserve the existing global ranking.

Mutation sensitivity: restoring the old featured-plus-global-fill assembly
must remove the nonlocal item and fail this test.

### Composition matrix

Cover these status cases through the real composition function:

- research + nonlocal + local, 6–8 entries: `published`;
- research + local but no nonlocal: `partial` with
  `missingSections: ["nonlocal_news"]`;
- research only: `partial` with both news labels;
- news only: `failed` with `research` missing;
- zero valid entries: `failed`.

Assert that source-failure metadata and validated entry structure are
unchanged.

### Pipeline integration

Run a manual pipeline case whose scores reproduce local crowd-out. Assert that
the composed edition includes research and nonlocal news and reaches the
existing publication path. Run a research-only case and assert that it persists
a partial edition instead of `MINIMUM_COVERAGE_FAILED`.

Run the affected unit and Worker/D1 suites, then the full application suite,
full Worker suite, typecheck, evaluator, production build, and diff check.

## Rollout and Acceptance

Deploy to preview only after code review and complete verification. Start a new
preview canary for a fresh edition date; do not mutate the completed
`2026-08-10` audit history.

Acceptance requires:

- three research slots remain protected when three qualifying papers exist;
- an available nonlocal story cannot be crowded out solely by local scores;
- a validated research-only edition publishes as `partial` with honest missing
  news metadata;
- a news-only edition remains unpublished;
- model budgets and reservations reconcile normally;
- no source endpoint, migration, production deployment, or source-policy change
  is bundled into this project.

## Follow-On Project

Refresh nonlocal source reliability separately, beginning with the observed AP
redirect-policy mismatch and then independently reproducing Reuters and GDELT
failures. That work needs its own source-specific design, migration strategy,
and network-boundary tests.
