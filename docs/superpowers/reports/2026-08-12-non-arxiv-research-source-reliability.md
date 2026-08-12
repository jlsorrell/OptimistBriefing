# Non-arXiv research source reliability audit

**Date:** 2026-08-12
**Design base:** `5486b75`
**Implementation base:** `98e0081`
**Implementation through Task 6:** `aae3c66`

## Outcome

The implementation repairs the selected commentary, metadata-index, and
official-lab discovery lanes without adding a non-arXiv quota or changing the
existing relevance, quality, synthesis, grounding, diversity, or budget gates.
The Task 7 implementer audit found two diagnostic-count defects and corrected
both under focused RED/GREEN coverage: Papers with Code and the reviewed lab
adapters had counted raw or pre-policy rows as `observed`. They now count only
structurally valid, policy-approved rows before collection-window filtering.

The audit also added mutation-proven coverage for Atom category terms and D1
migration policy-preservation edges, and updated the source-health runbook for
the new family, outcome, and `observed` semantics. The final-review fix wave
then closed four Important and three Minor findings: the two dedicated adapters
now honor the catalog endpoint and split policies; their initial and final URLs
must match the exact reviewed endpoints; durable-identity conflicts are checked
across every jointly populated namespace; malformed XML is validated and
reported as a sanitized parse failure; reviewed calendar dates are strict and
UTC-stable; all six discovery-mechanism migration guards have mutation-sensitive
preservation coverage; and the report no longer claims Curated-specific item
preference.

No deployment, shared-D1 migration execution, paid canary, push, or pull request
was performed. Zero qualified non-arXiv results remains acceptable on quiet
days.

## Source contract matrix

