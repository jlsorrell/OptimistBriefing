# Non-arXiv Research Source Reliability Design

**Date:** 2026-08-12
**Status:** Approved for implementation planning

## Problem

The `2026-08-12` preview canary published a grounded Research section, but both
featured items originated on arXiv. No non-arXiv candidate reached research
triage even though several configured sources contained potentially useful
material.

The canary diagnostics separate that outcome into three different classes:

1. Some sources were operationally unhealthy. Alignment Forum reported a parse
   failure, OpenAI reported a fetch failure, and several official publication
   pages reported policy or fetch failures.
2. Some sources were healthy but low-yield. LessWrong Curated, MIT, and Papers
   with Code each discovered an item that did not route as research.
3. Bibliographic providers returned many candidates but none met the existing
   topical-fit requirements. In particular, OpenAlex preferred-institution
   discovery was healthy and broad; zero triaged results is not itself evidence
   that the provider is broken.

A live read-only check after the canary showed that the current Alignment Forum
feed parses successfully through the production RSS adapter. The canary failure
was therefore transient or response-specific rather than proof that the parser
is categorically incompatible. The same review found concrete source drift:

- the Papers with Code adapter still reads the homepage's stale trending list,
  while the site now exposes a dedicated recent-paper index at
  `https://paperswithcode.co/papers/recent`;
- LessWrong Curated is intentionally sparse and cannot provide broad daily
  recall by itself; and
- the generic publication-page collector cannot reliably interpret the current
  structures of several high-value lab indexes.

The next reliability pass should improve discovery recall without manufacturing
a daily non-arXiv quota or relaxing research quality.

## User decisions

The user approved the following boundaries:

- success means that non-arXiv sources work reliably and genuinely relevant
  candidates reach triage when available;
- zero non-arXiv items remains an acceptable result on a quiet day;
- implementation should focus first on a small set of high-yield sources rather
  than make the generic page scraper more permissive;
- Papers with Code, Alignment Forum, LessWrong, Anthropic, Google DeepMind,
  Google Research, and OpenAI receive the initial dedicated work;
- university news pages remain enabled and fail open, but do not receive equal
  implementation effort in this pass;
- LessWrong Curated remains, and a separate bounded Frontpage lane is added with
  an initial fixed minimum-karma threshold of 20; and
- all existing topical-fit, quality, grounding, freshness, diversity, budget,
  and publication controls stay in force.

## Goals

- Make high-value commentary, implementation indexes, and official-lab sources
  dependable enough to contribute candidates when relevant work exists.
- Distinguish a broken source from a healthy source with no in-window or
  research-routable content.
- Replace stale or structurally mismatched discovery endpoints with reviewed,
  bounded source contracts.
- Preserve strict outbound URL, redirect, response-size, timeout, retry, and
  provider-text controls.
- Preserve deterministic candidate identity and consolidate duplicate
  commentary observations across Curated and Frontpage feeds.
- Retain fail-open isolation so no non-arXiv source can block arXiv or another
  healthy lane.
- Keep diagnostics sanitized, bounded, and useful for the next preview review.

## Non-goals

- Guaranteeing a non-arXiv Research item every day.
- Filling an empty slot with weak, stale, low-quality, or ungrounded material.
- Lowering research topical-fit, near-match, technical-quality, source-authority,
  synthesis, or grounding thresholds.
- Treating an institution or lab name as proof of topical relevance or quality.
- Replacing arXiv, OpenAlex, or Semantic Scholar.
- Broadly loosening generic publication-page parsing.
- Bypassing bot defenses, challenges, paywalls, robots controls, or publisher
  restrictions.
- Adding a model call for source parsing, relevance filtering, or reranking.
- Rewriting historical candidates, observations, checkpoints, or editions.
- Deploying to preview or running a paid canary as part of implementation.

## Approaches considered

### A. Focused high-yield source contracts — chosen

Repair the small set of sources with the greatest expected editorial value.
Use explicit feed, recent-index, or reviewed listing contracts and retain all
downstream editorial gates.

This approach directly addresses the canary evidence, gives each source a
testable operational contract, and limits false-positive risk.

### B. More permissive generic page inference

Teach the generic page adapter to infer cards, relative dates, client-rendered
data, and likely article links across arbitrary layouts.

This could revive more institutional pages in one change, but it creates a much
larger false-positive and policy surface. A permissive fallback can silently
collect navigation links, stale archive material, unrelated campus news, or
product marketing when a site changes.

