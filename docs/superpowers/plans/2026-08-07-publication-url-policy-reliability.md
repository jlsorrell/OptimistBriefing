# Publication URL Policy Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore valid Alignment Forum, LessWrong, MIT, and official publication discovery by authorizing collection endpoints separately from extracted article links.

**Architecture:** Migrate catalog restrictions to explicit `feedUrlPolicy` and `articleUrlPolicy` objects, then require both policies in publication collector construction. Use the endpoint policy for RSS/listing fetches and the article policy for extracted links, redirects, and body fetches; update OpenAI's official publication index while keeping its lane fail-open.

**Tech Stack:** TypeScript 5.8, Cloudflare D1/SQLite JSON functions, Zod 3, fast-xml-parser 5, linkedom 0.18, Vitest 4.

**Design specification:** `docs/superpowers/specs/2026-08-07-research-relevance-and-source-reliability-design.md`

## Global Constraints

- Every outbound URL and every redirect hop remains HTTPS-only and is checked by `assertSafeOutboundUrl`.
- `feedUrlPolicy` authorizes only the configured RSS, Atom, or listing endpoint.
- `articleUrlPolicy` authorizes only links and detail pages extracted from that endpoint.
- Missing or invalid policies fail the affected catalog lane closed; other sources continue.
- Alignment Forum articles may use `/posts/` on `www.alignmentforum.org` or `www.lesswrong.com`.
- MIT's endpoint remains under `/rss/`; MIT articles remain on `news.mit.edu` and current-year-style `/202...` paths.
- OpenAI uses `https://openai.com/research/index/publication/`; `403` and anti-bot responses remain isolated fail-open source outcomes.
- Do not bypass anti-bot controls, impersonate a browser, use a mirror, or relax host/port checks.
- Preserve existing content-use, body-retrieval, paywall, retention, and section-eligibility restrictions.
- Use strict TDD and commit each independently passing task.
- Do not deploy or run a paid preview canary without separate authorization.

---

### Task 1: Catalog policy migration

**Files:**
- Create: `src/db/migrations/0011_split_publication_url_policies.sql`
- Create: `tests/integration/db/publication-url-policy-migration.test.ts`

**Interfaces:**
- Produces: `restrictions.feedUrlPolicy` and `restrictions.articleUrlPolicy` for catalog rows that already have `urlPolicy`.
- Preserves: legacy `restrictions.urlPolicy` for readers outside the publication collector during this stage.

- [ ] **Step 1: Write the failing migration tests**

Create the Worker integration test with this migration harness:

```ts
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { D1BriefingRepository } from "../../../src/db/d1-repository";

declare module "cloudflare:test" {
  interface ProvidedEnv { UPGRADE_DB: D1Database; }
}

function requiredMigration(name: string): D1Migration {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === name);
  if (migration === undefined) throw new TypeError(`Missing migration: ${name}`);
  return migration;
}

async function source(id: string, database = env.UPGRADE_DB) {
  const found = (await new D1BriefingRepository(database).listSources())
    .find((entry) => entry.id === id);
  if (found === undefined) throw new TypeError(`Missing source: ${id}`);
  return found;
}

const PRE_0011 = env.TEST_MIGRATIONS.filter(
  ({ name }) => name <= "0010_release_terminal_model_reservations.sql",
);
```

Inside each test, apply `PRE_0011`, inspect or customize the source, then apply
`requiredMigration("0011_split_publication_url_policies.sql")` and assert:

```ts
expect((await source("alignment-forum", env.UPGRADE_DB)).restrictions)
  .toMatchObject({
    feedUrlPolicy: {
      allowedHosts: ["www.alignmentforum.org"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/feed.xml"],
    },
    articleUrlPolicy: {
      allowedHosts: ["www.alignmentforum.org", "www.lesswrong.com"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/posts/"],
    },
  });

expect((await source("mit-research", env.UPGRADE_DB)).restrictions)
  .toMatchObject({
    feedUrlPolicy: {
      allowedHosts: ["news.mit.edu"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/rss/"],
    },
    articleUrlPolicy: {
      allowedHosts: ["news.mit.edu"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/202"],
    },
  });

expect((await source("openai", env.UPGRADE_DB)).restrictions.pageUrl)
  .toBe("https://openai.com/research/index/publication/");
```

