# Synthesis Grounding Contract Design

**Date:** 2026-08-06

## Goal

Restore useful, fail-closed synthesis by making the generation prompt, the
prominent-prose provenance validator, and the existing single repair attempt
enforce the same strict extractive grounding contract.

The change must allow a summary title copied exactly from a cited source title,
while preserving the stricter evidence and authority rules for factual claims.

## Evidence and root cause

The isolated preview canary for edition `2026-08-06` completed every workflow
stage on its first attempt and produced an eight-item shortlist. Two shortlisted
items were research papers. Synthesis retained one DMV summary and rejected the
other seven summaries, so publication failed with
`MINIMUM_COVERAGE_FAILED`.

Six rejected summaries included `UNGROUNDED_PROSE:title`. A minimal local
reproduction showed the same failure when:

- the generated title exactly equaled a cited source title;
- title provenance cited that source;
- the provenance evidence text exactly equaled the cited source title; and
- the remaining generated fields and claims used exact source excerpts.

The prompt and JSON-schema description explicitly permit prominent prose copied
from a cited source title or excerpt. The validator, however, currently treats
prominent provenance as present only when its evidence text occurs in a source
excerpt. It does not treat the cited source title itself as provenance evidence.
The repair request then returns opaque validation codes alongside the original
source packet, without deterministic field-specific correction instructions.

## Controlling policy

Grounding remains strict and extractive. Generated prominent prose and factual
claims must be supported by exact source wording. This design does not introduce
semantic-similarity grounding or general paraphrase acceptance.

## Contract

### Prominent prose

The generated fields `title`, `oneSentence`, `whyItMatters`, and `uncertainty`
each retain their required provenance entry:

- `sourceIds`: one or more known source IDs;
- `evidenceExcerpt`: nonempty text of at most 800 characters.

For each cited source, prominent provenance is valid only when its normalized
`evidenceExcerpt` occurs exactly in either:

1. that source's title; or
2. one of that source's numbered excerpts.

The prominent prose itself must still occur exactly within its provenance
evidence, the cited source title, or a cited source excerpt. The existing trusted
forecast label remains the only non-source prose exception.

Source-title matching applies only to prominent prose provenance. It must not
silently broaden factual-claim evidence rules.

### Factual claims

Factual claims retain the current stricter contract:

- every source ID must exist in the packet;
- `evidenceExcerpt` must occur exactly in every cited source's numbered
  excerpts;
- the claim text must occur exactly in its evidence or cited source text;
- paper and blog claims must retain primary-research authority or exact named
  commentary attribution;
- access-level checks remain unchanged.

If a model has evidence from only one source, it must cite only that source. A
single evidence excerpt must not be used to imply corroboration by additional
sources that do not contain it.

## Validator design

Add one focused helper for prominent provenance matching. It accepts the
normalized evidence text and a cited source and returns true only when the text
is contained in that source's title or one of its excerpts.

Use this helper only when deriving `evidenceSources` for the four prominent
prose fields. Prominent provenance is valid only when at least one known source
is cited and every cited source matches the evidence. Keep
`claimEvidenceMatchesAllSources`, claim-authority checks, access authorization,
forecast handling, and every existing error code unchanged.

An exact source-title match therefore passes `UNGROUNDED_PROSE:<field>` only
when the provenance cites the source that owns that title. A title copied from
an uncited source, a fabricated title, an empty evidence string, or a partial
match absent from all cited source titles and excerpts still fails closed.

## Repair design

Keep exactly one repair generation after an invalid initial generation. Do not
add retries or model calls.

Replace the repair packet's code-only error list with a bounded deterministic
repair section. The section contains:

- each distinct existing validation code;
- one allowlisted instruction derived from the code family; and
- no initial generated summary, invalid evidence, provider error, URL,
  credential, item ID, or other model-produced text.

Before instructions are selected, canonicalize the raw validator errors at the
repair boundary. Collapse every `UNKNOWN_SOURCE:<provider value>` variant to the
constant `UNKNOWN_SOURCE`. Preserve only codes that pass the existing bounded
rejection-code schema; map any oversized or unrecognized value to
`SCHEMA_INVALID:root`. Deduplicate and lexically sort the result.

The repair section may contain at most 64 distinct code/instruction lines and
at most 16,384 UTF-8 bytes. If assembling the section would exceed either
bound, replace it with the single canonical `SCHEMA_INVALID:root` instruction.

The repair guidance must cover these code families:

- `UNGROUNDED_PROSE:<field>`: copy the field exactly from one cited source title
  or excerpt, and make provenance evidence an exact substring from the same
  cited source;
