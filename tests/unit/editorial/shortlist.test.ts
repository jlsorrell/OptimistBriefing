import { describe, expect, it } from "vitest";

import type { Item, ItemScore } from "../../../src/contracts/editorial";
import {
  clusterNews,
  type NewsDevelopment,
} from "../../../src/editorial/cluster";
import type { NewsScore } from "../../../src/editorial/news-score";
import { scoreResearch } from "../../../src/editorial/research-score";
import {
  shortlist,
  type SectionBudgets,
  type ShortlistPreferences,
} from "../../../src/editorial/shortlist";

const NOW = "2026-07-29T12:00:00.000Z";

function item(
  id: string,
  primaryTopic: string,
  kind: Item["kind"] = "paper",
  metadata: Record<string, unknown> = {},
): Item {
  const section =
    typeof metadata.section === "string" ? metadata.section : null;
  return {
    id,
    kind,
    canonicalUrl: `https://example.com/${id}`,
    title: `Title ${id}`,
    publishedAt: NOW,
    sourceRefs: [
      {
        id: `source-${id}`,
        name: `Source ${id}`,
        url: `https://example.com/${id}`,
        role: kind === "forecast" ? "forecast" : "primary",
        retrievedAt: NOW,
      },
    ],
    accessLevel: "abstract",
    primaryTopic,
    tags: [primaryTopic],
    normalizedText: `Text ${id}`,
    metadata:
      kind === "paper" || kind === "blog" || section === null
        ? metadata
        : {
            ...metadata,
            primarySection: section,
            sectionEligibility: [section],
          },
    createdAt: NOW,
    expiresAt: null,
  };
}

function development(itemValue: Item): NewsDevelopment {
  const value = clusterNews([itemValue], {})[0];
  if (value === undefined) {
    throw new Error("Expected a news development fixture.");
  }
  return value;
}

function researchScore(itemId: string, total: number): ItemScore {
  return {
    itemId,
    topicalFit: total,
    technicalQuality: total,
    researchSignal: total,
    novelty: total,
    seriousAttention: total,
    total,
    selectionReasons: [`Topical fit ${Math.round(total * 100)}%`],
  };
}

function newsScore(itemId: string, total: number): NewsScore {
  return {
    itemId,
    publicImportance: total,
    personalRelevance: total,
    sourceQuality: total,
    corroboration: total,
    recency: total,
    geography: total,
    novelty: total,
    corroboratingSourceCount: 1,
    corroboratingSourceIds: [`source-${itemId}`],
    evidence: [],
    total,
    selectionReasons: [`Public importance ${Math.round(total * 100)}%`],
  };
}

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

