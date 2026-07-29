import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { SourceRecord } from "../../../src/db/repository";
import {
  extractReadableArticle,
} from "../../../src/sources/article-extractor";
import { GdeltAdapter } from "../../../src/sources/gdelt";
import { SourceHttpClient } from "../../../src/sources/http-client";
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
  it("labels Polymarket data as forecast and never as corroborating reporting", async () => {
    const { collector } = await newsCollectorWithFixtures();
    const items = await collector.collect(fixedWindow());
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
          feedUrlPolicy: wyprFeedPolicy,
          articleUrlPolicy: wyprArticlePolicy,
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

    expect(await collector.collect(fixedWindow())).toEqual([
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

    expect(await collector.collect(fixedWindow())).toEqual([]);
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

    expect(await collector.collect(fixedWindow())).toEqual([]);
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
              title: "Secure evaluation requirements",
              html_url:
                "https://www.federalregister.gov/documents/2026/07/29/2026-12345/secure-evaluation-requirements",
              publication_date: "2026-07-29",
              type: "Notice",
              abstract:
                "The agency published secure evaluation requirements.",
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

    const items = await collector.collect(fixedWindow());
    expect(
      items.find((item) => item.sourceId === "federal-register"),
    ).toMatchObject({
      kind: "document",
      sourceRole: "primary",
      canCorroborateFacts: true,
      title: "Secure evaluation requirements",
      originalUrl:
        "https://www.federalregister.gov/documents/2026/07/29/2026-12345/secure-evaluation-requirements",
      metadata: {
        documentNumber: "2026-12345",
        documentType: "Notice",
      },
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

      const items = await collector.collect(fixedWindow());

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
          }),
        }),
      ]);
      expect(items.some((item) => item.originalUrl === listingCase.pageUrl))
        .toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
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

    expect(await collector.collect(fixedWindow())).toEqual([
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

    const items = await collector.collect(fixedWindow());
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.originalUrl)).toEqual([
      "https://dc.gov/release/dc-launches-ai-procurement-review",
      "https://dc.gov/release/dc-publishes-dataset-guidance",
    ]);
    expect(items.every((item) => item.accessLevel === "metadata")).toBe(true);
    expect(items.every((item) => item.content === null)).toBe(true);
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
