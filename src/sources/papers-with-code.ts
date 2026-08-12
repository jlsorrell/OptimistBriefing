import { parseHTML } from "linkedom";

import { exactCalendarTimestamp } from "./calendar-date";
import { SourceHttpClient } from "./http-client";
import { normalizeArxivIdentifier } from "./identifiers";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
  type OutboundUrlPolicy,
} from "./outbound-url";
import { boundProviderText } from "./provider-text";
import {
  CollectionWindowSchema,
  MAX_PROVIDER_TITLE_CHARACTERS,
  RawPublicationCandidateSchema,
  type CollectionWindow,
  type RawPublicationCandidate,
  type ResearchSourceInput,
  type ResearchSourceRecord,
  ResearchSourceRecordSchema,
  UnsupportedSourceMediaTypeError,
} from "./types";

const PAPERS_WITH_CODE_ORIGIN = "https://paperswithcode.co";
const PAPERS_WITH_CODE_URL = `${PAPERS_WITH_CODE_ORIGIN}/papers/recent`;

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function publishedAt(value: string | null | undefined): string | null {
  const normalized = normalizedText(value);
  return normalized === null ? null : exactCalendarTimestamp(normalized);
}

function paperIdentity(pathname: string): string | null {
  const match = /^\/paper\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1] === undefined) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(match[1]); } catch { return null; }
  if (!/^[A-Za-z0-9._-]+$/.test(decoded)) return null;
  return normalizeArxivIdentifier(decoded) ?? `papers-with-code:${decoded}`;
}

function identifiableCodeLink(row: Element): boolean {
  return [...row.querySelectorAll("a[href]")].some((link) => {
    const href = link.getAttribute("href") ?? "";
    return /^https:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)\//i.test(href);
  });
}

export class PapersWithCodeAdapter {
  readonly sourceId: string;
  readonly laneId: string;
  readonly discoveryFamily = "official-publication" as const;
  private readonly source: ResearchSourceRecord;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    private readonly listingUrl: string,
    private readonly listingUrlPolicy: OutboundUrlPolicy,
    private readonly articleUrlPolicy: OutboundUrlPolicy,
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.sourceId = this.source.id;
    this.laneId = `${this.source.id}:page`;
    const endpoint = assertSafeOutboundUrl(listingUrl, listingUrlPolicy);
    if (endpoint.toString() !== PAPERS_WITH_CODE_URL) {
      throw new UnsafeOutboundUrlError(
        "Papers with Code endpoint is not the reviewed endpoint",
      );
    }
  }

  async collect(window: CollectionWindow): Promise<RawPublicationCandidate[]> {
    return (await this.collectWithStats(window)).candidates;
  }

  async collectWithStats(
    window: CollectionWindow,
  ): Promise<{ candidates: RawPublicationCandidate[]; observed: number }> {
    const validWindow = CollectionWindowSchema.parse(window);
    if (!this.source.enabled) return { candidates: [], observed: 0 };
    const response = await this.http.get(this.source, this.listingUrl, {
      headers: { accept: "text/html,application/xhtml+xml" },
      useValidators: false,
      urlPolicy: this.listingUrlPolicy,
    });
    const finalUrl = assertSafeOutboundUrl(
      response.finalUrl,
      this.listingUrlPolicy,
    );
    if (finalUrl.toString() !== PAPERS_WITH_CODE_URL) {
      throw new UnsafeOutboundUrlError(
        "Papers with Code final endpoint is not the reviewed endpoint",
      );
    }
    if (response.body === null) return { candidates: [], observed: 0 };
    const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
      throw new UnsupportedSourceMediaTypeError();
    }
    const { document } = parseHTML(response.body);
    const rows = [...document.querySelectorAll("li")].slice(0, 100);
    const discovered = rows.flatMap((row): RawPublicationCandidate[] => {
      const paperLink = [...row.querySelectorAll("a[href]")].find((link) => {
        try {
          const url = assertSafeOutboundUrl(
            new URL(link.getAttribute("href") ?? "", finalUrl),
            this.articleUrlPolicy,
          );
          return url.origin === PAPERS_WITH_CODE_ORIGIN && paperIdentity(url.pathname) !== null;
        } catch { return false; }
      });
      if (paperLink === undefined) return [];
      const title = boundProviderText(paperLink.textContent, {
        maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
      });
      let paperUrl: URL;
      try {
        paperUrl = assertSafeOutboundUrl(
          new URL(paperLink.getAttribute("href") ?? "", finalUrl),
          this.articleUrlPolicy,
        );
      } catch { return []; }
      const identifier = paperIdentity(paperUrl.pathname);
      const time = row.querySelector("time");
      const date = publishedAt(time?.getAttribute("datetime") ?? time?.textContent);
      if (title === null || identifier === null || date === null) return [];
      return [RawPublicationCandidateSchema.parse({
        kind: "publication",
        sourceId: this.source.id,
        sourceName: this.source.canonicalName,
        sourceRole: "blog",
        title,
        originalUrl: paperUrl.toString(),
        externalId: identifier,
        externalIds: [identifier],
        publishedAt: date,
        retrievedAt: response.retrievedAt,
        accessLevel: "metadata",
        authors: [],
        institutions: [],
        abstract: null,
        content: null,
        relatedPaperIds: [identifier],
        sectionEligibility: this.source.sectionEligibility ?? ["research", "research_radar"],
        discoveryFamily: "official-publication",
        metadata: {
          implementationAvailable: identifiableCodeLink(row),
          canCorroborateFacts: false,
          contentUse: "discovery-metadata-only",
          retention: "metadata-only",
          discoveryMechanism: "page",
          discoveryLaneIds: [this.laneId],
        },
      })];
    });
    if (response.body.length > 0 && discovered.length === 0) {
      throw new SyntaxError("Papers with Code recent-paper list was not interpretable.");
    }
    return {
      candidates: discovered
        .filter((candidate): candidate is RawPublicationCandidate & {
          publishedAt: string;
        } => candidate.publishedAt !== null &&
          candidate.publishedAt >= validWindow.from &&
          candidate.publishedAt <= validWindow.to)
        .slice(0, 100),
      observed: discovered.length,
    };
  }
}
