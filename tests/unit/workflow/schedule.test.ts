import { describe, expect, it } from "vitest";

import {
  coordinateScheduledBriefing,
  shouldRunAt,
} from "../../../src/workflow/schedule";
import type { Item } from "../../../src/contracts/editorial";
import type {
  GenerateObjectRequest,
  ModelProvider,
} from "../../../src/models/provider";
import { createProductionPipelineContext } from "../../../src/workflow/run-editorial-pipeline";
import type { PipelineStore } from "../../../src/workflow/types";

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
      workflow: {
        version: 1,
        ...(options.researchTier === undefined
          ? {}
          : { researchTier: options.researchTier }),
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
  });
}

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

  it("reapplies a hardened budget to cached radar before assessment and synthesis", async () => {
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

    await expect(hard.assess([featured, radar])).resolves.toHaveLength(1);
    await expect(hard.synthesize([featured, radar, news])).resolves.toHaveLength(2);
    expect(hardProvider.generateRequests.map((request) => [
      request.schemaName,
      request.maxOutputTokens,
    ])).toEqual([
      ["research_assessment", 1_200],
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
