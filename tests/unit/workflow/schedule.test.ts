import { describe, expect, it } from "vitest";

import {
  coordinateScheduledBriefing,
  shouldRunAt,
} from "../../../src/workflow/schedule";
import type {
  Item,
  ResearchAssessment,
} from "../../../src/contracts/editorial";
import type {
  GenerateObjectRequest,
  ModelProvider,
} from "../../../src/models/provider";
import { createProductionPipelineContext } from "../../../src/workflow/run-editorial-pipeline";
import {
  WorkflowItemPayloadSchema,
  type PipelineStore,
} from "../../../src/workflow/types";

const noPublishedRun = () => ({ status: "missing" as const });

class RecordingProvider implements ModelProvider {
  readonly generateRequests: GenerateObjectRequest[] = [];

  async embed(): Promise<readonly (readonly number[])[]> {
    throw new Error("Embedding is not used by this regression.");
  }

  async generateObject(input: GenerateObjectRequest): Promise<unknown> {
    this.generateRequests.push(structuredClone(input));
    if (input.schemaName === "research_assessment") {
      return {
        technicalQuality: 0.9,
        novelty: 0.8,
        strengths: ["Supported evidence."],
        limitations: ["Supported evidence."],
        rationale: "Supported evidence.",
        accessLevel: "abstract",
      };
    }
    const provenance = {
      sourceIds: ["source"],
      evidenceExcerpt: "Supported evidence.",
    };
    return {
      title: "Supported evidence.",
      oneSentence: "Supported evidence.",
      whyItMatters: "Supported evidence.",
      uncertainty: "Supported evidence.",
      claims: [{
        text: "Supported evidence.",
        sourceIds: ["source"],
        evidenceExcerpt: "Supported evidence.",
      }],
      accessLevel: "abstract",
      provenance: {
        title: { sourceIds: ["source"], evidenceExcerpt: "Supported evidence." },
        oneSentence: provenance,
        whyItMatters: provenance,
        uncertainty: provenance,
      },
    };
  }
}

function cachedItem(
  id: string,
  options: {
    kind: "paper" | "article";
    section: "research" | "research_radar" | "world";
    researchTier?: "featured" | "radar";
    researchScore?: number;
  },
): Item {
  return {
    id,
    kind: options.kind,
    canonicalUrl: `https://example.com/${id}`,
    title: "Supported title",
    publishedAt: "2026-07-29T08:00:00.000Z",
    sourceRefs: [{
      id: "source",
      name: "Source",
      url: "https://example.com/source",
      role: "primary",
      retrievedAt: "2026-07-29T08:05:00.000Z",
    }],
    accessLevel: "abstract",
    primaryTopic: "oversight",
    tags: ["oversight"],
    normalizedText: "Supported evidence.",
    metadata: {
      section: options.section,
      contentFingerprint: `content:${id}`,
      evidenceFingerprint: `evidence:${id}`,
      workflow: {
        version: 1,
        ...(options.researchTier === undefined
          ? {}
          : { researchTier: options.researchTier }),
        ...(options.researchScore === undefined
          ? {}
          : {
              researchScore: {
                itemId: id,
                topicalFit: options.researchScore,
                technicalQuality: options.researchScore,
                researchSignal: options.researchScore,
                novelty: options.researchScore,
                seriousAttention: options.researchScore,
                total: options.researchScore,
                selectionReasons: ["Supported ranking evidence."],
              },
            }),
        ...(options.kind === "paper"
          ? {
              rawResearch: {
                kind: "paper",
                sourceId: "source",
                sourceName: "Source",
                sourceRole: "primary",
                title: "Supported title",
                originalUrl: `https://example.com/${id}`,
                externalId: id,
                externalIds: [id],
                publishedAt: "2026-07-29T08:00:00.000Z",
                retrievedAt: "2026-07-29T08:05:00.000Z",
                accessLevel: "abstract",
                authors: ["Researcher"],
                institutions: ["Institute"],
                abstract: "Supported evidence.",
                content: null,
                relatedPaperIds: [],
                metadata: {},
                preferredInstitutionMatches: [],
                citationCount: 1,
                influentialCitationCount: 0,
                topics: ["oversight"],
              },
            }
          : {}),
      },
    },
    createdAt: "2026-07-29T08:05:00.000Z",
    expiresAt: null,
  };
}

function budgetContext(
  provider: ModelProvider,
  state: "degraded" | "hard_stop",
  researchRepository?: Parameters<
    typeof createProductionPipelineContext
  >[0]["researchRepository"],
) {
  return createProductionPipelineContext({
    editionDate: "2026-07-29",
    runId: `cached-${state}`,
    store: {} as PipelineStore,
    now: () => "2026-07-29T08:30:00.000Z",
    providers: { summary: provider, assessment: provider },
    collectCandidates: async () => [],
    budgetPolicy: {
      state,
      radarSummaryTokens: state === "hard_stop" ? 0 : 120,
      featuredSummaryTokens: 900,
    },
    ...(researchRepository === undefined ? {} : { researchRepository }),
  });
}

