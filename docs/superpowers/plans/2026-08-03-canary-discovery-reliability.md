# Canary Discovery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore useful, explainable research discovery in preview while preventing unrelated government notices from entering AI Policy.

**Architecture:** Add a secret-aware request option at the shared HTTP boundary, then make every OpenAlex adapter consume an optional encrypted Worker secret without making OpenAlex a hard dependency. Normalize RSS/Atom entries independently, centralize the AI-policy evidence gate, and track bounded terminal rejection reasons beside the monotone discovery funnel. Persist the extension in existing run-detail JSON and render it only on authenticated Run Status.

**Tech Stack:** TypeScript 5.8, Cloudflare Workers/Workflows and D1, React 19, Zod 3, fast-xml-parser 5, Vitest 4, Wrangler 4.

## Global Constraints

- Use strict TDD: failing focused test, observed failure, minimum implementation, passing focused test, then commit.
- Preserve `assessed <= triaged <= deduplicated <= discovered` for every lane.
- Keep `OPENALEX_API_KEY` optional and encrypted; never print, persist, audit, snapshot, commit, or return its value.
- Do not use unauthenticated OpenAlex fallback, pagination, or retries for missing/rejected/quota-limited credentials.
- Bound OpenAlex discovery to `per_page=100` and enrichment to `per_page=50`.
- Preserve all existing quality, grounding, coverage, budget, authentication, source-policy, and publication gates.
- AI Policy requires both explicit AI evidence and explicit policy-action evidence in retained title/abstract/content.
- Feed envelopes fail closed; invalid individual entries are skipped while valid siblings survive.
- Rejection diagnostics are aggregated and observational only; they must not change decisions or ordering.
- Add no D1 migration: diagnostics are already stored as bounded JSON and old records must default to empty rejection counts.
- Preview deployment and a paid canary each require separate explicit approval.

---

### Task 1: Secret-aware source HTTP requests

**Files:**
- Modify: `src/sources/http-client.ts:32-43,211-246,274-477`
- Test: `tests/unit/sources/research-collector.test.ts:1186-1425`

**Interfaces:**
- Consumes: existing `SourceHttpClient.get(source, url, options)`.
- Produces: `SourceRequestOptions` with `sensitiveQueryParameters?: readonly string[]` and `maxRetries?: number`.
- Produces: redacted validator identity and `finalUrl`; cross-origin redirects reject sensitive query transmission.

- [ ] **Step 1: Write failing boundary tests**

Add these cases to the existing `describe("SourceHttpClient", ...)` block:

```ts
it("transmits but never returns a sensitive query value", async () => {
  const secret = "fixture-openalex-key";
  const fetch = vi.fn(async (input: string | URL | Request) => {
    expect(new URL(String(input)).searchParams.get("api_key")).toBe(secret);
    return new Response("ok", { headers: { etag: '"v1"' } });
  });
  const response = await new SourceHttpClient({ fetch }).get(
    openAlexSource,
    `https://api.openalex.org/works?search=alignment&api_key=${secret}`,
    { sensitiveQueryParameters: ["api_key"] },
  );
  expect(response.finalUrl).toContain("api_key=REDACTED");
  expect(JSON.stringify(response)).not.toContain(secret);
});

