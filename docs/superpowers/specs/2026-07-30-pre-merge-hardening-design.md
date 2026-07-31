# Pre-Merge Hardening Design

**Date:** 2026-07-30
**Status:** Approved for planning
**Scope:** Resolve the release-blocking and Important findings from the first
whole-branch review of the private morning briefing.

## 1. Goals

Before the first production deployment, the application must:

- keep copyrighted article bodies out of all durable storage;
- validate every generated claim against evidence from the source it cites;
- continue collecting when individual sources fail and report those failures;
- route manual controls through the durable Cloudflare Workflow;
- retry transient minimum-coverage failures from fresh collection;
- prevent new paid model calls once the configured monthly budget is exhausted;
- apply a stable reader-preference snapshot during each editorial run;
- retain the actual reasons an item was selected;
- make the committed deployment command preserve dashboard-managed variables;
  and
- exercise Worker integration tests with the production compatibility date.

This work preserves the approved Worker, Workflow, D1, React, and provider
architecture. It does not deploy resources, change DNS, configure Access, run
remote migrations, or call paid model APIs.

## 2. Durable Content Boundary

Collectors may process a fetched article body only inside the collection
operation. Before a collected candidate crosses a checkpoint or repository
boundary, content marked `ephemeral-only` is converted into a bounded evidence
excerpt and the full body is discarded.

The durable representation contains:

- source ID, canonical URL, title, role, access level, and retrieval time;
- a bounded excerpt sufficient for relevance, event extraction, synthesis, and
  claim validation;
- explicit metadata identifying the text as an evidence excerpt; and
- no full article body or hidden copy of that body in workflow metadata,
  normalized JSON, audit events, or checkpoint artifacts.

The excerpt bound is enforced by a shared pure function so the collection
checkpoint, normalization path, and D1 persistence cannot disagree. Open-access
paper content remains governed by its existing license-aware path.

Every newly normalized candidate receives an expiry 90 days after `createdAt`
unless an earlier valid expiry is supplied. Existing retention pruning continues
to preserve items referenced by an edition, save, feedback record, summary, or
claim.

## 3. Source-Specific Grounding

A clustered news development retains its original items. Synthesis builds one
source document per original item rather than assigning an aggregate cluster
body to every source reference.

Each source document carries its own:

- stable source ID;
- title and URL;
- role and access level;
- retrieval time; and
- bounded evidence excerpt.

Multiple items from the same source may be combined only within that source,
with deterministic excerpt numbering. Cluster-level title and routing metadata
remain separate from source evidence.

Validation continues to reject unknown source IDs and additionally proves that
the exact cited evidence occurs in the cited source document. An adversarial
test will place a fact in only one source and verify that citing another source
is rejected.

## 4. Fail-Open Collection and Source Health

Source adapters isolate failures per enabled source with bounded settlement.
One malformed, unavailable, or timed-out source does not reject successful
results from other sources.

Failures are represented by sanitized source IDs and bounded failure kinds; raw
URLs, response bodies, credentials, and provider error messages are not exposed.
Production collection accumulates failures in the current run context, updates
source health through the repository, and includes the sanitized IDs in edition
metadata.

Research discovery and enrichment degrade independently:

- a failed discovery adapter contributes no candidates but does not erase
  successful discovery results;
- a failed optional enricher leaves the last valid candidate representation in
  place; and
- the run proceeds when the remaining candidates can satisfy coverage.

If remaining candidates cannot satisfy the minimum, normal coverage handling
determines whether the run is partial or retryable.

## 5. Durable Manual Controls and Recovery

The authenticated manual-start endpoint creates a `DAILY_BRIEFING` Workflow
instance and returns `202` without running the editorial pipeline inside the
HTTP request. The edition date is the stable Workflow instance ID and the run ID
is carried in Workflow parameters.

Creation is guarded by the existing edition-date uniqueness rule. A concurrent
manual or scheduled request observes the existing run or Workflow instance
instead of starting a second paid pipeline.

Manual resume:

- requires a failed, partial, or retryable D1 run with `retryable: true`;
- obtains the existing Workflow instance;
- resumes a paused instance, restarts a terminal instance, or recreates only an
  unknown instance; and
