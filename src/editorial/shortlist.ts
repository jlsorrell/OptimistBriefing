import { z } from "zod";

import {
  ItemSchema,
  ItemScoreSchema,
  type Item,
  type ItemScore,
} from "../contracts/editorial";
import {
  NewsDevelopmentSchema,
  type NewsDevelopment,
} from "./cluster";
import { NewsScoreSchema, type NewsScore } from "./news-score";
import { classifyResearchRelevance } from "./research-relevance";

export type SectionBudgets = {
  morningBrief: number;
  featuredResearch: number;
  researchRadar: number;
  world: number;
  technology: number;
  aiPolicy: number;
  dmvAndBaltimore: number;
  forecastSignals: number;
};

export type PreviousEditionDevelopment = {
  developmentKey: string;
  materialFactsFingerprint: string;
};

export type ShortlistPreferences = {
  researchTopics: readonly string[];
  researchQualityGates: {
    minimumTopicalFit: number;
    minimumTechnicalQuality: number;
  };
  previousEditionDevelopments?: readonly PreviousEditionDevelopment[];
  minimumResearchScore?: number;
  minimumNewsScore?: number;
};

export type ShortlistExclusion = {
  itemId: string;
  reason:
    | "missing_score"
    | "below_quality_threshold"
    | "below_topical_fit_gate"
    | "below_technical_quality_gate"
    | "unchanged_from_previous_edition";
};

export type Shortlist = {
  morningBrief: (Item | NewsDevelopment)[];
  rankedMorningCandidates: (Item | NewsDevelopment)[];
  researchFeatured: Item[];
  researchRadar: Item[];
  world: NewsDevelopment[];
  technology: NewsDevelopment[];
  aiPolicy: NewsDevelopment[];
  dmv: NewsDevelopment[];
  baltimore: NewsDevelopment[];
  forecastSignals: NewsDevelopment[];
  exclusions: ShortlistExclusion[];
};

const BudgetsSchema = z.object({
  morningBrief: z.number().int().nonnegative(),
  featuredResearch: z.number().int().nonnegative(),
  researchRadar: z.number().int().nonnegative(),
  world: z.number().int().nonnegative(),
  technology: z.number().int().nonnegative(),
  aiPolicy: z.number().int().nonnegative(),
  dmvAndBaltimore: z.number().int().nonnegative(),
  forecastSignals: z.number().int().nonnegative(),
});

export const APPROVED_SECTION_MAXIMA: Readonly<SectionBudgets> =
  Object.freeze({
    morningBrief: 8,
    featuredResearch: 3,
    researchRadar: 6,
    world: 4,
    technology: 4,
    aiPolicy: 4,
    dmvAndBaltimore: 5,
    forecastSignals: 3,
  });

const PreferencesSchema = z.object({
  researchTopics: z.array(z.string().min(1)),
  researchQualityGates: z.object({
    minimumTopicalFit: z.number().finite().min(0).max(1),
    minimumTechnicalQuality: z.number().finite().min(0).max(1),
  }),
  previousEditionDevelopments: z
    .array(
      z.object({
        developmentKey: z.string().min(1),
        materialFactsFingerprint: z.string().min(1),
      }),
    )
    .optional(),
  minimumResearchScore: z.number().finite().min(0).max(1).optional(),
  minimumNewsScore: z.number().finite().min(0).max(1).optional(),
});

type RankedResearch = {
  item: Item;
  score: ItemScore;
};

type RankedNews = {
  development: NewsDevelopment;
  score: NewsScore;
};

function researchScoreOrder(
  left: RankedResearch,
  right: RankedResearch,
): number {
  return (
    right.score.total - left.score.total ||
    (right.item.publishedAt ?? "").localeCompare(
      left.item.publishedAt ?? "",
    ) ||
    left.item.id.localeCompare(right.item.id)
  );
}

function newsScoreOrder(left: RankedNews, right: RankedNews): number {
  return (
    right.score.total - left.score.total ||
    (right.development.publishedTo ?? "").localeCompare(
      left.development.publishedTo ?? "",
    ) ||
    left.development.id.localeCompare(right.development.id)
  );
}

function scoreMap(
  input: readonly (ItemScore | NewsScore)[],
): ReadonlyMap<string, ItemScore | NewsScore> {
  const scores = new Map<string, ItemScore | NewsScore>();
  for (const value of input) {
    const score =
      "publicImportance" in value
        ? NewsScoreSchema.parse(value)
        : ItemScoreSchema.parse(value);
    if (scores.has(score.itemId)) {
      throw new TypeError(`Duplicate score for item ${score.itemId}.`);
    }
    scores.set(score.itemId, score);
  }
  return scores;
}

