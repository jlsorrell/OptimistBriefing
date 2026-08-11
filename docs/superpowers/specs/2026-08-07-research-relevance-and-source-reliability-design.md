# Research Relevance and Source Reliability Design

**Date:** 2026-08-07
**Status:** Approved for implementation planning

## Problem

The `2026-08-07` preview canary successfully published a briefing, but its
Research section contained only one paper and that paper was only broadly
related to the reader's interests. A more directly relevant shortlisted paper
failed synthesis validation, while several potentially useful research sources
were unavailable or unreliable during discovery.

The canary and a local diagnostic review exposed four distinct issues:

1. Research relevance is currently represented primarily by one embedding
   similarity score against a profile that contains both specific technical
   interests and broad terms such as AI safety, alignment, oversight, and
   governance. That score cannot reliably distinguish a direct technical match
   from a worthwhile but broader adjacent paper.
2. Alignment Forum and MIT feeds are healthy, but the publication collector
   applies one URL policy to both the feed endpoint and every article link.
   Valid article links therefore fail the feed-only host or path restrictions,
   causing otherwise parseable feeds to report no interpretable entries.
3. Research discovery launches many lanes for the same provider concurrently.
   In particular, Semantic Scholar's introductory key limit is one request per
   second, so concurrent searches and recommendations can intermittently
   throttle one another. OpenAlex lanes can likewise create unnecessary bursts
   and consume the daily allowance inefficiently.
4. Some publisher feeds include HTML character references such as `&#8216;`,
   `&#8217;`, and `&#8220;` in titles and descriptions. Provider text is currently
   normalized without decoding those references, so they are persisted to D1
   and rendered literally in the briefing.

The current OpenAI research listing URL is also stale. The current official
publication index may still reject automated Worker requests, so updating the
URL improves the attempt but cannot make OpenAI a dependable source.

## User decision

Research selection must use tiered relevance rather than a binary relevance
filter:

- papers directly matching the reader's specific technical interests receive
  priority; and
- strong broader work in AI safety, alignment, governance, evaluation, or
  closely adjacent areas may fill otherwise unused Research slots.

It is acceptable for a broader paper to appear when no better direct match is
available. Existing technical-quality and evidence standards must still apply.

## Goals

- Prefer direct technical matches without making sparse mornings artificially
  empty.
- Preserve up to three featured Research slots for the best available work,
  filling them from direct matches before considering adjacent matches.
- Keep current technical-quality, source-authority, grounding, access-level,
  budget, coverage, and publication gates unchanged.
- Restore valid Alignment Forum, LessWrong, and MIT article discovery while
  retaining strict outbound URL controls.
- Reduce provider throttling through provider-aware scheduling and bounded
  backoff without making any provider a hard dependency.
- Decode a bounded set of safe HTML character references before provider text
  is normalized and persisted.
- Update the OpenAI research publication URL and continue to fail that source
  open when automated access is blocked.
- Preserve sanitized diagnostics and current privacy boundaries.

## Non-goals

- Guaranteeing three Research items every day.
- Publishing low-quality or weakly supported work merely to fill a slot.
- Replacing the existing embedding, scoring, assessment, synthesis, or
  validation systems.
- Adding a paid model call for relevance reranking.
- Treating institution prestige as proof of relevance or quality.
- Making broad AI safety or AI ethics work compete equally with direct matches
  when qualified direct matches are available.
- Bypassing anti-bot controls or scraping restrictions on OpenAI or any other
  source.
- Rewriting historical D1 records or previously published editions. Historical
  entity artifacts may remain; new observations and editions must be clean.
- Broadly rendering arbitrary publisher HTML in the briefing.

## Chosen approach

Use four targeted changes:

1. classify qualified research candidates into deterministic `core` and
   `adjacent` relevance tiers, then select core candidates first;
2. schedule discovery with provider-aware concurrency and pacing;
3. separate feed-endpoint URL policy from article-link URL policy; and
4. decode bounded HTML character references at the provider-text ingestion
   boundary.

This approach is preferred over raising the embedding threshold. A higher
threshold would remain calibration-sensitive, would not express direct versus
fallback relevance, and could discard useful broader work on sparse days.

It is also preferred over adding an LLM reranker. Deterministic tiering is
cheaper, reproducible, explainable in tests, and does not consume another model
reservation before synthesis.

