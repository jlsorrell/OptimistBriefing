import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  extractReadableArticle,
} from "../../../src/sources/article-extractor";
import { GdeltAdapter } from "../../../src/sources/gdelt";
import { SourceHttpClient } from "../../../src/sources/http-client";
import { NewsCollector } from "../../../src/sources/news-collector";
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
  it("labels Polymarket data as forecast and never as corroborating reporting", async () => {
    const { collector } = await newsCollectorWithFixtures();
    const items = await collector.collect(fixedWindow());
    const market = items.find((item) => item.kind === "forecast");

    expect(market?.sourceRole).toBe("forecast");
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

  it("keeps GDELT as non-corroborating discovery metadata, not article truth", async () => {
    const { collector } = await newsCollectorWithFixtures();
    const items = await collector.collect(fixedWindow());
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
    const item = (await collector.collect(fixedWindow())).find(
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
          if (String(input) === `https://${role}.example.com/feed.xml`) {
            return new Response(await loadFixture("local-news.xml"), {
              headers: { "content-type": "application/rss+xml" },
            });
          }
          throw new Error("Article body must not be fetched");
        }),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      });
      const collector = new NewsCollector({
        http,
        directFeeds: [
          {
            source: contextualSource,
            feedUrl: `https://${role}.example.com/feed.xml`,
          },
        ],
        discoveryAdapters: [],
        forecastAdapters: [],
      });

      expect((await collector.collect(fixedWindow()))[0]).toMatchObject({
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
        },
      ],
      discoveryAdapters: [],
      forecastAdapters: [],
    });

    expect((await collector.collect(fixedWindow()))[0]).toMatchObject({
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
});
