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
  normalizedText = `Text ${id}`,
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
    normalizedText,
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

function itemWithText(id: string, text: string): Item {
  return item(id, "alignment-interpretability", "paper", {}, text);
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
  it("ranks non-arXiv research by editorial score without a source reservation", () => {
    const arxiv = itemWithText("arxiv", "Mechanistic interpretability for transformers");
    const nonArxiv = itemWithText("non-arxiv", "Mechanistic interpretability for transformers");
    nonArxiv.metadata.discoveryFamily = "official-publication";

    const winning = shortlist(
      [arxiv, nonArxiv],
      [researchScore(arxiv.id, 0.8), researchScore(nonArxiv.id, 0.9)],
      preferences,
      { ...budgets, featuredResearch: 1, researchRadar: 0 },
    );
    const losing = shortlist(
      [arxiv, nonArxiv],
      [researchScore(arxiv.id, 0.9), researchScore(nonArxiv.id, 0.8)],
      preferences,
      { ...budgets, featuredResearch: 1, researchRadar: 0 },
    );

    expect(winning.researchFeatured.map(({ id }) => id)).toEqual(["non-arxiv"]);
    expect(losing.researchFeatured.map(({ id }) => id)).toEqual(["arxiv"]);
  });

  it("selects a lower-scoring core paper before a higher-scoring adjacent paper", () => {
    const core = item(
      "core",
      "alignment-interpretability",
      "paper",
      {},
      "Capability elicitation for hidden language-model abilities",
    );
    const adjacent = item(
      "adjacent",
      "alignment-interpretability",
      "paper",
      {},
      "Expert perspectives on AI safety and ethics",
    );
    const result = shortlist(
      [adjacent, core],
      [
        researchScore(adjacent.id, 0.99),
        researchScore(core.id, 0.75),
      ],
      preferences,
      { ...budgets, featuredResearch: 1 },
    );

    expect(result.researchFeatured.map(({ id }) => id)).toEqual([
      core.id,
    ]);
  });

  it("fills unused featured capacity with the best adjacent papers", () => {
    const candidates = [
      itemWithText(
        "core",
        "Capability elicitation for hidden model abilities",
      ),
      itemWithText("adjacent-high", "A broad framework for AI safety"),
      itemWithText("adjacent-low", "Expert perspectives on AI ethics"),
    ];
    const result = shortlist(
      candidates,
      [
        researchScore("core", 0.7),
        researchScore("adjacent-high", 0.95),
        researchScore("adjacent-low", 0.8),
      ],
      preferences,
      budgets,
    );

    expect(result.researchFeatured.map(({ id }) => id)).toEqual([
      "core",
      "adjacent-high",
      "adjacent-low",
    ]);
  });

  it("excludes a higher-scoring adjacent paper when three core papers fill featured", () => {
    const candidates = [
      itemWithText("core-high", "Debate-based oversight for language models"),
      itemWithText(
        "core-mid",
        "Capability elicitation for hidden model abilities",
      ),
      itemWithText("core-low", "Mechanistic interpretability for transformers"),
      itemWithText("adjacent", "A broad framework for AI safety"),
    ];
    const result = shortlist(
      candidates,
      [
        researchScore("core-high", 0.9),
        researchScore("core-mid", 0.8),
        researchScore("core-low", 0.7),
        researchScore("adjacent", 0.99),
      ],
      preferences,
      { ...budgets, featuredResearch: 99 },
    );

    expect(result.researchFeatured.map(({ id }) => id)).toEqual([
      "core-high",
      "core-mid",
      "core-low",
    ]);
    expect(result.researchRadar.map(({ id }) => id)).toEqual([
      "adjacent",
    ]);
  });

  it("preserves configured-topic diversity within the core tier", () => {
    const candidates = [
      itemWithText(
        "alignment-high",
        "Mechanistic interpretability for transformers",
      ),
      itemWithText(
        "alignment-mid",
        "Capability elicitation for hidden model abilities",
      ),
      item(
        "governance",
        "oversight-governance",
        "paper",
        {},
        "A secure evaluation framework for frontier models",
      ),
    ];
    const result = shortlist(
      candidates,
      [
        researchScore("alignment-high", 0.99),
        researchScore("alignment-mid", 0.98),
        researchScore("governance", 0.7),
      ],
      preferences,
      { ...budgets, featuredResearch: 2 },
    );

    expect(result.researchFeatured.map(({ id }) => id)).toEqual([
      "alignment-high",
      "governance",
    ]);
  });

  it("keeps core-first featured ordering deterministic for reversed inputs", () => {
    const candidates = [
      itemWithText("core-b", "Mechanistic interpretability for transformers"),
      itemWithText("adjacent", "A broad framework for AI safety"),
      itemWithText(
        "core-a",
        "Capability elicitation for hidden model abilities",
      ),
    ];
    const scores = [
      researchScore("core-b", 0.8),
      researchScore("adjacent", 0.99),
      researchScore("core-a", 0.8),
    ];

    const forward = shortlist(candidates, scores, preferences, {
      ...budgets,
      featuredResearch: 2,
    });
    const reverse = shortlist(
      [...candidates].reverse(),
      [...scores].reverse(),
      preferences,
      { ...budgets, featuredResearch: 2 },
    );

    expect(forward.researchFeatured.map(({ id }) => id)).toEqual([
      "core-a",
      "core-b",
    ]);
    expect(reverse.researchFeatured).toEqual(forward.researchFeatured);
  });

  it("returns empty featured and radar sections for an empty qualified research pool", () => {
    const result = shortlist([], [], preferences, budgets);

    expect(result.researchFeatured).toEqual([]);
    expect(result.researchRadar).toEqual([]);
  });

  it("keeps topical-fit and technical-quality exclusions ahead of core and adjacent selection", () => {
    const weakCore = itemWithText(
      "weak-core",
      "Capability elicitation for hidden model abilities",
    );
    const weakAdjacent = itemWithText(
      "weak-adjacent",
      "A broad framework for AI safety",
    );
    const result = shortlist(
      [weakCore, weakAdjacent],
      [
        {
          ...researchScore(weakCore.id, 0.9),
          topicalFit: 0.49,
        },
        {
          ...researchScore(weakAdjacent.id, 0.9),
          technicalQuality: 0.49,
        },
      ],
      preferences,
      budgets,
    );

    expect(result.researchFeatured).toEqual([]);
    expect(result.researchRadar).toEqual([]);
    expect(result.exclusions).toEqual([
      {
        itemId: weakAdjacent.id,
        reason: "below_technical_quality_gate",
      },
      {
        itemId: weakCore.id,
        reason: "below_topical_fit_gate",
      },
    ]);
  });

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

  it("retains eligible candidates below the capped morning cutoff", () => {
    const research = [
      itemWithText("research-a", "Mechanistic interpretability for oversight"),
      itemWithText("research-b", "Capability elicitation for hidden abilities"),
      itemWithText("research-c", "Debate-based oversight for language models"),
    ];
    const local = Array.from({ length: 5 }, (_, index) =>
      development(
        item(`local-${index + 1}`, "baltimore", "article", {
          section: "baltimore",
        }),
      ),
    );
    const world = development(
      item("world-reserve", "world", "article", { section: "world" }),
    );
    const candidates = [...research, ...local, world];
    const scores = [
      researchScore("research-a", 0.99),
      researchScore("research-b", 0.98),
      researchScore("research-c", 0.97),
      ...local.map((candidate, index) =>
        newsScore(candidate.id, 0.96 - index * 0.01),
      ),
      newsScore(world.id, 0.9),
    ];

    const result = shortlist(candidates, scores, preferences, budgets);

    expect(result.morningBrief).toHaveLength(8);
    expect(result.morningBrief.map(({ id }) => id)).not.toContain(world.id);
    expect(result.rankedMorningCandidates.map(({ id }) => id)).toEqual([
      "research-a",
      "research-b",
      "research-c",
      ...local.map(({ id }) => id),
      world.id,
    ]);
  });

  it("rejects an unchanged previous-edition development but keeps material changes", () => {
    const unchanged = item("unchanged", "ai_policy", "article", {
      section: "ai_policy",
      primaryDocumentUrl: "https://agency.gov/framework",
      eventFamilies: ["guidance-rule"],
      eventInstances: [
        {
          subject: "evaluation-agency",
          domain: "governance-event",
          object: "secure-ai-framework",
        },
      ],
      materialFacts: [
        { kind: "status", key: "event-status", value: "adopted" },
      ],
      scopedMaterialFacts: [
        {
          kind: "status",
          key: "event-status",
          value: "adopted",
          eventInstance: {
            subject: "evaluation-agency",
            domain: "governance-event",
            object: "secure-ai-framework",
          },
        },
      ],
    });
    const changed = item("changed", "ai_policy", "article", {
      section: "ai_policy",
      primaryDocumentUrl: "https://agency.gov/evaluation-rule",
      eventFamilies: ["guidance-rule"],
      eventInstances: [
        {
          subject: "evaluation-agency",
          domain: "governance-event",
          object: "evaluation-rule",
        },
      ],
      materialFacts: [
        { kind: "status", key: "event-status", value: "adopted" },
      ],
      scopedMaterialFacts: [
        {
          kind: "status",
          key: "event-status",
          value: "adopted",
          eventInstance: {
            subject: "evaluation-agency",
            domain: "governance-event",
            object: "evaluation-rule",
          },
        },
      ],
    });
    const changedPreviously = item(
      "changed-previously",
      "ai_policy",
      "article",
      {
        section: "ai_policy",
        primaryDocumentUrl: "https://agency.gov/evaluation-rule",
        eventFamilies: ["guidance-rule"],
        eventInstances: [
          {
            subject: "evaluation-agency",
            domain: "governance-event",
            object: "evaluation-rule",
          },
        ],
        materialFacts: [
          {
            kind: "status",
            key: "event-status",
            value: "proposed",
          },
        ],
        scopedMaterialFacts: [
          {
            kind: "status",
            key: "event-status",
            value: "proposed",
            eventInstance: {
              subject: "evaluation-agency",
              domain: "governance-event",
              object: "evaluation-rule",
            },
          },
        ],
      },
    );
    const unchangedPreviously = development(unchanged);
    const changedPreviousDevelopment = development(
      changedPreviously,
    );
    const unchangedDevelopment = development(unchanged);
    const changedDevelopment = development(changed);

    expect(changedDevelopment.developmentKey).toBe(
      changedPreviousDevelopment.developmentKey,
    );
    expect(changedDevelopment.materialFactsFingerprint).not.toBe(
      changedPreviousDevelopment.materialFactsFingerprint,
    );

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
            developmentKey: unchangedPreviously.developmentKey,
            materialFactsFingerprint:
              unchangedPreviously.materialFactsFingerprint,
          },
          {
            developmentKey:
              changedPreviousDevelopment.developmentKey,
            materialFactsFingerprint:
              changedPreviousDevelopment.materialFactsFingerprint,
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
