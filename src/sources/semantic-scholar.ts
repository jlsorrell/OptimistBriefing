import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "./identifiers";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
  type OutboundUrlPolicy,
} from "./outbound-url";
import {
  CollectionWindowSchema,
  RawItemSchema,
  RawResearchCandidateSchema,
  ResearchSourceRecordSchema,
  type CollectionWindow,
  type DiscoverySourceAdapter,
  type RawItem,
  type RawResearchCandidate,
  type ResearchEnricher,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

const AuthorSchema = z.object({
  authorId: z.string().nullable(),
  name: z.string().min(1),
  affiliations: z.array(z.string()).default([]),
});

const SemanticScholarPaperSchema = z
  .object({
    paperId: z.string().min(1),
    externalIds: z
      .object({
        ArXiv: z.string().optional(),
        DOI: z.string().optional(),
      })
      .passthrough(),
    title: z.string().min(1),
    citationCount: z.number().int().nonnegative().nullable(),
    influentialCitationCount: z.number().int().nonnegative().nullable(),
    authors: z.array(AuthorSchema),
    fieldsOfStudy: z.array(z.string()).nullable(),
  })
  .nullable();

const SemanticScholarResponseSchema = z.array(SemanticScholarPaperSchema);
const SEMANTIC_SCHOLAR_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["api.semanticscholar.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/graph/v1/paper/batch"],
};

const SEMANTIC_SCHOLAR_SEARCH_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["api.semanticscholar.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/graph/v1/paper/search/bulk"],
};

const SEMANTIC_SCHOLAR_RECOMMENDATIONS_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["api.semanticscholar.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/recommendations/v1/papers"],
};

const DISCOVERY_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "authors",
  "year",
  "publicationDate",
  "venue",
  "citationCount",
  "influentialCitationCount",
  "fieldsOfStudy",
  "url",
].join(",");

const SemanticScholarDiscoveryPaperSchema = z.object({
  paperId: z.string().min(1),
  externalIds: z
    .object({
      ArXiv: z.string().optional(),
      DOI: z.string().optional(),
    })
    .passthrough(),
  title: z.string().min(1),
  abstract: z.string().min(1).nullable(),
  authors: z.array(AuthorSchema),
  year: z.number().int().nullable(),
  publicationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  venue: z.string().nullable(),
  citationCount: z.number().int().nonnegative().nullable(),
  influentialCitationCount: z.number().int().nonnegative().nullable(),
  fieldsOfStudy: z.array(z.string().min(1)).nullable(),
  url: z.string().url(),
});

const SemanticScholarSearchResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  token: z.string().nullable().optional(),
  data: z.array(SemanticScholarDiscoveryPaperSchema),
});

const SemanticScholarRecommendationsResponseSchema = z.object({
  recommendedPapers: z.array(SemanticScholarDiscoveryPaperSchema),
});

export type SemanticScholarDiscoveryOptions =
  | {
      laneId: string;
      mode: "search";
      query: string;
    }
  | {
      laneId: string;
      mode: "recommendations";
      positivePaperIds: readonly string[];
    };

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function exactProviderEndpoint(
  value: string,
  policy: OutboundUrlPolicy,
  pathname: string,
): string {
  const endpoint = assertSafeOutboundUrl(value, policy);
  if (endpoint.pathname !== pathname) {
    throw new UnsafeOutboundUrlError("provider endpoint path is not pinned");
  }
  return endpoint.toString();
}

