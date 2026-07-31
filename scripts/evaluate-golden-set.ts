import { readFile } from "node:fs/promises";

import type { Item } from "../src/contracts/editorial";
import {
  clusterNews,
  type NewsDevelopment,
} from "../src/editorial/cluster";
import {
  scoreNewsDevelopment,
  type NewsDevelopmentScoreInput,
  type NewsScore,
} from "../src/editorial/news-score";
import { normalizeCandidate } from "../src/editorial/normalize";
import {
  scoreResearch,
  type ResearchScoreInput,
} from "../src/editorial/research-score";
import {
  shortlist,
  type SectionBudgets,
  type ShortlistPreferences,
} from "../src/editorial/shortlist";
import {
  SourcePacketSchema,
  validateSummary,
} from "../src/editorial/validate-summary";
import { FakeModelProvider } from "../src/models/fake-provider";

type ResearchCase = {
  caseId: string;
  raw: unknown;
  score: Omit<ResearchScoreInput, "itemId">;
};

type NewsCase = {
  caseId: string;
  embedding: number[];
  raw: unknown;
  score: NewsDevelopmentScoreInput;
};

type ResearchFixture = {
  cases: ResearchCase[];
};

type NewsFixture = {
  cases: NewsCase[];
  duplicatePairs: [string, string][];
  requiredSeparateSections: Record<string, "dmv" | "baltimore">;
};

type RankingFixture = {
  precisionAt: number;
  minimumPrecision: number;
  relevant: string[];
  requiredHighValue: string[];
  knownDistractors: string[];
};

type GroundingCase = {
  caseId: string;
  shouldAccept: boolean;
  packet: unknown;
  summary: unknown;
};

type GroundingFixture = {
  cases: GroundingCase[];
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

const preferences: ShortlistPreferences = {
  researchTopics: [
    "alignment-interpretability",
    "oversight-governance",
    "secure-computation-ml",
  ],
  researchQualityGates: {
    minimumTopicalFit: 0,
    minimumTechnicalQuality: 0,
  },
};

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(`../tests/golden/${name}`, import.meta.url), "utf8"),
  ) as T;
}

