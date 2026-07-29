import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "./identifiers";
import {
  assertSafeOutboundUrl,
  type OutboundUrlPolicy,
} from "./outbound-url";
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

const ArxivAuthorSchema = z.object({
  name: z.string().min(1),
});

const ArxivLinkSchema = z.object({
  "@_href": z.string().url(),
  "@_rel": z.string().optional(),
  "@_type": z.string().optional(),
  "@_title": z.string().optional(),
});

const ArxivCategorySchema = z.object({
  "@_term": z.string().min(1),
});

const ArxivEntrySchema = z.object({
  id: z.string().url(),
  title: z.string().min(1),
  summary: z.string().min(1),
  published: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  updated: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  author: z.union([ArxivAuthorSchema, z.array(ArxivAuthorSchema)]),
  link: z.union([ArxivLinkSchema, z.array(ArxivLinkSchema)]),
  category: z
    .union([ArxivCategorySchema, z.array(ArxivCategorySchema)])
    .optional(),
  doi: z.string().min(1).optional(),
});

const ArxivFeedSchema = z.object({
  feed: z.object({
    entry: z
      .union([ArxivEntrySchema, z.array(ArxivEntrySchema)])
      .optional(),
  }),
});

type ArxivAdapterOptions = {
  apiUrl?: string;
  query?: string;
  maxResults?: number;
  maxPages?: number;
};

const ARXIV_API_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["export.arxiv.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/api/"],
};

function asArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export class ArxivAdapter implements SourceAdapter {
  private readonly source: ResearchSourceRecord;
  private readonly apiUrl: string;
  private readonly query: string;
  private readonly maxResults: number;
  private readonly maxPages: number;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    options: ArxivAdapterOptions = {},
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.apiUrl = assertSafeOutboundUrl(
      options.apiUrl ?? "https://export.arxiv.org/api/query",
      ARXIV_API_POLICY,
    ).toString();
    this.query = z
      .string()
      .min(1)
      .parse(
        options.query ??
          "(cat:cs.AI OR cat:cs.LG OR cat:cs.CL OR cat:cs.CR)",
      );
    this.maxResults = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(options.maxResults ?? 100);
    this.maxPages = z
      .number()
      .int()
      .min(1)
      .max(10)
      .parse(options.maxPages ?? 3);
  }

  async collect(window: CollectionWindow): Promise<RawItem[]> {
    if (!this.source.enabled) {
      return [];
    }
    const validWindow = CollectionWindowSchema.parse(window);
    const collected: RawItem[] = [];
    for (let page = 0; page < this.maxPages; page += 1) {
      const url = new URL(this.apiUrl);
      url.searchParams.set("search_query", this.query);
      url.searchParams.set("start", String(page * this.maxResults));
      url.searchParams.set("max_results", String(this.maxResults));
      url.searchParams.set("sortBy", "lastUpdatedDate");
      url.searchParams.set("sortOrder", "descending");

      const response = await this.http.get(this.source, url.toString(), {
        urlPolicy: ARXIV_API_POLICY,
      });
      if (response.notModified || response.body === null) {
        break;
      }
      const parsedXml: unknown = new XMLParser({
        ignoreAttributes: false,
        removeNSPrefix: true,
        trimValues: true,
        parseTagValue: false,
      }).parse(response.body);
      const feed = ArxivFeedSchema.parse(parsedXml);
      const entries = asArray(feed.feed.entry);
      for (const entry of entries) {
        const publishedAt = new Date(entry.published).toISOString();
        const updatedAt = new Date(entry.updated).toISOString();
        if (
          !(
            (publishedAt >= validWindow.from && publishedAt <= validWindow.to) ||
            (updatedAt >= validWindow.from && updatedAt <= validWindow.to)
          )
        ) {
          continue;
        }
        collected.push(
          this.toRawItem(entry, response.retrievedAt, publishedAt, updatedAt),
        );
      }
      const reachedOlderUpdates = entries.some(
        (entry) => new Date(entry.updated).toISOString() < validWindow.from,
      );
      if (reachedOlderUpdates || entries.length < this.maxResults) {
        break;
      }
    }
    return collected;
  }

  private toRawItem(
    entry: z.infer<typeof ArxivEntrySchema>,
    retrievedAt: string,
    publishedAt: string,
    updatedAt: string,
  ): RawItem {
    const externalId = normalizeArxivIdentifier(entry.id);
    if (externalId === null) {
      throw new Error(`Invalid arXiv entry identifier from ${this.source.id}`);
    }
    const links = asArray(entry.link);
    const originalUrl =
      links.find(
        (link) =>
          link["@_rel"] === "alternate" &&
          link["@_type"] === "text/html",
      )?.["@_href"] ?? entry.id;
    const bareId = externalId.slice("arXiv:".length);
    const doi =
      entry.doi === undefined ? null : normalizeDoi(entry.doi);
    const externalIds = [
      externalId,
      ...(doi === null ? [] : [`DOI:${doi}`]),
    ];
    return RawItemSchema.parse({
      kind: "paper",
      sourceId: this.source.id,
      sourceName: this.source.canonicalName,
      sourceRole: this.source.role,
      title: normalizeWhitespace(entry.title),
      originalUrl,
      externalId,
      externalIds,
      publishedAt,
      retrievedAt,
      accessLevel: "abstract",
      authors: asArray(entry.author).map((author) => author.name.trim()),
      institutions: [],
      abstract: normalizeWhitespace(entry.summary),
      content: null,
      relatedPaperIds: [],
      metadata: {
        updatedAt,
        categories: asArray(entry.category).map(
          (category) => category["@_term"],
        ),
        htmlUrl: `https://arxiv.org/html/${bareId}`,
        pdfUrl:
          links.find((link) => link["@_type"] === "application/pdf")?.[
            "@_href"
          ] ?? null,
      },
    });
  }
}