function dateOnlyIso(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export class SemanticScholarDiscoveryAdapter
implements DiscoverySourceAdapter {
  readonly discoveryFamily = "bibliographic" as const;
  readonly laneId: string;
  readonly sourceId: string;
  private readonly source: ResearchSourceRecord;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    private readonly options: SemanticScholarDiscoveryOptions,
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.sourceId = this.source.id;
    this.laneId = z.string().min(1).parse(options.laneId);
    if (options.mode === "search") {
      z.string().min(1).parse(options.query);
    } else {
      z.array(z.string().min(1)).min(1).max(100).parse(
        options.positivePaperIds,
      );
    }
  }

  async collect(window: CollectionWindow): Promise<RawItem[]> {
    if (!this.source.enabled) return [];
    const validWindow = CollectionWindowSchema.parse(window);
    const response = this.options.mode === "search"
      ? await this.search(validWindow)
      : await this.recommend();
    const papers = this.options.mode === "search"
      ? SemanticScholarSearchResponseSchema.parse(response.body).data
      : SemanticScholarRecommendationsResponseSchema.parse(response.body)
          .recommendedPapers;
    return papers
      .flatMap((paper) => {
        const publishedAt = dateOnlyIso(paper.publicationDate);
        return publishedAt !== null &&
          publishedAt >= validWindow.from &&
          publishedAt <= validWindow.to
          ? [this.toRawItem(paper, response.retrievedAt, publishedAt)]
          : [];
      })
      .slice(0, 100);
  }

  private async search(window: CollectionWindow): Promise<{
    body: unknown;
    retrievedAt: string;
  }> {
    if (this.options.mode !== "search") {
      throw new Error("Semantic Scholar discovery mode mismatch.");
    }
    const url = new URL(
      "https://api.semanticscholar.org/graph/v1/paper/search/bulk",
    );
    url.searchParams.set("query", this.options.query);
    url.searchParams.set("fields", DISCOVERY_FIELDS);
    url.searchParams.set(
      "publicationDateOrYear",
      `${window.from.slice(0, 10)}:${window.to.slice(0, 10)}`,
    );
    url.searchParams.set("sort", "publicationDate:desc");
    const response = await this.http.get(this.source, url.toString(), {
      useValidators: false,
      urlPolicy: SEMANTIC_SCHOLAR_SEARCH_POLICY,
    });
    return {
      body: JSON.parse(response.body ?? "null"),
      retrievedAt: response.retrievedAt,
    };
  }

  private async recommend(): Promise<{
    body: unknown;
    retrievedAt: string;
  }> {
    if (this.options.mode !== "recommendations") {
      throw new Error("Semantic Scholar discovery mode mismatch.");
    }
    const url = new URL(
      "https://api.semanticscholar.org/recommendations/v1/papers",
    );
    url.searchParams.set("fields", DISCOVERY_FIELDS);
    url.searchParams.set("limit", "100");
    const response = await this.http.postJson(
      this.source,
      url.toString(),
      {
        positivePaperIds: [...this.options.positivePaperIds],
        negativePaperIds: [],
      },
      { urlPolicy: SEMANTIC_SCHOLAR_RECOMMENDATIONS_POLICY },
    );
    return {
      body: JSON.parse(response.body ?? "null"),
      retrievedAt: response.retrievedAt,
    };
  }

  private toRawItem(
    paper: z.infer<typeof SemanticScholarDiscoveryPaperSchema>,
    retrievedAt: string,
    publishedAt: string,
  ): RawItem {
    const arxiv = paper.externalIds.ArXiv === undefined
      ? null
      : normalizeArxivIdentifier(paper.externalIds.ArXiv);
    const doi = paper.externalIds.DOI === undefined
      ? null
      : normalizeDoi(paper.externalIds.DOI);
    const semanticScholarId = `SemanticScholar:${paper.paperId}`;
    const externalIds = unique([
      semanticScholarId,
      ...(arxiv === null ? [] : [arxiv]),
      ...(doi === null ? [] : [`DOI:${doi}`]),
    ]);
    return RawItemSchema.parse({
      kind: "paper",
      sourceId: this.source.id,
      sourceName: this.source.canonicalName,
      sourceRole: this.source.role,
      title: paper.title.replace(/\s+/g, " ").trim(),
      originalUrl: paper.url,
      externalId: arxiv ?? (doi === null ? semanticScholarId : `DOI:${doi}`),
      externalIds,
      publishedAt,
      retrievedAt,
      accessLevel: paper.abstract === null ? "metadata" : "abstract",
      authors: paper.authors.map(({ name }) => name),
      institutions: [],
      abstract: paper.abstract,
      content: null,
      relatedPaperIds: [],
      metadata: {
        discoveryFamily: "bibliographic",
        semanticScholarId: paper.paperId,
        year: paper.year,
        venue: paper.venue?.trim() || null,
        citationCount: paper.citationCount,
        influentialCitationCount: paper.influentialCitationCount,
        topics: paper.fieldsOfStudy ?? [],
      },
    });
  }
}

