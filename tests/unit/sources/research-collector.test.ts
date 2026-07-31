import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { READER_PROFILE } from "../../../src/config/reader-profile";
import { ArxivAdapter } from "../../../src/sources/arxiv";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SourceFetchError,
  SourceHttpClient,
} from "../../../src/sources/http-client";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "../../../src/sources/identifiers";
import { OpenAlexAdapter } from "../../../src/sources/openalex";
import { PaperContentRetriever } from "../../../src/sources/paper-content";
import { ResearchCollector } from "../../../src/sources/research-collector";
import { RssAdapter } from "../../../src/sources/rss";
import { SemanticScholarAdapter } from "../../../src/sources/semantic-scholar";
import type {
  CollectionWindow,
  RawItem,
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
  restrictions: { bodyRetrieval: "forbidden" },
  ...value,
});

const arxivSource = source({
  id: "arxiv",
  canonicalName: "arXiv",
  canonicalUrl: "https://arxiv.org/",
  role: "primary",
});

const semanticScholarSource = source({
  id: "semantic-scholar",
  canonicalName: "Semantic Scholar",
  canonicalUrl: "https://api.semanticscholar.org/",
  role: "analysis",
});

const openAlexSource = source({
  id: "openalex",
  canonicalName: "OpenAlex",
  canonicalUrl: "https://api.openalex.org/",
  role: "analysis",
});

const blogSource = source({
  id: "alignment-lab",
  canonicalName: "Alignment Lab Notes",
  canonicalUrl: "https://lab.example.org/",
  role: "blog",
  restrictions: { bodyRetrieval: "permitted" },
});