it("rejects cross-origin redirects carrying a sensitive query", async () => {
  const fetch = vi.fn(async () => new Response(null, {
    status: 302,
    headers: { location: "https://cdn.example.net/works" },
  }));
  await expect(new SourceHttpClient({ fetch }).get(
    openAlexSource,
    "https://api.openalex.org/works?api_key=fixture-openalex-key",
    { sensitiveQueryParameters: ["api_key"] },
  )).rejects.toMatchObject({ failureKind: "policy", retryable: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("honors a request-local zero-retry limit", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 429 }));
  const sleep = vi.fn(async () => undefined);
  await expect(new SourceHttpClient({ fetch, sleep, maxRetries: 2 }).get(
    openAlexSource,
    "https://api.openalex.org/works",
    { maxRetries: 0 },
  )).rejects.toMatchObject({ status: 429 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it("reuses validators without putting secret values in their identity", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("first", { headers: { etag: '"v1"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const http = new SourceHttpClient({ fetch });
  await http.get(openAlexSource, "https://api.openalex.org/works?api_key=first-fixture", {
    sensitiveQueryParameters: ["api_key"],
  });
  await http.get(openAlexSource, "https://api.openalex.org/works?api_key=second-fixture", {
    sensitiveQueryParameters: ["api_key"],
  });
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("if-none-match"))
    .toBe('"v1"');
});
```

- [ ] **Step 2: Observe the expected failure**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "sensitive query|request-local zero-retry"
```

Expected: the option type is rejected or the key appears in `finalUrl`.

- [ ] **Step 3: Implement the boundary**

Use this option and helper:

```ts
export type SourceRequestOptions = {
  headers?: HeadersInit;
  useValidators?: boolean;
  urlPolicy?: OutboundUrlPolicy;
  sensitiveQueryParameters?: readonly string[];
  maxRetries?: number;
};

function redactedUrl(input: URL, names: readonly string[]): string {
  const output = new URL(input);
  for (const name of names) {
    if (output.searchParams.has(name)) output.searchParams.set(name, "REDACTED");
  }
  return output.toString();
}
```

Thread both fields through `get`/`RequestOptions`. Validate local `maxRetries` as an integer from 0 through 5. Build `validatorKey` from `redactedUrl(initialUrl, sensitiveNames)`, loop through `options.maxRetries ?? this.maxRetries`, and return a redacted `finalUrl` for both 304 and success. Reject a cross-origin redirect before following it when the current URL contains any named sensitive parameter. Keep all error messages URL-free.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "SourceHttpClient"
npm run check
git add src/sources/http-client.ts tests/unit/sources/research-collector.test.ts
git commit -m "fix: protect sensitive source query parameters"
```

Expected: all HTTP boundary tests and type checking pass.

---

### Task 2: Authenticated bounded OpenAlex discovery

**Files:**
- Modify: `src/worker.ts:9-23`
- Modify: `src/workflow/daily-briefing-workflow.ts:34-53,215-303,317-337`
- Modify: `src/workflow/run-editorial-pipeline.ts:867-909,2172-2260`
- Modify: `src/sources/paper-discovery.ts:62-130`
- Modify: `src/sources/openalex.ts:260-520`
- Modify: `.dev.vars.example`
- Test: `tests/unit/sources/research-collector.test.ts:900-1130,1540-1615`
- Test: `tests/integration/workflow/resume.test.ts:1080-1170`
- Test: `tests/integration/workflow/manual-run.test.ts:3000-3335`

**Interfaces:**
- Consumes: Task 1 request options.
- Produces: `OpenAlexRequestOptions = { apiKey?: string }`.
- Produces: `createPaperDiscoveryAdapters(http, sources, { openAlexApiKey? })`.
- Extends: optional `OPENALEX_API_KEY` through `Env`, runtime config, `PipelineRuntime`, and `ProductionPipelineContextOptions`.

- [ ] **Step 1: Write failing request-contract tests**

Update OpenAlex constructor fixtures to use `{ apiKey: "fixture-openalex-key" }`, then add:

```ts
it("uses the authenticated free-tier contract for updated discovery", async () => {
  const seen: URL[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    seen.push(new URL(String(input)));
    return Response.json({ results: [] });
  });
  const adapter = new OpenAlexDiscoveryAdapter(
    new SourceHttpClient({ fetch }), openAlexSource,
    { laneId: "openalex:updated:alignment", mode: "updated", query: "alignment" },
    { apiKey: "fixture-openalex-key" },
  );
  await adapter.collect(fixedWindow());
  expect(seen).toHaveLength(1);
  expect(seen[0]?.searchParams.get("api_key")).toBe("fixture-openalex-key");
  expect(seen[0]?.searchParams.get("per_page")).toBe("100");
  expect(seen[0]?.searchParams.has("per-page")).toBe(false);
  expect(seen[0]?.searchParams.get("sort")).toBe("updated_date:desc");
  expect(seen[0]?.searchParams.get("filter") ?? "").not.toMatch(/updated_date/);
});
```

Add a collector case with one healthy arXiv adapter and keyless OpenAlex adapters. Assert the arXiv paper survives and OpenAlex records a sanitized `policy` failure. In `resume.test.ts`, assert omission succeeds and a supplied value trims. In `manual-run.test.ts`, assert runtime wiring sends the fixture key but saved run detail does not contain it.

- [ ] **Step 2: Observe focused failures**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "OpenAlex|openalex"
npx vitest run tests/integration/workflow/resume.test.ts -t "configuration"
```

Expected: constructors/runtime lack the key, `per-page` is used, and updated filters are present.

- [ ] **Step 3: Implement the OpenAlex request helper**

Import `SourceFetchError` and add:

```ts
export type OpenAlexRequestOptions = { apiKey?: string };

function configuredApiKey(options: OpenAlexRequestOptions): string {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new SourceFetchError({
    sourceId: "openalex", status: null, retryable: false,
    failureKind: "policy", reason: "provider credential unavailable",
  });
  return apiKey;
}
```

Add `requestOptions` as the fourth constructor argument to `OpenAlexDiscoveryAdapter`; preserve the enricher endpoint as argument three and add `requestOptions` as argument four to `OpenAlexAdapter`. Every `/works` and `/institutions` request must append `api_key` immediately before `http.get` and use:

```ts
{
  useValidators: false,
  urlPolicy: OPENALEX_DISCOVERY_POLICY,
  sensitiveQueryParameters: ["api_key"],
  maxRetries: 0,
}
```

Use the narrower policy in the enricher. Replace `per-page` with `per_page`. Updated lanes use `search`, `sort=updated_date:desc`, `select`, and `per_page=100` with no updated-date filter; retain the local seven-day `updated_date` check. Text/institution lanes retain publication-date filters and local validation.

- [ ] **Step 4: Thread the optional secret through runtime**

Use these shapes:

```ts
// Add this field to the existing Env interface without changing its required fields.
OPENALEX_API_KEY?: string;

OPENALEX_API_KEY: z.string().trim().min(1).max(4_096).optional(),

export type PipelineRuntime = {
  providers: PipelineProviders;
  budgetPolicy?: BudgetPolicy;
  openAlexApiKey?: string;
};

export function createPaperDiscoveryAdapters(
  http: SourceHttpClient,
  sources: readonly ResearchSourceInput[],
  options: { openAlexApiKey?: string } = {},
): readonly DiscoverySourceAdapter[]
```

Extend `ProductionPipelineContextOptions` with `openAlexApiKey?: string`. Forward it from the budgeted runtime through scheduled/manual launchers, then into every discovery adapter and `OpenAlexAdapter`. Absence must create bounded OpenAlex failures rather than aborting the other collectors.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "OpenAlex|openalex"
npx vitest run tests/integration/workflow/resume.test.ts -t "configuration"
npx vitest run tests/integration/workflow/manual-run.test.ts -t "discovery diagnostics"
npx vitest run tests/unit/sources
npm run check
git add src/worker.ts src/workflow/daily-briefing-workflow.ts src/workflow/run-editorial-pipeline.ts src/sources/paper-discovery.ts src/sources/openalex.ts .dev.vars.example tests/unit/sources/research-collector.test.ts tests/integration/workflow/resume.test.ts tests/integration/workflow/manual-run.test.ts
git commit -m "fix: authenticate bounded OpenAlex discovery"
```

Expected: all commands pass; no key appears outside bounded test fixtures.

---

### Task 3: Resilient RSS and Atom normalization

**Files:**
- Modify: `src/sources/rss.ts:21-190`
- Create: `tests/fixtures/alignment-forum-feed.xml`
- Create: `tests/fixtures/atom-research-feed.xml`
- Test: `tests/unit/sources/publication-collector.test.ts:1-380`

**Interfaces:**
- Consumes/retains: `RssAdapter.collect(window): Promise<CollectionBatch<RawItem>>`.
- Produces internally: `NormalizedFeedEntry` and `normalizeFeedEntry(value)`.

- [ ] **Step 1: Add sanitized fixtures and failing tests**

The Alignment Forum fixture contains one valid structured-link item and one malformed-link sibling. The Atom fixture contains `feed.entry`, link `href`, structured `author.name`, `id`, `published`, and `summary`. Add assertions:

```ts
expect(rssResult.failures).toEqual([]);
expect(rssResult.candidates).toHaveLength(1);
expect(rssResult.candidates[0]).toMatchObject({
  title: "A valid alignment result",
  authors: ["Researcher Example"],
});
expect(atomResult.candidates[0]).toMatchObject({
  externalId: "urn:example:atom-result",
  publishedAt: "2026-08-02T12:00:00.000Z",
});
expect(noValidEntries.failures).toEqual([
  { sourceId: "lesswrong-curated", kind: "parse" },
]);
```

Use local helpers built from existing source policies and `loadFixture`.

- [ ] **Step 2: Observe strict parser failures**

Run:

```bash
npx vitest run tests/unit/sources/publication-collector.test.ts -t "structured-link|Atom|no interpretable"
```

Expected: alternate RSS shapes and Atom fail, or the malformed sibling discards the lane.

- [ ] **Step 3: Implement envelope and per-entry normalization**

Replace whole-document item parsing with:

```ts
type NormalizedFeedEntry = {
  title: string;
  link: string;
  identifier?: string;
  published?: string;
  author?: string;
  description?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function feedEntries(value: unknown): unknown[] {
  const root = record(value);
  const channel = record(record(root?.rss)?.channel);
  if (channel) return asArray(channel.item);
  const feed = record(root?.feed);
  if (feed) return asArray(feed.entry);
  throw new SyntaxError("Unsupported feed envelope.");
}
```

Bounded helpers accept string, `#text`, `href`/`@_href`, or arrays. Prefer an HTTP(S) link with absent/`alternate`/`canonical` rel. Author accepts string, `name`, or `#text`; content accepts `encoded`, `description`, `summary`, or `content`; timestamps accept `pubDate`, `published`, or `updated`. Skip invalid entries independently. A nonempty envelope with zero safe normalized entries throws `SyntaxError("No interpretable feed entries.")`; an empty valid feed returns `[]`. Preserve URL policy, time window, evidence-size bound, metadata-only behavior, and `relatedArxivIds`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx vitest run tests/unit/sources/publication-collector.test.ts
npm run check
git add src/sources/rss.ts tests/fixtures/alignment-forum-feed.xml tests/fixtures/atom-research-feed.xml tests/unit/sources/publication-collector.test.ts
git commit -m "fix: normalize resilient research feeds"
```

Expected: all publication collector tests pass and fixtures contain only example data.

---

### Task 4: Deterministic AI Policy evidence gate

**Files:**
- Modify: `src/sources/news-signals.ts:35-50,943-1080`
- Modify: `src/editorial/route-publication.ts:1-120`
- Test: `tests/unit/sources/news-signals.test.ts:1-420`
- Test: `tests/unit/editorial/route-publication.test.ts`
- Test: `tests/unit/sources/news-collector.test.ts`

**Interfaces:**
- Produces: `hasExplicitAiPolicyEvidence(values: readonly (string | null | undefined)[]): boolean`.
- Extends: `derivePrimarySection(title, sectionEligibility, namedEntities, kind, preferredSection, aiPolicyEvidence: boolean)`.
- Consumes: the same boolean in news derivation and publication routing.

- [ ] **Step 1: Write failing precision/recall tests**

Assert the two canary titles, a general audit notice, and an AI product launch do not route to AI Policy even with `preferredSection: "ai_policy"`. Assert these do route: frontier-model evaluation bill, AI training-compute reporting rule, secure foundation-model evaluation standard, automated-decision-system procurement rule. Add an official-publication case whose abstract—not title—contains both kinds of evidence.

```ts
expect(primary("National Center for Advancing Translational Sciences; Notice of Meeting"))
  .not.toBe("ai_policy");
expect(primary("Formations of, Acquisitions by, and Mergers of Bank Holding Companies"))
  .not.toBe("ai_policy");
expect(primary("Senate bill requires frontier AI model evaluations"))
  .toBe("ai_policy");
```

- [ ] **Step 2: Observe existing false positives**

Run:

```bash
npx vitest run tests/unit/sources/news-signals.test.ts -t "AI Policy|policy evidence"
npx vitest run tests/unit/editorial/route-publication.test.ts -t "AI Policy|canary"
npx vitest run tests/unit/sources/news-collector.test.ts -t "preferredSection"
```

Expected: preferred-section/governance-only inputs enter AI Policy.

- [ ] **Step 3: Implement one shared predicate**

```ts
const EXPLICIT_AI_EVIDENCE = /\b(?:artificial intelligence|AI (?:systems?|models?|governance|training|inference)|machine learning|foundation models?|frontier models?|generative AI|automated decision systems?|neural networks?|compute governance|model evaluations?|algorithmic accountability)\b/i;
const EXPLICIT_POLICY_ACTION = /\b(?:legislation|bill|regulation|rulemaking|rule (?:requires?|mandates?|governs?)|executive order|standards?|audit (?:requirement|mandate)|requires? audits?|evaluation policy|enforcement|oversight|accountability|procurement rule|reporting obligation|treaty)\b/i;

export function hasExplicitAiPolicyEvidence(
  values: readonly (string | null | undefined)[],
): boolean {
  const material = values.filter((v): v is string => typeof v === "string")
    .join("\n").slice(0, 12_000);
  return EXPLICIT_AI_EVIDENCE.test(material) && EXPLICIT_POLICY_ACTION.test(material);
}
```

Compute once in `deriveNewsSignals` from title/abstract/content. Preferred `ai_policy`, the direct AI-policy branch, and fallback `ai_policy` all require the boolean; fallback order without evidence is `world`, `technology`, `dmv`, `baltimore`, then `world`. Delete `route-publication.ts`'s local `GOVERNANCE`; require the shared predicate before its AI-policy route. Keep research/technology rules unchanged.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx vitest run tests/unit/sources/news-signals.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/sources/news-collector.test.ts tests/unit/editorial/pipeline.test.ts
npm run check
git add src/sources/news-signals.ts src/editorial/route-publication.ts tests/unit/sources/news-signals.test.ts tests/unit/editorial/route-publication.test.ts tests/unit/sources/news-collector.test.ts
git commit -m "fix: require explicit AI policy evidence"
```

Expected: routing suites pass without lowered section/coverage thresholds.

---

### Task 5: Bounded rejection contract, attribution, persistence, and UI

**Files:**
- Create: `src/workflow/discovery-diagnostics.ts`
- Modify: `src/sources/types.ts:150-185`
- Modify: `src/editorial/research-triage.ts:22-44,270-425`
- Modify: `src/workflow/run-editorial-pipeline.ts:1010-1065,1390-1730,1815-1930,2010-2080`
- Modify: `src/db/repository.ts:600-635`
- Modify: `src/db/d1-repository.ts:2165-2200`
- Modify: `src/web/pages/RunStatusPage.tsx:175-215`
- Create: `tests/unit/workflow/discovery-diagnostics.test.ts`
- Test: `tests/unit/editorial/research-triage.test.ts`
- Test: `tests/unit/contracts/editorial.test.ts:175-215`
- Test: `tests/integration/db/repository.test.ts:1560-1620`
- Test: `tests/integration/workflow/manual-run.test.ts:1250-1490,3000-3335`
- Test: `tests/unit/web/RunStatusPage.test.tsx:215-275`

**Interfaces:**
- Produces: `DiscoveryRejectionReasonSchema`, `DiscoveryRejectionCountsSchema`, `DiscoveryDiagnosticRef`, `DiscoveryDiagnosticsTracker`, `classifyDiscoveryWindowDecision`.
- Extends: `DiscoveryLaneDiagnostic.rejectionCounts`, defaulting old JSON to `{}`.
- Preserves: existing `classifyDiscoveryWindow` wrapper and all editorial outputs.

- [ ] **Step 1: Write failing contract and compatibility tests**

Assert an old diagnostic parses with `{}`, fixed reasons round-trip, and unknown/negative/fractional/>10,000 counts reject:

```ts
expect(DiscoveryLaneDiagnosticSchema.parse(diagnostic).rejectionCounts).toEqual({});
expect(DiscoveryLaneDiagnosticSchema.safeParse({
  ...diagnostic,
  rejectionCounts: { unchanged_observation: 2, capacity_limited: 1 },
}).success).toBe(true);
expect(DiscoveryLaneDiagnosticSchema.safeParse({
  ...diagnostic,
  rejectionCounts: { private_provider_error: 1 },
}).success).toBe(false);
```

Repository integration inserts old JSON without the field and then round-trips the two nonzero reasons. UI expects a `Rejections` column reading `Unchanged observation: 2; Capacity limited: 1`, never dynamic/private fields.

- [ ] **Step 2: Write failing attribution tests**

Tracker tests cover unique/idempotent counts, unknown lanes, 10,000 cap, stable sorting, and funnel monotonicity. Triage tests assert:

```ts
expect(classifyDiscoveryWindowDecision(oldItem, [], now)).toEqual({
  windowKind: null, rejectionReason: "out_of_window",
});
expect(classifyDiscoveryWindowDecision(repeatedItem, [matchingObservation], now)).toEqual({
  windowKind: null, rejectionReason: "unchanged_observation",
});
```

Manual-run fixture includes a routed-out publication, repeat observation, aliases for one paper, below-fit paper, and capacity overflow. Assert exact reason counts, unchanged selected IDs, and monotone funnel counts.

- [ ] **Step 3: Observe missing schema/tracker behavior**

Run:

```bash
npx vitest run tests/unit/contracts/editorial.test.ts -t "diagnostic"
npx vitest run tests/unit/workflow/discovery-diagnostics.test.ts
npx vitest run tests/unit/editorial/research-triage.test.ts -t "window decision"
npx vitest run tests/integration/db/repository.test.ts -t "discovery diagnostics"
npx vitest run tests/unit/web/RunStatusPage.test.tsx -t "bounded discovery"
```

Expected: the new fields/exports/UI are absent.

- [ ] **Step 4: Implement the fixed schema**

```ts
export const DiscoveryRejectionReasonSchema = z.enum([
  "out_of_window", "unchanged_observation", "identity_merged",
  "route_excluded", "topic_mismatch", "quality_rejected", "capacity_limited",
]);
export type DiscoveryRejectionReason = z.infer<typeof DiscoveryRejectionReasonSchema>;
const Count = z.number().int().nonnegative().max(10_000);
export const DiscoveryRejectionCountsSchema = z.object({
  out_of_window: Count.optional(), unchanged_observation: Count.optional(),
  identity_merged: Count.optional(), route_excluded: Count.optional(),
  topic_mismatch: Count.optional(), quality_rejected: Count.optional(),
  capacity_limited: Count.optional(),
}).strict();
```

Add `rejectionCounts: DiscoveryRejectionCountsSchema.default({})` to the diagnostic schema. Preserve funnel `superRefine`. Update exact-equality fixtures to include `{}`. No migration.

- [ ] **Step 5: Implement the pure tracker**

Implement `src/workflow/discovery-diagnostics.ts` as the complete bounded tracker:

```ts
import {
  DiscoveryLaneDiagnosticSchema,
  type DiscoveryLaneDiagnostic,
  type DiscoveryRejectionReason,
} from "../sources/types";

export type DiscoveryDiagnosticRef = { laneId: string; identity: string };

export class DiscoveryDiagnosticsTracker {
  private diagnostics: DiscoveryLaneDiagnostic[];
  private readonly rejected = new Set<string>();

  constructor(input: readonly DiscoveryLaneDiagnostic[]) {
    this.diagnostics = input.map((value) =>
      DiscoveryLaneDiagnosticSchema.parse(value)
    );
  }

  setStage(
    stage: "deduplicated" | "triaged" | "assessed",
    refs: readonly DiscoveryDiagnosticRef[],
  ): void {
    const identities = this.identitiesByLane(refs);
    this.diagnostics = this.diagnostics.map((diagnostic) => {
      const preceding = stage === "deduplicated"
        ? diagnostic.discovered
        : stage === "triaged"
          ? diagnostic.deduplicated
          : diagnostic.triaged;
      return DiscoveryLaneDiagnosticSchema.parse({
        ...diagnostic,
        [stage]: Math.min(
          preceding,
          identities.get(diagnostic.laneId)?.size ?? 0,
        ),
      });
    });
  }

  reject(
    reason: DiscoveryRejectionReason,
    refs: readonly DiscoveryDiagnosticRef[],
  ): void {
    for (const ref of refs) {
      const diagnostic = this.diagnostics.find(
        ({ laneId }) => laneId === ref.laneId,
      );
      if (!diagnostic) continue;
      const key = `${reason}\u0000${ref.laneId}\u0000${ref.identity}`;
      if (this.rejected.has(key)) continue;
      this.rejected.add(key);
      diagnostic.rejectionCounts[reason] = Math.min(
        10_000,
        (diagnostic.rejectionCounts[reason] ?? 0) + 1,
      );
    }
  }

  snapshot(): DiscoveryLaneDiagnostic[] {
    return this.diagnostics
      .map((value) => DiscoveryLaneDiagnosticSchema.parse(value))
      .sort((left, right) => left.laneId.localeCompare(right.laneId));
  }

  private identitiesByLane(
    refs: readonly DiscoveryDiagnosticRef[],
  ): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const ref of refs) {
      const identities = result.get(ref.laneId) ?? new Set<string>();
      identities.add(ref.identity);
      result.set(ref.laneId, identities);
    }
    return result;
  }
}
```

Internally parse every diagnostic, deduplicate stage refs by `(laneId, identity)`, clamp each stage to its predecessor, deduplicate rejection refs by `(reason, laneId, identity)`, cap at 10,000, ignore unknown lanes, and sort snapshots by lane ID. Identities remain in memory only and never appear in snapshots.

- [ ] **Step 6: Annotate the existing freshness decision**

Add `classifyDiscoveryWindowDecision` returning:

```ts
type DiscoveryWindowDecision = {
  windowKind: "fresh" | "reconsideration" | null;
  rejectionReason: "out_of_window" | "unchanged_observation" | null;
};
```

Move the existing exact age/fingerprint branches into it. Keep `classifyDiscoveryWindow(...)` as a wrapper returning `.windowKind`, so current callers and decisions remain compatible.

- [ ] **Step 7: Attribute each existing terminal decision**

In `run-editorial-pipeline.ts`, convert raw metadata `discoveryLaneIds` and normalized `discoveryLineage` into refs. Stage refs use canonical research identity once per lane; rejection refs retain upstream identity. Replace the local diagnostic update loop with the tracker and persist `snapshot()` through the existing fail-open repository callback.

Record only at the owning branch:

- `route_excluded`: `normalizedCandidate(candidate) === null`.
- `capacity_limited`: omitted by `boundResearchDiscoveryPool`.
- `identity_merged`: all but one upstream identity in each research consolidation/news dedup group.
- `out_of_window` / `unchanged_observation`: detailed freshness decision.
- `topic_mismatch`: triage `below_topical_fit`.
- `quality_rejected`: triage `invalid_content` and assessment `ACCESS_LEVEL_OVERCLAIM`.
- `capacity_limited`: triage family/domain/queue caps, uncached assessment cap, and assessed items absent from shortlist.

Continue stage updates at current deduplicated, triaged, and assessed checkpoints. Swallow observability errors exactly as today. Do not change returned arrays.

- [ ] **Step 8: Render fixed labels**

Add a fixed tuple list in Run Status:

```ts
const REJECTION_LABELS = [
  ["out_of_window", "Out of window"],
  ["unchanged_observation", "Unchanged observation"],
  ["identity_merged", "Identity merged"],
  ["route_excluded", "Route excluded"],
  ["topic_mismatch", "Topic mismatch"],
  ["quality_rejected", "Quality rejected"],
  ["capacity_limited", "Capacity limited"],
] as const;
```

Render only nonzero fixed labels joined by `; `, otherwise `None`. Add no per-candidate drill-down.

- [ ] **Step 9: Verify and commit diagnostics**

Run:

```bash
npx vitest run tests/unit/workflow/discovery-diagnostics.test.ts tests/unit/editorial/research-triage.test.ts tests/unit/contracts/editorial.test.ts tests/integration/db/repository.test.ts tests/integration/workflow/manual-run.test.ts tests/unit/web/RunStatusPage.test.tsx
npx vitest run tests/unit/editorial tests/unit/workflow tests/integration/workflow
npm run check
git add src/workflow/discovery-diagnostics.ts src/sources/types.ts src/editorial/research-triage.ts src/workflow/run-editorial-pipeline.ts src/db/repository.ts src/db/d1-repository.ts src/web/pages/RunStatusPage.tsx tests
git commit -m "feat: explain discovery funnel rejections"
```

Expected: all tests pass, old run details read, and selected content is unchanged.

---

### Task 6: Operations documentation and complete verification

**Files:**
- Modify: `README.md:115-140`
- Modify: `docs/runbooks/deployment.md:160-205,240-285`
- Modify: `docs/runbooks/privacy-and-retention.md:1-35`
- Modify: `docs/runbooks/source-health.md:1-100`
- Test: `tests/unit/config/deployment-safety.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: reviewed branch ready for external setup; does not deploy.

- [ ] **Step 1: Write failing deployment-safety assertions**

```ts
expect(readme).toContain("OPENALEX_API_KEY");
expect(deploymentRunbook).toContain("npx wrangler secret put OPENALEX_API_KEY");
expect(deploymentRunbook).toContain("--keep-vars");
expect(wranglerConfig).not.toContain("OPENALEX_API_KEY");
expect(devVarsExample).toContain("OPENALEX_API_KEY=");
```

Also assert source-health docs name all seven reasons and state empty AI Policy is preferable to unrelated filler.

- [ ] **Step 2: Observe documentation test failure**

Run: `npx vitest run tests/unit/config/deployment-safety.test.ts`

Expected: OpenAlex secret/rejection documentation is absent.

- [ ] **Step 3: Update runbooks**

Document the optional free OpenAlex key, fail-open behavior, seven rejection labels, and AI-policy fail-closed precision. Add only the interactive form:

```bash
npx wrangler secret put OPENALEX_API_KEY --config "$OPTIMIST_PREVIEW_CONFIG"
```

State that the variable resolves to an already-reviewed isolated preview config, the value never belongs in arguments/Git/D1/logs/audits/screenshots, and deployment uses `--keep-vars`.

- [ ] **Step 4: Run full deterministic verification**

```bash
npm test
npm run test:worker
npm run check
npm run evaluate
npm run build
git diff --check
git grep -n -I -E 'sk-[A-Za-z0-9_-]{16,}|OPENALEX_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]+' -- ':!docs/superpowers/plans/2026-08-03-canary-discovery-reliability.md'
```

Expected: all suites/build/evaluation pass; whitespace and secret scans return no findings. `fixture-openalex-key` is allowed only under tests.

- [ ] **Step 5: Commit docs**

```bash
git add README.md docs/runbooks/deployment.md docs/runbooks/privacy-and-retention.md docs/runbooks/source-health.md tests/unit/config/deployment-safety.test.ts
git commit -m "docs: operate reliable research discovery"
git status --short
```

Expected: clean worktree.

---

### Task 7: Separately approved preview deployment and canary

**Files:**
- No repository changes.
- Use: `/private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc`
- Use: authenticated preview `/run-status`.

**Interfaces:**
- Consumes: verified branch and the user's free OpenAlex key.
- Produces: preview version ID and one canary run-detail record; never production mutation.

- [ ] **Step 1: Review before mutation**

Inspect `git log --oneline main..HEAD`, `git diff --stat main...HEAD`, secret call sites, and verification output. Confirm no migration and confirm the config targets only `optimist-briefing-preview`, preview D1, and preview Workflow.

- [ ] **Step 2: Stop for approval and key creation**

Ask the user to create a free OpenAlex key and explicitly approve storing it as the preview Worker's encrypted secret plus deploying this branch. Never request the value in chat.

- [ ] **Step 3: Store interactively, then deploy preview**

After approval:

```bash
export OPTIMIST_PREVIEW_CONFIG=/private/tmp/optimist-briefing-preview-20260731/wrangler.preview.jsonc
npx wrangler secret put OPENALEX_API_KEY --config "$OPTIMIST_PREVIEW_CONFIG"
npm run build
npx wrangler deploy --config "$OPTIMIST_PREVIEW_CONFIG" --keep-vars
```

The user enters the key at Wrangler's hidden prompt. Record the version ID; do not modify production routes/domains/bindings.

- [ ] **Step 4: Stop for separate paid-canary approval**

Explain `POST /api/admin/runs` may incur OpenAI API cost and may publish in isolated preview. Obtain explicit approval for exactly one unused-date canary; never rewrite `2026-07-31`.

- [ ] **Step 5: Run and monitor one authenticated canary**

Start via authenticated Run Status and poll the same run to terminal without duplication. Acceptance requires: one successful OpenAlex lane; Alignment Forum without feed parse failure; two successful research families; one non-arXiv candidate reaching triage unless all are `unchanged_observation`; no AI Policy entry lacking both evidence classes; neither canary false-positive title; all model reservations reconciled/released; unchanged coverage/publication gate.

- [ ] **Step 6: Report and stop before production**

Report version ID, run ID/date/status, family outcomes, rejection counts, section counts, AI-policy manual check, and reservation state. Empty AI Policy plus failed-closed status is correct when no genuine item exists. Production promotion requires a new explicit decision.
