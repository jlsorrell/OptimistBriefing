import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import {
  RawResearchCandidateSchema,
  ResearchSourceRecordSchema,
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

export class SemanticScholarAdapter implements ResearchEnricher {
  private readonly source: ResearchSourceRecord;
  private readonly endpoint: string;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    endpoint = "https://api.semanticscholar.org/graph/v1/paper/batch",
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.endpoint = z.string().url().parse(endpoint);
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
      const response = await this.http.postJson(this.source, url.toString(), {
        ids,
      });
      if (response.body === null) {
        continue;
      }
      const parsed = SemanticScholarResponseSchema.parse(
        JSON.parse(response.body),
      );
      parsed.forEach((paper) => {
        if (paper?.externalIds.ArXiv !== undefined) {
          enrichments.set(`arXiv:${paper.externalIds.ArXiv}`, {
            paper,
            retrievedAt: response.retrievedAt,
          });
        }
      });
    }

    return candidates.map((candidate) => {
      const enrichment = enrichments.get(candidate.externalId);
      if (enrichment === undefined) {
        return candidate;
      }
      const { paper } = enrichment;
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
          ...(paper.externalIds.DOI === undefined
            ? []
            : [`DOI:${paper.externalIds.DOI.toLowerCase()}`]),
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
