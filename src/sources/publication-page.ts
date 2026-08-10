import { parseHTML } from "linkedom";
import { z } from "zod";

import type { AccessLevel } from "../contracts/editorial";
import { extractReadableArticle, type ExtractedArticle } from "./article-extractor";
import { SourceFetchError, SourceHttpClient } from "./http-client";
import { transientExtractionPermitted } from "./news-collector";
import { assertSafeOutboundUrl, type OutboundUrlPolicy } from "./outbound-url";
import { relatedArxivIds } from "./rss";
import { boundProviderText } from "./provider-text";
import {
  CollectionWindowSchema,
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  MAX_PROVIDER_TITLE_CHARACTERS,
  RawPublicationCandidateSchema,
  type CollectionWindow,
  type RawPublicationCandidate,
  type ResearchSourceRecord,
} from "./types";

const ListingConfigSchema = z.object({
  itemSelector: z.string().trim().min(1),
  linkSelector: z.string().trim().min(1),
  titleSelector: z.string().trim().min(1).optional(),
  dateSelector: z.string().trim().min(1),
  dateAttribute: z.string().trim().min(1).optional(),
  summarySelector: z.string().trim().min(1).optional(),
  maxItems: z.number().int().positive().max(20).default(20),
  maxBodyFetches: z.number().int().nonnegative().max(10).default(10),
});

type ListingConfig = z.infer<typeof ListingConfigSchema>;

type ListingItem = {
  title: string;
  url: string;
  publishedAt: string;
  authors: string[];
  summary: string | null;
};

function text(
  value: unknown,
  maxCharacters = MAX_PROVIDER_TITLE_CHARACTERS,
): string | null {
  if (typeof value !== "string") return null;
  return boundProviderText(value, { stripHtml: true, maxCharacters });
}

function rawText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length === 0 ? null : normalized;
}

