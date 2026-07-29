import { z } from "zod";
import { parseHTML } from "linkedom";

import type { AccessLevel, SourceRef } from "../contracts/editorial";
import {
  SourceRecordSchema,
  type SourceRecord,
} from "../db/repository";
import {
  extractReadableArticle,
  type ExtractedArticle,
} from "./article-extractor";
import { GdeltAdapter } from "./gdelt";
import {
  SourceFetchError,
  SourceHttpClient,
} from "./http-client";
import { deriveNewsSignals } from "./news-signals";
import { RssAdapter, type ConfiguredFeed } from "./rss";
import {
  assertSafeOutboundUrl,
  type OutboundUrlPolicy,
} from "./outbound-url";
import { PolymarketAdapter } from "./polymarket";
import {
  bodyRetrievalPermitted,
  CollectionWindowSchema,
  RawNewsCandidateSchema,
  ResearchSourceRecordSchema,
  type CollectionWindow,
  type NewsSourceAdapter,
  type RawNewsCandidate,
  type ResearchSourceRecord,
} from "./types";

export type ConfiguredNewsFeed = ConfiguredFeed & {
  feedUrlPolicy: OutboundUrlPolicy;
  articleUrlPolicy: OutboundUrlPolicy;
};

type NewsCollectorOptions = {
  http: SourceHttpClient;
  directFeeds: readonly ConfiguredNewsFeed[];
  discoveryAdapters: readonly NewsSourceAdapter[];
  forecastAdapters: readonly NewsSourceAdapter[];
};

const CatalogUrlPolicySchema = z.object({
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedPorts: z.array(z.string()),
  allowedPathPrefixes: z.array(z.string().startsWith("/")).min(1),
});
const ListingPageConfigSchema = z.object({
  itemSelector: z.string().trim().min(1),
  linkSelector: z.string().trim().min(1),
  titleSelector: z.string().trim().min(1).optional(),
  dateSelector: z.string().trim().min(1),
  dateAttribute: z.string().trim().min(1).optional(),
  summarySelector: z.string().trim().min(1).optional(),
  maxItems: z.number().int().positive().max(100),
  maxBodyFetches: z.number().int().nonnegative().max(20),
});
type ListingPageConfig = z.infer<typeof ListingPageConfigSchema>;
const FederalRegisterResponseSchema = z.object({
  results: z.array(z.unknown()),
}).passthrough();
const FederalRegisterDocumentSchema = z.object({
  document_number: z.string().min(1),
  title: z.string().trim().min(1),
  html_url: z.string().url(),
  publication_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.string().trim().min(1).nullable().optional(),
  abstract: z.string().trim().min(1).nullable().optional(),
}).passthrough();
const NEWS_SECTIONS = new Set([
  "morning_brief",
  "world",
  "technology",
  "ai_policy",
  "dmv",
  "baltimore",
  "forecast",
]);

const TRANSIENT_EXTRACTION_CONTENT_USES = new Set([
  "ephemeral-summarization",
  "open-government",
  "open-research",
]);