## Architecture

### Tiered research relevance

Research candidates retain their existing embedding topical-fit score,
technical-quality assessment, source signals, institution signals, recency,
and total score. A new deterministic relevance tier augments those signals; it
does not replace them.

The tier classifier operates on the same bounded normalized title, abstract,
topic metadata, and retained discovery metadata that are already authorized
for research triage. It does not fetch new content or use model memory.

#### Core tier

A candidate belongs to the `core` tier only when its normalized evidence
contains a concrete match to at least one configured technical-interest family:

- internal representations, concept representation or evolution over
  training, mechanistic or representation-level interpretability;
- theoretical accounts of emergence, learning dynamics, phase transitions,
  or scaling behavior;
- capability elicitation, hidden or latent capabilities, sandbagging, or
  evaluation methods intended to reveal capabilities;
- AI safety through debate, scalable oversight closely related to debate, or
  game-theoretic models of multi-agent behavior;
- cryptographic verification of training, inference, data provenance, or
  secure evaluation; or
- fully homomorphic encryption, multiparty computation, zero-knowledge proofs,
  or functional encryption applied specifically to machine learning.

The match must use bounded positive evidence, including configured phrases and
co-occurring term groups where a generic acronym or word would otherwise be
ambiguous. For example, `MPC` alone is insufficient, while multiparty
computation combined with model training or inference evidence is sufficient.
Generic occurrences of `alignment`, `AI safety`, `evaluation`, `governance`,
or `interpretability` alone do not establish the core tier.

#### Adjacent tier

A candidate belongs to the `adjacent` tier when it passes the existing
research topical-fit and technical-quality gates and concerns broader AI
safety, alignment, governance, oversight, evaluations, AI ethics, robustness,
or another closely related area, but lacks enough deterministic evidence for a
core classification.

The adjacent tier is a fallback category, not a lower quality standard. An
adjacent candidate must pass every existing research gate and is ranked using
the existing score components.

Candidates that meet neither tier remain excluded under current research
routing and topical-fit rules.

#### Selection behavior

The existing research assessment queue, quality gates, and score calculation
remain unchanged. Tier affects only the order in which already-qualified
research candidates consume the featured Research capacity:

1. rank qualified core candidates using the existing deterministic ordering;
2. select up to the existing featured Research maximum from that list;
3. if featured capacity remains, rank and select qualified adjacent candidates
   using the same ordering; and
4. leave capacity unused when neither tier contains another qualified item.

The current reservation of up to three featured Research slots is retained.
Tiering does not allow Research to displace unrelated section reservations or
increase edition/model budgets.

When a human-readable selection reason is already persisted, it should say
whether the item was a direct technical match or an adjacent fallback. The
bounded tier label may appear in authenticated diagnostics, but must not expose
abstract text, embeddings, or internal phrase matches.

### Provider-aware discovery scheduling

Research discovery will group adapters by provider identity. Different
providers may still run in parallel, preserving source isolation and reasonable
run time. Lanes for the same rate-limited provider run through a small
provider-specific scheduler:

- Semantic Scholar: at most one request in flight, with at least one second
  between request starts for the current introductory-key contract;
- OpenAlex: at most two requests in flight, with the existing bounded retries
  and daily request budget unchanged; and
- other independent providers: retain current concurrency unless their catalog
  entry declares a stricter bounded policy.

The scheduler is statically configured in application code. Provider response
text must not dynamically raise concurrency, retry count, or delay bounds.

Retry behavior remains bounded and provider-aware:

- retry only transient transport failures, `429`, and retryable `5xx`
  responses;
- honor a valid bounded `Retry-After` value when present;
- otherwise use bounded backoff with a fixed maximum number of attempts;
- do not retry authentication, authorization, malformed-response, or exhausted
  daily-quota failures; and
- settle each lane independently so one exhausted provider cannot fail the
  overall discovery stage.

Existing sanitized lane diagnostics remain the source of operational evidence.
Scheduling must not persist API keys, raw provider bodies, complete URLs with
secret query parameters, or candidate content.

### Separate feed and article URL policies

Publication catalog configuration will distinguish two controls:

- `feedUrlPolicy` authorizes the configured RSS, Atom, or listing endpoint;
- `articleUrlPolicy` authorizes links extracted from entries in that feed or
  listing.