function date(value: unknown): string | null {
  const normalized = rawText(value);
  if (normalized === null) return null;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00Z` : normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function authorNames(value: unknown): string[] {
  return [...new Set(values(value).flatMap((author) => {
    if (typeof author === "string") return text(author) ?? [];
    if (author === null || typeof author !== "object") return [];
    return text((author as Record<string, unknown>).name) ?? [];
  }))];
}

function schemaType(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function schemaUrl(value: Record<string, unknown>): string | null {
  const direct = rawText(value.url);
  if (direct !== null) return direct;
  if (typeof value.mainEntityOfPage === "string") return rawText(value.mainEntityOfPage);
  if (value.mainEntityOfPage !== null && typeof value.mainEntityOfPage === "object") {
    return rawText((value.mainEntityOfPage as Record<string, unknown>)["@id"]);
  }
  return null;
}

function schemaArticles(value: unknown): Record<string, unknown>[] {
  return values(value).flatMap((entry): Record<string, unknown>[] => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (schemaType(record["@type"]).some((type) => type === "ItemList")) {
      return values(record.itemListElement).flatMap((element) => {
        if (element === null || typeof element !== "object") return [];
        const item = (element as Record<string, unknown>).item;
        return item !== null && typeof item === "object" ? [item as Record<string, unknown>] : [];
      });
    }
    if (Array.isArray(record["@graph"])) return schemaArticles(record["@graph"]);
    return schemaType(record["@type"]).some((type) => type === "BlogPosting" || type === "NewsArticle") ? [record] : [];
  });
}

function nested(item: Element, selector: string): Element | null {
  return item.matches(selector) ? item : item.querySelector(selector);
}

function noExtraction(): ExtractedArticle {
  return { title: null, byline: null, excerpt: null, text: null, extractionLevel: "metadata-only" };
}

function accessLevel(extraction: ExtractedArticle): AccessLevel {
  if (extraction.extractionLevel === "full") return "full_text";
  if (extraction.extractionLevel === "partial") return "secondary";
  return "metadata";
}

function restriction(source: ResearchSourceRecord, key: string, fallback: string): string {
  const value = source.restrictions[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export class PublicationPageAdapter {
  readonly sourceId: string;
  readonly laneId: string;
  readonly discoveryFamily = "official-publication" as const;
  private readonly pageUrl: string;
  private readonly listing: ListingConfig | null;

  constructor(
    private readonly http: SourceHttpClient,
    private readonly source: ResearchSourceRecord,
    pageUrl: string,
    private readonly pageUrlPolicy: OutboundUrlPolicy,
    private readonly articleUrlPolicy: OutboundUrlPolicy,
    listing?: unknown,
  ) {
    this.sourceId = source.id;
    this.laneId = `${source.id}:page`;
    this.pageUrl = assertSafeOutboundUrl(pageUrl, pageUrlPolicy).toString();
    this.listing = listing === undefined ? null : ListingConfigSchema.parse(listing);
  }

  private permittedItem(input: Omit<ListingItem, "url"> & { url: string }, baseUrl: string): ListingItem | null {
    try {
      return { ...input, url: assertSafeOutboundUrl(new URL(input.url, baseUrl), this.articleUrlPolicy).toString() };
    } catch {
      return null;
    }
  }

  async collect(window: CollectionWindow): Promise<RawPublicationCandidate[]> {
    const validWindow = CollectionWindowSchema.parse(window);
    if (!this.source.enabled) return [];
    const response = await this.http.get(this.source, this.pageUrl, {
      headers: { accept: "text/html,application/xhtml+xml" },
      useValidators: false,
      urlPolicy: this.pageUrlPolicy,
    });
    if (response.body === null) return [];
    const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") return [];
    const { document } = parseHTML(response.body);
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .flatMap((script) => {
        try { return schemaArticles(JSON.parse(script.textContent)); } catch { return []; }
      })
      .flatMap((entry): ListingItem[] => {
        const title = text(entry.headline ?? entry.name);
        const url = schemaUrl(entry);
        const publishedAt = date(entry.datePublished ?? entry.dateCreated);
        if (title === null || url === null || publishedAt === null) return [];
        const item = this.permittedItem({ title, url, publishedAt, authors: authorNames(entry.author), summary: text(entry.description, MAX_PROVIDER_EVIDENCE_CHARACTERS) }, response.finalUrl);
        return item === null ? [] : [item];
      });
    let discovered = jsonLd;
    if (discovered.length === 0 && this.listing !== null) {
      discovered = [...document.querySelectorAll(this.listing.itemSelector)].flatMap((item): ListingItem[] => {
        const link = nested(item, this.listing!.linkSelector);
        const href = link?.getAttribute("href");
        const title = text((this.listing!.titleSelector === undefined ? link : nested(item, this.listing!.titleSelector))?.textContent);
        const dateElement = nested(item, this.listing!.dateSelector);
        const publishedAt = date(this.listing!.dateAttribute === undefined ? dateElement?.textContent : dateElement?.getAttribute(this.listing!.dateAttribute));
        if (href === null || href === undefined || title === null || publishedAt === null) return [];
        const found = this.permittedItem({ title, url: href, publishedAt, authors: [], summary: this.listing!.summarySelector === undefined ? null : text(nested(item, this.listing!.summarySelector)?.textContent, MAX_PROVIDER_EVIDENCE_CHARACTERS) }, response.finalUrl);
        return found === null ? [] : [found];
      });
    }
    if (discovered.length === 0) {
      discovered = [...document.querySelectorAll("article")].flatMap((item): ListingItem[] => {
        const link = item.querySelector("a[href]");
        const href = link?.getAttribute("href");
        const title = text(item.querySelector("h1,h2,h3")?.textContent ?? link?.textContent);
        const time = item.querySelector("time");
        const publishedAt = date(time?.getAttribute("datetime") ?? time?.textContent);
        if (href === null || href === undefined || title === null || publishedAt === null) return [];
        const found = this.permittedItem({ title, url: href, publishedAt, authors: [], summary: text(item.querySelector("p")?.textContent, MAX_PROVIDER_EVIDENCE_CHARACTERS) }, response.finalUrl);
        return found === null ? [] : [found];
      });
    }
    const bounded = discovered
      .filter((item) => item.publishedAt >= validWindow.from && item.publishedAt <= validWindow.to)
      .slice(0, Math.min(20, this.listing?.maxItems ?? 20));
    const maxBodyFetches = Math.min(10, this.listing?.maxBodyFetches ?? 10);
    return (await Promise.all(bounded.map(async (item, index) => {
      let extraction = noExtraction();
      let originalUrl = item.url;
      let retrievedAt = response.retrievedAt;
      if (index < maxBodyFetches && transientExtractionPermitted(this.source)) {
        try {
          const detail = await this.http.get(this.source, item.url, {
            headers: { accept: "text/html,application/xhtml+xml" },
            useValidators: false,
            urlPolicy: this.articleUrlPolicy,
          });
          originalUrl = detail.finalUrl;
          retrievedAt = detail.retrievedAt;
          if (detail.body !== null) extraction = extractReadableArticle(detail.body, detail.finalUrl, detail.contentType);
        } catch (error) {
          if (error instanceof SourceFetchError && error.failureKind === "policy") return null;
        }
      }
      const abstract = extraction.excerpt ?? item.summary;
      const content = extraction.text;
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
        relatedPaperIds: relatedArxivIds([originalUrl, item.summary, abstract, content].filter(Boolean).join(" ")).slice(0, 16),
        sectionEligibility: this.source.sectionEligibility ?? [],
        discoveryFamily: "official-publication",
        metadata: {
          canCorroborateFacts: false,
          extractionLevel: extraction.extractionLevel,
          contentUse: restriction(this.source, "contentUse", "metadata-only"),
          paywall: restriction(this.source, "paywall", "unknown"),
          retention:
            abstract === null && content === null
              ? "metadata-only"
              : "ephemeral-only",
          discoveryMechanism: "page",
          discoveryLaneIds: [this.laneId],
          listingUrl: response.finalUrl,
        },
      });
    }))).filter((candidate): candidate is RawPublicationCandidate => candidate !== null);
  }
}
