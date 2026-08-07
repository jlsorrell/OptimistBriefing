import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { SourceRecord } from "../../../src/db/repository";
import { routePublication } from "../../../src/editorial/route-publication";
import { durableCollectedCandidate } from "../../../src/sources/durable-evidence";
import { SourceHttpClient } from "../../../src/sources/http-client";
import { PapersWithCodeAdapter } from "../../../src/sources/papers-with-code";
import {
  createPublicationCollectorFromCatalog,
} from "../../../src/sources/publication-collector";
import { RssAdapter } from "../../../src/sources/rss";
import { ResearchSourceRecordSchema, type CollectionWindow } from "../../../src/sources/types";

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
    },
    discoveryMechanism: "rss",
    sectionEligibility: ["research", "research_radar"],
    ...overrides,
  });
}

function rssAdapterFor(feed: SourceRecord, body: string): RssAdapter {
  const urlPolicy = feed.restrictions.urlPolicy!;
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
      feedUrlPolicy: urlPolicy,
      articleUrlPolicy: urlPolicy,
    }],
  );
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
      title: "WAMU’s briefing",
      abstract: "It’s a provider update.",
    });
    expect(JSON.stringify(candidate)).not.toMatch(/&#(?:x[0-9a-f]+|[0-9]+);/i);
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

  it("reports a parse failure when all otherwise-normalized entries fail final safety validation", async () => {
    const unsafeTitle = "A".repeat(501);
    const noSafeEntries = await rssAdapterFor(
      rssSource({ id: "lesswrong-curated" }),
      `<?xml version="1.0"?><rss><channel><item><title>${unsafeTitle}</title><link>https://www.alignmentforum.org/posts/example/unsafe-result</link></item></channel></rss>`,
    ).collect(window);

    expect(noSafeEntries.failures).toEqual([
      { sourceId: "lesswrong-curated", kind: "parse" },
    ]);
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

    const candidate = (await adapter.collect(window))[0]!;
    const routed = routePublication(candidate);

    expect(candidate.title).toBe("interpretability study results");
    expect(routed).toMatchObject({
      topics: ["alignment-interpretability"],
      metadata: { primarySection: "research" },
    });
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
