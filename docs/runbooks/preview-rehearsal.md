# Access-Protected Preview Rehearsal

Use this procedure only for the isolated preview origin:

`https://optimist-briefing-preview.optimistindustries.workers.dev`

Preview deployment and any live model use require explicit approval. This
rehearsal does not authorize a production deployment.

## Access prerequisite

The `Optimist Briefing Preview` Cloudflare Access application must have
Managed OAuth enabled and must allow loopback clients on `127.0.0.1` with an
operating-system-assigned port. Do not enable localhost aliases or broad
redirect URI patterns.

Run the rehearsal from a machine with an allowed Google account available in
the user's ordinary browser:

```sh
npm run test:e2e:preview
```

The runner discovers the Access Managed OAuth endpoints, registers an exact
loopback callback, and opens the authorization URL in the ordinary browser.
After the user completes Google login, the callback exchanges the code with
PKCE and validates `/health` before starting Playwright. The runner does not
control the login browser and does not capture Playwright storage state.

Authorization codes, PKCE values, and bearer credentials remain in memory.
Only the Playwright child receives the access token. Its fixture adds a bearer
header only when the request origin exactly matches the preview origin;
requests to source sites, analytics endpoints, redirects, or lookalike hosts
never receive it. Browser-global `extraHTTPHeaders` are not used.

The desktop, tablet, and mobile projects run with one worker. All 42 tests are
read-only, traces/screenshots/video are disabled, and nonsecret Playwright
output stays in the runner's mode-`0700` directory directly under
`os.tmpdir()`. Identity-bound cleanup removes that exact directory after
success, failure, or joined signal shutdown. Failed child output is replaced
with a generic retry message.

## Discovery preview canary

Deployments, migrations, and manual Workflow starts remain separately approved
operations; this checklist does not authorize them. Before starting an
approved canary, record the preview Worker version and confirm migrations
`0007` and `0008` are applied only to the isolated preview D1 database. Never
read, print, or replace the stored OpenAI secret, and deploy only with
`--keep-vars`.

For one canary run, retain these bounded operational facts:

- the sanitized outcome for every `arxiv`, `bibliographic`,
  `official-publication`, and `commentary` lane;
- discovered, deduplicated, triaged, and assessed candidate counts per lane;
- the total research assessment count and budget state (normal, degraded, or
  hard stop), confirming uncached-call caps of 24, 4, or 0 respectively;
- cluster and shortlist checkpoint byte lengths, and confirmation that neither
  checkpoint contains embeddings;
- model cost for the run and the remaining monthly-cap state;
- edition status, missing sections, source-failure categories, and the explicit
  quality-floor reason when the run is partial, retryable, or failed; and
- the content/evidence fingerprint outcome for any candidate reconsidered from
  the rolling seven-day window rather than the 36-hour fresh window.

Review the canary in this order:

1. Confirm at least two independent research discovery families succeeded
   before calling the canary representative. This is a canary-evidence rule,
   not a new edition publication requirement; the existing coverage and
   quality rules alone decide published, partial, retryable, or failed status.
2. Confirm a non-arXiv candidate reached relevance triage and no research item
   reached assessment merely because of arrival order.
3. Confirm the same paper found through multiple lanes became one paper, while
   linked commentary and implementation labels remained attached context.
4. Confirm official-lab technical, product, and policy items retained distinct
   Research, Technology, and AI Policy routes.
5. Confirm a sparse or failed lane produced no fabricated empty section and did
   not lower topical-fit, technical-quality, grounding, or coverage floors.
6. Confirm unchanged canonical fingerprints reused cached artifacts, while a
   qualifying new content/evidence fingerprint invalidated only that paper's
   assessment cache entry.

Run the read-only preview suite only after the approved canary edition is
available. Its content assertions verify observable commentary and
implementation labels, distinct official-lab Technology and AI Policy items,
and omission of empty sections. Golden and unit evaluation—not rendered HTML—
enforce the score floor and gate exclusions.

## Secret-free evidence

Retain only:

- the total test count and the `desktop`, `tablet`, and `mobile` project names;
- the preview command's numeric exit status;
- the deployed preview Worker version;
- the allowed-session and signed-out Access-policy results;
- the Workflow instance count before and after the rehearsal; and
- the D1 migration status after the rehearsal.

Do not record or commit authorization URLs, callback query strings, codes,
verifiers, state values, access or refresh tokens, Google credentials,
cookies, browser storage, or test artifacts.

## Production blocker

The harness covers an allowed Google session and a signed-out Access
challenge. A real login attempt by a nonallowed Google account is unavailable
and remains unresolved. That missing result continues to block production
approval even when all 42 preview tests pass; policy inspection or fabricated
credentials are not a substitute.
