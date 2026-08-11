# Dynamic Preview End-to-End Content Contract

**Date:** 2026-08-11
**Status:** Approved design, pending implementation plan

## Context

The authenticated preview end-to-end runner completes Cloudflare Access discovery,
dynamic client registration, browser authorization, token exchange, and authenticated
health validation. Its content project then fails because
`tests/preview-e2e/content.spec.ts` assumes the latest preview edition is always the
seeded July 29, 2026 fixture. It also requires a fixed set of section headings and
source hosts.

Those assumptions are no longer valid after approved canary runs publish newer
editions. The preview API correctly returns the newest published edition, and the
homepage correctly renders that edition. The test is stale; authentication,
deployment, and edition publication are not the cause.

## Goals

- Make the read-only preview suite valid for both a freshly seeded preview and a
  long-lived preview containing newer canary editions.
- Continue verifying that the homepage renders the exact edition returned by
  `/api/edition/latest`.
- Derive section, item-count, source-link, and conditional editorial-label
  expectations from that edition instead of from a particular date's content.
- Preserve all existing security, accessibility, navigation, responsive, and
  no-mutation guarantees.
- Produce clear failures when the latest-edition response is missing or malformed.

## Non-goals

- Do not change Worker, API, database, editorial, authentication, or production
  behavior.
- Do not reseed, delete, rewrite, or otherwise mutate preview D1 data.
- Do not add an expected-edition-date environment variable or another manually
  maintained freshness setting.
- Do not weaken the separately tested editorial score floors, routing rules,
  grounding rules, or canary-evidence requirements.
- Do not make preview deployment or live model calls part of the test.

## Chosen approach

Use the latest-edition API response as the content contract for the live preview
test. Parse a deliberately narrow view of that response in test code, then compare
the rendered homepage with the parsed edition.

This is preferred to an environment-provided expected date because it cannot become
stale after the next canary. It is preferred to resetting preview D1 because the
suite remains read-only and can validate the state operators actually inspect.

The implementation remains local to preview-test code and the preview rehearsal
runbook. Production contracts and rendering components remain unchanged.

## Test-side edition boundary

The preview test will validate the fields it relies on before using them:

- the response is an object;
- `editionDate` is a real `YYYY-MM-DD` calendar date;
- `entries` is a non-empty array;
- every entry has a non-empty `id`, a recognized section, a finite nonnegative
  position, a summary with a non-empty title, an array of selection reasons, and an
  array of source references;
- every source reference has a non-empty ID and name plus a valid HTTP or HTTPS URL.

The recognized sections and canonical UI labels are:

| API section | UI heading |
| --- | --- |
| `morning_brief` | Morning brief |
| `research` | Research |
| `research_radar` | On the radar |
| `world` | World |
| `technology` | Technology |
| `ai_policy` | AI policy |
| `dmv` | DMV |
| `baltimore` | Baltimore |
| `forecast` | Forecast signals |

An HTTP error, absent edition, empty edition, unknown section, invalid date, or
malformed entry fails with a message that names the violated preview-edition
contract. The test will not silently skip malformed data or fall back to July 29.

## Live content assertions

The live content test will:

1. Read `/api/runs` before navigation and confirm `/api/sources` is populated.
2. Fetch and validate `/api/edition/latest`.
3. Navigate to `/` and verify the stable site heading.
4. Format the API's `editionDate` in UTC with the same user-visible date convention
   and require the header to show that exact date.
5. Group entries by section. For each canonical section, require its section element,
   heading, and singular/plural item count when entries exist, and require that the
   section is omitted when no entries exist. Match every API entry ID to its rendered
   `data-entry-id` element inside the expected section and require that element to
   contain the API title.
6. Derive expected source hosts from valid source URLs belonging to card-rendered
   entries. `morning_brief` is excluded because it intentionally renders overview
   links rather than source lists. Compare the deduplicated rendered host set for
   exact equality with the deduplicated API-derived host set, without requiring hosts
   that are not part of the current edition.
7. Require card-level editorial labels only when the edition implies them. A
   research primary source requires the corresponding primary-source label; a
   forecast entry requires the forecast disclaimer. Their absence from a sparse
   edition is not a test failure.
8. Visit Archive, Preferences, Run status, and Saved items and retain their existing
   top-level heading checks.
9. Read `/api/runs` again and require exact equality with the pre-test value.

The comparison is intentionally content-sensitive: if the API returns an entry but
the UI omits its section, count, title card, or source link, the suite fails. It is
only date-agnostic, not assertion-light.

## Deterministic rendering coverage

Dynamic live assertions do not replace deterministic rendering cases. Preview-test
fixtures will cover both supported states without depending on whichever edition is
currently stored remotely:

- the original seeded July 29 edition shape, including its fuller section and source
  mix; and
- a newer sparse/partial canary shape, including omitted sections and a reduced
  source mix.

The existing layered-research test will use deterministic fixture data rather than
requiring the live edition to contain representative Research, World, and AI Policy
templates. It will continue to verify:

- independent implementation and expert-commentary selection reasons;
- research-blog labeling;
- distinct official-lab Technology and AI Policy cards;
- exact per-section counts; and
- omission of empty sections.

This separation keeps the real preview check honest while ensuring a sparse live
edition cannot erase coverage for richer rendering behavior.

## Security and immutability boundaries

The change does not alter the managed OAuth harness. Authorization codes, PKCE
values, bearer credentials, cookies, and browser storage remain memory-only and are
not logged or committed. The bearer token remains restricted to the exact preview
origin. Signed-out Access checks, authenticated health validation, accessibility
checks, and responsive projects retain their current behavior.

The content suite remains read-only. The exact `/api/runs` before/after comparison is
the executable mutation guard. The test does not call run-start, preferences-write,
feedback, save, deployment, migration, or D1 mutation paths.

## Runbook update

`docs/runbooks/preview-rehearsal.md` will describe the content suite as validating the
current latest published preview edition rather than a fixed fixture. It will state
that sparse editions legitimately omit empty sections and that deterministic fixture
coverage preserves the richer layered-rendering checks.

The runbook's deployment approvals, canary requirements, secret-free evidence rules,
and production blocker remain unchanged.

## Verification and acceptance

Implementation will follow test-driven development:

1. Add or refactor deterministic tests so the original July 29 shape passes through
   the dynamic contract.
2. Add a newer sparse/partial fixture that fails under fixed date, heading, or host
   assumptions.
3. Add malformed-response cases for missing edition data, invalid date, unknown
   section, malformed entry, and invalid source URL.
4. Implement the narrow parser and derived assertions until both fixture families
   pass.
5. Run the focused preview content tests and the repository's relevant unit,
   type-check, and build gates.
6. Run `npm run test:e2e:preview` against the authenticated long-lived preview as the
   acceptance test. It must finish successfully without changing the run list.

Success means the same preview-test code passes against the seeded July 29 state and
the current newer canary state, still catches rendering/API disagreement, and makes
no product or remote-state changes.
