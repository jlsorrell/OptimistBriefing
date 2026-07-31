# Source health runbook

The application has no dedicated source-health endpoint and no single-source
probe API. Use the authenticated source catalog, run details, Wrangler
invocation logs, and audited database state. Do not claim that a discovery
service's HTTP status page proves an individual feed or page works.

## Triage

1. Open `/run-status` and identify the affected edition/run.
2. In the authenticated browser, inspect:

   - `GET /api/runs`
   - `GET /api/runs/<run-id>`
   - `GET /api/sources`

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
