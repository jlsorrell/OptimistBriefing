import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import { normalizeArxivIdentifier } from "./identifiers";
import { assertSafeOutboundUrl } from "./outbound-url";
import {
  CollectionWindowSchema,
  RawItemSchema,
  ResearchSourceRecordSchema,
  type CollectionWindow,
  type RawItem,
  type ResearchSourceInput,
  type ResearchSourceRecord,
  type SourceAdapter,
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

export type ConfiguredFeed = {
  source: ResearchSourceInput;
  feedUrl: string;
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

function relatedArxivIds(value: string): string[] {
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

export class RssAdapter implements SourceAdapter {
  private readonly feeds: readonly ConfiguredFeed[];

  constructor(
    private readonly http: SourceHttpClient,
    feeds: readonly ConfiguredFeed[],
  ) {
    this.feeds = feeds.map((feed) => ({
      source: ResearchSourceRecordSchema.parse(feed.source),
      feedUrl: assertSafeOutboundUrl(feed.feedUrl).toString(),
    }));
  }

  async collect(window: CollectionWindow): Promise<RawItem[]> {
    const validWindow = CollectionWindowSchema.parse(window);
    const collected = await Promise.all(
      this.feeds
        .filter((feed) => feed.source.enabled)
        .map(async (feed): Promise<RawItem[]> => {
          const response = await this.http.get(feed.source, feed.feedUrl);
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
            const publishedAt =
              item.pubDate === undefined
                ? null
                : new Date(item.pubDate).toISOString();
            if (
              publishedAt !== null &&
              (publishedAt < validWindow.from || publishedAt > validWindow.to)
            ) {
              return [];
            }
            const rawDescription = item.encoded ?? item.description ?? "";
            const description = normalizeWhitespace(rawDescription);
            const guid =
              typeof item.guid === "string"
                ? item.guid
                : item.guid?.["#text"];
            return [
              RawItemSchema.parse({
                kind: "blog",
                sourceId: feed.source.id,
                sourceName: feed.source.canonicalName,
                sourceRole: feed.source.role,
                title: normalizeWhitespace(item.title),
                originalUrl: item.link,
                externalId: guid ?? item.link,
                externalIds: [guid ?? item.link],
                publishedAt,
                retrievedAt: response.retrievedAt,
                accessLevel: "secondary",
                authors:
                  item.author === undefined ? [] : [item.author.trim()],
                institutions: [],
                abstract: description.length === 0 ? null : description,
                content: null,
                relatedPaperIds: relatedArxivIds(
                  `${item.link} ${rawDescription}`,
                ),
                metadata: {
                  feedUrl: feed.feedUrl,
                },
              }),
            ];
          });
        }),
    );
    return collected.flat();
  }
}
