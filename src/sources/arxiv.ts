import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { SourceHttpClient } from "./http-client";
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
  published: z.string(),
  updated: z.string(),
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

export function normalizeArxivId(value: string): string | null {
  const match = value.match(
    /(?:arxiv:|arxiv\.org\/(?:abs|html|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i,
  );
  return match?.[1] === undefined ? null : `arXiv:${match[1]}`;
}

function arxivDateTerm(value: string): string {
  return value.replace(/[-:TZ.]/g, "").slice(0, 12);
}

export class ArxivAdapter implements SourceAdapter {
  private readonly source: ResearchSourceRecord;
  private readonly apiUrl: string;
  private readonly query: string;
  private readonly maxResults: number;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    options: ArxivAdapterOptions = {},
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.apiUrl = options.apiUrl ?? "https://export.arxiv.org/api/query";
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
  }

  async collect(window: CollectionWindow): Promise<RawItem[]> {
    if (!this.source.enabled) {
      return [];
    }
    const validWindow = CollectionWindowSchema.parse(window);
    const url = new URL(this.apiUrl);
    url.searchParams.set(
      "search_query",
      `${this.query} AND submittedDate:[${arxivDateTerm(validWindow.from)} TO ${arxivDateTerm(validWindow.to)}]`,
    );
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(this.maxResults));
    url.searchParams.set("sortBy", "lastUpdatedDate");
    url.searchParams.set("sortOrder", "descending");

    const response = await this.http.get(this.source, url.toString());
    if (response.notModified || response.body === null) {
      return [];
    }
    const parsedXml: unknown = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      trimValues: true,
      parseTagValue: false,
    }).parse(response.body);
    const feed = ArxivFeedSchema.parse(parsedXml);

    return asArray(feed.feed.entry).map((entry) => {
      const externalId = normalizeArxivId(entry.id);
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
      const externalIds = [
        externalId,
        ...(entry.doi === undefined ? [] : [`DOI:${entry.doi.toLowerCase()}`]),
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
        publishedAt: new Date(entry.published).toISOString(),
        retrievedAt: response.retrievedAt,
        accessLevel: "abstract",
        authors: asArray(entry.author).map((author) => author.name.trim()),
        institutions: [],
        abstract: normalizeWhitespace(entry.summary),
        content: null,
        relatedPaperIds: [],
        metadata: {
          updatedAt: new Date(entry.updated).toISOString(),
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
    });
  }
}
