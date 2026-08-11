import { describe, expect, it } from "vitest";

import type { Item } from "../../../src/contracts/editorial";
import {
  classifyResearchRelevance,
  researchRelevanceReason,
} from "../../../src/editorial/research-relevance";

function paper(
  text: string,
  primaryTopic = "alignment-interpretability",
  overrides: Partial<Item> = {},
): Item {
  return {
    id: "paper-1",
    kind: "paper",
    canonicalUrl: "https://example.com/papers/paper-1",
    title: text,
    publishedAt: "2026-08-01T12:00:00.000Z",
    sourceRefs: [{
      id: "source-1",
      name: "Research source",
      url: "https://example.com/papers/paper-1",
      role: "primary",
      retrievedAt: "2026-08-02T09:00:00.000Z",
    }],
    accessLevel: "abstract",
    primaryTopic,
    tags: ["research"],
    normalizedText: "",
    metadata: {},
    createdAt: "2026-08-02T09:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

describe("classifyResearchRelevance", () => {
  it.each([
    ["Mechanistic analysis of internal concept representations during training", "alignment-interpretability"],
    ["A theoretical model of phase transitions in neural scaling laws", "alignment-interpretability"],
    ["Eliciting hidden capabilities from sandbagging language models", "alignment-interpretability"],
    ["AI safety via debate as a scalable oversight protocol", "alignment-interpretability"],
    ["A game-theoretic model of strategic multi-agent learning", "alignment-interpretability"],
    ["Cryptographic verification of neural network inference", "oversight-governance"],
    ["A secure evaluation framework for frontier models", "oversight-governance"],
    ["Zero-knowledge proofs for machine-learning model evaluation", "secure-computation-ml"],
  ] as const)("classifies %s as core", (text, topic) => {
    expect(classifyResearchRelevance(paper(text, topic))).toBe("core");
  });

  it.each([
    "Expert perspectives on AI safety and ethics",
    "A governance framework for responsible artificial intelligence",
    "Interpretability challenges in modern AI",
    "Evaluation practices for aligned systems",
    "MPC performance for database transactions",
  ] as const)("keeps broader or ambiguous work adjacent: %s", (text) => {
    expect(classifyResearchRelevance(
      paper(text, "alignment-interpretability"),
    )).toBe("adjacent");
  });

  it("uses full-text technical evidence when the title is generic", () => {
    expect(classifyResearchRelevance(paper("A new research result", "research", {
      normalizedText:
        "We introduce representation-level interpretability for transformers.",
    }))).toBe("core");
  });

  it("uses title evidence when the full text is empty", () => {
    expect(classifyResearchRelevance(
      paper("Debate-based oversight for language models", "research"),
    )).toBe("core");
  });

  it("normalizes NFKC and case before matching", () => {
    expect(classifyResearchRelevance(
      paper("ＭＥＣＨＡＮＩＳＴＩＣ ＩＮＴＥＲＰＲＥＴＡＢＩＬＩＴＹ", "research"),
    )).toBe("core");
  });

  it.each([
    "Fully homomorphic encryption for neural network inference",
    "MPC for machine learning",
    "ZKP for model training",
  ] as const)("requires secure-computation evidence to co-occur with ML context: %s", (text) => {
    expect(classifyResearchRelevance(paper(text, "secure computation"))).toBe(
      "core",
    );
  });

  it.each([
    "Fully homomorphic encryption for medical records",
    "MPC for database transactions",
    "ZKP for blockchain payments",
  ] as const)("does not accept secure-computation evidence without ML context: %s", (text) => {
    expect(classifyResearchRelevance(paper(text, "secure computation"))).toBe(
      "adjacent",
    );
  });

  it("bounds evidence before late full-text matches", () => {
    expect(classifyResearchRelevance(paper("General research", "research", {
      normalizedText: `${"x".repeat(20_000)} debate protocol`,
    }))).toBe("adjacent");
  });

  it("does not infer relevance from authors, institutions, citations, or model output", () => {
    expect(classifyResearchRelevance(paper("General research", "research", {
      metadata: {
        authors: ["Mechanistic Interpretability Researcher"],
        institutions: ["AI Safety Institute"],
        citationCount: 50_000,
        sourcePrestige: "highest",
        modelOutput: "Debate protocol for neural network oversight",
        embedding: [0.1, 0.2, 0.3],
      },
    }))).toBe("adjacent");
  });

  it("accepts blog items as research inputs", () => {
    expect(classifyResearchRelevance(paper(
      "Proof-of-learning for model provenance",
      "research",
      { kind: "blog" },
    ))).toBe("core");
  });

  it.each(["article", "document", "forecast"] as const)(
    "rejects non-research item kind %s",
    (kind) => {
      expect(() => classifyResearchRelevance(paper("General research", "research", {
        kind,
      }))).toThrowError(
        new TypeError("Research relevance requires a paper or blog item."),
      );
    },
  );
});

describe("researchRelevanceReason", () => {
  it("returns the exact deterministic reason for each tier", () => {
    expect(researchRelevanceReason("core"))
      .toBe("Direct technical-interest match.");
    expect(researchRelevanceReason("adjacent"))
      .toBe("Broader research match used as fallback.");
  });
});