| Source | Endpoint | Static parser and bounds | URL boundary | Content and access behavior | Focused evidence |
| --- | --- | --- | --- | --- | --- |
| `alignment-forum` | `https://www.alignmentforum.org/feed.xml?view=frontpage` | Shared `RssAdapter`; RSS/Atom envelope and entry fields; at most 10,000 emitted/observed entries; no detail fetch | Feed: `www.alignmentforum.org`, port `""`, `/feed.xml`; articles: `www.alignmentforum.org` or `www.lesswrong.com`, port `""`, `/posts/`; every resolved link uses the article policy | Commentary, `canCorroborateFacts=false`; permitted ephemeral summarization; feed summary is secondary evidence and still passes ordinary routing and grounding | `alignment-forum-feed.xml`; `publication-collector.test.ts` current feed, split-policy rejection, malformed envelope, unsupported media, quiet feed, and commentary mapping cases |
| `lesswrong-curated` | `https://www.lesswrong.com/feed.xml?view=curated` | Shared `RssAdapter`; RSS/Atom envelope and entry fields; at most 10,000 emitted/observed entries; no detail fetch | Feed: `www.lesswrong.com`, port `""`, `/feed.xml`; articles: the same host/port and `/posts/` | Commentary, `canCorroborateFacts=false`; permitted ephemeral summarization; consolidation retains Curated provenance without adding a Curated-specific item preference | `publication-collector.test.ts` Curated collection and malformed-feed cases; `research-identity.test.ts` Curated/Frontpage consolidation and durable-conflict cases |
| `lesswrong-frontpage` | `https://www.lesswrong.com/feed.xml?view=frontpage&karmaThreshold=20` | Shared `RssAdapter`; fixed endpoint threshold; at most 10,000 emitted/observed entries; no detail fetch | Feed: `www.lesswrong.com`, port `""`, `/feed.xml`; articles: the same host/port and `/posts/` | Commentary, `canCorroborateFacts=false`; permitted ephemeral summarization; threshold bounds discovery volume but grants no editorial authority | `lesswrong-frontpage-feed.xml`; collector mapping/policy cases; identity unit and production-context duplicate-commentary cases |
| `papers-with-code-co` | `https://paperswithcode.co/papers/recent` | `PapersWithCodeAdapter`; first 100 `<li>` rows; row-local `/paper/` link and strict UTC calendar date required; no detail fetch; no homepage fallback | Catalog `pageUrl`, listing policy, and article policy are parsed before adapter construction; the initial and final listing URL must be the exact approved endpoint with no query or fragment; emitted article paths must match `/paper/<durable-id>` under the catalog article policy | Discovery metadata only; emitted source role is `blog` so the index cannot claim primary-paper authority; code links are supporting metadata only | `papers-with-code-recent.html`; `publication-collector.test.ts` catalog drift, exact initial/final endpoint, redirect/query drift, 100-row bound, identity/date/code, policy, malformed-date, and observed-count cases; production-context primary-source boundary |
| `anthropic` | `https://www.anthropic.com/research` | Code-owned Anthropic profile; reviewed `/research/` anchors with time; first 20 matched entries; topical selection before at most 5 detail fetches; no generic fallback | Listing: `www.anthropic.com`, port `""`, `/research`; articles: same host/port, `/research/`; resolved paths such as `/research/../products/` are rejected before observation/emission | Permitted ephemeral summarization, paywall none; detail failure leaves a dated row as metadata; undated rows need an exact detail date; ordinary route/assessment/grounding remains decisive | `anthropic-research-listing.html`; profile extraction/date/text tests; collector 20/5, policy, sibling isolation, observed-count, and drift cases; production-context relevant, quiet, drift, and media scenarios |
| `google-deepmind` | `https://deepmind.google/blog/` | Code-owned DeepMind `.card__inner` profile; first 20 cards; topical selection before at most 5 detail fetches; month-only cards require an exact detail date; no generic fallback | Listing and articles: `deepmind.google`, port `""`, `/blog/`; each detail request and final URL uses the article policy | Permitted ephemeral summarization, paywall none; non-HTML or failed details are item-local; a dated row may remain metadata-only, while an unresolved undated row drops | `deepmind-blog-listing.html`, `deepmind-blog-detail.html`; profile date tests; collector window-boundary, media isolation, 20/5, policy, and observed-count cases |
| `google-research` | `https://research.google/blog/` | Code-owned Google Research `.glue-card--blog` profile; first 20 cards; topical selection before at most 5 detail fetches; no generic fallback | Listing and articles: `research.google`, port `""`, `/blog/`; every resolved article/final URL uses the article policy | Permitted ephemeral summarization, paywall none; product/navigation/off-policy rows do not emit; available detail text remains ephemeral | `google-research-blog-listing.html`; profile malformed-sibling tests; shared collector 20/5, policy, observed-count, and drift cases |
| `openai` | `https://openai.com/news/rss.xml` | `OpenAiPublicationFeedAdapter` composed with `RssAdapter`; first 20 raw feed entries; first 16 category labels/terms; topical selection before at most 5 detail fetches; no page fallback | Catalog `feedUrl` and split policies are parsed before adapter construction; the initial and final feed URL must be the exact approved endpoint with no query or fragment; articles use the catalog article policy; every redirect hop remains under `SourceHttpClient` policy validation | Permitted ephemeral summarization, paywall none; a complete dated feed row may remain metadata-only after detail failure; categories are bounded provider labels, not routing authority | `openai-news-feed.xml`, `openai-research-detail.html`; feed/collector tests cover RSS/Atom categories, 20/5 bounds, catalog drift, exact redirect/query handling, malformed XML, failure isolation, and no fallback |

## Design and non-goal audit