function caseId(item: Item): string {
  const value = item.metadata.caseId;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Golden item ${item.id} has no caseId.`);
  }
  return value;
}

function developmentSignal(
  development: NewsDevelopment,
  signals: ReadonlyMap<string, NewsDevelopmentScoreInput>,
): NewsDevelopmentScoreInput {
  const inputs = development.items.map((item) => {
    const value = signals.get(caseId(item));
    if (value === undefined) {
      throw new TypeError(`No news score signal for ${caseId(item)}.`);
    }
    return value;
  });
  const maximum = (key: keyof NewsDevelopmentScoreInput): number =>
    Math.max(...inputs.map((input) => input[key]));
  return {
    publicImportance: maximum("publicImportance"),
    personalRelevance: maximum("personalRelevance"),
    sourceQuality: maximum("sourceQuality"),
    recency: maximum("recency"),
    geography: maximum("geography"),
    novelty: maximum("novelty"),
  };
}

function acceptedMissingSourceIds(
  summary: unknown,
  sourceIds: ReadonlySet<string>,
): number {
  if (summary === null || typeof summary !== "object") return 0;
  const claims = (summary as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return 0;
  return claims.reduce((missing, claim) => {
    if (claim === null || typeof claim !== "object") return missing;
    const ids = (claim as { sourceIds?: unknown }).sourceIds;
    if (!Array.isArray(ids)) return missing;
    return (
      missing +
      ids.filter(
        (sourceId) =>
          typeof sourceId !== "string" || !sourceIds.has(sourceId),
      ).length
    );
  }, 0);
}

function printMetric(
  label: string,
  value: string,
  passed: boolean,
): void {
  process.stdout.write(`${label}: ${value} ${passed ? "PASS" : "FAIL"}\n`);
}

const [researchFixture, newsFixture, rankingFixture, groundingFixture] =
  await Promise.all([
    fixture<ResearchFixture>("research-candidates.json"),
    fixture<NewsFixture>("news-clusters.json"),
    fixture<RankingFixture>("expected-rankings.json"),
    fixture<GroundingFixture>("expected-grounding.json"),
  ]);

const research = researchFixture.cases.map((candidate) => ({
  caseId: candidate.caseId,
  item: normalizeCandidate(candidate.raw),
  scoreInput: candidate.score,
}));
const researchScores = research.map(({ item, scoreInput }) =>
  scoreResearch({ itemId: item.id, ...scoreInput }),
);

const news = newsFixture.cases.map((candidate) => ({
  caseId: candidate.caseId,
  embedding: candidate.embedding,
  item: normalizeCandidate(candidate.raw),
  scoreInput: candidate.score,
}));
const newsSignals = new Map(
  news.map(({ caseId: id, scoreInput }) => [id, scoreInput]),
);
const provider = new FakeModelProvider({
  embeddingBatches: [news.map(({ embedding }) => embedding)],
  generatedObjects: groundingFixture.cases.map(({ summary }) => summary),
});
const newsEmbeddings = await provider.embed(
  news.map(({ item }) => item.normalizedText),
);
const developments = clusterNews(
  news.map(({ item }) => item),
  new Map(
    news.map(({ item }, index) => [
      item.id,
      newsEmbeddings[index] ?? [],
    ]),
  ),
);
const newsScores: NewsScore[] = developments.map((development) =>
  scoreNewsDevelopment(
    development,
    developmentSignal(development, newsSignals),
  ),
);

const selected = shortlist(
  [...research.map(({ item }) => item), ...developments],
  [...researchScores, ...newsScores],
  preferences,
  budgets,
);
const productionResearchOrder = [
  ...selected.researchFeatured,
  ...selected.researchRadar,
].map(caseId);
const precisionWindow = productionResearchOrder.slice(
  0,
  rankingFixture.precisionAt,
);
const relevant = new Set(rankingFixture.relevant);
const precision =
  precisionWindow.filter((id) => relevant.has(id)).length /
  rankingFixture.precisionAt;
const precisionPassed =
  precisionWindow.length === rankingFixture.precisionAt &&
  precision >= rankingFixture.minimumPrecision;

const positions = new Map(
  productionResearchOrder.map((id, index) => [id, index]),
);
const highValuePositions = rankingFixture.requiredHighValue.map(
  (id) => positions.get(id) ?? Number.POSITIVE_INFINITY,
);
const distractorPositions = rankingFixture.knownDistractors.map(
  (id) => positions.get(id) ?? Number.POSITIVE_INFINITY,
);
const highValueAboveDistractors =
  highValuePositions.every(Number.isFinite) &&
  distractorPositions.every(Number.isFinite) &&
  Math.max(...highValuePositions) < Math.min(...distractorPositions);

const clusterByCase = new Map<string, string>();
for (const development of developments) {
  for (const item of development.items) {
    clusterByCase.set(caseId(item), development.id);
  }
}
const duplicateMatches = newsFixture.duplicatePairs.filter(
  ([left, right]) =>
    clusterByCase.get(left) !== undefined &&
    clusterByCase.get(left) === clusterByCase.get(right),
).length;
const duplicateRecall =
  newsFixture.duplicatePairs.length === 0
    ? 1
    : duplicateMatches / newsFixture.duplicatePairs.length;
const duplicateRecallPassed = duplicateRecall === 1;

const selectedLocalSections = new Map<string, "dmv" | "baltimore">([
  ...selected.dmv.flatMap((development) =>
    development.items.map(
      (item) => [caseId(item), "dmv"] as const,
    ),
  ),
  ...selected.baltimore.flatMap((development) =>
    development.items.map(
      (item) => [caseId(item), "baltimore"] as const,
    ),
  ),
]);
const localSectionsPassed = Object.entries(
  newsFixture.requiredSeparateSections,
).every(([id, section]) => selectedLocalSections.get(id) === section);

let acceptedClaimsMissingSourceIds = 0;
let groundingExpectationsPassed = true;
for (const groundingCase of groundingFixture.cases) {
  const packet = SourcePacketSchema.parse(groundingCase.packet);
  const generated = await provider.generateObject({
    model: "fake-golden-model",
    schemaName: "golden_grounding",
    jsonSchema: {},
    system: "Return the queued deterministic golden summary.",
    sourcePacket: groundingCase.caseId,
    maxOutputTokens: 1_000,
  });
  const result = validateSummary(generated, packet);
  const accepted = result.ok;
  groundingExpectationsPassed &&= accepted === groundingCase.shouldAccept;
  if (accepted) {
    acceptedClaimsMissingSourceIds += acceptedMissingSourceIds(
      generated,
      new Set(packet.sources.map(({ sourceId }) => sourceId)),
    );
  }
}
const missingSourcesPassed = acceptedClaimsMissingSourceIds === 0;

printMetric(
  `precision@${rankingFixture.precisionAt}`,
  `${precision.toFixed(2)} (minimum ${rankingFixture.minimumPrecision.toFixed(2)})`,
  precisionPassed,
);
printMetric(
  "required high-value items above known distractors",
  highValueAboveDistractors ? "yes" : "no",
  highValueAboveDistractors,
);
printMetric(
  "duplicate-cluster recall",
  `${duplicateRecall.toFixed(2)} (minimum 1.00)`,
  duplicateRecallPassed,
);
printMetric(
  "accepted claims with missing supporting source IDs",
  `${acceptedClaimsMissingSourceIds} (required 0)`,
  missingSourcesPassed,
);
printMetric(
  "grounding acceptance expectations",
  groundingExpectationsPassed ? "matched" : "mismatched",
  groundingExpectationsPassed,
);
printMetric(
  "DMV and Baltimore remain separate",
  localSectionsPassed ? "yes" : "no",
  localSectionsPassed,
);

if (
  !precisionPassed ||
  !highValueAboveDistractors ||
  !duplicateRecallPassed ||
  !missingSourcesPassed ||
  !groundingExpectationsPassed ||
  !localSectionsPassed
) {
  process.exitCode = 1;
}
