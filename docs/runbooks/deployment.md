# Deployment and launch runbook

This runbook separates repository verification from actions that change
Cloudflare, Google, GoDaddy, DNS, credentials, or deployments. The repository is
**not yet deployed**. Stop at every approval checkpoint.

Commands containing `REPLACE_...` or an `OPTIMIST_...` shell variable are
templates, not commands that are safe to paste unchanged. Resolve each value
from the named control plane, inspect it, and confirm that it is not still a
placeholder before execution. Never paste a secret into a command argument,
shell history, issue, or chat.

## 1. Prerequisites and local verification

Use Node.js 24 and the committed lockfile. From the repository root:

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

Apply migrations twice to disposable local state. The second invocation must
report that there are no migrations to apply:

```sh
npx wrangler d1 migrations apply optimist-briefing --local
npx wrangler d1 migrations apply optimist-briefing --local
```

Perform a repository-safe deploy compilation. This does not upload anything:

```sh
npx wrangler deploy --dry-run
```

Do not continue if any gate fails, if `wrangler.jsonc` still lacks `main` or
`assets`, or if the D1 `database_id` has not been resolved before a remote
operation.

## 2. Select the Cloudflare account and add the zone

**External action — explicit approval required.**

1. Sign in to Cloudflare and select or create the intended account.
2. Record the account name and account ID in the private deployment record.
3. Add `optimistindustries.com` as a website/zone. Keep GoDaddy as registrar.
4. Do not change nameservers yet.
5. In a terminal, authenticate Wrangler only after approval:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

Confirm `whoami` shows the intended account before creating any resource.

## 3. Review imported DNS before any change

**External read/review — no nameserver change yet.**

In Cloudflare DNS, compare every imported record with the current GoDaddy DNS
zone. Record at least the name, type, value, proxy state, and TTL of:

- apex and `www` web records;
- MX records;
- SPF, DKIM, DMARC, domain-verification, and other TXT records;
- CAA records;
- any subdomains or service records.

Even though the site is currently empty, do not assume mail or verification
records are disposable. Export or screenshot both zones and resolve every
difference before continuing.

## 4. Stop before GoDaddy nameserver changes

**Hard approval checkpoint.**

Show the user the reviewed DNS comparison and the exact two Cloudflare-assigned
nameservers. Do not edit GoDaddy nameservers until the user explicitly approves
that specific change. A prior request to build the site or create resources is
not approval to move authoritative DNS.

After approval, change only the authoritative nameservers. Do not transfer the
registration and do not delete records from either provider. Wait for
Cloudflare to report the zone as active, then recheck DNS and mail-related
records.

## 5. Create D1 and prepare the Workflow binding

**External resource creation — explicit approval required.**

Create the database:

```sh
npx wrangler d1 create optimist-briefing
```

Wrangler prints the real database UUID. Copy it from the command output, verify
the database name, then replace only the all-zero `database_id` in
`wrangler.jsonc`. Never guess or derive a UUID. Inspect the diff:

```sh
git diff -- wrangler.jsonc
```

The repository declares binding `DAILY_BRIEFING`, Workflow name
`daily-briefing`, and class `DailyBriefingWorkflow`. The installed Wrangler CLI
has no `workflows create` command. The Workflow resource is provisioned or
updated from that binding during an approved Worker deployment. Before launch,
verify it after deployment with:

```sh
npx wrangler workflows describe daily-briefing
npx wrangler workflows instances list daily-briefing
```

Do not add a custom-domain route to `wrangler.jsonc`; domain attachment remains
an explicit control-plane step.

## 6. Configure Google as the Cloudflare Access identity provider

**External identity configuration — explicit approval required.**

1. In Cloudflare Zero Trust, note the Access team domain.
2. In Google Cloud, create or select a project and configure the OAuth consent
   screen for the intended private use.
3. Create a Web application OAuth client using the exact redirect URI shown by
   Cloudflare's Google identity-provider setup.
4. Store the Google client secret only in the Cloudflare identity-provider
   form or an approved password manager.
5. In Zero Trust, add Google as a login method and test the connection.

Do not put the Google client ID or client secret in this repository. The Worker
does not consume them directly.

## 7. Create deny-by-default Access applications

Create a self-hosted Access application for each preview/production hostname
before exposing private content.

- Cover the entire hostname/path, including static assets and `/api/*`.
- Create one `Allow` policy whose include rule lists only the exact approved
  Google email address or addresses.
- Add no `Everyone`, email-domain, or `Bypass` rule.
- Nonmatching identities are denied by default.
- Test one allowed and one nonallowed identity.

