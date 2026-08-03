# Authenticated Canary Run Control

## Goal

Add a narrow operational control to the existing Run Status page so the
approved reader can start a single manual briefing run through the same
Cloudflare Access and Worker API boundaries used elsewhere in the private
site. The control must make the paid side effect explicit, prevent accidental
duplicate submissions, and preserve the server's one-run-per-edition-date
guarantee.

## Scope

The feature adds one inline form to `RunStatusPage`. It does not add a new
route, change authentication, alter Workflow orchestration, bypass the manual
run API, or add any new persistence. The existing `POST /api/admin/runs`
endpoint remains the sole authority for creating a run.

## User Interface

The Run Status page will display a compact “Start canary run” section before
the run list. It contains:

- a labeled native date input;
- a short notice that starting a run may incur model costs; and
- a submit button labeled “Start canary run.”

The date defaults to the browser's local calendar date, using local date
components rather than a UTC conversion, and remains editable. Opening the
page never starts a run. The button is disabled while the request is pending,
which prevents repeated submissions from the same form.

The existing burgundy, rose, sage, and mustard visual language will be reused.
The form will use the established state-page styles with only narrowly scoped
additions for layout, fields, and status messaging.

## Data Flow

Submitting the form sends an authenticated request to the existing endpoint:

```http
POST /api/admin/runs
Content-Type: application/json

{"editionDate":"YYYY-MM-DD"}
```

The browser automatically supplies the existing Cloudflare Access session.
The page does not handle or store identity tokens.

On a `202 Accepted` response, the page reads the returned `runId`, announces
that the canary started, reloads the run list, and leaves the selected date in
place. The run itself continues asynchronously in Cloudflare Workflows.

## Error Handling

- `409 Conflict`: announce that a run already exists for the selected date and
  invite the reader to choose another date.
- Any other non-success response or network failure: announce that the canary
  could not be started.
- Malformed success data: treat it as a generic start failure.

Messages will not display provider response bodies, authentication details,
or other internal errors. Status messages will use an appropriate live region
so they are announced by assistive technology.

## Accessibility and Interaction

The date input has a visible label. The form is operable by keyboard through
native controls. Pending state is communicated both through disabled controls
and visible text. Success messages use `role="status"`; failures use
`role="alert"`. The button label explicitly names the paid operation, so the
submit action itself is the user's confirmation.

## Testing

Unit tests for `RunStatusPage` will verify real rendered behavior:

1. the date defaults to the local calendar date without UTC drift;
2. submitting sends the exact JSON request to `/api/admin/runs`;
3. controls remain disabled while the request is pending;
4. a successful response announces the run ID and refreshes the run list;
5. a duplicate date receives a specific, safe message;
6. unexpected responses and network failures receive a generic safe message;
7. the input and status messages expose appropriate accessible semantics.

The existing application, Worker/D1, TypeScript, production build,
responsive, and accessibility checks remain required. No server API changes
are expected, so existing endpoint integration tests continue to protect
authentication, duplicate-run handling, auditing, and Workflow creation.

## Deployment and Canary

After tests pass, deploy the preview Worker with `--keep-vars`; no secret or
binding changes are required. Use the new form through the authenticated
preview page to start exactly one authorized canary on an unused edition date.
Monitor the resulting Workflow instance and D1 run record through completion,
then report discovery coverage, editorial outcome, publication status, and
recorded model cost.
