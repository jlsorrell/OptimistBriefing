import { z } from "zod";

import { SourceRecordSchema, type SourceRecord } from "../db/repository";
import { settleCollectionBatch } from "./collection-settlement";
import { SourceHttpClient } from "./http-client";
import { type OutboundUrlPolicy } from "./outbound-url";
import { PapersWithCodeAdapter } from "./papers-with-code";
import { PublicationPageAdapter } from "./publication-page";
import { mapRssCollectionBatch, RssAdapter } from "./rss";
import {
  DiscoveryLaneDiagnosticSchema,
  RawPublicationCandidateSchema,
  ResearchSourceRecordSchema,
  type CollectionBatch,
  type CollectionWindow,
  type DiscoveryFamily,
  type DiscoveryLaneDiagnostic,
  type RawItem,
  type RawPublicationCandidate,
} from "./types";

const CatalogPolicySchema = z.object({
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedPorts: z.array(z.string()),
  allowedPathPrefixes: z.array(z.string().startsWith("/")).min(1),
});
const ELIGIBLE_SECTIONS = new Set(["research", "research_radar", "technology", "ai_policy"]);

function publicationFromRss(item: RawItem, source: SourceRecord): RawPublicationCandidate {
  return RawPublicationCandidateSchema.parse({
    ...item,
    kind: "publication",
    sectionEligibility: source.sectionEligibility,
    discoveryFamily: source.id === "alignment-forum" || source.id === "lesswrong-curated" ? "commentary" : "official-publication",
    metadata: {
      ...item.metadata,
      canCorroborateFacts: false,
      contentUse: typeof source.restrictions.contentUse === "string" ? source.restrictions.contentUse : "metadata-only",
      retention:
        item.abstract === null && item.content === null
          ? "metadata-only"
          : "ephemeral-only",
      discoveryMechanism: "rss",
      discoveryLaneIds: [`${source.id}:rss`],
    },
  });
}

export type PublicationCollectorOptions = {
  rssAdapters?: readonly { source: SourceRecord; adapter: RssAdapter }[];
  pageAdapters?: readonly PublicationSourceAdapter[];
  sourceOrder?: readonly string[];
};

type PublicationSourceAdapter = {
  sourceId: string;
  laneId: string;
  discoveryFamily: DiscoveryFamily;
  collect(window: CollectionWindow): Promise<readonly RawPublicationCandidate[]>;
};

function publicationFamily(source: SourceRecord): DiscoveryFamily {
  return source.id === "alignment-forum" ||
      source.id === "lesswrong-curated" ||
      source.id === "papers-with-code-co"
    ? "commentary"
    : "official-publication";
}

function publicationDiagnostic(
  laneId: string,
  sourceId: string,
  discoveryFamily: DiscoveryFamily,
  batch: CollectionBatch<RawPublicationCandidate>,
): DiscoveryLaneDiagnostic {
  return DiscoveryLaneDiagnosticSchema.parse({
    laneId,
    sourceId,
    discoveryFamily,
    discovered: batch.candidates.length,
    deduplicated: 0,
    triaged: 0,
    assessed: 0,
    outcome: batch.failures[0]?.kind ?? "success",
  });
}

export class PublicationCollector {
  private readonly rssAdapters: readonly { source: SourceRecord; adapter: RssAdapter }[];
  private readonly pageAdapters: readonly PublicationSourceAdapter[];
  private readonly sourceOrder: readonly string[];

  constructor(options: PublicationCollectorOptions) {
    this.rssAdapters = options.rssAdapters ?? [];
    this.pageAdapters = options.pageAdapters ?? [];
    this.sourceOrder = options.sourceOrder ?? [
      ...this.rssAdapters.map(({ source }) => source.id),
      ...this.pageAdapters.map(({ sourceId }) => sourceId),
    ];
  }

