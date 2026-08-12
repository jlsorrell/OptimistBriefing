import { mapResearchTopicIds } from "../editorial/research-topics";
import type { PublicationSourceAdapter } from "./publication-collector";
import { extractReadableArticle, type ExtractedArticle } from "./article-extractor";
import { SourceFetchError, SourceHttpClient } from "./http-client";
import { transientExtractionPermitted } from "./news-collector";
import { assertSafeOutboundUrl, UnsafeOutboundUrlError, type OutboundUrlPolicy } from "./outbound-url";
import { boundProviderText } from "./provider-text";
import { relatedArxivIds, RssAdapter } from "./rss";
import {
  CollectionWindowSchema,
  RawPublicationCandidateSchema,
  type CollectionFailure,
  type CollectionWindow,
  type RawItem,
  type RawPublicationCandidate,
  type ResearchSourceRecord,
  UnsupportedSourceMediaTypeError,
} from "./types";

const OPENAI_NEWS_RSS_URL = "https://openai.com/news/rss.xml";
const MAX_OPENAI_DETAIL_FETCHES = 5;

function noExtraction(): ExtractedArticle {
  return {
    title: null,
    byline: null,
    excerpt: null,
    text: null,
    extractionLevel: "metadata-only",
  };
}

function accessLevel(extraction: ExtractedArticle): "full_text" | "secondary" | "metadata" {
  if (extraction.extractionLevel === "full") return "full_text";
  if (extraction.extractionLevel === "partial") return "secondary";
  return "metadata";
}

function restriction(
  source: ResearchSourceRecord,
  key: string,
  fallback: string,
): string {
  const value = source.restrictions[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function feedCategories(item: RawItem): string[] {
  const categories = item.metadata.feedCategories;
  return Array.isArray(categories)
    ? categories.filter((category): category is string => typeof category === "string")
    : [];
}

function rethrowRssFailure(failure: CollectionFailure): never {
  switch (failure.kind) {
    case "unsupported_media":
      throw new UnsupportedSourceMediaTypeError();
    case "policy":
      throw new UnsafeOutboundUrlError("reviewed feed request was rejected");
    case "parse":
      throw new SyntaxError("Reviewed feed was not interpretable.");
    case "fetch":
    case "timeout":
      throw new SourceFetchError({
        sourceId: failure.sourceId,
        status: null,
        retryable: false,
        failureKind: failure.kind === "timeout" ? "timeout" : "transport",
        reason: "reviewed feed request failed",
      });
    case "unknown":
      throw new Error("Reviewed feed request failed.");
  }
}

export class OpenAiPublicationFeedAdapter implements PublicationSourceAdapter {
  readonly sourceId: string;
  readonly laneId = "openai:rss";
  readonly discoveryFamily = "official-publication" as const;
  private readonly rss: RssAdapter;

  constructor(
    private readonly http: SourceHttpClient,
    private readonly source: ResearchSourceRecord,
    feedUrlPolicy: OutboundUrlPolicy,
    private readonly articleUrlPolicy: OutboundUrlPolicy,
  ) {
    if (source.id !== "openai") {
      throw new SyntaxError("Reviewed publication feed source must be OpenAI.");
    }
    this.sourceId = source.id;
    assertSafeOutboundUrl(OPENAI_NEWS_RSS_URL, feedUrlPolicy);
    this.rss = new RssAdapter(http, [{
      source,
      feedUrl: OPENAI_NEWS_RSS_URL,
      feedUrlPolicy,
      articleUrlPolicy,
      maxEntries: 20,
    }]);
  }

  async collect(window: CollectionWindow): Promise<RawPublicationCandidate[]> {
    return [...(await this.collectWithStats(window)).candidates];
  }

  private async candidateFromFeedItem(
    item: RawItem,
    fetchDetail: boolean,
  ): Promise<RawPublicationCandidate> {
    let extraction = noExtraction();
    let originalUrl = item.originalUrl;
    let retrievedAt = item.retrievedAt;
    if (fetchDetail && transientExtractionPermitted(this.source)) {
      try {
        const detail = await this.http.get(this.source, item.originalUrl, {
          headers: { accept: "text/html,application/xhtml+xml" },
          useValidators: false,
          urlPolicy: this.articleUrlPolicy,
        });
        originalUrl = assertSafeOutboundUrl(
          detail.finalUrl,
          this.articleUrlPolicy,
        ).toString();
        retrievedAt = detail.retrievedAt;
        if (detail.body !== null) {
          extraction = extractReadableArticle(
            detail.body,
            originalUrl,
            detail.contentType,
          );
        }
      } catch {
        // A feed row with complete metadata remains eligible when its detail
        // request is unavailable or rejected after a redirect.
      }
    }
    const abstract = extraction.excerpt ?? item.abstract;
    const content = extraction.text;
    const relatedPaperIds = [...new Set([
      ...item.relatedPaperIds,
      ...relatedArxivIds(
        [originalUrl, item.abstract, abstract, content].filter(Boolean).join(" "),
      ),
    ])].slice(0, 16);
    return RawPublicationCandidateSchema.parse({
      kind: "publication",
      sourceId: this.source.id,
      sourceName: this.source.canonicalName,
      sourceRole: this.source.role,
      title: item.title,
      originalUrl,
      externalId: originalUrl,
      externalIds: [originalUrl],
      publishedAt: item.publishedAt,
      retrievedAt,
      accessLevel: accessLevel(extraction),
      authors: extraction.byline === null ? item.authors : [extraction.byline],
      institutions: [],
      abstract,
      content,
      relatedPaperIds,
      sectionEligibility: this.source.sectionEligibility ?? [],
      discoveryFamily: "official-publication",
      metadata: {
        ...item.metadata,
        canCorroborateFacts: false,
        extractionLevel: extraction.extractionLevel,
        contentUse: restriction(this.source, "contentUse", "metadata-only"),
        paywall: restriction(this.source, "paywall", "unknown"),
        retention:
          abstract === null && content === null
            ? "metadata-only"
            : "ephemeral-only",
        discoveryMechanism: "rss",
        discoveryLaneIds: [this.laneId],
      },
    });
  }

  async collectWithStats(
    window: CollectionWindow,
  ): Promise<{ candidates: readonly RawPublicationCandidate[]; observed: number }> {
    const validWindow = CollectionWindowSchema.parse(window);
    const batch = await this.rss.collect(validWindow);
    const failure = batch.failures[0];
    if (failure !== undefined) rethrowRssFailure(failure);
    const rows = batch.candidates.filter((item) =>
      item.publishedAt !== null && item.abstract !== null
    );
    const detailRows = new Set(
      rows.filter((item) => mapResearchTopicIds([
        item.title,
        item.abstract ?? "",
        ...feedCategories(item),
      ]).length > 0).slice(0, MAX_OPENAI_DETAIL_FETCHES),
    );
    return {
      candidates: await Promise.all(rows.map((item) =>
        this.candidateFromFeedItem(item, detailRows.has(item))
      )),
      observed: batch.sourceObservations?.find((observation) =>
        observation.sourceId === this.source.id
      )?.observed ?? 0,
    };
  }
}
