import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { SourceRecord } from "../../../src/db/repository";
import {
  normalizeCandidate,
  prepareRawCandidateForPipeline,
} from "../../../src/editorial/normalize";
import { routePublication } from "../../../src/editorial/route-publication";
import { durableCollectedCandidate } from "../../../src/sources/durable-evidence";
import { SourceHttpClient } from "../../../src/sources/http-client";
import { PapersWithCodeAdapter } from "../../../src/sources/papers-with-code";
import {
  createPublicationCollectorFromCatalog,
} from "../../../src/sources/publication-collector";
import { RssAdapter } from "../../../src/sources/rss";
import {
  RawPublicationCandidateSchema,
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

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "example-lab",
    canonicalName: "Example Lab",
    canonicalUrl: "https://lab.example.org/",
    role: "blog",
    trustPrior: 0.9,
    enabled: true,
    restrictions: {
      bodyRetrieval: "permitted",
      paywall: "none",
      contentUse: "ephemeral-summarization",
      pageUrl: "https://lab.example.org/research/",
      urlPolicy: {
        allowedHosts: ["lab.example.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/research/"],
      },
      feedUrlPolicy: {
        allowedHosts: ["lab.example.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/research/"],
      },
      articleUrlPolicy: {
        allowedHosts: ["lab.example.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/research/"],
      },
    },
    discoveryMechanism: "page",
    sectionEligibility: ["research", "research_radar", "technology", "ai_policy"],
    lastSuccessAt: null,
    healthStatus: "unknown",
    ...overrides,
  };
}

function article(title: string): string {
  return `<!doctype html><html><body><nav>Discard navigation</nav><article><h1>${title}</h1><p>We report a bounded study and method for interpretable AI debate.</p><script>discard()</script></article></body></html>`;
}

function rssSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return source({
    id: "alignment-forum",
    canonicalName: "Alignment Forum",
    canonicalUrl: "https://www.alignmentforum.org/",
    restrictions: {
      bodyRetrieval: "permitted",
      paywall: "none",
      contentUse: "ephemeral-summarization",
      feedUrl: "https://www.alignmentforum.org/feed.xml",
      urlPolicy: {
        allowedHosts: ["www.alignmentforum.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/feed.xml", "/posts/"],
      },
      feedUrlPolicy: {
        allowedHosts: ["www.alignmentforum.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/feed.xml"],
      },
      articleUrlPolicy: {
        allowedHosts: ["www.alignmentforum.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/posts/"],
      },
    },
    discoveryMechanism: "rss",
    sectionEligibility: ["research", "research_radar"],
    ...overrides,
  });
}

function rssAdapterFor(feed: SourceRecord, body: string): RssAdapter {
  return new RssAdapter(
    new SourceHttpClient({
      fetch: vi.fn(async () => new Response(body, {
        headers: { "content-type": "application/rss+xml" },
      })),
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    }),
    [{
      source: ResearchSourceRecordSchema.parse(feed),
      feedUrl: feed.restrictions.feedUrl,
      feedUrlPolicy: feed.restrictions.feedUrlPolicy,
      articleUrlPolicy: feed.restrictions.articleUrlPolicy,
    }],
  );
}

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

