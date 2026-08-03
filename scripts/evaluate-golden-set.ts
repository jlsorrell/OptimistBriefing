import { readFile } from "node:fs/promises";

import type { Item } from "../src/contracts/editorial";
import { READER_PROFILE } from "../src/config/reader-profile";
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
  consolidateResearchCandidates,
  type AttachedResearchCommentary,
} from "../src/editorial/research-identity";
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
  classifyDiscoveryWindow,
  RESEARCH_DISCOVERY_FAMILIES,
  triageResearch,
} from "../src/editorial/research-triage";
import { routePublication } from "../src/editorial/route-publication";
import {
  SourcePacketSchema,
  validateSummary,
} from "../src/editorial/validate-summary";
import { FakeModelProvider } from "../src/models/fake-provider";
import {
  DiscoveryObservationSchema,
  RawPublicationCandidateSchema,
} from "../src/sources/types";
import type { DiscoveryObservation } from "../src/sources/types";

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
  discoveryCases: ResearchCase[];
  publicationCases: PublicationCase[];
};

type PublicationCase = {
  caseId: string;
  raw: unknown;
  score?: Omit<ResearchScoreInput, "itemId">;
};

type NewsFixture = {
  cases: NewsCase[];
  duplicatePairs: [string, string][];
  requiredSeparateSections: Record<string, "dmv" | "baltimore">;
};

