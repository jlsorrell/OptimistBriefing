import { describe, expect, it } from "vitest";

import type {
  ResearchAssessment,
  StructuredSummary,
} from "../../../src/contracts/editorial";
import { assessResearch } from "../../../src/editorial/assess-research";
import {
  SummaryRejectedError,
  summarizeItem,
} from "../../../src/editorial/summarize";
import type { SourcePacket } from "../../../src/editorial/validate-summary";
import { FakeModelProvider } from "../../../src/models/fake-provider";
import { OpenAIModelProvider } from "../../../src/models/openai-provider";
import type { RawResearchCandidate } from "../../../src/sources/types";

const packet: SourcePacket = {
  itemKind: "article",
  sources: [
    {
      sourceId: "source-1",
      role: "reporting",
      title: "A measured outcome improved",
      url: "https://example.com/report",
      retrievedAt: "2026-07-29T09:00:00.000Z",
      accessLevel: "full_text",
      excerpts: [
        {
          number: 1,
          text: "The measured outcome improved during the trial.",
        },
      ],
    },
  ],
};

function validSummary(
  overrides: Partial<StructuredSummary> = {},
): StructuredSummary {
  return {
    title: "A measured outcome improved",
    oneSentence: "The measured outcome improved during the trial.",
    whyItMatters: "The result may improve an important outcome.",
    uncertainty: "The durability of the result remains uncertain.",
    claims: [
      {
        text: "The measured outcome improved.",
        sourceIds: ["source-1"],
        evidenceExcerpt: "measured outcome improved during the trial",
      },
    ],
    accessLevel: "full_text",
    ...overrides,
  };
}

function researchCandidate(): RawResearchCandidate {
  return {
    kind: "paper",
    sourceId: "arxiv",
    sourceName: "arXiv",
    sourceRole: "primary",
    title: "Auditable oversight for language models",
    originalUrl: "https://arxiv.org/abs/2607.00001",
    externalId: "arXiv:2607.00001",
    externalIds: ["arXiv:2607.00001"],
    publishedAt: "2026-07-29T08:00:00.000Z",
    retrievedAt: "2026-07-29T09:00:00.000Z",
    accessLevel: "abstract",
    authors: ["Ada Example"],
    institutions: ["Example Institute"],
    abstract:
      "We evaluate an auditable oversight method on language-model tasks.",
    content: null,
    relatedPaperIds: [],
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics: ["oversight-governance"],
    metadata: {},
  };
}

