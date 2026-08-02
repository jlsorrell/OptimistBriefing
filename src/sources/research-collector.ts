import {
  settleCollectionBatch,
} from "./collection-settlement";
import {
  CollectionWindowSchema,
  RawItemSchema,
  RawResearchCandidateSchema,
  type CollectionBatch,
  type CollectionFailure,
  type CollectionWindow,
  type RawItem,
  type RawResearchCandidate,
  type ResearchEnricher,
  type ResearchSourceInput,
  type SourceAdapter,
} from "./types";
import type { PaperContentRetriever } from "./paper-content";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "./identifiers";

const PAPER_LANE_LIMIT = 100;

const INSTITUTION_ALIASES = new Map<string, string>([
  ["stanford", "Stanford"],
  ["stanford university", "Stanford"],
  ["uc berkeley", "UC Berkeley"],
  ["university of california berkeley", "UC Berkeley"],
  ["university of california at berkeley", "UC Berkeley"],
  ["harvard", "Harvard"],
  ["harvard university", "Harvard"],
  ["mit", "MIT"],
  ["massachusetts institute of technology", "MIT"],
  ["carnegie mellon", "Carnegie Mellon"],
  ["carnegie mellon university", "Carnegie Mellon"],
  ["university of pennsylvania", "University of Pennsylvania"],
  ["penn", "University of Pennsylvania"],
  ["upenn", "University of Pennsylvania"],
  ["johns hopkins", "Johns Hopkins"],
  ["johns hopkins university", "Johns Hopkins"],
  ["ut austin", "UT Austin"],
  ["university of texas at austin", "UT Austin"],
  ["georgia tech", "Georgia Tech"],
  ["georgia institute of technology", "Georgia Tech"],
  ["google", "Google"],
  ["google research", "Google"],
  ["google deepmind", "Google DeepMind"],
  ["deepmind", "Google DeepMind"],
  ["anthropic", "Anthropic"],
  ["anthropic pbc", "Anthropic"],
  ["openai", "OpenAI"],
]);

function aliasKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

export function normalizeInstitutionName(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return INSTITUTION_ALIASES.get(aliasKey(normalized)) ?? normalized;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function metadataStringArray(
  metadata: Record<string, unknown>,
  key: string,
): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0,
      )
    : [];
}