Also assert LessWrong gets its own feed endpoint and `/posts/` article policy,
every migrated publication source has both policy objects, a pre-existing
custom split policy is preserved, and applying `0011` twice is idempotent.

- [ ] **Step 2: Run the Worker test and confirm RED**

Run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/db/publication-url-policy-migration.test.ts
```

Expected: FAIL because migration `0011` and the split policy fields do not
exist.

- [ ] **Step 3: Implement the idempotent migration**

Create `0011_split_publication_url_policies.sql` with a general compatibility
copy followed by reviewed source-specific overrides:

```sql
UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy', json(json_extract(restrictions_json, '$.urlPolicy')),
  '$.articleUrlPolicy', json(json_extract(restrictions_json, '$.urlPolicy'))
)
WHERE json_type(restrictions_json, '$.urlPolicy') = 'object'
  AND json_type(restrictions_json, '$.feedUrlPolicy') IS NULL
  AND json_type(restrictions_json, '$.articleUrlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["www.alignmentforum.org"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["www.alignmentforum.org","www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/posts/"]}')
)
WHERE id = 'alignment-forum'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'www.alignmentforum.org';

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/posts/"]}')
)
WHERE id = 'lesswrong-curated'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'www.lesswrong.com';

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["news.mit.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/rss/"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["news.mit.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/202"]}')
)
WHERE id = 'mit-research'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'news.mit.edu';

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.pageUrl', 'https://openai.com/research/index/publication/',
  '$.feedUrlPolicy',
    json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research/index/publication/"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/index/","/research/"]}')
)
WHERE id = 'openai'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'openai.com';
```

The host predicates update the known legacy/default policies and leave a custom
operator policy unchanged. The test fixture must prove that behavior and that
reapplying the migration preserves the desired split values.

- [ ] **Step 4: Verify and commit the migration**

Run:

```bash
npx vitest run --config vitest.worker.config.ts tests/integration/db/publication-url-policy-migration.test.ts tests/integration/db/research-discovery-source-migration.test.ts
git add src/db/migrations/0011_split_publication_url_policies.sql tests/integration/db/publication-url-policy-migration.test.ts
git commit -m "fix: split publication endpoint and article policies"
```

Expected: both migration suites pass and repeated migration application is
stable.

---

### Task 2: Enforce split policies in publication collectors

**Files:**
- Modify: `src/sources/publication-collector.ts`
- Modify: `src/sources/publication-page.ts`
- Modify: `tests/unit/sources/publication-collector.test.ts`

**Interfaces:**
- Consumes: catalog `feedUrlPolicy` and `articleUrlPolicy` from Task 1.
- Changes: `PublicationPageAdapter` constructor to `(http, source, pageUrl, pageUrlPolicy, articleUrlPolicy, listing?)`.
- Preserves: `RssAdapter`'s existing separate `feedUrlPolicy` and `articleUrlPolicy` interface.

- [ ] **Step 1: Write failing policy-separation tests**

Update publication source fixtures to carry both policy fields. Add this helper
and the acceptance test:

```ts
function rssHttp(articleUrl: string): SourceHttpClient {
  const rss = `<?xml version="1.0"?><rss><channel><item>
    <title>Task gaming in aligned models</title>
    <link>${articleUrl}</link>
    <guid>task-gaming</guid>
    <pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate>
    <description>We present a substantive alignment result.</description>
  </item></channel></rss>`;
  return new SourceHttpClient({
    fetch: vi.fn(async () => new Response(rss, {
      headers: { "content-type": "application/rss+xml" },
    })),
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
}

it("accepts a LessWrong article emitted by the Alignment Forum feed", async () => {
  const forum = rssSource({
    restrictions: {
      ...rssSource().restrictions,
      feedUrlPolicy: {
        allowedHosts: ["www.alignmentforum.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/feed.xml"],
      },
      articleUrlPolicy: {
        allowedHosts: ["www.alignmentforum.org", "www.lesswrong.com"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/posts/"],
      },
    },
  });
  const result = await createPublicationCollectorFromCatalog({
    http: rssHttp("https://www.lesswrong.com/posts/example/task-gaming"),
    sources: [forum],
  }).collect(window);
  expect(result.failures).toEqual([]);
  expect(result.candidates[0]?.originalUrl)
    .toBe("https://www.lesswrong.com/posts/example/task-gaming");
});
```

Add the inverse checks: the LessWrong article URL cannot be used as the feed
endpoint; an unrelated article host is skipped; a listing endpoint redirect is
checked with the endpoint policy; an article redirect is checked with the
article policy; and missing either split policy produces one bounded parse or
policy lane failure while a healthy sibling source succeeds.

Add an MIT feed fixture whose item link is
`https://news.mit.edu/2026/example-ai-research-0807` and assert it survives.

- [ ] **Step 2: Confirm the focused tests are RED**

Run:

```bash
npx vitest run tests/unit/sources/publication-collector.test.ts -t "policy|Alignment Forum|MIT|LessWrong"
```

Expected: the catalog factory still passes one `urlPolicy` to both boundaries,
and the page adapter cannot express separate policies.

- [ ] **Step 3: Parse and thread the two policies**

In `createPublicationCollectorFromCatalog`, replace the single policy read with:

```ts
const feedUrlPolicy = CatalogPolicySchema.parse(
  source.restrictions.feedUrlPolicy,
) as OutboundUrlPolicy;
const articleUrlPolicy = CatalogPolicySchema.parse(
  source.restrictions.articleUrlPolicy,
) as OutboundUrlPolicy;
```

For RSS, pass them to their matching existing fields. For page discovery,
construct:

```ts
new PublicationPageAdapter(
  options.http,
  collectionSource,
  z.string().min(1).parse(source.restrictions.pageUrl),
  feedUrlPolicy,
  articleUrlPolicy,
  source.restrictions.listing,
)
```

In `PublicationPageAdapter`, validate and fetch `pageUrl` with
`pageUrlPolicy`. Validate every listing/JSON-LD/fallback article URL and every
detail fetch with `articleUrlPolicy`. Keep `response.finalUrl` as the relative
URL base only after the HTTP client has validated the redirect under the
endpoint policy. Detail fetch redirects remain under the article policy.

Do not fall back to `restrictions.urlPolicy`; Task 1 guarantees migrated
catalog rows and malformed custom rows must fail closed.

- [ ] **Step 4: Verify and commit collector enforcement**

Run:

```bash
npx vitest run tests/unit/sources/publication-collector.test.ts
npm run check
git add src/sources/publication-collector.ts src/sources/publication-page.ts tests/unit/sources/publication-collector.test.ts
git commit -m "fix: enforce split publication URL policies"
```

Expected: valid Alignment Forum/LessWrong and MIT entries survive while the
negative policy cases remain blocked.

---

### Task 3: OpenAI fail-open and full policy regression gate

**Files:**
- Modify: `tests/unit/sources/publication-collector.test.ts`
- Verify: `src/sources/collection-settlement.ts`

**Interfaces:**
- Consumes: Task 1 migration and Task 2 collector behavior.
- Produces: isolated sanitized failure behavior for the updated OpenAI lane.

- [ ] **Step 1: Add the OpenAI `403` regression**

Add a catalog source using the new OpenAI page and split policies. Mock its
listing request with `new Response("blocked", { status: 403 })`, add a healthy
RSS sibling, and assert:

```ts
expect(result.failures).toContainEqual({ sourceId: "openai", kind: "fetch" });
expect(result.candidates).toEqual([
  expect.objectContaining({ sourceId: "healthy-publication" }),
]);
expect(JSON.stringify(result)).not.toContain("blocked");
```

- [ ] **Step 2: Run the focused fail-open test**

Run:

```bash
npx vitest run tests/unit/sources/publication-collector.test.ts -t "OpenAI|403"
```

Expected after Tasks 1–2: PASS without changing settlement code. If it fails,
make the minimum collector-boundary correction that preserves the existing
`CollectionFailureKind` mapping and rerun the test.

- [ ] **Step 3: Run the full verification ladder**

Run:

```bash
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
git diff --check
```

Expected: all commands pass. No live source fetch, deployment, or preview
canary is part of this stage.

- [ ] **Step 4: Commit the fail-open regression**

Run:

```bash
git add tests/unit/sources/publication-collector.test.ts src/sources/collection-settlement.ts
git commit -m "test: preserve publication source failure isolation"
```

If `src/sources/collection-settlement.ts` is unchanged, stage only the test
file. Do not create an empty commit.
