# Spare-Capacity Non-arXiv Research Recovery Design

**Date:** 2026-08-12
**Status:** Approved for implementation planning

## Problem

The 2026-08-13 preview canary published successfully, but its Research section
contained only arXiv papers even though non-arXiv research sources had produced
plausible candidates.

The run evidence identifies two concrete causes:

1. Research triage selected seven normal candidates and then disabled the
   near-match pass. Three Papers with Code candidates were classified as
   eligible near-matches but rejected as capacity-limited, even though only
   seven of the 24 available research-assessment places were occupied.
2. Google Research's live listing still uses the reviewed glue-card structure,
   title field, and date field, but its categories now appear in
   `.glue-card__link-list__item`. The reviewed parser requires a category from
   older selectors, so every otherwise valid Google Research card is dropped
   and the lane reports a parse failure.

Raising the absolute assessment cap would not fix either defect. The triage
formula disables near-match admission once six normal candidates exist, and a
larger cap does not repair a parser that emits no candidates.

## User decision

Use otherwise idle research-assessment capacity for a small, bounded number of
strong configured-topic near-matches. Repair the exact Google Research listing
contract. Preserve the current quality, evidence, grounding, diversity, and
publication gates. The user is comfortable raising the absolute assessment cap
to 30 or 40 later if evidence shows it would help, but this change keeps the cap
at 24 because the observed run did not approach it.

During strict RED testing, the production-shaped fixture exposed that seven
arXiv normal candidates cannot coexist under the generic six-candidate
publisher-domain cap. The user explicitly prefers erring toward too many arXiv
papers rather than too few. The design therefore raises the arXiv-family
publisher-domain ceiling to 12 while retaining the ceiling of six for every
other discovery family.

Research remains the briefing's main priority. News behavior is not changed.

## Goals

- Admit up to six eligible near-match research candidates after normal
  candidates when the 24-place queue has spare capacity.
- Preserve the existing `0.50` normal topical-fit threshold and `0.35`
  near-match floor.
- Preserve configured-topic eligibility, core-before-adjacent ordering,
  discovery-family limits, the source-specific publisher-domain limits, and
  deterministic ordering.
- Repair Google Research extraction against its current first-party listing
  markup without adding a generic or permissive scraper.
- Let every admitted non-arXiv candidate compete under the same technical
  assessment, scoring, shortlist, synthesis, validation, and grounding rules as
  every other research candidate.
- Make admission and later loss observable through aggregate privacy-safe
  diagnostics.
- Keep paid work bounded by the existing 24-candidate absolute assessment cap
  and the existing degraded and hard-stop budget behavior.

## Non-goals

- Reserving a final Research or Research Radar slot for any provider, family,
  institution, laboratory, or media type.
- Guaranteeing that a non-arXiv item, or any fixed number of research items,
  publishes each day.
- Lowering technical-quality, evidence, source-authority, synthesis,
  validation, or grounding standards.
- Raising the assessment cap in this change.
- Raising every publisher-domain ceiling; only the arXiv discovery family gets
  the approved ceiling of 12.
- Adding an LLM relevance reranker, embedding request, provider request, or
  model-generated admission decision.
- Treating institutional prestige, citations, or source reputation as enough
  to establish topical relevance.
- Changing how standalone commentary is eligible for Research Radar rather
  than featured Research.
- Changing news discovery, ranking, coverage, or publication behavior.
- Repairing best-effort university-page redirect and policy drift. Georgia
  Tech, Stanford, and Johns Hopkins source-health work remains a separate
  follow-up because it changes independent endpoint and policy contracts.
- Rewriting historical checkpoints, diagnostics, candidates, or editions.

## Considered approaches

### 1. Spare-capacity near-match allowance — chosen

Retain the normal queue and add a second bounded pass that may admit at most six
near-matches into unused places under the existing absolute maximum of 24.

This directly addresses the observed exclusion, remains bounded, and leaves
the expensive assessment and publication gates responsible for quality.

### 2. Raise the absolute assessment cap to 30 or 40

This is easy to configure but does not fix the current problem. With seven
normal candidates, the present fallback formula admits zero near-matches at any
larger absolute cap. It would increase the maximum cost without changing the
observed candidate set.

The cap can be revisited after the admission repair if normal plus near-match
candidates begin saturating 24. At current observed token use, the approximate
assessment-only ceilings are $7.30 per month for 30 daily calls and $9.70 per
month for 40 daily calls, before roughly $3–4 per month of observed summary and
embedding usage.

### 3. Reserve a final slot or boost non-arXiv sources