function restriction(
  source: ResearchSourceRecord,
  name: string,
  fallback: string,
): string {
  const value = source.restrictions[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function canCorroborateFacts(role: SourceRef["role"]): boolean {
  return role === "primary" || role === "reporting";
}

export function transientExtractionPermitted(
  source: ResearchSourceRecord,
): boolean {
  return (
    bodyRetrievalPermitted(source) &&
    restriction(source, "paywall", "unknown") === "none" &&
    TRANSIENT_EXTRACTION_CONTENT_USES.has(
      restriction(source, "contentUse", "metadata-only"),
    )
  );
}

function noExtraction(): ExtractedArticle {
  return {
    title: null,
    byline: null,
    excerpt: null,
    text: null,
    extractionLevel: "metadata-only",
  };
}

function extractionAccessLevel(
  extraction: ExtractedArticle,
): AccessLevel {
  if (extraction.extractionLevel === "full") return "full_text";
  if (extraction.extractionLevel === "partial") return "secondary";
  return "metadata";
}

function catalogString(
  source: SourceRecord,
  name: "feedUrl" | "pageUrl" | "apiUrl" | "apiFormat",
): string {
  return z
    .string()
    .min(1)
    .parse(source.restrictions[name]);
}

function catalogPolicy(source: SourceRecord): OutboundUrlPolicy {
  return CatalogUrlPolicySchema.parse(
    source.restrictions.urlPolicy,
  );
}

function catalogListing(source: SourceRecord): ListingPageConfig {
  return ListingPageConfigSchema.parse(source.restrictions.listing);
}

function isNewsCatalogSource(source: SourceRecord): boolean {
  return (
    source.role !== "blog" &&
    source.sectionEligibility.some((section) =>
      NEWS_SECTIONS.has(section),
    )
  );
}

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function listingDate(value: string): string | null {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const timestamp =
    dateOnly === null
      ? Date.parse(
          /^[A-Za-z]+ \d{1,2}, \d{4}$/.test(trimmed)
            ? `${trimmed} UTC`
            : trimmed,
        )
      : Date.UTC(
          Number(dateOnly[1]),
          Number(dateOnly[2]) - 1,
          Number(dateOnly[3]),
        );
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

function nestedElement(item: Element, selector: string): Element | null {
  return item.matches(selector) ? item : item.querySelector(selector);
}

class DirectPageAdapter implements NewsSourceAdapter {
  private readonly pageUrl: string;

  constructor(
    private readonly http: SourceHttpClient,
    private readonly source: ResearchSourceRecord,
    pageUrl: string,
    private readonly urlPolicy: OutboundUrlPolicy,
    private readonly listing: ListingPageConfig,
  ) {
    this.pageUrl = assertSafeOutboundUrl(pageUrl, urlPolicy).toString();
  }

  async collect(window: CollectionWindow): Promise<RawNewsCandidate[]> {
    const validWindow = CollectionWindowSchema.parse(window);
    if (!this.source.enabled) return [];
    const response = await this.http.get(this.source, this.pageUrl, {
      headers: { accept: "text/html,application/xhtml+xml" },
      useValidators: false,
      urlPolicy: this.urlPolicy,
    });
    if (response.body === null) return [];
    const mediaType = response.contentType
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      mediaType !== "text/html" &&
      mediaType !== "application/xhtml+xml"
    ) {
      return [];
    }
    const { document } = parseHTML(response.body);
    const discovered = [...document.querySelectorAll(
      this.listing.itemSelector,
    )]
      .slice(0, this.listing.maxItems)
      .flatMap((item) => {
        const link = nestedElement(item, this.listing.linkSelector);
        const href = link?.getAttribute("href");
        const titleElement =
          this.listing.titleSelector === undefined
            ? link
            : nestedElement(item, this.listing.titleSelector);
        const title = normalizedText(titleElement?.textContent);
        const dateElement = nestedElement(
          item,
          this.listing.dateSelector,
        );
        const rawDate =
          this.listing.dateAttribute === undefined
            ? dateElement?.textContent
            : dateElement?.getAttribute(this.listing.dateAttribute);
        const publishedAt =
          rawDate === null || rawDate === undefined
            ? null
            : listingDate(rawDate);
        if (href == null || title === null || publishedAt === null) {
          return [];
        }
        if (
          publishedAt < validWindow.from ||
          publishedAt > validWindow.to
        ) {
          return [];
        }
        let originalUrl: string;
        try {
          originalUrl = assertSafeOutboundUrl(
            new URL(href, response.finalUrl),
            this.urlPolicy,
          ).toString();
        } catch {
          return [];
        }
        if (originalUrl === response.finalUrl) return [];
        const summary =
          this.listing.summarySelector === undefined
            ? null
            : normalizedText(
                nestedElement(
                  item,
                  this.listing.summarySelector,
                )?.textContent,
              );
        return [{ title, originalUrl, publishedAt, summary }];
      });

    return (
      await Promise.all(
        discovered.map(async (item, index) => {
          let extraction = noExtraction();
          let originalUrl = item.originalUrl;
          let retrievedAt = response.retrievedAt;
          if (
            index < this.listing.maxBodyFetches &&
            transientExtractionPermitted(this.source)
          ) {
            try {
              const articleResponse = await this.http.get(
                this.source,
                originalUrl,
                {
                  headers: {
                    accept: "text/html,application/xhtml+xml",
                  },
                  useValidators: false,
                  urlPolicy: this.urlPolicy,
                },
              );
              originalUrl = articleResponse.finalUrl;
              retrievedAt = articleResponse.retrievedAt;
              if (articleResponse.body !== null) {
                extraction = extractReadableArticle(
                  articleResponse.body,
                  articleResponse.finalUrl,
                  articleResponse.contentType,
                );
              }
            } catch (error) {
              if (
                error instanceof SourceFetchError &&
                error.failureKind === "policy"
              ) {
                return null;
              }
            }
          }
          const kind =
            this.source.role === "primary" ? "document" : "article";
          const metadata = {
            extractionLevel: extraction.extractionLevel,
            contentUse: restriction(
              this.source,
              "contentUse",
              "metadata-only",
            ),
            paywall: restriction(
              this.source,
              "paywall",
              "unknown",
            ),
            retention:
              extraction.text === null
                ? "metadata-only"
                : "ephemeral-only",
            discoveryMechanism: "page",
            listingUrl: response.finalUrl,
          };
          return RawNewsCandidateSchema.parse({
            kind,
            sourceId: this.source.id,
            sourceName: this.source.canonicalName,
            sourceRole: this.source.role,
            title: item.title,
            originalUrl,
            externalId: originalUrl,
            externalIds: [originalUrl],
            publishedAt: item.publishedAt,
            retrievedAt,
            accessLevel: extractionAccessLevel(extraction),
            authors:
              extraction.byline === null ? [] : [extraction.byline],
            institutions: [],
            abstract: extraction.excerpt ?? item.summary,
            content: extraction.text,
            relatedPaperIds: [],
            canCorroborateFacts: canCorroborateFacts(this.source.role),
            ...deriveNewsSignals({
              kind,
              title: item.title,
              originalUrl,
              sectionEligibility:
                this.source.sectionEligibility ?? [],
              metadata,
              preferredSection:
                this.source.restrictions.preferredSection,
            }),
          });
        }),
      )
    ).filter(
      (item): item is RawNewsCandidate => item !== null,
    );
  }
}

class FederalRegisterAdapter implements NewsSourceAdapter {
  private readonly apiUrl: string;

  constructor(
    private readonly http: SourceHttpClient,
    private readonly source: ResearchSourceRecord,
    apiUrl: string,
    private readonly urlPolicy: OutboundUrlPolicy,
  ) {
    this.apiUrl = assertSafeOutboundUrl(apiUrl, urlPolicy).toString();
  }

  async collect(window: CollectionWindow): Promise<RawNewsCandidate[]> {
    const validWindow = CollectionWindowSchema.parse(window);
    if (!this.source.enabled) return [];
    const endpoint = new URL(this.apiUrl);
    endpoint.searchParams.set(
      "conditions[publication_date][gte]",
      validWindow.from.slice(0, 10),
    );
    endpoint.searchParams.set(
      "conditions[publication_date][lte]",
      validWindow.to.slice(0, 10),
    );
    endpoint.searchParams.set("per_page", "100");
    endpoint.searchParams.set("order", "newest");
    const response = await this.http.get(
      this.source,
      endpoint.toString(),
      {
        headers: { accept: "application/json" },
        useValidators: false,
        urlPolicy: this.urlPolicy,
      },
    );
    if (response.body === null) return [];
    const document = FederalRegisterResponseSchema.parse(
      JSON.parse(response.body),
    );
    return document.results.flatMap((input): RawNewsCandidate[] => {
      const parsed = FederalRegisterDocumentSchema.safeParse(input);
      if (!parsed.success) return [];
      const item = parsed.data;
      const publishedAt = `${item.publication_date}T00:00:00.000Z`;
      if (
        publishedAt < validWindow.from ||
        publishedAt > validWindow.to
      ) {
        return [];
      }
      let originalUrl: string;
      try {
        originalUrl = assertSafeOutboundUrl(
          item.html_url,
          this.urlPolicy,
        ).toString();
      } catch {
        return [];
      }
      const metadata = {
        documentNumber: item.document_number,
        documentType: item.type ?? null,
        discoveryMechanism: "api",
      };
      return [
        RawNewsCandidateSchema.parse({
          kind: "document",
          sourceId: this.source.id,
          sourceName: this.source.canonicalName,
          sourceRole: this.source.role,
          title: item.title,
          originalUrl,
          externalId: `FederalRegister:${item.document_number}`,
          externalIds: [`FederalRegister:${item.document_number}`],
          publishedAt,
          retrievedAt: response.retrievedAt,
          accessLevel:
            item.abstract === null || item.abstract === undefined
              ? "metadata"
              : "secondary",
          authors: [],
          institutions: [],
          abstract: item.abstract ?? null,
          content: null,
          relatedPaperIds: [],
          canCorroborateFacts: canCorroborateFacts(this.source.role),
          ...deriveNewsSignals({
            kind: "document",
            title: item.title,
            originalUrl,
            sectionEligibility:
              this.source.sectionEligibility ?? [],
            metadata,
            preferredSection:
              this.source.restrictions.preferredSection,
          }),
        }),
      ];
    });
  }
}

export class NewsCollector {
  private readonly directFeeds: readonly {
    source: ResearchSourceRecord;
    feedUrl: string;
    feedUrlPolicy: OutboundUrlPolicy;
    articleUrlPolicy: OutboundUrlPolicy;
  }[];
  private readonly rss: RssAdapter;

  constructor(private readonly options: NewsCollectorOptions) {
    this.directFeeds = options.directFeeds.map((feed) => ({
      source: ResearchSourceRecordSchema.parse(feed.source),
      feedUrl: feed.feedUrl,
      feedUrlPolicy: feed.feedUrlPolicy,
      articleUrlPolicy: feed.articleUrlPolicy,
    }));
    this.rss = new RssAdapter(options.http, options.directFeeds);
  }

  private async collectDirect(
    window: CollectionWindow,
  ): Promise<RawNewsCandidate[]> {
    const configuredSources = new Map(
      this.directFeeds.map((feed) => [feed.source.id, feed]),
    );
    const feedItems = await this.rss.collect(window);
    const items = await Promise.all(
      feedItems.map(async (item): Promise<RawNewsCandidate | null> => {
        const feed = configuredSources.get(item.sourceId);
        if (feed === undefined) {
          throw new TypeError(
            `RSS returned an unconfigured source: ${item.sourceId}`,
          );
        }
        const source = feed.source;
        const contentUse = restriction(
          source,
          "contentUse",
          "metadata-only",
        );
        const paywall = restriction(source, "paywall", "unknown");
        let extraction = noExtraction();
        if (
          transientExtractionPermitted(source)
        ) {
          try {
            const response = await this.options.http.get(
              source,
              item.originalUrl,
              {
                headers: {
                  accept: "text/html,application/xhtml+xml",
                },
                useValidators: false,
                urlPolicy: feed.articleUrlPolicy,
              },
            );
            if (response.body !== null) {
              extraction = extractReadableArticle(
                response.body,
                response.finalUrl,
                response.contentType,
              );
            }
          } catch (error) {
            if (
              error instanceof SourceFetchError &&
              error.failureKind === "policy"
            ) {
              return null;
            }
          }
        }

        const kind =
          source.role === "primary" ? "document" : "article";
        const metadata = {
          ...item.metadata,
          extractionLevel: extraction.extractionLevel,
          contentUse,
          paywall,
          retention: "ephemeral-only",
        };
        return RawNewsCandidateSchema.parse({
          ...item,
          kind,
          accessLevel: extractionAccessLevel(extraction),
          content: extraction.text,
          canCorroborateFacts: canCorroborateFacts(source.role),
          ...deriveNewsSignals({
            kind,
            title: item.title,
            originalUrl: item.originalUrl,
            sectionEligibility: source.sectionEligibility ?? [],
            metadata,
            preferredSection: source.restrictions.preferredSection,
          }),
        });
      }),
    );
    return items.filter(
      (item): item is RawNewsCandidate => item !== null,
    );
  }

  async collect(
    window: CollectionWindow,
  ): Promise<RawNewsCandidate[]> {
    const validWindow = CollectionWindowSchema.parse(window);
    const [direct, discovered, forecasts] = await Promise.all([
      this.collectDirect(validWindow),
      Promise.all(
        this.options.discoveryAdapters.map((adapter) =>
          adapter.collect(validWindow),
        ),
      ),
      Promise.all(
        this.options.forecastAdapters.map((adapter) =>
          adapter.collect(validWindow),
        ),
      ),
    ]);
    return [...direct, ...discovered.flat(), ...forecasts.flat()].map(
      (candidate) => RawNewsCandidateSchema.parse(candidate),
    );
  }
}

export type CatalogNewsCollectorOptions = {
  http: SourceHttpClient;
  sources: readonly SourceRecord[];
  gdelt?: {
    query: string;
    maxRecords: number;
  };
  polymarket?: {
    minimumLiquidity: number;
    minimumAbsoluteChange: number;
  };
};

export function createNewsCollectorFromCatalog(
  options: CatalogNewsCollectorOptions,
): NewsCollector {
  const directFeeds: ConfiguredNewsFeed[] = [];
  const discoveryAdapters: NewsSourceAdapter[] = [];
  const forecastAdapters: NewsSourceAdapter[] = [];
  const sources = options.sources.map((source) =>
    SourceRecordSchema.parse(source),
  );

  for (const source of sources) {
    if (!source.enabled || !isNewsCatalogSource(source)) continue;
    const collectionSource = ResearchSourceRecordSchema.parse(source);
    if (source.discoveryMechanism === "rss") {
      const urlPolicy = catalogPolicy(source);
      directFeeds.push({
        source: collectionSource,
        feedUrl: catalogString(source, "feedUrl"),
        feedUrlPolicy: urlPolicy,
        articleUrlPolicy: urlPolicy,
      });
      continue;
    }
    if (source.discoveryMechanism === "page") {
      discoveryAdapters.push(
        new DirectPageAdapter(
          options.http,
          collectionSource,
          catalogString(source, "pageUrl"),
          catalogPolicy(source),
          catalogListing(source),
        ),
      );
      continue;
    }
    if (source.discoveryMechanism !== "api") continue;

    const apiUrl = catalogString(source, "apiUrl");
    if (source.id === "gdelt") {
      if (
        apiUrl !==
        "https://api.gdeltproject.org/api/v2/doc/doc"
      ) {
        throw new TypeError("GDELT catalog endpoint is not pinned.");
      }
      discoveryAdapters.push(
        new GdeltAdapter(
          options.http,
          collectionSource,
          options.gdelt ?? {
            query: "(AI OR technology OR policy)",
            maxRecords: 100,
          },
        ),
      );
      continue;
    }
    if (source.id === "polymarket") {
      if (
        apiUrl !==
        "https://gamma-api.polymarket.com/markets"
      ) {
        throw new TypeError("Polymarket catalog endpoint is not pinned.");
      }
      forecastAdapters.push(
        new PolymarketAdapter(
          options.http,
          collectionSource,
          options.polymarket ?? {
            minimumLiquidity: 100_000,
            minimumAbsoluteChange: 0.1,
          },
        ),
      );
      continue;
    }
    if (catalogString(source, "apiFormat") === "federal-register-v1") {
      discoveryAdapters.push(
        new FederalRegisterAdapter(
          options.http,
          collectionSource,
          apiUrl,
          catalogPolicy(source),
        ),
      );
      continue;
    }
    throw new TypeError(
      `Unsupported news catalog API source: ${source.id}`,
    );
  }

  return new NewsCollector({
    http: options.http,
    directFeeds,
    discoveryAdapters,
    forecastAdapters,
  });
}
