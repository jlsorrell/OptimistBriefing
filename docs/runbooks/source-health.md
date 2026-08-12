# Source health runbook

The application has no dedicated source-health endpoint and no single-source
probe API. Use the authenticated source catalog, run details, Wrangler
invocation logs, and audited database state. Do not claim that a discovery
service's HTTP status page proves an individual feed or page works.

## Research discovery lanes

Every research lane belongs to one of four diagnostic families:

- `arxiv`: the three targeted arXiv topic queries;
- `bibliographic`: Semantic Scholar search/recommendations and OpenAlex topic
  and institution queries;
- `official-publication`: cataloged university and laboratory feeds or listing
  pages, plus metadata indexes such as Papers with Code; and
- `commentary`: Alignment Forum, LessWrong Curated, and LessWrong Frontpage.

The authenticated source catalog is the operational control plane. `enabled`
turns collection on or off; `discoveryMechanism` selects API, RSS, or page
collection; `sectionEligibility` is only a routing ceiling; and
`bodyRetrieval`, `contentUse`, `paywall`, `canCorroborateFacts`, and the pinned
host/port/path feed and article URL policies constrain retrieval and evidence
use. Do not treat a
catalog role, institution, publisher, or section eligibility as item-level
proof of relevance or section placement. Apply source changes through the
audited source endpoint described below, not by editing remote D1 directly.

## Exact failure and cache semantics

Discovery adapters and optional enrichers settle independently. A failed lane
contributes zero new candidates. It does not erase candidates from healthy
lanes, cached unchanged candidates, or valid cached assessments. An unpinned or
malformed outbound URL is a `policy` failure before fetch. API throttling and
transient fetch errors use bounded retries and finish with the sanitized
`fetch`, `parse`, `policy`, `timeout`, `unsupported_media`, or `unknown`
outcome. These are fail-open collection semantics only: failures never lower
topical, technical-quality, grounding, coverage, or publication thresholds and
never authorize filler.

OpenAlex uses the optional encrypted `OPENALEX_API_KEY`. When the binding is
unset and an adapter has no credential, that lane records a sanitized `policy`
failure. A blank configured binding is invalid runtime configuration; it is not
equivalent to omission and does not become a lane-level failure. HTTP `401`,
`403`, and quota `429` responses settle as sanitized `fetch` outcomes. OpenAlex
requests use no unauthenticated fallback, pagination, or retry for these
credential outcomes. In every lane-level failure, other research collectors
still settle independently, so credential trouble cannot abort healthy arXiv,
publication, or commentary lanes.

Each run scans a 36-hour fresh window and a rolling seven-day reconsideration
window. Work older than 36 hours is reconsidered only when its content or
evidence fingerprint changes, for example a revision, new code mapping, linked
commentary, or changed bibliographic evidence. Cache identity is canonical
paper identity plus the content/evidence fingerprint; a different discovery
source alone does not invalidate it. Unchanged work reuses stored discovery
and assessment artifacts. When investigating stale results, compare both
fingerprints and invalidate only the affected canonical entry; never flush the
entire cache merely because one lane changed.

Relevance triage admits at most 24 candidates, with at most 12 from one family
and six from one publisher domain. Deep-assessment calls are capped at 24 in
normal budget state, four in degraded state, and zero in hard-stop state.
Hard-stop may reuse a valid cached assessment but must not start a paid call.

For every lane, run detail records `discovered`, `deduplicated`, `triaged`, and
`assessed` counts plus the sanitized outcome. Reviewed feed and page lanes also
record optional `observed`: the bounded number of structurally interpretable,
policy-approved entries before collection-window filtering. A successful lane
with `observed > 0` and `discovered = 0` is healthy but quiet for that window;
a missing `observed` remains valid for historical diagnostics. Counts must be
monotone through the funnel (`observed >= discovered >= deduplicated >= triaged
>= assessed`) whenever `observed` is present. If they are not, preserve the run
ID and escalate as a diagnostics defect; do not infer missing bodies or
provider responses from the count mismatch.

Run Status also reports bounded aggregate rejection counts using exactly these
fixed reasons:

- `out_of_window`: the candidate is outside both retained discovery windows;
- `unchanged_observation`: reconsideration found no changed content or evidence;
- `identity_merged`: another upstream identity consolidated into the retained
  item;
- `route_excluded`: normalization could not route the candidate into an allowed
  lane;
- `topic_mismatch`: deterministic research triage found insufficient topical
  fit;
- `quality_rejected`: content validity or assessment quality rules rejected it;
  and
- `capacity_limited`: a fixed pool, family, domain, queue, assessment, or
  shortlist cap omitted it.