| Approved boundary | Result and evidence |
| --- | --- |
| Relevant non-arXiv work reaches ordinary triage when available | The production D1-context Anthropic scenario traverses catalog loading, real collection, normalization/routing, identity, assessment, shortlist, synthesis, and grounding. It records `observed=1`, `discovered=1`, `triaged=1`, and `assessed=1`. |
| Quiet days remain valid | The quiet-source and all-eight-lanes scenarios produce successful `observed > 0`, `discovered=0` diagnostics with no model calls or filler. No source receives a reserved slot. |
| Repair a small reviewed set, not the generic scraper | Three lab IDs select fixed code-owned profiles. OpenAI selects its fixed feed adapter. Reviewed parser drift throws a bounded parse outcome and never enters the generic JSON-LD, catalog-selector, or arbitrary-article branches. Tier 3 behavior remains unchanged. |
| Preserve URL, redirect, media, response, timeout, and retry controls | All requests use `SourceHttpClient`; endpoint and article policies come from the parsed catalog and remain separate; every redirect hop stays policy-validated; Papers with Code and OpenAI additionally require exact reviewed initial/final endpoints, including empty query/fragment semantics; media types are allowlisted; parser entry/detail counts are static. |
| Preserve deterministic identity and both LessWrong lanes | Commentary consolidates before attachment or standalone output, refuses a mismatch in any jointly populated arXiv, DOI, or same-provider namespace, and unions both source references, lane IDs, and discovery lineage. Different provider namespaces such as OpenAlex and Semantic Scholar are independent mappings, not conflicts. The retained representative follows the existing generic access/role/text/stable-key comparator; no Curated-specific preference is required. |
| Fail open by lane | Fetch, timeout, policy, unsupported-media, and parse outcomes settle independently. Production-context drift/media scenarios retain a healthy sibling lane. |
| Keep diagnostics bounded and private | `observed` and all funnel/rejection counts cap at 10,000; diagnostic arrays cap at 64. D1 acceptance cases prove serialized audit artifacts omit bodies, excerpts, query parameters, selector text, internal exception messages, and stack data. |
| Do not relax editorial or grounding controls | No scoring, topical-fit, near-match, technical-quality, shortlist-budget, synthesis-prompt, grounding-validator, or section-capacity file changed. Route characterizations cover relevant/generic commentary, official research/product content, and metadata-only Papers with Code identity. |
| Do not grant lab or index provenance automatic quality | Lab records still pass ordinary topic/routing/assessment/grounding. Papers with Code has no primary authority and fails the existing primary-source grounding requirement when unresolved. |
| Do not add model calls or source-parsing models | Parsing remains XML/DOM/static selectors. The quiet all-lanes acceptance case asserts zero embedding, assessment, and summary calls. |
| Do not bypass access controls | No credential, cookie, authenticated browser, challenge bypass, paywall bypass, or arbitrary third-party host was added. |
| Do not rewrite history or deployed migration `0011` | Migration `0012` is additive and guarded. The exact history diff for `0011_split_publication_url_policies.sql` is empty. No historical candidate, observation, checkpoint, or edition rewrite was added. |
| Do not deploy or spend | No deployment, preview release, shared D1 execution, remote source mutation, paid canary, push, or PR action occurred. |

## Diagnostics and production-path acceptance

The production-context Worker coverage distinguishes the required states:

| State | Observable contract |
| --- | --- |
| Relevant reviewed result | Anthropic item reaches assessment, shortlist, synthesis, and valid grounding through `official-publication`. |
| Healthy quiet | `outcome=success`, `observed=1`, `discovered=0`; no filler or model call. |
| Parsed but unroutable | LessWrong broad mention records `route_excluded=1` while the lane remains successful. |
| Parser drift | Anthropic records `parse`; a LessWrong sibling continues. |
| Unsupported media | Anthropic records `unsupported_media`; a LessWrong sibling continues. |
| Fetch/timeout/policy | Focused settlement/collector tests retain distinct bounded fixed outcomes without exception text. |
| Dedicated endpoint drift | A catalog mismatch or redirected path/query mismatch records `policy`, emits no candidate, omits `observed`, and leaves a healthy sibling lane running. |
| Malformed XML | Truncated, unbalanced, and parser-rejected XML record a fixed sanitized `parse` outcome with no candidate and no `observed`. |
| Duplicate commentary | Curated and Frontpage become one identity with both provenance lanes and exactly one identity-merge rejection. |
| Metadata index boundary | Papers with Code reaches triage as a discovery identity but cannot satisfy primary-source grounding by itself. |
| No quota | All eight non-arXiv lanes may be healthy and quiet with empty downstream stages and zero model calls. |

Run Status remains backward compatible: historical diagnostics without
`observed` render an em dash, and all current outcome values render through
fixed labels rather than raw provider text.

## TDD history

The RED entries below are historical implementation evidence captured in the
task reports. Final-tree GREEN evidence appears in the verification section.

