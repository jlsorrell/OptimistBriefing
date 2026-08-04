# Canary Discovery Reliability and Policy Precision Design

**Date:** 2026-08-03  
**Status:** Pending written-spec review

## Problem

The authenticated preview canary for edition `2026-07-31` exercised the
deployed discovery pipeline through every durable checkpoint, reconciled all
model reservations, and then failed closed at publication with
`MINIMUM_COVERAGE_FAILED`. The quality gate behaved correctly, but the draft
was not useful:

- it contained no Research or Technology entries;
- its two AI Policy entries were unrelated government notices;
- all seven OpenAlex discovery lanes failed at fetch time;
- the Alignment Forum lane failed at parse time; and
- arXiv and Semantic Scholar discovered many records, but almost none were
  reported as surviving deduplication or reaching relevance triage.

The OpenAlex failure has a confirmed external cause. OpenAlex changed its API
contract in February 2026: API keys replaced the former polite-pool behavior,
and the current API documentation requires an `api_key` query parameter. The
preview has no OpenAlex key. The current adapter also uses the legacy
`per-page` spelling instead of the documented `per_page` parameter and uses an
updated-date filter form that may require a paid OpenAlex tier.

The Alignment Forum failure is less specific because the current RSS adapter
validates the entire feed against one strict RSS 2.0 item shape. A single item
whose author, link, identifier, or content uses a valid alternate RSS/Atom
representation can therefore turn the entire lane into a generic parse
failure.

The funnel counters do not explain whether candidates disappeared because
they were unchanged observations, outside the freshness window, merged into
another identity, off-topic, or rejected for quality. This ambiguity made the
historical-slot canary look like a broad deduplication failure even though the
same preview database had already observed many of the current papers.

Finally, AI Policy routing currently allows generic governance terminology to
combine with broad source eligibility. That is insufficient for a private
briefing whose AI Policy section must be specifically about AI.

## User decision

The user explicitly chose precision over section completeness: AI Policy must
remain empty, and the edition may fail closed, when no genuinely AI-specific
policy item is available. Generic regulatory or governmental notices must
never be used to fill the section.

## Goals

- Restore bounded OpenAlex discovery through a free API key without logging,
  persisting, or exposing the key.
- Keep OpenAlex usage inside the free daily allowance and fail the OpenAlex
  lanes open when authentication, quota, or transport is unavailable.
- Parse the valid RSS and Atom variants used by Alignment Forum and LessWrong
  without letting one malformed entry discard an otherwise valid feed.
- Explain candidate loss with bounded, deterministic rejection counters while
  preserving the existing discovery diagnostic invariants.
- Require explicit AI evidence and explicit policy/governance evidence before
  an item can enter AI Policy.
- Preserve all current research-quality, grounding, coverage, budget,
  authentication, source-policy, and publication gates.
- Verify the changes with one separately authorized preview canary before any
  production promotion.

## Non-goals

- Weakening topic, quality, grounding, or minimum-coverage thresholds.
- Allowing a model to override the deterministic AI Policy gate.
- Making OpenAlex a hard dependency for edition publication.
- Purchasing an OpenAlex plan, attaching a payment method, or exceeding its
  free daily allowance.
- Replacing arXiv, Semantic Scholar, Papers with Code, Alignment Forum, or
  official institutional sources.
- Replaying, deleting, or rewriting the completed `2026-07-31` canary.
- Broadly redesigning the ranking, summarization, or edition UI.

## Chosen approach

Use four targeted changes:

1. add a secret-aware, free-tier OpenAlex request boundary;
2. make feed parsing tolerant at the document and individual-entry boundary;
3. add bounded funnel-rejection accounting; and
4. centralize a deterministic dual-evidence AI Policy predicate.

This is preferred over reducing source diversity because the user values
institutional research, commentary, and cross-source evidence. It is preferred
over a model-only policy classifier because deterministic exclusion is cheaper,
testable, and fail-closed.

## Architecture

### OpenAlex secret and request boundary

The Worker environment will accept an optional `OPENALEX_API_KEY` secret. The
secret will be passed only to the OpenAlex adapter factory and appended as the
documented `api_key` query parameter immediately before the outbound HTTPS
request.