describe("PublicationCollector", () => {
  it("collects JSON-LD official listings, bounded stripped detail text, authors, dates, and paper links", async () => {
    const listing = await loadFixture("official-research-listing.html");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://lab.example.org/research/") {
        return new Response(listing, { headers: { "content-type": "text/html" } });
      }
      if (url.startsWith("https://lab.example.org/research/")) {
        return new Response(article("Detail"), { headers: { "content-type": "text/html" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [source()],
    });

    const result = await collector.collect(window);

    expect(result.failures).toEqual([]);
    expect(result.succeededSourceIds).toEqual(["example-lab"]);
    expect(result.candidates).toHaveLength(2);
    const technical = result.candidates.find((candidate) => candidate.title === "A method for interpretable debate");
    expect(technical).toMatchObject({
      kind: "publication",
      discoveryFamily: "official-publication",
      title: "A method for interpretable debate",
      publishedAt: "2026-08-01T14:00:00.000Z",
      authors: ["Ada Example"],
      relatedPaperIds: ["arXiv:2608.00001"],
      sourceRole: "blog",
      sectionEligibility: ["research", "research_radar", "technology", "ai_policy"],
      metadata: {
        canCorroborateFacts: false,
        retention: "ephemeral-only",
        discoveryLaneIds: ["example-lab:page"],
      },
    });
    expect(result.discoveryDiagnostics).toEqual([{
      laneId: "example-lab:page",
      sourceId: "example-lab",
      discoveryFamily: "official-publication",
      discovered: 2,
      deduplicated: 0,
      triaged: 0,
      assessed: 0,
      outcome: "success",
      rejectionCounts: {},
    }]);
    expect(technical?.content).toContain("bounded study");
    expect(technical?.content).not.toContain("Discard navigation");
    expect(technical?.content).not.toContain("discard()");
  });

  it("maps Alignment Forum and LessWrong RSS without duplicating the RSS parser", async () => {
    const rss = (host: string) => `<?xml version="1.0"?><rss><channel><item><title>Original alignment study</title><link>https://${host}/posts/example/original-study</link><guid>${host}-example</guid><pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate><author>Researcher Example</author><description><![CDATA[We present a result related to https://arxiv.org/abs/2608.00001v2.]]></description></item></channel></rss>`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(rss(url.host), {
        headers: { "content-type": "application/rss+xml" },
      });
    });
    const forum = source({
      id: "alignment-forum",
      canonicalName: "Alignment Forum",
      canonicalUrl: "https://www.alignmentforum.org/",
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "ephemeral-summarization",
        feedUrl: "https://www.alignmentforum.org/feed.xml?view=frontpage",
        urlPolicy: { allowedHosts: ["www.alignmentforum.org"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml", "/posts/"] },
        feedUrlPolicy: { allowedHosts: ["www.alignmentforum.org"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml"] },
        articleUrlPolicy: { allowedHosts: ["www.alignmentforum.org"], allowedPorts: [""], allowedPathPrefixes: ["/posts/"] },
      },
      discoveryMechanism: "rss",
      sectionEligibility: ["research", "research_radar"],
    });
    const lesswrong = source({
      id: "lesswrong-curated",
      canonicalName: "LessWrong Curated",
      canonicalUrl: "https://www.lesswrong.com/",
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "ephemeral-summarization",
        feedUrl: "https://www.lesswrong.com/feed.xml?view=curated",
        urlPolicy: { allowedHosts: ["www.lesswrong.com"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml", "/posts/"] },
        feedUrlPolicy: { allowedHosts: ["www.lesswrong.com"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml"] },
        articleUrlPolicy: { allowedHosts: ["www.lesswrong.com"], allowedPorts: [""], allowedPathPrefixes: ["/posts/"] },
      },
      discoveryMechanism: "rss",
      sectionEligibility: ["research", "research_radar"],
    });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({ fetch, now: () => new Date("2026-08-02T12:00:00.000Z") }),
      sources: [forum, lesswrong],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "alignment-forum", discoveryFamily: "commentary", relatedPaperIds: ["arXiv:2608.00001"], metadata: expect.objectContaining({ canCorroborateFacts: false, discoveryLaneIds: ["alignment-forum:rss"] }) }),
      expect.objectContaining({ sourceId: "lesswrong-curated", discoveryFamily: "commentary", relatedPaperIds: ["arXiv:2608.00001"], metadata: expect.objectContaining({ canCorroborateFacts: false, discoveryLaneIds: ["lesswrong-curated:rss"] }) }),
    ]));
    expect(result.discoveryDiagnostics).toEqual([
      expect.objectContaining({
        laneId: "alignment-forum:rss",
        sourceId: "alignment-forum",
        discovered: 1,
        outcome: "success",
      }),
      expect.objectContaining({
        laneId: "lesswrong-curated:rss",
        sourceId: "lesswrong-curated",
        discovered: 1,
        outcome: "success",
      }),
    ]);
  });

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

  it("rejects a LessWrong article URL used as an Alignment Forum feed endpoint", async () => {
    const forum = rssSource({
      restrictions: {
        ...rssSource().restrictions,
        feedUrl: "https://www.lesswrong.com/posts/example/task-gaming",
        urlPolicy: {
          allowedHosts: ["www.alignmentforum.org", "www.lesswrong.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/feed.xml", "/posts/"],
        },
      },
    });
    const result = await createPublicationCollectorFromCatalog({
      http: rssHttp("https://www.lesswrong.com/posts/example/task-gaming"),
      sources: [forum],
    }).collect(window);

    expect(result.candidates).toEqual([]);
    expect(result.failures).toEqual([
      { sourceId: "alignment-forum", kind: "policy" },
    ]);
  });

  it("skips unrelated RSS article hosts while retaining policy-allowed articles", async () => {
    const feed = `<?xml version="1.0"?><rss><channel>
      <item><title>Off policy</title><link>https://unrelated.example/posts/nope</link><pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate></item>
      <item><title>Allowed</title><link>https://www.lesswrong.com/posts/example/task-gaming</link><pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const forum = rssSource({
      restrictions: {
        ...rssSource().restrictions,
        articleUrlPolicy: {
          allowedHosts: ["www.alignmentforum.org", "www.lesswrong.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/posts/"],
        },
      },
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(feed, {
          headers: { "content-type": "application/rss+xml" },
        })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [forum],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        originalUrl: "https://www.lesswrong.com/posts/example/task-gaming",
      }),
    ]);
  });

  it("uses the endpoint policy and article policy for their respective redirect lanes", async () => {
    const listing = `<!doctype html><html><body><article>
      <h2>Redirected research</h2><a href="/articles/example">Read</a>
      <time datetime="2026-08-01T12:00:00Z"></time>
    </article></body></html>`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://lab.example.org/research/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://lab.example.org/research/archive" },
        });
      }
      if (url === "https://lab.example.org/research/archive") {
        return new Response(listing, { headers: { "content-type": "text/html" } });
      }
      if (url === "https://lab.example.org/articles/example") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://lab.example.org/articles/redirected" },
        });
      }
      if (url === "https://lab.example.org/articles/redirected") {
        return new Response(article("Redirected detail"), {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const redirected = source({
      restrictions: {
        ...source().restrictions,
        feedUrlPolicy: {
          allowedHosts: ["lab.example.org"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/research/"],
        },
        articleUrlPolicy: {
          allowedHosts: ["lab.example.org"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/articles/"],
        },
      },
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [redirected],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        originalUrl: "https://lab.example.org/articles/redirected",
        metadata: expect.objectContaining({
          listingUrl: "https://lab.example.org/research/archive",
        }),
      }),
    ]);
  });

  it("blocks a listing redirect into an article-only path", async () => {
    const endpointPolicy = {
      allowedHosts: ["lab.example.org"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/research/"],
    };
    const articlePolicy = {
      allowedHosts: ["lab.example.org"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/articles/"],
    };
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(null, {
          status: 302,
          headers: { location: "https://lab.example.org/articles/not-a-listing" },
        })),
      }),
      sources: [source({
        restrictions: {
          ...source().restrictions,
          feedUrlPolicy: endpointPolicy,
          articleUrlPolicy: articlePolicy,
        },
      })],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toEqual([]);
    expect(result.failures).toEqual([
      { sourceId: "example-lab", kind: "policy" },
    ]);
  });

  it("skips an article whose redirect enters an endpoint-only path", async () => {
    const listing = `<!doctype html><html><body><article>
      <h2>Redirected research</h2><a href="/articles/example">Read</a>
      <time datetime="2026-08-01T12:00:00Z"></time>
    </article></body></html>`;
    const endpointPolicy = {
      allowedHosts: ["lab.example.org"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/research/"],
    };
    const articlePolicy = {
      allowedHosts: ["lab.example.org"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/articles/"],
    };
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async (input: string | URL | Request) => {
          switch (String(input)) {
            case "https://lab.example.org/research/":
              return new Response(listing, {
                headers: { "content-type": "text/html" },
              });
            case "https://lab.example.org/articles/example":
              return new Response(null, {
                status: 302,
                headers: { location: "https://lab.example.org/research/not-an-article" },
              });
            default:
              throw new Error(`Unexpected URL: ${input}`);
          }
        }),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [source({
        restrictions: {
          ...source().restrictions,
          feedUrlPolicy: endpointPolicy,
          articleUrlPolicy: articlePolicy,
        },
      })],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.succeededSourceIds).toEqual(["example-lab"]);
  });

  it.each(["feedUrlPolicy", "articleUrlPolicy"] as const)(
    "fails only the source missing split policy %s while a healthy RSS sibling succeeds",
    async (missingPolicy) => {
      const restrictions = { ...rssSource().restrictions };
      delete restrictions[missingPolicy];
      const broken = rssSource({ id: `missing-${missingPolicy}`, restrictions });
      const healthy = rssSource({ id: "healthy-rss" });
      const result = await createPublicationCollectorFromCatalog({
        http: rssHttp("https://www.alignmentforum.org/posts/example/task-gaming"),
        sources: [broken, healthy],
      }).collect(window);

      expect(result.candidates).toHaveLength(1);
      expect(result.succeededSourceIds).toEqual(["healthy-rss"]);
      expect(result.failures).toEqual([
        { sourceId: `missing-${missingPolicy}`, kind: "parse" },
      ]);
    },
  );

  it("retains MIT RSS items under the separate article policy", async () => {
    const mit = rssSource({
      id: "mit-research",
      canonicalName: "MIT News Research",
      canonicalUrl: "https://news.mit.edu/",
      restrictions: {
        ...rssSource().restrictions,
        feedUrl: "https://news.mit.edu/rss/topic/artificial-intelligence2",
        urlPolicy: {
          allowedHosts: ["news.mit.edu"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/rss/"],
        },
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
      },
    });
    const result = await createPublicationCollectorFromCatalog({
      http: rssHttp("https://news.mit.edu/2026/example-ai-research-0807"),
      sources: [mit],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates[0]?.originalUrl)
      .toBe("https://news.mit.edu/2026/example-ai-research-0807");
  });

  it("marks oversized RSS bodies ephemeral so durable checkpoints bound them", async () => {
    const oversized = `${"feed evidence ".repeat(220)}RSS_BODY_TAIL`;
    const rss = `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Bounded feed study</title><link>https://www.alignmentforum.org/posts/example/bounded-feed</link><guid>bounded-feed</guid><pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate><content:encoded><![CDATA[${oversized}]]></content:encoded></item></channel></rss>`;
    const forum = source({
      id: "alignment-forum",
      canonicalName: "Alignment Forum",
      canonicalUrl: "https://www.alignmentforum.org/",
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "ephemeral-summarization",
        feedUrl: "https://www.alignmentforum.org/feed.xml?view=frontpage",
        urlPolicy: { allowedHosts: ["www.alignmentforum.org"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml", "/posts/"] },
        feedUrlPolicy: { allowedHosts: ["www.alignmentforum.org"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml"] },
        articleUrlPolicy: { allowedHosts: ["www.alignmentforum.org"], allowedPorts: [""], allowedPathPrefixes: ["/posts/"] },
      },
      discoveryMechanism: "rss",
      sectionEligibility: ["research", "research_radar"],
    });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(rss, { headers: { "content-type": "application/rss+xml" } })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [forum],
    });

    const candidate = (await collector.collect(window)).candidates[0]!;
    const durable = durableCollectedCandidate(candidate);

    expect(candidate.metadata.retention).toBe("ephemeral-only");
    expect([...durable.abstract!]).toHaveLength(2_000);
    expect(durable.abstract).not.toContain("RSS_BODY_TAIL");
    expect(durable.content).toBeNull();
  });

  it("settles eligible blog sources independently and ignores ineligible catalog rows", async () => {
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => { throw new TypeError("offline"); }),
        maxRetries: 0,
      }),
      sources: [
        source({ id: "broken" }),
        source({ id: "disabled", enabled: false }),
        source({ id: "reporting", role: "reporting" }),
        source({ id: "analysis", role: "analysis" }),
        source({ id: "world-blog", sectionEligibility: ["world"] }),
      ],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toEqual([]);
    expect(result.failures).toEqual([{ sourceId: "broken", kind: "fetch" }]);
    expect(result.discoveryDiagnostics).toEqual([{
      laneId: "broken:page",
      sourceId: "broken",
      discoveryFamily: "official-publication",
      discovered: 0,
      deduplicated: 0,
      triaged: 0,
      assessed: 0,
      outcome: "fetch",
      rejectionCounts: {},
    }]);
  });

  it("fails open when the OpenAI listing receives a 403 while a healthy publication RSS lane survives", async () => {
    const openai = source({
      id: "openai",
      canonicalName: "OpenAI Research",
      canonicalUrl: "https://openai.com/research/",
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "ephemeral-summarization",
        pageUrl: "https://openai.com/research/index/publication/",
        urlPolicy: {
          allowedHosts: ["openai.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/research/index/publication/", "/index/", "/research/"],
        },
        feedUrlPolicy: {
          allowedHosts: ["openai.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/research/index/publication/"],
        },
        articleUrlPolicy: {
          allowedHosts: ["openai.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/index/", "/research/"],
        },
      },
    });
    const healthy = rssSource({ id: "healthy-publication" });
    const healthyFeed = `<?xml version="1.0"?><rss><channel><item>
      <title>Healthy publication</title>
      <link>https://www.alignmentforum.org/posts/example/healthy-publication</link>
      <guid>healthy-publication</guid>
      <pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate>
      <description>Healthy RSS evidence.</description>
    </item></channel></rss>`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://openai.com/research/index/publication/") {
        return new Response("blocked", { status: 403 });
      }
      return new Response(healthyFeed, {
        headers: { "content-type": "application/rss+xml" },
      });
    });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [openai, healthy],
    });

    const result = await collector.collect(window);

    expect(result.failures).toContainEqual({ sourceId: "openai", kind: "fetch" });
    expect(result.candidates).toEqual([
      expect.objectContaining({ sourceId: "healthy-publication" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("blocked");
  });

  it("retains a real page lane when collection succeeds with zero results", async () => {
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () =>
          new Response("<!doctype html><html><body></body></html>", {
            headers: { "content-type": "text/html" },
          })
        ),
      }),
      sources: [source()],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toEqual([]);
    expect(result.discoveryDiagnostics).toEqual([{
      laneId: "example-lab:page",
      sourceId: "example-lab",
      discoveryFamily: "official-publication",
      discovered: 0,
      deduplicated: 0,
      triaged: 0,
      assessed: 0,
      outcome: "success",
      rejectionCounts: {},
    }]);
  });

  it("uses configured selectors only when JSON-LD is absent and caps items and detail fetches", async () => {
    const entries = Array.from({ length: 22 }, (_, index) =>
      `<article class="result"><a class="link" href="/research/item-${index}">Result ${index}</a><time datetime="2026-08-01T12:00:00Z"></time><p>Study ${index}</p></article>`,
    ).join("");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        url === "https://lab.example.org/research/"
          ? `<!doctype html><html><body>${entries}</body></html>`
          : article("Detail"),
        { headers: { "content-type": "text/html" } },
      );
    });
    const configured = source({
      restrictions: {
        ...source().restrictions,
        listing: {
          itemSelector: ".result",
          linkSelector: ".link",
          dateSelector: "time",
          dateAttribute: "datetime",
          summarySelector: "p",
          maxItems: 20,
          maxBodyFetches: 10,
        },
      },
    });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({ fetch, now: () => new Date("2026-08-02T12:00:00.000Z") }),
      sources: [configured],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toHaveLength(20);
    expect(fetch).toHaveBeenCalledTimes(11);
    expect(result.candidates.filter((candidate) => candidate.content !== null)).toHaveLength(10);
  });

  it("marks unfetched listing summaries ephemeral so durable checkpoints bound them", async () => {
    const oversized = `${"listing evidence ".repeat(180)}LISTING_SUMMARY_TAIL`;
    const listing = `<!doctype html><html><body><article class="result"><a class="link" href="/research/unfetched">Unfetched study</a><time datetime="2026-08-01T12:00:00Z"></time><p>${oversized}</p></article></body></html>`;
    const configured = source({
      restrictions: {
        ...source().restrictions,
        listing: {
          itemSelector: ".result",
          linkSelector: ".link",
          dateSelector: "time",
          dateAttribute: "datetime",
          summarySelector: "p",
          maxItems: 20,
          maxBodyFetches: 0,
        },
      },
    });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(listing, { headers: { "content-type": "text/html" } })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [configured],
    });

    const candidate = (await collector.collect(window)).candidates[0]!;
    const durable = durableCollectedCandidate(candidate);

    expect(candidate.content).toBeNull();
    expect(candidate.metadata.retention).toBe("ephemeral-only");
    expect([...durable.abstract!]).toHaveLength(2_000);
    expect(durable.abstract).not.toContain("LISTING_SUMMARY_TAIL");
  });

  it("falls back to semantic article markup when structured configuration is absent", async () => {
    const listing = `<!doctype html><html><body><article><h2>Fallback research result</h2><a href="/research/fallback">Read</a><time datetime="2026-08-01T12:00:00Z"></time><p>An alignment study.</p></article></body></html>`;
    const fetch = vi.fn(async (input: string | URL | Request) => new Response(
      String(input).endsWith("/research/") ? listing : article("Fallback detail"),
      { headers: { "content-type": "text/html" } },
    ));
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({ fetch, now: () => new Date("2026-08-02T12:00:00.000Z") }),
      sources: [source()],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ title: "Fallback research result" });
  });
});