const cachedAssessment: ResearchAssessment = {
  technicalQuality: 0.88,
  novelty: 0.76,
  strengths: ["Cached exact evidence."],
  limitations: ["Cached exact evidence."],
  rationale: "Cached exact evidence.",
  accessLevel: "abstract",
};

describe("shouldRunAt", () => {
  it.each([
    ["2026-07-29T08:30:00Z", true],
    ["2026-01-29T08:30:00Z", false],
    ["2026-01-29T09:30:00Z", true],
    ["2026-01-29T10:30:00Z", true],
  ])("evaluates %s in America/New_York", (instant, expected) => {
    expect(shouldRunAt(new Date(instant), "America/New_York", noPublishedRun()).run)
      .toBe(expected);
  });

  it("reapplies a hardened budget before uncached assessment and synthesis", async () => {
    const featured = cachedItem("featured", {
      kind: "paper",
      section: "research",
      researchTier: "featured",
    });
    const radar = cachedItem("radar", {
      kind: "paper",
      section: "research",
      researchTier: "radar",
    });
    const news = cachedItem("news", { kind: "article", section: "world" });
    const hardProvider = new RecordingProvider();
    const hard = budgetContext(hardProvider, "hard_stop");

    await expect(hard.assess([featured, radar])).resolves.toHaveLength(0);
    await expect(hard.synthesize([featured, radar, news])).resolves.toHaveLength(2);
    expect(hardProvider.generateRequests.map((request) => [
      request.schemaName,
      request.maxOutputTokens,
    ])).toEqual([
      ["structured_summary", 900],
      ["structured_summary", 900],
    ]);

    const degradedProvider = new RecordingProvider();
    const degraded = budgetContext(degradedProvider, "degraded");
    await degraded.synthesize([featured, radar, news]);
    expect(degradedProvider.generateRequests.map(({ maxOutputTokens }) =>
      maxOutputTokens
    )).toEqual([900, 120, 900]);
  });

  it("uses exact assessment cache hits before hardened uncached-call caps", async () => {
    const cachedIds = new Set(["cached-a", "cached-b"]);
    const cacheGets: Array<[string, string, string]> = [];
    const cachePuts: Array<[string, string, ResearchAssessment, string]> = [];
    const researchRepository = {
      getDiscoveryObservations: async () => [],
      upsertDiscoveryObservations: async () => {},
      getCachedResearchAssessment: async (
        canonicalId: string,
        evidenceFingerprint: string,
        currentTime: string,
      ) => {
        cacheGets.push([canonicalId, evidenceFingerprint, currentTime]);
        return [...cachedIds].some((id) => canonicalId.endsWith(`/${id}`))
          ? cachedAssessment
          : null;
      },
      putCachedResearchAssessment: async (
        canonicalId: string,
        evidenceFingerprint: string,
        assessment: ResearchAssessment,
        expiresAt: string,
      ) => {
        cachePuts.push([
          canonicalId,
          evidenceFingerprint,
          assessment,
          expiresAt,
        ]);
      },
    };
    const hardProvider = new RecordingProvider();
    const hard = budgetContext(
      hardProvider,
      "hard_stop",
      researchRepository,
    );
    const hardItems = ["cached-a", "uncached-a"].map((id) =>
      cachedItem(id, { kind: "paper", section: "research" })
    );

    const hardAssessed = await hard.assess(hardItems);

    expect(hardAssessed.map(({ id }) => id)).toEqual(["cached-a"]);
    expect(hardProvider.generateRequests).toHaveLength(0);

    cacheGets.length = 0;
    const degradedProvider = new RecordingProvider();
    const degraded = budgetContext(
      degradedProvider,
      "degraded",
      researchRepository,
    );
    const degradedItems = [
      "cached-a",
      "cached-b",
      ...Array.from({ length: 6 }, (_, index) => `uncached-${index}`),
    ].map((id) => cachedItem(id, { kind: "paper", section: "research" }));

    const degradedAssessed = await degraded.assess(degradedItems);

    expect(degradedAssessed.map(({ id }) => id)).toEqual([
      "cached-a",
      "cached-b",
      "uncached-0",
      "uncached-1",
      "uncached-2",
      "uncached-3",
    ]);
    expect(degradedProvider.generateRequests).toHaveLength(4);
    expect(cacheGets).toHaveLength(8);
    expect(cacheGets[0]).toEqual([
      "https://example.com/cached-a",
      "evidence:cached-a",
      "2026-07-29T08:30:00.000Z",
    ]);
    expect(cachePuts.map(([canonicalId, evidenceFingerprint]) => [
      canonicalId,
      evidenceFingerprint,
    ])).toEqual([
      ["https://example.com/uncached-0", "evidence:uncached-0"],
      ["https://example.com/uncached-1", "evidence:uncached-1"],
      ["https://example.com/uncached-2", "evidence:uncached-2"],
      ["https://example.com/uncached-3", "evidence:uncached-3"],
    ]);
  });

  it("keeps a successful paid assessment when the optional cache write fails", async () => {
    const provider = new RecordingProvider();
    const context = budgetContext(provider, "degraded", {
      getDiscoveryObservations: async () => [],
      upsertDiscoveryObservations: async () => {},
      getCachedResearchAssessment: async () => null,
      putCachedResearchAssessment: async () => {
        throw new Error("CACHE_WRITE_UNAVAILABLE");
      },
    });
    const item = cachedItem("cache-write-failure", {
      kind: "paper",
      section: "research",
    });

    const assessed = await context.assess([item]);

    expect(assessed).toHaveLength(1);
    expect(WorkflowItemPayloadSchema.parse(
      assessed[0]?.metadata.workflow,
    ).assessment).toMatchObject({
      technicalQuality: 0.9,
      novelty: 0.8,
    });
    expect(provider.generateRequests.filter(({ schemaName }) =>
      schemaName === "research_assessment"
    )).toHaveLength(1);
  });

  it("assigns research tiers from ranked shortlist roles, not input order", async () => {
    const context = budgetContext(new RecordingProvider(), "degraded");
    const shortlisted = await context.shortlist([
      cachedItem("input-featured-low", {
        kind: "paper",
        section: "research",
        researchTier: "featured",
        researchScore: 0.6,
      }),
      cachedItem("input-featured-middle", {
        kind: "paper",
        section: "research",
        researchTier: "featured",
        researchScore: 0.7,
      }),
      cachedItem("input-featured-high", {
        kind: "paper",
        section: "research",
        researchTier: "featured",
        researchScore: 0.8,
      }),
      cachedItem("input-radar-highest", {
        kind: "paper",
        section: "research",
        researchTier: "radar",
        researchScore: 0.9,
      }),
    ]);

    expect(shortlisted.map((item) => ({
      id: item.id,
      section: item.metadata.section,
      researchTier:
        WorkflowItemPayloadSchema.parse(item.metadata.workflow).researchTier,
    }))).toEqual([
      {
        id: "input-radar-highest",
        section: "research",
        researchTier: "featured",
      },
      {
        id: "input-featured-high",
        section: "research",
        researchTier: "featured",
      },
      {
        id: "input-featured-middle",
        section: "research",
        researchTier: "featured",
      },
      {
        id: "input-featured-low",
        section: "research_radar",
        researchTier: "radar",
      },
    ]);
  });

  it("uses the local date and stops after the 05:50 local cutoff", () => {
    expect(shouldRunAt(new Date("2026-01-29T10:50:00Z"), "America/New_York", noPublishedRun()))
      .toEqual({ run: true, editionDate: "2026-01-29", reason: "scheduled" });
    expect(shouldRunAt(new Date("2026-01-29T10:51:00Z"), "America/New_York", noPublishedRun()))
      .toEqual({ run: false, editionDate: "2026-01-29", reason: "outside_window" });
  });

  it("skips an edition that is already published", () => {
    expect(shouldRunAt(new Date("2026-07-29T08:30:00Z"), "America/New_York", {
      status: "published",
    })).toEqual({ run: false, editionDate: "2026-07-29", reason: "published" });
  });
});

