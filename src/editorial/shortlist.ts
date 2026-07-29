import { z } from "zod";

import {
  ItemSchema,
  ItemScoreSchema,
  type Item,
  type ItemScore,
} from "../contracts/editorial";
import { NewsScoreSchema, type NewsScore } from "./news-score";

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
  previousEditionDevelopments?: readonly PreviousEditionDevelopment[];
  minimumResearchScore?: number;
  minimumNewsScore?: number;
};

export type ShortlistExclusion = {
  itemId: string;
  reason:
    | "missing_score"
    | "below_quality_threshold"
    | "unchanged_from_previous_edition";
};

export type Shortlist = {
  morningBrief: Item[];
  researchFeatured: Item[];
  researchRadar: Item[];
  world: Item[];
  technology: Item[];
  aiPolicy: Item[];
  dmv: Item[];
  baltimore: Item[];
  forecastSignals: Item[];
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

type RankedItem = {
  item: Item;
  score: ItemScore | NewsScore;
};

function scoreOrder(left: RankedItem, right: RankedItem): number {
  return (
    right.score.total - left.score.total ||
    (right.item.publishedAt ?? "").localeCompare(
      left.item.publishedAt ?? "",
    ) ||
    left.item.id.localeCompare(right.item.id)
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

function materialFactsFingerprint(item: Item): string | null {
  const value = item.metadata.materialFactsFingerprint;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function developmentKey(item: Item): string {
  const value = item.metadata.developmentKey;
  return typeof value === "string" && value.length > 0
    ? value
    : item.canonicalUrl;
}

function unchangedFromPreviousEdition(
  item: Item,
  previous: ReadonlyMap<string, string>,
): boolean {
  if (item.metadata.materialChange === true) return false;
  const priorFingerprint = previous.get(developmentKey(item));
  if (priorFingerprint === undefined) return false;
  const currentFingerprint = materialFactsFingerprint(item);
  return (
    currentFingerprint === null || currentFingerprint === priorFingerprint
  );
}

function diverseResearch(
  ranked: readonly RankedItem[],
  configuredTopics: readonly string[],
  maximum: number,
): RankedItem[] {
  if (maximum === 0) return [];
  const selected = new Map<string, RankedItem>();
  const representatives = configuredTopics.flatMap((topic) => {
    const representative = ranked.find(
      ({ item }) => item.primaryTopic === topic,
    );
    return representative === undefined ? [] : [representative];
  });
  for (const representative of representatives.sort(scoreOrder)) {
    if (selected.size >= maximum) break;
    selected.set(representative.item.id, representative);
  }
  for (const candidate of ranked) {
    if (selected.size >= maximum) break;
    selected.set(candidate.item.id, candidate);
  }
  return [...selected.values()].sort(scoreOrder);
}

type NewsSection =
  | "world"
  | "technology"
  | "ai_policy"
  | "dmv"
  | "baltimore"
  | "forecast";

const NEWS_SECTION_PRIORITY: readonly NewsSection[] = [
  "baltimore",
  "dmv",
  "ai_policy",
  "technology",
  "world",
  "forecast",
];

function sectionValues(item: Item): string[] {
  const values = [
    typeof item.metadata.section === "string"
      ? item.metadata.section
      : null,
    ...(Array.isArray(item.metadata.sectionEligibility)
      ? item.metadata.sectionEligibility
      : []),
    item.primaryTopic,
    ...item.tags,
  ];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));
}

function newsSection(item: Item): NewsSection {
  if (item.kind === "forecast") return "forecast";
  const values = new Set(sectionValues(item));
  return (
    NEWS_SECTION_PRIORITY.find((section) => values.has(section)) ?? "world"
  );
}

function uniqueRanked(values: readonly RankedItem[]): RankedItem[] {
  const items = new Map<string, RankedItem>();
  for (const value of [...values].sort(scoreOrder)) {
    if (!items.has(value.item.id)) items.set(value.item.id, value);
  }
  return [...items.values()];
}

export function shortlist(
  itemInput: readonly Item[],
  scoreInput: readonly (ItemScore | NewsScore)[],
  preferenceInput: ShortlistPreferences,
  budgetInput: SectionBudgets,
): Shortlist {
  const items = itemInput.map((item) => ItemSchema.parse(item));
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
  const ranked: RankedItem[] = [];

  for (const item of items) {
    const score = scores.get(item.id);
    if (score === undefined) {
      exclusions.push({ itemId: item.id, reason: "missing_score" });
      continue;
    }
    if (unchangedFromPreviousEdition(item, previous)) {
      exclusions.push({
        itemId: item.id,
        reason: "unchanged_from_previous_edition",
      });
      continue;
    }
    const threshold =
      item.kind === "paper" || item.kind === "blog"
        ? (preferences.minimumResearchScore ?? 0)
        : (preferences.minimumNewsScore ?? 0);
    if (score.total < threshold) {
      exclusions.push({
        itemId: item.id,
        reason: "below_quality_threshold",
      });
      continue;
    }
    ranked.push({ item, score });
  }
  ranked.sort(scoreOrder);

  const research = ranked.filter(
    ({ item, score }) =>
      (item.kind === "paper" || item.kind === "blog") &&
      !("publicImportance" in score),
  );
  const featuredCandidates = research.filter(
    ({ item }) => item.kind === "paper",
  );
  const featured = diverseResearch(
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

  const news = ranked.filter(
    ({ item, score }) =>
      item.kind !== "paper" &&
      item.kind !== "blog" &&
      "publicImportance" in score,
  );
  const bySection = new Map<NewsSection, RankedItem[]>();
  for (const candidate of news) {
    const section = newsSection(candidate.item);
    bySection.set(section, [...(bySection.get(section) ?? []), candidate]);
  }
  const limited = (
    section: NewsSection,
    maximum: number,
  ): RankedItem[] =>
    (bySection.get(section) ?? []).sort(scoreOrder).slice(0, maximum);
  const world = limited("world", budgets.world);
  const technology = limited("technology", budgets.technology);
  const aiPolicy = limited("ai_policy", budgets.aiPolicy);
  const local = [
    ...(bySection.get("dmv") ?? []),
    ...(bySection.get("baltimore") ?? []),
  ]
    .sort(scoreOrder)
    .slice(0, budgets.dmvAndBaltimore);
  const dmv = local.filter(
    ({ item }) => newsSection(item) === "dmv",
  );
  const baltimore = local.filter(
    ({ item }) => newsSection(item) === "baltimore",
  );
  const forecastSignals = limited(
    "forecast",
    budgets.forecastSignals,
  );
  const morningBrief = uniqueRanked([
    ...featured,
    ...world,
    ...technology,
    ...aiPolicy,
    ...local,
    ...forecastSignals,
  ]).slice(0, budgets.morningBrief);

  return {
    morningBrief: morningBrief.map(({ item }) => item),
    researchFeatured: featured.map(({ item }) => item),
    researchRadar: radar.map(({ item }) => item),
    world: world.map(({ item }) => item),
    technology: technology.map(({ item }) => item),
    aiPolicy: aiPolicy.map(({ item }) => item),
    dmv: dmv.map(({ item }) => item),
    baltimore: baltimore.map(({ item }) => item),
    forecastSignals: forecastSignals.map(({ item }) => item),
    exclusions: exclusions.sort((left, right) =>
      left.itemId.localeCompare(right.itemId),
    ),
  };
}
