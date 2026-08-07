# Provider Text Entity Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent HTML character references such as `&#8216;` from being persisted or rendered as literal briefing text.

**Architecture:** Add one dependency-free, bounded provider-text decoder and plain-text normalizer. Apply it centrally during candidate normalization and at the RSS/page/article extraction boundaries that currently maintain their own whitespace or tag handling, while leaving URLs and identifiers untouched.

**Tech Stack:** TypeScript 5.8, Zod 3, fast-xml-parser 5, linkedom 0.18, Vitest 4.

**Design specification:** `docs/superpowers/specs/2026-08-07-research-relevance-and-source-reliability-design.md`

## Global Constraints

- Decode only decimal numeric, hexadecimal numeric, and named `amp`, `quot`, `apos`, `lt`, `gt`, and `nbsp` references.
- Reject invalid Unicode scalars, surrogate code points, C0/C1 controls, and values above `U+10FFFF` without throwing.
- Perform at most two decoding passes and inspect at most 100,000 input characters per provider text field.
- Produce plain text only; decoded markup must pass through tag removal and normal UI escaping.
- Do not use `dangerouslySetInnerHTML`, DOM HTML insertion, or a general HTML sanitizer.
- Do not decode URLs, external IDs, credentials, restriction JSON, or structured metadata keys.
- Do not rewrite historical D1 rows or previously published editions.
- Preserve existing provider evidence and extracted-article length bounds.
- Use strict TDD and commit each independently passing task.
- Do not deploy or run a paid preview canary without separate authorization.

---

### Task 1: Bounded provider-text primitive

**Files:**
- Create: `src/sources/provider-text.ts`
- Create: `tests/unit/sources/provider-text.test.ts`

**Interfaces:**
- Produces: `decodeProviderTextEntities(value: string): string`.
- Produces: `normalizeProviderText(value: string | null | undefined, options?: ProviderTextOptions): string | null`.
- Produces: `ProviderTextOptions = { stripHtml?: boolean; maxCharacters?: number }`.

- [ ] **Step 1: Write the failing decoder tests**

Create `tests/unit/sources/provider-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  decodeProviderTextEntities,
  normalizeProviderText,
} from "../../../src/sources/provider-text";

describe("provider text normalization", () => {
  it("decodes decimal, hexadecimal, named, and double-encoded references", () => {
    expect(decodeProviderTextEntities(
      "&#8216;safe&#8217; &#x201C;text&#x201D; &amp; &quot;ok&quot; &amp;#8217;",
    )).toBe("‘safe’ “text” & \"ok\" ’");
  });

  it("keeps unsupported and unsafe references inert", () => {
    expect(decodeProviderTextEntities(
      "&#0; &#xD800; &#x110000; &#x1F; &copy; &unfinished",
    )).toBe("&#0; &#xD800; &#x110000; &#x1F; &copy; &unfinished");
  });

  it("returns bounded plain text after decoding and tag removal", () => {
    expect(normalizeProviderText(
      "&lt;script&gt;bad()&lt;/script&gt; &nbsp; useful   text",
      { stripHtml: true, maxCharacters: 20 },
    )).toBe("bad() useful text");
  });

  it("normalizes empty input to null", () => {
    expect(normalizeProviderText(" &nbsp; ")).toBeNull();
    expect(normalizeProviderText(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/unit/sources/provider-text.test.ts
```

Expected: FAIL because `src/sources/provider-text.ts` does not exist.

- [ ] **Step 3: Implement the bounded primitive**

Create `src/sources/provider-text.ts` with these constants and functions:

