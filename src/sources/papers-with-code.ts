import { parseHTML } from "linkedom";

import { SourceHttpClient } from "./http-client";
import { normalizeArxivIdentifier } from "./identifiers";
import { assertSafeOutboundUrl, type OutboundUrlPolicy } from "./outbound-url";
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
const PAPERS_WITH_CODE_POLICY: OutboundUrlPolicy = {
  allowedHosts: ["paperswithcode.co"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/"],
};

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function publishedAt(value: string | null | undefined): string | null {
  const normalized = normalizedText(value);
  if (normalized === null) return null;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00Z` : normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.sourceId = this.source.id;
    this.laneId = `${this.source.id}:page`;
  }

  async collect(window: CollectionWindow): Promise<RawPublicationCandidate[]> {
    return (await this.collectWithStats(window)).candidates;
  }

  async collectWithStats(
    window: CollectionWindow,
  ): Promise<{ candidates: RawPublicationCandidate[]; observed: number }> {
    const validWindow = CollectionWindowSchema.parse(window);
    if (!this.source.enabled) return { candidates: [], observed: 0 };
    const response = await this.http.get(this.source, PAPERS_WITH_CODE_URL, {
      headers: { accept: "text/html,application/xhtml+xml" },
      useValidators: false,
      urlPolicy: PAPERS_WITH_CODE_POLICY,
    });
    if (response.body === null) return { candidates: [], observed: 0 };
    const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
      throw new UnsupportedSourceMediaTypeError();
    }
    const finalUrl = assertSafeOutboundUrl(response.finalUrl, PAPERS_WITH_CODE_POLICY);
    if (
      finalUrl.origin !== PAPERS_WITH_CODE_ORIGIN ||
      finalUrl.pathname !== "/papers/recent"
    ) {
      return { candidates: [], observed: 0 };
    }
    const { document } = parseHTML(response.body);
    const rows = [...document.querySelectorAll("li")].slice(0, 100);
    const discovered = rows.flatMap((row): RawPublicationCandidate[] => {
      const paperLink = [...row.querySelectorAll("a[href]")].find((link) => {
        try {
          const url = assertSafeOutboundUrl(new URL(link.getAttribute("href") ?? "", finalUrl), PAPERS_WITH_CODE_POLICY);
          return url.origin === PAPERS_WITH_CODE_ORIGIN && paperIdentity(url.pathname) !== null;
        } catch { return false; }
      });
      if (paperLink === undefined) return [];
      const title = boundProviderText(paperLink.textContent, {
        maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
      });
      let paperUrl: URL;
      try { paperUrl = assertSafeOutboundUrl(new URL(paperLink.getAttribute("href") ?? "", finalUrl), PAPERS_WITH_CODE_POLICY); } catch { return []; }
      const identifier = paperIdentity(paperUrl.pathname);
      const time = row.querySelector("time");
      const date = publishedAt(time?.getAttribute("datetime") ?? time?.textContent);
      if (title === null || identifier === null || date === null) return [];
      return [RawPublicationCandidateSchema.parse({
        kind: "publication",
        sourceId: this.source.id,
        sourceName: this.source.canonicalName,
        sourceRole: this.source.role,
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
    if (response.body.trim().length > 0 && discovered.length === 0) {
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
      observed: rows.length,
    };
  }
}
