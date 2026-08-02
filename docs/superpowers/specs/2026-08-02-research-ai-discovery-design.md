# Research and AI Discovery Upgrade Design

## 1. Objective

Improve the daily briefing's research and AI coverage without weakening its
editorial standards. The system will discover relevant work from multiple
independent sources, rank the complete candidate pool before spending money on
deep assessment, revisit promising work as new evidence appears, and classify
official-lab publications by substance rather than publisher.

The publication quality floor remains unchanged. Better discovery may produce
more candidates, but it must not cause weak, irrelevant, or poorly grounded
material to be published.

## 2. Scope

This upgrade covers:

- research-paper discovery beyond a single broad arXiv query;
- official university and laboratory research publications;
- Alignment Forum and LessWrong research commentary;
- PapersWithCode.co discovery and implementation metadata;
- content-based routing of official-lab posts into Research, Technology, or AI
  Policy;
- ranking before model-based technical assessment;
- a 36-hour fresh-content scan plus a seven-day reconsideration scan;
- source-level failure isolation, diagnostics, caching, and regression tests;
  and
- improved AI-news discovery from existing official, primary, and preferred
  reporting sources.

This upgrade does not add an unrestricted general-web search dependency, change
the reader's approved research topics, increase the published section maxima,
or relax summary grounding and edition publication rules.

## 3. Editorial Principles

1. **Substance over prestige.** Preferred institutions and labs contribute a
   bounded research-signal boost. They are neither a discovery filter nor a
   substitute for topical fit or technical quality.
2. **Discovery is not evidence.** Alignment Forum, LessWrong, and
   PapersWithCode.co may surface work and provide attention, commentary, code,
   or benchmark signals. They do not validate a paper's claims.
3. **Publisher does not determine section.** An official-lab post about a
   technical result belongs in Research; a product or capability release
   belongs in Technology; a governance, standards, evaluation-policy, or legal
   development belongs in AI Policy.
4. **Primary material anchors claims.** Paper claims are grounded in the paper,
   abstract, or other explicitly identified access level. News claims remain
   grounded in primary documents or corroborating reporting.
5. **Quality floors do not degrade.** Source failure, sparse mornings, and
   budget pressure may reduce coverage or prevent publication. They never
   manufacture filler.
6. **Ranking is explainable.** Stored candidate and selection records retain
   the components and human-readable reasons that affected selection.

## 4. Discovery Architecture

Discovery uses independent lanes. Each lane returns normalized source records
and sanitized source outcomes through the existing fail-open settlement model.

### 4.1 Paper lanes

#### Targeted arXiv lanes

Replace the single broad category query with three topic-aligned queries, one
for each reader-profile topic family:

- alignment, safety, interpretability, internal representations, emergence,
  scaling, capability elicitation, debate, and multi-agent behavior;
- cryptographic oversight, verification of training or inference, provenance,
  and secure evaluation; and
- FHE, MPC, ZKP, and functional encryption applied to machine learning.

Every query remains constrained to relevant arXiv categories. Results are
sorted by last update so materially revised older papers can enter the fresh
window.

#### Semantic Scholar discovery

Semantic Scholar becomes both a discovery source and an enricher. Discovery
uses:

- recent paper search for the three topic families; and
- recommendations from a small, versioned set of positive seed papers.