function unchangedFromPreviousEdition(
  development: NewsDevelopment,
  previous: ReadonlyMap<string, string>,
): boolean {
  if (!development.repeatable) return false;
  if (development.materialChange) return false;
  const priorFingerprint = previous.get(development.developmentKey);
  if (priorFingerprint === undefined) return false;
  return development.materialFactsFingerprint === priorFingerprint;
}

function diverseResearch(
  ranked: readonly RankedResearch[],
  configuredTopics: readonly string[],
  maximum: number,
): RankedResearch[] {
  if (maximum === 0) return [];
  const selected = new Map<string, RankedResearch>();
  const representatives = configuredTopics.flatMap((topic) => {
    const representative = ranked.find(
      ({ item }) => item.primaryTopic === topic,
    );
    return representative === undefined ? [] : [representative];
  });
  for (const representative of representatives.sort(researchScoreOrder)) {
    if (selected.size >= maximum) break;
    selected.set(representative.item.id, representative);
  }
  for (const candidate of ranked) {
    if (selected.size >= maximum) break;
    selected.set(candidate.item.id, candidate);
  }
  return [...selected.values()].sort(researchScoreOrder);
}

function featuredResearch(
  ranked: readonly RankedResearch[],
  configuredTopics: readonly string[],
  maximum: number,
): RankedResearch[] {
  const core = ranked.filter(
    ({ item }) => classifyResearchRelevance(item) === "core",
  );
  const adjacent = ranked.filter(
    ({ item }) => classifyResearchRelevance(item) === "adjacent",
  );
  const selectedCore = diverseResearch(core, configuredTopics, maximum);
  const selectedIds = new Set(
    selectedCore.map(({ item }) => item.id),
  );
  const remaining = Math.max(0, maximum - selectedCore.length);
  const selectedAdjacent = diverseResearch(
    adjacent.filter(({ item }) => !selectedIds.has(item.id)),
    configuredTopics,
    remaining,
  );
  return [...selectedCore, ...selectedAdjacent];
}

type NewsSection =
  | "world"
  | "technology"
  | "ai_policy"
  | "dmv"
  | "baltimore"
  | "forecast";

function uniqueMorningBrief(
  research: readonly RankedResearch[],
  news: readonly RankedNews[],
): (Item | NewsDevelopment)[] {
  const candidates = [
    ...research.map(({ item, score }) => ({
      id: item.id,
      publishedAt: item.publishedAt,
      value: item as Item | NewsDevelopment,
      total: score.total,
    })),
    ...news.map(({ development, score }) => ({
      id: development.id,
      publishedAt: development.publishedTo,
      value: development as Item | NewsDevelopment,
      total: score.total,
    })),
  ].sort(
    (left, right) =>
      right.total - left.total ||
      (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
      left.id.localeCompare(right.id),
  );
  const selected = new Map<string, Item | NewsDevelopment>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.id)) {
      selected.set(candidate.id, candidate.value);
    }
  }
  return [...selected.values()];
}

