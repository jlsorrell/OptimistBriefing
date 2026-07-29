import { describe, expect, it } from "vitest";

import type { Item, ItemScore } from "../../../src/contracts/editorial";
import type { NewsScore } from "../../../src/editorial/news-score";
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
    metadata,
    createdAt: NOW,
    expiresAt: null,
  };
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

    const result = shortlist(
      [loneWorldItem],
      [newsScore(loneWorldItem.id, 0.9)],
      preferences,
      budgets,
    );

    expect(result.world).toEqual([loneWorldItem]);
    expect(result.technology).toEqual([]);
    expect(result.world).toHaveLength(1);
  });

  it("never exceeds the approved section maximum when given a larger budget", () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      item(`world-${index}`, "world", "article", { section: "world" }),
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

    const result = shortlist(
      [unchanged, changed],
      [
        newsScore(unchanged.id, 0.95),
        newsScore(changed.id, 0.8),
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

    expect(result.aiPolicy.map(({ id }) => id)).toEqual(["changed"]);
    expect(result.exclusions).toEqual([
      {
        itemId: "unchanged",
        reason: "unchanged_from_previous_edition",
      },
    ]);
  });

  it("uses stable item IDs to break score and timestamp ties", () => {
    const a = item("a", "world", "article", { section: "world" });
    const b = item("b", "world", "article", { section: "world" });
    const inputs = [b, a];
    const scores = [newsScore("b", 0.8), newsScore("a", 0.8)];

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

    expect(forward.world.map(({ id }) => id)).toEqual(["a"]);
    expect(reverse.world).toEqual(forward.world);
  });
});