This would make provider diversity visible more reliably, but could publish a
weaker item over a better paper and would let provenance influence the final
editorial decision. The design therefore improves opportunity to be assessed,
not guaranteed publication.

## Research admission policy

### Normal candidates

Normal eligibility and ordering remain unchanged. A candidate must satisfy all
existing prefilter requirements, including a topical fit of at least `0.50`,
bounded evidence, freshness or reconsideration eligibility, source and identity
requirements, and the family, publisher, and absolute-cap controls.

Normal candidates are selected first. Their order and membership cannot be
changed by the near-match pass.

### Near-match candidates

The existing near-match eligibility rules remain unchanged. A candidate must:

1. not already be selected normally;
2. have topical fit at least `0.35` and below `0.50`;
3. have nonempty bounded normalized evidence;
4. map to at least one configured research topic;
5. remain within shared discovery-family and source-specific publisher-domain
   limits; and
6. satisfy every other existing prefilter requirement.

Preferred institutions, preferred laboratories, citations, popularity, or
source reputation cannot make an otherwise ineligible candidate eligible.

### Capacity

Let `normalCount` be the count selected by the normal pass, `maximum` be the
absolute research-assessment maximum, and `nearMatchAllowance` be six.

```text
fallbackCapacity = max(
  0,
  min(nearMatchAllowance, maximum - normalCount)
)
```

Therefore:

- seven normal candidates may admit up to six near-matches, for at most 13;
- 20 normal candidates may admit up to four near-matches, for at most 24;
- 24 normal candidates admit no near-matches; and
- the combined queue never exceeds the existing maximum of 24.

The option and constant must be named as an allowance or maximum, not a target,
so callers and diagnostics do not retain the obsolete "fill the queue to six"
meaning.

### Ordering and diversity

Normal candidates remain first. Eligible core near-matches are selected next,
followed by eligible adjacent near-matches. Both near-match groups use the
existing deterministic ranking and configured-topic diversification.

Family and publisher counts are shared across normal and near-match passes. The
near-match pass cannot reset those counts or displace a normal candidate.
Reversing provider input order must produce the same selected order.

The publisher-domain ceiling is selected from the candidate's discovery
family. Candidates in the `arxiv` discovery family use a ceiling of 12 for the
shared `arxiv.org` domain. Every other discovery family uses the existing
ceiling of six. The exception must not be inferred from a provider-controlled
URL or display name, and it must not increase any discovery-family limit or the
24-candidate absolute maximum.

Degraded budget behavior continues to consume candidates in this order. Hard
stop makes no new paid calls. Cached assessments remain unchanged.

## Google Research parser repair

The reviewed Google Research profile remains a code-owned, source-specific
parser. Listing rows must continue to match the existing exact blog-card link
contract:

```text
a.glue-card--blog[href^="/blog/"]
```

The parser continues to require the existing title and date elements. Category
extraction checks the existing explicit category selectors first, then the
current Google Research list item selector:

```text
.glue-card__link-list__item
```

Category values use the existing provider-text normalization and bounds. If
several category list items exist, the parser retains a deterministic bounded
representation suitable for the existing publication candidate contract. It
must not search arbitrary list items, infer a category from surrounding prose,
or relax the required row fields.

A malformed row is isolated. Healthy siblings continue. If the page uses none
of the reviewed structures, the lane retains the existing sanitized parse
failure rather than silently claiming a healthy empty result.

URLs, dates, IDs, access levels, endpoint policies, and source roles remain
structural values and must not pass through provider display-text decoding.

## Downstream editorial behavior

All newly admitted candidates follow the existing pipeline:

```text
triage -> assessment -> score -> shortlist -> synthesis -> validation -> publish
```

No source-family bonus or reserved final slot is added. A Papers with Code,
Google Research, commentary, or other non-arXiv candidate can still be rejected
for technical quality, topical fit, insufficient evidence, shortlist capacity,
summary validity, or grounding.

Featured Research remains limited to papers under the existing shortlist
contract. Eligible standalone commentary remains able to compete for Research
Radar. Commentary attached to a paper continues to strengthen context signals
without becoming independent primary evidence.

## Diagnostics and privacy

Existing lane diagnostics continue to report aggregate discovered,
deduplicated, triaged, assessed, and rejection counts. The existing bounded
fallback-admission count remains the authoritative measure of near-match use.

The implementation must make the following states distinguishable through
existing aggregate categories and stage counts:

- eligible near-match excluded by family, its applicable publisher ceiling,
  allowance, or absolute capacity;
- admitted near-match rejected during assessment;
- assessed research candidate excluded during shortlist; and
- source-level parse failure versus a healthy empty result.

