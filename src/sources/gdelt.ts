import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import { assertSafeOutboundUrl } from "./outbound-url";
import {
  CollectionWindowSchema,
  RawNewsCandidateSchema,
  ResearchSourceRecordSchema,
  type CollectionWindow,
  type NewsSourceAdapter,
  type RawNewsCandidate,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

const GDELT_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_URL_POLICY = {
  allowedHosts: ["api.gdeltproject.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/api/v2/doc/doc"],
} as const;

const GdeltArticleSchema = z.object({
  url: z.string().url(),
  title: z.string().trim().min(1),
  seendate: z.string().regex(/^\d{8}T\d{6}Z$/),
  domain: z.string().trim().min(1),
  language: z.string().trim().min(1),
  sourcecountry: z.string().trim().min(1),
}).passthrough();

const GdeltResponseSchema = z.object({
  articles: z.array(GdeltArticleSchema),
});

const GdeltOptionsSchema = z.object({
  query: z.string().trim().min(1),
  maxRecords: z.number().int().min(1).max(250),
});

type GdeltOptions = z.input<typeof GdeltOptionsSchema>;

function gdeltTimestamp(value: string): string {
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(9, 11);
  const minute = value.slice(11, 13);
  const second = value.slice(13, 15);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

function queryTimestamp(value: string): string {
  const date = new Date(value);
  const component = (part: number) => String(part).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    component(date.getUTCMonth() + 1),
    component(date.getUTCDate()),
    component(date.getUTCHours()),
    component(date.getUTCMinutes()),
    component(date.getUTCSeconds()),
  ].join("");
}

export class GdeltAdapter implements NewsSourceAdapter {
  private readonly source: ResearchSourceRecord;
  private readonly options: z.output<typeof GdeltOptionsSchema>;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    options: GdeltOptions,
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.options = GdeltOptionsSchema.parse(options);
  }

  async collect(window: CollectionWindow): Promise<RawNewsCandidate[]> {
    if (!this.source.enabled) return [];
    const validWindow = CollectionWindowSchema.parse(window);
    const endpoint = new URL(GDELT_ENDPOINT);
    endpoint.searchParams.set("query", this.options.query);
    endpoint.searchParams.set("mode", "ArtList");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set(
      "maxrecords",
      String(this.options.maxRecords),
    );
    endpoint.searchParams.set(
      "startdatetime",
      queryTimestamp(validWindow.from),
    );
    endpoint.searchParams.set(
      "enddatetime",
      queryTimestamp(validWindow.to),
    );
    const response = await this.http.get(
      this.source,
      endpoint.toString(),
      {
        headers: { accept: "application/json" },
        useValidators: false,
        urlPolicy: GDELT_URL_POLICY,
      },
    );
    if (response.body === null) return [];
    const parsed = GdeltResponseSchema.parse(JSON.parse(response.body));

    return parsed.articles.flatMap((article): RawNewsCandidate[] => {
      let originalUrl: string;
      try {
        originalUrl = assertSafeOutboundUrl(article.url).toString();
      } catch {
        return [];
      }
      const seenAt = gdeltTimestamp(article.seendate);
      if (seenAt < validWindow.from || seenAt > validWindow.to) {
        return [];
      }
      return [
        RawNewsCandidateSchema.parse({
          kind: "article",
          sourceId: this.source.id,
          sourceName: this.source.canonicalName,
          sourceRole: this.source.role,
          title: article.title.replace(/\s+/g, " ").trim(),
          originalUrl,
          externalId: originalUrl,
          externalIds: [originalUrl],
          publishedAt: null,
          retrievedAt: response.retrievedAt,
          accessLevel: "metadata",
          authors: [],
          institutions: [],
          abstract: null,
          content: null,
          relatedPaperIds: [],
          canCorroborateFacts: false,
          metadata: {
            discoveryOnly: true,
            discoveryProvider: "GDELT",
            seenAt,
            publisherDomain: article.domain,
            language: article.language,
            sourceCountry: article.sourcecountry,
          },
        }),
      ];
    });
  }
}