No request URL containing `api_key` may be used as a validator key, audit
payload, exception message, diagnostic label, test snapshot, or log field.
The HTTP boundary will derive any cache or diagnostic identity from a redacted
URL that removes the value of known sensitive query parameters. Provider
errors remain sanitized to the existing bounded source-failure categories.

When the key is absent, empty, rejected, or out of quota, every OpenAlex lane
returns a bounded failure and the other research families continue. The system
must not retry authentication failures or attempt an unauthenticated OpenAlex
fallback.

The adapter will use current snake-case parameters, including `per_page`.
Updated-work discovery will not depend on a premium-only updated-date filter.
It will issue the existing bounded topical search ordered by `updated_date`,
then apply the seven-day updated timestamp window locally to at most 100
returned works. Publication-date and institution lanes retain their existing
bounded server filters and local window validation.

One briefing run may make only the statically configured OpenAlex lane calls
and bounded institution-resolution calls already represented in the source
plan. It may not paginate or retry through the free allowance. An OpenAlex
free-tier exhaustion response fails those lanes open.

Operationally, the user will create a free OpenAlex API key. It will be stored
with Cloudflare's encrypted Worker-secret mechanism for preview and later for
production; it will never be placed in `wrangler.jsonc`, a shell transcript,
Git, D1, or a design/test fixture. Preview deployment must continue to use
`--keep-vars`.

### Resilient RSS and Atom normalization

The feed adapter will normalize a small, explicit set of common feed shapes:

- RSS 2.0 `rss.channel.item` and Atom `feed.entry` envelopes;
- link text, `{ href }`, and bounded link arrays, preferring an alternate or
  canonical HTTP(S) link;
- `guid` or Atom `id` identifiers;
- `pubDate`, `published`, or `updated` timestamps;
- string or structured author values; and
- `description`, `summary`, namespaced encoded content, or Atom content.

Envelope parsing remains fail-closed. Individual entries are parsed and
normalized independently: an invalid item is skipped, while valid siblings
remain available. The lane reports parse failure only when the feed envelope
is invalid or no entry can be interpreted safely from a non-empty feed.

Existing outbound URL allowlists, port/path restrictions, time-window checks,
evidence-length bounds, metadata-only behavior, and non-corroborating
commentary policy remain unchanged.

### Bounded funnel-rejection accounting

Discovery diagnostics will retain the invariant:

`assessed <= triaged <= deduplicated <= discovered`.

They will additionally carry bounded rejection counts from a fixed enum:

- `out_of_window`;
- `unchanged_observation`;
- `identity_merged`;
- `route_excluded`;
- `topic_mismatch`;
- `quality_rejected`; and
- `capacity_limited`.

Counts will be aggregated by lane and capped by the existing candidate bounds.
They will not contain titles, URLs, embeddings, provider bodies, model output,
credentials, or per-item identifiers. Only nonzero reasons need be persisted.

The counters are observational. They must not change ordering, identity
resolution, freshness windows, cache reuse, shortlist budgets, assessment
caps, or selection outcomes. A repeat-heavy canary should therefore explain
that unchanged observations were excluded instead of implying that the
adapter or identity layer lost them.

The authenticated Run Status detail will display these bounded counts beside
the existing lane diagnostics. Existing run details without the new field
remain readable as empty rejection counts.

### Deterministic AI Policy evidence gate

A shared predicate will require both of the following in bounded title,
abstract, or retained metadata text:

1. **AI evidence:** terms that specifically identify AI or its governance
   object, such as artificial intelligence, AI system, machine learning,
   foundation/frontier/generative model, automated decision system, neural
   network, model training/inference, compute governance, model evaluation, or
   algorithmic accountability.
2. **Policy evidence:** terms that identify a concrete policy or governance
   action, such as legislation, regulation, rulemaking, executive order,
   standard, audit requirement, evaluation policy, enforcement, oversight,
   accountability, procurement rule, reporting obligation, or treaty.

Source identity, source section eligibility, and generic words such as
`notice`, `meeting`, `law`, `audit`, `evaluation`, or `regulatory` cannot
satisfy AI evidence. A title or body that mentions AI only incidentally but has
no policy action cannot satisfy policy evidence.