type RankingFixture = {
  version: number;
  evaluationNow: string;
  precisionAt: number;
  minimumPrecision: number;
  relevant: string[];
  requiredHighValue: string[];
  knownDistractors: string[];
  expectedResearchOrder: string[];
  expectedIdentityGroups: Array<{
    canonicalCaseId: string;
    memberCaseIds: string[];
    expectedPaperCount: number;
    attachedCommentaryCaseIds: string[];
    duplicateMutationCaseId: string;
  }>;
  expectedRoutes: Record<
    string,
    "research" | "technology" | "ai_policy" | "excluded"
  >;
  expectedTriageAdmissions: string[];
  expectedTriageExclusions: Record<string, string>;
  expectedQualityGateExclusions: Record<string, string>;
  expectedSelectionReasons: Record<string, string[]>;
  expectedDiscoveryWindows: Record<
    string,
    "fresh" | "reconsideration" | null
  >;
  expectedUnchangedDiscoveryWindows: Record<string, null>;
  priorDiscoveryObservations: Record<string, DiscoveryObservation[]>;
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
  researchTopics: READER_PROFILE.researchTopics.map(({ id }) => id),
  researchQualityGates: {
    ...READER_PROFILE.researchQualityGates,
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

function withTopicalFit(item: Item, topicalFit: number): Item {
  return {
    ...item,
    metadata: { ...item.metadata, topicalFit },
  };
}

function attachedCommentary(item: Item): AttachedResearchCommentary[] {
  if (!Array.isArray(item.metadata.attachedCommentary)) return [];
  return item.metadata.attachedCommentary.filter(
    (entry): entry is AttachedResearchCommentary =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as { sourceId?: unknown }).sourceId === "string",
  );
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

const publicationRoutes = researchFixture.publicationCases.map((candidate) => {
  const routed = routePublication(
    RawPublicationCandidateSchema.parse(candidate.raw),
  );
  const route = routed === null
    ? "excluded" as const
    : routed.kind === "paper" || routed.kind === "blog"
      ? "research" as const
      : routed.metadata.primarySection === "ai_policy"
        ? "ai_policy" as const
        : "technology" as const;
  return { ...candidate, route, routed };
});
const researchInputs = [
  ...researchFixture.cases,
  ...researchFixture.discoveryCases,
  ...publicationRoutes.flatMap((candidate): ResearchCase[] =>
    candidate.route === "research" &&
        candidate.routed !== null &&
        candidate.score !== undefined
      ? [{
          caseId: candidate.caseId,
          raw: candidate.routed,
          score: candidate.score,
        }]
      : []
  ),
];
const normalizedResearch = researchInputs.map((candidate) => ({
  caseId: candidate.caseId,
  item: withTopicalFit(
    normalizeCandidate(candidate.raw),
    candidate.score.topicalFit,
  ),
  scoreInput: candidate.score,
}));
const scoreInputByCase = new Map(
  normalizedResearch.map(({ caseId: id, scoreInput }) => [id, scoreInput]),
);
const caseBySource = new Map(
  normalizedResearch.flatMap(({ caseId: id, item }) =>
    item.sourceRefs.map((source) => [
      `${source.id}\u0000${source.url}`,
      id,
    ] as const)
  ),
);
const consolidated = consolidateResearchCandidates(
  normalizedResearch.map(({ item }) => item),
);
const research = [
  ...consolidated.papers,
  ...consolidated.standaloneCommentary,
].map((item) => {
  const id = caseId(item);
  const scoreInput = scoreInputByCase.get(id);
  if (scoreInput === undefined) {
    throw new TypeError(`No research score signal for ${id}.`);
  }
  return { caseId: id, item, scoreInput };
});
const triage = triageResearch(research.map(({ item }) => item), {
  maximum: 24,
  maximumPerFamily: 12,
  maximumPerPublisherDomain: 6,
  configuredTopics: preferences.researchTopics,
  now: rankingFixture.evaluationNow,
  minimumTopicalFit:
    READER_PROFILE.researchQualityGates.minimumTopicalFit,
});
const triagedIds = new Set(triage.items.map(caseId));
const triagedResearch = research.filter(({ caseId: id }) =>
  triagedIds.has(id)
);
const researchScores = triagedResearch.map(({ item, scoreInput }) =>
  scoreResearch({ itemId: item.id, ...scoreInput, candidate: item }),
);
const researchItemById = new Map(
  triagedResearch.map(({ item }) => [item.id, item]),
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
  [...triagedResearch.map(({ item }) => item), ...developments],
  [...researchScores, ...newsScores],
  preferences,
  budgets,
);
const scoreByCase = new Map(
  researchScores.map((score) => {
    const item = researchItemById.get(score.itemId);
    if (item === undefined) {
      throw new TypeError(`No golden research item for score ${score.itemId}.`);
    }
    return [caseId(item), score] as const;
  }),
);
const productionResearchOrder = [...scoreByCase.entries()]
  .filter(([, score]) =>
    score.topicalFit >= preferences.researchQualityGates.minimumTopicalFit &&
    score.technicalQuality >=
      preferences.researchQualityGates.minimumTechnicalQuality
  )
  .sort(([leftId, left], [rightId, right]) =>
    right.total - left.total || leftId.localeCompare(rightId)
  )
  .map(([id]) => id);
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
  Math.max(...highValuePositions) < Math.min(...distractorPositions);

const researchOrderPassed = rankingFixture.expectedResearchOrder.every(
  (id, index) => productionResearchOrder[index] === id,
);
const discoveryFamilies = new Set(
  normalizedResearch.flatMap(({ item }) =>
    typeof item.metadata.discoveryFamily === "string"
      ? [item.metadata.discoveryFamily]
      : []
  ),
);
const discoveryFamiliesPassed = RESEARCH_DISCOVERY_FAMILIES.every((family) =>
  discoveryFamilies.has(family)
);
const routingPassed = publicationRoutes.every(({ caseId: id, route }) =>
  rankingFixture.expectedRoutes[id] === route
);
const identityMemberIds = (paper: Item): ReadonlySet<string> =>
  new Set(
    paper.sourceRefs.flatMap((source) =>
      caseBySource.get(`${source.id}\u0000${source.url}`) ?? []
    ),
  );
const identityGroupPassed = (
  papers: readonly Item[],
  expectation: RankingFixture["expectedIdentityGroups"][number],
): boolean => {
  const matches = papers.filter((paper) => {
    const memberIds = identityMemberIds(paper);
    return expectation.memberCaseIds.some((id) => memberIds.has(id));
  });
  if (matches.length !== expectation.expectedPaperCount) return false;
  return matches.every((paper) => {
    const memberIds = identityMemberIds(paper);
    if (
      caseId(paper) !== expectation.canonicalCaseId ||
      !expectation.memberCaseIds.every((id) => memberIds.has(id))
    ) {
      return false;
    }
    const commentaryIds = new Set(
      attachedCommentary(paper).flatMap(({ sourceId }) =>
        paper.sourceRefs.flatMap((source) =>
          source.id === sourceId
            ? caseBySource.get(`${source.id}\u0000${source.url}`) ?? []
            : []
        )
      ),
    );
    return expectation.attachedCommentaryCaseIds.every((id) =>
      commentaryIds.has(id)
    );
  });
};
const identityPassed = rankingFixture.expectedIdentityGroups.every(
  (expectation) => identityGroupPassed(consolidated.papers, expectation),
);
const identityDuplicateMutationPassed =
  rankingFixture.expectedIdentityGroups.every((expectation) => {
    const duplicate = normalizedResearch.find(({ caseId: id }) =>
      id === expectation.duplicateMutationCaseId
    )?.item;
    if (duplicate === undefined) return false;
    return !identityGroupPassed(
      [...consolidated.papers, duplicate],
      expectation,
    );
  });
const identityCaseGroups = rankingFixture.expectedIdentityGroups.map(
  ({ canonicalCaseId }) => {
    const paper = consolidated.papers.find((candidate) =>
      caseId(candidate) === canonicalCaseId
    );
    return {
      paper: canonicalCaseId,
      members: paper?.sourceRefs.flatMap((source) =>
        caseBySource.get(`${source.id}\u0000${source.url}`) ?? []
      ) ?? [],
      commentary: paper === undefined
        ? []
        : attachedCommentary(paper).flatMap(({ sourceId }) =>
            paper.sourceRefs.flatMap((source) =>
              source.id === sourceId
                ? caseBySource.get(`${source.id}\u0000${source.url}`) ?? []
                : []
            )
          ),
    };
  },
);
const triageExclusions = new Map(
  triage.exclusions.map(({ itemId, reason }) => {
    const item = research.find(({ item }) => item.id === itemId)?.item;
    if (item === undefined) {
      throw new TypeError(`No golden item for triage exclusion ${itemId}.`);
    }
    return [caseId(item), reason] as const;
  }),
);
const triagePassed =
  rankingFixture.expectedTriageAdmissions.every((id) => triagedIds.has(id)) &&
  Object.entries(rankingFixture.expectedTriageExclusions).every(
    ([id, reason]) => triageExclusions.get(id) === reason,
  );
const shortlistExclusions = new Map(
  selected.exclusions.flatMap(({ itemId, reason }) => {
    const item = researchItemById.get(itemId);
    return item === undefined ? [] : [[caseId(item), reason] as const];
  }),
);
const qualityGatesPassed = Object.entries(
  rankingFixture.expectedQualityGateExclusions,
).every(([id, reason]) => shortlistExclusions.get(id) === reason);
const selectionReasonsPassed = Object.entries(
  rankingFixture.expectedSelectionReasons,
).every(([id, reasons]) => {
  const score = scoreByCase.get(id);
  return score !== undefined && reasons.every((reason) =>
    score.selectionReasons.includes(reason)
  );
});
const discoveryWindowsPassed = Object.entries(
  rankingFixture.expectedDiscoveryWindows,
).every(([id, expected]) => {
  const item = research.find(({ caseId: candidateId }) =>
    candidateId === id
  )?.item;
  const prior = (rankingFixture.priorDiscoveryObservations[id] ?? []).map(
    (observation) => DiscoveryObservationSchema.parse(observation),
  );
  return item !== undefined &&
    classifyDiscoveryWindow(item, prior, rankingFixture.evaluationNow) === expected;
});
const unchangedDiscoveryWindowsPassed = Object.entries(
  rankingFixture.expectedUnchangedDiscoveryWindows,
).every(([id, expected]) => {
  const item = research.find(({ caseId: candidateId }) =>
    candidateId === id
  )?.item;
  const prior = rankingFixture.priorDiscoveryObservations[id]?.[0];
  if (item === undefined || prior === undefined) return false;
  const unchanged = {
    ...item,
    metadata: {
      ...item.metadata,
      evidenceFingerprint: prior.evidenceFingerprint,
      implementationAvailable: false,
    },
  };
  return classifyDiscoveryWindow(
    unchanged,
    [DiscoveryObservationSchema.parse(prior)],
    rankingFixture.evaluationNow,
  ) === expected;
});

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
for (const id of rankingFixture.expectedResearchOrder) {
  const score = scoreByCase.get(id);
  printMetric(
    `research score ${id}`,
    score === undefined
      ? "missing"
      : [
          `topicalFit=${score.topicalFit.toFixed(2)}`,
          `technicalQuality=${score.technicalQuality.toFixed(2)}`,
          `researchSignal=${score.researchSignal.toFixed(2)}`,
          `novelty=${score.novelty.toFixed(2)}`,
          `seriousAttention=${score.seriousAttention.toFixed(2)}`,
          `total=${score.total.toFixed(4)}`,
        ].join(" "),
    score !== undefined,
  );
}
printMetric(
  "expected research ordering",
  researchOrderPassed ? "matched" : "mismatched",
  researchOrderPassed,
);
printMetric(
  "all discovery families represented",
  RESEARCH_DISCOVERY_FAMILIES.join(","),
  discoveryFamiliesPassed,
);
printMetric(
  "cross-source research identity joins",
  identityCaseGroups.map(({ paper, members, commentary }) =>
    `${paper}=[${members.join("+")}];commentary=[${commentary.join("+")}]`
  ).join(","),
  identityPassed,
);
printMetric(
  "extra cross-source duplicate rejected",
  identityDuplicateMutationPassed ? "yes" : "no",
  identityDuplicateMutationPassed,
);
printMetric(
  "official publication routes",
  publicationRoutes.map(({ caseId: id, route }) => `${id}=${route}`).join(","),
  routingPassed,
);
printMetric(
  "research triage expectations",
  triagePassed ? "matched" : "mismatched",
  triagePassed,
);
printMetric(
  "research quality-gate exclusions",
  qualityGatesPassed ? "matched" : "mismatched",
  qualityGatesPassed,
);
printMetric(
  "research selection reasons",
  selectionReasonsPassed ? "matched" : "mismatched",
  selectionReasonsPassed,
);
printMetric(
  "discovery windows",
  discoveryWindowsPassed ? "matched" : "mismatched",
  discoveryWindowsPassed,
);
printMetric(
  "unchanged old evidence remains excluded",
  unchangedDiscoveryWindowsPassed ? "yes" : "no",
  unchangedDiscoveryWindowsPassed,
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
  !researchOrderPassed ||
  !discoveryFamiliesPassed ||
  !identityPassed ||
  !identityDuplicateMutationPassed ||
  !routingPassed ||
  !triagePassed ||
  !qualityGatesPassed ||
  !selectionReasonsPassed ||
  !discoveryWindowsPassed ||
  !unchangedDiscoveryWindowsPassed ||
  !duplicateRecallPassed ||
  !missingSourcesPassed ||
  !groundingExpectationsPassed ||
  !localSectionsPassed
) {
  process.exitCode = 1;
}