- returns without executing the pipeline inline.

A minimum-coverage failure is recoverable. It is stored with
`retryable: true`, and the next attempt invalidates checkpoints from `collect`
so new source material can repair the missing section. Published runs remain
terminal and idempotent.

## 6. Budget Enforcement

The monthly D1 usage ledger remains the source of truth. Budget policy is
evaluated immediately before every paid provider request rather than captured
once at Workflow startup.

Calls within a run are sequenced at each paid stage. Before a request, the
runtime atomically reserves a conservative maximum charge in D1 using the
configured unit price and the request token ceiling. The reservation succeeds
only when current spend plus outstanding reservations stays within the monthly
limit.

After the provider returns:

- the reservation is reconciled to actual recorded usage;
- unused reserved value is released; and
- provider failures release the reservation while recording no fabricated
  usage.

If a reservation cannot be made, the pipeline performs no new paid call. It
records a bounded `BUDGET_HARD_STOP` failure and leaves the run retryable rather
than silently exceeding the cap or publishing ungrounded fallback text.

The existing 70% warning and 90% degraded behavior remains. Radar count and
depth are reduced before featured content. The hard limit applies to all new
paid calls, not only optional radar summaries.

## 7. Preference Snapshot and Selection Reasons

At the beginning of a new collection attempt, the Workflow reads current reader
preferences and stores a bounded preference snapshot with the run. All
subsequent ranking and shortlisting checkpoints use that snapshot, so a
mid-run preference edit cannot make a single edition internally inconsistent.

The snapshot adjusts only the controls already exposed by the application:

- topic and section emphasis;
- source enablement where applicable;
- reading-depth or section-budget preferences; and
- feedback-derived boosts or suppressions already represented by repository
  contracts.

Default values remain those in `READER_PROFILE`. Invalid or absent optional
preferences fail open to those defaults.

Composition copies the calculated `selectionReasons` from the shortlisted item
into the final edition entry. The generic fallback is used only when no
calculated reason exists.

## 8. Deployment and Compatibility Safety

The committed production deployment script invokes Wrangler with
`--keep-vars`, matching the reviewed deployment runbook and protecting
dashboard-managed configuration.

The Worker integration test configuration uses the same compatibility date as
`wrangler.jsonc`. A regression test or configuration assertion prevents the two
dates from drifting silently.

## 9. Testing Strategy

Every behavior change follows red-green-refactor:

1. add one focused regression test and observe the expected failure;
2. implement the smallest production change;
3. observe the focused test pass; and
4. run the related test group before committing.

Required negative coverage includes:

- a sentinel article-body tail absent from collect checkpoint JSON and
  `items.normalized_json`, with only the bounded evidence excerpt present;
- a default 90-day candidate expiry and preservation of referenced items;
- a clustered claim rejected when it cites a source that does not contain its
  evidence;
- one failed feed with sufficient remaining research, nonlocal, and local
  coverage;
- concurrent manual and scheduled starts producing one Workflow instance;
- recovery from failed minimum coverage beginning again at `collect`;
- a provider request refused when its reservation would exceed the hard cap;
- preference changes affecting the next run but not an in-progress run;
- final edition entries retaining calculated selection reasons;
- the safe deployment flag; and
- compatibility-date parity.

After the task-level review loop is clean, the complete branch gate is:

- TypeScript check;
- full unit suite;
- Worker integration suite;
- golden evaluation;
- production build;
- Playwright end-to-end suite;
- `git diff --check`;
- secret and durable-body leakage scans; and
- an independent whole-branch review.

The draft pull request remains a draft until both Critical findings and all
confirmed Important findings are resolved. Production deployment remains a
separate, explicitly approved operation.

## 10. Implementation Sequence

The work is divided into independently reviewable tranches:

1. durable content boundary and 90-day candidate expiry;
2. source-specific synthesis packets and adversarial grounding validation;
3. fail-open collection and source-health reporting;
4. durable manual controls and minimum-coverage recovery;
5. live budget reservation and enforcement;
6. preference snapshots and selection reasons;
7. deploy-variable and compatibility-date safeguards; and
8. whole-branch verification and review.

Each tranche receives a focused implementation commit and independent review
before the next tranche begins.
