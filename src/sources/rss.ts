import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import { normalizeArxivIdentifier } from "./identifiers";
import {
  assertSafeOutboundUrl,
  type OutboundUrlPolicy,
} from "./outbound-url";
import {
  settleCollectionBatch,
} from "./collection-settlement";
import {
  CollectionWindowSchema,
  RawItemSchema,
  ResearchSourceRecordSchema,
  type CollectionBatch,
  type CollectionWindow,
  type RawItem,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

const RssItemSchema = z.object({
  title: z.string().min(1),
  link: z.string().url(),
  guid: z
    .union([
      z.string().min(1),
      z.object({ "#text": z.string().min(1) }).passthrough(),
    ])
    .optional(),
  pubDate: z.string().optional(),
  author: z.string().optional(),
  description: z.string().optional(),
  encoded: z.string().optional(),
});

const RssDocumentSchema = z.object({
  rss: z.object({
    channel: z.object({
      item: z.union([RssItemSchema, z.array(RssItemSchema)]).optional(),
    }),
  }),
});

const OutboundUrlPolicySchema = z.object({
  allowedHosts: z.array(z.string().min(1)).optional(),
  allowedPorts: z.array(z.string()).optional(),
  allowedPathPrefixes: z
    .array(z.string().startsWith("/"))
    .optional(),
});

export type ConfiguredFeed = {
  source: ResearchSourceInput;
  feedUrl: unknown;
  feedUrlPolicy?: unknown;
  articleUrlPolicy?: unknown;
};

function asArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function relatedArxivIds(value: string): string[] {
  const matches = value.matchAll(
    /(?:arxiv:|arxiv\.org\/(?:abs|html|pdf)\/)(\d{4}\.\d{4,5})(?:v\d+)?/gi,
  );
  return [
    ...new Set(
      [...matches]
        .map((match) => normalizeArxivIdentifier(match[0]))
        .filter((identifier): identifier is string => identifier !== null),
    ),
  ];
}

export function mapRssCollectionBatch<T>(
  batch: CollectionBatch<RawItem>,
  mapper: (item: RawItem) => T,
): CollectionBatch<T> {
  return {
    candidates: batch.candidates.map(mapper),
    succeededSourceIds: [...batch.succeededSourceIds],
    failures: [...batch.failures],
  };
}

export class RssAdapter {
  private readonly feeds: readonly ConfiguredFeed[];

  constructor(
    private readonly http: SourceHttpClient,
    feeds: readonly ConfiguredFeed[],
  ) {
    this.feeds = feeds.map((feed) => ({ ...feed }));
  }

  async collect(
    window: CollectionWindow,
  ): Promise<CollectionBatch<RawItem>> {
    const validWindow = CollectionWindowSchema.parse(window);
    return settleCollectionBatch(
      this.feeds
        .filter((feed) => feed.source.enabled)
        .map((feed) => ({
          sourceId: feed.source.id,
          collect: async (): Promise<RawItem[]> => {
            const source = ResearchSourceRecordSchema.parse(feed.source);
            const feedUrlPolicy: OutboundUrlPolicy =
              OutboundUrlPolicySchema.parse(
                feed.feedUrlPolicy ?? {},
              ) as OutboundUrlPolicy;
            const articleUrlPolicy: OutboundUrlPolicy =
              OutboundUrlPolicySchema.parse(
                feed.articleUrlPolicy ?? {},
              ) as OutboundUrlPolicy;
            const feedUrl = assertSafeOutboundUrl(
              z.string().min(1).parse(feed.feedUrl),
              feedUrlPolicy,
            ).toString();
            const response = await this.http.get(
              source,
              feedUrl,
              { urlPolicy: feedUrlPolicy },
            );
            if (response.notModified || response.body === null) {
              return [];
            }
            const parsedXml: unknown = new XMLParser({
              ignoreAttributes: false,
              removeNSPrefix: true,
              trimValues: true,
              parseTagValue: false,
            }).parse(response.body);
            const document = RssDocumentSchema.parse(parsedXml);
            return asArray(document.rss.channel.item).flatMap((item) => {
              let originalUrl: string;
              try {
                originalUrl = assertSafeOutboundUrl(
                  item.link,
                  articleUrlPolicy,
                ).toString();
              } catch {
                return [];
              }
              const publishedAt =
                item.pubDate === undefined
                  ? null
                  : new Date(item.pubDate).toISOString();
              if (
                publishedAt !== null &&
                (publishedAt < validWindow.from ||
                  publishedAt > validWindow.to)
              ) {
                return [];
              }
              const rawDescription =
                item.encoded ?? item.description ?? "";
              const description = normalizeWhitespace(rawDescription);
              const guid =
                typeof item.guid === "string"
                  ? item.guid
                  : item.guid?.["#text"];
              return [
                RawItemSchema.parse({
                  kind: "blog",
                  sourceId: source.id,
                  sourceName: source.canonicalName,
                  sourceRole: source.role,
                  title: normalizeWhitespace(item.title),
                  originalUrl,
                  externalId: guid ?? originalUrl,
                  externalIds: [guid ?? originalUrl],
                  publishedAt,
                  retrievedAt: response.retrievedAt,
                  accessLevel: "secondary",
                  authors:
                    item.author === undefined ? [] : [item.author.trim()],
                  institutions: [],
                  abstract:
                    description.length === 0 ? null : description,
                  content: null,
                  relatedPaperIds: relatedArxivIds(
                    `${originalUrl} ${rawDescription}`,
                  ),
                  metadata: {
                    feedUrl,
                  },
                }),
              ];
            });
          },
        })),
    );
  }
}