These counts are observational, capped, and safe to display; they do not change
selection decisions or ordering. They explain terminal outcomes without
exposing candidate identities, source text, provider responses, or secrets.

AI Policy routing fails closed: retained title, abstract, or content must
contain both explicit AI evidence and explicit policy-action evidence. Preferred
section metadata, source role, or a general government notice is not enough.
An empty AI Policy section is preferable to unrelated filler. This precision
rule never relaxes because another source or credential fails.

## Triage

1. Open `/run-status` and identify the affected edition/run.
2. In the authenticated browser, inspect:

   - `GET /api/runs`
   - `GET /api/runs/<run-id>`
   - `GET /api/sources`

   In run detail, compare every discovery lane's family, outcome, and
   `discovered`/`deduplicated`/`triaged`/`assessed` counts. A healthy upstream
   with zero retained candidates is not necessarily a failure; routing,
   identity consolidation, relevance triage, and quality gates may legitimately
   remove its candidates.

3. Check the upstream's official status page or API documentation when one
   exists. For RSS/page sources, fetch only the configured URL and check status,
   content type, redirects, rate-limit headers, and whether selectors still
   match. Respect source restrictions and never bypass a paywall.
4. Tail failing Worker invocations:

   ```sh
   npx wrangler tail optimist-briefing --format pretty --status error
   ```

5. Query only operational metadata when deeper inspection is needed:

   ```sh
   npx wrangler d1 execute optimist-briefing --remote --command "SELECT id, canonical_name, enabled, last_success_at, health_status FROM sources ORDER BY id"
   ```

   Remote queries are production reads: confirm account and database first, and
   do not select article bodies, source packets, tokens, or secret-like data.

Correlate upstream evidence with the run's `sourceFailures`; log messages and
public run detail are redacted by design and may not contain a raw URL or packet.

## Disable criteria

Disable a source only when at least one criterion is documented:

- repeated retryable failure across two scheduled attempts;
- persistent non-HTML/schema/feed breakage;
- redirects outside the configured URL policy;
- material terms, licensing, or access-policy change;
- repeated misleading metadata or role misclassification;
- evidence of credential leakage, malicious content, or unsafe retrieval.

A single timeout or upstream maintenance event is normally not enough unless it
creates a security, privacy, or legal risk. For an urgent security or
terms-of-use concern, disable immediately.

## Audited disable procedure

There is no source-specific health mutation route. The existing authenticated
source update endpoint accepts an `enabled` change and records a
`source_updated` audit event.

1. Record source ID, evidence, operator, time, and proposed recovery condition.
2. Capture the current `GET /api/sources` record.
3. In the authenticated application's browser console, use this template only
   after replacing the source ID:

   ```js
   await fetch("/api/sources/REPLACE_WITH_SOURCE_ID", {
     method: "PUT",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ enabled: false }),
   }).then((response) => response.json());
   ```

4. Confirm the response shows `enabled: false`.
5. Confirm `GET /api/sources` reflects the change.
6. Verify the audit record with bounded JSON fields rather than exposing its
   full payload:

   ```sh
   npx wrangler d1 execute optimist-briefing --remote --command "SELECT json_extract(event_json, '$.sourceId') AS source_id, json_extract(event_json, '$.actorEmail') AS actor_email, json_extract(event_json, '$.changes.enabled') AS enabled, created_at FROM audit_events WHERE event_type = 'source_updated' AND json_extract(event_json, '$.sourceId') = 'REPLACE_WITH_SOURCE_ID' ORDER BY created_at DESC LIMIT 20"
   ```

The JavaScript and SQL are templates. Verify the authenticated origin, source
ID, account, and database before execution. Keep the bounded output private
because it contains the operator email. Confirm the newest row has the intended
source ID, actor, and enabled state.

## Re-enable criteria and procedure

Re-enable only after:

- the upstream status/API/feed is healthy;
- the configured URL, schema, selectors, role, and restrictions have been
  reviewed;
- a fixture or isolated preview collection succeeds twice without policy or
  parsing failure; and
- any source-catalog correction has been reviewed.

Use the same audited endpoint with `{ enabled: true }`, then confirm the catalog
and `source_updated` audit event. A live preview collection can incur model cost
and publish in the preview database; obtain approval first. Do not test a
re-enabled source by forcing an unapproved production run.

## Escalation

- If several unrelated sources fail, suspect networking, D1, or deployment
  configuration and use the failed-edition runbook.
- If disabling a source would make minimum partial-edition coverage impossible,
  prefer preservation of the prior edition and an operator review.
- If source restrictions changed, keep the source disabled until the catalog
  restriction record and retrieval implementation agree.
