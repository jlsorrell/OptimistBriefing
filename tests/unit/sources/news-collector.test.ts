import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Readability } from "@mozilla/readability";
import { describe, expect, it, vi } from "vitest";

import type { SourceRecord } from "../../../src/db/repository";
import { normalizeCandidate } from "../../../src/editorial/normalize";
import {
  extractReadableArticle,
} from "../../../src/sources/article-extractor";
import { GdeltAdapter } from "../../../src/sources/gdelt";
import { SourceHttpClient } from "../../../src/sources/http-client";
import { hasExplicitAiPolicyEvidence } from "../../../src/sources/news-signals";
import {
  createNewsCollectorFromCatalog,
  NewsCollector,
} from "../../../src/sources/news-collector";
import { PolymarketAdapter } from "../../../src/sources/polymarket";
import type {
  CollectionWindow,
  ResearchSourceRecord,
} from "../../../src/sources/types";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const loadFixture = (name: string) => readFile(fixturePath(name), "utf8");

const fixedWindow = (): CollectionWindow => ({
  from: "2026-07-28T00:00:00.000Z",
  to: "2026-07-29T12:00:00.000Z",
});

const wyprFeedPolicy = {
  allowedHosts: ["www.wypr.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/rss/"],
} as const;

const wyprArticlePolicy = {
  allowedHosts: ["www.wypr.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/wypr-news/"],
} as const;

async function localNewsForUrl(url: string): Promise<string> {
  return (await loadFixture("local-news.xml")).replace(
    "https://www.wypr.org/wypr-news/2026-07-29/baltimore-expands-secure-ai-pilot",
    url,
  );
}

const source = (
  value: Partial<ResearchSourceRecord> &
    Pick<ResearchSourceRecord, "id" | "canonicalName" | "canonicalUrl" | "role">,
): ResearchSourceRecord => ({
  enabled: true,
  restrictions: {
    bodyRetrieval: "forbidden",
    paywall: "none",
    contentUse: "metadata-only",
  },
  ...value,
});

const gdeltSource = source({
  id: "gdelt",
  canonicalName: "GDELT",
  canonicalUrl: "https://www.gdeltproject.org/",
  role: "analysis",
});

const wyprSource = source({
  id: "wypr",
  canonicalName: "WYPR",
  canonicalUrl: "https://www.wypr.org/",
  role: "reporting",
  restrictions: {
    bodyRetrieval: "permitted",
    paywall: "none",
    contentUse: "ephemeral-summarization",
  },
});

const polymarketSource = source({
  id: "polymarket",
  canonicalName: "Polymarket",
  canonicalUrl: "https://polymarket.com/",
  role: "forecast",
});

