import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import { normalizeArxivIdentifier } from "./identifiers";
import {
  boundProviderText,
  normalizedProviderSignalText,
} from "./provider-text";
import {
  assertSafeOutboundUrl,
  type OutboundUrlPolicy,
} from "./outbound-url";
import {
  settleObservedCollectionBatch,
} from "./collection-settlement";
import {
  CollectionWindowSchema,
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  MAX_PROVIDER_TITLE_CHARACTERS,
  RawItemSchema,
  ResearchSourceRecordSchema,
  type CollectionBatch,
  type CollectionWindow,
  type RawItem,
  type ResearchSourceInput,
  type ResearchSourceRecord,
  UnsupportedSourceMediaTypeError,
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
  const rss = record(root?.rss);
  if (rss !== null && "channel" in rss) {
    return asArray(record(rss.channel)?.item);
  }
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

function firstSafeArticleLink(
  value: unknown,
  articleUrlPolicy: OutboundUrlPolicy,
): string | undefined {
  for (const { href, rel } of links(value)) {
    const candidate = href.trim();
    if (
      !/^https?:/i.test(candidate) ||
      (rel !== undefined && !/^(alternate|canonical)$/i.test(rel.trim()))
    ) {
      continue;
    }
    try {
      return assertSafeOutboundUrl(candidate, articleUrlPolicy).toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

function normalizeFeedEntry(
  value: unknown,
  articleUrlPolicy: OutboundUrlPolicy,
): NormalizedFeedEntry | null {
  const entry = record(value);
  if (entry === null) return null;
  const title = firstString(entry.title);
  const link = firstSafeArticleLink(entry.link, articleUrlPolicy);
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
    ...(batch.sourceObservations === undefined
      ? {}
      : { sourceObservations: batch.sourceObservations }),
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
    return settleObservedCollectionBatch(
      this.feeds
        .filter((feed) => feed.source.enabled)
        .map((feed) => ({
          sourceId: feed.source.id,
          collect: async (): Promise<{ candidates: RawItem[]; observed: number }> => {
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
              return { candidates: [], observed: 0 };
            }
            const mediaType = response.contentType?.split(";", 1)[0]
              ?.trim()
              .toLowerCase();
            if (
              mediaType !== "application/rss+xml" &&
              mediaType !== "application/atom+xml" &&
              mediaType !== "application/xml" &&
              mediaType !== "text/xml"
            ) {
              throw new UnsupportedSourceMediaTypeError();
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
              const entry = normalizeFeedEntry(value, articleUrlPolicy);
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
                const description = boundProviderText(rawDescription, {
                  stripHtml: true,
                  maxCharacters: MAX_PROVIDER_EVIDENCE_CHARACTERS,
                }) ?? "";
                const title = boundProviderText(entry.title, {
                  stripHtml: true,
                  maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
                }) ?? "";
                const signalTitle = normalizedProviderSignalText(
                  title,
                  MAX_PROVIDER_TITLE_CHARACTERS,
                );
                if (signalTitle === null) return [];
                const identifier = entry.identifier ?? originalUrl;
                const candidate = RawItemSchema.parse({
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
                });
                interpretableEntries += 1;
                if (
                  publishedAt !== null &&
                  (publishedAt < validWindow.from ||
                    publishedAt > validWindow.to)
                ) return [];
                return [candidate];
              } catch {
                return [];
              }
            });
            if (entries.length > 0 && interpretableEntries === 0) {
              throw new SyntaxError("No interpretable feed entries.");
            }
            return {
              candidates: candidates.slice(0, 10_000),
              observed: Math.min(10_000, interpretableEntries),
            };
          },
        })),
    );
  }
}
