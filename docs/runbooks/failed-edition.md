# Failed edition and recovery runbook

The pipeline checkpoints are idempotent and persisted in both Workflow state
and D1. Resume skips completed checkpoints and reuses stored artifacts.
Artifact-bearing checkpoint and attempt events expire after 90 days. Edition
date and run ID prevent duplicate daily runs and entries.

## Diagnose

1. Confirm the previous published edition remains visible.
2. Open `/run-status`, then inspect authenticated
   `GET /api/runs/<run-id>`.
3. Record status, retryable flag, current checkpoint, attempts, failure code,
   source failures, rejected-summary reasons, publish time, and estimated cost.
4. Inspect Workflow state and errors:

   ```sh
   npx wrangler workflows instances describe daily-briefing "$OPTIMIST_RUN_ID"
   npx wrangler tail optimist-briefing --format pretty --status error
   ```

`OPTIMIST_RUN_ID` is a template variable. Resolve it from `/api/runs` and verify
it before use.

## Retry or resume

The application exposes these authenticated endpoints:

- `POST /api/admin/runs` with `{ "editionDate": "YYYY-MM-DD" }`
- `POST /api/admin/runs/:runId/resume`

Starting an edition that already has a run returns
`409 RUN_ALREADY_EXISTS`. Resume is accepted only for a retryable failed or
partial run; otherwise it returns a validation error.

From the authenticated application's browser console:

```js
await fetch("/api/admin/runs/REPLACE_WITH_RUN_ID/resume", {
  method: "POST",
});
```

This is a template. Replace and verify the run ID and production origin. Resume
may make paid model calls. Check the cost state before triggering it.

If the D1 run is retryable but the Workflow instance needs operator action,
inspect it first and use only the action appropriate to its current state:

```sh
npx wrangler workflows instances resume daily-briefing "$OPTIMIST_RUN_ID"
npx wrangler workflows instances restart daily-briefing "$OPTIMIST_RUN_ID"
```

Do not run both blindly. The scheduled coordinator also resumes/restarts
retryable instances during its valid morning window.

## Publication behavior

- A draft is never visible.
- `published` and `partial` editions are visible.
- `partial` is allowed only when the pipeline retains at least one research
  item, one nonlocal news item, and one DMV/Baltimore item.
- A failed or insufficient draft remains unpublished, so the prior visible
  edition is preserved.
- A successfully published partial edition becomes the latest visible edition;
  there is no unpublish, restore, or publish API.
- Model/validation failures omit invalid items rather than publishing malformed
  summaries.

## Recovery paths

### Source or model transient failure

Fix or wait for the upstream issue, verify budget headroom, then resume the
existing retryable run. Do not create a second run for the same date.

### Worker code/config regression

Resolve the last known-good version:

```sh
npx wrangler deployments list --name optimist-briefing
```

After explicit rollback approval:

```sh
npx wrangler rollback "$OPTIMIST_KNOWN_GOOD_VERSION_ID" --name optimist-briefing
```

Worker rollback does not reverse database migrations or data.

### Incorrect partial edition

There is no safe application endpoint to make an older edition latest. Preserve
evidence, stop additional runs, and decide between:

- correcting the current run/data with a reviewed application change; or
- a D1 Time Travel restore when the database as a whole must be returned to an
  earlier point.

Do not directly change edition status with ad hoc SQL.

### D1 corruption or destructive data error

D1 Time Travel affects the remote database and is a destructive recovery
action. Obtain separate explicit approval. Before restoring:

1. stop schedules or otherwise prevent writes through an approved deployment
   change;
2. identify the exact last known-good timestamp;
3. inspect available Time Travel information:

   ```sh
   npx wrangler d1 time-travel info optimist-briefing --timestamp "$OPTIMIST_RECOVERY_TIMESTAMP"
   ```

4. export the current database:

   ```sh
   npx wrangler d1 export optimist-briefing --remote --output "$OPTIMIST_PREFLIGHT_EXPORT"
   ```

5. verify the export exists, is protected, and is outside the repository;
6. have a second person/operator review the target and consequences.

Only then, after approval, use:

```sh
npx wrangler d1 time-travel restore optimist-briefing --timestamp "$OPTIMIST_RECOVERY_TIMESTAMP"
```

All variables are templates and must be resolved and checked. After restoration,
reapply compatible migrations if needed, redeploy a compatible known-good
Worker, verify Access, inspect editions/runs, and re-enable schedules.

## Closeout

Record the failure cause, resumed checkpoints, model cost, publication result,
source changes, code/deployment version, recovery actions, and whether the next
scheduled run succeeded by 6:00 a.m. Eastern.
