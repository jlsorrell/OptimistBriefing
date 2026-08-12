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
import {
  OpenAlexAdapter,
  OpenAlexDiscoveryAdapter,
} from "../../../src/sources/openalex";
import { PaperContentRetriever } from "../../../src/sources/paper-content";
import { createProviderRequestAdmission } from
  "../../../src/sources/provider-scheduler";
import {
  createPaperDiscoveryAdapters,
  SEMANTIC_SCHOLAR_SEED_SET_V1,
} from "../../../src/sources/paper-discovery";
import { ResearchCollector } from "../../../src/sources/research-collector";
import {
  isPreparedRawCandidate,
  rebrandPreparedResearchCandidateAfterSchemaClone,
} from "../../../src/editorial/normalize";
import { RssAdapter } from "../../../src/sources/rss";
import { SemanticScholarAdapter } from "../../../src/sources/semantic-scholar";
import type {
  CollectionWindow,
  DiscoverySourceAdapter,
  RawItem,
  ResearchSourceRecord,
} from "../../../src/sources/types";
import { RawResearchCandidateSchema } from "../../../src/sources/types";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const loadFixture = (name: string) => readFile(fixturePath(name), "utf8");

const fixedWindow = (): CollectionWindow => ({
  from: "2026-07-28T00:00:00.000Z",
  to: "2026-07-29T12:00:00.000Z",
});

function logicalSchedulerRuntime() {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn(async (milliseconds: number) => {
      current += milliseconds;
    }),
  };
}

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
        new OpenAlexAdapter(
          http,
          openAlexSource,
          undefined,
          { apiKey: "fixture-openalex-key" },
        ),
      ],
      preferredInstitutions: READER_PROFILE.preferredInstitutions,
      preferredLabs: READER_PROFILE.preferredLabs,
    }),
    fetch,
  };
}