- `CLAIM_EVIDENCE_NOT_EXACT`: cite only sources whose numbered excerpts contain
  the exact evidence text; use one source when only one contains it;
- `EVIDENCE_NOT_FOUND:<index>`: copy evidence exactly from a numbered excerpt of
  a cited source;
- `UNGROUNDED_CLAIM:<index>`: copy the claim assertion exactly from its evidence
  or cited source text;
- `PRIMARY_RESEARCH_SOURCE_REQUIRED:<index>`: cite primary research for the
  research assertion, or make exact named attribution to cited commentary;
- `UNKNOWN_SOURCE`, schema errors, access overclaim, empty uncertainty, and
  forecast-label errors: retain bounded correction instructions consistent with
  their current validator semantics.

Instructions must be selected from constant application text. Dynamic indexes
and prominent field names may be included only after they have passed the
existing bounded rejection-code schema. Instructions must not echo
provider-supplied values.

The original bounded source packet remains available to the repair call. The
existing model, output-token ceiling, sequential synthesis behavior, budget
reservation, and rejection-audit behavior remain unchanged.

## Data flow

1. Serialize the bounded source packet.
2. Generate one structured summary using the existing extractive grounding
   prompt and JSON schema.
3. Validate it against the aligned prominent-prose and unchanged claim
   contracts.
4. If valid, return it without a repair call.
5. If invalid, construct bounded deterministic guidance from the validation
   codes and make the existing single repair call.
6. Validate the repair with the same contract.
7. If repair remains invalid, persist only the existing sanitized rejection
   diagnostic and continue to the next shortlist item.

## Privacy and failure behavior

- Do not persist or expose raw generated summaries that fail validation.
- Do not add raw source text, titles, URLs, item IDs, credentials, prompts, or
  provider output to audit events or Run Status.
- Keep digest-only rejection identity, 90-day artifact retention, and
  fail-closed diagnostic persistence unchanged.
- A missing or failing rejection recorder remains a bounded pipeline failure.
- Invalid summaries never reach composition or publication.

## Testing

### Validator tests

- Reproduce the canary mismatch: exact cited source title plus exact title
  provenance passes when the title is absent from excerpt bodies.
- Exact prose copied from a cited excerpt continues to pass.
- A source title from an uncited source fails.
- Fabricated or partially matching title evidence fails.
- Prominent provenance citing two sources fails when the exact evidence occurs
  in only one of them.
- Empty prominent provenance evidence fails schema validation.
- Claim evidence present in only one of two cited sources continues to produce
  `CLAIM_EVIDENCE_NOT_EXACT`.
- Research authority and access-level regressions remain unchanged.

### Summarizer tests

- The initial request still states the strict extractive contract.
- Repair guidance is field-specific and actionable for the live canary error
  families.
- Repair guidance is deduplicated, deterministically ordered, and bounded.
- Repair guidance never contains invalid generated prose or unknown source
  payloads.
- One successful repair returns a valid summary.
- One failed repair throws `SummaryRejectedError` after exactly two total model
  calls.

### Pipeline tests

- An eight-item canary-like shortlist containing two qualified research papers
  preserves all eight synthesis attempts and the reserved research ordering.
- Title-only initial failures can be repaired without changing shortlist or
  coverage gates.
- Unrepaired items still produce only sanitized diagnostics and do not block
  later shortlist items.
- Model calls remain sequential and capped at two calls per shortlisted item.

Run the focused tests first, followed by type checking, the full unit suite, the
full Worker suite, evaluation, production build, and diff checking. The known
managed-OAuth baseline remains separately scoped and must not be changed by this
work.

## Non-goals

- Permitting general paraphrases or semantic-similarity grounding.
- Relaxing claim corroboration, research authority, access-level, quality,
  topical-fit, coverage, or publication gates.
- Adding model calls, retries, token budget, or monthly budget.
- Changing discovery sources, shortlist size, research reservation count,
  ranking, section assignment, authentication, schema migrations, or HTTP API
  shape.
- Repairing Alignment Forum, OpenAlex, Papers with Code, or other discovery
  adapters in this change.

## Rollout and approval boundaries

Implementation and local verification do not authorize external mutation.
Preview deployment, a paid canary, and production promotion each require a new
explicit approval. A later canary must use one unused preview edition date and
must not retry or start a second run without separate approval.

Acceptance for implementation is local: the prompt and validator agree, the
minimal mismatch is covered by tests, stricter claim rules remain intact, and
the repair path stays bounded to one additional call. Live usefulness remains a
separate preview-canary question.