describe("RssAdapter feed normalization", () => {
  it("keeps encoded RSS sourceName markup raw before central typed rejection", async () => {
    const rawTitle = "&lt;strong&gt;Useful RSS title&lt;/strong&gt;";
    const feed = rssSource({ canonicalName: "&lt;br&gt;" });
    const rssResult = await rssAdapterFor(
      feed,
      `<?xml version="1.0"?><rss><channel><item>
          <title><![CDATA[${rawTitle}]]></title>
          <link>https://www.alignmentforum.org/posts/example/encoded-markup?label=%26lt%3Bbr%26gt%3B</link>
          <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
          <description>Useful bounded evidence.</description>
        </item></channel></rss>`,
    ).collect(window);
    const candidate = rssResult.candidates[0]!;

    expect(candidate.sourceName).toBe("&lt;br&gt;");
    let observed: unknown;
    try {
      normalizeCandidate(candidate);
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ field: "sourceName" });
  });

  it.each([
    {
      encoding: "entity-encoded",
      tagOnly: "&lt;br&gt;",
      useful:
        "&lt;strong&gt;Useful RSS title&lt;/strong&gt;",
    },
    {
      encoding: "compatibility-encoded",
      tagOnly: "&#65308;br&#65310;",
      useful:
        "&#65308;strong&#65310;Useful RSS title&#65308;/strong&#65310;",
    },
  ])(
    "isolates a $encoding tag-only RSS title without losing its useful sibling",
    async ({ tagOnly, useful }) => {
      const rssResult = await rssAdapterFor(
        rssSource(),
        `<?xml version="1.0"?><rss><channel>
          <item>
            <title><![CDATA[${tagOnly}]]></title>
            <link>https://www.alignmentforum.org/posts/example/tag-only</link>
            <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
            <description>Routine evidence.</description>
          </item>
          <item>
            <title><![CDATA[${useful}]]></title>
            <link>https://www.alignmentforum.org/posts/example/useful-sibling</link>
            <pubDate>Sat, 02 Aug 2026 12:01:00 GMT</pubDate>
            <description>Useful bounded evidence.</description>
          </item>
        </channel></rss>`,
      ).collect(window);

      expect(rssResult.candidates).toHaveLength(1);
      expect(rssResult.candidates[0]?.title).toBe(useful);
      expect(normalizeCandidate(rssResult.candidates[0])).toMatchObject({
        title: "Useful RSS title",
        normalizedText: "Useful bounded evidence.",
      });
    },
  );

  it("strips useful encoded RSS wrappers without decoding its URL", async () => {
    const originalUrl =
      "https://www.alignmentforum.org/posts/example/useful-markup?label=%26lt%3Bbr%26gt%3B";
    const rssResult = await rssAdapterFor(
      rssSource({
        canonicalName: "&lt;em&gt;Useful RSS source&lt;/em&gt;",
      }),
      `<?xml version="1.0"?><rss><channel><item>
        <title><![CDATA[&lt;script&gt;Useful RSS title&lt;/script&gt;]]></title>
        <link>${originalUrl}</link>
        <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
        <description>Useful bounded evidence.</description>
      </item></channel></rss>`,
    ).collect(window);
    const candidate = rssResult.candidates[0]!;

    expect(candidate).toMatchObject({
      title: "&lt;script&gt;Useful RSS title&lt;/script&gt;",
      sourceName: "&lt;em&gt;Useful RSS source&lt;/em&gt;",
      originalUrl,
    });
    const normalized = normalizeCandidate(candidate);
    expect(normalized.title).toBe("Useful RSS title");
    expect(normalized.sourceRefs[0]?.name).toBe("Useful RSS source");
    expect(normalized.canonicalUrl).toBe(originalUrl);
    expect(JSON.stringify(normalized)).not.toMatch(/<(?:script|em)>/i);
  });

  it("keeps compatibility-encoded RSS sourceName raw before central typed rejection", async () => {
    const tagOnly = "&#65308;br&#65310;";
    const usefulTitle =
      "&#65308;strong&#65310;Useful RSS title&#65308;/strong&#65310;";
    const rssResult = await rssAdapterFor(
      rssSource({ canonicalName: tagOnly }),
      `<?xml version="1.0"?><rss><channel><item>
          <title><![CDATA[${usefulTitle}]]></title>
          <link>https://www.alignmentforum.org/posts/example/compatibility-markup?label=%EF%BC%86%238217%3B</link>
          <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
          <description>Useful bounded evidence.</description>
        </item></channel></rss>`,
    ).collect(window);
    const candidate = rssResult.candidates[0]!;

    expect(candidate.sourceName).toBe(tagOnly);
    expect(candidate.originalUrl).toContain(
      "label=%EF%BC%86%238217%3B",
    );
    let observed: unknown;
    try {
      normalizeCandidate(candidate);
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ field: "sourceName" });
  });

  it("strips compatibility-created RSS wrappers after its raw boundary", async () => {
    const originalUrl =
      "https://www.alignmentforum.org/posts/example/compatibility-useful?label=%EF%BC%86%238217%3B";
    const rawTitle =
      "&#65308;script&#65310;Useful RSS title&#65308;/script&#65310;";
    const rawSource =
      "&#65308;em&#65310;Useful RSS source&#65308;/em&#65310;";
    const rssResult = await rssAdapterFor(
      rssSource({ canonicalName: rawSource }),
      `<?xml version="1.0"?><rss><channel><item>
        <title><![CDATA[${rawTitle}]]></title>
        <link>${originalUrl}</link>
        <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
        <description><![CDATA[&#65308;p&#65310;Useful evidence&#65308;/p&#65310;]]></description>
      </item></channel></rss>`,
    ).collect(window);
    const candidate = rssResult.candidates[0]!;

    expect(candidate).toMatchObject({
      title: rawTitle,
      sourceName: rawSource,
      originalUrl,
    });
    const normalized = normalizeCandidate(candidate);
    expect(normalized.title).toBe("Useful RSS title");
    expect(normalized.sourceRefs[0]?.name).toBe("Useful RSS source");
    expect(normalized.normalizedText).toBe("Useful evidence");
    expect(normalized.canonicalUrl).toBe(originalUrl);
    expect(JSON.stringify(normalized)).not.toMatch(
      /<(?:script|em|p)>/i,
    );
  });

  it("keeps triple-encoded RSS text inert after central normalization", async () => {
    const rssResult = await rssAdapterFor(
      rssSource(),
      `<?xml version="1.0"?><rss><channel><item>
        <title><![CDATA[Interpretability&amp;amp;#8217;s frontier]]></title>
        <link>https://www.alignmentforum.org/posts/example/triple</link>
        <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
        <description><![CDATA[Evidence&amp;amp;#8217;s boundary.]]></description>
      </item></channel></rss>`,
    ).collect(window);

    const item = normalizeCandidate(rssResult.candidates[0]!);

    expect(item.title).toBe("Interpretability&#8217;s frontier");
    expect(item.normalizedText).toBe("Evidence&#8217;s boundary.");
  });

  it("decodes WAMU-style provider entities in RSS titles and descriptions", async () => {
    const rssResult = await rssAdapterFor(
      rssSource(),
      `<?xml version="1.0"?><rss><channel><item>
        <title><![CDATA[WAMU&#8217;s briefing]]></title>
        <link>https://www.alignmentforum.org/posts/example/wamu</link>
        <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
        <description><![CDATA[It&amp;#8217;s a provider update.]]></description>
      </item></channel></rss>`,
    ).collect(window);

    const candidate = rssResult.candidates[0];
    expect(candidate).toMatchObject({
      title: "WAMU&#8217;s briefing",
      abstract: "It&amp;#8217;s a provider update.",
    });
    const normalized = normalizeCandidate(candidate);
    expect(normalized).toMatchObject({
      title: "WAMU’s briefing",
      normalizedText: "It’s a provider update.",
    });
  });

  it("keeps an interpretable structured-link RSS entry when a malformed sibling is skipped", async () => {
    const rssResult = await rssAdapterFor(
      rssSource(),
      await loadFixture("alignment-forum-feed.xml"),
    ).collect(window);

    expect(rssResult.failures).toEqual([]);
    expect(rssResult.candidates).toHaveLength(1);
    expect(rssResult.candidates[0]).toMatchObject({
      title: "A valid alignment result",
      authors: ["Researcher Example"],
    });
  });

  it("normalizes Atom entries with href links and structured authors", async () => {
    const atomResult = await rssAdapterFor(
      rssSource({
        id: "lesswrong-curated",
        canonicalName: "LessWrong Curated",
        canonicalUrl: "https://www.lesswrong.com/",
        restrictions: {
          bodyRetrieval: "permitted",
          paywall: "none",
          contentUse: "ephemeral-summarization",
          feedUrl: "https://www.lesswrong.com/feed.xml",
          urlPolicy: {
            allowedHosts: ["www.lesswrong.com"],
            allowedPorts: [""],
            allowedPathPrefixes: ["/feed.xml", "/posts/"],
          },
          feedUrlPolicy: {
            allowedHosts: ["www.lesswrong.com"],
            allowedPorts: [""],
            allowedPathPrefixes: ["/feed.xml"],
          },
          articleUrlPolicy: {
            allowedHosts: ["www.lesswrong.com"],
            allowedPorts: [""],
            allowedPathPrefixes: ["/posts/"],
          },
        },
      }),
      await loadFixture("atom-research-feed.xml"),
    ).collect(window);

    expect(atomResult.failures).toEqual([]);
    expect(atomResult.candidates).toHaveLength(1);
    expect(atomResult.candidates[0]).toMatchObject({
      externalId: "urn:example:atom-result",
      publishedAt: "2026-08-02T12:00:00.000Z",
    });
  });

  it("uses the first policy-allowed alternate or canonical link in feed order", async () => {
    const result = await rssAdapterFor(
      rssSource(),
      `<?xml version="1.0"?><feed><entry>
        <title>Policy-aware link selection</title>
        <link rel="alternate" href="https://off-policy.example/posts/rejected" />
        <link rel="canonical" href="https://www.alignmentforum.org/posts/example/accepted" />
      </entry></feed>`,
    ).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        title: "Policy-aware link selection",
        originalUrl:
          "https://www.alignmentforum.org/posts/example/accepted",
      }),
    ]);
  });

  it("reports a parse failure when a nonempty feed has no interpretable entries", async () => {
    const noValidEntries = await rssAdapterFor(
      rssSource({ id: "lesswrong-curated" }),
      `<?xml version="1.0"?><feed><entry>
        <title>Malformed item</title>
        <link rel="alternate" href="javascript:alert(1)" />
        <link rel="canonical" href="https://off-policy.example/posts/rejected" />
      </entry></feed>`,
    ).collect(window);

    expect(noValidEntries.failures).toEqual([
      { sourceId: "lesswrong-curated", kind: "parse" },
    ]);
  });

  it("bounds oversized titles before final safety validation", async () => {
    const unsafeTitle = "ﬃ".repeat(200);
    const noSafeEntries = await rssAdapterFor(
      rssSource({ id: "lesswrong-curated" }),
      `<?xml version="1.0"?><rss><channel><item><title>${unsafeTitle}</title><link>https://www.alignmentforum.org/posts/example/unsafe-result</link></item></channel></rss>`,
    ).collect(window);

    expect(noSafeEntries.failures).toEqual([]);
    expect(noSafeEntries.candidates[0]?.title).toHaveLength(500);
  });

  it("keeps a valid feed successful when its entries fall outside the collection window", async () => {
    const outOfWindow = await rssAdapterFor(
      rssSource(),
      "<?xml version=\"1.0\"?><rss><channel><item><title>Older result</title><link>https://www.alignmentforum.org/posts/example/older-result</link><pubDate>Sat, 01 Aug 2020 12:00:00 GMT</pubDate></item></channel></rss>",
    ).collect(window);

    expect(outOfWindow.failures).toEqual([]);
    expect(outOfWindow.candidates).toEqual([]);
  });
});