async function newsCollectorWithFixtures() {
  const fixtures = {
    article: await loadFixture("article.html"),
    gdelt: await loadFixture("gdelt-response.json"),
    localNews: await loadFixture("local-news.xml"),
    polymarket: await loadFixture("polymarket-markets.json"),
  };
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.gdeltproject.org/api/v2/doc/doc")) {
      const endpoint = new URL(url);
      expect(endpoint.searchParams.get("startdatetime")).toBe(
        "20260728000000",
      );
      expect(endpoint.searchParams.get("enddatetime")).toBe(
        "20260729120000",
      );
      return new Response(fixtures.gdelt, {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://www.wypr.org/rss/local-news") {
      return new Response(fixtures.localNews, {
        headers: { "content-type": "application/rss+xml" },
      });
    }
    if (
      url ===
      "https://www.wypr.org/wypr-news/2026-07-29/baltimore-expands-secure-ai-pilot"
    ) {
      return new Response(fixtures.article, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.startsWith("https://gamma-api.polymarket.com/markets")) {
      return new Response(fixtures.polymarket, {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  const http = new SourceHttpClient({
    fetch,
    now: () => new Date("2026-07-29T08:30:00.000Z"),
    sleep: async () => undefined,
  });

  return {
    collector: new NewsCollector({
      http,
      directFeeds: [
        {
          source: wyprSource,
          feedUrl: "https://www.wypr.org/rss/local-news",
          feedUrlPolicy: wyprFeedPolicy,
          articleUrlPolicy: wyprArticlePolicy,
        },
      ],
      discoveryAdapters: [
        new GdeltAdapter(http, gdeltSource, {
          query: "(Baltimore OR AI policy)",
          maxRecords: 10,
        }),
      ],
      forecastAdapters: [
        new PolymarketAdapter(http, polymarketSource, {
          minimumLiquidity: 100_000,
          minimumAbsoluteChange: 0.1,
        }),
      ],
    }),
    fetch,
  };
}

describe("NewsCollector", () => {
  it("drops an entity-only GDELT title without losing its valid sibling", async () => {
    const adapter = new GdeltAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          articles: [
            {
              url: "https://news.example.com/empty-title",
              title: "&nbsp;",
              seendate: "20260729T081500Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/valid-title",
              title: "Artificial intelligence regulation advances",
              seendate: "20260729T081600Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
          ],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      gdeltSource,
      { query: "AI policy", maxRecords: 2 },
    );

    const candidates = await adapter.collect(fixedWindow());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.originalUrl).toBe(
      "https://news.example.com/valid-title",
    );
  });

  it("keeps triple-encoded GDELT text inert after central normalization", async () => {
    const adapter = new GdeltAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          articles: [{
            url: "https://news.example.com/artificial-intelligence-rule",
            title:
              "artificial intelligence regulation&amp;amp;#8217;s advance",
            seendate: "20260729T081500Z",
            domain: "news.example.com",
            language: "English",
            sourcecountry: "United States",
          }],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      gdeltSource,
      { query: "AI policy", maxRecords: 1 },
    );

    const candidate = (await adapter.collect(fixedWindow()))[0]!;
    const item = normalizeCandidate(candidate);

    expect(item.title).toBe(
      "artificial intelligence regulation&#8217;s advance",
    );
    expect(item.metadata.primarySection).toBe("ai_policy");
  });

  it("bounds GDELT titles after NFKC expansion", async () => {
    const adapter = new GdeltAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          articles: [{
            url: "https://news.example.com/expanded-title",
            title: "ﬃ".repeat(200),
            seendate: "20260729T081500Z",
            domain: "news.example.com",
            language: "English",
            sourcecountry: "United States",
          }],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      gdeltSource,
      { query: "AI policy", maxRecords: 1 },
    );

    const candidate = (await adapter.collect(fixedWindow()))[0]!;

    expect(candidate.title).toHaveLength(500);
    expect(candidate.title).not.toMatch(/[\uD800-\uDFFF]/u);
  });


  it("decodes GDELT provider text before deriving news signals", async () => {
    const adapter = new GdeltAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          articles: [{
            url: "https://news.example.com/artificial-intelligence-rule",
            title: "artificial&#32;intelligence regulation advances",
            seendate: "20260729T081500Z",
            domain: "news.example.com",
            language: "English",
            sourcecountry: "United States",
          }],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      gdeltSource,
      { query: "AI policy", maxRecords: 1 },
    );

    const candidate = (await adapter.collect(fixedWindow()))[0]!;

    expect(candidate.title).toBe(
      "artificial&#32;intelligence regulation advances",
    );
    expect(normalizeCandidate(candidate).title).toBe(
      "artificial intelligence regulation advances",
    );
    expect(candidate.metadata.primarySection).toBe("ai_policy");
  });

  it("keeps compatibility-created GDELT tag names out of item routing and isolates tag-only titles", async () => {
    const adapter = new GdeltAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          articles: [
            {
              url: "https://news.example.com/tag-name",
              title:
                "&#65308;technology&#65310;Ordinary update&#65308;/technology&#65310;",
              seendate: "20260729T081500Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/useful-wrapper",
              title:
                "&#65308;span&#65310;Acme launches an AI coding assistant&#65308;/span&#65310;",
              seendate: "20260729T081600Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/tag-only",
              title: "&#65308;technology&#65310;",
              seendate: "20260729T081700Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/beyond-budget-tag-name",
              title:
                "&amp;amp;#65308;technology&amp;amp;#65310;Ordinary boundary update&amp;amp;#65308;/technology&amp;amp;#65310;",
              seendate: "20260729T081800Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/beyond-budget-tag-only",
              title:
                "&amp;amp;#65308;technology&amp;amp;#65310;",
              seendate: "20260729T081900Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
          ],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      gdeltSource,
      { query: "technology", maxRecords: 5 },
    );

    const candidates = await adapter.collect(fixedWindow());
    const items = candidates.map((candidate) => normalizeCandidate(candidate));

    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      "&#65308;technology&#65310;Ordinary update&#65308;/technology&#65310;",
      "&#65308;span&#65310;Acme launches an AI coding assistant&#65308;/span&#65310;",
      "&amp;amp;#65308;technology&amp;amp;#65310;Ordinary boundary update&amp;amp;#65308;/technology&amp;amp;#65310;",
    ]);
    expect(items.map((item) => ({
      title: item.title,
      primarySection: item.metadata.primarySection,
    }))).toEqual([
      { title: "Ordinary update", primarySection: "world" },
      {
        title: "Acme launches an AI coding assistant",
        primarySection: "technology",
      },
      {
        title:
          "&#65308;technology&#65310;Ordinary boundary update&#65308;/technology&#65310;",
        primarySection: "world",
      },
    ]);
  });

  it("preserves ambiguous residual GDELT comparisons for signal routing without treating malformed syntax as a tag", async () => {
    const adapter = new GdeltAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          articles: [
            {
              url: "https://news.example.com/numeric-comparison",
              title:
                "Ordinary 3 &amp;amp;lt; 5 Baltimore &amp;amp;gt; 2 update",
              seendate: "20260729T081500Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/malformed-nested",
              title:
                "Ordinary A &amp;amp;lt;tag &amp;amp;lt; B &amp;amp;gt; C update",
              seendate: "20260729T081600Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/self-closing-tag",
              title:
                "&amp;amp;lt;technology/&amp;amp;gt;Ordinary update",
              seendate: "20260729T081700Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
            {
              url: "https://news.example.com/self-closing-tag-only",
              title: "&amp;amp;lt;technology/&amp;amp;gt;",
              seendate: "20260729T081800Z",
              domain: "news.example.com",
              language: "English",
              sourcecountry: "United States",
            },
          ],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      gdeltSource,
      { query: "comparison", maxRecords: 4 },
    );

    const candidates = await adapter.collect(fixedWindow());
    const items = candidates.map((candidate) => normalizeCandidate(candidate));

    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({
      title:
        "Ordinary 3 &amp;amp;lt; 5 Baltimore &amp;amp;gt; 2 update",
      namedEntities: expect.arrayContaining(["Baltimore"]),
      metadata: { primarySection: "baltimore" },
    });
    expect(items.map((item) => ({
      title: item.title,
      primarySection: item.metadata.primarySection,
    }))).toEqual([
      {
        title: "Ordinary 3 &lt; 5 Baltimore &gt; 2 update",
        primarySection: "baltimore",
      },
      {
        title: "Ordinary A &lt;tag &lt; B &gt; C update",
        primarySection: "world",
      },
      {
        title: "&lt;technology/&gt;Ordinary update",
        primarySection: "world",
      },
    ]);
  });

  it("retains direct local results when a discovery adapter fails", async () => {
    const localNews = await loadFixture("local-news.xml");
    const directSource = source({
      ...wyprSource,
      restrictions: {
        bodyRetrieval: "forbidden",
        paywall: "none",
        contentUse: "metadata-only",
      },
    });
    const collector = new NewsCollector({
      http: new SourceHttpClient({
        fetch: vi.fn(async () =>
          new Response(localNews, {
            headers: { "content-type": "application/rss+xml" },
          }),
        ),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      directFeeds: [{
        source: directSource,
        feedUrl: "https://www.wypr.org/rss/local-news",
        feedUrlPolicy: wyprFeedPolicy,
        articleUrlPolicy: wyprArticlePolicy,
      }],
      discoveryAdapters: [{
        sourceId: "gdelt",
        collect: async () => {
          throw new Error("private discovery detail");
        },
      }],
      forecastAdapters: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates.map(({ sourceId }) => sourceId)).toEqual([
      "wypr",
    ]);
    expect(result.succeededSourceIds).toEqual(["wypr"]);
    expect(result.failures).toEqual([
      { sourceId: "gdelt", kind: "unknown" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private discovery detail");
  });

  it("labels Polymarket data as forecast and never as corroborating reporting", async () => {
    const { collector } = await newsCollectorWithFixtures();
    const { candidates: items } = await collector.collect(fixedWindow());
    const market = items.find((item) => item.kind === "forecast");

    expect(market?.sourceRole).toBe("forecast");
    expect(market?.externalId).toBe("Polymarket:market-material");
    expect(market?.canCorroborateFacts).toBe(false);
    expect(market?.metadata).toMatchObject({
      currentProbability: 0.64,
      priorProbability: 0.48,
      absoluteChange: 0.16,
      retrievedAt: "2026-07-29T08:30:00.000Z",
      liquidity: 250000,
      resolutionSource:
        "https://mgaleg.maryland.gov/mgawebsite/Legislation/Details/hb0001",
    });
    expect(items.filter((item) => item.kind === "forecast")).toHaveLength(1);
  });

  it("decodes Polymarket questions before deriving AI-policy signals", async () => {
    const encodedQuestion =
      "Will artificial&#32;intelligence regulation advance in 2026?";
    const adapter = new PolymarketAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json([{
          id: "encoded-ai-policy",
          question: encodedQuestion,
          slug: "encoded-ai-policy",
          outcomes: "[\"Yes\",\"No\"]",
          outcomePrices: "[\"0.64\",\"0.36\"]",
          oneDayPriceChange: 0.16,
          liquidity: "250000",
          active: true,
          closed: false,
          archived: false,
          acceptingOrders: true,
          updatedAt: "2026-07-29T08:20:00.000Z",
          endDate: "2026-12-31T23:59:59.000Z",
          resolutionSource: "https://www.congress.gov/",
        }])),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      source({
        ...polymarketSource,
        sectionEligibility: ["forecast", "ai_policy"],
      }),
      {
        minimumLiquidity: 100_000,
        minimumAbsoluteChange: 0.1,
      },
    );

    const candidate = (await adapter.collect(fixedWindow()))[0]!;

    expect(candidate.title).toBe(encodedQuestion);
    const normalized = normalizeCandidate(candidate);
    expect(normalized.title).toBe(
      "Will artificial intelligence regulation advance in 2026?",
    );
    expect(candidate.sectionEligibility).toContain("ai_policy");
    expect(hasExplicitAiPolicyEvidence([normalized.title])).toBe(true);
    expect(candidate.metadata.primarySection).toBe("forecast");
  });

  it("keeps compatibility-created Polymarket tag names out of item entities and isolates tag-only questions", async () => {
    const market = {
      outcomes: "[\"Yes\",\"No\"]",
      outcomePrices: "[\"0.64\",\"0.36\"]",
      oneDayPriceChange: 0.16,
      liquidity: "250000",
      active: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      updatedAt: "2026-07-29T08:20:00.000Z",
      endDate: "2026-12-31T23:59:59.000Z",
      resolutionSource: "https://www.congress.gov/",
    };
    const adapter = new PolymarketAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json([
          {
            ...market,
            id: "tag-name",
            question:
              "&#65308;Baltimore&#65310;Will ordinary odds move?&#65308;/Baltimore&#65310;",
            slug: "tag-name",
          },
          {
            ...market,
            id: "useful-wrapper",
            question:
              "&#65308;span&#65310;Will Baltimore transit odds move?&#65308;/span&#65310;",
            slug: "useful-wrapper",
          },
          {
            ...market,
            id: "tag-only",
            question: "&#65308;Baltimore&#65310;",
            slug: "tag-only",
          },
        ])),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      polymarketSource,
      {
        minimumLiquidity: 100_000,
        minimumAbsoluteChange: 0.1,
      },
    );

    const candidates = await adapter.collect(fixedWindow());
    const items = candidates.map((candidate) => normalizeCandidate(candidate));

    expect(candidates).toHaveLength(2);
    expect(items.map((item) => ({
      title: item.title,
      namedEntities: item.metadata.namedEntities,
    }))).toEqual([
      { title: "Will ordinary odds move?", namedEntities: [] },
      {
        title: "Will Baltimore transit odds move?",
        namedEntities: ["Baltimore", "Will Baltimore"],
      },
    ]);
  });

  it("bounds Polymarket questions after NFKC expansion", async () => {
    const adapter = new PolymarketAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json([{
          id: "expanding-question",
          question: "ﬃ".repeat(200),
          slug: "expanding-question",
          outcomes: "[\"Yes\",\"No\"]",
          outcomePrices: "[\"0.64\",\"0.36\"]",
          oneDayPriceChange: 0.16,
          liquidity: "250000",
          active: true,
          closed: false,
          archived: false,
          acceptingOrders: true,
          updatedAt: "2026-07-29T08:20:00.000Z",
          endDate: "2026-12-31T23:59:59.000Z",
          resolutionSource: "https://www.congress.gov/",
        }])),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      polymarketSource,
      {
        minimumLiquidity: 100_000,
        minimumAbsoluteChange: 0.1,
      },
    );

    const candidate = (await adapter.collect(fixedWindow()))[0]!;

    expect(candidate.title).toHaveLength(500);
    expect(candidate.title).toBe("ffi".repeat(166) + "ff");
  });

  it("keeps GDELT as non-corroborating discovery metadata, not article truth", async () => {
    const { collector } = await newsCollectorWithFixtures();
    const { candidates: items } = await collector.collect(fixedWindow());
    const discovery = items.find(
      (item) => item.metadata.discoveryProvider === "GDELT",
    );

    expect(discovery).toMatchObject({
      sourceId: "gdelt",
      sourceRole: "analysis",
      canCorroborateFacts: false,
      accessLevel: "metadata",
      content: null,
      metadata: {
        discoveryOnly: true,
        publisherDomain: "wypr.org",
      },
    });
    expect(
      items.some((item) => item.originalUrl.includes("127.0.0.1")),
    ).toBe(false);
  });

  it("retains direct source roles and extracts permitted HTML ephemerally", async () => {
    const { collector } = await newsCollectorWithFixtures();
    const item = (await collector.collect(fixedWindow())).candidates.find(
      (candidate) => candidate.sourceId === "wypr",
    );

    expect(item).toMatchObject({
      kind: "article",
      sourceRole: "reporting",
      canCorroborateFacts: true,
      accessLevel: "full_text",
      metadata: {
        extractionLevel: "full",
        contentUse: "ephemeral-summarization",
      },
    });
    expect(item?.content).toContain("The reported development");
    expect(item?.content).not.toContain("Subscribe now");
    expect(item?.content).not.toContain("privateTrackingToken");
  });

  it.each(["analysis", "opinion", "blog", "forecast"] as const)(
    "never lets %s sources corroborate factual reporting",
    async (role) => {
      const contextualSource = source({
        ...wyprSource,
        id: `context-${role}`,
        canonicalName: `Context ${role}`,
        canonicalUrl: `https://${role}.example.com/`,
        role,
      });
      const http = new SourceHttpClient({
        fetch: vi.fn(async (input) => {
          const requestedUrl = String(input);
          if (requestedUrl === `https://${role}.example.com/feed.xml`) {
            return new Response(
              await localNewsForUrl(`https://${role}.example.com/story`),
              {
              headers: { "content-type": "application/rss+xml" },
              },
            );
          }
          if (requestedUrl === `https://${role}.example.com/story`) {
            return new Response(await loadFixture("article.html"), {
              headers: { "content-type": "text/html" },
            });
          }
          throw new Error(`Unexpected URL: ${requestedUrl}`);
        }),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      });
      const collector = new NewsCollector({
        http,
        directFeeds: [
          {
            source: contextualSource,
            feedUrl: `https://${role}.example.com/feed.xml`,
            feedUrlPolicy: {
              allowedHosts: [`${role}.example.com`],
              allowedPorts: [""],
              allowedPathPrefixes: ["/feed.xml"],
            },
            articleUrlPolicy: {
              allowedHosts: [`${role}.example.com`],
              allowedPorts: [""],
              allowedPathPrefixes: ["/story"],
            },
          },
        ],
        discoveryAdapters: [],
        forecastAdapters: [],
      });

      expect(
        (await collector.collect(fixedWindow())).candidates[0],
      ).toMatchObject({
        sourceRole: role,
        canCorroborateFacts: false,
      });
    },
  );

  it("does not fetch article bodies when source policy permits metadata only", async () => {
    const metadataOnlySource = source({
      ...wyprSource,
      restrictions: {
        bodyRetrieval: "forbidden",
        paywall: "hard",
        contentUse: "metadata-only",
      },
    });
    const fetch = vi.fn(async (input) => {
      if (String(input) === "https://www.wypr.org/rss/local-news") {
        return new Response(await loadFixture("local-news.xml"), {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      throw new Error("Article body must not be fetched");
    });
    const collector = new NewsCollector({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      directFeeds: [
        {
          source: metadataOnlySource,
          feedUrl: "https://www.wypr.org/rss/local-news",
          feedUrlPolicy: wyprFeedPolicy,
          articleUrlPolicy: wyprArticlePolicy,
        },
      ],
      discoveryAdapters: [],
      forecastAdapters: [],
    });

    expect(
      (await collector.collect(fixedWindow())).candidates[0],
    ).toMatchObject({
      accessLevel: "metadata",
      content: null,
      metadata: {
        extractionLevel: "metadata-only",
        paywall: "hard",
        contentUse: "metadata-only",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves validated RSS metadata when optional article retrieval fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(await loadFixture("local-news.xml"), {
          headers: { "content-type": "application/rss+xml" },
        }),
      )
      .mockResolvedValueOnce(new Response("temporarily unavailable", {
        status: 503,
      }));
    const collector = new NewsCollector({
      http: new SourceHttpClient({ fetch, maxRetries: 0 }),
      directFeeds: [
        {
          source: wyprSource,
          feedUrl: "https://www.wypr.org/rss/local-news",
          feedUrlPolicy: wyprFeedPolicy,
          articleUrlPolicy: wyprArticlePolicy,
        },
      ],
      discoveryAdapters: [],
      forecastAdapters: [],
    });

    expect((await collector.collect(fixedWindow())).candidates).toEqual([
      expect.objectContaining({
        sourceId: "wypr",
        title: "Baltimore expands secure AI pilot",
        accessLevel: "metadata",
        content: null,
        metadata: expect.objectContaining({
          extractionLevel: "metadata-only",
        }),
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps compatibility-created RSS/news tag names out of item signals and isolates tag-only titles", async () => {
    const host = "rss-signal-boundary.example.com";
    const feedUrl = `https://${host}/feed.xml`;
    const feed = `<?xml version="1.0"?><rss><channel>
      <item>
        <title><![CDATA[&#65308;technology&#65310;Ordinary update&#65308;/technology&#65310;]]></title>
        <link>https://${host}/title-tag</link>
        <pubDate>Wed, 29 Jul 2026 08:00:00 GMT</pubDate>
        <description>Routine details.</description>
      </item>
      <item>
        <title>Ordinary content update</title>
        <link>https://${host}/content-tag</link>
        <pubDate>Wed, 29 Jul 2026 08:01:00 GMT</pubDate>
        <description>Routine details.</description>
      </item>
      <item>
        <title>Useful content update</title>
        <link>https://${host}/content-wrapper</link>
        <pubDate>Wed, 29 Jul 2026 08:02:00 GMT</pubDate>
        <description>Routine details.</description>
      </item>
      <item>
        <title><![CDATA[&#65308;span&#65310;Acme launches an AI coding assistant&#65308;/span&#65310;]]></title>
        <link>https://${host}/title-wrapper</link>
        <pubDate>Wed, 29 Jul 2026 08:03:00 GMT</pubDate>
        <description>Routine details.</description>
      </item>
      <item>
        <title><![CDATA[&#65308;technology&#65310;]]></title>
        <link>https://${host}/tag-only</link>
        <pubDate>Wed, 29 Jul 2026 08:04:00 GMT</pubDate>
        <description>Routine details.</description>
      </item>
    </channel></rss>`;
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === feedUrl) {
        return new Response(feed, {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      if (url === `https://${host}/content-tag`) {
        return new Response(
          `<article><p>&#65308;artificial intelligence regulation&#65310;Routine details.</p></article>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === `https://${host}/content-wrapper`) {
        return new Response(
          `<article><p>&#65308;span&#65310;Artificial intelligence regulation advances.&#65308;/span&#65310;</p></article>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (
        url === `https://${host}/title-tag` ||
        url === `https://${host}/title-wrapper` ||
        url === `https://${host}/tag-only`
      ) {
        return new Response(
          "<article><p>Routine details.</p></article>",
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const rssSource = source({
      id: "rss-signal-boundary",
      canonicalName: "RSS Signal Boundary",
      canonicalUrl: `https://${host}/`,
      role: "reporting",
      sectionEligibility: ["world", "technology", "ai_policy"],
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "ephemeral-summarization",
      },
    });
    const collector = new NewsCollector({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
      directFeeds: [{
        source: rssSource,
        feedUrl,
        feedUrlPolicy: {
          allowedHosts: [host],
          allowedPorts: [""],
          allowedPathPrefixes: ["/"],
        },
        articleUrlPolicy: {
          allowedHosts: [host],
          allowedPorts: [""],
          allowedPathPrefixes: ["/"],
        },
      }],
      discoveryAdapters: [],
      forecastAdapters: [],
    });

    const candidates = (await collector.collect(fixedWindow())).candidates;

    expect(candidates).toHaveLength(4);
    const items = candidates.map((candidate) => normalizeCandidate(candidate));
    expect(items.map((item) => ({
      title: item.title,
      normalizedText: item.normalizedText,
      primarySection: item.metadata.primarySection,
    }))).toEqual([
      {
        title: "Ordinary update",
        normalizedText: "Routine details.",
        primarySection: "world",
      },
      {
        title: "Ordinary content update",
        normalizedText: "Routine details.",
        primarySection: "world",
      },
      {
        title: "Useful content update",
        normalizedText: "Artificial intelligence regulation advances.",
        primarySection: "ai_policy",
      },
      {
        title: "Acme launches an AI coding assistant",
        normalizedText: "Routine details.",
        primarySection: "technology",
      },
    ]);
  });

  it("rejects a feed item outside the configured article allowlist", async () => {
    const fetch = vi.fn(async (input) => {
      if (String(input) === "https://www.wypr.org/rss/local-news") {
        return new Response(
          await localNewsForUrl("https://attacker.example/story"),
          { headers: { "content-type": "application/rss+xml" } },
        );
      }
      throw new Error("Cross-origin article must not be fetched");
    });
    const collector = new NewsCollector({
      http: new SourceHttpClient({ fetch }),
      directFeeds: [
        {
          source: metadataOnlySource(),
          feedUrl: "https://www.wypr.org/rss/local-news",
          feedUrlPolicy: wyprFeedPolicy,
          articleUrlPolicy: wyprArticlePolicy,
        },
      ],
      discoveryAdapters: [],
      forecastAdapters: [],
    });

    expect((await collector.collect(fixedWindow())).candidates).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects outlet attribution when an article redirect escapes its allowlist", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(await loadFixture("local-news.xml"), {
          headers: { "content-type": "application/rss+xml" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/stolen" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(await loadFixture("article.html"), {
          headers: { "content-type": "text/html" },
        }),
      );
    const collector = new NewsCollector({
      http: new SourceHttpClient({ fetch, maxRetries: 0 }),
      directFeeds: [
        {
          source: wyprSource,
          feedUrl: "https://www.wypr.org/rss/local-news",
          feedUrlPolicy: wyprFeedPolicy,
          articleUrlPolicy: wyprArticlePolicy,
        },
      ],
      discoveryAdapters: [],
      forecastAdapters: [],
    });

    expect((await collector.collect(fixedWindow())).candidates).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.redirect).toBe("manual");
  });

  it("pins GDELT and Gamma requests and rejects provider redirect escapes", async () => {
    const providerCases = [
      {
        adapter: (http: SourceHttpClient) =>
          new GdeltAdapter(http, gdeltSource, {
            query: "AI policy",
            maxRecords: 10,
          }),
        host: "api.gdeltproject.org",
        path: "/api/v2/doc/doc",
      },
      {
        adapter: (http: SourceHttpClient) =>
          new PolymarketAdapter(http, polymarketSource, {
            minimumLiquidity: 100_000,
            minimumAbsoluteChange: 0.1,
          }),
        host: "gamma-api.polymarket.com",
        path: "/markets",
      },
    ] as const;

    for (const providerCase of providerCases) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: {
              location: "https://attacker.example/provider-payload",
            },
          }),
        )
        .mockResolvedValueOnce(new Response("[]"));
      const adapter = providerCase.adapter(
        new SourceHttpClient({ fetch, maxRetries: 0 }),
      );

      await expect(adapter.collect(fixedWindow())).rejects.toMatchObject({
        name: "SourceFetchError",
        failureKind: "policy",
        retryable: false,
      });
      const requested = new URL(String(fetch.mock.calls[0]?.[0]));
      expect(requested.hostname).toBe(providerCase.host);
      expect(requested.pathname).toBe(providerCase.path);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});

function metadataOnlySource(): ResearchSourceRecord {
  return source({
    ...wyprSource,
    restrictions: {
      bodyRetrieval: "forbidden",
      paywall: "hard",
      contentUse: "metadata-only",
    },
  });
}

function catalogSource(
  value: Pick<
    SourceRecord,
    | "id"
    | "canonicalName"
    | "canonicalUrl"
    | "role"
    | "restrictions"
    | "discoveryMechanism"
  > &
    Partial<SourceRecord>,
): SourceRecord {
  return {
    trustPrior: 0.9,
    enabled: true,
    sectionEligibility: ["world"],
    lastSuccessAt: null,
    healthStatus: "unknown",
    ...value,
  };
}

describe("catalog-driven news collection", () => {
  const policy = (
    host: string,
    allowedPathPrefixes: readonly string[],
  ) => ({
    allowedHosts: [host],
    allowedPorts: [""],
    allowedPathPrefixes,
  });

  it("isolates an invalid RSS catalog URL and collects its healthy sibling", async () => {
    const validFeed = `<?xml version="1.0"?>
      <rss version="2.0"><channel><item>
        <title>Healthy sibling feed item</title>
        <link>https://healthy-feed.example/article</link>
        <guid>healthy-feed-item</guid>
        <description>Healthy bounded evidence.</description>
      </item></channel></rss>`;
    const fetch = vi.fn(async () =>
      new Response(validFeed, {
        headers: { "content-type": "application/rss+xml" },
      }),
    );
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "invalid-feed",
          canonicalName: "Invalid Feed",
          canonicalUrl: "https://invalid-feed.example/",
          role: "reporting",
          discoveryMechanism: "rss",
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            feedUrl: "http://invalid-feed.example/feed.xml",
            urlPolicy: policy("invalid-feed.example", ["/"]),
          },
        }),
        catalogSource({
          id: "healthy-feed",
          canonicalName: "Healthy Feed",
          canonicalUrl: "https://healthy-feed.example/",
          role: "reporting",
          discoveryMechanism: "rss",
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            feedUrl: "https://healthy-feed.example/feed.xml",
            urlPolicy: policy("healthy-feed.example", ["/"]),
          },
        }),
      ],
    });

    await expect(collector.collect(fixedWindow())).resolves.toMatchObject({
      candidates: [expect.objectContaining({ sourceId: "healthy-feed" })],
      succeededSourceIds: ["healthy-feed"],
      failures: [{ sourceId: "invalid-feed", kind: "policy" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("isolates malformed page setup and collects its healthy page sibling", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        `<article><a href="/story">Healthy page item</a><time datetime="2026-07-29T07:00:00.000Z"></time></article>`,
        { headers: { "content-type": "text/html" } },
      )
    );
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "malformed-page",
          canonicalName: "Malformed Page",
          canonicalUrl: "https://malformed-page.example/",
          role: "reporting",
          discoveryMechanism: "page",
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            pageUrl: "https://malformed-page.example/news",
            urlPolicy: policy("malformed-page.example", ["/"]),
            listing: { itemSelector: "article" },
          },
        }),
        catalogSource({
          id: "healthy-page",
          canonicalName: "Healthy Page",
          canonicalUrl: "https://healthy-page.example/",
          role: "reporting",
          discoveryMechanism: "page",
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            pageUrl: "https://healthy-page.example/news",
            urlPolicy: policy("healthy-page.example", ["/"]),
            listing: {
              itemSelector: "article",
              linkSelector: "a",
              dateSelector: "time",
              dateAttribute: "datetime",
              maxItems: 10,
              maxBodyFetches: 0,
            },
          },
        }),
      ],
    });

    await expect(collector.collect(fixedWindow())).resolves.toMatchObject({
      candidates: [expect.objectContaining({ sourceId: "healthy-page" })],
      succeededSourceIds: ["healthy-page"],
      failures: [{ sourceId: "malformed-page", kind: "parse" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("isolates an unpinned API endpoint and collects its healthy API sibling", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        results: [{
          document_number: "2026-54321",
          title: "Healthy sibling API document",
          html_url:
            "https://www.federalregister.gov/documents/2026/07/29/2026-54321/healthy-sibling",
          publication_date: "2026-07-29",
          type: "Notice",
          abstract: "Bounded government evidence.",
        }],
      })
    );
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "gdelt",
          canonicalName: "GDELT",
          canonicalUrl: "https://www.gdeltproject.org/",
          role: "reporting",
          discoveryMechanism: "api",
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            apiUrl: "https://attacker.example/gdelt",
            apiFormat: "gdelt-v2",
          },
        }),
        catalogSource({
          id: "unsupported-api",
          canonicalName: "Unsupported API",
          canonicalUrl: "https://unsupported-api.example/",
          role: "reporting",
          discoveryMechanism: "api",
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            apiUrl: "https://unsupported-api.example/v1/news",
            apiFormat: "unknown-v1",
            urlPolicy: policy("unsupported-api.example", ["/v1/"]),
          },
        }),
        catalogSource({
          id: "federal-register",
          canonicalName: "Federal Register",
          canonicalUrl: "https://www.federalregister.gov/",
          role: "primary",
          discoveryMechanism: "api",
          sectionEligibility: ["ai_policy"],
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "open-government",
            apiUrl:
              "https://www.federalregister.gov/api/v1/documents.json",
            apiFormat: "federal-register-v1",
            urlPolicy: policy("www.federalregister.gov", [
              "/api/v1/documents.json",
              "/documents/",
            ]),
          },
        }),
      ],
    });

    await expect(collector.collect(fixedWindow())).resolves.toMatchObject({
      candidates: [expect.objectContaining({
        sourceId: "federal-register",
        title: "Healthy sibling API document",
      })],
      succeededSourceIds: ["federal-register"],
      failures: [
        { sourceId: "gdelt", kind: "policy" },
        { sourceId: "unsupported-api", kind: "parse" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("constructs a usable Federal Register API adapter with typed policy", async () => {
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (
        url.startsWith(
          "https://www.federalregister.gov/api/v1/documents.json",
        )
      ) {
        return Response.json({
          count: 1,
          results: [
            {
              document_number: "2026-12345",
              title: "Secure foundation model evaluation standard",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-12345/secure-evaluation-requirements",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract:
                "The agency published a secure foundation model evaluation standard.",
            },
          ],
        });
      }
      throw new Error(`Unexpected catalog URL: ${url}`);
    });
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "federal-register",
          canonicalName: "Federal Register",
          canonicalUrl: "https://www.federalregister.gov/",
          role: "primary",
          discoveryMechanism: "api",
          sectionEligibility: ["ai_policy"],
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "open-government",
            apiUrl:
              "https://www.federalregister.gov/api/v1/documents.json",
            apiFormat: "federal-register-v1",
            urlPolicy: policy("www.federalregister.gov", [
              "/api/v1/documents.json",
              "/documents/",
            ]),
          },
        }),
      ],
    });

    const { candidates: items } = await collector.collect(fixedWindow());
    expect(
      items.find((item) => item.sourceId === "federal-register"),
    ).toMatchObject({
      kind: "document",
      sourceRole: "primary",
      canCorroborateFacts: true,
      title: "Secure foundation model evaluation standard",
      originalUrl:
        "https://www.federalregister.gov/documents/2026/07/29/2026-12345/secure-evaluation-requirements",
      metadata: {
        documentNumber: "2026-12345",
        documentType: "Notice",
        primarySection: "ai_policy",
      },
      sectionEligibility: ["ai_policy"],
      primaryDocumentUrl:
        "https://www.federalregister.gov/documents/2026/07/29/2026-12345/secure-evaluation-requirements",
    });
  });

  it("decodes Federal Register text before deriving news signals", async () => {
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          results: [{
            document_number: "2026-encoded",
            title:
              "artificial intelligence regulation&amp;amp;#8217;s notice",
            html_url:
              "https://www.federalregister.gov/documents/2026/07/29/2026-encoded/ai-regulation",
            publication_date: "2026-07-29",
            type: "Notice",
            abstract: "ﬃ".repeat(2_000),
          }],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "federal-register",
          canonicalName: "Federal Register",
          canonicalUrl: "https://www.federalregister.gov/",
          role: "primary",
          discoveryMechanism: "api",
          sectionEligibility: ["ai_policy"],
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "open-government",
            apiUrl:
              "https://www.federalregister.gov/api/v1/documents.json",
            apiFormat: "federal-register-v1",
            urlPolicy: policy("www.federalregister.gov", [
              "/api/v1/documents.json",
              "/documents/",
            ]),
          },
        }),
      ],
    });

    const candidate = (await collector.collect(fixedWindow())).candidates[0]!;

    expect(candidate).toMatchObject({
      title:
        "artificial intelligence regulation&amp;amp;#8217;s notice",
      metadata: { primarySection: "ai_policy" },
    });
    expect(candidate.abstract).toHaveLength(4_000);
    expect(normalizeCandidate(candidate)).toMatchObject({
      title: "artificial intelligence regulation&#8217;s notice",
    });
  });

  it("keeps compatibility-created Federal Register tag names out of item routing and isolates tag-only titles", async () => {
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          results: [
            {
              document_number: "2026-title-tag",
              title:
                "&#65308;technology&#65310;Ordinary notice&#65308;/technology&#65310;",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-title-tag/ordinary-notice",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract: "Routine record.",
            },
            {
              document_number: "2026-abstract-tag",
              title: "Ordinary abstract notice",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-abstract-tag/ordinary-abstract",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract:
                "&#65308;artificial intelligence regulation&#65310;Routine record.",
            },
            {
              document_number: "2026-useful-wrapper",
              title: "Useful wrapper notice",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-useful-wrapper/useful-wrapper",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract:
                "&#65308;span&#65310;Artificial intelligence regulation advances.&#65308;/span&#65310;",
            },
            {
              document_number: "2026-tag-only",
              title: "&#65308;technology&#65310;",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-tag-only/tag-only",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract: "Routine record.",
            },
          ],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "federal-register",
          canonicalName: "Federal Register",
          canonicalUrl: "https://www.federalregister.gov/",
          role: "primary",
          discoveryMechanism: "api",
          sectionEligibility: ["world", "technology", "ai_policy"],
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "open-government",
            apiUrl:
              "https://www.federalregister.gov/api/v1/documents.json",
            apiFormat: "federal-register-v1",
            urlPolicy: policy("www.federalregister.gov", [
              "/api/v1/documents.json",
              "/documents/",
            ]),
          },
        }),
      ],
    });

    const candidates = (await collector.collect(fixedWindow())).candidates;
    const items = candidates.map((candidate) => normalizeCandidate(candidate));

    expect(candidates).toHaveLength(3);
    expect(items.map((item) => ({
      title: item.title,
      normalizedText: item.normalizedText,
      primarySection: item.metadata.primarySection,
    }))).toEqual([
      {
        title: "Ordinary notice",
        normalizedText: "Routine record.",
        primarySection: "world",
      },
      {
        title: "Ordinary abstract notice",
        normalizedText: "Routine record.",
        primarySection: "world",
      },
      {
        title: "Useful wrapper notice",
        normalizedText: "Artificial intelligence regulation advances.",
        primarySection: "ai_policy",
      },
    ]);
  });

  it("preserves Federal Register raw abstract presence for access classification", async () => {
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({
          results: [
            {
              document_number: "2026-present-blank",
              title: "Present blank abstract",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-present-blank/present-blank",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract: "&nbsp;",
            },
            {
              document_number: "2026-null-abstract",
              title: "Null abstract",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-null-abstract/null-abstract",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract: null,
            },
          ],
        })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "federal-register",
          canonicalName: "Federal Register",
          canonicalUrl: "https://www.federalregister.gov/",
          role: "primary",
          discoveryMechanism: "api",
          sectionEligibility: ["world"],
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "open-government",
            apiUrl:
              "https://www.federalregister.gov/api/v1/documents.json",
            apiFormat: "federal-register-v1",
            urlPolicy: policy("www.federalregister.gov", [
              "/api/v1/documents.json",
              "/documents/",
            ]),
          },
        }),
      ],
    });

    const candidates = (await collector.collect(fixedWindow())).candidates;
    const presentBlank = candidates.find(
      (candidate) =>
        candidate.externalId ===
        "FederalRegister:2026-present-blank",
    );
    const nullAbstract = candidates.find(
      (candidate) =>
        candidate.externalId ===
        "FederalRegister:2026-null-abstract",
    );

    expect(presentBlank).toMatchObject({
      abstract: null,
      accessLevel: "secondary",
    });
    expect(nullAbstract).toMatchObject({
      abstract: null,
      accessLevel: "metadata",
    });
  });

  it.each([
    {
      id: "associated-press",
      name: "Associated Press",
      canonicalUrl: "https://apnews.com/",
      pageUrl: "https://apnews.com/hub/ap-top-news",
      fixture: "ap-top-news.html",
      itemSelector: ".PagePromo",
      linkSelector: "a.Link",
      titleSelector: ".PagePromo-title",
      dateSelector: ".Timestamp",
      dateAttribute: "data-date",
      summarySelector: ".PagePromo-description",
      paths: ["/hub/ap-top-news", "/article/"],
      expectedTitle: "Agencies publish new AI safety evaluation standards",
      expectedUrl:
        "https://apnews.com/article/ai-safety-evaluation-standards",
      sectionEligibility: ["technology"] as const,
      expectedPrimarySection: "technology",
      expectedEntity: "AI",
    },
    {
      id: "baltimore-banner",
      name: "The Baltimore Banner",
      canonicalUrl: "https://www.thebaltimorebanner.com/",
      pageUrl:
        "https://www.thebaltimorebanner.com/community/local-news/",
      fixture: "baltimore-banner-local.html",
      itemSelector: ".tease-card",
      linkSelector: "a.tease-card__link",
      titleSelector: ".tease-card__headline",
      dateSelector: "time",
      dateAttribute: "datetime",
      summarySelector: ".tease-card__dek",
      paths: ["/community/local-news/"],
      expectedTitle: "Baltimore expands secure-compute pilot",
      expectedUrl:
        "https://www.thebaltimorebanner.com/community/local-news/city-council-secure-compute-pilot/",
      sectionEligibility: ["dmv", "baltimore"] as const,
      expectedPrimarySection: "baltimore",
      expectedEntity: "Baltimore",
    },
  ])(
    "discovers metadata-only individual candidates from $name listing",
    async (listingCase) => {
      const fetch = vi.fn(async () =>
        new Response(await loadFixture(listingCase.fixture), {
          headers: { "content-type": "text/html" },
        }),
      );
      const collector = createNewsCollectorFromCatalog({
        http: new SourceHttpClient({
          fetch,
          now: () => new Date("2026-07-29T10:00:00.000Z"),
        }),
        sources: [
          catalogSource({
            id: listingCase.id,
            canonicalName: listingCase.name,
            canonicalUrl: listingCase.canonicalUrl,
            role: "reporting",
            discoveryMechanism: "page",
            sectionEligibility: listingCase.sectionEligibility,
            restrictions: {
              bodyRetrieval: "forbidden",
              paywall: "none",
              contentUse: "metadata-only",
              pageUrl: listingCase.pageUrl,
              urlPolicy: policy(
                new URL(listingCase.pageUrl).hostname,
                listingCase.paths,
              ),
              listing: {
                itemSelector: listingCase.itemSelector,
                linkSelector: listingCase.linkSelector,
                titleSelector: listingCase.titleSelector,
                dateSelector: listingCase.dateSelector,
                dateAttribute: listingCase.dateAttribute,
                summarySelector: listingCase.summarySelector,
                maxItems: 10,
                maxBodyFetches: 0,
              },
            },
          }),
        ],
      });

      const { candidates: items } = await collector.collect(fixedWindow());

      expect(items).toEqual([
        expect.objectContaining({
          sourceId: listingCase.id,
          sourceRole: "reporting",
          title: listingCase.expectedTitle,
          originalUrl: listingCase.expectedUrl,
          accessLevel: "metadata",
          content: null,
          canCorroborateFacts: true,
          metadata: expect.objectContaining({
            discoveryMechanism: "page",
            listingUrl: listingCase.pageUrl,
            extractionLevel: "metadata-only",
            primarySection: listingCase.expectedPrimarySection,
          }),
          sectionEligibility: listingCase.sectionEligibility,
          namedEntities: expect.arrayContaining([
            listingCase.expectedEntity,
          ]),
        }),
      ]);
      expect(items.some((item) => item.originalUrl === listingCase.pageUrl))
        .toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("derives contextual material facts from listing summaries", async () => {
    const host = "facts.example.com";
    const pageUrl = `https://${host}/news`;
    const fetch = vi.fn(async () =>
      new Response(
        `<article>
          <h2><a href="/story">Evaluation Agency evaluation standard update</a></h2>
          <time datetime="2026-07-29T08:00:00.000Z"></time>
          <p>The requirements were adopted for 200 models.</p>
        </article>`,
        { headers: { "content-type": "text/html" } },
      ),
    );
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "facts-source",
          canonicalName: "Facts Source",
          canonicalUrl: `https://${host}/`,
          role: "reporting",
          discoveryMechanism: "page",
          sectionEligibility: ["ai_policy"],
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            pageUrl,
            urlPolicy: policy(host, ["/"]),
            listing: {
              itemSelector: "article",
              linkSelector: "h2 a",
              titleSelector: "h2",
              dateSelector: "time",
              dateAttribute: "datetime",
              summarySelector: "p",
              maxItems: 10,
              maxBodyFetches: 0,
            },
          },
        }),
      ],
    });

    expect(
      (await collector.collect(fixedWindow())).candidates[0],
    ).toMatchObject({
      eventFamilies: ["evaluation-standards"],
      materialFacts: expect.arrayContaining([
        { kind: "status", key: "event-status", value: "adopted" },
        {
          kind: "number",
          key: "count:governance-instrument:models",
          value: "200",
        },
      ]),
    });
  });

  it("decodes provider entities in direct-page listing text", async () => {
    const host = "wamu-entities.example.com";
    const pageUrl = `https://${host}/news`;
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          `<article>
            <h2><a href="/story">WAMU&amp;#8217;s entity update</a></h2>
            <time datetime="2026-07-29T08:00:00.000Z"></time>
            <p>&#8220;quoted&#8221; summary</p>
          </article>`,
          { headers: { "content-type": "text/html" } },
        )),
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "wamu-entities",
          canonicalName: "WAMU",
          canonicalUrl: `https://${host}/`,
          role: "reporting",
          discoveryMechanism: "page",
          sectionEligibility: ["dmv"],
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            pageUrl,
            urlPolicy: policy(host, ["/"]),
            listing: {
              itemSelector: "article",
              linkSelector: "h2 a",
              titleSelector: "h2",
              dateSelector: "time",
              dateAttribute: "datetime",
              summarySelector: "p",
              maxItems: 10,
              maxBodyFetches: 0,
            },
          },
        }),
      ],
    });

    const candidate = (await collector.collect(fixedWindow())).candidates[0];
    expect(candidate).toMatchObject({
      title: "WAMU&#8217;s entity update",
      abstract: "“quoted” summary",
    });
    expect(normalizeCandidate(candidate).title).toBe(
      "WAMU’s entity update",
    );
  });

  it("keeps compatibility-created direct-page tag names out of item routing and isolates tag-only titles", async () => {
    const host = "direct-signal-boundary.example.com";
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          `<article>
            <h2><a href="/title-tag">&#65308;technology&#65310;Ordinary update&#65308;/technology&#65310;</a></h2>
            <time datetime="2026-07-29T08:00:00.000Z"></time>
            <p>Routine details.</p>
          </article>
          <article>
            <h2><a href="/summary-tag">Ordinary summary update</a></h2>
            <time datetime="2026-07-29T08:01:00.000Z"></time>
            <p>&#65308;artificial intelligence regulation&#65310;Routine details.</p>
          </article>
          <article>
            <h2><a href="/useful-wrapper">Useful wrapper update</a></h2>
            <time datetime="2026-07-29T08:02:00.000Z"></time>
            <p>&#65308;span&#65310;Artificial intelligence regulation advances.&#65308;/span&#65310;</p>
          </article>
          <article>
            <h2><a href="/tag-only">&#65308;technology&#65310;</a></h2>
            <time datetime="2026-07-29T08:03:00.000Z"></time>
            <p>Routine details.</p>
          </article>`,
          { headers: { "content-type": "text/html" } },
        )),
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "direct-signal-boundary",
          canonicalName: "Direct Signal Boundary",
          canonicalUrl: `https://${host}/`,
          role: "reporting",
          discoveryMechanism: "page",
          sectionEligibility: ["world", "technology", "ai_policy"],
          restrictions: {
            bodyRetrieval: "forbidden",
            paywall: "none",
            contentUse: "metadata-only",
            pageUrl: `https://${host}/news`,
            urlPolicy: policy(host, ["/"]),
            listing: {
              itemSelector: "article",
              linkSelector: "h2 a",
              titleSelector: "h2",
              dateSelector: "time",
              dateAttribute: "datetime",
              summarySelector: "p",
              maxItems: 10,
              maxBodyFetches: 0,
            },
          },
        }),
      ],
    });

    const candidates = (await collector.collect(fixedWindow())).candidates;
    const items = candidates.map((candidate) => normalizeCandidate(candidate));

    expect(candidates).toHaveLength(3);
    expect(items.map((item) => ({
      title: item.title,
      normalizedText: item.normalizedText,
      primarySection: item.metadata.primarySection,
    }))).toEqual([
      {
        title: "Ordinary update",
        normalizedText: "Routine details.",
        primarySection: "world",
      },
      {
        title: "Ordinary summary update",
        normalizedText: "Routine details.",
        primarySection: "world",
      },
      {
        title: "Useful wrapper update",
        normalizedText: "Artificial intelligence regulation advances.",
        primarySection: "ai_policy",
      },
    ]);
  });

  it("keeps compatibility-created direct-page content tag names out of item routing while retaining wrapper content", async () => {
    const host = "direct-content-boundary.example.com";
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === `https://${host}/news`) {
        return new Response(
          `<article><h2><a href="/tag-name">Ordinary content update</a></h2><time datetime="2026-07-29T08:00:00.000Z"></time></article>
          <article><h2><a href="/useful-wrapper">Useful content update</a></h2><time datetime="2026-07-29T08:01:00.000Z"></time></article>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === `https://${host}/tag-name`) {
        return new Response(
          `<article><p>&#65308;artificial intelligence regulation&#65310;Routine details.</p></article>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === `https://${host}/useful-wrapper`) {
        return new Response(
          `<article><p>&#65308;span&#65310;Artificial intelligence regulation advances.&#65308;/span&#65310;</p></article>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "direct-content-boundary",
          canonicalName: "Direct Content Boundary",
          canonicalUrl: `https://${host}/`,
          role: "reporting",
          discoveryMechanism: "page",
          sectionEligibility: ["world", "ai_policy"],
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "ephemeral-summarization",
            pageUrl: `https://${host}/news`,
            urlPolicy: policy(host, ["/"]),
            listing: {
              itemSelector: "article",
              linkSelector: "h2 a",
              titleSelector: "h2",
              dateSelector: "time",
              dateAttribute: "datetime",
              maxItems: 10,
              maxBodyFetches: 2,
            },
          },
        }),
      ],
    });

    const candidates = (await collector.collect(fixedWindow())).candidates;
    const items = candidates.map((candidate) => normalizeCandidate(candidate));

    expect(items.map((item) => ({
      normalizedText: item.normalizedText,
      primarySection: item.metadata.primarySection,
    }))).toEqual([
      { normalizedText: "Routine details.", primarySection: "world" },
      {
        normalizedText: "Artificial intelligence regulation advances.",
        primarySection: "ai_policy",
      },
    ]);
  });

  it.each([
    {
      id: "reuters",
      name: "Reuters",
      title: "Acme launches AI coding assistant",
      sections: ["morning_brief", "world", "technology", "ai_policy"] as const,
      expected: "technology",
    },
    {
      id: "associated-press",
      name: "Associated Press",
      title: "Senate passes transportation funding bill",
      sections: ["morning_brief", "world", "technology", "ai_policy"] as const,
      expected: "world",
    },
    {
      id: "npr",
      name: "NPR",
      title: "Startup releases artificial intelligence music app",
      sections: ["morning_brief", "world", "technology", "ai_policy"] as const,
      expected: "technology",
    },
  ])(
    "does not misroute ordinary $name coverage into AI policy",
    async (sourceCase) => {
      const host = `${sourceCase.id}.example.com`;
      const pageUrl = `https://${host}/news`;
      const fetch = vi.fn(async () =>
        new Response(
          `<article><h2><a href="/story">${sourceCase.title}</a></h2><time datetime="2026-07-29T08:00:00.000Z"></time><p>Reported details.</p></article>`,
          { headers: { "content-type": "text/html" } },
        ),
      );
      const collector = createNewsCollectorFromCatalog({
        http: new SourceHttpClient({
          fetch,
          now: () => new Date("2026-07-29T10:00:00.000Z"),
        }),
        sources: [
          catalogSource({
            id: sourceCase.id,
            canonicalName: sourceCase.name,
            canonicalUrl: `https://${host}/`,
            role: "reporting",
            discoveryMechanism: "page",
            sectionEligibility: [...sourceCase.sections],
            restrictions: {
              bodyRetrieval: "forbidden",
              paywall: "none",
              contentUse: "metadata-only",
              pageUrl,
              urlPolicy: policy(host, ["/"]),
              listing: {
                itemSelector: "article",
                linkSelector: "h2 a",
                titleSelector: "h2",
                dateSelector: "time",
                dateAttribute: "datetime",
                summarySelector: "p",
                maxItems: 10,
                maxBodyFetches: 0,
              },
            },
          }),
        ],
      });

      const { candidates: result } = await collector.collect(fixedWindow());

      expect(result[0]?.metadata.primarySection).toBe(
        sourceCase.expected,
      );
      expect(result[0]?.metadata.primarySection).not.toBe("ai_policy");
    },
  );

  it.each([
    "National Center for Advancing Translational Sciences; Notice of Meeting",
    "Formations of, Acquisitions by, and Mergers of Bank Holding Companies",
  ])(
    "does not let preferredSection ai_policy route %s without policy evidence",
    async (title) => {
      const host = "ai-policy-source.example.com";
      const fetch = vi.fn(async () =>
        new Response(
          `<article><h2><a href=\"/story\">${title}</a></h2><time datetime=\"2026-07-29T08:00:00.000Z\"></time><p>Reported details.</p></article>`,
          { headers: { "content-type": "text/html" } },
        ),
      );
      const collector = createNewsCollectorFromCatalog({
        http: new SourceHttpClient({
          fetch,
          now: () => new Date("2026-07-29T10:00:00.000Z"),
        }),
        sources: [
          catalogSource({
            id: "ai-policy-source",
            canonicalName: "AI Policy Source",
            canonicalUrl: `https://${host}/`,
            role: "reporting",
            discoveryMechanism: "page",
            sectionEligibility: ["world", "technology", "ai_policy"],
            restrictions: {
              bodyRetrieval: "forbidden",
              paywall: "none",
              contentUse: "metadata-only",
              preferredSection: "ai_policy",
              pageUrl: `https://${host}/news`,
              urlPolicy: policy(host, ["/"]),
              listing: {
                itemSelector: "article",
                linkSelector: "h2 a",
                titleSelector: "h2",
                dateSelector: "time",
                dateAttribute: "datetime",
                summarySelector: "p",
                maxItems: 10,
                maxBodyFetches: 0,
              },
            },
          }),
        ],
      });

      const { candidates } = await collector.collect(fixedWindow());

      expect(candidates[0]?.metadata.primarySection).toBe("world");
    },
  );

  it.each([
    {
      id: "baltimore-brew",
      name: "Baltimore Brew",
      title: "Council approves annual budget",
      sections: ["dmv", "baltimore"] as const,
      preferredSection: "baltimore",
    },
    {
      id: "wamu",
      name: "WAMU",
      title: "Transit board updates weekend service",
      sections: ["world", "dmv"] as const,
      preferredSection: "dmv",
    },
  ])(
    "uses the catalog preferred section for location-implicit $name coverage",
    async (sourceCase) => {
      const host = `${sourceCase.id}.example.com`;
      const pageUrl = `https://${host}/news`;
      const fetch = vi.fn(async () =>
        new Response(
          `<article><h2><a href="/story">${sourceCase.title}</a></h2><time datetime="2026-07-29T08:00:00.000Z"></time><p>Reported details.</p></article>`,
          { headers: { "content-type": "text/html" } },
        ),
      );
      const collector = createNewsCollectorFromCatalog({
        http: new SourceHttpClient({
          fetch,
          now: () => new Date("2026-07-29T10:00:00.000Z"),
        }),
        sources: [
          catalogSource({
            id: sourceCase.id,
            canonicalName: sourceCase.name,
            canonicalUrl: `https://${host}/`,
            role: "reporting",
            discoveryMechanism: "page",
            sectionEligibility: [...sourceCase.sections],
            restrictions: {
              bodyRetrieval: "forbidden",
              paywall: "none",
              contentUse: "metadata-only",
              preferredSection: sourceCase.preferredSection,
              pageUrl,
              urlPolicy: policy(host, ["/"]),
              listing: {
                itemSelector: "article",
                linkSelector: "h2 a",
                titleSelector: "h2",
                dateSelector: "time",
                dateAttribute: "datetime",
                summarySelector: "p",
                maxItems: 10,
                maxBodyFetches: 0,
              },
            },
          }),
        ],
      });

      const { candidates: result } = await collector.collect(fixedWindow());

      expect(result[0]?.metadata.primarySection).toBe(
        sourceCase.preferredSection,
      );
    },
  );

  it("discovers Congress documents and bounds optional item retrieval", async () => {
    const articleFixture = await loadFixture("article.html");
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://www.congress.gov/") {
        return new Response(await loadFixture("congress-latest.html"), {
          headers: { "content-type": "text/html" },
        });
      }
      if (
        url ===
        "https://www.congress.gov/bill/119th-congress/house-bill/4321"
      ) {
        return new Response(articleFixture, {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected Congress URL: ${url}`);
    });
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "congress-gov",
          canonicalName: "Congress.gov",
          canonicalUrl: "https://www.congress.gov/",
          role: "primary",
          discoveryMechanism: "page",
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "open-government",
            pageUrl: "https://www.congress.gov/",
            urlPolicy: policy("www.congress.gov", ["/"]),
            listing: {
              itemSelector: ".basic-search-results-lists > li",
              linkSelector: ".result-heading a",
              dateSelector: ".result-date",
              summarySelector: ".result-summary",
              maxItems: 10,
              maxBodyFetches: 1,
            },
          },
        }),
      ],
    });

    expect((await collector.collect(fixedWindow())).candidates).toEqual([
      expect.objectContaining({
        kind: "document",
        sourceId: "congress-gov",
        title: "H.R. 4321 — Secure Model Evaluation Act",
        originalUrl:
          "https://www.congress.gov/bill/119th-congress/house-bill/4321",
        publishedAt: "2026-07-29T00:00:00.000Z",
        accessLevel: "full_text",
        canCorroborateFacts: true,
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves DC listing metadata when bounded item retrieval gets a 503", async () => {
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://dc.gov/newsroom") {
        return new Response(await loadFixture("dc-newsroom.html"), {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://dc.gov/release/dc-launches-ai-procurement-review") {
        return new Response("temporarily unavailable", { status: 503 });
      }
      throw new Error(`Item fetch budget escaped: ${url}`);
    });
    const collector = createNewsCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-07-29T10:00:00.000Z"),
      }),
      sources: [
        catalogSource({
          id: "dc-gov",
          canonicalName: "DC.gov",
          canonicalUrl: "https://dc.gov/",
          role: "primary",
          discoveryMechanism: "page",
          sectionEligibility: ["dmv"],
          restrictions: {
            bodyRetrieval: "permitted",
            paywall: "none",
            contentUse: "open-government",
            pageUrl: "https://dc.gov/newsroom",
            urlPolicy: policy("dc.gov", ["/newsroom", "/release/"]),
            listing: {
              itemSelector: ".usa-card",
              linkSelector: ".usa-card__heading a",
              dateSelector: "time",
              dateAttribute: "datetime",
              summarySelector: ".usa-card__description",
              maxItems: 10,
              maxBodyFetches: 1,
            },
          },
        }),
      ],
    });

    const { candidates: items } = await collector.collect(fixedWindow());
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.originalUrl)).toEqual([
      "https://dc.gov/release/dc-launches-ai-procurement-review",
      "https://dc.gov/release/dc-publishes-dataset-guidance",
    ]);
    expect(items.every((item) => item.accessLevel === "metadata")).toBe(true);
    expect(items.every((item) => item.content === null)).toBe(true);
    expect(
      items.every(
        (item) =>
          item.metadata.primarySection === "dmv" &&
          item.sectionEligibility.includes("dmv") &&
          item.namedEntities.includes("Washington, D.C."),
      ),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("extractReadableArticle", () => {
  it("extracts article text while excluding navigation, forms, and scripts", async () => {
    const article = extractReadableArticle(
      await loadFixture("article.html"),
      "https://example.com/story",
      "text/html; charset=utf-8",
    );

    expect(article.text).toContain("The reported development");
    expect(article.text).not.toContain("Subscribe now");
    expect(article.text).not.toContain("privateTrackingToken");
    expect(article.extractionLevel).toBe("full");
  });

  it("rejects non-HTML content as metadata-only", () => {
    expect(
      extractReadableArticle(
        '{"secret":"not an article"}',
        "https://example.com/story",
        "application/json",
      ),
    ).toMatchObject({
      text: null,
      extractionLevel: "metadata-only",
    });
  });

  it("caps retained text at 100,000 characters and records partial extraction", () => {
    const longText = "Reported material sentence. ".repeat(5_000);
    const article = extractReadableArticle(
      `<article><h1>Long report</h1><p>${longText}</p></article>`,
      "https://example.com/long-report",
      "text/html",
    );

    expect(article.text?.length).toBeLessThanOrEqual(100_000);
    expect(article.extractionLevel).toBe("partial");
  });

  it("keeps direct readability text over the bound classified as partial", () => {
    const readabilityText = "Readable article text. ".repeat(5_000);
    const parse = vi.spyOn(Readability.prototype, "parse").mockReturnValue({
      title: "Long report",
      content: "<p>Long report</p>",
      textContent: readabilityText,
      length: readabilityText.length,
      excerpt: null,
      byline: null,
      dir: null,
      siteName: null,
      lang: null,
      publishedTime: null,
    });

    try {
      const article = extractReadableArticle(
        "<article><p>Fallback text.</p></article>",
        "https://example.com/direct-readability-long-report",
        "text/html",
      );

      expect(article.text).toHaveLength(100_000);
      expect(article.extractionLevel).toBe("partial");
    } finally {
      parse.mockRestore();
    }
  });

  it("classifies NFKC-expanded readability text as truncated and partial", () => {
    const readabilityText = "ﬃ".repeat(60_000);
    const parse = vi.spyOn(Readability.prototype, "parse").mockReturnValue({
      title: "Compatibility expansion report",
      content: "<p>Compatibility expansion report</p>",
      textContent: readabilityText,
      length: readabilityText.length,
      excerpt: null,
      byline: null,
      dir: null,
      siteName: null,
      lang: null,
      publishedTime: null,
    });

    try {
      const article = extractReadableArticle(
        "<article><p>Fallback text.</p></article>",
        "https://example.com/nfkc-expansion-report",
        "text/html",
      );

      expect(article.text).toHaveLength(100_000);
      expect(article.extractionLevel).toBe("partial");
    } finally {
      parse.mockRestore();
    }
  });

  it("labels a short teaser as partial rather than complete full text", () => {
    const article = extractReadableArticle(
      "<main><h1>Subscriber report</h1><p>A short teaser only.</p></main>",
      "https://example.com/subscriber-report",
      "text/html",
    );

    expect(article.text).toContain("A short teaser only.");
    expect(article.extractionLevel).toBe("partial");
  });
});