The recommendation endpoint supports recent or all-computer-science candidate
pools and bounded result limits. Seed changes are reviewed in code so discovery
behavior is reproducible. See the
[Semantic Scholar Recommendations API](https://api.semanticscholar.org/api-docs/recommendations).

#### OpenAlex discovery

OpenAlex becomes both a discovery source and an enricher. It supplies recent
works matching configured topic text and works associated with preferred
institutions or labs. Institution matches affect the research-signal component
only after topical relevance is established.

### 4.2 Publication and commentary lanes

The existing catalog entries for Stanford, UC Berkeley, Harvard, MIT, Carnegie
Mellon, Penn, Johns Hopkins, UT Austin, Georgia Tech, Google Research, Google
DeepMind, Anthropic, and OpenAI become active discovery sources.

Alignment Forum and LessWrong are added as enabled, explicitly labeled blog
sources. Their posts can:

- enter Research when they present a substantive original result;
- attach to an identified paper as commentary;
- raise a bounded serious-attention signal; or
- remain unselected when they are off-topic, unsupported, or below quality
  thresholds.

PapersWithCode.co is added as a page-based discovery and enrichment source. It
may contribute paper identifiers, code repositories, tasks, datasets,
benchmarks, and reported results. Because the `.co` site is a newer revival, its
metadata is treated as a lead and must be joined to an arXiv ID, DOI, or
conservatively matched paper before it affects ranking. See
[PapersWithCode.co](https://paperswithcode.co/?order_by=date_published).

### 4.3 AI-news lanes

AI-news discovery continues to use official company publications, government
and legislative sources, preferred neutral reporting, and cataloged technology
feeds. Official-lab publications are no longer discarded merely because their
catalog role is `blog`.

Section eligibility remains a ceiling on where a source may appear, not proof
that each item belongs there. Item-level signals derived from the title,
description, accessible text, paper identifiers, named entities, and event
families determine the final route.

## 5. Publication Routing

A shared publication adapter collects RSS and configured listing pages from
catalog sources whose role is `blog`. It produces a publication candidate before
the candidate is assigned a research or news contract.

Routing applies these rules in order:

1. A publication with an arXiv ID, DOI, explicit paper link, or substantive
   study/method/result framing routes to Research when its semantic topical fit
   clears the research prefilter.
2. A publication with legislation, regulation, governance, standards,
   oversight, official evaluation-policy, or enforcement signals routes to AI
   Policy when that section is allowed by the source catalog.
3. A publication describing a product, model, capability, deployment, code
   release, or benchmark release routes to Technology when that section is
   allowed.
4. An ambiguous official-lab publication defaults to Technology rather than
   Research. It may still be excluded later for low personal relevance.
5. Independent commentary that identifies a paper is linked to that paper. It
   does not create a duplicate featured item about the same result.

Routing is deterministic from retrieved evidence. It does not use model memory
or infer an unavailable paper.

## 6. Candidate Windows and Reconsideration

Every run performs two scans:

- **Fresh scan:** material published or materially updated during the previous
  36 hours.
- **Reconsideration scan:** material from the previous seven days that gained a
  new qualifying signal.

Qualifying reconsideration signals are:

- a new paper version or changed source content fingerprint;
- a newly discovered code repository or PapersWithCode.co mapping;
- newly discovered official or independent commentary linked to the work; or
- changed bibliographic or attention metadata.

Unchanged candidates reuse their stored discovery and assessment artifacts.
They do not consume another model assessment merely because they remain inside
the seven-day window. Cache identity uses the canonical paper identity plus a
content-and-evidence fingerprint, not the discovery source that happened to
find it.

## 7. Candidate Flow and Budgets

### 7.1 Bounded collection

Adapters enforce request pagination and per-source result limits. The merged
research discovery pool has a hard maximum of 500 pre-deduplication candidates
per run. Each discovery family receives a reservation before unused capacity is
filled by the strongest remaining candidates, preventing arXiv volume from
crowding out official publications, commentary, or bibliographic discovery.

The reservation families are:

- arXiv;
- Semantic Scholar and OpenAlex;
- official university and laboratory publications; and
- Alignment Forum, LessWrong, and PapersWithCode.co.

### 7.2 Normalize and deduplicate

Candidates are joined in this order:

1. normalized arXiv identifier;
2. normalized DOI;
3. provider identifiers associated with the same arXiv ID or DOI;
4. canonical URL; and
5. conservative normalized-title matching when author overlap or an explicit
   paper link provides additional evidence.

Commentary remains a distinct source record attached to the paper. It is not
merged into the paper's primary text or allowed to change the paper's access
level.

### 7.3 Cheap relevance triage

The system embeds the complete normalized candidate pool in bounded batches and
computes scalar topical fit or personal relevance before assigning the
assessment budget. Research embeddings are transient: after topical similarity
is calculated, vectors are not persisted with research candidates.

Triage removes candidates that fail minimum content, date, policy, section, or
semantic relevance rules. It then creates a diverse assessment queue of at most
24 research candidates. When qualified candidates exist, the queue reserves
space across the three configured research topic families and across discovery
families, then fills remaining capacity by relevance, recency, and bounded
source/institution priors.

No single discovery family may occupy more than half of the 24-candidate
assessment queue. No single publisher domain may occupy more than one quarter.
Unused reservations are released so sparse lanes do not leave artificial empty
slots.

### 7.4 Deep assessment and shortlist

Only the triaged research queue receives model-based technical-quality,
novelty, and limitations assessment. Existing research scoring weights and
minimum topical-fit and technical-quality gates remain unchanged.

The published maxima remain three featured research items and six research
radar items. Budget degradation continues to remove optional radar depth before
featured quality.

## 8. Research and Commentary Signals

PapersWithCode.co and linked code repositories may contribute an implementation
availability signal. The signal indicates that an implementation was found; it
does not establish correctness, reproducibility, or benchmark validity.

Alignment Forum and LessWrong may contribute a bounded serious-attention signal
when a post is clearly linked to the paper and contains substantive discussion.
Popularity, votes, or comment volume alone do not increase technical quality.

Preferred institution and lab matches remain inside the existing 15% research
signal component. Commentary, code, and attention signals cannot compensate for
failure of the topical-fit or technical-quality gates.

Selection reasons may include:

- strong match to a configured research topic;
- preferred institution or laboratory;
- full paper text available;
- material revision during the fresh window;
- independent implementation located;
- substantive expert commentary located; and
- renewed evidence during the seven-day reconsideration window.

## 9. Persistence and Observability

The system persists bounded discovery observations separately from editorial
items. Each observation records:

- canonical candidate identity;
- discovery source and discovery family;
- source publication and retrieval timestamps;
- content and evidence fingerprints;
- joined external identifiers;
- routing result;
- whether the candidate was fresh or reconsidered; and
- the latest sanitized source outcome.

Run diagnostics record, per lane:

- candidates discovered;
- candidates retained after deduplication;
- candidates retained after relevance triage;
- candidates sent to deep assessment; and
- source success or sanitized failure category.

Diagnostics do not retain fetched article bodies, provider error payloads,
credentials, or unrestricted URLs. Existing privacy and retention policies
continue to govern stored evidence.

## 10. Failure and Cost Behavior

- Each discovery adapter and optional enricher settles independently.
- A failed lane contributes no new candidates but cannot erase candidates from
  healthy lanes or cached unchanged work.
- A malformed or unpinned outbound URL fails as a policy error before fetch.
- API throttling and transient fetch failures use the existing bounded retry
  behavior and appear in source health diagnostics.
- Collection and embedding calls are capped before execution.
- Deep assessment is capped at 24 research candidates and remains subject to the
  existing monthly model-budget gate.
- Hard-stop budget state may reuse already valid cached assessments but cannot
  initiate new paid assessments.
- Sparse or failed discovery never lowers publication thresholds. Existing
  coverage rules decide whether the run publishes, remains partial, is
  retryable, or fails.

## 11. Testing Strategy

Unit and integration fixtures cover:

1. targeted arXiv query construction, pagination, and revision windows;
2. Semantic Scholar search and recommendation discovery;
3. OpenAlex topic, date, and institution discovery;
4. official-blog RSS and listing-page parsing;
5. Alignment Forum, LessWrong, and PapersWithCode.co parsing;
6. strict outbound URL policies for every new adapter;
7. arXiv, DOI, provider-ID, canonical-URL, and conservative-title joins;
8. commentary attachment without paper-text or access-level contamination;
9. content-based routing among Research, Technology, and AI Policy;
10. complete-pool relevance triage before deep assessment;
11. assessment-queue size, topic reservations, discovery-family cap, and
    publisher-domain cap;
12. transient research embeddings and bounded checkpoint sizes;
13. 36-hour fresh discovery and seven-day signal-based reconsideration;
14. cache reuse for unchanged candidate fingerprints;
15. independent lane failure and source-health reporting;
16. commentary and implementation signals never validating factual claims;
17. prestigious but irrelevant and topical but technically weak papers failing
    the appropriate gates; and
18. the unchanged edition publication quality floor.

A versioned golden set includes relevant high-quality papers, prestigious but
irrelevant papers, low-quality topical papers, official research releases,
product announcements, policy announcements, independent commentary,
cross-source duplicates, and noisy AI headlines. Expected rankings favor
substance over prestige, popularity, or publication volume.

## 12. Rollout and Acceptance

The upgrade ships behind catalog enablement and is exercised first against the
isolated preview environment. A preview canary is acceptable when:

- at least two independent research discovery families succeed;
- relevant candidates from non-arXiv sources reach relevance triage;
- no research candidate reaches deep assessment solely because of arrival
  order;
- official-lab fixtures route to all three intended sections correctly;
- duplicate papers discovered through multiple lanes become one paper with
  attached source context;
- research checkpoint sizes remain within D1 limits;
- model usage remains inside the configured monthly cap; and
- the existing publication quality floor behaves identically on sparse input.

General web search remains a possible later fallback for specific catalog sites
that cannot be monitored reliably through APIs, feeds, or stable listing pages.
It is not part of this implementation.