### C. Bibliographic providers as the dominant discovery layer

Invest only in OpenAlex and Semantic Scholar query recall and use publisher
websites primarily for enrichment.

This is operationally simpler, but it does not satisfy the user's interest in
research commentary and lab-authored results. It also leaves discovery overly
dependent on paper indexes that overlap substantially with arXiv.

## Chosen architecture

### Source tiers

The source catalog remains one fail-open collection system, but implementation
effort is explicitly prioritized.

#### Tier 1: repair now

- Alignment Forum Frontpage RSS
- LessWrong Curated RSS
- a new LessWrong Frontpage RSS lane with `karmaThreshold=20`
- Papers with Code recent papers

#### Tier 2: reviewed lab contracts

- Anthropic Research
- Google DeepMind
- Google Research
- OpenAI Research

#### Tier 3: existing best-effort sources

Stanford, Berkeley, Harvard, MIT, CMU, Penn, Johns Hopkins, UT Austin, and
Georgia Tech remain enabled. The MIT RSS adapter continues to use its existing
reviewed feed/article policy. Other university pages retain their current
fail-open behavior. A later pass may promote a source to a dedicated contract
when diagnostics demonstrate useful missed content.

OpenAlex and Semantic Scholar remain first-class bibliographic providers. A
healthy bibliographic lane that returns no candidate above topical-fit is not
classified as an operational failure.

### Explicit collection contracts

Each dedicated source contract specifies:

- one exact endpoint or bounded family of reviewed endpoints;
- separate endpoint and extracted-article URL policies;
- allowed redirect hosts, ports, and path prefixes;
- accepted response media types;
- bounded selectors or feed fields for title, canonical URL, publication date,
  authors, summary, categories, and identifiers;
- maximum listing entries and maximum detail-page fetches;
- the content-use and retention policy inherited from the catalog; and
- fixtures representing the real source structure and meaningful drift cases.

Extraction profiles are static application code keyed by reviewed source ID.
The source catalog supplies the endpoint and URL policies, but cannot choose or
modify selectors, increase bounds, or expand URL policies at runtime.

If a reviewed structure is absent or malformed, the lane fails open with a
sanitized outcome. It does not fall back to arbitrary whole-page link scraping.

### Feed contracts

Alignment Forum keeps the existing Frontpage RSS endpoint and split feed/article
URL policy. The production adapter already accepts the current feed when fetched
successfully. Implementation adds a current-structure fixture and improves
failure attribution; it does not replace the feed with scraping.

LessWrong Curated remains an independent high-selectivity lane. A new Frontpage
source uses the officially supported Frontpage feed view plus a fixed
`karmaThreshold=20`. The threshold bounds discovery volume; it is not an
editorial approval signal. Both feeds retain the same strict LessWrong article
policy.

When Curated and Frontpage contain the same post, canonical URL and durable
identity consolidation produce one research candidate. The consolidated
candidate retains both discovery lanes and the stronger Curated provenance.

OpenAI uses its official `https://openai.com/news/rss.xml` feed as the reviewed
discovery endpoint. The live feed supplies stable publication dates, categories,
canonical URLs, and bounded summaries. It also contains non-research company and
product posts, so category and ordinary routing checks remain mandatory. The
endpoint policy permits only that feed path; the article policy retains only
reviewed OpenAI research and index paths. The adapter does not fall back to the
Research page when the feed fails.

### Papers with Code recent-paper contract

The Papers with Code adapter moves from the homepage's `Relevant papers`
trending region to `https://paperswithcode.co/papers/recent`, which describes a
rolling fourteen-day paper index.

The adapter:

- reads at most 100 recent entries;
- requires an allowed `/paper/` URL and a normalized arXiv or other durable
  paper identity under the existing identifier policy;
- preserves the publication date exposed by the index;
- treats code availability as supporting implementation metadata only; and
- emits metadata-only discovery candidates that must resolve to primary
  evidence before synthesis and grounding.

Papers with Code never substitutes for the primary paper and cannot establish
technical quality by itself.

### Reviewed lab contracts

Anthropic, Google DeepMind, and Google Research receive explicit listing
profiles rather than generic card inference. OpenAI uses the explicit RSS
contract above.

