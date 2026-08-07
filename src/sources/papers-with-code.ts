import { parseHTML } from "linkedom";

import { SourceHttpClient } from "./http-client";
import { normalizeArxivIdentifier } from "./identifiers";
import { assertSafeOutboundUrl, type OutboundUrlPolicy } from "./outbound-url";
import { normalizeProviderText } from "./provider-text";
import {
  CollectionWindowSchema,
  RawPublicationCandidateSchema,
  type CollectionWindow,
  type RawPublicationCandidate,
  type ResearchSourceInput,
  type ResearchSourceRecord,
  ResearchSourceRecordSchema,
} from "./types";

const PAPERS_WITH_CODE_ORIGIN = "https://paperswithcode.co";
const PAPERS_WITH_CODE_URL = `${PAPERS_WITH_CODE_ORIGIN}/?order_by=date_published`;
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

function articlePublishedAt(article: Element): string | null {
  const time = article.querySelector("time");
  const structured = publishedAt(
    time?.getAttribute("datetime") ?? time?.textContent,
  );
  if (structured !== null) return structured;
  for (const paragraph of article.querySelectorAll("p")) {
    const match = /^Trending research\s*·\s*(\d{4}-\d{2}-\d{2})$/i.exec(
      normalizedText(paragraph.textContent) ?? "",
    );
    if (match?.[1] !== undefined) return publishedAt(match[1]);
  }
  return null;
}

function paperIdentity(pathname: string): string | null {
  const match = /^\/paper\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1] === undefined) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(match[1]); } catch { return null; }
  if (!/^[A-Za-z0-9._-]+$/.test(decoded)) return null;
  return normalizeArxivIdentifier(decoded) ?? `papers-with-code:${decoded}`;
}

function relevantPaperArticles(document: Document): Element[] {
  const heading = [...document.querySelectorAll("h1,h2,h3")].find((element) =>
    normalizedText(element.textContent)?.toLocaleLowerCase("en-US") === "relevant papers",
  );
  const region = heading?.parentElement ?? document.body;
  return [...region.querySelectorAll("article")];
}

function identifiableCodeLink(article: Element): boolean {
  return [...article.querySelectorAll("a[href]")].some((link) => {
    const href = link.getAttribute("href") ?? "";
    return /^https:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)\//i.test(href);
  });
}

export class PapersWithCodeAdapter {
  readonly sourceId: string;
  readonly laneId: string;
  readonly discoveryFamily = "commentary" as const;
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
    const validWindow = CollectionWindowSchema.parse(window);
    if (!this.source.enabled) return [];
    const response = await this.http.get(this.source, PAPERS_WITH_CODE_URL, {
      headers: { accept: "text/html,application/xhtml+xml" },
      useValidators: false,
      urlPolicy: PAPERS_WITH_CODE_POLICY,
    });
    if (response.body === null) return [];
    const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") return [];
    const finalUrl = assertSafeOutboundUrl(response.finalUrl, PAPERS_WITH_CODE_POLICY);
    if (finalUrl.origin !== PAPERS_WITH_CODE_ORIGIN || finalUrl.pathname !== "/") return [];
    const { document } = parseHTML(response.body);
    return relevantPaperArticles(document).flatMap((article): RawPublicationCandidate[] => {
      const paperLink = [...article.querySelectorAll("a[href]")].find((link) => {
        try {
          const url = assertSafeOutboundUrl(new URL(link.getAttribute("href") ?? "", finalUrl), PAPERS_WITH_CODE_POLICY);
          return url.origin === PAPERS_WITH_CODE_ORIGIN && paperIdentity(url.pathname) !== null;
        } catch { return false; }
      });
      if (paperLink === undefined) return [];
      const title = normalizeProviderText(paperLink.textContent);
      let paperUrl: URL;
      try { paperUrl = assertSafeOutboundUrl(new URL(paperLink.getAttribute("href") ?? "", finalUrl), PAPERS_WITH_CODE_POLICY); } catch { return []; }
      const identifier = paperIdentity(paperUrl.pathname);
      const date = articlePublishedAt(article);
      if (title === null || identifier === null || date === null || date < validWindow.from || date > validWindow.to) return [];
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
        discoveryFamily: "commentary",
        metadata: {
          implementationAvailable: identifiableCodeLink(article),
          canCorroborateFacts: false,
          contentUse: "discovery-metadata-only",
          retention: "metadata-only",
          discoveryMechanism: "page",
          discoveryLaneIds: [this.laneId],
        },
      })];
    }).slice(0, 100);
  }
}