Both policies retain the existing HTTPS, port, hostname, path, redirect, and
bounded-fetch checks. Separating them does not make article retrieval
unrestricted.

The Alignment Forum source will:

- keep its feed endpoint pinned to the configured Alignment Forum feed; and
- allow article paths under `/posts/` on both `www.alignmentforum.org` and
  `www.lesswrong.com`, because the current feed legitimately emits LessWrong
  article links.

The MIT source will:

- keep its feed endpoint pinned to the configured `/rss/` endpoint; and
- allow bounded article paths on the same official MIT domain rather than
  requiring every article to remain below `/rss/`.

Catalog parsing fails closed when either policy is absent or invalid. Existing
catalog records can be migrated by copying their current URL policy into both
fields, then applying only the reviewed source-specific article-policy
expansions. Redirects must be checked against the appropriate policy after
every hop.

### Provider-text entity decoding

A shared provider-text normalizer will decode a bounded subset of HTML
character references before tag stripping, whitespace normalization, evidence
truncation, hashing, and persistence.

The decoder will support:

- decimal numeric references such as `&#8216;`;
- hexadecimal numeric references such as `&#x2019;`; and
- the small named set needed for ordinary feed text: `amp`, `quot`, `apos`,
  `lt`, `gt`, and `nbsp`.

Numeric references are decoded only when they represent a valid Unicode scalar
value. Invalid, oversized, surrogate, control-character, or unrecognized named
references remain inert text or are handled by the existing control-character
normalization; they must not throw or create markup.

Decoding is bounded by the existing provider-text input limits and a fixed
maximum number of passes sufficient for the observed feeds. This addresses
single-encoded and common double-encoded text without creating an unbounded
recursive decoder. The decoder returns plain text only. Decoded `<` and `>`
characters pass through the existing tag-removal and escaping path and are
never treated as trusted markup by the UI.

The shared normalizer will be applied to provider-controlled display and
evidence fields—including titles, descriptions, abstracts, extracted excerpts,
and publication-page text—before creation of normalized source records. URL,
identifier, credential, and structured metadata fields are not decoded.

The UI remains escaped by default. No `dangerouslySetInnerHTML` or equivalent
rendering path is introduced.

### OpenAI publication source

The OpenAI catalog entry will point to the current official research
publication index. It remains subject to the same strict feed/page and article
URL policies as other official sources.

If the official site returns `403`, an anti-bot response, an unsupported page,
or another bounded fetch/parse failure, the OpenAI lane fails open and records
only the existing sanitized outcome. The system will not impersonate a browser,
solve a challenge, use an unofficial mirror, or make publication depend on
OpenAI availability.

## Data flow

1. The research collector groups configured lanes by provider and schedules
   each group under its provider-specific concurrency and pacing bounds.
2. Feed and page collectors validate the source endpoint with `feedUrlPolicy`,
   then validate every extracted and redirected article link with
   `articleUrlPolicy`.
3. Retrieved provider text passes through the bounded shared entity decoder
   and existing plain-text normalizer before normalized records, fingerprints,
   excerpts, or D1 observations are created.
4. Existing identity, freshness, deduplication, routing, embedding, triage, and
   technical assessment stages run under their current budgets and gates.
5. Qualified research candidates receive a deterministic `core` or `adjacent`
   tier from bounded normalized evidence.
6. Existing scoring orders candidates within each tier. Featured selection
   consumes core candidates first, then adjacent candidates if capacity
   remains.
7. Existing synthesis, grounding validation, composition, coverage, cost, and
   publication controls run unchanged.

## Failure behavior

- A provider scheduler failure settles only the affected provider lanes; other
  discovery families continue.
- A provider that remains throttled after bounded retries fails open without
  expanding requests, retries, or budget.
- A valid feed containing no article link allowed by its article policy reports
  a bounded parse/policy outcome; it never follows an unapproved URL.
- A malformed entity never crashes ingestion and never becomes trusted HTML.
- Failure to classify a candidate as core does not discard it when it
  legitimately qualifies as adjacent.
- Zero qualified core candidates allows qualified adjacent candidates to fill
  Research capacity.
- Zero qualified candidates in both tiers leaves Research capacity unused and
  preserves the existing edition coverage behavior.
- Source availability, preferred institution, or publisher identity cannot
  override the research quality and grounding gates.
