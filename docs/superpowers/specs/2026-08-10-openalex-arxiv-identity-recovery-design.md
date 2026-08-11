# OpenAlex arXiv Identity Recovery Design

**Date:** 2026-08-10
**Status:** Approved approach; final-review compatibility ruling incorporated

## Problem

The `2026-08-10` preview canary completed research discovery but exhausted the
normalization retry budget before any model calls or publication. D1 reported:

`UNIQUE constraint failed: items.canonical_url`

The collect checkpoint contains 386 candidates with 386 distinct canonical URL
hints, so this is not a same-run duplicate. Five candidate URLs already exist in
preview; four resolve to the same durable item IDs and are safe updates. The
remaining OpenAlex candidate has:

- an arXiv landing URL (`https://arxiv.org/abs/2608.03626`);
- only `OpenAlex:W7197052950` in its provider identifiers because OpenAlex
  omitted `ids.arxiv`; and
- an existing stored row at that URL whose durable identity is
  `arXiv:2608.03626`.

Normalization therefore derives a new OpenAlex-based item ID while D1 already
owns the canonical URL under the arXiv-based item ID. The repository correctly
refuses to create two items for one canonical URL, but the whole normalization
stage becomes retryable.

## User decision

Use the OpenAlex-specific identity-recovery approach. When OpenAlex omits its
explicit arXiv identifier but provides an arXiv landing URL, recover the arXiv
identifier from that URL rather than changing repository conflict semantics or
all-provider normalization behavior.

## Goals

- Give the same paper the same durable item ID whether it arrives from arXiv or
  from an OpenAlex record whose landing page is arXiv.
- Repair the already-persisted `2026-08-10` collect checkpoint without repeating
  provider discovery.
- Preserve OpenAlex provenance alongside the recovered arXiv identity.
- Keep historical durable-identity ordering, canonical URL handling,
  provider-text boundaries, deduplication, model budgets, and publication rules
  unchanged.
- Fail open when a landing URL is not a valid arXiv identifier.

## Non-goals

- Changing the `items.canonical_url` uniqueness constraint.
- Re-keying, deleting, or rewriting historical items or editions.
- Resolving arbitrary cross-provider identity conflicts by canonical URL.
- Repeating the completed discovery stage or starting a second dated run.
- Modifying production, schedules, credentials, model settings, or D1 schemas.

## Chosen approach

Recover an arXiv identifier only for OpenAlex candidates, at both OpenAlex
collection and the trusted normalization boundary.

The adapter path prevents future collect checkpoints from losing the identity.
The normalization fallback is also required because the current canary's
completed collect checkpoint already contains the older OpenAlex-only record.
It allows that checkpoint to resume without repeating external provider calls.

## Final-review compatibility ruling

At normalization, URL recovery is allowed only when the supplied identifiers
contain neither a valid arXiv identifier nor a valid DOI, as determined by
`normalizeArxivIdentifier` and `normalizeDoi`. A supplied dual DOI+arXiv
candidate retains the historical arXiv-derived Item ID produced by the
normalized, sorted DOI/arXiv selection. Malformed `arXiv:` or `DOI:` text is not
an explicit identity and is excluded from stable-ID eligibility. This ruling
supersedes any earlier global DOI-first interpretation; Task 1 adapter behavior
is unchanged.

This remains narrower than globally deriving identifiers from every candidate
URL. It is also safer than teaching repository persistence to change item IDs on
canonical-URL conflict, which could break foreign-key references from editions,
feedback, summaries, and scores.

## Data flow

### New OpenAlex observations

1. Parse OpenAlex's explicit `ids.arxiv` value with the existing
   `normalizeArxivIdentifier` helper.
2. If the explicit value is absent or invalid, apply the same helper to
   `primary_location.landing_page_url`.
3. If either produces an arXiv identifier, include it with the OpenAlex ID in
   `externalIds` and use the existing identity precedence for `externalId`.
4. Preserve the existing original-URL and DOI selection rules.

An explicit valid OpenAlex arXiv identifier takes precedence over an inferred
landing-page identifier. A non-arXiv landing page produces no inferred ID.

### Existing collect checkpoints

At normalization, when and only when `sourceId` is `openalex`:

1. parse every supplied identifier for valid explicit arXiv and DOI identities;
2. only when neither kind is present, inspect the already-canonicalized URL with
   `normalizeArxivIdentifier`;
3. add any recovered arXiv identifier to the normalized durable identifiers;
   and
4. derive the Item ID through the historical normalized/sorted DOI-or-arXiv,
   provider, then canonical-URL selection.

No URL is decoded as provider display text, and no provider can assert a
prepared-state marker. The URL remains structural data.

For the observed candidate this produces the existing arXiv-based item ID, so
D1 performs its normal `ON CONFLICT(id) DO UPDATE` operation instead of hitting
the canonical-URL uniqueness constraint.

## Error handling and invariants

- Invalid, non-HTTP, non-arXiv, or malformed landing URLs do not yield an arXiv
  identity and retain current OpenAlex-ID behavior.
- Explicit and inferred arXiv values use the existing version-stripping and
  canonical formatting rules.
- An explicit DOI without an explicit arXiv identity suppresses normalization
  fallback; a supplied dual DOI+arXiv candidate retains its historical
  arXiv-derived Item ID.
- The fix does not catch or suppress genuine D1 uniqueness errors; unexpected
  conflicts remain visible and retryable.
- Raw article text, titles, credentials, and full provider responses are not
  added to diagnostics.

## Testing

Use strict test-driven development:

1. Add an OpenAlex discovery regression where `ids.arxiv` is absent and the
   landing page is arXiv. Before the fix it must produce an OpenAlex-only
   identity; after the fix it must include and prefer the normalized arXiv ID.
2. Add a normalization regression using an OpenAlex-only raw candidate with an
   arXiv original URL. Its normalized item ID must equal the ID produced by an
   arXiv-identified candidate for the same paper.
3. Add inverse cases proving a non-arXiv landing URL remains OpenAlex-only and a
   valid explicit arXiv identifier is not replaced by a conflicting landing
   URL.
4. Add a D1 repository/workflow regression with an existing arXiv-identified
   item and the checkpoint-shaped OpenAlex candidate. Normalization persistence
   must update safely rather than violate `items.canonical_url`.
5. Run the focused OpenAlex, normalization, repository, and workflow suites,
   followed by typecheck, the full non-Worker and Worker suites, evaluator,
   build, and diff checks.

## Preview rollout and acceptance

1. Deploy the tested build only to `optimist-briefing-preview` with existing
   variables, secrets, D1 binding, and Workflow binding preserved.
2. Do not apply a migration; this design changes no schema or historical rows.
3. Resume the existing `2026-08-10` retryable run from its completed collect
   checkpoint. Do not start another dated run.
4. Confirm normalize persists successfully, later checkpoints advance, model
   reservations reconcile, and the edition reaches its correct terminal state.
5. Inspect the Research and Research Radar output for source relevance, tier
   ordering, literal entity artifacts, source failures, and bounded cost.

Acceptance requires no canonical-URL collision, no repeated discovery, no
production change, and no extra run beyond the existing August 10 canary.
