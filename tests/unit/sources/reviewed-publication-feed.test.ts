import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { SourceRecord } from "../../../src/db/repository";
import { routePublication } from "../../../src/editorial/route-publication";
import { SourceHttpClient } from "../../../src/sources/http-client";
import { OpenAiPublicationFeedAdapter } from "../../../src/sources/reviewed-publication-feed";
import { RssAdapter } from "../../../src/sources/rss";
import {
  ResearchSourceRecordSchema,
  type CollectionWindow,
} from "../../../src/sources/types";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const loadFixture = (name: string) => readFile(fixturePath(name), "utf8");

const window: CollectionWindow = {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-03T00:00:00.000Z",
};

function openAiSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "openai",
    canonicalName: "OpenAI Research",
    canonicalUrl: "https://openai.com/research/",
    role: "blog",
    trustPrior: 0.92,
    enabled: true,
    restrictions: {
      bodyRetrieval: "permitted",
      paywall: "none",
      contentUse: "ephemeral-summarization",
      feedUrl: "https://openai.com/catalog-supplied-wrong-feed.xml",
      feedUrlPolicy: {
        allowedHosts: ["openai.com"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/news/rss.xml"],
      },
      articleUrlPolicy: {
        allowedHosts: ["openai.com"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/index/"],
      },
    },
    discoveryMechanism: "rss",
    sectionEligibility: ["research", "research_radar", "technology", "ai_policy"],
    lastSuccessAt: null,
    healthStatus: "unknown",
    ...overrides,
  };
}

function rssAdapter(source: SourceRecord, body: string): RssAdapter {
  return new RssAdapter(
    new SourceHttpClient({
      fetch: vi.fn(async () => new Response(body, {
        headers: { "content-type": "application/rss+xml" },
      })),
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    }),
    [{
      source: ResearchSourceRecordSchema.parse(source),
      feedUrl: "https://openai.com/news/rss.xml",
      feedUrlPolicy: source.restrictions.feedUrlPolicy,
      articleUrlPolicy: source.restrictions.articleUrlPolicy,
    }],
  );
}

describe("reviewed OpenAI publication feed", () => {
  it("copies only the first sixteen bounded feed categories from ordinary RSS entries", async () => {
    const categories = [
      "AI safety",
      ...Array.from({ length: 16 }, (_, index) => `Category ${index + 2}`),
    ];
    const feed = `<?xml version="1.0"?><rss><channel><item>
      <title>Category-bearing research study</title>
      <link>https://openai.com/index/category-bearing-study/</link>
      <pubDate>Sat, 01 Aug 2026 12:00:00 GMT</pubDate>
      <description>Bounded feed evidence.</description>
      ${categories.map((category) => `<category>${category}</category>`).join("\n")}
    </item></channel></rss>`;

    const result = await rssAdapter(openAiSource(), feed).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates[0]?.metadata).toMatchObject({
      feedCategories: [
        "AI safety",
        "Category 2",
        "Category 3",
        "Category 4",
        "Category 5",
        "Category 6",
        "Category 7",
        "Category 8",
        "Category 9",
        "Category 10",
        "Category 11",
        "Category 12",
        "Category 13",
        "Category 14",
        "Category 15",
        "Category 16",
      ],
    });
  });

  it("uses the exact OpenAI endpoint, bounds inspection and details, and keeps failed details as metadata", async () => {
    const feed = await loadFixture("openai-news-feed.xml");
    const detail = await loadFixture("openai-research-detail.html");
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://openai.com/news/rss.xml") {
        return new Response(feed, {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      if (url === "https://openai.com/index/ai-safety-research-study/") {
        throw new TypeError("temporary detail failure");
      }
      if (url.startsWith("https://openai.com/index/")) {
        return new Response(detail, {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const source = openAiSource();
    const adapter = new OpenAiPublicationFeedAdapter(
      new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      ResearchSourceRecordSchema.parse(source),
      source.restrictions.feedUrlPolicy as never,
      source.restrictions.articleUrlPolicy as never,
    );

    const result = await adapter.collectWithStats(window);

    expect(result.observed).toBe(18);
    expect(result.candidates).toHaveLength(18);
    expect(result.candidates.map((candidate) => candidate.title))
      .not.toContain("Ignored after the first twenty raw rows");
    expect(result.candidates.find((candidate) =>
      candidate.title === "AI safety research study for robust oversight"
    )).toMatchObject({
      accessLevel: "metadata",
      abstract: "We report a substantive method and results for AI safety oversight.",
      content: null,
      metadata: {
        discoveryLaneIds: ["openai:rss"],
        feedCategories: ["Research", "AI safety"],
      },
    });
    expect(requests).toEqual([
      "https://openai.com/news/rss.xml",
      "https://openai.com/index/ai-safety-research-study/",
      "https://openai.com/index/policy-update/",
      "https://openai.com/index/research-01/",
      "https://openai.com/index/research-02/",
      "https://openai.com/index/research-03/",
    ]);

    const research = result.candidates.find((candidate) =>
      candidate.title === "AI safety research study for robust oversight"
    );
    const product = result.candidates.find((candidate) =>
      candidate.title === "New product launch"
    );
    expect(research === undefined ? null : routePublication(research))
      .toMatchObject({ kind: "blog", metadata: { primarySection: "research" } });
    expect(product === undefined ? null : routePublication(product))
      .toMatchObject({ kind: "article" });
  });

  it("never calls an OpenAI page fallback when the bounded feed fails", async () => {
    const source = openAiSource();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://openai.com/news/rss.xml") {
        return new Response("blocked", { status: 403 });
      }
      throw new Error(`Unexpected fallback: ${input}`);
    });
    const adapter = new OpenAiPublicationFeedAdapter(
      new SourceHttpClient({ fetch, maxRetries: 0 }),
      ResearchSourceRecordSchema.parse(source),
      source.restrictions.feedUrlPolicy as never,
      source.restrictions.articleUrlPolicy as never,
    );

    await expect(adapter.collectWithStats(window)).rejects.toThrow();
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://openai.com/news/rss.xml",
    ]);
  });
});
