import { describe, expect, it } from "vitest";

import type { Item } from "../../../src/contracts/editorial";
import {
  clusterNews,
  type NewsDevelopment,
} from "../../../src/editorial/cluster";
import type { Shortlist } from "../../../src/editorial/shortlist";
import { assembleResearchFirstMorning } from
  "../../../src/workflow/research-first-morning";

const NOW = "2026-08-11T09:00:00.000Z";

function item(
  id: string,
  section: "research" | "world" | "technology" | "ai_policy" | "dmv" | "baltimore" | "forecast",
): Item {
  const research = section === "research";
  return {
    id,
    kind: research ? "paper" : section === "forecast" ? "forecast" : "article",
    canonicalUrl: `https://example.com/${id}`,
    title: `Title ${id}`,
    publishedAt: NOW,
    sourceRefs: [{
      id: `source-${id}`,
      name: `Source ${id}`,
      url: `https://example.com/${id}`,
      role: section === "forecast" ? "forecast" : research ? "primary" : "reporting",
      retrievedAt: NOW,
    }],
    accessLevel: "abstract",
    primaryTopic: section,
    tags: [section],
    normalizedText: `Evidence ${id}`,
    metadata: research ? {} : {
      primarySection: section,
      sectionEligibility: [section],
    },
    createdAt: NOW,
    expiresAt: null,
  };
}

function research(id: string): Item {
  return item(id, "research");
}

function news(
  id: string,
  section: "world" | "technology" | "ai_policy" | "dmv" | "baltimore" | "forecast",
): NewsDevelopment {
  const value = clusterNews([item(id, section)], {})[0];
  if (value === undefined) throw new Error(`Missing development ${id}.`);
  return { ...value, id };
}

function shortlistFixture(input: {
  ranked: readonly (Item | NewsDevelopment)[];
  featured?: readonly Item[];
  world?: readonly NewsDevelopment[];
  technology?: readonly NewsDevelopment[];
  aiPolicy?: readonly NewsDevelopment[];
  dmv?: readonly NewsDevelopment[];
  baltimore?: readonly NewsDevelopment[];
  forecast?: readonly NewsDevelopment[];
}): Shortlist {
  return {
    morningBrief: [...input.ranked.slice(0, 8)],
    rankedMorningCandidates: [...input.ranked],
    researchFeatured: [...(input.featured ?? [])],
    researchRadar: [],
    world: [...(input.world ?? [])],
    technology: [...(input.technology ?? [])],
    aiPolicy: [...(input.aiPolicy ?? [])],
    dmv: [...(input.dmv ?? [])],
    baltimore: [...(input.baltimore ?? [])],
    forecastSignals: [...(input.forecast ?? [])],
    exclusions: [],
  };
}

