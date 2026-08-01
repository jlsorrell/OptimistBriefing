# Preview Managed OAuth Handoff Design

## Purpose

Replace the preview harness's Playwright-controlled Google login with
Cloudflare Access Managed OAuth. Google rejects browsers controlled by
Playwright even when stable Chrome is used. The replacement must open the
authorization URL in the user's ordinary browser, preserve the existing
Google exact-email Access policy, and avoid persisting OAuth credentials.

This design supersedes only the interactive authentication and Playwright
credential-transport portions of
`2026-07-31-preview-access-harness-design.md`. Its read-only coverage,
preview-origin pinning, artifact policy, cleanup requirements, and production
blockers remain in force.

## Architecture

The preview runner discovers Managed OAuth from the preview's unauthenticated
response instead of hard-coding endpoint paths. It validates the protected
resource metadata and authorization-server metadata against the exact preview
origin and the exact Cloudflare Access team origin.

The runner binds a one-use HTTP callback server to `127.0.0.1` on an
operating-system-assigned port. It dynamically registers that exact callback
URI as a public OAuth client, creates random `state` and PKCE verifier values,
and derives an S256 challenge. It then opens the authorization URL in the
user's ordinary default browser. The callback accepts only the expected path,
method, state, and one authorization response before closing.

The authorization code is exchanged for Cloudflare's opaque access token.
Authorization codes, PKCE values, access tokens, and refresh tokens remain in
memory only, are never logged, and are discarded at shutdown. The short live
suite does not persist or reuse refresh tokens.

## Playwright Integration

The Playwright suite receives the access token through a process-private
channel. It attaches `Authorization: Bearer <token>` only to requests whose
origin exactly equals
`https://optimist-briefing-preview.optimistindustries.workers.dev`. Requests
to any other origin never receive the token. Browser storage state is no
longer used for Managed OAuth authentication.

The existing desktop, tablet, and mobile projects, one-worker execution,
read-only tests, disabled traces/screenshots/video, and ephemeral output
directory remain unchanged.

## Failure and Cleanup Behavior

- Metadata, registration, authorization, token exchange, callback, or preview
  validation failures return a generic nonzero result without printing
  response bodies or secrets.
- The callback listener closes on success, error, timeout, or signal.
- State mismatch, duplicate callbacks, unexpected methods or paths, unsafe
  endpoint origins, and unsupported OAuth capabilities fail closed.
- Signals join active network, callback, browser-open, and Playwright child
  lifecycles before existing identity-bound temporary cleanup completes.
- The live run verifies `/health` with the bearer token before starting the
  responsive suite.

## Testing

Tests are written before implementation and cover metadata validation,
dynamic registration, PKCE/state construction, callback rejection and
timeout, token response validation, exact-origin header scoping, redaction,
abort handling, and harness cleanup. Existing unit, Worker, local E2E,
typecheck, build, and evaluation gates remain required. A final live run must
complete through ordinary Chrome and execute all 39 preview tests.

## External Configuration

The `Optimist Briefing Preview` Access application has Managed OAuth enabled
with loopback clients allowed for `127.0.0.1`. Localhost clients and additional
redirect URI patterns remain disabled. No Google OAuth configuration, service
token, copied cookies, automated MFA, or browser-profile access is used.

