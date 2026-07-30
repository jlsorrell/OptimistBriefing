import { describe, expect, it } from "vitest";

import { clusterNews } from "../../../src/editorial/cluster";
import { deduplicateItems } from "../../../src/editorial/deduplicate";
import {
  scoreNewsDevelopment,
} from "../../../src/editorial/news-score";
import { normalizeCandidate } from "../../../src/editorial/normalize";
import { deriveNewsSignals } from "../../../src/sources/news-signals";
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
    primaryDocumentUrls: [],
    eventFamilies: [],
    materialFacts: [],
    metadata: { primarySection: "ai_policy" },
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

  it("keeps ordinary paraphrases and added reporting on one repeat identity", () => {
    const originalItem = normalizeCandidate(
      rawNews("reuters", {
        title:
          "Evaluation Agency approves AI evaluation standard for 100 models",
        primaryDocumentUrl: null,
        namedEntities: ["Evaluation Agency"],
        abstract:
          "The standard was approved and covers 100 evaluated models.",
      }),
    );
    const paraphrasedItem = normalizeCandidate(
      rawNews("ap", {
        title:
          "100-model safety standard adopted by Evaluation Agency",
        primaryDocumentUrl: null,
        namedEntities: ["Evaluation Agency"],
        abstract:
          "The Evaluation Agency adopted the standard for 100 models.",
      }),
    );
    const corroboratingItem = normalizeCandidate(
      rawNews("npr", {
        title:
          "Evaluation Agency adopts safety standard covering 100 AI models",
        primaryDocumentUrl: null,
        namedEntities: ["Evaluation Agency"],
        abstract:
          "A safety standard covering 100 AI models was approved.",
      }),
    );
    const original = clusterNews([originalItem], {})[0];
    const paraphrased = clusterNews([paraphrasedItem], {})[0];
    const withAddedSource = clusterNews(
      [paraphrasedItem, corroboratingItem],
      {
        [paraphrasedItem.id]: [1, 0],
        [corroboratingItem.id]: [0.99, 0.01],
      },
    )[0];
    expect(original).toBeDefined();
    expect(paraphrased).toBeDefined();
    expect(withAddedSource).toBeDefined();
    if (
      original === undefined ||
      paraphrased === undefined ||
      withAddedSource === undefined
    ) {
      return;
    }

    expect(paraphrased.developmentKey).toBe(original.developmentKey);
    expect(paraphrased.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );
    expect(withAddedSource.developmentKey).toBe(original.developmentKey);
    expect(withAddedSource.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );

    const score = scoreNewsDevelopment(withAddedSource, {
      publicImportance: 0.8,
      personalRelevance: 0.8,
      sourceQuality: 0.8,
      recency: 0.8,
      geography: 0.2,
      novelty: 0.8,
    });

    const repeated = shortlist(
      [withAddedSource],
      [score],
      {
        ...preferences,
        previousEditionDevelopments: [
          {
            developmentKey: original.developmentKey,
            materialFactsFingerprint:
              original.materialFactsFingerprint,
          },
        ],
      },
      budgets,
    );

    expect(repeated.aiPolicy).toEqual([]);
    expect(repeated.exclusions).toContainEqual({
      itemId: withAddedSource.id,
      reason: "unchanged_from_previous_edition",
    });
  });

  it("keeps identity when a no-family paraphrase changes the representative or input order", () => {
    const originalItem = normalizeCandidate(
      rawNews("reuters", {
        title:
          "Evaluation Agency approves AI evaluation standard for 100 models",
        primaryDocumentUrl: null,
        accessLevel: "metadata",
        abstract:
          "The Evaluation Agency adopted an evaluation standard covering 100 models.",
      }),
    );
    const paraphrasedRepresentative = normalizeCandidate(
      rawNews("agency", {
        title: "Evaluation Agency provides its morning update",
        primaryDocumentUrl: null,
        abstract:
          "Its evaluation standard was adopted and covers 100 models.",
      }),
    );
    const original = clusterNews([originalItem], {})[0];
    const forward = clusterNews(
      [originalItem, paraphrasedRepresentative],
      {
        [originalItem.id]: [1, 0],
        [paraphrasedRepresentative.id]: [0.99, 0.01],
      },
    )[0];
    const reverse = clusterNews(
      [paraphrasedRepresentative, originalItem],
      {
        [originalItem.id]: [1, 0],
        [paraphrasedRepresentative.id]: [0.99, 0.01],
      },
    )[0];
    const paraphrased = clusterNews(
      [paraphrasedRepresentative],
      {},
    )[0];
    expect(original).toBeDefined();
    expect(forward).toBeDefined();
    expect(reverse).toBeDefined();
    expect(paraphrased).toBeDefined();
    if (
      original === undefined ||
      forward === undefined ||
      reverse === undefined ||
      paraphrased === undefined
    ) {
      return;
    }

    expect(forward.representativeItem.sourceRefs[0]?.id).toBe("agency");
    expect(forward.title).not.toBe(original.title);
    expect(paraphrased.developmentKey).toBe(original.developmentKey);
    expect(paraphrased.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );
    expect(forward.developmentKey).toBe(original.developmentKey);
    expect(forward.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );
    expect(reverse.developmentKey).toBe(forward.developmentKey);
    expect(reverse.materialFactsFingerprint).toBe(
      forward.materialFactsFingerprint,
    );
  });

  it("ignores incidental source dates and numbers in material fingerprints", () => {
    const originalItem = normalizeCandidate(
      rawNews("reuters", {
        title:
          "Evaluation Agency approves AI evaluation standard for 100 models",
        primaryDocumentUrl: null,
        abstract:
          "The adopted standard covers 100 models.",
      }),
    );
    const incidentalItem = normalizeCandidate(
      rawNews("npr", {
        title:
          "Evaluation Agency offers July 29 briefing on 3 earlier reports",
        primaryDocumentUrl: null,
        abstract:
          "The evaluation standard was adopted for 100 models. It cites an earlier benchmark covering 50 models.",
      }),
    );
    const original = clusterNews([originalItem], {})[0];
    const expanded = clusterNews(
      [originalItem, incidentalItem],
      {
        [originalItem.id]: [1, 0],
        [incidentalItem.id]: [0.99, 0.01],
      },
    )[0];
    expect(original).toBeDefined();
    expect(expanded).toBeDefined();
    if (original === undefined || expanded === undefined) return;

    expect(expanded.developmentKey).toBe(original.developmentKey);
    expect(expanded.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );
    expect(expanded.materialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "29" }),
        expect.objectContaining({ value: "3" }),
        expect.objectContaining({ value: "50" }),
      ]),
    );
  });

  it("keeps fallback identity stable when added sources introduce section and family variants", () => {
    const originalItem = normalizeCandidate(
      rawNews("reuters", {
        title: "Evaluation Agency issues a governance rule",
        primaryDocumentUrl: null,
        sectionEligibility: ["world"],
        metadata: { primarySection: "world" },
      }),
    );
    const variantItem = normalizeCandidate(
      rawNews("analysis", {
        title: "Evaluation Agency evaluation standard update",
        primaryDocumentUrl: null,
        sectionEligibility: ["ai_policy"],
        metadata: { primarySection: "ai_policy" },
      }),
    );
    const original = clusterNews([originalItem], {})[0];
    const expanded = clusterNews(
      [originalItem, variantItem],
      {
        [originalItem.id]: [1, 0],
        [variantItem.id]: [0.99, 0.01],
      },
    )[0];
    expect(original).toBeDefined();
    expect(expanded).toBeDefined();
    if (original === undefined || expanded === undefined) return;

    expect(expanded.developmentKey).toBe(original.developmentKey);
  });

  it("uses structured generic semantics rather than the reporting URL", () => {
    const first = normalizeCandidate(
      rawNews("first-generic", {
        title: "AI product release",
        abstract: "AI product release",
        namedEntities: ["AI"],
        primaryDocumentUrl: null,
        publishedAt: "2026-07-29T11:00:00.000Z",
        sectionEligibility: ["technology"],
        metadata: { primarySection: "technology" },
      }),
    );
    const paraphrase = normalizeCandidate(
      rawNews("second-generic", {
        title: "AI product launches",
        abstract: "AI product launches",
        namedEntities: ["AI"],
        primaryDocumentUrl: null,
        sectionEligibility: ["technology"],
        metadata: { primarySection: "technology" },
      }),
    );
    const firstDevelopment = clusterNews([first], {})[0];
    const secondDevelopment = clusterNews([paraphrase], {})[0];
    expect(firstDevelopment).toBeDefined();
    expect(secondDevelopment).toBeDefined();
    if (
      firstDevelopment === undefined ||
      secondDevelopment === undefined
    ) {
      return;
    }

    expect(secondDevelopment.developmentKey).toBe(
      firstDevelopment.developmentKey,
    );
    expect(firstDevelopment.repeatable).toBe(false);
    expect(secondDevelopment.repeatable).toBe(false);

    const score = scoreNewsDevelopment(firstDevelopment, {
      publicImportance: 0.8,
      personalRelevance: 0.8,
      sourceQuality: 0.8,
      recency: 0.8,
      geography: 0.2,
      novelty: 0.8,
    });
    const result = shortlist(
      [firstDevelopment],
      [score],
      {
        ...preferences,
        previousEditionDevelopments: [
          {
            developmentKey: firstDevelopment.developmentKey,
            materialFactsFingerprint:
              firstDevelopment.materialFactsFingerprint,
          },
        ],
      },
      budgets,
    );
    expect(result.technology.map(({ id }) => id)).toEqual([
      firstDevelopment.id,
    ]);
  });

  it("keeps distinct event semantics separate for the same subject", () => {
    const development = (sourceId: string, title: string) =>
      clusterNews(
        [
          normalizeCandidate(
            rawNews(sourceId, {
              title,
              primaryDocumentUrl: null,
              namedEntities: ["Evaluation Agency"],
              abstract: title,
            }),
          ),
        ],
        {},
      )[0];
    const governance = development(
      "governance-event",
      "Evaluation Agency adopts an evaluation standard",
    );
    const funding = development(
      "funding-event",
      "Evaluation Agency approves a new funding budget",
    );
    const product = development(
      "product-event",
      "Evaluation Agency launches a software product",
    );
    expect(governance).toBeDefined();
    expect(funding).toBeDefined();
    expect(product).toBeDefined();
    if (
      governance === undefined ||
      funding === undefined ||
      product === undefined
    ) {
      return;
    }

    expect(funding.developmentKey).not.toBe(
      governance.developmentKey,
    );
    expect(product.developmentKey).not.toBe(
      governance.developmentKey,
    );
    expect(product.developmentKey).not.toBe(funding.developmentKey);
  });

  it("retains independent contextual facts when only one is re-corroborated", () => {
    const baselineItem = normalizeCandidate(
      rawNews("baseline-facts", {
        title: "Evaluation Agency adopts evaluation standard",
        primaryDocumentUrl: null,
        abstract:
          "The standard covers 100 models across 10 states.",
      }),
    );
    const partialItem = normalizeCandidate(
      rawNews("partial-facts", {
        title: "Evaluation Agency confirms evaluation standard",
        primaryDocumentUrl: null,
        abstract: "The standard covers 100 models.",
      }),
    );
    const baseline = clusterNews([baselineItem], {})[0];
    const expanded = clusterNews(
      [baselineItem, partialItem],
      {
        [baselineItem.id]: [1, 0],
        [partialItem.id]: [0.99, 0.01],
      },
    )[0];
    expect(baseline).toBeDefined();
    expect(expanded).toBeDefined();
    if (baseline === undefined || expanded === undefined) return;

    expect(expanded.materialFactsFingerprint).toBe(
      baseline.materialFactsFingerprint,
    );
    expect(expanded.materialFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "100" }),
        expect.objectContaining({ value: "10" }),
      ]),
    );
  });

  it("filters incidental fact contexts for document-anchored generic developments", () => {
    const official = normalizeCandidate(
      rawNews("official-document", {
        kind: "document",
        sourceRole: "primary",
        title:
          "Evaluation Agency AI evaluation standard adopted for 100 models",
        originalUrl: "https://agency.gov/ai-standard",
        primaryDocumentUrl: "https://agency.gov/ai-standard",
        namedEntities: ["AI", "Evaluation Agency"],
        abstract:
          "The Evaluation Agency standard covers 100 models.",
      }),
    );
    const reporting = normalizeCandidate(
      rawNews("document-reporting", {
        title: "Coverage of the agency update",
        primaryDocumentUrl: "https://agency.gov/ai-standard",
        namedEntities: ["AI", "Evaluation Agency"],
        abstract:
          "The Evaluation Agency AI evaluation standard remains adopted for 100 models. It cites an earlier evaluation benchmark covering 50 models.",
      }),
    );
    const materiallyChanged = normalizeCandidate(
      rawNews("changed-document", {
        kind: "document",
        sourceRole: "primary",
        title:
          "Evaluation Agency AI evaluation standard adopted for 200 models",
        originalUrl: "https://agency.gov/ai-standard",
        primaryDocumentUrl: "https://agency.gov/ai-standard",
        namedEntities: ["AI", "Evaluation Agency"],
        abstract:
          "The Evaluation Agency adopted standard covers 200 models.",
      }),
    );
    const original = clusterNews([official], {})[0];
    const expanded = clusterNews([official, reporting], {})[0];
    const changed = clusterNews([materiallyChanged], {})[0];
    expect(original).toBeDefined();
    expect(expanded).toBeDefined();
    expect(changed).toBeDefined();
    if (
      original === undefined ||
      expanded === undefined ||
      changed === undefined
    ) {
      return;
    }

    expect(original.repeatable).toBe(true);
    expect(expanded.developmentKey).toBe(original.developmentKey);
    expect(expanded.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );
    expect(expanded.materialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "50" }),
      ]),
    );
    expect(changed.developmentKey).toBe(original.developmentKey);
    expect(changed.materialFactsFingerprint).not.toBe(
      original.materialFactsFingerprint,
    );
  });

  it("lets a later terminal status in extracted content supersede a proposal mention", () => {
    const item = normalizeCandidate(
      rawNews("status-progression", {
        title:
          "Evaluation Agency proposes an AI evaluation standard",
        primaryDocumentUrl: null,
        abstract: "The proposal covered 100 models.",
        content:
          "The Evaluation Agency later adopted the standard for 100 models.",
      }),
    );
    const development = clusterNews([item], {})[0];

    expect(development?.materialFacts).toContainEqual({
      kind: "status",
      key: "event-status",
      value: "adopted",
    });
    expect(development?.materialFacts).not.toContainEqual({
      kind: "status",
      key: "event-status",
      value: "proposed",
    });
  });

  it("canonicalizes equivalent contextual counts and dates", () => {
    const development = (
      sourceId: string,
      content: string,
    ) =>
      clusterNews(
        [
          normalizeCandidate(
            rawNews(sourceId, {
              title:
                "Evaluation Agency evaluation standard update",
              primaryDocumentUrl: null,
              abstract: null,
              content,
            }),
          ),
        ],
        {},
      )[0];
    const prose = development(
      "prose-values",
      "The standard was adopted for 100.0 models and becomes effective July 29, 2026.",
    );
    const machine = development(
      "machine-values",
      "The standard was adopted for 100 models and becomes effective 2026-07-29.",
    );
    expect(prose).toBeDefined();
    expect(machine).toBeDefined();
    if (prose === undefined || machine === undefined) return;

    expect(machine.developmentKey).toBe(prose.developmentKey);
    expect(machine.materialFactsFingerprint).toBe(
      prose.materialFactsFingerprint,
    );
  });

  it("excludes non-corroborating facts from authoritative reconciliation", () => {
    const reporting = normalizeCandidate(
      rawNews("reporting", {
        title:
          "Evaluation Agency adopts evaluation standard for 100 models",
        primaryDocumentUrl: null,
        abstract: "The standard was adopted for 100 models.",
      }),
    );
    const discovery = normalizeCandidate(
      rawNews("discovery", {
        sourceRole: "primary",
        canCorroborateFacts: false,
        title: "Evaluation Agency funding budget background",
        primaryDocumentUrl: null,
        abstract: "Background details from discovery metadata.",
        materialFacts: [
          {
            kind: "status",
            key: "event-status",
            value: "proposed",
          },
          {
            kind: "number",
            key: "count:governance-instrument:models",
            value: "200",
          },
        ],
      }),
    );
    const original = clusterNews([reporting], {})[0];
    const expanded = clusterNews(
      [reporting, discovery],
      {
        [reporting.id]: [1, 0],
        [discovery.id]: [0.99, 0.01],
      },
    )[0];
    expect(original).toBeDefined();
    expect(expanded).toBeDefined();
    if (original === undefined || expanded === undefined) return;

    expect(expanded.developmentKey).toBe(original.developmentKey);
    expect(expanded.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );
  });

  it("detects status and contextual numeric changes found only in source content", () => {
    const development = (
      sourceId: string,
      abstract: string,
      content: string | null = null,
    ) =>
      clusterNews(
        [
          normalizeCandidate(
            rawNews(sourceId, {
              title: "Evaluation Agency evaluation standard update",
              primaryDocumentUrl: null,
              abstract,
              content,
            }),
          ),
        ],
        {},
      )[0];
    const proposed = development(
      "proposed",
      "The requirements were proposed for 100 models.",
    );
    const statusChanged = development(
      "status-changed",
      "Background on the evaluation program.",
      "The requirements were adopted for 100 models.",
    );
    const numericChanged = development(
      "numeric-changed",
      "Background on the evaluation program.",
      "The requirements were proposed for 200 models.",
    );
    expect(proposed).toBeDefined();
    expect(statusChanged).toBeDefined();
    expect(numericChanged).toBeDefined();
    if (
      proposed === undefined ||
      statusChanged === undefined ||
      numericChanged === undefined
    ) {
      return;
    }

    expect(statusChanged.developmentKey).toBe(proposed.developmentKey);
    expect(numericChanged.developmentKey).toBe(
      proposed.developmentKey,
    );
    expect(statusChanged.materialFactsFingerprint).not.toBe(
      proposed.materialFactsFingerprint,
    );
    expect(numericChanged.materialFactsFingerprint).not.toBe(
      proposed.materialFactsFingerprint,
    );
    expect(proposed.materialFacts).toEqual(
      expect.arrayContaining([
        { kind: "status", key: "event-status", value: "proposed" },
        {
          kind: "number",
          key: "count:governance-instrument:models",
          value: "100",
        },
      ]),
    );
    expect(statusChanged.materialFacts).toEqual(
      expect.arrayContaining([
        { kind: "status", key: "event-status", value: "adopted" },
        {
          kind: "number",
          key: "count:governance-instrument:models",
          value: "100",
        },
      ]),
    );
    expect(numericChanged.materialFacts).toEqual(
      expect.arrayContaining([
        { kind: "status", key: "event-status", value: "proposed" },
        {
          kind: "number",
          key: "count:governance-instrument:models",
          value: "200",
        },
      ]),
    );
  });

  it("changes material fingerprints for status or numeric fact changes", () => {
    const development = (title: string) =>
      clusterNews(
        [
          normalizeCandidate(
            rawNews(title.includes("200") ? "changed-number" : title.includes("proposes") ? "changed-status" : "baseline", {
              title,
              primaryDocumentUrl: null,
              namedEntities: ["Evaluation Agency"],
              abstract: title,
            }),
          ),
        ],
        {},
      )[0];
    const approved = development(
      "Evaluation Agency approves AI evaluation standard for 100 models",
    );
    const proposed = development(
      "Evaluation Agency proposes AI evaluation standard for 100 models",
    );
    const expanded = development(
      "Evaluation Agency approves AI evaluation standard for 200 models",
    );
    expect(approved).toBeDefined();
    expect(proposed).toBeDefined();
    expect(expanded).toBeDefined();
    if (
      approved === undefined ||
      proposed === undefined ||
      expanded === undefined
    ) {
      return;
    }

    expect(proposed.developmentKey).toBe(approved.developmentKey);
    expect(expanded.developmentKey).toBe(approved.developmentKey);
    expect(proposed.materialFactsFingerprint).not.toBe(
      approved.materialFactsFingerprint,
    );
    expect(expanded.materialFactsFingerprint).not.toBe(
      approved.materialFactsFingerprint,
    );
  });

  it("does not use canonical document URL ordering as repeat identity", () => {
    const originalItem = normalizeCandidate(
      rawNews("document-original", {
        title:
          "Evaluation Agency proposes Frontier Evaluation Standard",
        abstract:
          "The Evaluation Agency proposed the Frontier Evaluation Standard.",
        primaryDocumentUrl: "https://z.agency.gov/frontier-standard",
      }),
    );
    const addedReporting = normalizeCandidate(
      rawNews("document-added", {
        title:
          "Frontier Evaluation Standard proposed by Evaluation Agency",
        abstract:
          "The Evaluation Agency proposed the Frontier Evaluation Standard.",
        primaryDocumentUrl: "https://a.example.org/conflicting-link",
      }),
    );
    const original = clusterNews([originalItem], {})[0];
    const expanded = clusterNews(
      [originalItem, addedReporting],
      {
        [originalItem.id]: [1, 0],
        [addedReporting.id]: [0.99, 0.01],
      },
    )[0];
    expect(original).toBeDefined();
    expect(expanded).toBeDefined();
    if (original === undefined || expanded === undefined) return;

    expect(expanded.primaryDocumentUrls).toHaveLength(2);
    expect(expanded.developmentKey).toBe(original.developmentKey);
    expect(expanded.materialFactsFingerprint).toBe(
      original.materialFactsFingerprint,
    );
  });

  it("recovers a subject from abstract content for stable identity", () => {
    const explicit = clusterNews(
      [
        normalizeCandidate(
          rawNews("explicit-subject", {
            title:
              "Evaluation Agency proposes Frontier Evaluation Standard",
            abstract:
              "The Evaluation Agency proposed the Frontier Evaluation Standard.",
            content:
              "Model Institute researchers praised the proposal.",
            primaryDocumentUrl: null,
            namedEntities: [],
          }),
        ),
      ],
      {},
    )[0];
    const abstractOnlyItem = normalizeCandidate(
      rawNews("abstract-subject", {
        title: "New frontier-model evaluation proposal",
        abstract:
          "Evaluation Agency proposed the Frontier Evaluation Standard for advanced models.",
        content:
          "The Evaluation Agency said the standard remains proposed.",
        primaryDocumentUrl: null,
        namedEntities: [],
      }),
    );
    const abstractOnly = clusterNews([abstractOnlyItem], {})[0];
    const introductoryProse = clusterNews(
      [
        normalizeCandidate(
          rawNews("introductory-subject", {
            title:
              "In a statement Evaluation Agency proposes Frontier Evaluation Standard",
            abstract:
              "Evaluation Agency proposed the Frontier Evaluation Standard.",
            primaryDocumentUrl: null,
            namedEntities: [],
          }),
        ),
      ],
      {},
    )[0];
    expect(explicit).toBeDefined();
    expect(abstractOnly).toBeDefined();
    expect(introductoryProse).toBeDefined();
    if (
      explicit === undefined ||
      abstractOnly === undefined ||
      introductoryProse === undefined
    ) {
      return;
    }

    expect(abstractOnly.repeatable).toBe(true);
    expect(abstractOnly.developmentKey).toBe(explicit.developmentKey);
    expect(introductoryProse.repeatable).toBe(true);
    expect(introductoryProse.developmentKey).toBe(
      explicit.developmentKey,
    );
  });

  it("separates distinct event instances in one subject and domain", () => {
    const development = (sourceId: string, title: string) =>
      clusterNews(
        [
          normalizeCandidate(
            rawNews(sourceId, {
              title,
              abstract: title,
              primaryDocumentUrl: null,
              namedEntities: ["Evaluation Agency"],
            }),
          ),
        ],
        {},
      )[0];
    const frontierStandard = development(
      "frontier-standard",
      "Evaluation Agency proposes Frontier Evaluation Standard",
    );
    const transparencyRule = development(
      "transparency-rule",
      "Evaluation Agency proposes Model Transparency Rule",
    );
    const atlas = development(
      "atlas-launch",
      "Evaluation Agency launches Atlas Assistant product",
    );
    const orion = development(
      "orion-launch",
      "Evaluation Agency launches Orion Assistant product",
    );
    const unseededDevelopment = (
      sourceId: string,
      title: string,
    ) =>
      clusterNews(
        [
          normalizeCandidate(
            rawNews(sourceId, {
              title,
              abstract: title,
              primaryDocumentUrl: null,
              namedEntities: [],
            }),
          ),
        ],
        {},
      )[0];
    const lowerCaseAtlas = unseededDevelopment(
      "atlas-lower-case",
      "Evaluation Agency launches Atlas Assistant",
    );
    const titleCaseAtlas = unseededDevelopment(
      "atlas-title-case",
      "Evaluation Agency Launches Atlas Assistant",
    );
    const upperCaseAtlas = unseededDevelopment(
      "atlas-upper-case",
      "EVALUATION AGENCY LAUNCHES ATLAS ASSISTANT",
    );
    expect(frontierStandard).toBeDefined();
    expect(transparencyRule).toBeDefined();
    expect(atlas).toBeDefined();
    expect(orion).toBeDefined();
    expect(lowerCaseAtlas).toBeDefined();
    expect(titleCaseAtlas).toBeDefined();
    expect(upperCaseAtlas).toBeDefined();
    if (
      frontierStandard === undefined ||
      transparencyRule === undefined ||
      atlas === undefined ||
      orion === undefined ||
      lowerCaseAtlas === undefined ||
      titleCaseAtlas === undefined ||
      upperCaseAtlas === undefined
    ) {
      return;
    }

    expect(transparencyRule.developmentKey).not.toBe(
      frontierStandard.developmentKey,
    );
    expect(lowerCaseAtlas.developmentKey).toBe(atlas.developmentKey);
    expect(titleCaseAtlas.developmentKey).toBe(atlas.developmentKey);
    expect(upperCaseAtlas.developmentKey).toBe(atlas.developmentKey);
    expect(orion.developmentKey).not.toBe(atlas.developmentKey);

    const atlasWithUnrelatedProduct = clusterNews(
      [
        normalizeCandidate(
          rawNews("atlas-with-orion-history", {
            title:
              "Evaluation Agency launches Atlas Assistant product",
            abstract:
              "Evaluation Agency released the Atlas Assistant product.",
            content:
              "Meanwhile, the orion assistant was delayed.",
            primaryDocumentUrl: null,
            namedEntities: ["Evaluation Agency"],
          }),
        ),
      ],
      {},
    )[0];
    expect(atlasWithUnrelatedProduct?.materialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "delayed" }),
      ]),
    );
  });

  it("fails open when event subject or object semantics conflict", () => {
    const ambiguousSubject = normalizeCandidate(
      rawNews("ambiguous-subject", {
        title:
          "Evaluation Agency and National Evaluation Agency propose Frontier Evaluation Standard",
        abstract:
          "Evaluation Agency and National Evaluation Agency jointly proposed the Frontier Evaluation Standard.",
        primaryDocumentUrl: null,
        namedEntities: [
          "Evaluation Agency",
          "National Evaluation Agency",
        ],
      }),
    );
    const frontier = normalizeCandidate(
      rawNews("conflict-frontier", {
        title:
          "Evaluation Agency proposes Frontier Evaluation Standard",
        abstract:
          "Evaluation Agency proposed the Frontier Evaluation Standard.",
        primaryDocumentUrl: null,
      }),
    );
    const transparency = normalizeCandidate(
      rawNews("conflict-transparency", {
        title:
          "Evaluation Agency proposes Model Transparency Rule",
        abstract:
          "Evaluation Agency proposed the Model Transparency Rule.",
        primaryDocumentUrl: null,
      }),
    );
    const ambiguous = clusterNews([ambiguousSubject], {})[0];
    const conflicting = clusterNews(
      [frontier, transparency],
      {
        [frontier.id]: [1, 0],
        [transparency.id]: [0.99, 0.01],
      },
    )[0];

    expect(ambiguous?.repeatable).toBe(false);
    expect(conflicting?.repeatable).toBe(false);
    expect(conflicting?.eventInstance).toBeNull();
  });

  it("scopes terminal status and dates to the current event instance", () => {
    const title =
      "Evaluation Agency proposes Frontier Evaluation Standard";
    const abstract =
      "The Frontier Evaluation Standard remains proposed with a deadline of December 1, 2026.";
    const content =
      "The earlier Model Transparency Rule was discussed. It was adopted as a rule and takes effect July 1, 2026. The workforce development standard was adopted and takes effect July 1, 2026.";
    const upstreamSignals = deriveNewsSignals({
      kind: "article",
      title,
      abstract,
      content,
      originalUrl: "https://scoped-policy.example.com/framework",
      sectionEligibility: ["ai_policy"],
      metadata: { primarySection: "ai_policy" },
      preferredSection: "ai_policy",
    });
    const item = normalizeCandidate(
      rawNews("scoped-policy", {
        ...upstreamSignals,
        title,
        abstract,
        content,
        primaryDocumentUrl: null,
        namedEntities: ["Evaluation Agency"],
      }),
    );
    const development = clusterNews([item], {})[0];

    expect(development?.materialFacts).toEqual(
      expect.arrayContaining([
        {
          kind: "status",
          key: "event-status",
          value: "proposed",
        },
        {
          kind: "date",
          key: "deadline-date",
          value: "2026-12-01",
        },
      ]),
    );
    expect(development?.materialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "adopted" }),
        expect.objectContaining({ value: "2026-07-01" }),
      ]),
    );

    const explicitCurrentChange = clusterNews(
      [
        normalizeCandidate(
          rawNews("explicit-current-change", {
            title,
            abstract,
            content:
              "The Frontier Evaluation Standard was adopted and takes effect July 1, 2027.",
            primaryDocumentUrl: null,
            namedEntities: ["Evaluation Agency"],
          }),
        ),
      ],
      {},
    )[0];
    expect(explicitCurrentChange?.materialFacts).toEqual(
      expect.arrayContaining([
        {
          kind: "status",
          key: "event-status",
          value: "adopted",
        },
        {
          kind: "date",
          key: "effective-date",
          value: "2027-07-01",
        },
      ]),
    );
  });

  it("normalizes and fingerprints funding amount changes", () => {
    const development = (sourceId: string, title: string) =>
      clusterNews(
        [
          normalizeCandidate(
            rawNews(sourceId, {
              title,
              abstract: title,
              primaryDocumentUrl: null,
              namedEntities: ["Evaluation Agency"],
            }),
          ),
        ],
        {},
      )[0];
    const prose = development(
      "funding-prose",
      "Evaluation Agency proposes $100 million for Compute Safety Program funding",
    );
    const compact = development(
      "funding-compact",
      "Evaluation Agency proposes $100m Compute Safety Program funding",
    );
    const changed = development(
      "funding-changed",
      "Evaluation Agency proposes $125m Compute Safety Program funding",
    );
    expect(prose).toBeDefined();
    expect(compact).toBeDefined();
    expect(changed).toBeDefined();
    if (
      prose === undefined ||
      compact === undefined ||
      changed === undefined
    ) {
      return;
    }

    expect(compact.developmentKey).toBe(prose.developmentKey);
    expect(changed.developmentKey).toBe(prose.developmentKey);
    expect(compact.materialFactsFingerprint).toBe(
      prose.materialFactsFingerprint,
    );
    expect(changed.materialFactsFingerprint).not.toBe(
      prose.materialFactsFingerprint,
    );
    expect(prose.materialFacts).toContainEqual({
      kind: "amount",
      key: "funding-amount:usd",
      value: "100000000",
    });
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
