# Privacy and retention runbook

## Privacy boundary

Cloudflare Access must cover the entire deployed hostname. It uses Google login
with an exact-email allow policy and no `Everyone` or `Bypass` rule. The Worker
then validates the Access JWT's issuer, audience, signature, and normalized
email for every `/api/*` request.

Only `/health` is outside application middleware and returns
`{"status":"ok"}`. When Access covers the full hostname, the edge policy still
applies to that path. Static assets contain no credentials or private briefing
data.

`OPENAI_API_KEY` is an encrypted Worker secret. `ALLOWED_EMAILS` should also be
stored as an encrypted secret because it is personal access-control data. Never
log Access assertions, cookies, OAuth secrets, API keys, source packets, article
bodies, or a populated `.dev.vars`.

## Diagnostic redaction

Public run detail exposes bounded failure labels, checkpoint state, counts, and
estimated cost. It does not expose raw source packets or secrets. Wrangler logs
must use correlation/run IDs and machine-readable error codes rather than full
content.

When investigating:

- tail error status rather than all traffic where possible;
- select explicit metadata columns in D1 queries;
- do not paste `event_json`, tokens, email allowlists, or source text into
  tickets/chat;
- store any necessary export outside the repository with restricted access;
- delete temporary diagnostics when the incident closes.

## Retention contract

| Data | Retention |
| --- | --- |
| Published editions and referenced item metadata | Indefinite until reader deletion |
| Preferences, saves, and feedback | Until explicitly reset/deleted |
| Unselected expired candidates | Deleted after their 90-day expiry |
| `workflow_runs` rows | Deleted after 90 days |
| Workflow checkpoint/attempt audit events | Deleted after 90 days, including historical events whose run link is already NULL |
| High-volume `diagnostic_log` audit events | Deleted after 30 days |
| `model_usage` audit events | Created with 30-day expiry metadata; currently preserved by the pruning query so monthly cost accounting remains intact |
| Retention audit events | Created with 30-day expiry metadata; currently preserved by the pruning query |
| Copyrighted article bodies | Transient processing only; not a private article archive |
| Evidence excerpts | Small, source-linked excerpts associated with summary validation |

The implementation prunes after successful/partial publication. It will not
delete an expired candidate referenced by an edition entry, feedback/save
record, or summary. Summary preservation also protects its claims.

At the 90-day cutoff, the repository counts and deletes
`workflow_checkpoint`, `workflow_attempt`, and `workflow_attempt_failed` events
before deleting the corresponding run rows. This removes artifact-bearing
payloads and also cleans historical NULL-run orphans. It reports the count as
`deletedWorkflowArtifacts` in the retention audit.

The prune query does not generically delete every audit row whose `expires_at`
has elapsed. It preserves model usage, source/admin, and retention audit events
for cost and administrative continuity. Reevaluate those durable classes if
event volume or policy changes.

## Verify retention

Inspect counts, not private payloads:

```sh
npx wrangler d1 execute optimist-briefing --remote --command "SELECT status, COUNT(*) AS count FROM workflow_runs GROUP BY status"
npx wrangler d1 execute optimist-briefing --remote --command "SELECT event_type, COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM audit_events GROUP BY event_type ORDER BY event_type"
npx wrangler d1 execute optimist-briefing --remote --command "SELECT COUNT(*) AS expired_unreferenced_candidates FROM items i WHERE i.expires_at IS NOT NULL AND i.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND NOT EXISTS (SELECT 1 FROM edition_entries e WHERE e.item_id = i.id) AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.item_id = i.id) AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.item_id = i.id)"
```

These are production reads. Confirm account/database and keep their output
private. Check the latest `retention_pruned` audit timestamp after a publication
without selecting its JSON.

## Privacy or retention incident

1. Stop unnecessary runs and preserve run/deployment identifiers.
2. Revoke exposed credentials in their owning control plane after approval.
3. Do not delete audit evidence or D1 data ad hoc.
4. Determine whether static assets, logs, D1, provider requests, or Access
   policy were affected.
5. For a code regression, roll back the Worker.
6. For destructive D1 recovery, follow the separately approved preflight in the
   failed-edition runbook.
7. Record scope, exposure window, remediation, credential rotation, retention
   impact, and verification evidence.

Deleting reader data, feedback, saves, or a published edition is not currently
exposed as an application endpoint. It requires a separately designed and
approved operation; do not improvise deletion SQL.
