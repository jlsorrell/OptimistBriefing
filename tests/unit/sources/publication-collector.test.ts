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

function reviewedLabSource(
  id: "anthropic" | "google-deepmind" | "google-research",
): SourceRecord {
  const configuration = {
    anthropic: {
      canonicalName: "Anthropic Research",
      canonicalUrl: "https://www.anthropic.com/research",
      pageUrl: "https://www.anthropic.com/research",
      host: "www.anthropic.com",
      prefix: "/research/",
    },
    "google-deepmind": {
      canonicalName: "Google DeepMind",
      canonicalUrl: "https://deepmind.google/",
      pageUrl: "https://deepmind.google/blog/",
      host: "deepmind.google",
      prefix: "/blog/",
    },
    "google-research": {
      canonicalName: "Google Research",
      canonicalUrl: "https://research.google/",
      pageUrl: "https://research.google/blog/",
      host: "research.google",
      prefix: "/blog/",
    },
  }[id];
  const pagePolicy = {
    allowedHosts: [configuration.host],
    allowedPorts: [""],
    allowedPathPrefixes: [new URL(configuration.pageUrl).pathname],
  };
  const articlePolicy = {
    allowedHosts: [configuration.host],
    allowedPorts: [""],
    allowedPathPrefixes: [configuration.prefix],
  };
  return source({
    id,
    canonicalName: configuration.canonicalName,
    canonicalUrl: configuration.canonicalUrl,
    restrictions: {
      bodyRetrieval: "permitted",
      paywall: "none",
      contentUse: "ephemeral-summarization",
      pageUrl: configuration.pageUrl,
      urlPolicy: pagePolicy,
      feedUrlPolicy: pagePolicy,
      articleUrlPolicy: articlePolicy,
      listing: {
        itemSelector: ".catalog-controlled-selector-that-must-not-run",
        linkSelector: "a[href]",
        dateSelector: "time",
      },
    },
  });
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

function responseWithUrl(
  body: string,
  url: string,
  headers: HeadersInit = { "content-type": "text/html" },
): Response {
  const response = new Response(body, { headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
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
      observed: 2,
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

  it("collects relevant entries from each reviewed lab profile and skips navigation, product, and off-policy siblings", async () => {
    const anthropic = await loadFixture("anthropic-research-listing.html");
    const deepmind = await loadFixture("deepmind-blog-listing.html");
    const deepmindDetail = await loadFixture("deepmind-blog-detail.html");
    const google = await loadFixture("google-research-blog-listing.html");
    const listings = new Map([
      ["https://www.anthropic.com/research", anthropic],
      ["https://deepmind.google/blog/", deepmind],
      ["https://research.google/blog/", google],
    ]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const listing = listings.get(url);
      if (listing !== undefined) {
        return new Response(listing, { headers: { "content-type": "text/html" } });
      }
      if (url.startsWith("https://deepmind.google/blog/evaluating-ai-systems")) {
        return new Response(deepmindDetail, { headers: { "content-type": "text/html" } });
      }
      if (
        url.startsWith("https://www.anthropic.com/research/") ||
        url.startsWith("https://research.google/blog/")
      ) {
        return new Response(article("Reviewed detail"), {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [
        reviewedLabSource("anthropic"),
        reviewedLabSource("google-deepmind"),
        reviewedLabSource("google-research"),
      ],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.succeededSourceIds).toEqual([
      "anthropic",
      "google-deepmind",
      "google-research",
    ]);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "anthropic",
        title: "Alignment through debate",
        originalUrl: "https://www.anthropic.com/research/alignment-through-debate?ref=listing%2Faugust",
      }),
      expect.objectContaining({
        sourceId: "anthropic",
        title: "Mechanistic representations",
      }),
      expect.objectContaining({
        sourceId: "google-deepmind",
        title: "Evaluating AI systems for oversight",
        publishedAt: "2026-08-02T00:00:00.000Z",
      }),
      expect.objectContaining({
        sourceId: "google-research",
        title: "Interpretable representations in neural networks",
      }),
    ]));
    expect(result.candidates).toHaveLength(4);
    expect(result.discoveryDiagnostics?.map(({ sourceId, observed }) => ({
      sourceId,
      observed,
    }))).toEqual([
      { sourceId: "anthropic", observed: 2 },
      { sourceId: "google-deepmind", observed: 1 },
      { sourceId: "google-research", observed: 1 },
    ]);
    expect(JSON.stringify(result.candidates)).not.toContain("Console product release");
    expect(JSON.stringify(result.candidates)).not.toContain("Model launch product update");
    expect(JSON.stringify(result.candidates)).not.toContain("AI Studio product announcement");
    expect(JSON.stringify(result.candidates)).not.toContain("/products/");
  });

  it("fetches only the first five topical reviewed rows, leaving unrelated rows unfetched", async () => {
    const unrelated = Array.from({ length: 6 }, (_, index) => `<a href="/research/product-${index}">
      <h3>Console product release ${index}</h3><span>Product</span>
      <time datetime="2026-08-02"></time></a>`).join("");
    const relevant = Array.from({ length: 6 }, (_, index) => `<a href="/research/research-${index}">
      <h3>AI safety oversight research ${index}</h3><span>Research</span>
      <time datetime="2026-08-02"></time></a>`).join("");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://www.anthropic.com/research") {
        return new Response(`<!doctype html><html><body>${unrelated}${relevant}</body></html>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://www.anthropic.com/research/research-")) {
        return new Response(article("Reviewed detail"), {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unrelated reviewed row was fetched: ${url}`);
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [reviewedLabSource("anthropic")],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "AI safety oversight research 0",
      "AI safety oversight research 1",
      "AI safety oversight research 2",
      "AI safety oversight research 3",
      "AI safety oversight research 4",
      "AI safety oversight research 5",
    ]);
    expect(result.candidates[5]).toMatchObject({
      accessLevel: "metadata",
      content: null,
    });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://www.anthropic.com/research",
      "https://www.anthropic.com/research/research-0",
      "https://www.anthropic.com/research/research-1",
      "https://www.anthropic.com/research/research-2",
      "https://www.anthropic.com/research/research-3",
      "https://www.anthropic.com/research/research-4",
    ]);
  });

  it("retains dated reviewed siblings when one detail fetch rejects", async () => {
    const listing = await loadFixture("anthropic-research-listing.html");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://www.anthropic.com/research") {
        return new Response(listing, { headers: { "content-type": "text/html" } });
      }
      if (url.startsWith("https://www.anthropic.com/research/alignment-through-debate")) {
        throw new TypeError("temporary detail failure");
      }
      if (url === "https://www.anthropic.com/research/representation-learning") {
        return new Response(article("Healthy reviewed detail"), {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [reviewedLabSource("anthropic")],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "Alignment through debate",
      "Mechanistic representations",
    ]);
    expect(result.candidates[0]).toMatchObject({
      accessLevel: "metadata",
      content: null,
    });
    expect(result.candidates[1]?.content).toContain("bounded study");
  });

  it("drops a month-only reviewed entry when its recovered detail date is outside the collection window", async () => {
    const listing = `<!doctype html><article class="card__inner">
      <a class="card__overlay-link" href="/blog/recovered-july"></a>
      <h3 class="card__title">AI oversight evaluation research</h3>
      <span class="meta__category">Governance</span>
      <time datetime="2026-08">August 2026</time>
    </article>`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://deepmind.google/blog/") {
        return new Response(listing, { headers: { "content-type": "text/html" } });
      }
      if (url === "https://deepmind.google/blog/recovered-july") {
        return new Response(`<!doctype html><script type="application/ld+json">
          {"@type":"BlogPosting","datePublished":"2026-07-31"}
        </script><article><p>Oversight evaluation evidence.</p></article>`, {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [reviewedLabSource("google-deepmind")],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.succeededSourceIds).toEqual(["google-deepmind"]);
    expect(result.candidates).toEqual([]);
  });

  it("keeps exact boundary instants and drops out-of-window reviewed dates regardless of ISO spelling", async () => {
    const listing = `<!doctype html>
      <article class="card__inner">
        <a class="card__overlay-link" href="/blog/dated-lower"></a>
        <h3 class="card__title">AI safety lower-bound research</h3>
        <span class="meta__category">Research</span>
        <time datetime="2026-08-01">August 1, 2026</time>
      </article>
      <article class="card__inner">
        <a class="card__overlay-link" href="/blog/dated-upper"></a>
        <h3 class="card__title">AI safety upper-bound research</h3>
        <span class="meta__category">Research</span>
        <time datetime="2026-08-03">August 3, 2026</time>
      </article>
      <article class="card__inner">
        <a class="card__overlay-link" href="/blog/dated-outside"></a>
        <h3 class="card__title">AI safety outside-window research</h3>
        <span class="meta__category">Research</span>
        <time datetime="2026-07-31">July 31, 2026</time>
      </article>
      <article class="card__inner">
        <a class="card__overlay-link" href="/blog/recovered-lower"></a>
        <h3 class="card__title">AI safety recovered-bound research</h3>
        <span class="meta__category">Research</span>
        <time datetime="2026-08">August 2026</time>
      </article>`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://deepmind.google/blog/") {
        return new Response(listing, { headers: { "content-type": "text/html" } });
      }
      if (url === "https://deepmind.google/blog/recovered-lower") {
        return new Response(`<!doctype html><script type="application/ld+json">
          {"@type":"BlogPosting","datePublished":"2026-08-01"}
        </script><article><p>Recovered safety evidence.</p></article>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://deepmind.google/blog/")) {
        return new Response(article("Reviewed boundary detail"), {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [reviewedLabSource("google-deepmind")],
    }).collect({
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-03T00:00:00Z",
    });

    expect(result.failures).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "AI safety upper-bound research",
      "AI safety lower-bound research",
      "AI safety recovered-bound research",
    ]);
  });

  it("isolates non-HTML reviewed detail responses: dated rows stay metadata-only while undated rows drop", async () => {
    const listing = `<!doctype html>
      <article class="card__inner">
        <a class="card__overlay-link" href="/blog/dated-non-html"></a>
        <h3 class="card__title">AI safety oversight study</h3>
        <span class="meta__category">Research</span>
        <time datetime="2026-08-02">August 2, 2026</time>
      </article>
      <article class="card__inner">
        <a class="card__overlay-link" href="/blog/undated-non-html"></a>
        <h3 class="card__title">AI safety evaluation study</h3>
        <span class="meta__category">Research</span>
        <time datetime="2026-08">August 2026</time>
      </article>
      <article class="card__inner">
        <a class="card__overlay-link" href="/blog/healthy-dated"></a>
        <h3 class="card__title">Mechanistic interpretability research</h3>
        <span class="meta__category">Research</span>
        <time datetime="2026-08-02">August 2, 2026</time>
      </article>`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://deepmind.google/blog/") {
        return new Response(listing, { headers: { "content-type": "text/html" } });
      }
      if (
        url === "https://deepmind.google/blog/dated-non-html" ||
        url === "https://deepmind.google/blog/undated-non-html"
      ) {
        return new Response("not HTML", {
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url === "https://deepmind.google/blog/healthy-dated") {
        return new Response(article("Healthy reviewed detail"), {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch,
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [reviewedLabSource("google-deepmind")],
    }).collect(window);

    expect(result.failures).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        title: "AI safety oversight study",
        publishedAt: "2026-08-02T00:00:00.000Z",
        accessLevel: "metadata",
        abstract: null,
        content: null,
      }),
      expect.objectContaining({
        title: "Mechanistic interpretability research",
        content: expect.stringContaining("bounded study"),
      }),
    ]);
  });

  it("maps Alignment Forum, LessWrong Curated, and LessWrong Frontpage RSS without duplicating the RSS parser", async () => {
    const frontpage = await loadFixture("lesswrong-frontpage-feed.xml");
    const rss = (host: string) => `<?xml version="1.0"?><rss><channel><item><title>Original alignment study</title><link>https://${host}/posts/example/original-study</link><guid>${host}-example</guid><pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate><author>Researcher Example</author><description><![CDATA[We present a result related to https://arxiv.org/abs/2608.00001v2.]]></description></item></channel></rss>`;
    const curated = `<?xml version="1.0"?><rss><channel><item><title>Curated post also on Frontpage</title><link>https://www.lesswrong.com/posts/shared-curated-post</link><guid>lesswrong:shared-curated-post</guid><pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate><author>Ada Example</author><description><![CDATA[An interpretation of a bounded oversight result.]]></description></item></channel></rss>`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = url.host === "www.lesswrong.com" &&
          url.searchParams.get("view") === "frontpage"
        ? frontpage
        : url.host === "www.lesswrong.com"
          ? curated
          : rss(url.host);
      return new Response(body, {
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
    const frontpageSource = source({
      id: "lesswrong-frontpage",
      canonicalName: "LessWrong Frontpage",
      canonicalUrl: "https://www.lesswrong.com/",
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "ephemeral-summarization",
        feedUrl: "https://www.lesswrong.com/feed.xml?view=frontpage",
        urlPolicy: { allowedHosts: ["www.lesswrong.com"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml", "/posts/"] },
        feedUrlPolicy: { allowedHosts: ["www.lesswrong.com"], allowedPorts: [""], allowedPathPrefixes: ["/feed.xml"] },
        articleUrlPolicy: { allowedHosts: ["www.lesswrong.com"], allowedPorts: [""], allowedPathPrefixes: ["/posts/"] },
      },
      discoveryMechanism: "rss",
      sectionEligibility: ["research", "research_radar"],
    });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({ fetch, now: () => new Date("2026-08-02T12:00:00.000Z") }),
      sources: [forum, lesswrong, frontpageSource],
    });

    const result = await collector.collect(window);

    expect(result.candidates).toHaveLength(4);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "alignment-forum", discoveryFamily: "commentary", relatedPaperIds: ["arXiv:2608.00001"], metadata: expect.objectContaining({ canCorroborateFacts: false, discoveryLaneIds: ["alignment-forum:rss"] }) }),
      expect.objectContaining({ sourceId: "lesswrong-curated", discoveryFamily: "commentary", metadata: expect.objectContaining({ canCorroborateFacts: false, discoveryLaneIds: ["lesswrong-curated:rss"] }) }),
      expect.objectContaining({ sourceId: "lesswrong-frontpage", originalUrl: "https://www.lesswrong.com/posts/shared-curated-post", discoveryFamily: "commentary", metadata: expect.objectContaining({ canCorroborateFacts: false, discoveryLaneIds: ["lesswrong-frontpage:rss"] }) }),
      expect.objectContaining({ sourceId: "lesswrong-frontpage", originalUrl: "https://www.lesswrong.com/posts/frontpage-only-post", discoveryFamily: "commentary", metadata: expect.objectContaining({ canCorroborateFacts: false, discoveryLaneIds: ["lesswrong-frontpage:rss"] }) }),
    ]));
    expect(result.discoveryDiagnostics).toEqual([
      expect.objectContaining({
        laneId: "alignment-forum:rss",
        sourceId: "alignment-forum",
        observed: 1,
        discovered: 1,
        outcome: "success",
      }),
      expect.objectContaining({
        laneId: "lesswrong-curated:rss",
        sourceId: "lesswrong-curated",
        observed: 1,
        discovered: 1,
        outcome: "success",
      }),
      expect.objectContaining({
        laneId: "lesswrong-frontpage:rss",
        sourceId: "lesswrong-frontpage",
        discoveryFamily: "commentary",
        observed: 2,
        discovered: 2,
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

  it("uses the reviewed OpenAI RSS adapter without a page fallback and isolates a malformed OpenAI lane", async () => {
    const openai = source({
      id: "openai",
      canonicalName: "OpenAI Research",
      canonicalUrl: "https://openai.com/research/",
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "ephemeral-summarization",
        feedUrl: "https://openai.com/catalog-supplied-wrong-feed.xml",
        feedUrlPolicy: {
          allowedHosts: ["openai.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/not-the-reviewed-feed/"],
        },
        articleUrlPolicy: {
          allowedHosts: ["openai.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/index/"],
        },
      },
      discoveryMechanism: "rss",
    });
    const healthy = rssSource({ id: "healthy-publication" });
    const collector = createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async (input: string | URL | Request) => {
          if (String(input).startsWith("https://openai.com/")) {
            throw new Error("OpenAI must not use its generic page fallback");
          }
          return new Response(`<?xml version="1.0"?><rss><channel><item>
            <title>Healthy publication</title>
            <link>https://www.alignmentforum.org/posts/example/healthy-publication</link>
            <pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate>
          </item></channel></rss>`, {
            headers: { "content-type": "application/rss+xml" },
          });
        }),
        maxRetries: 0,
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [openai, healthy],
    });

    const result = await collector.collect(window);

    expect(result.failures).toContainEqual({ sourceId: "openai", kind: "policy" });
    expect(result.candidates).toEqual([
      expect.objectContaining({ sourceId: "healthy-publication" }),
    ]);
    expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ laneId: "openai:rss", outcome: "policy" }),
    ]));
  });

  it("records out-of-window RSS entries as healthy source observations", async () => {
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          "<?xml version=\"1.0\"?><rss><channel><item><title>Older result</title><link>https://www.alignmentforum.org/posts/example/older-result</link><pubDate>Sat, 01 Aug 2020 12:00:00 GMT</pubDate></item></channel></rss>",
          { headers: { "content-type": "application/rss+xml" } },
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [rssSource()],
    }).collect(window);

    expect(result.candidates).toEqual([]);
    expect(result.discoveryDiagnostics).toEqual([{
      laneId: "alignment-forum:rss",
      sourceId: "alignment-forum",
      discoveryFamily: "commentary",
      observed: 1,
      discovered: 0,
      deduplicated: 0,
      triaged: 0,
      assessed: 0,
      outcome: "success",
      rejectionCounts: {},
    }]);
  });

  it("records an empty valid RSS feed as a healthy zero observation", async () => {
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          "<?xml version=\"1.0\"?><rss><channel></channel></rss>",
          { headers: { "content-type": "application/rss+xml" } },
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [rssSource()],
    }).collect(window);

    expect(result.discoveryDiagnostics).toEqual([{
      laneId: "alignment-forum:rss",
      sourceId: "alignment-forum",
      discoveryFamily: "commentary",
      observed: 0,
      discovered: 0,
      deduplicated: 0,
      triaged: 0,
      assessed: 0,
      outcome: "success",
      rejectionCounts: {},
    }]);
  });

  it("reports malformed RSS as parse without inventing an observation", async () => {
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          "<?xml version=\"1.0\"?><rss><channel><item><title>Malformed</title><link>javascript:alert(1)</link></item></channel></rss>",
          { headers: { "content-type": "application/rss+xml" } },
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [rssSource()],
    }).collect(window);

    expect(result.failures).toEqual([
      { sourceId: "alignment-forum", kind: "parse" },
    ]);
    expect(result.discoveryDiagnostics).toEqual([{
      laneId: "alignment-forum:rss",
      sourceId: "alignment-forum",
      discoveryFamily: "commentary",
      discovered: 0,
      deduplicated: 0,
      triaged: 0,
      assessed: 0,
      outcome: "parse",
      rejectionCounts: {},
    }]);
  });

  it("reports an RSS envelope without a channel as parse", async () => {
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          "<?xml version=\"1.0\"?><rss><version>2.0</version></rss>",
          { headers: { "content-type": "application/rss+xml" } },
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [rssSource()],
    }).collect(window);

    expect(result.failures).toEqual([
      { sourceId: "alignment-forum", kind: "parse" },
    ]);
    expect(result.discoveryDiagnostics).toEqual([{
      laneId: "alignment-forum:rss",
      sourceId: "alignment-forum",
      discoveryFamily: "commentary",
      discovered: 0,
      deduplicated: 0,
      triaged: 0,
      assessed: 0,
      outcome: "parse",
      rejectionCounts: {},
    }]);
  });

  it("reports unsupported RSS and publication-page media without marking lanes healthy", async () => {
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response("not a source listing", {
          headers: { "content-type": "text/plain" },
        })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [rssSource({ id: "plain-rss" }), source({ id: "plain-page" })],
    }).collect(window);

    expect(result.failures).toEqual([
      { sourceId: "plain-rss", kind: "unsupported_media" },
      { sourceId: "plain-page", kind: "unsupported_media" },
    ]);
    expect(result.discoveryDiagnostics).toEqual([
      expect.objectContaining({
        laneId: "plain-rss:rss",
        discovered: 0,
        outcome: "unsupported_media",
      }),
      expect.objectContaining({
        laneId: "plain-page:page",
        discovered: 0,
        outcome: "unsupported_media",
      }),
    ]);
    expect(result.discoveryDiagnostics?.every((diagnostic) =>
      "observed" in diagnostic
    )).toBe(false);
  });

  it("does not hide unsupported publication detail media as an empty source", async () => {
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async (input: string | URL | Request) =>
          String(input) === "https://lab.example.org/research/"
            ? new Response(`<!doctype html><html><body><article>
                <h2>Detail media check</h2>
                <a href="/research/detail-media-check">Read</a>
                <time datetime="2026-08-02T12:00:00Z"></time>
              </article></body></html>`, {
                headers: { "content-type": "text/html" },
              })
            : new Response("not HTML", {
                headers: { "content-type": "text/plain" },
              }),
        ),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [source()],
    }).collect(window);

    expect(result.failures).toEqual([
      { sourceId: "example-lab", kind: "unsupported_media" },
    ]);
    expect(result.discoveryDiagnostics).toEqual([
      expect.objectContaining({
        laneId: "example-lab:page",
        outcome: "unsupported_media",
      }),
    ]);
    expect(result.discoveryDiagnostics?.[0]).not.toHaveProperty("observed");
  });

  it("preserves parsed publication diagnostics when downstream routing excludes the candidate", async () => {
    const papersWithCode = source({
      id: "papers-with-code-co",
      canonicalName: "Papers with Code",
      canonicalUrl: "https://paperswithcode.co/",
      role: "analysis",
      restrictions: {
        bodyRetrieval: "permitted",
        paywall: "none",
        contentUse: "discovery-metadata-only",
      },
      discoveryMechanism: "page",
      sectionEligibility: ["research", "research_radar"],
    });
    const result = await createPublicationCollectorFromCatalog({
      http: new SourceHttpClient({
        fetch: vi.fn(async () => new Response(`<!doctype html><html><body>
          <ul><li>
            <a href="/paper/2608.12345">Ordinary research item</a>
            <time datetime="2026-08-02"></time>
          </li></ul>
        </body></html>`, { headers: { "content-type": "text/html" } })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      sources: [papersWithCode],
    }).collect(window);

    expect(result.discoveryDiagnostics).toEqual([
      expect.objectContaining({
        laneId: "papers-with-code-co:page",
        observed: 1,
        discovered: 1,
        outcome: "success",
      }),
    ]);
    expect(routePublication(
      RawPublicationCandidateSchema.parse(
        prepareRawCandidateForPipeline(result.candidates[0]),
      ),
    )).toBeNull();
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
      observed: 0,
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
  it("fetches the reviewed recent-paper list and decodes its topical provider text before routing", async () => {
    const fetch = vi.fn(async () => new Response(
      `<!doctype html><html><body><ul>
        <li>
          <a href="/paper/2608.12345">&amp;#105;nterpretability study results</a>
          <time datetime="2026-08-02">August 2, 2026</time>
        </li>
        <li>
          <a href="/paper/2608.12346">&#65308;interpretability&#65310;Ordinary study results&#65308;/interpretability&#65310;</a>
          <time datetime="2026-08-02">August 2, 2026</time>
        </li>
      </ul></body></html>`,
      { headers: { "content-type": "text/html" } },
    ));
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch,
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
    expect(fetch).toHaveBeenCalledWith(
      "https://paperswithcode.co/papers/recent",
      expect.any(Object),
    );
  });

  it("parses only on-origin paper links into discovery-only identifiers and code metadata", async () => {
    const fixture = await loadFixture("papers-with-code-recent.html");
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response(
      fixture,
      { headers: { "content-type": "text/html" } },
    ));
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch,
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
          pageUrl: "https://paperswithcode.co/papers/recent",
          urlPolicy: { allowedHosts: ["paperswithcode.co"], allowedPorts: [""], allowedPathPrefixes: ["/"] },
        },
        discoveryMechanism: "page",
        sectionEligibility: ["research", "research_radar"],
      })),
    );

    const { candidates, observed } = await adapter.collectWithStats(window);

    expect(adapter.laneId).toBe("papers-with-code-co:page");
    expect(fetch.mock.calls[0]?.[0]).toBe("https://paperswithcode.co/papers/recent");
    expect(observed).toBe(3);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      externalId: "arXiv:2608.00001",
      externalIds: ["arXiv:2608.00001"],
      relatedPaperIds: ["arXiv:2608.00001"],
      discoveryFamily: "official-publication",
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
      externalId: "papers-with-code:opaque-provider-paper",
      relatedPaperIds: ["papers-with-code:opaque-provider-paper"],
      metadata: { implementationAvailable: false },
    });
    expect(JSON.stringify(candidates)).not.toContain("2608.99999");
    expect(JSON.stringify(candidates)).not.toContain("Older Paper");
    expect(JSON.stringify(candidates)).not.toContain("Invalid Date Paper");
  });

  it("accepts only the exact reviewed final path", async () => {
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => responseWithUrl(
          `<!doctype html><html><body><ul><li>
            <a href="/paper/2608.12345">Interpretability result</a>
            <time datetime="2026-08-02">2 August 2026</time>
          </li></ul></body></html>`,
          "https://paperswithcode.co/",
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      ResearchSourceRecordSchema.parse(source({
        id: "papers-with-code-co",
        canonicalName: "Papers with Code",
        canonicalUrl: "https://paperswithcode.co/",
        role: "analysis",
        restrictions: { bodyRetrieval: "permitted", paywall: "none", contentUse: "discovery-metadata-only" },
        discoveryMechanism: "page",
        sectionEligibility: ["research", "research_radar"],
      })),
    );

    await expect(adapter.collect(window)).resolves.toEqual([]);
  });

  it("examines at most the first one hundred reviewed list rows", async () => {
    const olderRows = Array.from({ length: 100 }, (_, index) => `<li>
      <a href="/paper/2607.${String(index).padStart(5, "0")}">Older ${index}</a>
      <time datetime="2026-07-01">1 July 2026</time>
    </li>`).join("");
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          `<!doctype html><html><body><ul>${olderRows}<li>
            <a href="/paper/2608.99999">One-hundred-first result</a>
            <time datetime="2026-08-02">2 August 2026</time>
          </li></ul></body></html>`,
          { headers: { "content-type": "text/html" } },
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      ResearchSourceRecordSchema.parse(source({
        id: "papers-with-code-co",
        canonicalName: "Papers with Code",
        canonicalUrl: "https://paperswithcode.co/",
        role: "analysis",
        restrictions: { bodyRetrieval: "permitted", paywall: "none", contentUse: "discovery-metadata-only" },
        discoveryMechanism: "page",
        sectionEligibility: ["research", "research_radar"],
      })),
    );

    await expect(adapter.collect(window)).resolves.toEqual([]);
  });

  it("surfaces reviewed-list parser drift instead of falling back to homepage paper links", async () => {
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => new Response(
          `<!doctype html><html><body><section><h2>Relevant papers</h2>
            <article><a href="/paper/2608.12345">Homepage-only result</a>
              <time datetime="2026-08-02">2 August 2026</time></article>
          </section></body></html>`,
          { headers: { "content-type": "text/html" } },
        )),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      ResearchSourceRecordSchema.parse(source({
        id: "papers-with-code-co",
        canonicalName: "Papers with Code",
        canonicalUrl: "https://paperswithcode.co/",
        role: "analysis",
        restrictions: { bodyRetrieval: "permitted", paywall: "none", contentUse: "discovery-metadata-only" },
        discoveryMechanism: "page",
        sectionEligibility: ["research", "research_radar"],
      })),
    );

    await expect(adapter.collect(window)).rejects.toThrow(SyntaxError);
  });

  it("treats a whitespace-only HTML response as reviewed-list parser drift", async () => {
    const adapter = new PapersWithCodeAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => new Response(" \n\t ", {
          headers: { "content-type": "text/html" },
        })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      ResearchSourceRecordSchema.parse(source({
        id: "papers-with-code-co",
        canonicalName: "Papers with Code",
        canonicalUrl: "https://paperswithcode.co/",
        role: "analysis",
        restrictions: { bodyRetrieval: "permitted", paywall: "none", contentUse: "discovery-metadata-only" },
        discoveryMechanism: "page",
        sectionEligibility: ["research", "research_radar"],
      })),
    );

    await expect(adapter.collect(window)).rejects.toThrow(SyntaxError);
  });
});
