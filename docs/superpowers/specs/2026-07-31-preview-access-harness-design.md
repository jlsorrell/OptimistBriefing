# Access-Protected Preview Harness Design

## Goal

Add a separate Playwright harness that exercises the deployed preview through
Cloudflare Access at desktop, tablet, and mobile viewports without committing or
printing Google credentials, Access cookies, JWTs, or Playwright storage state.
The harness provides the automated evidence required before production review
while leaving the unavailable nonallowed-Google-account check as an explicit
manual blocker.

## Context

The committed `playwright.config.ts` starts a local integration Worker and adds
a locally signed `CF-Access-Jwt-Assertion` header. Cloudflare Access does not
trust that local signer, so the existing suite cannot validate the deployed
preview. The preview is already protected at
`https://optimist-briefing-preview.optimistindustries.workers.dev` by a Google
Access application whose only Allow rule is
`optimistindustries@gmail.com`. The preview contains fixed fixture data, has no
cron triggers, and has no OpenAI key.

## Chosen Approach

Use an interactive, ephemeral Google authentication step followed by a
separate preview-only Playwright run.

The runner launches headed Chromium and opens the preview `/health` endpoint.
The user completes Google authentication in that browser. The runner accepts
the session only after the browser returns to the exact preview origin and the
page body equals `{"status":"ok"}`. It then writes Playwright storage state to
a mode-`0600` file inside a mode-`0700` operating-system temporary directory,
runs the preview suite with that state, and removes the directory in a `finally`
block. Signal handlers also remove the exact temporary directory before
terminating.

This approach is preferred over CI-managed Google credentials because the site
is private, authentication includes MFA, and no unattended account is
available. A Cloudflare service token is rejected because it would not exercise
the approved Google exact-email flow and would conflict with the Worker's
defense-in-depth email verification.

## Components and Boundaries

### Preview target validation

A small configuration module owns the canonical preview origin and validates
all runtime inputs. The accepted origin is exactly
`https://optimist-briefing-preview.optimistindustries.workers.dev`; userinfo,
ports, paths other than `/`, query strings, fragments, HTTP, other Workers, and
`optimistindustries.com` are rejected. This prevents the harness from
accidentally targeting production or an unrelated deployment.

### Interactive authentication runner

`npm run test:e2e:preview` invokes a TypeScript runner that:

1. validates the exact preview origin before launching a browser;
2. creates the protected temporary directory and storage-state path;
3. launches headed Chromium and navigates to `/health`;
4. waits up to five minutes for the user to complete Google authentication;
5. verifies the final origin and exact health body;
6. writes and permission-hardens the temporary storage state;
7. starts Playwright with the preview config and the temporary state path;
8. returns the Playwright exit status; and
9. removes the temporary directory on success, failure, or termination.

The runner never reads Google passwords, automates MFA, copies browser-profile
state, or logs cookie/token values. Error messages may name a missing variable,
an unexpected host, a timeout, or a failed cleanup target, but may not include
storage-state contents or redirect query strings.

### Preview Playwright configuration

`playwright.preview.config.ts` is separate from the local configuration. It has
no `webServer`, uses a preview-only test directory, requires the validated base
URL and temporary storage-state path, disables traces, screenshots, and video,
and runs serially with zero retries. It defines these Chromium projects:

- desktop: 1440 by 900;
- tablet: 768 by 1024; and
- mobile: 390 by 844.

The preview suite must not generate traces, screenshots, or video because those
artifacts can contain Access cookies. It must not attach token values or
storage-state files to reports.

### Preview tests

The preview-only tests are read-only and cover:

- a cookie-free request to `/health` receives an Access redirect rather than
  origin content;
- the authenticated `/health` body is exactly `{"status":"ok"}`;
- Today loads the fixed `2026-07-29` complete edition, expected sections,
  source labels, and external source links;
- Archive, Preferences, Run Status, and Saved Items render their primary
  headings and controls;
- `/api/sources` returns a nonempty catalog and `/api/runs` returns the current
  preview run list without triggering a Workflow;
- desktop/tablet navigation remains visible and grid-based where expected;
- mobile navigation opens, closes after selection, and uses the single-column
  reader layout;
- each primary route has no horizontal overflow and keeps its primary control
  visible and usable; and
- Today, Archive, Preferences, and Run Status have no serious or critical axe
  violations.

Tests must not click Save, submit preferences, start a run, call an admin
endpoint, modify D1 data, or contact OpenAI.

## Testability and TDD

Pure target-validation and runner-argument helpers are separated from process
and browser side effects. Unit tests are written first for accepted/rejected
origins, missing or unsafe storage-state paths, and child-process exit-status
propagation. Each test must be observed failing for the intended reason before
minimal implementation is added. Preview Playwright specs reuse observable UI
contracts from the local suite but do not import its local-JWT authentication
helper.

## Failure Handling

- Invalid target configuration fails before browser launch.
- Authentication timeout closes Chromium, deletes temporary state, and exits
  nonzero with a concise retry instruction.
- A redirect to any origin other than Google, the Access team domain, or the
  exact preview origin fails without printing the redirect URL.
- A non-`{"status":"ok"}` health response fails before the test suite starts.
- Playwright failures preserve the nonzero exit status while still cleaning up
  authentication state.
- Cleanup validates that its target is the exact directory created by the
  runner; it never deletes a broad path or follows an unresolved variable.

## Documentation and Review Evidence

The deployment runbook will document the exact preview command, the interactive
login handoff, expected cleanup behavior, and evidence to retain without
secrets: test counts, project names, exit status, preview Worker version, Access
policy result, Workflow instance count, and D1 migration status.

The written design and implementation plan are committed separately from the
implementation. The completed change receives an independent code review before
the preview command is run against Cloudflare Access.

## Production Gate

Passing this harness does not authorize or perform a production deployment.
Production remains blocked until all runbook evidence is assembled and the user
explicitly approves production. Because no second Google account is available,
an actual login attempt by a nonallowed Google identity remains unresolved and
must be reported as a blocker; policy inspection or a fabricated JWT must not be
misrepresented as that test.

## Non-Goals

- unattended Google authentication in CI;
- storing browser profiles or reusable Google credentials;
- weakening the Worker or Access policy for testability;
- live-source collection, AI summarization, Workflow execution, or cost tests;
- production deployment, DNS changes, or custom-domain attachment; and
- replacing the existing local Playwright suite.

## Acceptance Criteria

1. The local E2E suite remains unchanged in behavior and continues to pass.
2. The preview command cannot target production or an arbitrary origin.
3. Authentication state exists only in a protected OS-temporary directory and
   is removed after every runner exit path.
4. The preview suite passes at desktop, tablet, and mobile viewports through the
   real Google/Cloudflare Access session.
5. A separate cookie-free check proves signed-out requests are challenged.
6. The suite performs no persistent preview writes and starts no Workflow.
7. No credentials, cookies, JWTs, storage state, traces, or screenshots are
   committed.
8. The missing nonallowed-account test is reported honestly as a production
   blocker.