The predicate will be used by both official-publication routing and general
news signal derivation so a candidate cannot bypass it through a different
collector. Items failing the predicate may still qualify for World,
Technology, DMV, or Baltimore under their existing rules; they simply cannot
enter AI Policy.

Model assessment and summarization may reject an item that passed the
deterministic gate, but they may not promote an item that failed it.

## Data flow

1. Collection adapters fetch bounded provider responses under the existing
   source policies.
2. OpenAlex adds its secret only at the final request boundary; feed adapters
   normalize valid entries independently.
3. Routing applies the shared dual-evidence AI Policy predicate.
4. Freshness, observation, identity, triage, assessment, and capacity stages
   increment bounded rejection reasons without altering their decisions.
5. Existing scoring, clustering, shortlisting, synthesis, validation,
   composition, and publication gates run unchanged.
6. Run Status reads the persisted bounded diagnostics and renders rejection
   counts without exposing candidate-level data.

## Failure behavior

- Missing or invalid OpenAlex credentials produce sanitized OpenAlex lane
  failures; other sources continue.
- OpenAlex quota or transport failures do not trigger unbounded retry or
  unauthenticated fallback.
- A malformed feed envelope fails only that feed lane.
- A malformed feed entry is skipped without discarding valid siblings.
- Zero genuine AI Policy candidates leaves the section empty and may cause the
  existing coverage gate to fail the edition.
- Diagnostic persistence remains fail-open and cannot change editorial output.
- No failure path may expose a secret, provider body, candidate URL, or model
  output in a public error or audit label.

## Testing

Implementation will follow test-driven development and cover:

1. OpenAlex requests include `api_key`, use `per_page`, and never expose the
   key through recorded request identities, errors, or diagnostics.
2. Missing and rejected OpenAlex keys fail only OpenAlex lanes; arXiv,
   Semantic Scholar, and publication lanes still settle.
3. Updated-work discovery uses bounded sorted search plus local seven-day
   filtering without a premium-only updated-date filter.
4. RSS 2.0 and Atom fixtures normalize to the same publication contract.
5. One malformed feed entry does not discard valid siblings, while an invalid
   envelope still produces a parse failure.
6. Each funnel rejection reason increments at the stage that owns the decision
   without changing the existing count invariants or selection results.
7. Historical unchanged candidates are reported as `unchanged_observation`,
   not as an unexplained identity loss.
8. The two unrelated canary titles—`National Center for Advancing
   Translational Sciences; Notice of Meeting` and `Formations of,
   Acquisitions by, and Mergers of Bank Holding Companies`—cannot enter AI
   Policy.
9. Genuine examples covering frontier-model regulation, compute reporting,
   secure model evaluation requirements, and AI procurement rules remain
   eligible for AI Policy.
10. General policy stories without AI evidence and AI product stories without
    policy evidence remain excluded from AI Policy.
11. Existing research routing, news sections, quality floors, grounding,
    publication, authentication, and budget tests remain green.

Full application tests, Worker integration tests, type checking, golden-set
evaluation, production build, whitespace checks, and secret-scanning checks
must pass before preview deployment.

## Preview deployment and canary acceptance

Preview deployment and another paid canary require separate explicit user
approval after implementation review.

Before deployment:

- create and store the free `OPENALEX_API_KEY` as an encrypted preview Worker
  secret without displaying it in terminal output;
- confirm no D1 migration is pending unless the implementation plan proves a
  schema migration is necessary;
- deploy only the isolated preview with `--keep-vars`; and
- retain the previous preview version for rollback.

The next canary is representative only if:

- OpenAlex authentication succeeds and at least one OpenAlex lane settles
  without an authentication or fetch failure;
- Alignment Forum settles without a feed-level parse failure;
- at least two independent research discovery families succeed;
- at least one non-arXiv research candidate reaches relevance triage, unless
  bounded diagnostics show that every such candidate was an unchanged prior
  observation;
- no item enters AI Policy without both AI and policy evidence;
- no obviously unrelated AI Policy item is composed;
- every model reservation is reconciled or released at terminal state; and
- the existing coverage and publication gates remain authoritative.

If no genuine AI Policy item is available, an empty AI Policy section and a
failed-closed edition are the correct result. Production promotion remains
blocked until a canary demonstrates useful Research coverage and clean policy
routing; missing content must never be repaired by weakening the gates.
