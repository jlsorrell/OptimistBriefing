# Cost-control runbook

The application rejects a monthly budget above `$30` and refuses unbudgeted
models. Every recorded provider call includes provider, model, input tokens,
output tokens, embedding count, configured unit price, and estimated cost.

## Verify prices before live use

Immediately before the first live run and after any provider/model price change:

1. verify each configured model identifier still exists and supports its
   operation;
2. verify current prices from the provider's primary documentation;
3. convert per-million-token prices to dollars per token;
4. because the ledger uses one price per model, configure the more expensive
   applicable input/output token rate;
5. record the price URL, effective date, conversion, and reviewer;
6. verify all three `*_UNIT_PRICE_USD` bindings and
   `MONTHLY_BUDGET_USD`;
7. run deterministic tests before deployment.

Do not copy the blank examples as prices. A missing, zero, negative, or
unconfigured model price is intentionally rejected.

## Inspect usage and audit state

Use `/run-status`, authenticated `GET /api/runs`, and
`GET /api/runs/<run-id>` for public operational state. For an audited aggregate:

```sh
npx wrangler d1 execute optimist-briefing --remote --command "SELECT ROUND(COALESCE(SUM(estimated_cost_usd), 0), 6) AS recorded_run_cost_usd FROM workflow_runs WHERE created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')"
```

Confirm account and database first. The per-call records are stored as
`model_usage` audit events; do not print full event JSON into shared logs.

Provider billing remains the authority for actual charges. Reconcile the D1
estimate with the provider dashboard at least weekly and after any incident.

## Threshold actions

| Spend | Runtime state | Operator action |
| --- | --- | --- |
| Below 70% | `normal` | Monitor weekly; keep current section budgets |
| 70% through below 90% | `warning` | Review run volume, retries, prices, and usage daily; defer optional manual runs |
| 90% through below 100% | `degraded` | Runtime shortens and reduces research radar while retaining featured summaries; do not trigger nonessential runs |
| 100% or more | `hard_stop` | Runtime removes optional radar generation and must not make unbudgeted calls; initiate emergency stop review |

The thresholds are calculated from recorded monthly estimated spend divided by
the configured monthly limit. A low configured limit can trigger them before
`$30`.

## Emergency hard stop

If actual/provider spend is at or above the limit, prices are misconfigured, or
usage is unexplained:

1. do not trigger or resume a run;
2. record current Workflow/run state and provider usage;
3. pause the active Workflow instance only after resolving its ID:

   ```sh
   npx wrangler workflows instances pause daily-briefing "$OPTIMIST_RUN_ID"
   ```

4. if necessary, revoke or disable the model API key in the provider control
   plane; this is an external action requiring explicit approval;
5. do not raise `MONTHLY_BUDGET_USD` above `30` or weaken validation;
6. reconcile D1 events, Workflow attempts, and provider billing;
7. correct prices/configuration through the normal reviewed deployment path;
8. resume only after the projected remaining cost fits the approved budget.

Pausing one instance does not disable future cron triggers. A complete schedule
shutdown requires an approved configuration/deployment change. Deleting a
Workflow, Worker, secret, or D1 database is not part of this procedure.

## Audit closeout

Record threshold crossed, estimated and actual spend, affected run IDs, provider
price evidence, paused/revoked controls, corrective commit/config change, and
the approval to resume.