| Task | RED command | Intended and observed failure |
| --- | --- | --- |
| 1 diagnostics | `npx vitest run tests/unit/contracts/editorial.test.ts` | 2 of 25 failed because `observed` and `unsupported_media` were absent. |
| 1 detail media | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "does not hide unsupported publication detail media"` | Failed with an empty failure list because a typed detail-media error was swallowed. |
| 2 Tier 1 | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "PapersWithCodeAdapter|Alignment Forum|LessWrong"` | 4 failed: old Papers with Code endpoint/parser and incorrect Frontpage family behavior. |
| 2 identity | `npx vitest run tests/unit/editorial/research-identity.test.ts` | 1 of 18 failed because duplicate commentary lost the Frontpage lane/source/lineage. |
| 2 whitespace drift | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "whitespace-only HTML response"` | Failed because nonempty whitespace resolved as a healthy empty list. |
| 3 lab profiles | `npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts` | Import failed because the code-owned profile module did not exist. |
| 3 timestamp validation | `npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts -t "rejects unresolved detail timestamps"` | Failed because an invalid timestamp was accepted from its calendar prefix. |
| 3 review round 1 | `npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts -t "excludes the direct-child display-date span|drops a month-only reviewed entry|isolates non-HTML reviewed detail"` | 3 failed for date-span selection, post-detail window validation, and sibling-wide media failure. |
| 3 review round 2 | `npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts -t "excludes the direct-child display-date span|keeps exact boundary instants"` | 2 failed for whitespace-equivalent date display and lexical timestamp-boundary comparison. |
| 4 OpenAI | `npx vitest run tests/unit/sources/reviewed-publication-feed.test.ts tests/unit/sources/publication-collector.test.ts -t "OpenAI|feed categor"` | Import failed because the reviewed feed adapter did not exist; two selected pre-existing collector cases passed. |
| 5 migration | `npx vitest run --config vitest.worker.config.ts tests/integration/db/non-arxiv-research-source-migration.test.ts` | Approved loopback rerun produced 28 expected failures because migration `0012` and its final endpoints were absent. |
| 6 routing characterization | `npx vitest run tests/unit/editorial/route-publication.test.ts` | The first test draft had 3 expectation failures because it omitted the existing `oversight-governance` topic; expectations were corrected with no production routing edit. |
| 6 production acceptance | `npx vitest run --config vitest.worker.config.ts tests/integration/workflow/manual-run.test.ts -t "non-arXiv|reviewed publication|quiet source|duplicate commentary|unsupported media"` | 1 failed and 7 passed: Papers with Code incorrectly claimed primary research authority. |
| 6 Run Status | `npx vitest run tests/unit/web/RunStatusPage.test.tsx -t "historical fallback diagnostics"` | 1 failed because `observed` was absent from rendering and outcome enum text was not mapped to bounded labels. |
| 7 Papers with Code count | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "parses only on-origin paper links"` | 1 failed: `observed` was 5 rather than the 3 structurally valid, policy-approved rows. |
| 7 reviewed-lab count | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "collects relevant entries from each reviewed lab profile"` | 1 failed: lab observations counted policy-rejected product paths (`3/2/2` rather than `2/1/1`). |
| Final I1 catalog authority | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "catalog drift"` | All 5 new cases failed: Papers with Code bypassed mechanism/endpoint/split-policy configuration and OpenAI ignored the catalog feed URL or entered the generic page path. |
| Final I2 exact redirects | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "after redirects"` | All 4 new cases failed: Papers with Code treated a wrong final path/query as healthy-empty and OpenAI accepted a feed-path suffix/query. |
| Final I3 durable conflicts | `npx vitest run tests/unit/editorial/research-identity.test.ts -t "shares arXiv identity|transitive commentary bridge"` | Both new cases failed because an earlier matching family hid a later DOI/provider conflict. A follow-up cross-provider namespace regression also failed after the first aggregate-provider fix, preventing an overcorrection that would split valid OpenAlex/Semantic Scholar mappings. |
| Final I4 malformed XML | `npx vitest run tests/unit/sources/publication-collector.test.ts -t "malformed XML"` | All 3 new cases failed: truncated/unbalanced XML emitted a candidate and a parser exception was classified `unknown`. |
| Final M1 calendar dates | `TZ=Pacific/Kiritimati npx vitest run tests/unit/sources/reviewed-publication-profiles.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/reviewed-publication-feed.test.ts -t "calendar date|impossible recent-paper|explicitly offset"` | 5 of 8 failed because impossible natural dates rolled over and valid natural dates inherited the host timezone. |

The earlier unsupported-envelope characterization was not a malformed-XML
test: that well-formed object shape was already rejected after parsing. The
final-review regressions instead use genuinely truncated, unbalanced, and
parser-rejected XML and produced the product RED recorded above.

## Mutation evidence

### Parser and boundary mutations

- Removing topic selection before the reviewed-lab five-detail cap is caught
  by the test that places six unrelated rows before six relevant rows and
  asserts only the first five relevant details are fetched.
- Replacing Atom `@_term` extraction with the non-attribute form made
  `npx vitest run tests/unit/sources/reviewed-publication-feed.test.ts -t
  "Atom category terms"` fail 1 test with `feedCategories: []`; restoring the
  implementation returned 1 pass and 3 skips.
- Changing either corrected observation to raw/pre-policy row count is caught
  by the Task 7 RED cases above.
- Restoring `durableIdentityConflict`'s first-populated-family return makes the
  shared-arXiv/conflicting-DOI and transitive shared-DOI/conflicting-OpenAlex
  regressions fail. Aggregating all provider namespaces into one family makes
  the cross-provider regression and the golden evaluator fail, while the
  namespace-specific implementation preserves both conflict safety and valid
  OpenAlex/Semantic Scholar joins.

### Migration guard mutations

Task 5 temporarily weakened each listed predicate and restored the SQL after
the named preservation regression failed:

| Weakened guard | Regression that failed |
| --- | --- |
| Papers with Code prior endpoint | Custom endpoint preservation |
| Papers with Code paired split-policy condition | Custom feed-policy preservation |
| DeepMind prior endpoint | Custom endpoint preservation |
| DeepMind paired split-policy condition | Custom article-policy preservation |
| Anthropic absent-policy endpoint | Absent policies plus custom endpoint |
| Anthropic paired absence | One split policy present |
| Anthropic prior article policy | Custom article-policy preservation |
| Google Research absent-policy endpoint | Absent policies plus custom endpoint |
| Google Research paired absence | One split policy present |
| OpenAI prior page endpoint | Custom endpoint preservation |
| OpenAI prior split policies | Custom article-policy preservation |
| OpenAI feed absence | Pre-existing feed endpoint preservation |

Task 7 added and mutation-checked the deferred edges:

- Removing the Papers with Code article-policy absence predicate caused
  `-t "papers-with-code-co record when feedUrlPolicy is absent"` to fail 1
  test with 42 skips because a partial operator record was rewritten.
- Disabling the both-absent guard branches for Papers with Code and DeepMind
  caused `-t "endpoint when both split policies are absent"` to fail both
  selected tests with 41 skips. Restored SQL passed the full 43-test dedicated
  migration suite.

The final-review wave added six custom-`manual` mechanism cases covering the
Papers with Code endpoint guard, DeepMind endpoint guard, both Anthropic guard
branches, the Google Research both-absent branch, and OpenAI page-to-RSS
conversion. Removing each `discoveryMechanism = 'page'` predicate independently
made its matching case fail; restoring the unmodified SQL returned the full
49-case suite to GREEN.

## Migration preservation matrix

`tests/integration/db/non-arxiv-research-source-migration.test.ts` applies only
through `0011` to isolated `UPGRADE_DB`, executes raw `0012` directly, and can
therefore prove SQL idempotence independently of the migration ledger. Its 49
cases cover:

- current fresh installation and catalog readability;
- exact reviewed `0011` defaults for Papers with Code, DeepMind, Anthropic,
  Google Research, and OpenAI;
- custom endpoint, feed-policy, and article-policy preservation for all five;
- both directions of partial split-policy presence for all five;
- explicit legacy-looking DeepMind feed policy with a custom article sibling;
- both split policies absent for Papers with Code, DeepMind, Anthropic, and
  Google Research;
- absent policies plus custom Anthropic/Google Research endpoints;
- a deleted source row;
- pre-existing LessWrong Frontpage ID and canonical-URL collision;
- pre-existing OpenAI feed URL;
- six custom `manual` discovery-mechanism rows spanning every affected update;
  and
- identical ordered raw rows after executing `0012` twice.

`git diff 1110484..HEAD --
src/db/migrations/0011_split_publication_url_policies.sql` returns no output.

## Safety and structural audit

- Trusted/dynamic HTML sink scan:
  `rg -n "dangerouslySetInnerHTML|innerHTML\\s*=|outerHTML\\s*=|insertAdjacentHTML|document\\.write" src`
  returned no matches.
- The provider-text scan was manually inspected at every match. New calls
  normalize or bound only titles, summaries, categories, extracted article
  text, or routing-signal copies. URLs use `URL` plus
  `assertSafeOutboundUrl`; identifiers use identity helpers; timestamps use
  date parsers; roles remain catalog/static values. No URL, ID, date, role,
  token, credential, or secret assignment passes through prose normalization.
- The implementation diff adds no credential, cookie, authorization header,
  bearer token, API key, authenticated browser dependency, or arbitrary
  exception persistence.
- Added outbound origins are limited to the reviewed first-party hosts in the
  source matrix. Every catalog policy uses HTTPS, port `""`, and fixed path
  prefixes. Papers with Code and OpenAI additionally enforce their exact
  reviewed initial/final endpoint, including query and fragment semantics;
  Papers with Code retains the `/paper/` identity shape in code.
- The shared calendar helper accepts only explicit reviewed calendar forms or
  an explicitly zoned ISO timestamp, constructs date-only values in UTC, and
  round-trips year/month/day. RSS timestamp parsing remains unchanged.
- Changed files include no assessment prompt, score, topical threshold,
  shortlist budget, grounding validator, model reservation, or cost-control
  implementation.
- `git diff --check 5486b75..HEAD` and the working-tree diff check report no
  whitespace errors.
- The unfinished-marker scan covers this report, `src/sources`, and `tests`.
  Any repository-wide matches are reviewed against the base so Task 7 adds no
  unfinished implementation marker.

## GREEN evidence

Focused GREEN results on the final-fix tree:

- `TZ=Pacific/Kiritimati npx vitest run
  tests/unit/sources/publication-collector.test.ts
  tests/unit/sources/reviewed-publication-feed.test.ts
  tests/unit/sources/reviewed-publication-profiles.test.ts
  tests/unit/editorial/research-identity.test.ts` — 4 files, 107 tests passed.
- `npx vitest run --config vitest.worker.config.ts
  tests/integration/db/non-arxiv-research-source-migration.test.ts` — 1 file,
  49 tests passed on the approved local loopback rerun.
- `npx vitest run --config vitest.worker.config.ts
  tests/integration/workflow/manual-run.test.ts -t
  "non-arXiv|reviewed publication|quiet source|unsupported media|duplicate commentary|PapersWithCode"`
  — 9 production-wiring cases passed.

Final verification commands and final-tree counts:

| Command | Result |
| --- | --- |
| `npm test` | 47 files, 1,049 tests passed on the approved loopback rerun |
| `npm run test:worker` | 13 files, 340 tests passed |
| `npm run check` | `tsc --noEmit` completed with no errors |
| `npm run evaluate` | Every golden-set assertion passed; precision@5 `1.00`, duplicate-cluster recall `1.00`, missing support IDs `0` |
| `npm run build` | Vite production build passed; 53 modules transformed |
| `git diff --check 5486b75..HEAD` plus working-tree check | No whitespace errors |

The full `npm test` command used approved local loopback access because the
managed OAuth suite opens a listener. Worker/D1 commands likewise use approved
local Miniflare loopback access only; they use isolated `DB` and `UPGRADE_DB`
bindings, not a shared database. Worker output contains existing transitive
`htmlparser2`/`domutils` missing-source sourcemap notices and no test failure.

## Deferred-minor adjudication

- `settleObservedCollectionBatch` runtime validation remains deferred. Its
  callback is an internal typed contract, its current callers derive bounded
  integer counts from array lengths, and the persisted diagnostic schema still
  rejects invalid funnel values. Adding a new coercion or failure policy would
  change behavior rather than merely harden tests; the audit found no current
  unvalidated provider-controlled path into `observed`.
- Atom category-term coverage is closed by the mutation-proven feed test.
- Both directions of partial split-policy preservation are closed for every
  affected source.
- Direct both-policy-absent upgrade coverage is closed for Papers with Code and
  DeepMind, matching the existing Anthropic and Google Research cases.
- Custom discovery-mechanism preservation is now direct and mutation-proven for
  every affected migration update.

## Implementer self-review and remaining gate

The implementer re-read the approved design, implementation plan, task reports,
source contracts, migrations, focused tests, production-context scenarios, and
the complete `5486b75..HEAD` file list. The observed-count findings and the
final-review findings were addressed with strict failing tests and
focused/full GREEN runs. No implementer-known Critical or Important issue
remains.

The controller retained ownership of the final scoped read-only review. This
implementer report makes no independent-review verdict claim. Push, PR
creation, deployment, shared-D1 migration execution, and any paid canary remain
outside this audit.
