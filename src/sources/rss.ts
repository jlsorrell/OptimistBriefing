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
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  RawItemSchema,
  ResearchSourceRecordSchema,
  type CollectionBatch,
  type CollectionWindow,
  type RawItem,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

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

type NormalizedFeedEntry = {
  title: string;
  link: string;
  identifier?: string;
  published?: string;
  author?: string;
  description?: string;
};

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? [...value] : [value];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function feedEntries(value: unknown): unknown[] {
  const root = record(value);
  const channel = record(record(root?.rss)?.channel);
  if (channel) return asArray(channel.item);
  const feed = record(root?.feed);
  if (feed) return asArray(feed.entry);
  throw new SyntaxError("Unsupported feed envelope.");
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  const object = record(value);
  if (object === null) return [];
  return [
    ...strings(object["#text"]),
    ...strings(object.href),
    ...strings(object["@_href"]),
    ...strings(object.name),
  ];
}

function firstString(value: unknown): string | undefined {
  return strings(value).map((candidate) => candidate.trim()).find(Boolean);
}

type FeedLink = { href: string; rel?: string };

function links(value: unknown): FeedLink[] {
  if (typeof value === "string") return [{ href: value }];
  if (Array.isArray(value)) return value.flatMap(links);
  const object = record(value);
  if (object === null) return [];
  const rel = firstString(object.rel) ?? firstString(object["@_rel"]);
  const href = firstString(object.href) ?? firstString(object["@_href"]);
  const text = firstString(object["#text"]);
  const relField = rel === undefined ? {} : { rel };
  return [
    ...(href === undefined ? [] : [{ href, ...relField }]),
    ...(text === undefined ? [] : [{ href: text, ...relField }]),
  ];
}

function normalizeFeedEntry(value: unknown): NormalizedFeedEntry | null {
  const entry = record(value);
  if (entry === null) return null;
  const title = firstString(entry.title);
  const link = links(entry.link).find(({ href, rel }) =>
    /^https?:/i.test(href.trim()) &&
    (rel === undefined || /^(alternate|canonical)$/i.test(rel.trim()))
  )?.href.trim();
  if (title === undefined || link === undefined) return null;
  const identifier = firstString(entry.guid) ?? firstString(entry.id);
  const published =
    firstString(entry.pubDate) ??
    firstString(entry.published) ??
    firstString(entry.updated);
  const author = firstString(entry.author);
  const description =
    firstString(entry.encoded) ??
    firstString(entry.description) ??
    firstString(entry.summary) ??
    firstString(entry.content);
  return {
    title,
    link,
    ...(identifier === undefined ? {} : { identifier }),
    ...(published === undefined ? {} : { published }),
    ...(author === undefined ? {} : { author }),
    ...(description === undefined ? {} : { description }),
  };
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
            const entries = feedEntries(parsedXml);
            let interpretableEntries = 0;
            const candidates = entries.flatMap((value) => {
              const entry = normalizeFeedEntry(value);
              if (entry === null) return [];
              try {
                const originalUrl = assertSafeOutboundUrl(
                  entry.link,
                  articleUrlPolicy,
                ).toString();
                const date = entry.published === undefined
                  ? null
                  : new Date(entry.published);
                if (date !== null && Number.isNaN(date.getTime())) return [];
                const publishedAt = date === null ? null : date.toISOString();
                const rawDescription = entry.description ?? "";
                const description = normalizeWhitespace(rawDescription).slice(
                  0,
                  MAX_PROVIDER_EVIDENCE_CHARACTERS,
                );
                const title = normalizeWhitespace(entry.title);
                if (title.length === 0) return [];
                interpretableEntries += 1;
                if (
                  publishedAt !== null &&
                  (publishedAt < validWindow.from ||
                    publishedAt > validWindow.to)
                ) return [];
                const identifier = entry.identifier ?? originalUrl;
                return [RawItemSchema.parse({
                  kind: "blog",
                  sourceId: source.id,
                  sourceName: source.canonicalName,
                  sourceRole: source.role,
                  title,
                  originalUrl,
                  externalId: identifier,
                  externalIds: [identifier],
                  publishedAt,
                  retrievedAt: response.retrievedAt,
                  accessLevel: "secondary",
                  authors: entry.author === undefined ? [] : [entry.author],
                  institutions: [],
                  abstract: description.length === 0 ? null : description,
                  content: null,
                  relatedPaperIds: relatedArxivIds(
                    `${originalUrl} ${rawDescription}`,
                  ),
                  metadata: { feedUrl },
                })];
              } catch {
                return [];
              }
            });
            if (entries.length > 0 && interpretableEntries === 0) {
              throw new SyntaxError("No interpretable feed entries.");
            }
            return candidates;
          },
        })),
    );
  }
}
