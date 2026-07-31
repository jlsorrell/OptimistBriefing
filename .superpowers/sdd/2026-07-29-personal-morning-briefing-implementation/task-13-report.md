# Task 13 report

## Status

Repository-local implementation and fresh verification complete; independent
review pending. No external action has been performed.

## Configuration correction

The implementation plan's illustrative `MONTHLY_AI_BUDGET_USD` name is stale.
The runtime contract is `MONTHLY_BUDGET_USD`, bounded to at most 30, plus
`SUMMARY_UNIT_PRICE_USD`, `ASSESSMENT_UNIT_PRICE_USD`, and
`EMBEDDING_UNIT_PRICE_USD`.

## Repository changes

- Added a blank, secret-safe `.dev.vars.example`.
- Added operator/developer overview and local commands in `README.md`.
- Added deployment, source health, failed-edition, cost-control, and
  privacy/retention runbooks.
- Added production Worker entry point and static asset configuration to
  `wrangler.jsonc`; no route, real resource ID, model, price, email, OAuth value,
  account ID, or secret was added.
- Added bounded deletion and reporting for 90-day artifact-bearing Workflow
  audit events after the launch audit exposed a retention gap.

## Plan-versus-runtime findings

- This Wrangler CLI has no separate `workflows create` command. The declared
  Workflow is provisioned/updated during an approved deployment.
- There is no restore, publish, or dedicated source-health API.
- There is no draft-only live-source mode. An admin run can incur model cost and
  publish into its database.
- A failed/unpublished draft preserves the prior visible edition. A published
  partial becomes latest; recovery must use resume, a Worker rollback, or a
  separately approved D1 recovery rather than an invented API.
- Launch audit found that checkpoint/attempt audit events originally outlived
  90-day `workflow_runs`. The approved narrow fix now counts and deletes
  `workflow_checkpoint`, `workflow_attempt`, and `workflow_attempt_failed`
  events at the 90-day cutoff, including historical NULL-run orphans, while
  preserving model usage and durable source/admin/retention audits.

## Verification evidence

- `npm ci`: exit 0; 388 packages installed from the clean committed lockfile;
  `package-lock.json` unchanged.
- `npm run check`: exit 0.
- `npm test`: 19 files and 333 tests passed.
- `npm run test:worker`: 8 files and 104 tests passed.
- `npm run evaluate`: exit 0; precision@5 1.00, required ordering passed,
  duplicate recall 1.00, zero missing-support claims, grounding expectations
  matched, DMV/Baltimore separation passed.
- `npm run build`: exit 0; 53 modules transformed and production assets emitted.
- `npm run test:e2e`: 39 tests passed across desktop, mobile, and tablet.
- `git diff --check`: exit 0.
- `npx wrangler deploy --dry-run --outdir
  /tmp/optimist-task13-final-worker`: exit 0; four assets found and the
  `DAILY_BRIEFING` Workflow and `DB` D1 bindings resolved. No upload occurred.
- Disposable local D1 state:
  `/tmp/optimist-task13-d1.Q1iaHm`.
  - First `npx wrangler d1 migrations apply optimist-briefing --local
    --persist-to /tmp/optimist-task13-d1.Q1iaHm`: all five migrations applied,
    with 34/2/2/3/2 commands reported successful.
  - Second identical command: `No migrations to apply!`.
- Retention TDD:
  - RED: the focused Worker repository suite failed because
    `deletedWorkflowArtifacts` was absent and old artifact events remained.
  - GREEN: focused repository suite passed 23/23 after the minimal contract and
    D1 change.
- Endpoint audit matched every runbook action to `src/api/app.ts` or
  `src/api/routes/*`; no restore, publish, draft-only, or source-health endpoint
  was claimed.
- CLI audit used local Wrangler 4.115.0 help for deploy/assets, D1
  create/info/migrations/execute/export/Time Travel, secrets, tail, deployments,
  rollback, and Workflow resource/instance commands.

## Commit and review

- Narrow retention launch-blocker commit:
  `f6d7fbd fix: expire workflow artifact audits`.
- Required documentation commit:
  `30f1620 docs: add briefing deployment and operations runbooks`.
- Independent review of `7c7496d..30f1620`: CHANGES REQUIRED.
  - Important: preview D1 was neither migrated nor seeded, and the committed
    local Playwright harness cannot target/authenticate against preview.
  - Minor: source audit query was not attributable to the changed source/state.
- Review round 1 response:
  - added exact preview-config migration and fixed-fixture seed commands;
  - documented that the current local Playwright harness cannot test preview
    and blocks production approval until a separately reviewed preview harness
    exists and passes;
  - narrowed the source audit query to source ID, actor, enabled change, and
    timestamp.

## Remaining concerns

- `wrangler.jsonc` intentionally retains the all-zero local D1 ID and no custom
  domain route; a real ID must be resolved only at the approved resource
  checkpoint.
- The ledger uses one conservative per-unit price for each model. Current model
  identifiers and prices must be verified immediately before live use.
- There is no draft-only live-source rehearsal. Any approved preview run must
  use isolated resources and can incur cost and publish into its preview D1.
- Preview browser automation is not yet implemented. Local 39/39 browser
  evidence does not substitute for an Access-protected preview run; production
  approval remains blocked on that separate change.

## External actions deliberately not performed

- Cloudflare account/zone/resource creation
- GoDaddy or DNS changes
- Google OAuth or Cloudflare Access configuration
- remote secret or variable changes
- remote migrations or D1 queries
- preview/production deploys or custom-domain attachment
- live source/model calls
- Workflow instance mutation
- D1 Time Travel or other destructive recovery