describe("shortlist", () => {
  it("reserves shortlist space for distinct configured topics", () => {
    const items = [
      item("interpretability-1", "alignment-interpretability"),
      item("interpretability-2", "alignment-interpretability"),
      item("interpretability-3", "alignment-interpretability"),
      item("governance", "oversight-governance"),
    ];
    const scores = [
      researchScore("interpretability-1", 0.99),
      researchScore("interpretability-2", 0.98),
      researchScore("interpretability-3", 0.97),
      researchScore("governance", 0.8),
    ];

    const result = shortlist(items, scores, preferences, budgets);

    expect(
      new Set(
        result.researchFeatured.map(
          (featured) => featured.primaryTopic,
        ),
      ).size,
    ).toBeGreaterThan(1);
  });

  it("treats section budgets as maximums rather than quotas", () => {
    const loneWorldItem = item("world-1", "world", "article", {
      section: "world",
    });
    const loneWorld = development(loneWorldItem);

    const result = shortlist(
      [loneWorld],
      [newsScore(loneWorld.id, 0.9)],
      preferences,
      budgets,
    );

    expect(result.world).toEqual([loneWorld]);
    expect(result.technology).toEqual([]);
    expect(result.world).toHaveLength(1);
  });

  it("never exceeds the approved section maximum when given a larger budget", () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      development(
        item(`world-${index}`, "world", "article", { section: "world" }),
      ),
    );

    const result = shortlist(
      items,
      items.map(({ id }, index) => newsScore(id, 1 - index / 100)),
      preferences,
      { ...budgets, world: 99 },
    );

    expect(result.world).toHaveLength(4);
  });

  it("rejects an unchanged previous-edition development but keeps material changes", () => {
    const unchanged = item("unchanged", "ai_policy", "article", {
      section: "ai_policy",
      developmentKey: "agency-framework",
      materialFactsFingerprint: "version-1",
    });
    const changed = item("changed", "ai_policy", "article", {
      section: "ai_policy",
      developmentKey: "evaluation-rule",
      materialFactsFingerprint: "version-2",
    });
    const unchangedDevelopment = development(unchanged);
    const changedDevelopment = development(changed);

    const result = shortlist(
      [unchangedDevelopment, changedDevelopment],
      [
        newsScore(unchangedDevelopment.id, 0.95),
        newsScore(changedDevelopment.id, 0.8),
      ],
      {
        ...preferences,
        previousEditionDevelopments: [
          {
            developmentKey: "agency-framework",
            materialFactsFingerprint: "version-1",
          },
          {
            developmentKey: "evaluation-rule",
            materialFactsFingerprint: "version-1",
          },
        ],
      },
      budgets,
    );

    expect(result.aiPolicy.map(({ id }) => id)).toEqual([
      changedDevelopment.id,
    ]);
    expect(result.exclusions).toEqual([
      {
        itemId: unchangedDevelopment.id,
        reason: "unchanged_from_previous_edition",
      },
    ]);
  });

  it("uses stable item IDs to break score and timestamp ties", () => {
    const a = item("a", "world", "article", { section: "world" });
    const b = item("b", "world", "article", { section: "world" });
    const aDevelopment = development(a);
    const bDevelopment = development(b);
    const inputs = [bDevelopment, aDevelopment];
    const scores = [
      newsScore(bDevelopment.id, 0.8),
      newsScore(aDevelopment.id, 0.8),
    ];

    const forward = shortlist(
      inputs,
      scores,
      preferences,
      { ...budgets, world: 1 },
    );
    const reverse = shortlist(
      [...inputs].reverse(),
      [...scores].reverse(),
      preferences,
      { ...budgets, world: 1 },
    );

    expect(forward.world.map(({ id }) => id)).toEqual([
      aDevelopment.id,
    ]);
    expect(reverse.world).toEqual(forward.world);
  });

  it("rejects weak topical fit independently of a high aggregate score", () => {
    const weak = item("weak-topic", "alignment-interpretability");
    const score = {
      ...researchScore(weak.id, 0.9),
      topicalFit: 0.49,
      technicalQuality: 1,
      researchSignal: 1,
      novelty: 1,
      seriousAttention: 1,
      total: 0.9,
    };

    const result = shortlist([weak], [score], preferences, budgets);

    expect(result.researchFeatured).toEqual([]);
    expect(result.exclusions).toContainEqual({
      itemId: weak.id,
      reason: "below_topical_fit_gate",
    });
  });

  it("rejects weak technical quality independently of popularity signals", () => {
    const weak = item("weak-quality", "alignment-interpretability");
    const score = {
      ...researchScore(weak.id, 0.9),
      topicalFit: 1,
      technicalQuality: 0.49,
      researchSignal: 1,
      novelty: 1,
      seriousAttention: 1,
      total: 0.9,
    };

    const result = shortlist([weak], [score], preferences, budgets);

    expect(result.researchFeatured).toEqual([]);
    expect(result.exclusions).toContainEqual({
      itemId: weak.id,
      reason: "below_technical_quality_gate",
    });
  });

  it("allows a neutral absent assessment at the configured technical gate", () => {
    const neutral = item("neutral-assessment", "alignment-interpretability");
    const score = scoreResearch({
      itemId: neutral.id,
      topicalFit: 0.8,
      technicalQuality: null,
      researchSignal: 0.8,
      novelty: null,
      seriousAttention: null,
      assessment: null,
    });

    const result = shortlist([neutral], [score], preferences, budgets);

    expect(score.technicalQuality).toBe(0.5);
    expect(result.researchFeatured.map(({ id }) => id)).toEqual([
      neutral.id,
    ]);
  });
});
