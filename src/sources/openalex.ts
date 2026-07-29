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

const OpenAlexInstitutionSchema = z.object({
  id: z.string().url(),
  display_name: z.string().min(1),
});

const OpenAlexAuthorshipSchema = z.object({
  author: z.object({
    id: z.string().url(),
    display_name: z.string().min(1),
  }),
  institutions: z.array(OpenAlexInstitutionSchema),
});

const OpenAlexWorkSchema = z.object({
  id: z.string().url(),
  doi: z.string().url().nullable(),
  title: z.string().min(1),
  cited_by_count: z.number().int().nonnegative(),
  ids: z
    .object({
      openalex: z.string().url(),
      doi: z.string().url().optional(),
      arxiv: z.string().url().optional(),
    })
    .passthrough(),
  authorships: z.array(OpenAlexAuthorshipSchema),
  topics: z.array(
    z.object({
      display_name: z.string().min(1),
      score: z.number().min(0).max(1),
    }),
  ),
});

const OpenAlexResponseSchema = z.object({
  results: z.array(OpenAlexWorkSchema),
});

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

function doiFromExternalIds(externalIds: readonly string[]): string | null {
  const doi = externalIds.find((id) => id.startsWith("DOI:"));
  return doi?.slice("DOI:".length).toLowerCase() ?? null;
}

function openAlexIdentifier(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

export class OpenAlexAdapter implements ResearchEnricher {
  private readonly source: ResearchSourceRecord;
  private readonly endpoint: string;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    endpoint = "https://api.openalex.org/works",
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
    const paperDois = candidates.flatMap((candidate) => {
      if (candidate.kind !== "paper") {
        return [];
      }
      const doi = doiFromExternalIds(candidate.externalIds);
      return doi === null ? [] : [doi];
    });
    if (paperDois.length === 0) {
      return [...candidates];
    }

    const enrichments = new Map<
      string,
      {
        work: z.infer<typeof OpenAlexWorkSchema>;
        retrievedAt: string;
      }
    >();
    for (const batch of chunks([...new Set(paperDois)], 50)) {
      const url = new URL(this.endpoint);
      url.searchParams.set("filter", `doi:${batch.join("|")}`);
      url.searchParams.set(
        "select",
        "id,doi,title,cited_by_count,ids,authorships,topics",
      );
      url.searchParams.set("per-page", "50");
      const response = await this.http.get(this.source, url.toString());
      if (response.body === null) {
        continue;
      }
      const parsed = OpenAlexResponseSchema.parse(JSON.parse(response.body));
      parsed.results.forEach((work) => {
        if (work.doi !== null) {
          enrichments.set(
            decodeURIComponent(work.doi.replace(/^https?:\/\/doi\.org\//i, ""))
              .toLowerCase(),
            {
              work,
              retrievedAt: response.retrievedAt,
            },
          );
        }
      });
    }

    return candidates.map((candidate) => {
      const doi = doiFromExternalIds(candidate.externalIds);
      const enrichment = doi === null ? undefined : enrichments.get(doi);
      if (enrichment === undefined) {
        return candidate;
      }
      const { work } = enrichment;
      const institutions = work.authorships.flatMap((authorship) =>
        authorship.institutions.map((institution) => institution.display_name),
      );
      return RawResearchCandidateSchema.parse({
        ...candidate,
        institutions: unique([...candidate.institutions, ...institutions]),
        externalIds: unique([
          ...candidate.externalIds,
          `OpenAlex:${openAlexIdentifier(work.id)}`,
        ]),
        citationCount: Math.max(
          candidate.citationCount ?? 0,
          work.cited_by_count,
        ),
        topics: unique([
          ...candidate.topics,
          ...work.topics.map((topic) => topic.display_name),
        ]),
        metadata: {
          ...candidate.metadata,
          openAlexId: work.id,
          openAlexRetrievedAt: enrichment.retrievedAt,
        },
      });
    });
  }
}
