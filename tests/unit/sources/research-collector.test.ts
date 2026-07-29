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
import { OpenAlexAdapter } from "../../../src/sources/openalex";
import { PaperContentRetriever } from "../../../src/sources/paper-content";
import { ResearchCollector } from "../../../src/sources/research-collector";
import { RssAdapter } from "../../../src/sources/rss";
import { SemanticScholarAdapter } from "../../../src/sources/semantic-scholar";
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

  return {
    collector: new ResearchCollector({
      discoveryAdapters: [
        new ArxivAdapter(http, arxivSource),
        new RssAdapter(http, [
          { source: blogSource, feedUrl: "https://lab.example.org/feed.xml" },
        ]),
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
  it("records abstract-only access without claiming full-paper access", async () => {
    const { collector } = await collectorWithFixtures();
    const candidates = await collector.collect(fixedWindow());
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
    const candidates = await collector.collect(fixedWindow());

    expect(candidates.find((item) => item.kind === "blog")?.relatedPaperIds)
      .toContain("arXiv:2607.00001");
  });

  it("normalizes institution aliases before applying preferred signals", async () => {
    const { collector } = await collectorWithFixtures();
    const paper = (await collector.collect(fixedWindow())).find(
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

describe("SourceHttpClient", () => {
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
