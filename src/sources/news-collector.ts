import type { AccessLevel, SourceRef } from "../contracts/editorial";
import {
  extractReadableArticle,
  type ExtractedArticle,
} from "./article-extractor";
import { SourceHttpClient } from "./http-client";
import { RssAdapter, type ConfiguredFeed } from "./rss";
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

type NewsCollectorOptions = {
  http: SourceHttpClient;
  directFeeds: readonly ConfiguredFeed[];
  discoveryAdapters: readonly NewsSourceAdapter[];
  forecastAdapters: readonly NewsSourceAdapter[];
};

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

export class NewsCollector {
  private readonly directFeeds: readonly {
    source: ResearchSourceRecord;
    feedUrl: string;
  }[];
  private readonly rss: RssAdapter;

  constructor(private readonly options: NewsCollectorOptions) {
    this.directFeeds = options.directFeeds.map((feed) => ({
      source: ResearchSourceRecordSchema.parse(feed.source),
      feedUrl: feed.feedUrl,
    }));
    this.rss = new RssAdapter(options.http, options.directFeeds);
  }

  private async collectDirect(
    window: CollectionWindow,
  ): Promise<RawNewsCandidate[]> {
    const configuredSources = new Map(
      this.directFeeds.map((feed) => [feed.source.id, feed.source]),
    );
    const feedItems = await this.rss.collect(window);
    return Promise.all(
      feedItems.map(async (item): Promise<RawNewsCandidate> => {
        const source = configuredSources.get(item.sourceId);
        if (source === undefined) {
          throw new TypeError(
            `RSS returned an unconfigured source: ${item.sourceId}`,
          );
        }
        const contentUse = restriction(
          source,
          "contentUse",
          "metadata-only",
        );
        const paywall = restriction(source, "paywall", "unknown");
        let extraction = noExtraction();
        if (
          bodyRetrievalPermitted(source) &&
          contentUse === "ephemeral-summarization"
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
            extraction = noExtraction();
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