  async collect(window: CollectionWindow): Promise<CollectionBatch<RawPublicationCandidate>> {
    const rssOutcomes = await Promise.all(
      this.rssAdapters.map(async ({ source, adapter }) => {
        const laneId = `${source.id}:rss`;
        const discoveryFamily = publicationFamily(source);
        try {
          const batch = mapRssCollectionBatch(
            await adapter.collect(window),
            (item) => publicationFromRss(item, source),
          );
          return {
            batch,
            diagnostic: publicationDiagnostic(
              laneId,
              source.id,
              discoveryFamily,
              batch,
            ),
          };
        } catch {
          const batch: CollectionBatch<RawPublicationCandidate> = {
            candidates: [],
            succeededSourceIds: [],
            failures: [{ sourceId: source.id, kind: "parse" as const }],
          };
          return {
            batch,
            diagnostic: publicationDiagnostic(
              laneId,
              source.id,
              discoveryFamily,
              batch,
            ),
          };
        }
      }),
    );
    const pageOutcomes = await Promise.all(this.pageAdapters.map(
      async (adapter) => {
        const batch = await settleCollectionBatch([{
          sourceId: adapter.sourceId,
          collect: async () => (await adapter.collect(window)).map((candidate) =>
            RawPublicationCandidateSchema.parse({
              ...candidate,
              metadata: {
                ...candidate.metadata,
                discoveryLaneIds: [adapter.laneId],
              },
            })
          ),
        }]);
        return {
          batch,
          diagnostic: publicationDiagnostic(
            adapter.laneId,
            adapter.sourceId,
            adapter.discoveryFamily,
            batch,
          ),
        };
      }
    ));
    const batches = [
      ...rssOutcomes.map(({ batch }) => batch),
      ...pageOutcomes.map(({ batch }) => batch),
    ];
    const candidates = batches.flatMap((batch) => batch.candidates);
    const position = (sourceId: string) => {
      const index = this.sourceOrder.indexOf(sourceId);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    candidates.sort((left, right) => position(left.sourceId) - position(right.sourceId) || (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") || left.externalId.localeCompare(right.externalId));
    return {
      candidates,
      succeededSourceIds: [...new Set(batches.flatMap((batch) =>
        batch.succeededSourceIds
      ))].sort((left, right) => position(left) - position(right)),
      failures: batches.flatMap((batch) => batch.failures).sort((left, right) =>
        position(left.sourceId) - position(right.sourceId)
      ),
      discoveryDiagnostics: [
        ...rssOutcomes.map(({ diagnostic }) => diagnostic),
        ...pageOutcomes.map(({ diagnostic }) => diagnostic),
      ].sort((left, right) =>
        position(left.sourceId) - position(right.sourceId) ||
        left.laneId.localeCompare(right.laneId)
      ).slice(0, 64),
    };
  }
}

function failedAdapter(
  source: SourceRecord,
  error: unknown,
): PublicationSourceAdapter {
  const failure = error instanceof Error ? error : new SyntaxError("Invalid publication source configuration.", { cause: error });
  return {
    sourceId: source.id,
    laneId: `${source.id}:${source.discoveryMechanism}`,
    discoveryFamily: publicationFamily(source),
    collect: async (_window) => { throw failure; },
  };
}

export function createPublicationCollectorFromCatalog(options: {
  http: SourceHttpClient;
  sources: readonly SourceRecord[];
}): PublicationCollector {
  const rssAdapters: { source: SourceRecord; adapter: RssAdapter }[] = [];
  const pageAdapters: PublicationSourceAdapter[] = [];
  const sourceOrder: string[] = [];
  for (const input of options.sources) {
    if (
      input.enabled === false ||
      !input.sectionEligibility.some((section) =>
        ELIGIBLE_SECTIONS.has(section)
      )
    ) continue;
    const papersWithCode = input.id === "papers-with-code-co";
    if (!papersWithCode && input.role !== "blog") continue;
    sourceOrder.push(input.id);
    try {
      const source = SourceRecordSchema.parse(input);
      const collectionSource = ResearchSourceRecordSchema.parse(source);
      if (papersWithCode) {
        pageAdapters.push(new PapersWithCodeAdapter(options.http, collectionSource));
        continue;
      }
      const feedUrlPolicy = CatalogPolicySchema.parse(
        source.restrictions.feedUrlPolicy,
      ) as OutboundUrlPolicy;
      const articleUrlPolicy = CatalogPolicySchema.parse(
        source.restrictions.articleUrlPolicy,
      ) as OutboundUrlPolicy;
      if (source.discoveryMechanism === "rss") {
        const feedUrl = z.string().min(1).parse(source.restrictions.feedUrl);
        rssAdapters.push({
          source,
          adapter: new RssAdapter(options.http, [{ source: collectionSource, feedUrl, feedUrlPolicy, articleUrlPolicy }]),
        });
      } else if (source.discoveryMechanism === "page") {
        pageAdapters.push(new PublicationPageAdapter(options.http, collectionSource, z.string().min(1).parse(source.restrictions.pageUrl), feedUrlPolicy, articleUrlPolicy, source.restrictions.listing));
      } else {
        throw new SyntaxError("Unsupported publication discovery mechanism.");
      }
    } catch (error) {
      pageAdapters.push(failedAdapter(input, error));
    }
  }
  return new PublicationCollector({ rssAdapters, pageAdapters, sourceOrder });
}