describe("summarizeItem", () => {
  it("returns a grounded structured summary without a repair call", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: [validSummary()],
    });

    await expect(summarizeItem(packet, provider)).resolves.toEqual(
      validSummary(),
    );
    expect(provider.generateRequests).toHaveLength(1);
  });

  it("sends only bounded source fields in a numbered source packet", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: [validSummary()],
    });

    await summarizeItem(packet, provider);

    const request = provider.generateRequests[0];
    expect(request?.system).toContain("Use only the supplied source packet.");
    expect(request?.system).toContain(
      "Every factual claim must cite one or more supplied source IDs.",
    );
    expect(request?.system).toContain("State uncertainty and disagreement.");
    expect(request?.system).toContain(
      "Do not imply full-paper access when access_level is abstract or metadata.",
    );
    expect(request?.system).toContain(
      "Return only data matching the supplied JSON schema.",
    );
    expect(request?.sourcePacket).toContain("source_id: source-1");
    expect(request?.sourcePacket).toContain("role: reporting");
    expect(request?.sourcePacket).toContain(
      "title: A measured outcome improved",
    );
    expect(request?.sourcePacket).toContain(
      "url: https://example.com/report",
    );
    expect(request?.sourcePacket).toContain(
      "retrieved_at: 2026-07-29T09:00:00.000Z",
    );
    expect(request?.sourcePacket).toContain("access_level: full_text");
    expect(request?.sourcePacket).toContain(
      "[1] The measured outcome improved during the trial.",
    );
  });

  it("makes one controlled repair and returns the repaired summary", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: [
        validSummary({
          claims: [
            {
              text: "Unsupported claim",
              sourceIds: ["unknown"],
              evidenceExcerpt: "Unsupported claim",
            },
          ],
        }),
        validSummary(),
      ],
    });

    await expect(summarizeItem(packet, provider)).resolves.toEqual(
      validSummary(),
    );
    expect(provider.generateRequests).toHaveLength(2);
    expect(provider.generateRequests[1]?.sourcePacket).toContain(
      "UNKNOWN_SOURCE:unknown",
    );
    expect(provider.generateRequests[1]?.sourcePacket).toContain(
      "source_id: source-1",
    );
    expect(provider.generateRequests[1]?.sourcePacket).not.toContain(
      "Unsupported claim",
    );
  });

  it("throws a typed rejection after exactly one failed repair and preserves errors", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: [
        validSummary({
          claims: [
            {
              text: "Unsupported claim",
              sourceIds: ["unknown"],
              evidenceExcerpt: "Unsupported claim",
            },
          ],
        }),
        validSummary({ uncertainty: "" }),
        validSummary(),
      ],
    });

    const rejection = await summarizeItem(packet, provider).catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(SummaryRejectedError);
    expect((rejection as SummaryRejectedError).errors).toEqual(
      expect.arrayContaining([
        "UNKNOWN_SOURCE:unknown",
        "SCHEMA_INVALID:uncertainty",
      ]),
    );
    expect(provider.generateRequests).toHaveLength(2);
  });

  it("reports malformed model output without hiding the schema failure", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: ["{not valid json", null],
    });

    const rejection = await summarizeItem(packet, provider).catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(SummaryRejectedError);
    expect((rejection as SummaryRejectedError).errors).toContain(
      "SCHEMA_INVALID:root",
    );
  });
});

describe("model assessment and embeddings", () => {
  it("returns a schema-validated research assessment", async () => {
    const assessment: ResearchAssessment = {
      technicalQuality: 0.8,
      novelty: 0.7,
      strengths: ["The evaluation compares against a clear baseline."],
      limitations: ["Only abstract-level evidence was available."],
      rationale: "The abstract describes a relevant controlled comparison.",
      accessLevel: "abstract",
    };
    const provider = new FakeModelProvider({
      generatedObjects: [assessment],
    });

    await expect(
      assessResearch(researchCandidate(), provider),
    ).resolves.toEqual(assessment);
  });

  it("does not hide malformed assessment output", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: [{ technicalQuality: "high" }],
    });

    await expect(
      assessResearch(researchCandidate(), provider),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects an assessment that overstates abstract-only access", async () => {
    const provider = new FakeModelProvider({
      generatedObjects: [
        {
          technicalQuality: 0.8,
          novelty: 0.7,
          strengths: ["The abstract describes a clear comparison."],
          limitations: ["The complete methods were not available."],
          rationale: "The available abstract supports a preliminary assessment.",
          accessLevel: "full_text",
        },
      ],
    });

    await expect(
      assessResearch(researchCandidate(), provider),
    ).rejects.toThrow("ACCESS_LEVEL_OVERCLAIM");
  });

  it("returns queued embeddings without a network dependency", async () => {
    const provider = new FakeModelProvider({
      embeddingBatches: [
        [
          [1, 0],
          [0, 1],
        ],
      ],
    });

    await expect(provider.embed(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});

describe("OpenAIModelProvider", () => {
  it("returns malformed response text as unknown for editorial validation", async () => {
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "test-generation-model",
      embeddingModel: "test-embedding-model",
      maxTransportRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "test-generation-model",
            output_text: "{not valid json",
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    await expect(
      provider.generateObject({
        model: "briefing-summary",
        schemaName: "structured_summary",
        jsonSchema: { type: "object" },
        system: "Use the packet.",
        sourcePacket: "source_id: source-1",
        maxOutputTokens: 100,
      }),
    ).resolves.toBe("{not valid json");
  });
});
