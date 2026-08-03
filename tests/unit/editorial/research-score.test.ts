import { describe, expect, it } from "vitest";

import type { Item } from "../../../src/contracts/editorial";
import {
  scoreNews,
  type NewsEvidenceSource,
} from "../../../src/editorial/news-score";
import {
  scoreResearch,
  type ResearchScoreInput,
} from "../../../src/editorial/research-score";

function researchScoreFixture(
  overrides: Partial<ResearchScoreInput> = {},
): ResearchScoreInput {
  return {
    itemId: "paper-1",
    topicalFit: 0.5,
    technicalQuality: 0.5,
    researchSignal: 0.5,
    novelty: 0.5,
    seriousAttention: 0.5,
    ...overrides,
  };
}

function researchItemFixture(
  metadata: Record<string, unknown> = {},
): Item {
  return {
    id: "paper-1",
    kind: "paper",
    canonicalUrl: "https://arxiv.org/abs/2608.00001",
    title: "Debate as a mechanism for scalable oversight",
    publishedAt: "2026-08-01T12:00:00.000Z",
    sourceRefs: [{
      id: "arxiv",
      name: "arXiv",
      url: "https://arxiv.org/abs/2608.00001",
      role: "primary",
      retrievedAt: "2026-08-02T09:00:00.000Z",
    }],
    accessLevel: "abstract",
    primaryTopic: "scalable oversight",
    tags: ["research"],
    normalizedText: "The paper establishes a bounded oversight result.",
    metadata,
    createdAt: "2026-08-02T09:00:00.000Z",
    expiresAt: null,
  };
}

function evidence(
  sourceId: string,
  role: NewsEvidenceSource["role"],
  canCorroborateFacts: boolean,
): NewsEvidenceSource {
  return {
    sourceId,
    role,
    accessLevel: "full_text",
    provenanceUrl: `https://example.com/${sourceId}`,
    canCorroborateFacts,
  };
}

