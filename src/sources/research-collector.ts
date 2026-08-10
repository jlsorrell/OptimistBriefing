import {
  settleCollectionBatch,
} from "./collection-settlement";
import {
  CollectionWindowSchema,
  DiscoveryFamilySchema,
  DiscoveryLaneDiagnosticSchema,
  RawItemSchema,
  RawResearchCandidateSchema,
  type CollectionBatch,
  type CollectionFailure,
  type CollectionWindow,
  type DiscoveryFamily,
  type DiscoveryLaneDiagnostic,
  type RawItem,
  type RawResearchCandidate,
  type ResearchEnricher,
  type ResearchSourceInput,
  type SourceAdapter,
} from "./types";
import type { PaperContentRetriever } from "./paper-content";
import {
  InvalidRequiredProviderDisplayTextError,
  markPreparedRawCandidate,
  prepareRawCandidateForPipeline,
} from "../editorial/normalize";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "./identifiers";
import {
  runProviderTasks,
  type ProviderSchedulePolicy,
  type ProviderSchedulerRuntime,
} from "./provider-scheduler";

const PAPER_LANE_LIMIT = 100;
const DISCOVERY_DIAGNOSTIC_LIMIT = 64;
const RECOGNIZED_PROVIDER_NAMES = new Set([
  "openalex",
  "papers-with-code",
  "semanticscholar",
]);

export const RESEARCH_PROVIDER_SCHEDULE_POLICIES: Readonly<
  Record<string, ProviderSchedulePolicy>
> = Object.freeze({
  "semantic-scholar": {
    maxConcurrency: 1,
    minimumStartIntervalMs: 1_000,
  },
  openalex: {
    maxConcurrency: 2,
    minimumStartIntervalMs: 0,
  },
});

const DEFAULT_PROVIDER_POLICY = Object.freeze({
  maxConcurrency: 16,
  minimumStartIntervalMs: 0,
});

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

function adapterDiscoveryFamily(adapter: SourceAdapter): DiscoveryFamily {
  const configured = "discoveryFamily" in adapter
    ? DiscoveryFamilySchema.safeParse(adapter.discoveryFamily)
    : { success: false as const };
  if (configured.success) return configured.data;
  return adapter.sourceId === "arxiv" ? "arxiv" : "bibliographic";
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

type RawDurableIdentities = {
  arxiv: ReadonlySet<string>;
  doi: ReadonlySet<string>;
  provider: ReadonlySet<string>;
};

function rawProviderIdentity(value: string): string | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const provider = value.slice(0, separator).toLocaleLowerCase("en-US");
  if (!RECOGNIZED_PROVIDER_NAMES.has(provider)) return null;
  const identifier = value.slice(separator + 1).trim();
  return identifier.length === 0 ? null : `${provider}:${identifier}`;
}

function rawDurableIdentities(item: RawItem): RawDurableIdentities {
  const arxiv = new Set<string>();
  const doi = new Set<string>();
  const provider = new Set<string>();
  for (const value of [item.externalId, ...item.externalIds]) {
    const normalizedArxiv = normalizeArxivIdentifier(value);
    if (normalizedArxiv !== null) {
      arxiv.add(normalizedArxiv);
      continue;
    }
    const normalizedDoi = normalizeDoi(value);
    if (normalizedDoi !== null) {
      doi.add(`DOI:${normalizedDoi}`);
      continue;
    }
    const normalizedProvider = rawProviderIdentity(value);
    if (normalizedProvider !== null) provider.add(normalizedProvider);
  }
  return { arxiv, doi, provider };
}