Copy the application's AUD tag into the private deployment record. The Worker
also verifies the Access JWT, issuer, audience, and exact-email allowlist as
defense in depth.

## 8. Configure secrets and nonsecret variables

The exact runtime contract is:

| Name | Storage | Validation |
| --- | --- | --- |
| `OPENAI_API_KEY` | Encrypted Worker secret | Nonempty |
| `ALLOWED_EMAILS` | Encrypted Worker secret recommended | Comma-separated valid emails |
| `SUMMARY_MODEL` | Nonsecret Worker variable | Nonempty current model ID |
| `ASSESSMENT_MODEL` | Nonsecret Worker variable | Nonempty current model ID |
| `EMBEDDING_MODEL` | Nonsecret Worker variable | Nonempty current model ID |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Nonsecret Worker variable | Hostname only |
| `CLOUDFLARE_ACCESS_AUDIENCE` | Nonsecret Worker variable | Exact AUD tag |
| `MONTHLY_BUDGET_USD` | Nonsecret Worker variable | Positive and no more than 30 |
| `SUMMARY_UNIT_PRICE_USD` | Nonsecret Worker variable | Positive dollars per counted unit |
| `ASSESSMENT_UNIT_PRICE_USD` | Nonsecret Worker variable | Positive dollars per counted unit |
| `EMBEDDING_UNIT_PRICE_USD` | Nonsecret Worker variable | Positive dollars per counted unit |

The plan's `MONTHLY_AI_BUDGET_USD` example is stale; do not set it.

Immediately before first live use, verify all three model identifiers and
provider prices against current provider documentation. The ledger multiplies a
single configured unit rate by input tokens, output tokens, and embedding count.
Convert a per-million-token rate to dollars per token and use the more expensive
applicable rate when one model has different input and output prices. Record the
source URL, effective date, calculation, and reviewer in the private deployment
record.