No diagnostic may store titles, abstracts, complete provider URLs, embeddings,
phrase matches, model output, or candidate identifiers. No new persistence
schema is required unless implementation planning proves that the existing
aggregate counters cannot express the distinction; any such need requires a
design revision before implementation.

## Failure behavior

- Candidate parse or eligibility failure excludes only that candidate.
- Google Research row drift excludes only the malformed row; page-level
  structural drift produces a sanitized source parse failure.
- A near-match selection defect must not remove or reorder the normal queue.
- Sparse or failed providers do not relax the `0.35` floor or later quality
  gates.
- Assessment or summary failure retains the current typed, fail-open candidate
  isolation behavior.
- Provider failure remains isolated and does not abort healthy sources.
- Checkpoint restore and retry preserve the selected order and aggregate
  diagnostics without repeating provider-text preparation or paid work.

## Compatibility

- No D1 schema migration is expected.
- Existing Item, assessment, score, summary, edition, and checkpoint contracts
  remain unchanged.
- The triage option rename and the discovery-family publisher-ceiling override
  are internal compile-time changes; no public or persisted configuration uses
  either value.
- Historical checkpoints and diagnostics remain readable.
- Existing cached embeddings and research assessments remain valid.
- Production callers continue using the default 24-candidate maximum.

## Testing

Implementation follows strict test-driven development.

### Research-triage unit coverage

- seven normal arXiv candidates plus three eligible near-matches select all ten;
- 20 normal candidates admit no more than four near-matches;
- 24 normal candidates admit none;
- zero normal candidates admit no more than six near-matches;
- normal candidates precede every near-match;
- core near-matches precede higher-scoring adjacent near-matches;
- scores below `0.35` and candidates without configured-topic evidence remain
  ineligible;
- arXiv may contribute up to 12 candidates from `arxiv.org`, while every other
  discovery family remains limited to six candidates per publisher domain;
- family and publisher counts remain shared across passes;
- normal output is unchanged when the near-match selector fails or has no
  eligible candidates;
- reversed input yields byte-identical selected order and exclusions; and
- diagnostics count admitted fallback candidates without provider text.

Mutation checks must fail when the implementation restores the old
`allowance - normalCount` formula or bypasses shared diversity counts.

### Google Research parser coverage

- a current first-party glue card using `.glue-card__link-list__item` produces
  one bounded candidate with the exact URL, date, title, and category;
- the older explicit category selectors remain supported;
- multiple current category items resolve deterministically within bounds;
- unrelated list items cannot become categories;
- a malformed row is dropped while a healthy sibling survives;
- a listing with reviewed rows but no valid rows produces the existing parse
  failure rather than healthy empty;
- structural URLs and timestamps remain unchanged by provider-text handling;
  and
- malformed or encoded markup cannot route on tag names.

### Workflow coverage

- a production-shaped funnel with seven normal arXiv candidates and three
  Papers with Code near-matches sends all ten to the assessment boundary under
  a normal budget;
- later assessment may reject every near-match without lowering standards;
- degraded mode assesses normal, core near-match, then adjacent near-match;
- hard stop makes no new paid calls;
- shortlist adds no non-arXiv reservation or source bonus;
- a non-ArXiv candidate can win on score and can lose on score;
- retry restores the same order and does not repeat paid assessment; and
- news candidates and news diagnostics are unchanged.

### Acceptance canary

After separate deployment authorization, a preview canary is acceptable when:

- Google Research either produces valid candidates from the reviewed live
  structure or reports a truthful sanitized failure;
- eligible near-matches can enter unused assessment capacity even when six or
  more normal candidates exist;
- at most six near-matches are admitted and the combined assessment queue is at
  most 24;
- normal candidates remain first and unchanged;
- the arXiv publisher ceiling is 12, every other publisher ceiling is six, and
  neither ceiling can bypass the 24-candidate absolute maximum;
- no candidate below `0.35` or without configured-topic evidence enters via the
  fallback path;
- no source receives a reserved final slot;
- every published research claim remains grounded under existing validation;
- model reservations reconcile within the configured budget; and
- diagnostics remain aggregate and privacy-safe.

Production remains untouched until the preview result is reviewed.

## Success criteria

The change succeeds when the observed idle-capacity exclusion is impossible,
the reviewed Google Research listing yields candidates again, and the system
still publishes only candidates that pass the unchanged downstream editorial
and grounding standards. A preview run may still contain only arXiv research
if the admitted alternatives lose on quality; that is a valid outcome rather
than a reason to weaken the gates.