function identitySetsIntersect(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function samePaperIdentity(left: RawItem, right: RawItem): boolean {
  const leftIds = rawDurableIdentities(left);
  const rightIds = rawDurableIdentities(right);
  if (identitySetsIntersect(leftIds.arxiv, rightIds.arxiv)) return true;
  if (leftIds.arxiv.size > 0 && rightIds.arxiv.size > 0) return false;
  if (identitySetsIntersect(leftIds.doi, rightIds.doi)) return true;
  if (leftIds.doi.size > 0 && rightIds.doi.size > 0) return false;
  if (identitySetsIntersect(leftIds.provider, rightIds.provider)) return true;
  if (leftIds.provider.size > 0 && rightIds.provider.size > 0) return false;
  return left.externalId === right.externalId;
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
      discoveryLaneIds: unique([
        ...metadataStringArray(primary.metadata, "discoveryLaneIds"),
        ...metadataStringArray(secondary.metadata, "discoveryLaneIds"),
      ]).sort((left, right) => left.localeCompare(right)).slice(
        0,
        DISCOVERY_DIAGNOSTIC_LIMIT,
      ),
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
    const matches = merged.flatMap((candidate, index) =>
      candidate.kind === "paper" &&
      candidate.sourceId === item.sourceId &&
      samePaperIdentity(candidate, item)
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
      const candidate = merged[index] as RawItem;
      if (!samePaperIdentity(representative, candidate)) continue;
      representative = mergeRawItems(
        representative,
        candidate,
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

async function collectDiscoveryLane(
  adapter: SourceAdapter,
  window: CollectionWindow,
): Promise<{
  batch: CollectionBatch<{ laneId: string; item: RawItem }>;
  diagnostic: DiscoveryLaneDiagnostic;
}> {
  const laneId = adapterLaneId(adapter);
  const discoveryFamily = adapterDiscoveryFamily(adapter);
  const batch = await settleCollectionBatch([{
    sourceId: adapter.sourceId,
    collect: async () => (await adapter.collect(window))
      .map((item) => {
        const parsed = RawItemSchema.parse(item);
        const itemFamily = DiscoveryFamilySchema.safeParse(
          parsed.metadata.discoveryFamily,
        );
        return {
          laneId,
          item: RawItemSchema.parse({
            ...parsed,
            metadata: {
              ...parsed.metadata,
              discoveryFamily: itemFamily.success
                ? itemFamily.data
                : discoveryFamily,
              discoveryLaneIds: [laneId],
            },
          }),
        };
      })
      .sort(compareDiscovered)
      .slice(0, PAPER_LANE_LIMIT),
  }]);
  const diagnostic = DiscoveryLaneDiagnosticSchema.parse({
    laneId,
    sourceId: adapter.sourceId,
    discoveryFamily,
    discovered: batch.candidates.length,
    deduplicated: 0,
    triaged: 0,
    assessed: 0,
    outcome: batch.failures[0]?.kind ?? "success",
  });
  return { batch, diagnostic };
}

type ResearchCollectorOptions = {
  discoveryAdapters: readonly SourceAdapter[];
  enrichers: readonly ResearchEnricher[];
  preferredInstitutions: readonly string[];
  preferredLabs?: readonly string[];
  schedulerRuntime?: ProviderSchedulerRuntime;
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
    const adaptersByProvider = new Map<string, SourceAdapter[]>();
    for (const adapter of adapters) {
      const providerAdapters = adaptersByProvider.get(adapter.sourceId);
      if (providerAdapters === undefined) {
        adaptersByProvider.set(adapter.sourceId, [adapter]);
      } else {
        providerAdapters.push(adapter);
      }
    }
    const providerOutcomes = await Promise.all(
      [...adaptersByProvider].map(([sourceId, providerAdapters]) =>
        runProviderTasks(
          providerAdapters.map((adapter) =>
            () => collectDiscoveryLane(adapter, validWindow)
          ),
          RESEARCH_PROVIDER_SCHEDULE_POLICIES[sourceId]
            ?? DEFAULT_PROVIDER_POLICY,
          this.options.schedulerRuntime,
        )
      ),
    );
    const discoveryOutcomes = providerOutcomes
      .flat()
      .sort((left, right) =>
        left.diagnostic.laneId.localeCompare(right.diagnostic.laneId)
      );
    const discovery = {
      candidates: discoveryOutcomes.flatMap(({ batch }) => batch.candidates),
      succeededSourceIds: unique(
        discoveryOutcomes.flatMap(({ batch }) => batch.succeededSourceIds),
      ),
      failures: discoveryOutcomes.flatMap(({ batch }) => batch.failures),
    };
    const discoveryDiagnostics: DiscoveryLaneDiagnostic[] = discoveryOutcomes
      .map(({ diagnostic }) => diagnostic)
      .sort((left, right) => left.laneId.localeCompare(right.laneId))
      .slice(0, DISCOVERY_DIAGNOSTIC_LIMIT);
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

    const qualityRejectedByLane = new Map<string, number>();
    const candidates = enriched.flatMap((rawCandidate) => {
      try {
        const candidate = RawResearchCandidateSchema.parse(
          prepareRawCandidateForPipeline(rawCandidate),
        );
        const institutions = unique(
          candidate.institutions.map(normalizeInstitutionName),
        );
        return [markPreparedRawCandidate(RawResearchCandidateSchema.parse({
          ...candidate,
          institutions,
          preferredInstitutionMatches: institutions.filter((institution) =>
            this.preferredInstitutions.has(institution),
          ),
        }))];
      } catch (error) {
        if (error instanceof InvalidRequiredProviderDisplayTextError) {
          for (const laneId of metadataStringArray(
            rawCandidate.metadata,
            "discoveryLaneIds",
          )) {
            qualityRejectedByLane.set(
              laneId,
              (qualityRejectedByLane.get(laneId) ?? 0) + 1,
            );
          }
          return [];
        }
        throw error;
      }
    });
    return {
      candidates,
      succeededSourceIds: unique(succeededSourceIds),
      failures,
      discoveryDiagnostics: discoveryDiagnostics.map((diagnostic) => {
        const qualityRejected = qualityRejectedByLane.get(diagnostic.laneId) ??
          0;
        return qualityRejected === 0
          ? diagnostic
          : DiscoveryLaneDiagnosticSchema.parse({
              ...diagnostic,
              rejectionCounts: {
                ...diagnostic.rejectionCounts,
                quality_rejected: qualityRejected,
              },
            });
      }),
    };
  }
}