export function shortlist(
  candidateInput: readonly (Item | NewsDevelopment)[],
  scoreInput: readonly (ItemScore | NewsScore)[],
  preferenceInput: ShortlistPreferences,
  budgetInput: SectionBudgets,
): Shortlist {
  const candidates = candidateInput.map((candidate) =>
    "representativeItem" in candidate
      ? NewsDevelopmentSchema.parse(candidate)
      : ItemSchema.parse(candidate),
  );
  const scores = scoreMap(scoreInput);
  const preferences = PreferencesSchema.parse(preferenceInput);
  const requestedBudgets = BudgetsSchema.parse(budgetInput);
  const budgets: SectionBudgets = {
    morningBrief: Math.min(
      requestedBudgets.morningBrief,
      APPROVED_SECTION_MAXIMA.morningBrief,
    ),
    featuredResearch: Math.min(
      requestedBudgets.featuredResearch,
      APPROVED_SECTION_MAXIMA.featuredResearch,
    ),
    researchRadar: Math.min(
      requestedBudgets.researchRadar,
      APPROVED_SECTION_MAXIMA.researchRadar,
    ),
    world: Math.min(requestedBudgets.world, APPROVED_SECTION_MAXIMA.world),
    technology: Math.min(
      requestedBudgets.technology,
      APPROVED_SECTION_MAXIMA.technology,
    ),
    aiPolicy: Math.min(
      requestedBudgets.aiPolicy,
      APPROVED_SECTION_MAXIMA.aiPolicy,
    ),
    dmvAndBaltimore: Math.min(
      requestedBudgets.dmvAndBaltimore,
      APPROVED_SECTION_MAXIMA.dmvAndBaltimore,
    ),
    forecastSignals: Math.min(
      requestedBudgets.forecastSignals,
      APPROVED_SECTION_MAXIMA.forecastSignals,
    ),
  };
  const previous = new Map(
    (preferences.previousEditionDevelopments ?? []).map((development) => [
      development.developmentKey,
      development.materialFactsFingerprint,
    ]),
  );
  const exclusions: ShortlistExclusion[] = [];
  const research: RankedResearch[] = [];
  const news: RankedNews[] = [];

  for (const candidate of candidates) {
    const score = scores.get(candidate.id);
    if (score === undefined) {
      exclusions.push({ itemId: candidate.id, reason: "missing_score" });
      continue;
    }
    if ("representativeItem" in candidate) {
      if (!("publicImportance" in score)) {
        throw new TypeError(
          `News development ${candidate.id} requires a news score.`,
        );
      }
      if (unchangedFromPreviousEdition(candidate, previous)) {
        exclusions.push({
          itemId: candidate.id,
          reason: "unchanged_from_previous_edition",
        });
        continue;
      }
      if (score.total < (preferences.minimumNewsScore ?? 0)) {
        exclusions.push({
          itemId: candidate.id,
          reason: "below_quality_threshold",
        });
        continue;
      }
      news.push({ development: candidate, score });
      continue;
    }
    const item = candidate;
    if (item.kind !== "paper" && item.kind !== "blog") {
      throw new TypeError(
        `News item ${item.id} must be clustered before shortlisting.`,
      );
    }
    if ("publicImportance" in score) {
      throw new TypeError(`Research item ${item.id} requires a research score.`);
    }
    if (
      score.topicalFit <
      preferences.researchQualityGates.minimumTopicalFit
    ) {
      exclusions.push({
        itemId: item.id,
        reason: "below_topical_fit_gate",
      });
      continue;
    }
    if (
      score.technicalQuality <
      preferences.researchQualityGates.minimumTechnicalQuality
    ) {
      exclusions.push({
        itemId: item.id,
        reason: "below_technical_quality_gate",
      });
      continue;
    }
    if (score.total < (preferences.minimumResearchScore ?? 0)) {
      exclusions.push({
        itemId: item.id,
        reason: "below_quality_threshold",
      });
      continue;
    }
    research.push({ item, score });
  }
  research.sort(researchScoreOrder);
  news.sort(newsScoreOrder);

  const featuredCandidates = research.filter(
    ({ item }) => item.kind === "paper",
  );
  const featured = featuredResearch(
    featuredCandidates,
    preferences.researchTopics,
    budgets.featuredResearch,
  );
  const featuredIds = new Set(featured.map(({ item }) => item.id));
  const radar = diverseResearch(
    research.filter(({ item }) => !featuredIds.has(item.id)),
    preferences.researchTopics,
    budgets.researchRadar,
  );

  const bySection = new Map<NewsSection, RankedNews[]>();
  for (const candidate of news) {
    const section = candidate.development.primarySection;
    bySection.set(section, [...(bySection.get(section) ?? []), candidate]);
  }
  const limited = (
    section: NewsSection,
    maximum: number,
  ): RankedNews[] =>
    (bySection.get(section) ?? []).sort(newsScoreOrder).slice(0, maximum);
  const world = limited("world", budgets.world);
  const technology = limited("technology", budgets.technology);
  const aiPolicy = limited("ai_policy", budgets.aiPolicy);
  const local = [
    ...(bySection.get("dmv") ?? []),
    ...(bySection.get("baltimore") ?? []),
  ]
    .sort(newsScoreOrder)
    .slice(0, budgets.dmvAndBaltimore);
  const dmv = local.filter(
    ({ development }) => development.primarySection === "dmv",
  );
  const baltimore = local.filter(
    ({ development }) => development.primarySection === "baltimore",
  );
  const forecastSignals = limited(
    "forecast",
    budgets.forecastSignals,
  );
  const rankedMorningCandidates = uniqueMorningBrief(
    featured,
    [
      ...world,
      ...technology,
      ...aiPolicy,
      ...local,
      ...forecastSignals,
    ],
  );
  const morningBrief = rankedMorningCandidates.slice(0, budgets.morningBrief);

  return {
    morningBrief,
    rankedMorningCandidates,
    researchFeatured: featured.map(({ item }) => item),
    researchRadar: radar.map(({ item }) => item),
    world: world.map(({ development }) => development),
    technology: technology.map(({ development }) => development),
    aiPolicy: aiPolicy.map(({ development }) => development),
    dmv: dmv.map(({ development }) => development),
    baltimore: baltimore.map(({ development }) => development),
    forecastSignals: forecastSignals.map(
      ({ development }) => development,
    ),
    exclusions: exclusions.sort((left, right) =>
      left.itemId.localeCompare(right.itemId),
    ),
  };
}
