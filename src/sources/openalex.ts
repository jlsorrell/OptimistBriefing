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
const OPENALEX_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["api.openalex.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/works"],
};

const OPENALEX_DISCOVERY_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["api.openalex.org"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/institutions", "/works"],
};

const OPENALEX_DISCOVERY_FIELDS =
  "id,doi,title,publication_date,updated_date,cited_by_count,ids,authorships,topics,abstract_inverted_index,primary_location";

const OpenAlexInstitutionSearchResponseSchema = z.object({
  results: z.array(OpenAlexInstitutionSchema),
});

const OpenAlexDiscoveryWorkSchema = OpenAlexWorkSchema.extend({
  publication_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updated_date: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  abstract_inverted_index: z
    .record(z.string(), z.array(z.number().int().nonnegative()))
    .nullable(),
  primary_location: z
    .object({
      landing_page_url: z.string().url().nullable().optional(),
      source: z
        .object({ display_name: z.string().min(1).nullable().optional() })
        .nullable()
        .optional(),
    })
    .nullable(),
});

const OpenAlexDiscoveryResponseSchema = z.object({
  results: z.array(OpenAlexDiscoveryWorkSchema),
});

export type OpenAlexDiscoveryOptions =
  | {
      laneId: string;
      mode: "text";
      query: string;
    }
  | {
      laneId: string;
      mode: "institutions";
      institutionNames: readonly string[];
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

function doiFromExternalIds(externalIds: readonly string[]): string | null {
  const doi = externalIds.find((id) => id.startsWith("DOI:"));
  return doi === undefined ? null : normalizeDoi(doi);
}

function arxivFromExternalIds(
  externalIds: readonly string[],
): string | null {
  const arxiv = externalIds.find((id) =>
    id.toLowerCase().startsWith("arxiv:"),
  );
  return arxiv === undefined ? null : normalizeArxivIdentifier(arxiv);
}

function openAlexIdentifier(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
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

function dateOnlyIso(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function normalizedExactName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null,
): string | null {
  if (invertedIndex === null) return null;
  const positions = Object.values(invertedIndex).flat();
  if (positions.length === 0) return null;
  const words = Array<string>(Math.max(...positions) + 1).fill("");
  for (const [word, indexes] of Object.entries(invertedIndex)) {
    for (const index of indexes) words[index] = word;
  }
  const abstract = words.join(" ").replace(/\s+/g, " ").trim();
  return abstract.length === 0 ? null : abstract;
}

export class OpenAlexDiscoveryAdapter implements DiscoverySourceAdapter {
  readonly discoveryFamily = "bibliographic" as const;
  readonly laneId: string;
  readonly sourceId: string;
  private readonly source: ResearchSourceRecord;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    private readonly options: OpenAlexDiscoveryOptions,
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.sourceId = this.source.id;
    this.laneId = z.string().min(1).parse(options.laneId);
    if (options.mode === "text") {
      z.string().min(1).parse(options.query);
    } else {
      z.array(z.string().min(1)).min(1).max(100).parse(
        options.institutionNames,
      );
    }
  }

  async collect(window: CollectionWindow): Promise<RawItem[]> {
    if (!this.source.enabled) return [];
    const validWindow = CollectionWindowSchema.parse(window);
    const institutionIds = this.options.mode === "institutions"
      ? await this.resolveInstitutionIds()
      : [];
    if (
      this.options.mode === "institutions" &&
      institutionIds.length === 0
    ) {
      return [];
    }
    const to = Date.parse(validWindow.to);
    const sevenDaysBefore = to - 7 * 24 * 60 * 60 * 1_000;
    const localFrom = new Date(
      Math.max(Date.parse(validWindow.from), sevenDaysBefore),
    ).toISOString();
    const url = new URL("https://api.openalex.org/works");
    const filters = [
      `from_publication_date:${localFrom.slice(0, 10)}`,
      `to_publication_date:${validWindow.to.slice(0, 10)}`,
    ];
    if (this.options.mode === "text") {
      url.searchParams.set("search", this.options.query);
    } else {
      filters.unshift(
        `authorships.institutions.id:${institutionIds.join("|")}`,
      );
    }
    url.searchParams.set("filter", filters.join(","));
    url.searchParams.set("select", OPENALEX_DISCOVERY_FIELDS);
    url.searchParams.set("sort", "publication_date:desc");
    url.searchParams.set("per-page", "100");
    const response = await this.http.get(this.source, url.toString(), {
      useValidators: false,
      urlPolicy: OPENALEX_DISCOVERY_POLICY,
    });
    const parsed = OpenAlexDiscoveryResponseSchema.parse(
      JSON.parse(response.body ?? "null"),
    );
    return parsed.results
      .filter((work) => {
        const published = Date.parse(dateOnlyIso(work.publication_date));
        const updated = Date.parse(work.updated_date);
        return [published, updated].some(
          (timestamp) => timestamp >= Date.parse(localFrom) && timestamp <= to,
        );
      })
      .slice(0, 100)
      .map((work) => this.toRawItem(work, response.retrievedAt));
  }

  private async resolveInstitutionIds(): Promise<string[]> {
    if (this.options.mode !== "institutions") return [];
    const resolved = new Map<string, string | null>();
    for (const name of unique(this.options.institutionNames)) {
      const key = normalizedExactName(name);
      if (resolved.has(key)) continue;
      const url = new URL("https://api.openalex.org/institutions");
      url.searchParams.set("search", name);
      url.searchParams.set("select", "id,display_name");
      url.searchParams.set("per-page", "100");
      const response = await this.http.get(this.source, url.toString(), {
        useValidators: false,
        urlPolicy: OPENALEX_DISCOVERY_POLICY,
      });
      const parsed = OpenAlexInstitutionSearchResponseSchema.parse(
        JSON.parse(response.body ?? "null"),
      );
      const match = parsed.results.find(
        ({ display_name }) => normalizedExactName(display_name) === key,
      );
      resolved.set(
        key,
        match === undefined ? null : openAlexIdentifier(match.id),
      );
    }
    return unique(
      [...resolved.values()].filter((id): id is string => id !== null),
    );
  }

  private toRawItem(
    work: z.infer<typeof OpenAlexDiscoveryWorkSchema>,
    retrievedAt: string,
  ): RawItem {
    const doi = work.doi === null ? null : normalizeDoi(work.doi);
    const arxiv = work.ids.arxiv === undefined
      ? null
      : normalizeArxivIdentifier(work.ids.arxiv);
    const openAlexId = openAlexIdentifier(work.id);
    const abstract = reconstructAbstract(work.abstract_inverted_index);
    const landingPageUrl = work.primary_location?.landing_page_url ?? null;
    return RawItemSchema.parse({
      kind: "paper",
      sourceId: this.source.id,
      sourceName: this.source.canonicalName,
      sourceRole: this.source.role,
      title: work.title.replace(/\s+/g, " ").trim(),
      originalUrl:
        doi === null
          ? landingPageUrl ?? work.id
          : `https://doi.org/${doi}`,
      externalId:
        arxiv ?? (doi === null ? `OpenAlex:${openAlexId}` : `DOI:${doi}`),
      externalIds: unique([
        `OpenAlex:${openAlexId}`,
        ...(arxiv === null ? [] : [arxiv]),
        ...(doi === null ? [] : [`DOI:${doi}`]),
      ]),
      publishedAt: dateOnlyIso(work.publication_date),
      retrievedAt,
      accessLevel: abstract === null ? "metadata" : "abstract",
      authors: work.authorships.map(({ author }) => author.display_name),
      institutions: work.authorships.flatMap(({ institutions }) =>
        institutions.map(({ display_name }) => display_name),
      ),
      abstract,
      content: null,
      relatedPaperIds: [],
      metadata: {
        discoveryFamily: "bibliographic",
        openAlexId: work.id,
        updatedAt: new Date(work.updated_date).toISOString(),
        venue: work.primary_location?.source?.display_name ?? null,
        citationCount: work.cited_by_count,
        influentialCitationCount: null,
        topics: work.topics.map(({ display_name }) => display_name),
      },
    });
  }
}

export class OpenAlexAdapter implements ResearchEnricher {
  readonly sourceId: string;
  private readonly source: ResearchSourceRecord;
  private readonly endpoint: string;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    endpoint = "https://api.openalex.org/works",
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.sourceId = this.source.id;
    this.endpoint = exactProviderEndpoint(
      endpoint,
      OPENALEX_POLICY,
      "/works",
    );
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
      const response = await this.http.get(this.source, url.toString(), {
        urlPolicy: OPENALEX_POLICY,
      });
      if (response.body === null) {
        continue;
      }
      const parsed = OpenAlexResponseSchema.parse(JSON.parse(response.body));
      parsed.results.forEach((work) => {
        const enrichment = {
          work,
          retrievedAt: response.retrievedAt,
        };
        const doi = work.doi === null ? null : normalizeDoi(work.doi);
        if (doi !== null) {
          enrichments.set(`DOI:${doi}`, enrichment);
        }
        const arxiv =
          work.ids.arxiv === undefined
            ? null
            : normalizeArxivIdentifier(work.ids.arxiv);
        if (arxiv !== null) {
          enrichments.set(arxiv, enrichment);
        }
      });
    }

    return candidates.map((candidate) => {
      const doi = doiFromExternalIds(candidate.externalIds);
      const arxiv = arxivFromExternalIds(candidate.externalIds);
      const enrichment =
        (doi === null ? undefined : enrichments.get(`DOI:${doi}`)) ??
        (arxiv === null ? undefined : enrichments.get(arxiv));
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