function rawPaper(sourceId = "arxiv"): RawItem {
  return {
    kind: "paper",
    sourceId,
    sourceName: "arXiv",
    sourceRole: "primary",
    title: "A bounded research result",
    originalUrl: "https://arxiv.org/abs/2607.00001",
    externalId: "arXiv:2607.00001",
    externalIds: ["arXiv:2607.00001"],
    publishedAt: "2026-07-29T08:00:00.000Z",
    retrievedAt: "2026-07-29T08:30:00.000Z",
    accessLevel: "abstract",
    authors: ["Ada Example"],
    institutions: ["MIT"],
    abstract: "The research result has bounded evidence.",
    content: null,
    relatedPaperIds: [],
    metadata: {},
  };
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

async function collectorWithFixtures() {
  const fixtures = {
    arxiv: await loadFixture("arxiv-response.xml"),
    semanticScholar: await loadFixture("semantic-scholar-paper.json"),
    openAlex: await loadFixture("openalex-work.json"),
    blog: await loadFixture("research-blog.xml"),
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://export.arxiv.org/api/query")) {
      return new Response(fixtures.arxiv, {
        headers: {
          "content-type": "application/atom+xml",
          etag: '"arxiv-fixture"',
        },
      });
    }
    if (url.startsWith("https://api.semanticscholar.org/graph/v1/paper/batch")) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        ids: ["ARXIV:2607.00001"],
      });
      return new Response(fixtures.semanticScholar, {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.openalex.org/works")) {
      expect(new URL(url).searchParams.get("filter")).toBe(
        "doi:10.1000/example.2607.1",
      );
      return new Response(fixtures.openAlex, {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://lab.example.org/feed.xml") {
      return new Response(fixtures.blog, {
        headers: { "content-type": "application/rss+xml" },
      });
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  const http = new SourceHttpClient({
    fetch,
    now: () => new Date("2026-07-29T08:30:00.000Z"),
    sleep: async () => undefined,
  });
  const blogRss = new RssAdapter(http, [
    { source: blogSource, feedUrl: "https://lab.example.org/feed.xml" },
  ]);

  return {
    collector: new ResearchCollector({
      discoveryAdapters: [
        new ArxivAdapter(http, arxivSource),
        {
          sourceId: blogSource.id,
          collect: async (window) => {
            const batch = await blogRss.collect(window);
            if (batch.failures.length > 0) {
              throw new Error("BLOG_RSS_COLLECTION_FAILED");
            }
            return [...batch.candidates];
          },
        },
      ],
      enrichers: [
        new SemanticScholarAdapter(http, semanticScholarSource),
        new OpenAlexAdapter(http, openAlexSource),
      ],
      preferredInstitutions: READER_PROFILE.preferredInstitutions,
      preferredLabs: READER_PROFILE.preferredLabs,
    }),
    fetch,
  };
}

describe("ResearchCollector", () => {
  it("retains a successful discovery adapter when another adapter fails", async () => {
    const collector = new ResearchCollector({
      discoveryAdapters: [
        {
          sourceId: "failed-research",
          collect: async () => {
            throw new Error("private discovery detail");
          },
        },
        {
          sourceId: "arxiv",
          collect: async () => [rawPaper()],
        },
      ],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates.map(({ sourceId }) => sourceId)).toEqual([
      "arxiv",
    ]);
    expect(result.succeededSourceIds).toEqual(["arxiv"]);
    expect(result.failures).toEqual([
      { sourceId: "failed-research", kind: "unknown" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private discovery detail");
  });

  it("retains prior candidates when an optional enricher fails", async () => {
    const collector = new ResearchCollector({
      discoveryAdapters: [{
        sourceId: "arxiv",
        collect: async () => [rawPaper()],
      }],
      enrichers: [{
        sourceId: "semantic-scholar",
        enrich: async () => {
          throw new Error("private enrichment detail");
        },
      }],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.externalId).toBe("arXiv:2607.00001");
    expect(result.succeededSourceIds).toEqual(["arxiv"]);
    expect(result.failures).toEqual([
      { sourceId: "semantic-scholar", kind: "unknown" },
    ]);
  });

  it("records abstract-only access without claiming full-paper access", async () => {
    const { collector } = await collectorWithFixtures();
    const { candidates } = await collector.collect(fixedWindow());
    const paper = candidates.find(
      (candidate) => candidate.externalId === "arXiv:2607.00001",
    );

    expect(paper?.accessLevel).toBe("abstract");
    expect(paper?.authors).toEqual(["Ada Example", "Grace Example"]);
    expect(paper?.originalUrl).toBe("https://arxiv.org/abs/2607.00001v2");
    expect(paper?.externalIds).toEqual(
      expect.arrayContaining([
        "arXiv:2607.00001",
        "DOI:10.1000/example.2607.1",
        "SemanticScholar:S2-2607-00001",
        "OpenAlex:W260700001",
      ]),
    );
    expect(paper?.retrievedAt).toBe("2026-07-29T08:30:00.000Z");
  });

  it("associates a blog post with its discussed arXiv paper", async () => {
    const { collector } = await collectorWithFixtures();
    const { candidates } = await collector.collect(fixedWindow());

    expect(candidates.find((item) => item.kind === "blog")?.relatedPaperIds)
      .toContain("arXiv:2607.00001");
  });

  it("normalizes institution aliases before applying preferred signals", async () => {
    const { collector } = await collectorWithFixtures();
    const paper = (await collector.collect(fixedWindow())).candidates.find(
      (candidate) => candidate.kind === "paper",
    );

    expect(paper?.institutions).toEqual([
      "MIT",
      "Google DeepMind",
    ]);
    expect(paper?.preferredInstitutionMatches).toEqual([
      "MIT",
      "Google DeepMind",
    ]);
  });

  it("enriches all discovered identifiers in one request per provider", async () => {
    const { collector, fetch } = await collectorWithFixtures();
    await collector.collect(fixedWindow());

    const requestedUrls = fetch.mock.calls.map(([url]) => String(url));
    expect(
      requestedUrls.filter((url) => url.includes("semanticscholar.org")),
    ).toHaveLength(1);
    expect(
      requestedUrls.filter((url) => url.includes("api.openalex.org")),
    ).toHaveLength(1);
  });
});

describe("RssAdapter", () => {
  it("retains a valid feed when another feed is malformed", async () => {
    const validFeed = await loadFixture("research-blog.xml");
    const malformedSource = source({
      id: "malformed-feed",
      canonicalName: "Malformed Feed",
      canonicalUrl: "https://malformed.example.org/",
      role: "blog",
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://malformed.example.org/feed.xml") {
        return new Response("<not-rss />", {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      return new Response(validFeed, {
        headers: { "content-type": "application/rss+xml" },
      });
    });
    const adapter = new RssAdapter(
      new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      [
        {
          source: malformedSource,
          feedUrl: "https://malformed.example.org/feed.xml",
        },
        {
          source: blogSource,
          feedUrl: "https://lab.example.org/feed.xml",
        },
      ],
    );

    const result = await adapter.collect(fixedWindow());

    expect(result.candidates.map(({ sourceId }) => sourceId)).toEqual([
      "alignment-lab",
    ]);
    expect(result.succeededSourceIds).toEqual(["alignment-lab"]);
    expect(result.failures).toEqual([
      { sourceId: "malformed-feed", kind: "parse" },
    ]);
  });
});

describe("SourceHttpClient", () => {
  it.each([
    "http://public.example.org/feed",
    "https://reader:secret@public.example.org/feed",
    "https://127.0.0.1/feed",
    "https://[::1]/feed",
    "https://metadata.google.internal/feed",
  ])("rejects unsafe outbound URL %s before fetch", async (url) => {
    const fetch = vi.fn(async () => new Response("must not be reached"));
    const http = new SourceHttpClient({ fetch });

    await expect(http.get(arxivSource, url)).rejects.toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      status: null,
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates each manual redirect before following it", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        }),
    );
    const http = new SourceHttpClient({ fetch });

    await expect(
      http.get(arxivSource, "https://example.org/start"),
    ).rejects.toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("does not forward caller-supplied credentials across origins", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.net/feed" },
        }),
      )
      .mockResolvedValueOnce(new Response("feed"));
    const http = new SourceHttpClient({ fetch });

    await http.get(arxivSource, "https://publisher.example.org/feed", {
      headers: {
        accept: "application/rss+xml",
        "x-source-api-key": "must-not-cross-origin",
      },
    });

    expect(
      headerValue(fetch.mock.calls[1]?.[1], "x-source-api-key"),
    ).toBeNull();
    expect(headerValue(fetch.mock.calls[1]?.[1], "accept")).toBe(
      "application/rss+xml",
    );
  });

  it("sends an identifying user agent and reuses response validators", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("first", {
          headers: {
            etag: '"v1"',
            "last-modified": "Wed, 29 Jul 2026 08:00:00 GMT",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const http = new SourceHttpClient({ fetch });

    await http.get(arxivSource, "https://example.org/feed");
    const second = await http.get(arxivSource, "https://example.org/feed");

    expect(headerValue(fetch.mock.calls[0]?.[1], "user-agent")).toContain(
      "OptimistBriefing",
    );
    expect(headerValue(fetch.mock.calls[1]?.[1], "if-none-match")).toBe('"v1"');
    expect(headerValue(fetch.mock.calls[1]?.[1], "if-modified-since")).toBe(
      "Wed, 29 Jul 2026 08:00:00 GMT",
    );
    expect(second.notModified).toBe(true);
    expect(second.body).toBeNull();
  });

  it("honors Retry-After and bounds retries for retryable statuses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn(async () => undefined);
    const http = new SourceHttpClient({ fetch, sleep });

    const response = await http.get(arxivSource, "https://example.org/feed");

    expect(response.body).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("rejects oversized responses before retaining their body", async () => {
    const fetch = vi.fn(async () =>
      new Response("not read", {
        headers: {
          "content-length": String(DEFAULT_MAX_RESPONSE_BYTES + 1),
        },
      }),
    );
    const http = new SourceHttpClient({ fetch });

    await expect(
      http.get(arxivSource, "https://example.org/huge"),
    ).rejects.toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      status: 200,
      retryable: false,
    });
  });

  it("aborts a request after the configured 15-second deadline", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          capturedSignal = init?.signal ?? undefined;
          capturedSignal?.addEventListener("abort", () => {
            reject(capturedSignal?.reason);
          });
        }),
    );
    vi.useFakeTimers();
    const http = new SourceHttpClient({ fetch });
    const request = http.get(arxivSource, "https://example.org/hangs");
    const rejection = expect(request).rejects.toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      status: null,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(capturedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("sanitizes typed fetch errors and never exposes response bodies", async () => {
    const secretBody = "private upstream response";
    const http = new SourceHttpClient({
      fetch: vi.fn(async () => new Response(secretBody, { status: 401 })),
    });

    let caught: unknown;
    try {
      await http.get(arxivSource, "https://example.org/restricted");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SourceFetchError);
    expect(caught).toMatchObject({
      sourceId: "arxiv",
      status: 401,
      retryable: false,
    });
    expect(String(caught)).not.toContain(secretBody);
    expect(JSON.stringify(caught)).not.toContain(secretBody);
  });
});

describe("PaperContentRetriever", () => {
  it("does not retrieve HTML when the source policy forbids body retrieval", async () => {
    const http = new SourceHttpClient({
      fetch: vi.fn(async () => {
        throw new Error("network must not be used");
      }),
    });
    const retriever = new PaperContentRetriever(http);

    const result = await retriever.retrieve({
      source: arxivSource,
      htmlUrl: "https://arxiv.org/html/2607.00001",
      abstract: "Fixture abstract",
    });

    expect(result).toEqual({
      accessLevel: "abstract",
      text: "Fixture abstract",
    });
  });

  it("falls back honestly to the abstract when readable HTML extraction fails", async () => {
    const permittedSource = source({
      ...arxivSource,
      restrictions: { bodyRetrieval: "permitted" },
    });
    const http = new SourceHttpClient({
      fetch: vi.fn(async () =>
        new Response("<html><body><nav>PDF</nav></body></html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    });
    const retriever = new PaperContentRetriever(http);

    const result = await retriever.retrieve({
      source: permittedSource,
      htmlUrl: "https://arxiv.org/html/2607.00001",
      abstract: "Fixture abstract",
    });

    expect(result).toEqual({
      accessLevel: "abstract",
      text: "Fixture abstract",
    });
  });

  it("follows only verified arXiv HTML redirects and extracts readable text", async () => {
    const permittedSource = source({
      ...arxivSource,
      restrictions: { bodyRetrieval: "permitted" },
    });
    const articleText = "Evidence from the training trajectory. ".repeat(12);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://arxiv.org/html/2607.00001v2",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `<html><head><title>Paper</title></head><body><article><h1>Paper</h1><p>${articleText}</p></article></body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
      );
    const retriever = new PaperContentRetriever(
      new SourceHttpClient({ fetch }),
    );

    const result = await retriever.retrieve({
      source: permittedSource,
      htmlUrl: "https://arxiv.org/html/2607.00001",
      abstract: "Fixture abstract",
    });

    expect(result.accessLevel).toBe("full_text");
    expect(result.text).toContain("training trajectory");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not send validators that could turn full text into an abstract on 304", async () => {
    const permittedSource = source({
      ...arxivSource,
      restrictions: { bodyRetrieval: "permitted" },
    });
    const articleText = "Evidence from a complete accessible paper. ".repeat(12);
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (headerValue(init, "if-none-match") !== null) {
          return new Response(null, { status: 304 });
        }
        return new Response(
          `<html><head><title>Paper</title></head><body><article><h1>Paper</h1><p>${articleText}</p></article></body></html>`,
          {
            headers: {
              "content-type": "text/html",
              etag: '"paper-v1"',
            },
          },
        );
      },
    );
    const retriever = new PaperContentRetriever(
      new SourceHttpClient({ fetch }),
    );
    const request = {
      source: permittedSource,
      htmlUrl: "https://arxiv.org/html/2607.00001",
      abstract: "Fixture abstract",
    };

    expect((await retriever.retrieve(request)).accessLevel).toBe("full_text");
    expect((await retriever.retrieve(request)).accessLevel).toBe("full_text");
    expect(headerValue(fetch.mock.calls[1]?.[1], "if-none-match")).toBeNull();
  });

  it("refuses an off-origin redirect before it can become full text", async () => {
    const permittedSource = source({
      ...arxivSource,
      restrictions: { bodyRetrieval: "permitted" },
    });
    const fetch = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: "https://attacker.example/html/2607.00001",
        },
      }),
    );
    const retriever = new PaperContentRetriever(
      new SourceHttpClient({ fetch }),
    );

    const result = await retriever.retrieve({
      source: permittedSource,
      htmlUrl: "https://arxiv.org/html/2607.00001",
      abstract: "Fixture abstract",
    });

    expect(result).toEqual({
      accessLevel: "abstract",
      text: "Fixture abstract",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("provider endpoint and identifier policy", () => {
  it("rejects fixed-provider endpoints outside their intended hosts", () => {
    const http = new SourceHttpClient({
      fetch: vi.fn(async () => new Response("unused")),
    });

    expect(
      () =>
        new ArxivAdapter(http, arxivSource, {
          apiUrl: "https://attacker.example/api",
        }),
    ).toThrow();
    expect(
      () =>
        new SemanticScholarAdapter(
          http,
          semanticScholarSource,
          "https://attacker.example/batch",
        ),
    ).toThrow();
    expect(
      () =>
        new OpenAlexAdapter(
          http,
          openAlexSource,
          "https://attacker.example/works",
        ),
    ).toThrow();
  });

  it.each([
    "https://localhost/feed.xml",
    "https://10.0.0.1/feed.xml",
  ])("settles private or local configured feed URL %s as policy failure", async (feedUrl) => {
    const fetch = vi.fn(async () => new Response("unused"));
    const adapter = new RssAdapter(
      new SourceHttpClient({ fetch }),
      [{ source: blogSource, feedUrl }],
    );

    await expect(adapter.collect(fixedWindow())).resolves.toEqual({
      candidates: [],
      succeededSourceIds: [],
      failures: [{ sourceId: "alignment-lab", kind: "policy" }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("canonicalizes DOI and versioned arXiv identifiers before joins", () => {
    expect(normalizeDoi(" DOI:https://doi.org/10.1000/Example%2E2607%2E1 "))
      .toBe("10.1000/example.2607.1");
    expect(normalizeDoi("http://dx.doi.org/10.1000/EXAMPLE.2607.1"))
      .toBe("10.1000/example.2607.1");
    expect(normalizeDoi("10.1000/%ZZ")).toBeNull();
    expect(normalizeArxivIdentifier("ARXIV:2607.00001v12"))
      .toBe("arXiv:2607.00001");
    expect(
      normalizeArxivIdentifier("https://arxiv.org/abs/2607.00001v3"),
    ).toBe("arXiv:2607.00001");
  });
});

describe("ArxivAdapter revision window", () => {
  it("includes revised older papers and bounds the last-updated pagination scan", async () => {
    const atom = (published: string, updated: string, id: string) => `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>https://arxiv.org/abs/${id}</id>
          <updated>${updated}</updated>
          <published>${published}</published>
          <title>Revised safety paper</title>
          <summary>An older paper received a material revision.</summary>
          <author><name>Ada Example</name></author>
          <link href="https://arxiv.org/abs/${id}" rel="alternate" type="text/html"/>
        </entry>
      </feed>`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          atom(
            "2026-01-01T00:00:00Z",
            "2026-07-29T04:00:00Z",
            "2601.00001v4",
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          atom(
            "2026-01-01T00:00:00Z",
            "2026-07-20T04:00:00Z",
            "2601.00002v1",
          ),
        ),
      );
    const adapter = new ArxivAdapter(
      new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      arxivSource,
      { maxResults: 1, maxPages: 2 },
    );

    const items = await adapter.collect(fixedWindow());

    expect(items.map((item) => item.externalId)).toEqual([
      "arXiv:2601.00001",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get(
        "search_query",
      ),
    ).not.toContain("submittedDate");
    expect(
      fetch.mock.calls.map(([input]) =>
        new URL(String(input)).searchParams.get("start"),
      ),
    ).toEqual(["0", "1"]);
  });
});

describe("reader profile", () => {
  it("is deeply immutable and contains the approved section limits", () => {
    expect(Object.isFrozen(READER_PROFILE)).toBe(true);
    expect(Object.isFrozen(READER_PROFILE.researchTopics)).toBe(true);
    expect(READER_PROFILE.sectionBudgets).toMatchObject({
      morningBrief: 8,
      featuredResearch: 3,
      researchRadar: 6,
      world: 4,
      technology: 4,
      aiPolicy: 4,
      dmvAndBaltimore: 5,
    });
  });
});
