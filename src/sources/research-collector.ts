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

function initialResearchCandidate(item: RawItem): RawResearchCandidate {
  return RawResearchCandidateSchema.parse({
    ...RawItemSchema.parse(item),
    kind: item.kind,
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics: [],
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
    const discovery = await settleCollectionBatch(
      this.options.discoveryAdapters.map((adapter) => ({
        sourceId: adapter.sourceId,
        collect: () => adapter.collect(validWindow),
      })),
    );
    const discovered = discovery.candidates
      .map((item) => RawItemSchema.parse(item))
      .filter(
        (item): item is RawItem & { kind: "paper" | "blog" } =>
          item.kind === "paper" || item.kind === "blog",
      )
      .map(initialResearchCandidate);

    let enriched = discovered;
    const succeededSourceIds = [...discovery.succeededSourceIds];
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
