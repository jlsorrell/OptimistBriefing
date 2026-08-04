# Optimist Briefing

Optimist Briefing is a private, source-grounded daily research and news reader
for one explicitly approved person. A Cloudflare Worker serves the React
application and authenticated JSON API, D1 stores editorial and operational
state, a Cloudflare Workflow runs the durable daily pipeline, and Cloudflare
Access is the outer Google-login boundary.

## Deployment status

**Not yet deployed.** This repository is a locally verified launch candidate.
It has not created Cloudflare or Google resources, changed GoDaddy nameservers,
set remote secrets, attached `optimistindustries.com`, run paid models, or
deployed a preview or production Worker.

The following are explicit approval checkpoints:

1. creating preview or production cloud resources;
2. changing GoDaddy nameservers;
3. setting remote credentials or personal allowlist data;
4. running a live-source/model rehearsal;
5. deploying a preview or production Worker; and
6. performing a D1 Time Travel restore or other destructive recovery.

See [the deployment runbook](docs/runbooks/deployment.md) before any external
action.

## Architecture

```text
Cloudflare Access (Google + exact-email allow policy)
  └── Worker
      ├── static assets from dist/
      ├── Hono API and /health
      ├── D1 repository
      └── DailyBriefingWorkflow
          ├── source collectors
          ├── deterministic editorial ranking
          ├── OpenAI provider adapters
          └── atomic edition publication
```

Important directories:

| Path | Responsibility |
| --- | --- |
| `src/api/` | Authenticated HTTP routes and error contracts |
| `src/auth/` | Cloudflare Access JWT verification and allowlist enforcement |
| `src/db/` | D1 migrations, repository interface, and D1 implementation |
| `src/editorial/` | Normalization, ranking, shortlisting, synthesis, validation |
| `src/models/` | Model adapters and cost ledger |
| `src/sources/` | Research, news, local, and forecast collection |
| `src/workflow/` | Durable pipeline, schedule, resume, and publication |
| `src/web/` | React reader interface |
| `tests/` | Unit, Worker integration, browser, fixture, and golden-set tests |
| `docs/runbooks/` | Deployment and operational procedures |

## Prerequisites

- Node.js 24, matching CI
- npm
- Chromium installed through Playwright for browser tests
- A local Wrangler installation supplied by `npm ci`
- For later deployment only: approved Cloudflare, Google Cloud, GoDaddy, and
  model-provider access

## Local setup

```sh
npm ci
npx playwright install chromium
npx wrangler d1 migrations apply optimist-briefing --local
npm run seed:dev
```

`npm run seed:dev` is idempotent for the fixed fixture edition and also applies
local migrations. It uses only fixture data and makes no source or model calls.

For frontend-only development:

```sh
npm run dev
```

For the authenticated local integration harness:

```sh
npm run dev:integration
```

The integration harness builds the app, seeds local D1, creates an ephemeral
local signing key under ignored `.wrangler/` state, and listens on
`127.0.0.1:4173`. The Playwright tests mint the matching local assertion; this
is not a production authentication bypass.

## Verification

Run the same gates used by CI:

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
npm run test:e2e
git diff --check
```

The golden-set runner is deterministic and does not use the network or paid
models.

## Runtime configuration

Copy `.dev.vars.example` to ignored `.dev.vars` only for an approved local
Worker smoke test. Blank values are deliberate; never commit a populated file.

| Binding | Classification | Required value |
| --- | --- | --- |
| `OPENAI_API_KEY` | Secret | Provider API key |
| `OPENALEX_API_KEY` | Optional encrypted secret | Free OpenAlex API key; omission disables only OpenAlex lanes |
| `SUMMARY_MODEL` | Nonsecret | Verified generation model identifier |
| `ASSESSMENT_MODEL` | Nonsecret | Verified assessment model identifier |
| `EMBEDDING_MODEL` | Nonsecret | Verified embedding model identifier |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Nonsecret | Access team hostname, without scheme or path |
| `CLOUDFLARE_ACCESS_AUDIENCE` | Nonsecret | Access application's AUD tag |
| `ALLOWED_EMAILS` | Encrypted personal configuration | Comma-separated exact email allowlist |
| `MONTHLY_BUDGET_USD` | Nonsecret | Positive budget, rejected above `30` |
| `SUMMARY_UNIT_PRICE_USD` | Nonsecret | Conservative dollars per counted summary unit |
| `ASSESSMENT_UNIT_PRICE_USD` | Nonsecret | Conservative dollars per counted assessment unit |
| `EMBEDDING_UNIT_PRICE_USD` | Nonsecret | Conservative dollars per counted embedding unit |

Model identifiers and provider prices change. Verify them against the provider
immediately before the first live run. The runtime rejects missing model/price
configuration and models without a configured unit price. The implemented cost
ledger multiplies the configured unit price by counted input tokens, output
tokens, and embedding count, so convert any provider per-million-token price to
dollars per token and use a conservative rate when input and output prices
differ.

The implementation plan's illustrative `MONTHLY_AI_BUDGET_USD` name is stale.
The code contract is `MONTHLY_BUDGET_USD`.

`OPENALEX_API_KEY` is optional so a missing or rejected credential cannot abort
healthy research collectors. OpenAlex lanes instead record a sanitized policy
failure and contribute no new candidates; arXiv, publication, commentary, and
other configured lanes continue under the normal quality and coverage gates.
Use an encrypted Worker secret for any live key, including the free OpenAlex
tier. See the deployment runbook for the approved interactive command.

## Operations

- [Deployment and launch](docs/runbooks/deployment.md)
- [Source health](docs/runbooks/source-health.md)
- [Failed editions and recovery](docs/runbooks/failed-edition.md)
- [Cost control](docs/runbooks/cost-control.md)
- [Privacy and retention](docs/runbooks/privacy-and-retention.md)

The production `wrangler.jsonc` intentionally retains an all-zero D1
`database_id` placeholder and contains no domain route or runtime variables.
Resolve the real database ID and configure variables only at the approved
deployment checkpoint. A Workflow resource is provisioned or updated from the
declared binding during an approved Worker deployment; this Wrangler version
does not expose a separate `workflows create` command.