```ts
export const MAX_PROVIDER_TEXT_INPUT_CHARACTERS = 100_000;
const MAX_ENTITY_DECODE_PASSES = 2;
const ENTITY = /&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi;
const NAMED = new Map<string, string>([
  ["amp", "&"], ["quot", "\""], ["apos", "'"],
  ["lt", "<"], ["gt", ">"], ["nbsp", " "],
]);

function safeScalar(value: number): boolean {
  return Number.isSafeInteger(value) &&
    value > 0 && value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff) &&
    !(value <= 0x1f || (value >= 0x7f && value <= 0x9f));
}

function decodePass(value: string): string {
  return value.replace(ENTITY, (match, decimal, hexadecimal, named) => {
    if (typeof named === "string") {
      return NAMED.get(named.toLowerCase()) ?? match;
    }
    const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
    return safeScalar(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

export function decodeProviderTextEntities(value: string): string {
  let decoded = value.slice(0, MAX_PROVIDER_TEXT_INPUT_CHARACTERS);
  for (let pass = 0; pass < MAX_ENTITY_DECODE_PASSES; pass += 1) {
    const next = decodePass(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

export type ProviderTextOptions = {
  stripHtml?: boolean;
  maxCharacters?: number;
};

export function normalizeProviderText(
  value: string | null | undefined,
  options: ProviderTextOptions = {},
): string | null {
  if (value == null) return null;
  const maximum = options.maxCharacters ?? MAX_PROVIDER_TEXT_INPUT_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 0 ||
      maximum > MAX_PROVIDER_TEXT_INPUT_CHARACTERS) {
    throw new RangeError("Provider text limit is outside the safe bound.");
  }
  const decoded = decodeProviderTextEntities(value);
  const plain = options.stripHtml === true
    ? decoded.replace(/<[^>]+>/g, " ")
    : decoded;
  const normalized = plain.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized.length === 0 ? null : normalized.slice(0, maximum);
}
```

If the third test exposes that truncation occurs after normalization, set its
expected value to the first 20 characters of the normalized result; do not move
the bound before decoding or whitespace normalization.

- [ ] **Step 4: Run the test and commit**

Run:

```bash
npx vitest run tests/unit/sources/provider-text.test.ts
npm run check
git add src/sources/provider-text.ts tests/unit/sources/provider-text.test.ts
git commit -m "fix: decode bounded provider text entities"
```

Expected: focused tests and type checking pass.

---

### Task 2: Normalize collected display and evidence text

**Files:**
- Modify: `src/editorial/normalize.ts`
- Modify: `src/sources/rss.ts`
- Modify: `src/sources/publication-page.ts`
- Modify: `src/sources/article-extractor.ts`
- Modify: `src/sources/news-collector.ts`
- Modify: `tests/unit/editorial/normalize.test.ts`
- Modify: `tests/unit/sources/publication-collector.test.ts`
- Modify: `tests/unit/sources/news-collector.test.ts`

**Interfaces:**
- Consumes: Task 1 `normalizeProviderText`.
- Preserves: all URL, identifier, access-level, retention, evidence-size, and RawItem/Item schemas.

- [ ] **Step 1: Write failing central and WAMU-style regressions**

Add to `tests/unit/editorial/normalize.test.ts`:

```ts
it("decodes provider entities before normalized items are persisted", () => {
  const normalized = normalizeCandidate(candidate({
    title: "Inspector finds &#8216;systemic breakdown&#8217;",
    abstract: "It&amp;#8217;s documented in yesterday&#8217;s report.",
  }));

  expect(normalized.title).toBe("Inspector finds ‘systemic breakdown’");
  expect(normalized.normalizedText).toContain("It’s documented in yesterday’s report.");
  expect(JSON.stringify(normalized)).not.toMatch(/&#(?:x[0-9a-f]+|[0-9]+);/i);
});
```

Add an RSS case to `tests/unit/sources/publication-collector.test.ts` whose title
and CDATA description contain decimal and double-encoded apostrophes. Assert the
candidate title and abstract contain curly punctuation and no numeric entity.

Add a direct-page case to `tests/unit/sources/news-collector.test.ts` with
`&amp;#8217;` in a listing title and `&#8220;quoted&#8221;` in its summary. Assert the
collected candidate is decoded before normalization.