Set secrets interactively so their values never appear in the command:

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ALLOWED_EMAILS
```

Set the remaining names as nonsecret Variables in Worker Settings. Because they
are deliberately absent from `wrangler.jsonc`, production deploy commands must
use `--keep-vars` or they may remove dashboard-managed variables. Confirm all
eleven bindings by name before proceeding. Never commit a populated
`.dev.vars`.

## 9. Apply remote migrations

**Remote database mutation — explicit approval required.**

First confirm the binding resolves to the intended remote database:

```sh
npx wrangler d1 info optimist-briefing
npx wrangler d1 migrations list optimist-briefing --remote
```

Then apply migrations:

```sh
npx wrangler d1 migrations apply optimist-briefing --remote
```

Run the list command again and retain the output with the launch record. Do not
use `d1 execute --remote` to hand-apply migration SQL.

## 10. Perform an authenticated preview rehearsal

**Preview deployment and any live model use require explicit approval.**

Use a distinct preview Worker name, D1 database, Workflow name, Access
application, and local configuration file outside the repository. Resolve and
inspect every preview binding before upload. Apply migrations through the
preview config and verify that none remain:

```sh
npx wrangler d1 migrations apply DB --remote --config "$OPTIMIST_PREVIEW_CONFIG"
npx wrangler d1 migrations list DB --remote --config "$OPTIMIST_PREVIEW_CONFIG"
```

The preview UI needs data. The existing `seed:dev` command is local-only and
must not be pointed at a remote database. Generate the repository's fixed,
nonsecret fixture SQL into a protected file outside the repository, inspect the
destination, then apply it only to the preview config's `DB` binding:

```sh
node --import tsx --input-type=module -e 'import { writeFileSync } from "node:fs"; import { seedSql } from "./scripts/seed-dev.ts"; writeFileSync(process.argv[1], seedSql(), { mode: 0o600 });' "$OPTIMIST_PREVIEW_SEED_SQL"
npx wrangler d1 execute DB --remote --config "$OPTIMIST_PREVIEW_CONFIG" --file "$OPTIMIST_PREVIEW_SEED_SQL"
```

Both variables must be reviewed absolute paths. Before the execute command,
confirm the preview config has a distinct Worker name, D1 UUID, and Workflow
name, and inspect the generated SQL to verify it contains only the fixed
`2026-07-29` fixture. Never run this seed against production.

Build, then deploy only after the user approves the preview deployment:

```sh
npm run build
npx wrangler deploy --config "$OPTIMIST_PREVIEW_CONFIG" --keep-vars
```

`OPTIMIST_PREVIEW_CONFIG` must be an already-reviewed absolute path, not a
literal placeholder. Do not attach `optimistindustries.com` during preview.

With an allowed Google session:

1. open `/health` and verify the body is exactly `{"status":"ok"}`;
2. verify a signed-out request is challenged by Access;
3. record that the separate real nonallowed Google-account check is unavailable
   and remains a production blocker; do not mark it verified;
4. verify the allowed account can view the fixture edition and source links;
5. inspect Today, Archive, Preferences, Run Status, desktop, and mobile;
6. inspect `GET /api/sources`, `GET /api/runs`, and the relevant run detail.

The local `npm run test:e2e` suite cannot target preview: it hard-codes the
local integration server and uses a locally signed assertion that Cloudflare
Access will not accept. Do not claim that it tested preview. To rehearse the
Access-protected preview, run:

```sh
npm run test:e2e:preview
```

The command opens headed Chromium for the allowed user to complete Google
authentication. It does not start the preview suite until `/health` returns
exactly `{"status":"ok"}`, then closes the authentication browser and runs the
desktop, tablet, and mobile projects. The harness accepts only the preview,
Cloudflare Access, and Google authentication origins.

Authentication state and Playwright output live only in a uniquely named
directory directly under Node's `os.tmpdir()`: the directory is mode `0700` and
its `storage-state.json` is mode `0600`. The harness removes that exact
directory after success, failure, or `SIGINT`/`SIGTERM`; it rejects broad,
unrelated, or symlinked cleanup targets. Playwright trace, screenshot, and
video artifacts are disabled, and all preview tests are read-only: they make
only GET/navigation requests and verify that run state is unchanged. To list
any unexpected leftovers portably, use Node's actual temporary directory:

```sh
node --input-type=module -e 'import { readdirSync } from "node:fs"; import { tmpdir } from "node:os"; console.log(readdirSync(tmpdir()).filter((name) => name.startsWith("optimist-preview-e2e-")).join("\\n"));'
```

Do not commit Google credentials, cookies, tokens, storage state, or test
artifacts. The signed-out Access challenge and allowed Google session are
covered by the harness, but a real nonallowed Google account has not been
tested. That unresolved nonallowed-account test continues to block production
approval even if the preview rehearsal passes.

There is no draft-only live-source endpoint. `POST /api/admin/runs` can incur
model cost and may publish when coverage passes. A live-source preview run
therefore requires separate explicit approval and must use the isolated preview
database:

```js
await fetch("/api/admin/runs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ editionDate: "REPLACE_WITH_YYYY_MM_DD" }),
});
```

The snippet is a browser-console template and is not safe unchanged. Replace the
date, confirm the browser is on the isolated preview origin, and confirm cost
approval before running it.

## 11. Stop before the first production deploy

**Hard approval checkpoint.**

Present the user with:

- verified commit and clean diff;
- complete local gates, manual preview results, and the separately reviewed
  preview Playwright result;
- DNS review and current zone status;
- Access allow/deny test evidence;
- resolved D1 and Workflow bindings;
- model identifiers, price calculations, and projected monthly cost;
- remote migration status;
- rollback version/database recovery plan.

Do not infer production approval from preview approval. After explicit
production approval:

```sh
npm run build
npx wrangler deploy --keep-vars
```

The deployment provisions/updates the declared Workflow, uploads `dist/`, and
attaches the three UTC cron triggers. Do not use `npm run deploy` for production
while variables remain dashboard-managed because that script omits
`--keep-vars`.

Attach `optimistindustries.com` as the Worker's custom domain only after the
Access application covering the full hostname is enabled and tested.

## 12. Post-deploy checks and rollback

With the authenticated production origin:

1. verify `/health` returns only `{"status":"ok"}`;
2. repeat allowed, nonallowed, and signed-out Access checks;
3. verify static routes and every authenticated API page;
4. verify the newest edition is published/partial, source-linked, and readable;
5. verify cron strings remain `30 8 * * *`, `30 9 * * *`, and
   `30 10 * * *`;
6. verify Workflow and run state:

   ```sh
   npx wrangler workflows describe daily-briefing
   npx wrangler workflows instances list daily-briefing
   ```

7. tail errors during the first run:

   ```sh
   npx wrangler tail optimist-briefing --format pretty --status error
   ```

8. confirm the next valid run publishes by 6:00 a.m. America/New_York.

List deployed versions before rollback:

```sh
npx wrangler deployments list --name optimist-briefing
npx wrangler deployments status
```

For a code/config regression, resolve a known-good version ID from that output,
obtain approval, then use this template:

```sh
npx wrangler rollback "$OPTIMIST_KNOWN_GOOD_VERSION_ID" --name optimist-briefing
```

Rollback does not reverse D1 migrations or repair data. For database recovery,
follow [the failed-edition runbook](failed-edition.md). D1 Time Travel is a
destructive, separately approved last resort with a preflight export and
inspection.