describe("coordinateScheduledBriefing", () => {
  it("creates the Workflow with the America/New_York edition date as its ID", async () => {
    const created: unknown[] = [];

    await coordinateScheduledBriefing({
      listRuns: async () => [],
      workflow: {
        create: async (input) => {
          created.push(input);
          return {};
        },
        createBatch: async () => [],
        get: async () => {
          throw new Error("get must not be called");
        },
      },
    }, new Date("2026-07-29T08:30:00.000Z"));

    expect(created).toEqual([{
      id: "2026-07-29",
      params: { editionDate: "2026-07-29", runId: "2026-07-29" },
      retention: { successRetention: "90 days", errorRetention: "90 days" },
    }]);
  });

  it("skips an edition that is already published", async () => {
    let workflowCalls = 0;

    await coordinateScheduledBriefing({
      listRuns: async () => [{
        id: "published-run",
        editionDate: "2026-07-29",
        status: "published",
        retryable: false,
      }],
      workflow: {
        create: async () => {
          workflowCalls += 1;
          return {};
        },
        createBatch: async () => [],
        get: async () => {
          workflowCalls += 1;
          throw new Error("get must not be called");
        },
      },
    }, new Date("2026-07-29T08:30:00.000Z"));

    expect(workflowCalls).toBe(0);
  });

  it.each([
    ["errored", "restart"],
    ["paused", "resume"],
  ] as const)("continues a retryable %s Workflow with %s", async (
    workflowStatus,
    expectedAction,
  ) => {
    const actions: string[] = [];

    await coordinateScheduledBriefing({
      listRuns: async () => [{
        id: "retryable-run",
        editionDate: "2026-07-29",
        status: "retryable",
        retryable: true,
      }],
      workflow: {
        create: async () => {
          actions.push("create");
          return {};
        },
        createBatch: async () => [],
        get: async (id) => {
          actions.push(`get:${id}`);
          return {
            status: async () => ({ status: workflowStatus }),
            restart: async () => {
              actions.push("restart");
            },
            resume: async () => {
              actions.push("resume");
            },
          };
        },
      },
    }, new Date("2026-07-29T08:30:00.000Z"));

    expect(actions).toEqual(["get:2026-07-29", expectedAction]);
  });
});