- [ ] **Step 2: Confirm the regressions are RED**

Run:

```bash
npx vitest run tests/unit/editorial/normalize.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/news-collector.test.ts -t "entit|WAMU|provider"
```

Expected: literal references remain in at least the central normalization and
RSS assertions.

- [ ] **Step 3: Replace local text helpers with the shared normalizer**

In `src/editorial/normalize.ts`, import `normalizeProviderText` and change the
private whitespace helper to fail closed only on empty text:

```ts
function normalizedWhitespace(value: string): string {
  return normalizeProviderText(value) ?? "";
}
```

Normalize `candidate.abstract` and `candidate.content` into local nullable
values before deriving `materialText`. Keep the existing evidence precedence
for `normalizedText`:

```ts
const abstract = candidate.abstract === null
  ? null
  : normalizeProviderText(candidate.abstract);
const content = candidate.content === null
  ? null
  : normalizeProviderText(candidate.content);
const materialText = [title, abstract, content];

// Inside the Item payload:
normalizedText: content ?? abstract ?? title,
```

This lets news signals, research topics, and persisted evidence see the same
decoded plain text. Do not apply the helper to `canonicalUrl`, `externalIds`,
or metadata keys.

In `src/sources/rss.ts`, replace `normalizeWhitespace` calls with:

```ts
const description = normalizeProviderText(rawDescription, {
  stripHtml: true,
  maxCharacters: MAX_PROVIDER_EVIDENCE_CHARACTERS,
}) ?? "";
const title = normalizeProviderText(entry.title, { stripHtml: true }) ?? "";
```

In `src/sources/publication-page.ts`, make `text(value)` call
`normalizeProviderText(value, { stripHtml: true })`. In
`src/sources/article-extractor.ts`, make `normalized(value)` call
`normalizeProviderText(value)` after DOM text extraction. In
`src/sources/news-collector.ts`, make `normalizedText(value)` call the shared
normalizer.

Do not use the text normalizer from `schemaUrl`, `permittedItem`, date parsing
after the date string is selected, or any outbound URL path.

- [ ] **Step 4: Run focused and adjacent suites**

Run:

```bash
npx vitest run tests/unit/sources/provider-text.test.ts tests/unit/editorial/normalize.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/news-collector.test.ts
npm run check
```

Expected: all four test files and type checking pass; existing evidence-length
and retention assertions remain unchanged.

- [ ] **Step 5: Commit the integration**

Run:

```bash
git add src/editorial/normalize.ts src/sources/rss.ts src/sources/publication-page.ts src/sources/article-extractor.ts src/sources/news-collector.ts tests/unit/editorial/normalize.test.ts tests/unit/sources/publication-collector.test.ts tests/unit/sources/news-collector.test.ts
git commit -m "fix: normalize provider text before persistence"
```

---

### Task 3: Entity-normalization regression gate

**Files:**
- Verify only; modify a file only when a failing test identifies a regression caused by Tasks 1–2.

**Interfaces:**
- Produces: an independently mergeable entity-normalization stage.

- [ ] **Step 1: Run the full verification ladder**

Run in order:

```bash
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
git diff --check
```

Expected: all commands pass. The known managed-OAuth preview baseline is not
part of this local stage and must not be changed.

- [ ] **Step 2: Inspect the diff for prohibited behavior**

Run:

```bash
git diff main...HEAD -- src/sources/provider-text.ts src/editorial/normalize.ts src/sources
rg -n "dangerouslySetInnerHTML|innerHTML\s*=" src
```

Expected: no new trusted-HTML rendering, URL decoding, credential handling, D1
migration, deployment configuration, or historical rewrite.

- [ ] **Step 3: Commit only test-driven corrections**

If Step 1 required a scoped correction, stage only the explicitly reviewed
files from Tasks 1–2 that changed, rerun the failing command, and commit with
`git commit -m "test: complete provider text regression coverage"`.

If no correction was needed, do not create an empty commit.