function metadataCount(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function adapterLaneId(adapter: SourceAdapter): string {
  return "laneId" in adapter && typeof adapter.laneId === "string"
    ? adapter.laneId
    : adapter.sourceId;
}

function paperIdentities(item: RawItem): string[] {
  if (item.kind !== "paper") return [`external:${item.externalId}`];
  const normalized = item.externalIds.flatMap((externalId) => {
    const arxiv = normalizeArxivIdentifier(externalId);
    if (arxiv !== null) return [arxiv];
    const doi = normalizeDoi(externalId);
    return doi === null ? [] : [`DOI:${doi}`];
  });
  return unique(
    normalized.length === 0
      ? [`external:${item.externalId}`]
      : normalized,
  );
}

function mergeRawItems(primary: RawItem, secondary: RawItem): RawItem {
  const citationCounts = [
    metadataCount(primary.metadata, "citationCount"),
    metadataCount(secondary.metadata, "citationCount"),
  ].filter((value): value is number => value !== null);
  const influentialCitationCounts = [
    metadataCount(primary.metadata, "influentialCitationCount"),
    metadataCount(secondary.metadata, "influentialCitationCount"),
  ].filter((value): value is number => value !== null);
  return RawItemSchema.parse({
    ...primary,
    externalIds: unique([...primary.externalIds, ...secondary.externalIds]),
    authors: unique([...primary.authors, ...secondary.authors]),
    institutions: unique([
      ...primary.institutions,
      ...secondary.institutions,
    ]),
    abstract: primary.abstract ?? secondary.abstract,
    content: primary.content ?? secondary.content,
    relatedPaperIds: unique([
      ...primary.relatedPaperIds,
      ...secondary.relatedPaperIds,
    ]),
    metadata: {
      ...secondary.metadata,
      ...primary.metadata,
      citationCount:
        citationCounts.length === 0 ? null : Math.max(...citationCounts),
      influentialCitationCount:
        influentialCitationCounts.length === 0
          ? null
          : Math.max(...influentialCitationCounts),
      topics: unique([
        ...metadataStringArray(primary.metadata, "topics"),
        ...metadataStringArray(secondary.metadata, "topics"),
      ]),
    },
  });
}

function mergePaperIdentities(items: readonly RawItem[]): RawItem[] {
  const merged: RawItem[] = [];
  for (const item of items) {
    const identities = new Set(paperIdentities(item));
    const matches = merged.flatMap((candidate, index) =>
      candidate.kind === "paper" &&
      candidate.sourceId === item.sourceId &&
      paperIdentities(candidate).some((identity) => identities.has(identity))
        ? [index]
        : [],
    );
    if (matches.length === 0) {
      merged.push(item);
      continue;
    }
    const primaryIndex = matches[0] ?? 0;
    let representative = mergeRawItems(merged[primaryIndex] as RawItem, item);
    for (const index of matches.slice(1).reverse()) {
      representative = mergeRawItems(
        representative,
        merged[index] as RawItem,
      );
      merged.splice(index, 1);
    }
    merged[primaryIndex] = representative;
  }
  return merged;
}

function canonicalIdentity(item: RawItem): string {
  return paperIdentities(item).sort()[0] ?? `external:${item.externalId}`;
}

function compareDiscovered(
  left: { laneId: string; item: RawItem },
  right: { laneId: string; item: RawItem },
): number {
  const lane = left.laneId.localeCompare(right.laneId);
  if (lane !== 0) return lane;
  const publication = (right.item.publishedAt ?? "").localeCompare(
    left.item.publishedAt ?? "",
  );
  return publication !== 0
    ? publication
    : canonicalIdentity(left.item).localeCompare(canonicalIdentity(right.item));
}

function initialResearchCandidate(item: RawItem): RawResearchCandidate {
  return RawResearchCandidateSchema.parse({
    ...RawItemSchema.parse(item),
    kind: item.kind,
    preferredInstitutionMatches: [],
    citationCount: metadataCount(item.metadata, "citationCount"),
    influentialCitationCount: metadataCount(
      item.metadata,
      "influentialCitationCount",
    ),
    topics: metadataStringArray(item.metadata, "topics"),
  });
}

type ResearchCollectorOptions = {
  discoveryAdapters: readonly SourceAdapter[];
  enrichers: readonly ResearchEnricher[];
  preferredInstitutions: readonly string[];
  preferredLabs?: readonly string[];
  paperContent?: {
    retriever: PaperContentRetriever;
    sources: readonly ResearchSourceInput[];
  };
};

export class ResearchCollector {
  private readonly preferredInstitutions: ReadonlySet<string>;

  constructor(private readonly options: ResearchCollectorOptions) {
    this.preferredInstitutions = new Set(
      [...options.preferredInstitutions, ...(options.preferredLabs ?? [])].map(
        normalizeInstitutionName,
      ),
    );
  }

  async collect(
    window: CollectionWindow,
  ): Promise<CollectionBatch<RawResearchCandidate>> {
    const validWindow = CollectionWindowSchema.parse(window);
    const adapters = [...this.options.discoveryAdapters].sort((left, right) =>
      adapterLaneId(left).localeCompare(adapterLaneId(right)),
    );
    const discovery = await settleCollectionBatch(
      adapters.map((adapter) => ({
        sourceId: adapter.sourceId,
        collect: async () => {
          const laneId = adapterLaneId(adapter);
          return (await adapter.collect(validWindow))
            .map((item) => ({
              laneId,
              item: RawItemSchema.parse(item),
            }))
            .sort(compareDiscovered)
            .slice(0, PAPER_LANE_LIMIT);
        },
      })),
    );
    const discovered = mergePaperIdentities(
      discovery.candidates
        .map(({ laneId, item }) => ({
          laneId,
          item: RawItemSchema.parse(item),
        }))
        .sort(compareDiscovered)
        .map(({ item }) => item),
    )
      .filter(
        (item): item is RawItem & { kind: "paper" | "blog" } =>
          item.kind === "paper" || item.kind === "blog",
      )
      .map(initialResearchCandidate);

    let enriched = discovered;
    const succeededSourceIds = unique(discovery.succeededSourceIds);
    const failures: CollectionFailure[] = [...discovery.failures];
    for (const enricher of this.options.enrichers) {
      const result = await settleCollectionBatch([{
        sourceId: enricher.sourceId,
        collect: () => enricher.enrich(enriched),
      }]);
      succeededSourceIds.push(...result.succeededSourceIds);
      failures.push(...result.failures);
      if (result.failures.length === 0) {
        enriched = result.candidates.map((candidate) =>
          RawResearchCandidateSchema.parse(candidate),
        );
      }
    }

    const paperContent = this.options.paperContent;
    if (paperContent !== undefined) {
      const sources = new Map(
        paperContent.sources.map((source) => [source.id, source]),
      );
      enriched = await Promise.all(
        enriched.map(async (candidate) => {
          if (candidate.kind !== "paper" || candidate.abstract === null) {
            return candidate;
          }
          const source = sources.get(candidate.sourceId);
          const htmlUrl =
            typeof candidate.metadata.htmlUrl === "string"
              ? candidate.metadata.htmlUrl
              : null;
          if (source === undefined) {
            return candidate;
          }
          const content = await paperContent.retriever.retrieve({
            source,
            htmlUrl,
            abstract: candidate.abstract,
          });
          return RawResearchCandidateSchema.parse({
            ...candidate,
            accessLevel: content.accessLevel,
            content:
              content.accessLevel === "full_text" ? content.text : null,
          });
        }),
      );
    }

    const candidates = enriched.map((candidate) => {
      const institutions = unique(
        candidate.institutions.map(normalizeInstitutionName),
      );
      return RawResearchCandidateSchema.parse({
        ...candidate,
        institutions,
        preferredInstitutionMatches: institutions.filter((institution) =>
          this.preferredInstitutions.has(institution),
        ),
      });
    });
    return { candidates, succeededSourceIds, failures };
  }
}
