import { z } from "zod";

import { SourceRecordSchema, type SourceRecord } from "../db/repository";
import { settleCollectionBatch } from "./collection-settlement";
import { SourceHttpClient } from "./http-client";
import { type OutboundUrlPolicy } from "./outbound-url";
import { PublicationPageAdapter } from "./publication-page";
import { mapRssCollectionBatch, RssAdapter } from "./rss";
import {
  RawPublicationCandidateSchema,
  ResearchSourceRecordSchema,
  type CollectionBatch,
  type CollectionWindow,
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
      retention: "metadata-only",
      discoveryMechanism: "rss",
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
  collect(window: CollectionWindow): Promise<readonly RawPublicationCandidate[]>;
};

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
    const rssBatches = await Promise.all(
      this.rssAdapters.map(async ({ source, adapter }) => {
        try {
          return mapRssCollectionBatch(
            await adapter.collect(window),
            (item) => publicationFromRss(item, source),
          );
        } catch {
          return {
            candidates: [],
            succeededSourceIds: [],
            failures: [{ sourceId: source.id, kind: "parse" as const }],
          };
        }
      }),
    );
    const pages = await settleCollectionBatch(this.pageAdapters.map((adapter) => ({ sourceId: adapter.sourceId, collect: () => adapter.collect(window) })));
    const candidates = [...rssBatches.flatMap((batch) => batch.candidates), ...pages.candidates];
    const position = (sourceId: string) => {
      const index = this.sourceOrder.indexOf(sourceId);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    candidates.sort((left, right) => position(left.sourceId) - position(right.sourceId) || (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") || left.externalId.localeCompare(right.externalId));
    return {
      candidates,
      succeededSourceIds: [...rssBatches.flatMap((batch) => batch.succeededSourceIds), ...pages.succeededSourceIds].sort((left, right) => position(left) - position(right)),
      failures: [...rssBatches.flatMap((batch) => batch.failures), ...pages.failures].sort((left, right) => position(left.sourceId) - position(right.sourceId)),
    };
  }
}

function failedAdapter(sourceId: string, error: unknown): PublicationSourceAdapter {
  const failure = error instanceof Error ? error : new SyntaxError("Invalid publication source configuration.", { cause: error });
  return { sourceId, collect: async (_window) => { throw failure; } };
}

export function createPublicationCollectorFromCatalog(options: {
  http: SourceHttpClient;
  sources: readonly SourceRecord[];
}): PublicationCollector {
  const rssAdapters: { source: SourceRecord; adapter: RssAdapter }[] = [];
  const pageAdapters: PublicationSourceAdapter[] = [];
  const sourceOrder: string[] = [];
  for (const input of options.sources) {
    if (input.enabled === false || input.role !== "blog" || !input.sectionEligibility.some((section) => ELIGIBLE_SECTIONS.has(section))) continue;
    sourceOrder.push(input.id);
    try {
      const source = SourceRecordSchema.parse(input);
      const collectionSource = ResearchSourceRecordSchema.parse(source);
      const urlPolicy = CatalogPolicySchema.parse(source.restrictions.urlPolicy) as OutboundUrlPolicy;
      if (source.discoveryMechanism === "rss") {
        const feedUrl = z.string().min(1).parse(source.restrictions.feedUrl);
        rssAdapters.push({
          source,
          adapter: new RssAdapter(options.http, [{ source: collectionSource, feedUrl, feedUrlPolicy: urlPolicy, articleUrlPolicy: urlPolicy }]),
        });
      } else if (source.discoveryMechanism === "page") {
        pageAdapters.push(new PublicationPageAdapter(options.http, collectionSource, z.string().min(1).parse(source.restrictions.pageUrl), urlPolicy, source.restrictions.listing));
      } else {
        throw new SyntaxError("Unsupported publication discovery mechanism.");
      }
    } catch (error) {
      pageAdapters.push(failedAdapter(input.id, error));
    }
  }
  return new PublicationCollector({ rssAdapters, pageAdapters, sourceOrder });
}