- OpenAI access failure remains an isolated source failure.

## Compatibility and migration

- Catalog configuration gains explicit feed and article policies. Existing
  source entries preserve their behavior by defaulting both policies to their
  current policy during the code/config migration.
- Persisted records that predate tiering remain readable. The tier is derived
  during the active pipeline and may be added only to bounded selection or
  diagnostic data where needed; historical rows do not require a rewrite.
- Existing D1 text containing literal entities is not mutated. If an old item
  is rediscovered from source, its newly normalized observation uses decoded
  text under the existing identity and freshness rules.
- Run Status and artifact readers must tolerate records without a tier or new
  scheduling detail.

## Testing

Implementation will follow test-driven development.

### Relevance-tier tests

- Each configured technical-interest family has positive core examples.
- Ambiguous acronyms and isolated broad words do not establish a core match.
- A broader AI safety or governance paper that passes existing gates is
  classified as adjacent rather than discarded.
- Core candidates fill featured Research capacity before higher-scoring
  adjacent candidates.
- Adjacent candidates fill remaining capacity when fewer than three qualified
  core candidates exist.
- Capacity remains empty when neither tier contains another qualified item.
- Technical-quality, topical-fit, authority, access, grounding, and total
  research capacity gates remain unchanged.
- Selection reasons expose only the bounded tier label and approved score
  explanations.

### Scheduler tests

- Semantic Scholar requests never overlap and request starts satisfy the
  configured pacing interval under a fake clock.
- OpenAlex never exceeds its configured per-provider concurrency.
- Different providers can progress concurrently.
- `429` and retryable `5xx` responses receive only bounded retries and bounded
  delays.
- Authentication, parse, and non-retryable quota failures are not retried.
- Failure or exhaustion of one provider leaves other providers and lanes
  settled normally.
- Scheduler diagnostics contain no credentials, sensitive query values, or raw
  provider bodies.

### URL-policy tests

- The Alignment Forum feed endpoint remains allowed.
- Valid `/posts/` links on Alignment Forum and LessWrong are allowed as article
  links, while unrelated hosts and paths remain blocked.
- The MIT RSS endpoint remains allowed and official MIT article paths are
  accepted without permitting unrelated hosts or ports.
- A URL permitted by an article policy cannot be used as a feed endpoint unless
  the feed policy also permits it.
- Every redirect hop is revalidated against the relevant policy.
- Existing catalog entries preserve their previous behavior after migration.

### Entity-normalization tests

- Decimal and hexadecimal curly quotes decode correctly.
- The approved named references decode correctly.
- Double-encoded observed feed text is handled within the fixed pass bound.
- Invalid Unicode values, unknown names, incomplete references, and oversized
  inputs fail safely.
- Decoded angle brackets pass through plain-text tag removal and cannot create
  executable or trusted markup.
- Titles, descriptions, abstracts, publication-page text, and extracted
  excerpts are normalized before persistence and rendering.
- URLs and identifiers are unchanged.
- A canary-like WAMU fixture no longer renders literal `&#8216;` or `&#8217;`.

### Integration and regression tests

- A mixed research pool selects direct papers first and uses adjacent papers as
  fallback without exceeding three featured Research items.
- Alignment Forum and MIT fixtures produce candidates rather than generic parse
  failures under their reviewed policies.
- Provider throttling cannot abort the full research collector.
- Existing discovery count invariants and fail-open lane settlement remain
  intact.
- Existing synthesis, grounding, cost, coverage, authentication, privacy, and
  publication tests remain unchanged and pass.

Run focused tests first, then type checking, the full unit suite, the full
Worker suite, evaluation, production build, and diff checking. Deployment and
a preview canary require separate authorization after implementation review.

## Operational verification

After implementation is merged and deployed to preview:

1. run one separately authorized scoped preview briefing;
2. confirm Alignment Forum and MIT no longer fail because article links violate
   feed-only policy;
3. confirm Semantic Scholar and OpenAlex lane failures do not show burst-shaped
   throttling under the new scheduler;
4. inspect the authenticated shortlist diagnostics to confirm core candidates
   precede adjacent fallback candidates;
5. inspect the rendered briefing for literal numeric entity artifacts; and
6. verify model reservations, run cost, monthly cap, and publication outcome as
   usual.

Production promotion remains a separate user decision.