describe("ResearchCollector", () => {
  it("serializes Semantic Scholar lanes without owning request pacing", async () => {
    const clock = logicalSchedulerRuntime();
    const starts: number[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseAll: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const collector = new ResearchCollector({
      discoveryAdapters: Array.from({ length: 3 }, (_, index) => ({
        sourceId: "semantic-scholar",
        laneId: `semantic-scholar:test:${index}`,
        discoveryFamily: "bibliographic" as const,
        collect: async () => {
          starts.push(clock.now());
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await gate;
          active -= 1;
          return [];
        },
      })),
      enrichers: [],
      preferredInstitutions: [],
      schedulerRuntime: clock,
    });

    const pending = collector.collect(fixedWindow());
    await vi.waitFor(() => expect(active).toBeGreaterThan(0));
    const startsWhileFirstLaneIsHeld = [...starts];
    const maximumActiveWhileFirstLaneIsHeld = maximumActive;
    releaseAll?.();
    await pending;

    expect(startsWhileFirstLaneIsHeld).toEqual([0]);
    expect(maximumActiveWhileFirstLaneIsHeld).toBe(1);
    expect(starts).toEqual([0, 0, 0]);
    expect(maximumActive).toBe(1);
  });

  it("keeps a Semantic Scholar Retry-After retry inside its scheduled lane", async () => {
    const baseTime = Date.parse("2026-07-29T08:30:00.000Z");
    let currentTime = 0;
    const schedulerSleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const httpSleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    let activeLanes = 0;
    let maximumActiveLanes = 0;
    const completedLanes: string[] = [];
    const requestEvents: Array<{
      laneId: string;
      activeLanes: number;
      time: number;
    }> = [];
    const privateThrottleBody = "private Semantic Scholar throttle body";
    const laneUrls = new Map([
      [
        "semantic-scholar:01-retry",
        "https://api.semanticscholar.org/graph/v1/paper/retry-lane?token=private-retry-token",
      ],
      [
        "semantic-scholar:02-healthy",
        "https://api.semanticscholar.org/graph/v1/paper/healthy-lane?token=private-healthy-token",
      ],
    ]);
    let retryLaneAttempts = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const laneId = url.includes("retry-lane")
        ? "semantic-scholar:01-retry"
        : "semantic-scholar:02-healthy";
      requestEvents.push({ laneId, activeLanes, time: currentTime });
      if (laneId === "semantic-scholar:01-retry") {
        retryLaneAttempts += 1;
        if (retryLaneAttempts === 1) {
          return new Response(privateThrottleBody, {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }
      }
      return new Response("ok");
    });
    const http = new SourceHttpClient({
      fetch,
      sleep: httpSleep,
      now: () => new Date(baseTime + currentTime),
      maxRetries: 1,
      requestAdmission: createProviderRequestAdmission(new Map([
        ["semantic-scholar", {
          maxConcurrency: 1,
          minimumStartIntervalMs: 1_000,
        }],
      ]), {
        now: () => currentTime,
        sleep: schedulerSleep,
      }),
    });
    const adapters = [...laneUrls].map(([laneId, url]) => ({
      sourceId: "semantic-scholar",
      laneId,
      discoveryFamily: "bibliographic" as const,
      collect: async () => {
        activeLanes += 1;
        maximumActiveLanes = Math.max(maximumActiveLanes, activeLanes);
        try {
          await http.get(semanticScholarSource, url);
          completedLanes.push(laneId);
          return [];
        } finally {
          activeLanes -= 1;
        }
      },
    }));
    const collector = new ResearchCollector({
      discoveryAdapters: adapters,
      enrichers: [],
      preferredInstitutions: [],
      schedulerRuntime: {
        now: () => currentTime,
        sleep: schedulerSleep,
      },
    });

    const result = await collector.collect(fixedWindow());

    expect(requestEvents).toEqual([
      {
        laneId: "semantic-scholar:01-retry",
        activeLanes: 1,
        time: 0,
      },
      {
        laneId: "semantic-scholar:01-retry",
        activeLanes: 1,
        time: 2_000,
      },
      {
        laneId: "semantic-scholar:02-healthy",
        activeLanes: 1,
        time: 3_000,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(httpSleep).toHaveBeenCalledTimes(1);
    expect(httpSleep).toHaveBeenCalledWith(2_000);
    expect(schedulerSleep).toHaveBeenCalledOnce();
    expect(schedulerSleep).toHaveBeenCalledWith(1_000);
    expect(maximumActiveLanes).toBe(1);
    expect(completedLanes).toEqual([
      "semantic-scholar:01-retry",
      "semantic-scholar:02-healthy",
    ]);
    expect(result.discoveryDiagnostics).toEqual([
      {
        laneId: "semantic-scholar:01-retry",
        sourceId: "semantic-scholar",
        discoveryFamily: "bibliographic",
        discovered: 0,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        rejectionCounts: {},
        outcome: "success",
      },
      {
        laneId: "semantic-scholar:02-healthy",
        sourceId: "semantic-scholar",
        discoveryFamily: "bibliographic",
        discovered: 0,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        rejectionCounts: {},
        outcome: "success",
      },
    ]);
    const serializedDiagnostics = JSON.stringify(result.discoveryDiagnostics);
    expect(serializedDiagnostics).not.toContain(privateThrottleBody);
    for (const url of laneUrls.values()) {
      expect(serializedDiagnostics).not.toContain(url);
    }
  });

  it("runs each provider group concurrently", async () => {
    let releaseSemanticScholar: (() => void) | undefined;
    let semanticScholarSettled = false;
    let arxivStartedBeforeSemanticScholarSettled = false;
    const semanticScholarGate = new Promise<void>((resolve) => {
      releaseSemanticScholar = resolve;
    });
    const adapters = [
      {
        sourceId: "semantic-scholar",
        laneId: "a-semantic-scholar:blocked",
        discoveryFamily: "bibliographic",
        collect: async () => {
          await semanticScholarGate;
          semanticScholarSettled = true;
          return [];
        },
      },
      {
        sourceId: "arxiv",
        laneId: "z-arxiv:healthy",
        discoveryFamily: "arxiv",
        collect: async () => {
          arxivStartedBeforeSemanticScholarSettled = !semanticScholarSettled;
          return [];
        },
      },
    ] satisfies readonly DiscoverySourceAdapter[];
    const collector = new ResearchCollector({
      discoveryAdapters: adapters,
      enrichers: [],
      preferredInstitutions: [],
    });

    const pending = collector.collect(fixedWindow());
    try {
      await vi.waitFor(() => {
        expect(arxivStartedBeforeSemanticScholarSettled).toBe(true);
      });
    } finally {
      releaseSemanticScholar?.();
      await pending;
    }
  });

  it("limits OpenAlex discovery concurrency to two lanes", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseAll: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const collector = new ResearchCollector({
      discoveryAdapters: Array.from({ length: 4 }, (_, index) => ({
        sourceId: "openalex",
        laneId: `openalex:test:${index}`,
        discoveryFamily: "bibliographic" as const,
        collect: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await gate;
          active -= 1;
          return [];
        },
      })),
      enrichers: [],
      preferredInstitutions: [],
    });

    const pending = collector.collect(fixedWindow());
    await vi.waitFor(() => expect(active).toBeGreaterThan(0));
    releaseAll?.();
    await pending;

    expect(maximumActive).toBe(2);
  });

  it("settles later lanes and another provider after a throttled lane fails", async () => {
    const clock = logicalSchedulerRuntime();
    const settled: string[] = [];
    const adapters = [
      {
        sourceId: "semantic-scholar",
        laneId: "semantic-scholar:01-failed",
        discoveryFamily: "bibliographic",
        collect: async () => {
          throw new Error("private provider body and https://secret.example");
        },
      },
      {
        sourceId: "semantic-scholar",
        laneId: "semantic-scholar:02-healthy",
        discoveryFamily: "bibliographic",
        collect: async () => {
          settled.push("semantic-scholar:02-healthy");
          return [];
        },
      },
      {
        sourceId: "arxiv",
        laneId: "arxiv:healthy",
        discoveryFamily: "arxiv",
        collect: async () => {
          settled.push("arxiv:healthy");
          return [];
        },
      },
    ] satisfies readonly DiscoverySourceAdapter[];
    const collector = new ResearchCollector({
      discoveryAdapters: adapters,
      enrichers: [],
      preferredInstitutions: [],
      schedulerRuntime: clock,
    });

    const result = await collector.collect(fixedWindow());

    expect(settled.sort()).toEqual([
      "arxiv:healthy",
      "semantic-scholar:02-healthy",
    ]);
    expect([...result.succeededSourceIds].sort()).toEqual([
      "arxiv",
      "semantic-scholar",
    ]);
    expect(result.failures).toEqual([
      { sourceId: "semantic-scholar", kind: "unknown" },
    ]);
    expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneId: "semantic-scholar:01-failed",
        outcome: "unknown",
      }),
      expect.objectContaining({
        laneId: "semantic-scholar:02-healthy",
        outcome: "success",
      }),
      expect.objectContaining({
        laneId: "arxiv:healthy",
        outcome: "success",
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain("secret.example");
    expect(clock.now()).toBe(0);
  });

  it.each(["constructor", "__proto__"])(
    "uses the default policy and preserves fail-open settlement for unknown provider %s",
    async (sourceId) => {
      const settled: string[] = [];
      const adapters = [
        {
          sourceId,
          laneId: `${sourceId}:01-failed`,
          discoveryFamily: "bibliographic",
          collect: async () => {
            throw new Error("private inherited-policy failure detail");
          },
        },
        {
          sourceId,
          laneId: `${sourceId}:02-healthy`,
          discoveryFamily: "bibliographic",
          collect: async () => {
            settled.push(`${sourceId}:02-healthy`);
            return [];
          },
        },
      ] satisfies readonly DiscoverySourceAdapter[];
      const collector = new ResearchCollector({
        discoveryAdapters: adapters,
        enrichers: [],
        preferredInstitutions: [],
      });

      const result = await collector.collect(fixedWindow());

      expect(settled).toEqual([`${sourceId}:02-healthy`]);
      expect(result.succeededSourceIds).toEqual([sourceId]);
      expect(result.failures).toEqual([
        {
          sourceId: sourceId === "__proto__" ? "unknown-source" : sourceId,
          kind: "unknown",
        },
      ]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          laneId: `${sourceId}:01-failed`,
          outcome: "unknown",
        }),
        expect.objectContaining({
          laneId: `${sourceId}:02-healthy`,
          outcome: "success",
        }),
      ]));
      expect(JSON.stringify(result)).not.toContain(
        "private inherited-policy failure detail",
      );
    },
  );

  it.each(["title", "sourceName"] as const)(
    "drops an entity-only research %s without losing its valid sibling",
    async (invalidField) => {
      const collector = new ResearchCollector({
        discoveryAdapters: [{
          sourceId: "arxiv",
          collect: async () => [
            { ...rawPaper(), [invalidField]: "&#32;" },
            {
              ...rawPaper(),
              externalId: "arXiv:2607.00002",
              externalIds: ["arXiv:2607.00002"],
              originalUrl: "https://arxiv.org/abs/2607.00002",
              title: "A valid sibling research result",
            },
          ],
        }],
        enrichers: [],
        preferredInstitutions: [],
      });

      const result = await collector.collect(fixedWindow());

      expect(result.failures).toEqual([]);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.title).toBe(
        "A valid sibling research result",
      );
      expect(result.discoveryDiagnostics?.[0]?.rejectionCounts).toEqual({
        quality_rejected: 1,
      });
    },
  );

  it("decodes institutions before preferred-institution matching", async () => {
    const candidate = {
      ...rawPaper(),
      institutions: ["&#83;tanford"],
    };
    const collector = new ResearchCollector({
      discoveryAdapters: [{
        sourceId: "arxiv",
        collect: async () => [candidate],
      }],
      enrichers: [],
      preferredInstitutions: ["Stanford"],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates[0]?.institutions).toEqual(["Stanford"]);
    expect(result.candidates[0]?.preferredInstitutionMatches).toEqual([
      "Stanford",
    ]);
  });

  it("rebrands only a schema-cloned prepared research candidate without decoding it again", async () => {
    const collector = new ResearchCollector({
      discoveryAdapters: [{
        sourceId: "arxiv",
        collect: async () => [{
          ...rawPaper(),
          title: "Research &amp;amp;#8217; identity",
          institutions: [
            "&amp;#83;tanford",
            "Institute &amp;amp;#8217; Lab",
          ],
        }],
      }],
      enrichers: [],
      preferredInstitutions: ["Stanford"],
    });
    const result = await collector.collect(fixedWindow());
    const prepared = result.candidates[0]!;
    const schemaClone = RawResearchCandidateSchema.parse(prepared);

    expect(isPreparedRawCandidate(prepared)).toBe(true);
    expect(isPreparedRawCandidate(schemaClone)).toBe(false);
    const rebranded = rebrandPreparedResearchCandidateAfterSchemaClone(
      schemaClone,
    );
    expect(rebranded).toEqual(expect.objectContaining({
      title: "Research &#8217; identity",
      institutions: ["Stanford", "Institute &#8217; Lab"],
      preferredInstitutionMatches: ["Stanford"],
    }));
    expect(isPreparedRawCandidate(rebranded)).toBe(true);
    expect(isPreparedRawCandidate(schemaClone)).toBe(false);
  });

  it("runs three targeted arXiv lanes and merges repeated paper identities", async () => {
    const fixture = await loadFixture("arxiv-response.xml");
    const requestQueries: string[] = [];
    const http = new SourceHttpClient({
      fetch: vi.fn(async (input: string | URL | Request) => {
        requestQueries.push(
          new URL(String(input)).searchParams.get("search_query") ?? "",
        );
        return new Response(fixture, {
          headers: { "content-type": "application/atom+xml" },
        });
      }),
      now: () => new Date("2026-07-29T08:30:00.000Z"),
    });
    const arxivAdapters = createPaperDiscoveryAdapters(http, [arxivSource]);
    const collector = new ResearchCollector({
      discoveryAdapters: arxivAdapters,
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(arxivAdapters.map(({ laneId }) => laneId)).toEqual([
      "arxiv:alignment-interpretability",
      "arxiv:oversight-governance",
      "arxiv:secure-ml",
    ]);
    expect(arxivAdapters.every(({ sourceId }) => sourceId === "arxiv")).toBe(
      true,
    );
    expect(requestQueries).toHaveLength(3);
    expect(requestQueries.every((query) => query.includes("cat:cs."))).toBe(
      true,
    );
    expect(requestQueries.join(" ")).toContain("interpretability");
    expect(requestQueries.join(" ")).toContain("provenance");
    expect(requestQueries.join(" ")).toContain("homomorphic encryption");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.externalId).toBe("arXiv:2607.00001");
  });

  it("bounds unusually large arXiv author lists without rejecting the lane", async () => {
    const fixture = (await loadFixture("arxiv-response.xml")).replace(
      "    <author><name>Ada Example</name></author>\n" +
        "    <author><name>Grace Example</name></author>",
      Array.from(
        { length: 65 },
        (_, index) => `    <author><name>Author ${index}</name></author>`,
      ).join("\n"),
    );
    const collector = new ResearchCollector({
      discoveryAdapters: [
        new ArxivAdapter(
          new SourceHttpClient({
            fetch: vi.fn(async () => new Response(fixture)),
          }),
          arxivSource,
          { laneId: "arxiv:bounded-authors", maxPages: 1 },
        ),
      ],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.failures).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.authors).toHaveLength(64);
  });

  it("retains cross-source paper evidence for normalized identity consolidation", async () => {
    const providerPaper = {
      ...rawPaper("openalex"),
      sourceName: "OpenAlex",
      sourceRole: "analysis" as const,
      originalUrl: "https://openalex.org/W260700001",
      externalId: "OpenAlex:W260700001",
      externalIds: ["OpenAlex:W260700001", "arXiv:2607.00001"],
    };
    const adapters = [
      {
        laneId: "arxiv:one",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        collect: async () => [rawPaper()],
      },
      {
        laneId: "openalex:one",
        sourceId: "openalex",
        discoveryFamily: "bibliographic",
        collect: async () => [providerPaper],
      },
    ] satisfies readonly DiscoverySourceAdapter[];
    const collector = new ResearchCollector({
      discoveryAdapters: adapters,
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates.map(({ sourceId }) => sourceId)).toEqual([
      "arxiv",
      "openalex",
    ]);
  });

  it("does not same-source merge a DOI bridge with conflicting arXiv identities", async () => {
    const first = {
      ...rawPaper("openalex"),
      originalUrl: "https://openalex.org/W-CONFLICT-A",
      externalId: "arXiv:2607.00101",
      externalIds: [
        "arXiv:2607.00101",
        "DOI:10.1000/same-source-bridge",
      ],
    };
    const second = {
      ...rawPaper("openalex"),
      originalUrl: "https://openalex.org/W-CONFLICT-B",
      externalId: "arXiv:2607.00102",
      externalIds: [
        "arXiv:2607.00102",
        "DOI:10.1000/same-source-bridge",
      ],
    };
    const collector = new ResearchCollector({
      discoveryAdapters: [{
        sourceId: "openalex",
        collect: async () => [first, second],
      }],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(({ externalId }) => externalId).sort()).toEqual([
      "arXiv:2607.00101",
      "arXiv:2607.00102",
    ]);
  });

  it("sorts each paper lane before applying the 100-candidate cap", async () => {
    const olderPapers = Array.from({ length: 100 }, (_, index) => {
      const paper = rawPaper();
      const identifier = `arXiv:2607.${String(99 - index).padStart(5, "0")}`;
      return {
        ...paper,
        originalUrl: `https://arxiv.org/abs/${identifier.slice(6)}`,
        externalId: identifier,
        externalIds: [identifier],
        publishedAt: "2026-07-28T08:00:00.000Z",
      };
    });
    const newestPaper = {
      ...rawPaper(),
      originalUrl: "https://arxiv.org/abs/2607.99999",
      externalId: "arXiv:2607.99999",
      externalIds: ["arXiv:2607.99999"],
      publishedAt: "2026-07-29T08:00:00.000Z",
    };
    const collector = new ResearchCollector({
      discoveryAdapters: [{
        sourceId: "arxiv",
        collect: async () => [...olderPapers, newestPaper],
      }],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates).toHaveLength(100);
    expect(result.candidates[0]?.externalId).toBe("arXiv:2607.99999");
    expect(result.candidates[1]?.externalId).toBe("arXiv:2607.00000");
    expect(result.candidates.at(-1)?.externalId).toBe("arXiv:2607.00098");
    expect(result.candidates.some(
      ({ externalId }) => externalId === "arXiv:2607.00099",
    )).toBe(false);
  });

  it("orders paper results by lane, recency, and canonical identity", async () => {
    const paper = (
      identifier: string,
      publishedAt: string,
    ): RawItem => ({
      ...rawPaper(),
      originalUrl: `https://arxiv.org/abs/${identifier.slice(6)}`,
      externalId: identifier,
      externalIds: [identifier],
      publishedAt,
    });
    const adapters = [
      {
        laneId: "z-lane",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        collect: async () => [
          paper("arXiv:2607.00004", "2026-07-29T10:00:00.000Z"),
        ],
      },
      {
        laneId: "a-lane",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        collect: async () => [
          paper("arXiv:2607.00003", "2026-07-28T10:00:00.000Z"),
          paper("arXiv:2607.00002", "2026-07-29T10:00:00.000Z"),
          paper("arXiv:2607.00001", "2026-07-29T10:00:00.000Z"),
        ],
      },
    ] satisfies readonly DiscoverySourceAdapter[];
    const collector = new ResearchCollector({
      discoveryAdapters: adapters,
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates.map(({ externalId }) => externalId)).toEqual([
      "arXiv:2607.00001",
      "arXiv:2607.00002",
      "arXiv:2607.00003",
      "arXiv:2607.00004",
    ]);
  });

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

  it("reports real same-source lanes including duplicates, zero results, and failures", async () => {
    const adapters = [
      {
        laneId: "arxiv:one",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        collect: async () => [rawPaper()],
      },
      {
        laneId: "arxiv:two",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        collect: async () => [rawPaper()],
      },
      {
        laneId: "arxiv:zero",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        collect: async () => [],
      },
      {
        laneId: "arxiv:failed",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        collect: async () => {
          throw new Error("private provider body and https://secret.example");
        },
      },
    ] satisfies readonly DiscoverySourceAdapter[];
    const collector = new ResearchCollector({
      discoveryAdapters: adapters,
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.succeededSourceIds).toEqual(["arxiv"]);
    expect(result.discoveryDiagnostics).toEqual([
      {
        laneId: "arxiv:failed",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        discovered: 0,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "unknown",
        rejectionCounts: {},
      },
      {
        laneId: "arxiv:one",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        discovered: 1,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success",
        rejectionCounts: {},
      },
      {
        laneId: "arxiv:two",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        discovered: 1,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success",
        rejectionCounts: {},
      },
      {
        laneId: "arxiv:zero",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        discovered: 0,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success",
        rejectionCounts: {},
      },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.metadata.discoveryLaneIds).toEqual([
      "arxiv:one",
      "arxiv:two",
    ]);
    expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(
      "secret.example",
    );
  });

  it("bounds lane diagnostics and contributing lane IDs at sixty-four", async () => {
    const collector = new ResearchCollector({
      discoveryAdapters: Array.from({ length: 65 }, (_, index) => ({
        laneId: `arxiv:${String(index).padStart(2, "0")}`,
        sourceId: "arxiv",
        discoveryFamily: "arxiv" as const,
        collect: async () => [rawPaper()],
      })),
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.discoveryDiagnostics).toHaveLength(64);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.metadata.discoveryLaneIds).toHaveLength(64);
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

describe("bibliographic discovery", () => {
  it("accepts Semantic Scholar empty search pages with a null continuation token", async () => {
    const fetch = vi.fn(async () => Response.json({
      total: 0,
      token: null,
      data: [],
    }));
    const collector = new ResearchCollector({
      discoveryAdapters: createPaperDiscoveryAdapters(
        new SourceHttpClient({ fetch }),
        [semanticScholarSource],
      ).filter(({ laneId }) => laneId.startsWith("semantic-scholar:search:")),
      enrichers: [],
      preferredInstitutions: [],
      schedulerRuntime: logicalSchedulerRuntime(),
    });

    const result = await collector.collect(fixedWindow());

    expect(result.failures).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.succeededSourceIds).toEqual(["semantic-scholar"]);
  });

  it("discovers recent Semantic Scholar search and recommendation papers", async () => {
    const searchFixture = await loadFixture("semantic-scholar-search.json");
    const recommendationFixture = await loadFixture(
      "semantic-scholar-recommendations.json",
    );
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/graph/v1/paper/search/bulk") {
          expect(init?.method ?? "GET").toBe("GET");
          return new Response(searchFixture, {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/recommendations/v1/papers") {
          expect(init?.method).toBe("POST");
          return new Response(recommendationFixture, {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected Semantic Scholar URL: ${url}`);
      },
    );
    const collector = new ResearchCollector({
      discoveryAdapters: createPaperDiscoveryAdapters(
        new SourceHttpClient({
          fetch,
          now: () => new Date("2026-07-29T08:30:00.000Z"),
        }),
        [semanticScholarSource],
      ),
      enrichers: [],
      preferredInstitutions: [],
      schedulerRuntime: logicalSchedulerRuntime(),
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates).toHaveLength(2);
    const searched = result.candidates.find(
      ({ externalId }) => externalId === "arXiv:2608.00001",
    );
    expect(searched?.externalIds).toEqual(expect.arrayContaining([
      "SemanticScholar:paper-id",
      "arXiv:2608.00001",
      "DOI:10.1000/example",
    ]));
    expect(searched).toMatchObject({
      citationCount: 11,
      influentialCitationCount: 3,
      topics: ["Computer Science"],
      publishedAt: "2026-07-29T00:00:00.000Z",
    });
    expect(result.candidates.some(
      ({ externalIds }) => externalIds.includes("SemanticScholar:old-paper-id"),
    )).toBe(false);
    expect(result.candidates.some(
      ({ externalIds }) => externalIds.includes("SemanticScholar:undated-paper-id"),
    )).toBe(false);

    const urls = fetch.mock.calls.map(([input]) => new URL(String(input)));
    const searchUrls = urls.filter(
      ({ pathname }) => pathname === "/graph/v1/paper/search/bulk",
    );
    const recommendationUrls = urls.filter(
      ({ pathname }) => pathname === "/recommendations/v1/papers",
    );
    expect(searchUrls).toHaveLength(3);
    expect(recommendationUrls).toHaveLength(3);
    const fields =
      "paperId,externalIds,title,abstract,authors,year,publicationDate,venue,citationCount,influentialCitationCount,fieldsOfStudy,url";
    expect(urls.every((url) => url.searchParams.get("fields") === fields)).toBe(
      true,
    );
    expect(searchUrls.every(
      (url) => url.searchParams.get("sort") === "publicationDate:desc",
    )).toBe(true);
    expect(recommendationUrls.every(
      (url) => url.searchParams.get("limit") === "100",
    )).toBe(true);
    const recommendationBodies = fetch.mock.calls.flatMap(([, init]) =>
      init?.method === "POST" ? [JSON.parse(String(init.body))] : [],
    );
    expect(recommendationBodies).toEqual(
      SEMANTIC_SCHOLAR_SEED_SET_V1.map(({ paperId }) => ({
        positivePaperIds: [paperId],
        negativePaperIds: [],
      })),
    );
  });

  it("discovers OpenAlex topic and preferred-institution papers", async () => {
    const worksFixture = await loadFixture("openalex-discovery.json");
    const resolvedInstitutions = new Map([
      ["MIT", "https://openalex.org/I63966007"],
      ["OpenAI", "https://openalex.org/I987654321"],
    ]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/institutions") {
        const requestedName = url.searchParams.get("search") ?? "";
        const id = resolvedInstitutions.get(requestedName);
        return Response.json({
          meta: { count: id === undefined ? 0 : 1, page: 1, per_page: 100 },
          results: id === undefined
            ? []
            : [{ id, display_name: requestedName }],
          group_by: [],
        });
      }
      if (url.pathname === "/works") {
        return new Response(worksFixture, {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected OpenAlex URL: ${url}`);
    });
    const discoveryAdapters = createPaperDiscoveryAdapters(
      new SourceHttpClient({
        fetch,
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      [openAlexSource],
      { openAlexApiKey: "fixture-openalex-key" },
    );
    const collector = new ResearchCollector({
      discoveryAdapters,
      enrichers: [],
      preferredInstitutions: READER_PROFILE.preferredInstitutions,
      preferredLabs: READER_PROFILE.preferredLabs,
    });

    const result = await collector.collect({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-29T12:00:00.000Z",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalId: "arXiv:2608.00001",
      authors: ["Ada Example"],
      institutions: ["MIT"],
      preferredInstitutionMatches: ["MIT"],
      abstract: "Secure models retain provenance.",
      citationCount: 13,
      topics: ["Interpretable machine learning"],
      metadata: expect.objectContaining({
        discoveryFamily: "bibliographic",
        openAlexId: "https://openalex.org/W260800001",
      }),
    });
    expect(result.candidates[0]?.externalIds).toEqual(expect.arrayContaining([
      "OpenAlex:W260800001",
      "arXiv:2608.00001",
      "DOI:10.1000/example",
    ]));
    expect(discoveryAdapters.map(({ laneId }) => laneId).filter((laneId) =>
      laneId.startsWith("openalex:updated:")
    )).toEqual([
      "openalex:updated:alignment-interpretability",
      "openalex:updated:oversight-governance",
      "openalex:updated:secure-computation-ml",
    ]);

    const urls = fetch.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.every(({ pathname }) =>
      pathname === "/institutions" || pathname === "/works",
    )).toBe(true);
    const institutionUrls = urls.filter(
      ({ pathname }) => pathname === "/institutions",
    );
    const workUrls = urls.filter(({ pathname }) => pathname === "/works");
    expect(institutionUrls).toHaveLength(
      READER_PROFILE.preferredInstitutions.length +
        READER_PROFILE.preferredLabs.length,
    );
    expect(institutionUrls.every(
      (url) => url.searchParams.get("select") === "id,display_name",
    )).toBe(true);
    expect(workUrls).toHaveLength(7);
    expect(workUrls.every(
      (url) => url.searchParams.get("per_page") === "100",
    )).toBe(true);
    expect(urls.every(
      (url) => url.searchParams.get("api_key") === "fixture-openalex-key",
    )).toBe(true);
    expect(workUrls.every(
      (url) =>
        url.searchParams.get("select") ===
        "id,doi,title,publication_date,updated_date,cited_by_count,ids,authorships,topics,abstract_inverted_index,primary_location",
    )).toBe(true);
    const institutionWorkUrl = workUrls.find((url) =>
      url.searchParams.get("filter")?.includes("authorships.institutions.id"),
    );
    expect(institutionWorkUrl?.searchParams.get("filter")).toContain(
      "I63966007|I987654321",
    );
    expect(institutionWorkUrl?.searchParams.has("search")).toBe(false);
    expect(workUrls.filter((url) => url.searchParams.has("search"))).toHaveLength(
      6,
    );
    const updatedWorkUrls = workUrls.filter((url) =>
      url.searchParams.get("sort") === "updated_date:desc"
    );
    expect(updatedWorkUrls).toHaveLength(3);
    expect(updatedWorkUrls.every((url) => {
      const filter = url.searchParams.get("filter") ?? "";
      return !filter.includes("updated_date") &&
        !filter.includes("from_publication_date") &&
        !filter.includes("to_publication_date") &&
        url.searchParams.get("sort") === "updated_date:desc";
    })).toBe(true);
  });

  it("uses the authenticated free-tier contract for updated discovery", async () => {
    const seen: URL[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      seen.push(new URL(String(input)));
      return Response.json({ results: [] });
    });
    const adapter = new OpenAlexDiscoveryAdapter(
      new SourceHttpClient({ fetch }), openAlexSource,
      { laneId: "openalex:updated:alignment", mode: "updated", query: "alignment" },
      { apiKey: "fixture-openalex-key" },
    );
    await adapter.collect(fixedWindow());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.searchParams.get("api_key")).toBe("fixture-openalex-key");
    expect(seen[0]?.searchParams.get("per_page")).toBe("100");
    expect(seen[0]?.searchParams.has("per-page")).toBe(false);
    expect(seen[0]?.searchParams.get("sort")).toBe("updated_date:desc");
    expect(seen[0]?.searchParams.get("filter") ?? "").not.toMatch(/updated_date/);
  });

  it("discovers older OpenAlex works updated inside the reconsideration window", async () => {
    const updatedWork = {
      id: "https://openalex.org/W260800777",
      doi: "https://doi.org/10.1000/updated-example",
      title: "Updated interpretability evidence for oversight",
      publication_date: "2026-06-01",
      updated_date: "2026-07-28T06:00:00.000Z",
      cited_by_count: 7,
      ids: {
        openalex: "https://openalex.org/W260800777",
        doi: "https://doi.org/10.1000/updated-example",
        arxiv: "https://arxiv.org/abs/2606.00777v2",
      },
      authorships: [{
        author: {
          id: "https://openalex.org/A260800777",
          display_name: "Ada Updated",
        },
        institutions: [],
      }],
      topics: [{ display_name: "AI interpretability", score: 0.95 }],
      abstract_inverted_index: {
        Updated: [0],
        evidence: [1],
        improves: [2],
        oversight: [3],
      },
      primary_location: {
        landing_page_url: "https://doi.org/10.1000/updated-example",
        source: { display_name: "Updated Fixture Proceedings" },
      },
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/institutions") {
        return Response.json({ results: [] });
      }
      if (url.pathname === "/works") {
        return Response.json({
          results: url.searchParams.get("sort") === "updated_date:desc"
            ? [updatedWork]
            : [],
        });
      }
      throw new Error(`Unexpected OpenAlex URL: ${url}`);
    });
    const collector = new ResearchCollector({
      discoveryAdapters: [
        new OpenAlexDiscoveryAdapter(
          new SourceHttpClient({
            fetch,
            now: () => new Date("2026-07-29T08:30:00.000Z"),
          }),
          openAlexSource,
          {
            laneId: "openalex:updated:alignment-interpretability",
            mode: "updated",
            query: "AI safety, alignment, and interpretability",
          },
          { apiKey: "fixture-openalex-key" },
        ),
      ],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect({
      from: "2026-07-22T12:00:00.000Z",
      to: "2026-07-29T12:00:00.000Z",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalId: "arXiv:2606.00777",
      publishedAt: "2026-06-01T00:00:00.000Z",
      metadata: expect.objectContaining({
        updatedAt: "2026-07-28T06:00:00.000Z",
        discoveryLaneIds: expect.arrayContaining([
          "openalex:updated:alignment-interpretability",
        ]),
      }),
    });
    const updatedUrls = fetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) =>
        url.pathname === "/works" &&
        url.searchParams.get("sort") === "updated_date:desc"
      );
    expect(updatedUrls).toHaveLength(1);
    expect(updatedUrls.every((url) =>
      !url.searchParams.get("filter")?.includes("from_publication_date") &&
      url.searchParams.get("sort") === "updated_date:desc" &&
      url.searchParams.get("per_page") === "100" &&
      url.searchParams.get("api_key") === "fixture-openalex-key"
    )).toBe(true);
  });

  it("recovers an omitted OpenAlex arXiv identity from its landing page", async () => {
    const work = {
      id: "https://openalex.org/W7197052950",
      doi: null,
      title: "Recovered OpenAlex identity",
      publication_date: "2026-07-29",
      updated_date: "2026-07-29T08:00:00.000Z",
      cited_by_count: 1,
      ids: { openalex: "https://openalex.org/W7197052950" },
      authorships: [],
      topics: [],
      abstract_inverted_index: null,
      primary_location: {
        landing_page_url: "https://arxiv.org/abs/2608.03626v2",
        source: { display_name: "arXiv" },
      },
    };
    const adapter = new OpenAlexDiscoveryAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({ results: [work] })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      openAlexSource,
      { laneId: "openalex:text:identity", mode: "text", query: "alignment" },
      { apiKey: "fixture-openalex-key" },
    );

    const result = await adapter.collect(fixedWindow());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      originalUrl: "https://arxiv.org/abs/2608.03626v2",
      externalId: "arXiv:2608.03626",
      externalIds: ["OpenAlex:W7197052950", "arXiv:2608.03626"],
    });
  });

  it.each([
    {
      caseName: "keeps a non-arXiv landing page OpenAlex-only",
      ids: { openalex: "https://openalex.org/W-NON-ARXIV" },
      landingPageUrl: "https://publisher.example/papers/non-arxiv",
      expectedExternalId: "OpenAlex:W-NON-ARXIV",
      expectedExternalIds: ["OpenAlex:W-NON-ARXIV"],
    },
    {
      caseName: "prefers the explicit arXiv identity over a conflicting landing page",
      ids: {
        openalex: "https://openalex.org/W-EXPLICIT",
        arxiv: "https://arxiv.org/abs/2608.00001v3",
      },
      landingPageUrl: "https://arxiv.org/abs/2608.99999",
      expectedExternalId: "arXiv:2608.00001",
      expectedExternalIds: ["OpenAlex:W-EXPLICIT", "arXiv:2608.00001"],
    },
    {
      caseName: "falls back when the explicit OpenAlex arXiv URL is invalid",
      ids: {
        openalex: "https://openalex.org/W-INVALID-EXPLICIT",
        arxiv: "https://publisher.example/not-an-arxiv-identifier",
      },
      landingPageUrl: "https://arxiv.org/abs/2608.00002v4",
      expectedExternalId: "arXiv:2608.00002",
      expectedExternalIds: [
        "OpenAlex:W-INVALID-EXPLICIT",
        "arXiv:2608.00002",
      ],
    },
  ])("$caseName", async ({ ids, landingPageUrl, expectedExternalId, expectedExternalIds }) => {
    const work = {
      id: ids.openalex,
      doi: null,
      title: "OpenAlex identity inverse",
      publication_date: "2026-07-29",
      updated_date: "2026-07-29T08:00:00.000Z",
      cited_by_count: 0,
      ids,
      authorships: [],
      topics: [],
      abstract_inverted_index: null,
      primary_location: {
        landing_page_url: landingPageUrl,
        source: { display_name: "Fixture publisher" },
      },
    };
    const adapter = new OpenAlexDiscoveryAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => Response.json({ results: [work] })),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      openAlexSource,
      { laneId: "openalex:text:identity-inverse", mode: "text", query: "alignment" },
      { apiKey: "fixture-openalex-key" },
    );

    const result = await adapter.collect(fixedWindow());

    expect(result[0]?.externalId).toBe(expectedExternalId);
    expect(result[0]?.externalIds).toEqual(expectedExternalIds);
  });

  it("bounds large OpenAlex provider arrays without rejecting the lane", async () => {
    const payload = JSON.parse(await loadFixture("openalex-discovery.json"));
    payload.results[0].authorships = Array.from({ length: 65 }, (_, index) => ({
      author: { id: null, display_name: `Author ${index}` },
      institutions: [{
        id: `https://openalex.org/I${index}`,
        display_name: `Institution ${index}`,
      }],
    }));
    payload.results[0].topics = Array.from({ length: 65 }, (_, index) => ({
      display_name: `Topic ${index}`,
      score: 0.9,
    }));
    const collector = new ResearchCollector({
      discoveryAdapters: [
        new OpenAlexDiscoveryAdapter(
          new SourceHttpClient({ fetch: vi.fn(async () => Response.json(payload)) }),
          openAlexSource,
          {
            laneId: "openalex:text:bounded-arrays",
            mode: "text",
            query: "alignment",
          },
          { apiKey: "fixture-openalex-key" },
        ),
      ],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.failures).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.authors).toHaveLength(64);
    expect(result.candidates[0]?.institutions).toHaveLength(64);
    expect(result.candidates[0]?.topics).toHaveLength(64);
  });

  it("keeps arXiv papers when bibliographic discovery returns malformed data", async () => {
    const malformedFetch = vi.fn(async () => Response.json({ unexpected: [] }));
    const http = new SourceHttpClient({ fetch: malformedFetch });
    const collector = new ResearchCollector({
      discoveryAdapters: [
        {
          sourceId: "arxiv",
          collect: async () => [rawPaper()],
        },
        ...createPaperDiscoveryAdapters(http, [semanticScholarSource]),
      ],
      enrichers: [],
      preferredInstitutions: [],
      schedulerRuntime: logicalSchedulerRuntime(),
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates.map(({ externalId }) => externalId)).toEqual([
      "arXiv:2607.00001",
    ]);
    expect(result.failures).toContainEqual({
      sourceId: "semantic-scholar",
      kind: "parse",
    });
    expect(JSON.stringify(result)).not.toContain("unexpected");
  });

  it("keeps arXiv papers when OpenAlex credentials are unavailable", async () => {
    const collector = new ResearchCollector({
      discoveryAdapters: [
        {
          sourceId: "arxiv",
          collect: async () => [rawPaper()],
        },
        ...createPaperDiscoveryAdapters(
          new SourceHttpClient({ fetch: vi.fn(async () => Response.json({ results: [] })) }),
          [openAlexSource],
        ),
      ],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates.map(({ externalId }) => externalId)).toEqual([
      "arXiv:2607.00001",
    ]);
    expect(result.failures).toContainEqual({
      sourceId: "openalex",
      kind: "policy",
    });
    expect(JSON.stringify(result)).not.toContain("provider credential unavailable");
  });

  it.each([401, 403, 429])(
    "settles OpenAlex HTTP %i as a sanitized fetch failure without losing healthy research",
    async (status) => {
      const privateBody = `private OpenAlex ${status} response`;
      const fetch = vi.fn(async () => new Response(privateBody, { status }));
      const collector = new ResearchCollector({
        discoveryAdapters: [
          {
            sourceId: "arxiv",
            collect: async () => [rawPaper()],
          },
          new OpenAlexDiscoveryAdapter(
            new SourceHttpClient({ fetch }),
            openAlexSource,
            {
              laneId: "openalex:text:alignment",
              mode: "text",
              query: "alignment",
            },
            { apiKey: "fixture-openalex-key" },
          ),
        ],
        enrichers: [],
        preferredInstitutions: [],
      });

      const result = await collector.collect(fixedWindow());

      expect(result.candidates.map(({ externalId }) => externalId)).toEqual([
        "arXiv:2607.00001",
      ]);
      expect(result.failures).toContainEqual({
        sourceId: "openalex",
        kind: "fetch",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain(privateBody);
      expect(JSON.stringify(result)).not.toContain("fixture-openalex-key");
    },
  );

  it.each([
    ["a huge sparse position", { HOSTILE_POSITION: [999_999] }],
    [
      "too many distinct words",
      Object.fromEntries(
        Array.from({ length: 2_001 }, (_, index) => [
          `HOSTILE_WORD_${index}`,
          [0],
        ]),
      ),
    ],
    [
      "too many positions for one word",
      { HOSTILE_REPETITION: Array.from({ length: 129 }, (_, index) => index) },
    ],
    [
      "an oversized reconstructed output",
      Object.fromEntries(
        Array.from({ length: 22 }, (_, index) => [
          `HOSTILE_OUTPUT_${index}_${"x".repeat(178)}`,
          [index],
        ]),
      ),
    ],
  ])("fails open on an OpenAlex abstract index with %s", async (
    _case,
    abstractInvertedIndex,
  ) => {
    const hostileWork = {
      id: "https://openalex.org/W260899999",
      doi: null,
      title: "Hostile abstract index",
      publication_date: "2026-07-29",
      updated_date: "2026-07-29T08:00:00.000Z",
      cited_by_count: 0,
      ids: { openalex: "https://openalex.org/W260899999" },
      authorships: [],
      topics: [],
      abstract_inverted_index: abstractInvertedIndex,
      primary_location: null,
    };
    const fetch = vi.fn(async () => Response.json({ results: [hostileWork] }));
    const http = new SourceHttpClient({
      fetch,
      now: () => new Date("2026-07-29T08:30:00.000Z"),
    });
    const collector = new ResearchCollector({
      discoveryAdapters: [
        {
          sourceId: "arxiv",
          collect: async () => [rawPaper()],
        },
        new OpenAlexDiscoveryAdapter(http, openAlexSource, {
          laneId: "openalex:hostile-index",
          mode: "text",
          query: "interpretability",
        }, { apiKey: "fixture-openalex-key" }),
      ],
      enrichers: [],
      preferredInstitutions: [],
    });

    const result = await collector.collect(fixedWindow());

    expect(result.candidates.map(({ externalId }) => externalId)).toEqual([
      "arXiv:2607.00001",
    ]);
    expect(result.failures).toContainEqual({
      sourceId: "openalex",
      kind: "parse",
    });
    expect(JSON.stringify(result)).not.toContain("HOSTILE_");
  });
});

describe("RssAdapter", () => {
  it("bounds oversized article bodies without rejecting the feed", async () => {
    const oversizedEvidence = "x".repeat(5_000);
    const feed = `<?xml version="1.0"?>
      <rss version="2.0"><channel><item>
        <title>Bounded source evidence</title>
        <link>https://lab.example.org/posts/bounded-source-evidence</link>
        <guid>bounded-source-evidence</guid>
        <pubDate>Wed, 29 Jul 2026 08:00:00 GMT</pubDate>
        <description><![CDATA[${oversizedEvidence}]]></description>
      </item></channel></rss>`;
    const adapter = new RssAdapter(
      new SourceHttpClient({
        fetch: async () => new Response(feed, {
          headers: { "content-type": "application/rss+xml" },
        }),
        now: () => new Date("2026-07-29T08:30:00.000Z"),
      }),
      [{ source: blogSource, feedUrl: "https://lab.example.org/feed.xml" }],
    );

    const result = await adapter.collect(fixedWindow());

    expect(result.failures).toEqual([]);
    expect(result.succeededSourceIds).toEqual(["alignment-lab"]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.abstract).toHaveLength(4_000);
  });

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
  it("paces every Semantic Scholar retry attempt after fallback backoff", async () => {
    const baseTime = Date.parse("2026-07-29T08:30:00.000Z");
    const clock = logicalSchedulerRuntime();
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(clock.now());
      return starts.length === 1
        ? new Response(null, { status: 503 })
        : new Response("ok");
    });
    const http = new SourceHttpClient({
      fetch,
      maxRetries: 1,
      sleep: clock.sleep,
      now: () => new Date(baseTime + clock.now()),
      requestAdmission: createProviderRequestAdmission(new Map([
        ["semantic-scholar", {
          maxConcurrency: 1,
          minimumStartIntervalMs: 1_000,
        }],
      ]), clock),
    });

    const response = await http.get(
      semanticScholarSource,
      "https://api.semanticscholar.org/graph/v1/paper/search/bulk",
    );

    expect(response.body).toBe("ok");
    expect(starts).toEqual([0, 1_000]);
    expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds))
      .toEqual([500, 500]);
  });

  it("paces every allowed Semantic Scholar redirect hop", async () => {
    const clock = logicalSchedulerRuntime();
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(clock.now());
      return starts.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                "https://api.semanticscholar.org/graph/v1/paper/search/bulk?cursor=next",
            },
          })
        : new Response("ok");
    });
    const http = new SourceHttpClient({
      fetch,
      requestAdmission: createProviderRequestAdmission(new Map([
        ["semantic-scholar", {
          maxConcurrency: 1,
          minimumStartIntervalMs: 1_000,
        }],
      ]), clock),
    });

    const response = await http.get(
      semanticScholarSource,
      "https://api.semanticscholar.org/graph/v1/paper/search/bulk",
    );

    expect(response.body).toBe("ok");
    expect(starts).toEqual([0, 1_000]);
  });

  it("holds Semantic Scholar admission until a successful body is consumed", async () => {
    const clock = logicalSchedulerRuntime();
    const starts: number[] = [];
    let finishFirstBody: (() => void) | undefined;
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finishFirstBody = () => {
          controller.enqueue(new TextEncoder().encode("first"));
          controller.close();
        };
      },
    });
    const fetch = vi.fn(async () => {
      starts.push(clock.now());
      return starts.length === 1
        ? new Response(firstBody)
        : new Response("second");
    });
    const http = new SourceHttpClient({
      fetch,
      requestAdmission: createProviderRequestAdmission(new Map([
        ["semantic-scholar", {
          maxConcurrency: 1,
          minimumStartIntervalMs: 1_000,
        }],
      ]), clock),
    });

    const first = http.get(
      semanticScholarSource,
      "https://api.semanticscholar.org/graph/v1/paper/search/bulk?request=first",
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const second = http.get(
      semanticScholarSource,
      "https://api.semanticscholar.org/graph/v1/paper/search/bulk?request=second",
    );
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);

    finishFirstBody?.();

    expect((await first).body).toBe("first");
    expect((await second).body).toBe("second");
    expect(starts).toEqual([0, 1_000]);
  });

  it("starts the network timeout after queued provider admission", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Response("admitted"));
      const admission = createProviderRequestAdmission(new Map([
        ["semantic-scholar", {
          maxConcurrency: 1,
          minimumStartIntervalMs: 0,
        }],
      ]));
      const http = new SourceHttpClient({
        fetch,
        maxRetries: 0,
        timeoutMs: 10,
        requestAdmission: admission,
      });

      const held = await admission.acquire("semantic-scholar");
      const request = http.get(
        semanticScholarSource,
        "https://api.semanticscholar.org/graph/v1/paper/search/bulk?request=queued",
      );

      await vi.advanceTimersByTimeAsync(10);
      expect(fetch).not.toHaveBeenCalled();
      held.release();

      expect((await request).body).toBe("admitted");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("cancels an unsafe redirect body without overriding policy failure", async () => {
    const privateDetail = "private unsafe redirect cancellation detail";
    const cancel = vi.fn(async () => {
      throw new Error(privateDetail);
    });
    const fetch = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      },
    ));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    let observed: unknown;

    try {
      await new SourceHttpClient({
        fetch,
        sleep,
        maxRetries: 2,
      }).get(arxivSource, "https://example.org/start");
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      status: null,
      retryable: false,
      failureKind: "policy",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(String(observed)).not.toContain(privateDetail);
    expect(JSON.stringify(observed)).not.toContain(privateDetail);
  });

  it("bounds unsafe redirect cancellation before releasing admission", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const fetch = vi.fn(async () =>
        fetch.mock.calls.length === 1
          ? new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status: 302,
            headers: {
              location: "https://169.254.169.254/latest/meta-data",
            },
          })
          : new Response("second")
      );
      const http = new SourceHttpClient({
        fetch,
        maxRetries: 0,
        timeoutMs: 10,
        requestAdmission: createProviderRequestAdmission(new Map([
          ["semantic-scholar", {
            maxConcurrency: 1,
            minimumStartIntervalMs: 0,
          }],
        ])),
      });
      let firstFailure: unknown;
      const first = http.get(
        semanticScholarSource,
        "https://api.semanticscholar.org/graph/v1/paper/search/bulk?request=first",
      ).catch((error: unknown) => {
        firstFailure = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      const second = http.get(
        semanticScholarSource,
        "https://api.semanticscholar.org/graph/v1/paper/search/bulk?request=second",
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);

      await first;
      expect(firstFailure).toMatchObject({
        name: "SourceFetchError",
        status: null,
        retryable: false,
        failureKind: "policy",
      });
      expect((await second).body).toBe("second");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

  it("transmits but never returns a sensitive query value", async () => {
    const secret = "fixture-openalex-key";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get("api_key")).toBe(secret);
      return new Response("ok", { headers: { etag: '"v1"' } });
    });
    const response = await new SourceHttpClient({ fetch }).get(
      openAlexSource,
      `https://api.openalex.org/works?search=alignment&api_key=${secret}`,
      { sensitiveQueryParameters: ["api_key"] },
    );
    expect(response.finalUrl).toContain("api_key=REDACTED");
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it("rejects cross-origin redirects carrying a sensitive query", async () => {
    const fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://cdn.example.net/works" },
    }));
    await expect(new SourceHttpClient({ fetch }).get(
      openAlexSource,
      "https://api.openalex.org/works?api_key=fixture-openalex-key",
      { sensitiveQueryParameters: ["api_key"] },
    )).rejects.toMatchObject({ failureKind: "policy", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors a request-local zero-retry limit", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429 }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    await expect(new SourceHttpClient({ fetch, sleep, maxRetries: 2 }).get(
      openAlexSource,
      "https://api.openalex.org/works",
      { maxRetries: 0 },
    )).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reuses validators without putting secret values in their identity", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("first", { headers: { etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const http = new SourceHttpClient({ fetch });
    await http.get(openAlexSource, "https://api.openalex.org/works?api_key=first-fixture", {
      sensitiveQueryParameters: ["api_key"],
    });
    await http.get(openAlexSource, "https://api.openalex.org/works?api_key=second-fixture", {
      sensitiveQueryParameters: ["api_key"],
    });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("if-none-match"))
      .toBe('"v1"');
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

  it("uses bounded fallback retries for transient fetch failures", async () => {
    const privateFailure = new Error("private fetch transport detail");
    const fetch = vi.fn()
      .mockRejectedValueOnce(privateFailure)
      .mockRejectedValueOnce(privateFailure)
      .mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const http = new SourceHttpClient({ fetch, sleep, maxRetries: 2 });

    const response = await http.get(
      arxivSource,
      "https://export.arxiv.org/api/query",
    );

    expect(response.body).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      500,
      1_000,
    ]);
  });

  it("retries a transient body read failure without retaining partial state", async () => {
    const baseTime = Date.parse("2026-07-29T08:30:00.000Z");
    const clock = logicalSchedulerRuntime();
    const starts: number[] = [];
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private body transport detail"));
      },
    });
    const fetch = vi.fn(async () => {
      starts.push(clock.now());
      return starts.length === 1
        ? new Response(failingBody, { headers: { etag: '"partial"' } })
        : new Response("ok", { headers: { etag: '"complete"' } });
    });
    const http = new SourceHttpClient({
      fetch,
      sleep: clock.sleep,
      now: () => new Date(baseTime + clock.now()),
      maxRetries: 1,
      requestAdmission: createProviderRequestAdmission(new Map([
        ["semantic-scholar", {
          maxConcurrency: 1,
          minimumStartIntervalMs: 1_000,
        }],
      ]), clock),
    });

    const response = await http.get(
      semanticScholarSource,
      "https://api.semanticscholar.org/graph/v1/paper/search/bulk",
    );

    expect(response.body).toBe("ok");
    expect(response.etag).toBe('"complete"');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(starts).toEqual([0, 1_000]);
    expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds))
      .toEqual([500, 500]);
  });

  it("bounds and sanitizes response cancellation failures on retryable statuses", async () => {
    const privateDetail = "private response cancellation detail";
    const cancel = vi.fn(async () => {
      throw new Error(privateDetail);
    });
    const fetch = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { status: 503 },
    ));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    let observed: unknown;

    try {
      await new SourceHttpClient({
        fetch,
        sleep,
        maxRetries: 1,
      }).get(arxivSource, "https://export.arxiv.org/api/query");
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      status: 503,
      retryable: true,
      failureKind: "transport",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
    expect(String(observed)).not.toContain(privateDetail);
    expect(JSON.stringify(observed)).not.toContain(privateDetail);
  });

  it("retries a failed 304 body cancellation within the request cap", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("private not-modified cancellation detail");
    });
    const notModified = new Response(null, { status: 304 });
    Object.defineProperty(notModified, "body", {
      configurable: true,
      value: { cancel },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(notModified)
      .mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);

    const response = await new SourceHttpClient({
      fetch,
      sleep,
      maxRetries: 1,
    }).get(arxivSource, "https://export.arxiv.org/api/query");

    expect(response.body).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("does not let cancellation failures make authentication retryable", async () => {
    const privateDetail = "private authentication cancellation detail";
    const cancel = vi.fn(async () => {
      throw new Error(privateDetail);
    });
    const fetch = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { status: 401 },
    ));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    let observed: unknown;

    try {
      await new SourceHttpClient({
        fetch,
        sleep,
        maxRetries: 2,
      }).get(arxivSource, "https://export.arxiv.org/api/query");
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({
      name: "SourceFetchError",
      status: 401,
      retryable: false,
      failureKind: "transport",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(String(observed)).not.toContain(privateDetail);
    expect(JSON.stringify(observed)).not.toContain(privateDetail);
  });

  it("bounds response cancellation and releases queued provider admission", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const fetch = vi.fn(async () =>
        fetch.mock.calls.length === 1
          ? new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status: 503,
          })
          : new Response("second")
      );
      const http = new SourceHttpClient({
        fetch,
        maxRetries: 0,
        timeoutMs: 10,
        requestAdmission: createProviderRequestAdmission(new Map([
          ["semantic-scholar", {
            maxConcurrency: 1,
            minimumStartIntervalMs: 0,
          }],
        ])),
      });
      let firstFailure: unknown;
      const first = http.get(
        semanticScholarSource,
        "https://api.semanticscholar.org/graph/v1/paper/search/bulk?request=first",
      ).catch((error: unknown) => {
        firstFailure = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      const second = http.get(
        semanticScholarSource,
        "https://api.semanticscholar.org/graph/v1/paper/search/bulk?request=second",
      );

      await vi.advanceTimersByTimeAsync(10);

      expect(fetch).toHaveBeenCalledTimes(2);
      await first;
      expect(firstFailure).toMatchObject({
        name: "SourceFetchError",
        status: 503,
        retryable: true,
      });
      expect((await second).body).toBe("second");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([429, 502, 503, 504])(
    "retries only the approved transient HTTP status %i",
    async (status) => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(new Response("ok"));
      const sleep = vi.fn(async (_milliseconds: number) => undefined);

      const response = await new SourceHttpClient({
        fetch,
        sleep,
        maxRetries: 1,
      }).get(arxivSource, "https://export.arxiv.org/api/query");

      expect(response.body).toBe("ok");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
    },
  );

  it.each([400, 401, 403, 404, 501])(
    "does not retry non-transient HTTP status %i",
    async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status }));
      const sleep = vi.fn(async (_milliseconds: number) => undefined);

      await expect(new SourceHttpClient({
        fetch,
        sleep,
        maxRetries: 2,
      }).get(
        arxivSource,
        "https://export.arxiv.org/api/query",
      )).rejects.toMatchObject({ status, retryable: false });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("caps Retry-After and fallback delays at their existing bounds", async () => {
    const retryAfterFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { "retry-after": "999" },
      }))
      .mockResolvedValueOnce(new Response("ok"));
    const retryAfterSleep = vi.fn(async (_milliseconds: number) => undefined);
    await new SourceHttpClient({
      fetch: retryAfterFetch,
      sleep: retryAfterSleep,
      maxRetries: 1,
    }).get(arxivSource, "https://export.arxiv.org/api/query");
    expect(retryAfterSleep).toHaveBeenCalledWith(60_000);

    const fallbackFetch = vi.fn(async () => new Response(null, {
      status: 503,
    }));
    const fallbackSleep = vi.fn(async (_milliseconds: number) => undefined);
    await expect(new SourceHttpClient({
      fetch: fallbackFetch,
      sleep: fallbackSleep,
      maxRetries: 5,
    }).get(
      arxivSource,
      "https://export.arxiv.org/api/query",
    )).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fallbackSleep.mock.calls.map(([milliseconds]) => milliseconds))
      .toEqual([500, 1_000, 2_000, 4_000, 8_000]);
  });

  it("honors zero retries for transient fetch and body failures", async () => {
    const fetchFailure = vi.fn(async () => {
      throw new Error("private fetch detail");
    });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    await expect(new SourceHttpClient({
      fetch: fetchFailure,
      sleep,
      maxRetries: 0,
    }).get(
      arxivSource,
      "https://export.arxiv.org/api/query",
    )).rejects.toMatchObject({ retryable: true, failureKind: "transport" });

    const bodyFailure = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private body detail"));
        },
      }),
    ));
    await expect(new SourceHttpClient({
      fetch: bodyFailure,
      sleep,
      maxRetries: 0,
    }).get(
      arxivSource,
      "https://export.arxiv.org/api/query",
    )).rejects.toMatchObject({ retryable: true, failureKind: "transport" });

    expect(fetchFailure).toHaveBeenCalledOnce();
    expect(bodyFailure).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sanitizes a transient fetch failure after exhausting its retry cap", async () => {
    const privateDetail = "private fetch transport and https://secret.example";
    const fetch = vi.fn(async () => {
      throw new Error(privateDetail);
    });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    let observed: unknown;
    try {
      await new SourceHttpClient({
        fetch,
        sleep,
        maxRetries: 1,
      }).get(arxivSource, "https://export.arxiv.org/api/query");
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({
      name: "SourceFetchError",
      retryable: true,
      failureKind: "transport",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(String(observed)).not.toContain(privateDetail);
    expect(JSON.stringify(observed)).not.toContain(privateDetail);
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

  it("keeps an oversized response nonretryable when reader cancellation fails", async () => {
    const privateDetail = "private oversized cancellation detail";
    const cancel = vi.fn(async () => {
      throw new Error(privateDetail);
    });
    const fetch = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
        cancel,
      }),
    ));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    let observed: unknown;

    try {
      await new SourceHttpClient({
        fetch,
        sleep,
        maxResponseBytes: 3,
        maxRetries: 2,
      }).get(arxivSource, "https://export.arxiv.org/api/query");
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      status: 200,
      retryable: false,
      failureKind: "transport",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(String(observed)).not.toContain(privateDetail);
    expect(JSON.stringify(observed)).not.toContain(privateDetail);
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
    const http = new SourceHttpClient({ fetch, maxRetries: 0 });
    const request = http.get(arxivSource, "https://example.org/hangs");
    const rejection = expect(request).rejects.toMatchObject({
      name: "SourceFetchError",
      sourceId: "arxiv",
      status: null,
      retryable: true,
      failureKind: "timeout",
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(capturedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("bounds retries for transient request timeouts", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason);
            });
          }),
      );
      const sleep = vi.fn(async (_milliseconds: number) => undefined);
      const http = new SourceHttpClient({
        fetch,
        sleep,
        timeoutMs: 10,
        maxRetries: 1,
      });

      const request = http.get(
        arxivSource,
        "https://export.arxiv.org/api/query",
      );
      let observed: unknown;
      const settled = request.catch((error: unknown) => {
        observed = error;
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10);

      await settled;
      expect(observed).toMatchObject({
        name: "SourceFetchError",
        sourceId: "arxiv",
        status: null,
        retryable: true,
        failureKind: "timeout",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledWith(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds retries for response bodies that never produce a chunk", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
        }),
      ));
      const sleep = vi.fn(async (_milliseconds: number) => undefined);
      const http = new SourceHttpClient({
        fetch,
        sleep,
        timeoutMs: 10,
        maxRetries: 1,
      });
      let observed: unknown;
      const settled = http.get(
        arxivSource,
        "https://export.arxiv.org/api/query",
      ).catch((error: unknown) => {
        observed = error;
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10);

      await settled;
      expect(observed).toMatchObject({
        name: "SourceFetchError",
        sourceId: "arxiv",
        status: 200,
        retryable: true,
        failureKind: "timeout",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledWith(500);
    } finally {
      vi.useRealTimers();
    }
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
          { apiKey: "fixture-openalex-key" },
        ),
    ).toThrow();
  });

  it("rejects same-host enrichment endpoints outside exact provider paths", () => {
    const http = new SourceHttpClient({
      fetch: vi.fn(async () => new Response("unused")),
    });

    expect(
      () =>
        new ArxivAdapter(http, arxivSource, {
          apiUrl: "https://export.arxiv.org/api/unintended",
        }),
    ).toThrow();
    expect(
      () =>
        new SemanticScholarAdapter(
          http,
          semanticScholarSource,
          "https://api.semanticscholar.org/graph/v1/paper/batch/unintended",
        ),
    ).toThrow();
    expect(
      () =>
        new OpenAlexAdapter(
          http,
          openAlexSource,
          "https://api.openalex.org/institutions",
          { apiKey: "fixture-openalex-key" },
        ),
    ).toThrow();
    expect(
      () =>
        new OpenAlexAdapter(
          http,
          openAlexSource,
          "https://api.openalex.org/works/unintended",
          { apiKey: "fixture-openalex-key" },
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
      sourceObservations: [],
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