export class SemanticScholarAdapter implements ResearchEnricher {
  readonly sourceId: string;
  private readonly source: ResearchSourceRecord;
  private readonly endpoint: string;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    endpoint = "https://api.semanticscholar.org/graph/v1/paper/batch",
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.sourceId = this.source.id;
    this.endpoint = exactProviderEndpoint(
      endpoint,
      SEMANTIC_SCHOLAR_POLICY,
      "/graph/v1/paper/batch",
    );
  }

  async enrich(
    candidates: readonly RawResearchCandidate[],
  ): Promise<RawResearchCandidate[]> {
    if (!this.source.enabled) {
      return [...candidates];
    }
    const arxivIds = unique(
      candidates.flatMap((candidate) => {
        if (candidate.kind !== "paper") {
          return [];
        }
        const arxiv = candidate.externalIds.find((id) =>
          id.startsWith("arXiv:"),
        );
        return arxiv === undefined ? [] : [arxiv];
      }),
    );
    if (arxivIds.length === 0) {
      return [...candidates];
    }

    const enrichments = new Map<
      string,
      {
        paper: NonNullable<z.infer<typeof SemanticScholarPaperSchema>>;
        retrievedAt: string;
      }
    >();
    for (const batch of chunks(arxivIds, 100)) {
      const ids = batch.map(
        (arxiv) => `ARXIV:${arxiv.slice("arXiv:".length)}`,
      );
      const url = new URL(this.endpoint);
      url.searchParams.set(
        "fields",
        [
          "paperId",
          "externalIds",
          "title",
          "citationCount",
          "influentialCitationCount",
          "authors",
          "fieldsOfStudy",
        ].join(","),
      );
      const response = await this.http.postJson(
        this.source,
        url.toString(),
        { ids },
        { urlPolicy: SEMANTIC_SCHOLAR_POLICY },
      );
      if (response.body === null) {
        continue;
      }
      const parsed = SemanticScholarResponseSchema.parse(
        JSON.parse(response.body),
      );
      parsed.forEach((paper) => {
        if (paper?.externalIds.ArXiv !== undefined) {
          const arxivId = normalizeArxivIdentifier(
            paper.externalIds.ArXiv,
          );
          if (arxivId !== null) {
            enrichments.set(arxivId, {
              paper,
              retrievedAt: response.retrievedAt,
            });
          }
        }
      });
    }

    return candidates.map((candidate) => {
      const enrichment = enrichments.get(candidate.externalId);
      if (enrichment === undefined) {
        return candidate;
      }
      const { paper } = enrichment;
      const doi =
        paper.externalIds.DOI === undefined
          ? null
          : normalizeDoi(paper.externalIds.DOI);
      const affiliations = paper.authors.flatMap(
        (author) => author.affiliations,
      );
      return RawResearchCandidateSchema.parse({
        ...candidate,
        authors:
          paper.authors.length === 0
            ? candidate.authors
            : paper.authors.map((author) => author.name),
        institutions: unique([...candidate.institutions, ...affiliations]),
        externalIds: unique([
          ...candidate.externalIds,
          `SemanticScholar:${paper.paperId}`,
          ...(doi === null ? [] : [`DOI:${doi}`]),
        ]),
        citationCount: paper.citationCount ?? candidate.citationCount,
        influentialCitationCount:
          paper.influentialCitationCount ??
          candidate.influentialCitationCount,
        topics: unique([
          ...candidate.topics,
          ...(paper.fieldsOfStudy ?? []),
        ]),
        metadata: {
          ...candidate.metadata,
          semanticScholarRetrievedAt: enrichment.retrievedAt,
        },
      });
    });
  }
}