describe("scoreResearch", () => {
  it.each([
    ["topicalFit", 0.35],
    ["technicalQuality", 0.3],
    ["researchSignal", 0.15],
    ["novelty", 0.1],
    ["seriousAttention", 0.1],
  ] as const)("weights %s exactly", (component, expected) => {
    const score = scoreResearch(
      researchScoreFixture({
        topicalFit: 0,
        technicalQuality: 0,
        researchSignal: 0,
        novelty: 0,
        seriousAttention: 0,
        [component]: 1,
      }),
    );

    expect(score.total).toBe(expected);
  });

  it("caps affiliation at fifteen percent of the research score", () => {
    const score = scoreResearch(
      researchScoreFixture({
        topicalFit: 0,
        technicalQuality: 0,
        researchSignal: 1,
        novelty: 0,
        seriousAttention: 0,
      }),
    );

    expect(score.total).toBe(0.15);
  });

  it("does not penalize a new paper for missing citation data", () => {
    const missing = scoreResearch(
      researchScoreFixture({ seriousAttention: null }),
    );
    const neutral = scoreResearch(
      researchScoreFixture({ seriousAttention: 0.5 }),
    );

    expect(missing.total).toBe(neutral.total);
    expect(missing.seriousAttention).toBe(0.5);
  });

  it("treats an unavailable Task 8 assessment as neutral", () => {
    const absent = scoreResearch(
      researchScoreFixture({
        technicalQuality: null,
        novelty: null,
        assessment: null,
      }),
    );
    const neutral = scoreResearch(
      researchScoreFixture({
        technicalQuality: 0.5,
        novelty: 0.5,
      }),
    );

    expect(absent).toMatchObject({
      technicalQuality: 0.5,
      novelty: 0.5,
      total: neutral.total,
    });
  });

  it("normalizes finite component inputs and derives reasons from the values", () => {
    const score = scoreResearch(
      researchScoreFixture({
        topicalFit: 4,
        technicalQuality: -2,
        assessment: {
          technicalQuality: 0.1,
          novelty: 0.2,
          strengths: ["A strength"],
          limitations: ["A limitation"],
          rationale: "MODEL PROSE MUST NOT BECOME A REASON",
          accessLevel: "abstract",
        },
      }),
    );

    expect(score).toMatchObject({
      topicalFit: 1,
      technicalQuality: 0,
    });
    expect(score.selectionReasons.join(" ")).not.toContain("MODEL PROSE");
    expect(() =>
      scoreResearch(researchScoreFixture({ topicalFit: Number.NaN })),
    ).toThrow();
  });

  it("raises only serious attention for bounded implementation and commentary context", () => {
    const base = researchScoreFixture({
      technicalQuality: null,
      seriousAttention: null,
      assessment: {
        technicalQuality: 0.72,
        novelty: 0.61,
        strengths: ["A strength"],
        limitations: ["A limitation"],
        rationale: "Assessment rationale.",
        accessLevel: "abstract",
      },
    });
    const withoutContext = scoreResearch({
      ...base,
      candidate: researchItemFixture(),
    } as ResearchScoreInput & { candidate: Item });
    const withContext = scoreResearch({
      ...base,
      candidate: researchItemFixture({
        attachedCommentary: [
          {
            sourceId: "papers-with-code-co",
            role: "blog",
            title: "Implementation and review",
            url: "https://paperswithcode.co/paper/2608.00001",
            retrievedAt: "2026-08-02T09:00:00.000Z",
            accessLevel: "secondary",
            excerpt: "This review critiques the result and links an implementation.",
            relatedPaperIds: ["arXiv:2608.00001"],
            implementationAvailable: true,
          },
        ],
      }),
    } as ResearchScoreInput & { candidate: Item });

    expect(withContext.technicalQuality).toBe(withoutContext.technicalQuality);
    expect(withContext.seriousAttention).toBeGreaterThan(
      withoutContext.seriousAttention,
    );
    expect(withContext.seriousAttention).toBeLessThanOrEqual(1);
    expect(withContext.selectionReasons).toEqual(
      expect.arrayContaining([
        "Independent implementation located.",
        "Substantive expert commentary located.",
      ]),
    );
  });

  it("does not treat votes or comment counts as research quality signals", () => {
    const base = researchScoreFixture({
      technicalQuality: null,
      seriousAttention: null,
      assessment: {
        technicalQuality: 0.72,
        novelty: 0.61,
        strengths: ["A strength"],
        limitations: ["A limitation"],
        rationale: "Assessment rationale.",
        accessLevel: "abstract",
      },
    });
    const withoutPopularity = scoreResearch({
      ...base,
      candidate: researchItemFixture(),
    } as ResearchScoreInput & { candidate: Item });
    const withPopularity = scoreResearch({
      ...base,
      candidate: researchItemFixture({ voteCount: 50_000, commentCount: 4_000 }),
    } as ResearchScoreInput & { candidate: Item });

    expect(withPopularity).toEqual(withoutPopularity);
  });
});

describe("scoreNews", () => {
  it("counts only distinct qualifying primary and reporting sources", () => {
    const score = scoreNews({
      itemId: "cluster-1",
      publicImportance: 0.7,
      personalRelevance: 0.8,
      sourceQuality: 0.9,
      recency: 0.6,
      geography: 0.5,
      novelty: 0.4,
      evidence: [
        evidence("official", "primary", true),
        evidence("reuters", "reporting", true),
        evidence("reuters", "reporting", true),
        evidence("analysis", "analysis", true),
        evidence("opinion", "opinion", true),
        evidence("blog", "blog", true),
        evidence("market", "forecast", true),
        evidence("uncorroborated", "reporting", false),
      ],
    });

    expect(score.corroboratingSourceIds).toEqual(["official", "reuters"]);
    expect(score.corroboratingSourceCount).toBe(2);
    expect(score.corroboration).toBeCloseTo(2 / 3);
    expect(score.evidence).toHaveLength(8);
  });
});