describe("PapersWithCodeAdapter", () => {
  it("decodes topical provider text before publication routing", async () => {
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          `<!doctype html><html><body><section>
            <h2>Relevant papers</h2>
            <article>
              <a href="/paper/2608.12345">&amp;#105;nterpretability study results</a>
              <time datetime="2026-08-02">August 2, 2026</time>
            </article>
            <article>
              <a href="/paper/2608.12346">&#65308;interpretability&#65310;Ordinary study results&#65308;/interpretability&#65310;</a>
              <time datetime="2026-08-02">August 2, 2026</time>
            </article>
          </section></body></html>`,
          { headers: { "content-type": "text/html" } },
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      ResearchSourceRecordSchema.parse(rssSource({
        id: "papers-with-code-co",
        canonicalName: "Papers with Code",
        canonicalUrl: "https://paperswithcode.co/",
        role: "analysis",
        restrictions: {
          bodyRetrieval: "permitted",
          paywall: "none",
          contentUse: "discovery-metadata-only",
        },
        sectionEligibility: ["research", "research_radar"],
      })),
    );

    const candidates = await adapter.collect(window);
    const candidate = candidates[0]!;
    const routed = routePublication(
      RawPublicationCandidateSchema.parse(
        prepareRawCandidateForPipeline(candidate),
      ),
    );

    expect(candidate.title).toBe("&#105;nterpretability study results");
    expect(routed).toMatchObject({
      topics: ["alignment-interpretability"],
      metadata: { primarySection: "research" },
    });
    expect(candidates[1]?.title).toBe(
      "<interpretability>Ordinary study results</interpretability>",
    );
    expect(routePublication(
      RawPublicationCandidateSchema.parse(
        prepareRawCandidateForPipeline(candidates[1]),
      ),
    )).toBeNull();
  });

  it("parses only on-origin paper links into discovery-only identifiers and code metadata", async () => {
    const fixture = await loadFixture("papers-with-code-recent.html");
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => new Response(fixture, { headers: { "content-type": "text/html" } })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      ResearchSourceRecordSchema.parse(source({
        id: "papers-with-code-co",
        canonicalName: "Papers with Code",
        canonicalUrl: "https://paperswithcode.co/",
        role: "analysis",
        restrictions: {
          bodyRetrieval: "permitted",
          paywall: "none",
          contentUse: "discovery-metadata-only",
          pageUrl: "https://paperswithcode.co/?order_by=date_published",
          urlPolicy: { allowedHosts: ["paperswithcode.co"], allowedPorts: [""], allowedPathPrefixes: ["/"] },
        },
        discoveryMechanism: "page",
        sectionEligibility: ["research", "research_radar"],
      })),
    );

    const candidates = await adapter.collect(window);

    expect(adapter.laneId).toBe("papers-with-code-co:page");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      externalId: "arXiv:2608.00001",
      externalIds: ["arXiv:2608.00001"],
      relatedPaperIds: ["arXiv:2608.00001"],
      discoveryFamily: "commentary",
      accessLevel: "metadata",
      abstract: null,
      content: null,
      metadata: {
        implementationAvailable: true,
        canCorroborateFacts: false,
        discoveryLaneIds: ["papers-with-code-co:page"],
      },
    });
    expect(candidates[1]).toMatchObject({
      externalId: "papers-with-code:98456",
      relatedPaperIds: ["papers-with-code:98456"],
      metadata: { implementationAvailable: false },
    });
    expect(JSON.stringify(candidates)).not.toContain("98.7");
    expect(JSON.stringify(candidates)).not.toContain("2608.99999");
  });
});
