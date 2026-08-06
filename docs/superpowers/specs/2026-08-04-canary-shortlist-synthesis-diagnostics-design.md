# Canary Shortlist and Synthesis Diagnostics Design

**Date:** 2026-08-04

## Goal

Prevent qualified research from being displaced entirely by higher-scoring news
in the eight-item morning briefing, and make grounded-summary rejections
diagnosable without weakening editorial or publication safeguards.

## Evidence and Root Cause

The 2026-08-04 preview canary collected 408 candidates, assessed and scored 133,
clustered 125, shortlisted 8, synthesized 1, and failed publication with
`MINIMUM_COVERAGE_FAILED`.

Two independent problems caused the failure:

1. Six papers reached clustering and four passed the configured topical-fit and
   technical-quality gates. The editorial shortlist selected featured research
   separately, but production assembly used the score-ranked morning brief
   first. Eight higher-scoring news developments filled that list, leaving no
   capacity for the already-qualified featured research.
2. Synthesis made one initial model call for each of eight shortlisted news
   items and a repair call for seven of them. Only one summary survived. The
   seven `SummaryRejectedError` values were caught and discarded without
   persisting their bounded validation codes, so the precise grounding failure
   cannot be recovered from the completed run.

OpenAlex authentication and research discovery were not the primary failure.
Several research discovery families succeeded, and non-arXiv candidates reached
assessment.

## Scope

This change will:

- reserve up to three slots in the existing eight-item morning briefing for
  qualified featured research;
- fill every remaining slot using the existing deterministic ranking and
  section budgets;
- persist bounded, structured validation codes when synthesis rejects an item
  after its repair attempt;
- include those codes in the existing Run Status rejected-summary display; and
- add regression coverage for research reservation, sparse research, ordering,
  synthesis rejection diagnostics, redaction, and retry idempotency.

This change will not:

- lower topical-fit, technical-quality, source-policy, grounding, coverage, or
  publication thresholds;
- create a deterministic or extractive summary fallback;
- increase model retry counts or model-token budgets;
- change the eight-item edition maximum;
- change source discovery or scoring weights;
- run another paid canary automatically; or
- deploy or promote anything to production.

## Shortlist Assembly

The editorial shortlist remains responsible for identifying up to three
qualified `researchFeatured` items under the current quality gates and topic
diversity rules. Production assembly will treat these as reserved members of
the eight-item briefing rather than optional members of the global score race.

Assembly will be deterministic:

1. Take up to `min(featuredResearch budget, morningBrief budget)` qualified
   featured-research items in their existing research rank order.
2. Append candidates from the existing score-ranked `morningBrief`, skipping
   IDs already reserved, until the morning-brief budget is reached.
3. If capacity remains, append eligible research-radar items using the existing
   budget-policy behavior and rank order.
4. Emit the reserved featured papers with section `research`; preserve all
   existing section assignments for news and radar items.

The reservation is a maximum, not a quality-bypassing quota. If no paper passes
the existing gates, no research item is inserted. If one or two pass, only
those items are reserved. News remains eligible for every unfilled slot.

## Synthesis-Rejection Diagnostics

When `summarizeItem` rejects both its initial and repair responses, synthesis
will continue fail-open for that individual item as it does today. Before
continuing, the production context will record a bounded audit event containing:

- the run ID;
- the assigned edition section;
- a deduplicated, bounded list of existing validation codes; and
- the event timestamp.

The event will not contain prompts, source excerpts, generated model output,
API credentials, URLs, titles, raw item IDs, or unrestricted exception text.
The raw item ID is used only transiently with the run ID to derive a
collision-safe deterministic SHA-256 audit key; D1 retains only that digest and
never serializes the raw item ID. The deterministic key prevents a workflow
retry from multiplying the same rejection event.

The repository's Run Status detail reader will accept these events in addition
to validation-stage checkpoint rejections. It will apply the existing public
diagnostic sanitizer and expose unique section-qualified rejection codes through
the existing `rejectedSummaryReasons` field. No database migration or public API
shape change is required.

If diagnostic persistence itself fails, the synthesis error-handling path must
fail closed rather than silently conceal a new storage failure. It must not
publish an edition whose diagnostic state is uncertain.

## Data Flow

```text
qualified research ----> featured selection --+--> reserve up to 3 --+
                                                |                     |
ranked research + news --> morning ranking -----+--> fill remainder ---+--> 8-item shortlist

shortlisted item --> initial summary --> validate
                                     | pass --> synthesized item
                                     | fail --> repair --> validate
                                                          | pass --> synthesized item
                                                          | fail --> bounded audit event --> drop item
```

Composition and publication continue to enforce the current minimum-section and
grounding requirements. Diagnostics explain failures; they do not override them.

## Error Handling and Privacy

- Only schema-validated validation-code families may reach Run Status. Unknown
  or malformed values use the existing generic redacted label.
- Event arrays and strings remain bounded by schemas before persistence.
- Duplicate events for the same run and item are ignored deterministically.
- Raw item identity is absent from both persisted event JSON and Run Status.
- A rejected item remains absent from validation, composition, and publication.
- A run with insufficient surviving coverage remains an unpublished draft.
- Model-budget reservation reconciliation and terminal cleanup remain unchanged.

## Testing

Focused regression tests will prove that:

1. Three qualified featured papers remain in an eight-item shortlist even when
   every competing news score is higher.
2. One or two qualified papers reserve only one or two slots, and zero qualified
   papers do not bypass the gates.
3. The shortlist remains capped at eight, has stable order, contains no duplicate
   IDs, and preserves news section assignments.
4. Hard-stop and degraded budget policies continue to remove optional radar
   depth before featured research.
5. A `SummaryRejectedError` records one bounded event and synthesis continues to
   the next item.
6. Retrying the same run and item does not create duplicate rejection events.
7. Credential- and URL-shaped raw item IDs are absent from persisted event JSON
   and authenticated Run Status output.
8. Rejection diagnostics are counted and deleted with 90-day workflow artifacts.
9. A missing diagnostic recorder fails closed only after a summary rejection.
10. Run Status includes sanitized, section-qualified rejection codes and never
   exposes raw model output or source text.
11. Existing editorial, workflow, repository, API, Worker, and build suites remain
   green.

## Rollout

Implementation and verification occur locally first. A preview deployment
requires separate approval. After preview deployment, another paid canary also
requires explicit approval. The canary must confirm both that qualified research
survives shortlisting and that any remaining synthesis failures expose actionable
bounded codes. Production promotion remains a separate decision after canary
review.
