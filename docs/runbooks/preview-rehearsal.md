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

The desktop, tablet, and mobile projects run with one worker. All 39 tests are
read-only, traces/screenshots/video are disabled, and nonsecret Playwright
output stays in the runner's mode-`0700` directory directly under
`os.tmpdir()`. Identity-bound cleanup removes that exact directory after
success, failure, or joined signal shutdown. Failed child output is replaced
with a generic retry message.

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
approval even when all 39 preview tests pass; policy inspection or fabricated
credentials are not a substitute.