For each listing source, collection inspects at most 20 dated entries. Bounded
title, summary, category, and URL signals identify plausible research material.
Only those plausible entries are eligible for at most five detail-page fetches
per source. The OpenAI feed applies the same 20-entry and five-detail limits.
Detail retrieval remains subject to the source's content-use policy and the
shared HTTP and article-extraction limits.

The contract permits only reviewed first-party hosts and specific paths. A lab
index that links to another first-party corporate domain requires that host and
path to be explicitly reviewed; it is not accepted merely because the brand is
related.

Product announcements, hiring pages, navigation links, undated entries, and
generic corporate news do not become Research candidates. They may route to an
existing news section only when the source's section eligibility and existing
news routing rules permit it.

## Data flow

1. The catalog loader validates the source record, approved profile, endpoint,
   feed/article policies, and static bounds.
2. The shared HTTP client fetches the endpoint with existing request admission,
   pacing, timeout, retry, redirect, response-size, and cancellation controls.
3. The dedicated adapter parses only its reviewed feed or listing structure.
4. Every extracted URL is validated against the article policy before it is
   retained or fetched.
5. Provider-controlled display and evidence text passes through the existing
   bounded normalize-once lifecycle. URLs, identifiers, dates, category codes,
   and structural metadata are not entity-decoded as prose.
6. Adapters emit ordinary `RawPublicationCandidate` values with bounded
   discovery-family and lane metadata.
7. Existing publication routing determines whether each candidate is
   substantive research, commentary, technology or AI-policy news, or
   unroutable.
8. Existing research identity consolidation combines duplicate paper or post
   observations and preserves source lineage.
9. Existing freshness, observation, embedding, topical-fit, near-match,
   diversity, assessment, technical-quality, synthesis, grounding, cost, and
   publication controls run unchanged.

## Editorial behavior

### Commentary

An Alignment Forum or LessWrong post may become standalone research commentary
only when its bounded text contains both a configured research-topic signal and
substantive research evidence under the existing routing rules. A broad mention
of AI safety or alignment is insufficient.

When a commentary post contains an arXiv or DOI identity, it may attach to the
primary paper under the existing research-consolidation contract. Commentary
can add context or criticism but cannot replace primary evidence for a paper's
technical claims.

### Official labs

Official-lab provenance contributes the existing source-authority signal. It
does not bypass topical fit, direct-versus-adjacent relevance, technical
assessment, access, freshness, or grounding. Official product announcements do
not become Research solely because they originate from a preferred lab.

### Metadata indexes

Papers with Code and other metadata-only observations may improve discovery,
identity, code-availability, and corroborating metadata. A featured paper still
requires a primary-document URL and the existing primary-source grounding.

### Capacity

No source receives a reserved slot. Existing research-family and publisher
diversity limits remain. Zero qualified non-arXiv items is a valid result and
does not cause threshold relaxation or additional model calls.

## Diagnostics and failure semantics

Discovery diagnostics must distinguish these operational states without
persisting content:

- success with one or more in-window candidates;
- success with no in-window entries;
- entries parsed but none routed as research;
- fetch or timeout failure;
- outbound URL or redirect-policy rejection;
- unsupported response media type; and
- feed/listing parser drift or no interpretable entries.

The implementation may express these through the existing bounded outcome and
rejection-count schemas or a backward-compatible bounded extension. It must not
store response bodies, article text, full sensitive query strings, credentials,
arbitrary exception messages, selector content, or provider stack traces.

One failed lane never rejects the overall collection stage. A configuration
error becomes a failed adapter for that source. A live source response that no
longer matches its reviewed fixture becomes a parser outcome, not an invitation
to broaden scraping automatically.

## Catalog migration and compatibility

A new additive D1 migration follows the already-deployed split-policy migration.
It must not amend migration `0011`.

The migration:

- updates the Papers with Code endpoint only when its existing endpoint and URL
  policy still equal the reviewed prior defaults;
- adds the new LessWrong Frontpage source without mutating the existing Curated
  source;
- adds or updates reviewed endpoint and article policies for dedicated lab
  contracts only when the existing fields are absent or exactly match known
  defaults; and
- preserves partial, custom, or operator-supplied endpoint and policy values.

Migration tests cover fresh installation, upgrade from every applicable legacy
default, explicit-equal legacy customization, partial configuration, custom
endpoints, idempotence, and absence semantics.