describe("assembleResearchFirstMorning", () => {
  it("keeps research first and admits nonlocal news below a local-heavy cutoff", () => {
    const researchA = research("research-a");
    const researchB = research("research-b");
    const researchC = research("research-c");
    const locals = Array.from({ length: 5 }, (_, index) =>
      news(`local-${index + 1}`, "baltimore"),
    );
    const worldReserve = news("world-reserve", "world");
    const selected = shortlistFixture({
      ranked: [
        researchA,
        researchB,
        researchC,
        ...locals,
        worldReserve,
      ],
      featured: [researchA, researchB, researchC],
      world: [worldReserve],
      baltimore: locals,
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 8,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "research-b", section: "research" },
      { id: "research-c", section: "research" },
      { id: "world-reserve", section: "world" },
      { id: "local-1", section: "baltimore" },
      { id: "local-2", section: "baltimore" },
      { id: "local-3", section: "baltimore" },
      { id: "local-4", section: "baltimore" },
    ]);
  });

  it("uses the best local candidate before global fill when no nonlocal candidate exists", () => {
    const researchA = research("research-a");
    const researchB = research("research-b");
    const local = news("local", "dmv");
    const forecast = news("forecast", "forecast");
    const selected = shortlistFixture({
      ranked: [researchA, researchB, local, forecast],
      featured: [researchA, researchB],
      dmv: [local],
      forecast: [forecast],
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 4,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "research-b", section: "research" },
      { id: "local", section: "dmv" },
      { id: "forecast", section: "forecast" },
    ]);
  });

  it("uses the best nonlocal candidate before global fill when no local candidate exists", () => {
    const researchA = research("research-a");
    const researchB = research("research-b");
    const world = news("world", "world");
    const forecast = news("forecast", "forecast");
    const selected = shortlistFixture({
      ranked: [researchA, researchB, world, forecast],
      featured: [researchA, researchB],
      world: [world],
      forecast: [forecast],
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 4,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "research-b", section: "research" },
      { id: "world", section: "world" },
      { id: "forecast", section: "forecast" },
    ]);
  });

  it("returns featured research only when there is no news", () => {
    const researchA = research("research-a");
    const researchB = research("research-b");
    const selected = shortlistFixture({
      ranked: [researchA, researchB],
      featured: [researchA, researchB],
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 8,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "research-b", section: "research" },
    ]);
  });

  it("lets featured research consume capacity before coverage reservations", () => {
    const researchA = research("research-a");
    const researchB = research("research-b");
    const researchC = research("research-c");
    const world = news("world", "world");
    const selected = shortlistFixture({
      ranked: [researchA, researchB, researchC, world],
      featured: [researchA, researchB, researchC],
      world: [world],
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 2,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "research-b", section: "research" },
    ]);
  });

  it("returns no selections at zero capacity", () => {
    const researchA = research("research-a");
    const world = news("world", "world");
    const selected = shortlistFixture({
      ranked: [researchA, world],
      featured: [researchA],
      world: [world],
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 0,
      featuredResearch: 3,
    })).toEqual([]);
  });

  it("emits a candidate listed in multiple sections only once", () => {
    const researchA = research("research-a");
    const shared = news("shared", "world");
    const selected = shortlistFixture({
      ranked: [researchA, shared],
      featured: [researchA],
      world: [shared],
      dmv: [shared],
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 3,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "shared", section: "world" },
    ]);
  });

  it("does not let a forecast satisfy coverage reservations but globally fills it", () => {
    const researchA = research("research-a");
    const forecast = news("forecast", "forecast");
    const local = news("local", "baltimore");
    const world = news("world", "world");
    const selected = shortlistFixture({
      ranked: [researchA, forecast, local, world],
      featured: [researchA],
      world: [world],
      baltimore: [local],
      forecast: [forecast],
    });

    expect(assembleResearchFirstMorning(selected, {
      morningBrief: 4,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "world", section: "world" },
      { id: "local", section: "baltimore" },
      { id: "forecast", section: "forecast" },
    ]);
  });

  it("uses the full ranking instead of shuffled section-array order", () => {
    const researchA = research("research-a");
    const worldHigh = news("world-high", "world");
    const worldLow = news("world-low", "world");
    const dmvHigh = news("dmv-high", "dmv");
    const dmvLow = news("dmv-low", "dmv");
    const forecast = news("forecast", "forecast");
    const ranked = [
      researchA,
      worldHigh,
      dmvHigh,
      worldLow,
      dmvLow,
      forecast,
    ];
    const base = shortlistFixture({
      ranked,
      featured: [researchA],
      world: [worldHigh, worldLow],
      dmv: [dmvHigh, dmvLow],
      forecast: [forecast],
    });
    const shuffled = shortlistFixture({
      ranked,
      featured: [researchA],
      world: [worldLow, worldHigh],
      dmv: [dmvLow, dmvHigh],
      forecast: [forecast],
    });

    expect(assembleResearchFirstMorning(shuffled, {
      morningBrief: 6,
      featuredResearch: 3,
    })).toEqual([
      { id: "research-a", section: "research" },
      { id: "world-high", section: "world" },
      { id: "dmv-high", section: "dmv" },
      { id: "world-low", section: "world" },
      { id: "dmv-low", section: "dmv" },
      { id: "forecast", section: "forecast" },
    ]);
    expect(assembleResearchFirstMorning(shuffled, {
      morningBrief: 6,
      featuredResearch: 3,
    })).toEqual(assembleResearchFirstMorning(base, {
      morningBrief: 6,
      featuredResearch: 3,
    }));
  });
});
