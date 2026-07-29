import { z } from "zod";

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
import { SourceHttpClient } from "./http-client";
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

function isNewsCatalogSource(source: SourceRecord): boolean {
  return (
    source.role !== "blog" &&
    source.sectionEligibility.some((section) =>
      NEWS_SECTIONS.has(section),
    )
  );
}

class DirectPageAdapter implements NewsSourceAdapter {
  private readonly pageUrl: string;

  constructor(
    private readonly http: SourceHttpClient,
    private readonly source: ResearchSourceRecord,
    pageUrl: string,
    private readonly urlPolicy: OutboundUrlPolicy,
  ) {
    this.pageUrl = assertSafeOutboundUrl(pageUrl, urlPolicy).toString();
  }

  async collect(window: CollectionWindow): Promise<RawNewsCandidate[]> {
    CollectionWindowSchema.parse(window);
    if (!this.source.enabled || !transientExtractionPermitted(this.source)) {
      return [];
    }
    const response = await this.http.get(this.source, this.pageUrl, {
      headers: { accept: "text/html,application/xhtml+xml" },
      useValidators: false,
      urlPolicy: this.urlPolicy,
    });
    if (response.body === null) return [];
    const extraction = extractReadableArticle(
      response.body,
      response.finalUrl,
      response.contentType,
    );
    if (extraction.text === null) return [];
    return [
      RawNewsCandidateSchema.parse({
        kind: this.source.role === "primary" ? "document" : "article",
        sourceId: this.source.id,
        sourceName: this.source.canonicalName,
        sourceRole: this.source.role,
        title: extraction.title ?? this.source.canonicalName,
        originalUrl: response.finalUrl,
        externalId: response.finalUrl,
        externalIds: [response.finalUrl],
        publishedAt: null,
        retrievedAt: response.retrievedAt,
        accessLevel: extractionAccessLevel(extraction),
        authors: extraction.byline === null ? [] : [extraction.byline],
        institutions: [],
        abstract: extraction.excerpt,
        content: extraction.text,
        relatedPaperIds: [],
        canCorroborateFacts: canCorroborateFacts(this.source.role),
        metadata: {
          extractionLevel: extraction.extractionLevel,
          contentUse: restriction(
            this.source,
            "contentUse",
            "metadata-only",
          ),
          paywall: restriction(this.source, "paywall", "unknown"),
          retention: "ephemeral-only",
          discoveryMechanism: "page",
        },
      }),
    ];
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
          metadata: {
            documentNumber: item.document_number,
            documentType: item.type ?? null,
            discoveryMechanism: "api",
          },
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
          } catch {
            return null;
          }
        }

        return RawNewsCandidateSchema.parse({
          ...item,
          kind: source.role === "primary" ? "document" : "article",
          accessLevel: extractionAccessLevel(extraction),
          content: extraction.text,
          canCorroborateFacts: canCorroborateFacts(source.role),
          metadata: {
            ...item.metadata,
            extractionLevel: extraction.extractionLevel,
            contentUse,
            paywall,
            retention: "ephemeral-only",
          },
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
