import { describe, expect, it } from "vitest";

import { clusterNews } from "../../../src/editorial/cluster";
import { deduplicateItems } from "../../../src/editorial/deduplicate";
import {
  scoreNewsDevelopment,
} from "../../../src/editorial/news-score";
import { normalizeCandidate } from "../../../src/editorial/normalize";
import { scoreResearch } from "../../../src/editorial/research-score";
import {
  shortlist,
  type SectionBudgets,
  type ShortlistPreferences,
} from "../../../src/editorial/shortlist";
import type {
  RawNewsCandidate,
  RawResearchCandidate,
} from "../../../src/sources/types";

const NOW = "2026-07-29T12:00:00.000Z";

const budgets: SectionBudgets = {
  morningBrief: 8,
  featuredResearch: 3,
  researchRadar: 6,
  world: 4,
  technology: 4,
  aiPolicy: 4,
  dmvAndBaltimore: 5,
  forecastSignals: 3,
};

const preferences: ShortlistPreferences = {
  researchTopics: [
    "alignment-interpretability",
    "oversight-governance",
    "secure-computation-ml",
  ],
  researchQualityGates: {
    minimumTopicalFit: 0.5,
    minimumTechnicalQuality: 0.5,
  },
};

function rawNews(
  sourceId: string,
  overrides: Partial<RawNewsCandidate>,
): RawNewsCandidate {
  return {
    kind: "article",
    sourceId,
    sourceName: sourceId,
    sourceRole: "reporting",
    title: "Evaluation Agency publishes secure AI framework",
    originalUrl: `https://${sourceId}.example.com/framework`,
    externalId: `${sourceId}:framework`,
    externalIds: [`${sourceId}:framework`],
    publishedAt: "2026-07-29T10:00:00.000Z",
    retrievedAt: NOW,
    accessLevel: "full_text",
    authors: [],
    institutions: [],
    abstract: "The Evaluation Agency published the framework.",
    content: null,
    relatedPaperIds: [],
    canCorroborateFacts: true,
    sectionEligibility: ["ai_policy"],
    namedEntities: ["Evaluation Agency"],
    primaryDocumentUrl: "https://agency.gov/framework",
    metadata: {
      primarySection: "ai_policy",
      developmentKey: "agency-framework",
      materialFactsFingerprint: "version-2",
    },
    ...overrides,
  };
}

function rawResearch(
  id: string,
  title: string,
  topics: string[],
): RawResearchCandidate {
  return {
    kind: "paper",
    sourceId: "arxiv",
    sourceName: "arXiv",
    sourceRole: "primary",
    title,
    originalUrl: `https://arxiv.org/abs/${id}`,
    externalId: `arXiv:${id}`,
    externalIds: [`arXiv:${id}`],
    publishedAt: "2026-07-29T08:00:00.000Z",
    retrievedAt: NOW,
    accessLevel: "abstract",
    authors: ["Example Author"],
    institutions: [],
    abstract: title,
    content: null,
    relatedPaperIds: [],
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics,
    metadata: {},
  };
}

describe("editorial production path", () => {
  it("selects a scored cluster by development ID with combined evidence", () => {
    const official = rawNews("agency", {
      kind: "document",
      sourceName: "Evaluation Agency",
      sourceRole: "primary",
      originalUrl: "https://agency.gov/framework",
    });
    const reporting = rawNews("reuters", {
      title: "Reuters analyzes the newly released agency document",
    });
    const normalized = [official, reporting].map(normalizeCandidate);
    const deduplicated = deduplicateItems(normalized);
    const developments = clusterNews(deduplicated.items, {});
    const development = developments[0];
    expect(development).toBeDefined();
    if (development === undefined) return;

    const score = scoreNewsDevelopment(development, {
      publicImportance: 0.9,
      personalRelevance: 0.9,
      sourceQuality: 0.9,
      recency: 1,
      geography: 0.3,
      novelty: 0.8,
    });
    const result = shortlist(
      developments,
      [score],
      preferences,
      budgets,
    );

    expect(score.itemId).toBe(development.id);
    expect(result.aiPolicy).toHaveLength(1);
    expect(result.aiPolicy[0]).toMatchObject({
      id: development.id,
      itemIds: expect.arrayContaining(
        deduplicated.items.map(({ id }) => id),
      ),
      corroboratingSourceIds: ["agency", "reuters"],
    });
    expect(result.aiPolicy[0]?.sourceEvidence).toHaveLength(2);
  });

  it("applies previous-edition material-change checks to the development", () => {
    const developments = clusterNews(
      [
        normalizeCandidate(rawNews("agency", { kind: "document" })),
        normalizeCandidate(rawNews("reuters", {})),
      ],
      {},
    );
    const development = developments[0];
    expect(development).toBeDefined();
    if (development === undefined) return;
    const score = scoreNewsDevelopment(development, {
      publicImportance: 0.8,
      personalRelevance: 0.8,
      sourceQuality: 0.8,
      recency: 0.8,
      geography: 0.2,
      novelty: 0.8,
    });

    const repeated = shortlist(
      developments,
      [score],
      {
        ...preferences,
        previousEditionDevelopments: [
          {
            developmentKey: "agency-framework",
            materialFactsFingerprint: "version-2",
          },
        ],
      },
      budgets,
    );
    const changed = shortlist(
      developments,
      [score],
      {
        ...preferences,
        previousEditionDevelopments: [
          {
            developmentKey: "agency-framework",
            materialFactsFingerprint: "version-1",
          },
        ],
      },
      budgets,
    );

    expect(repeated.aiPolicy).toEqual([]);
    expect(repeated.exclusions).toContainEqual({
      itemId: development.id,
      reason: "unchanged_from_previous_edition",
    });
    expect(changed.aiPolicy.map(({ id }) => id)).toEqual([
      development.id,
    ]);
  });

  it("maps Task 5 provider labels to configured IDs before diversity selection", () => {
    const raw = [
      rawResearch(
        "2607.10001",
        "Mechanistic interpretability of learned representations",
        ["Artificial Intelligence", "Interpretability"],
      ),
      rawResearch(
        "2607.10002",
        "Concept evolution during language model training",
        ["Machine Learning", "Representation Learning"],
      ),
      rawResearch(
        "2607.10003",
        "Scaling laws for emergent in-context learning",
        ["Artificial Intelligence", "Scaling"],
      ),
      rawResearch(
        "2607.10004",
        "Zero-knowledge proofs for private neural network inference",
        ["Cryptography", "Zero Knowledge Proof"],
      ),
    ];
    const items = raw.map(normalizeCandidate);
    const scores = items.map((item, index) =>
      scoreResearch({
        itemId: item.id,
        topicalFit: 0.95 - index * 0.05,
        technicalQuality: 0.8,
        researchSignal: 0.6,
        novelty: 0.7,
        seriousAttention: null,
      }),
    );

    const result = shortlist(items, scores, preferences, budgets);

    expect(items.map(({ primaryTopic }) => primaryTopic)).toEqual([
      "alignment-interpretability",
      "alignment-interpretability",
      "alignment-interpretability",
      "secure-computation-ml",
    ]);
    expect(
      new Set(
        result.researchFeatured.map(({ primaryTopic }) => primaryTopic),
      ),
    ).toEqual(
      new Set([
        "alignment-interpretability",
        "secure-computation-ml",
      ]),
    );
  });
});