Historical source observations, checkpoint artifacts, and editions remain
readable and are not rewritten. New source IDs and diagnostic outcomes must be
optional to existing readers. Source-order and discovery-lineage logic remains
deterministic when a legacy database does not yet contain the new Frontpage
source.

## Security, privacy, and resource bounds

- All requests use HTTPS and the existing SSRF-safe outbound URL validator.
- Every redirect hop is revalidated against the correct endpoint or article
  policy.
- Cross-origin redirects retain only the existing approved safe headers.
- Response bodies remain bounded by the shared byte limit and request timeout.
- Adapter entry, detail-fetch, text, metadata, and diagnostic counts are fixed
  in application code.
- Provider responses cannot raise concurrency, retry counts, timeouts, fetch
  depth, or URL-policy scope.
- Provider text remains plain escaped UI text; no trusted-HTML rendering path is
  added.
- No API key, cookie, authenticated browser session, or bot-challenge bypass is
  introduced.
- No new model call, embedding call, or model reservation is added by discovery.

## Testing strategy

Implementation follows test-driven development.

### Dedicated adapter tests

For every repaired source, add bounded sanitized fixtures for:

- a current valid feed or listing;
- in-window and out-of-window entries;
- malformed or missing required fields;
- unexpected markup or envelope drift;
- unsupported content type;
- allowed and disallowed article links;
- allowed and disallowed redirects; and
- healthy empty results versus parser failure.

Alignment Forum receives a current real-structure RSS fixture. A fetch-specific
failure must not be mislabeled as feed syntax failure.

LessWrong tests prove Curated and Frontpage independently collect, enforce the
fixed threshold endpoint, reject unrelated hosts, and consolidate duplicates
without losing Curated lineage.

Papers with Code tests prove recent-index extraction, stable date parsing,
identity normalization, stale-item exclusion, code metadata, and primary-source
requirements.

Lab tests prove current listing extraction, bounded detail fetches, first-party
policy enforcement, product-news exclusion, and fail-open parser drift.

### Pipeline and regression tests

- A relevant non-arXiv fixture reaches research triage without a special quota.
- An irrelevant but operationally healthy fixture records routing rejection,
  not source failure.
- A failed dedicated source leaves arXiv, bibliographic, and other publication
  lanes intact.
- Curated/Frontpage and commentary/paper duplicates retain deterministic
  identity, source lineage, and publisher-family accounting.
- Metadata-only observations cannot pass primary-paper grounding by themselves.
- Existing topical-fit, near-match, technical-quality, synthesis, validation,
  grounding, diversity, cost, and section-capacity tests remain unchanged.

### Verification ladder

Run focused adapter and migration tests first, then:

1. type checking;
2. the full non-Worker test suite;
3. the full Worker/D1 suite;
4. the research golden-set evaluator;
5. the production build;
6. diff checking; and
7. safety scans for trusted HTML, structural-field text normalization,
   credential leakage, and unreviewed outbound hosts.

## Rollout and acceptance

Implementation ends with a reviewed pull request. It does not deploy, mutate a
shared database, or start a paid briefing.

After merge, preview deployment is a separate user-authorized operation. Before
another paid canary, confirm budget headroom: after the `2026-08-12` canary, the
preview UI estimated monthly spend at `$4.44` against a `$5.00` cap.

The first authorized preview review should inspect source diagnostics before
starting a model-backed run. A later canary succeeds operationally when:

- repaired source lanes no longer fail for known endpoint or parser drift;
- healthy-empty, unroutable, and broken-source states are distinguishable;
- at least one genuinely relevant non-arXiv fixture or live observation reaches
  triage when such content is available;
- no weak item is admitted merely to prove non-arXiv coverage;
- primary-source and grounding controls remain effective; and
- run cost and monthly budget stay within the separately approved bounds.

Production promotion remains a separate decision.

## References

- [Papers with Code recent papers](https://paperswithcode.co/papers/recent)
- [AI Alignment Forum](https://www.alignmentforum.org/)
- [LessWrong RSS feed behavior](https://www.lesswrong.com/posts/dzF8vSdDtmWjCBBDr/secrets-of-the-lesswrong-rss-feed)
- [Anthropic Research](https://www.anthropic.com/research)
- [Google DeepMind blog](https://deepmind.google/blog/)
- [Google Research blog](https://research.google/blog/)
- [OpenAI Research index](https://openai.com/research/index/publication/)
- [OpenAI RSS](https://openai.com/news/rss.xml)
