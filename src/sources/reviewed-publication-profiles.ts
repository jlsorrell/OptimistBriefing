import { boundProviderText } from "./provider-text";
import {
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  MAX_PROVIDER_TITLE_CHARACTERS,
} from "./types";

export const REVIEWED_PUBLICATION_PROFILE_IDS = [
  "anthropic",
  "google-deepmind",
  "google-research",
] as const;

type ReviewedPublicationProfileId =
  (typeof REVIEWED_PUBLICATION_PROFILE_IDS)[number];

export type ReviewedPublicationListingEntry = {
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string | null;
  category: string | null;
  authors: string[];
};

export type ReviewedPublicationProfile = {
  maxListingEntries: 20;
  maxDetailFetches: 5;
  parseListing(
    document: Document,
    baseUrl: string,
  ): ReviewedPublicationListingEntry[];
  parseDetailPublishedAt(document: Document): string | null;
};

function providerTitle(value: string | null | undefined): string | null {
  return boundProviderText(value, {
    stripHtml: true,
    maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
  });
}

function providerEvidence(value: string | null | undefined): string | null {
  return boundProviderText(value, {
    stripHtml: true,
    maxCharacters: MAX_PROVIDER_EVIDENCE_CHARACTERS,
  });
}

function exactCalendarDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw);
  if (day !== null) {
    const [year, month, date] = day.slice(1).map(Number);
    const calendar = new Date(Date.UTC(year!, month! - 1, date!));
    if (
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month! - 1 ||
      calendar.getUTCDate() !== date
    ) return null;
    const timestamp = Date.parse(raw);
    if (raw.length > 10 && !Number.isFinite(timestamp)) return null;
    return Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : `${raw.slice(0, 10)}T00:00:00.000Z`;
  }
  if (!/[A-Za-z]+\s+\d{1,2}(?:,|\s)\s*\d{4}/.test(raw)) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function resolvedUrl(value: string | null, baseUrl: string): string | null {
  if (value === null || value.length === 0) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function timeValue(element: Element | null): string | null {
  if (element === null) return null;
  return element.getAttribute("datetime") ?? element.textContent;
}

function directChildren(element: Element, selector: string): Element[] {
  return Array.from(element.children).filter((child) => child.matches(selector));
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function detailDateFromJsonLd(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = detailDateFromJsonLd(entry);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record["@graph"])) {
    const found = detailDateFromJsonLd(record["@graph"]);
    if (found !== null) return found;
  }
  const types = Array.isArray(record["@type"])
    ? record["@type"]
    : [record["@type"]];
  if (
    !types.some((type) => type === "BlogPosting" || type === "NewsArticle")
  ) return null;
  return exactCalendarDate(
    typeof record.datePublished === "string" ? record.datePublished : null,
  );
}

function detailPublishedAt(document: Document): string | null {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const found = detailDateFromJsonLd(JSON.parse(script.textContent));
      if (found !== null) return found;
    } catch {
      // A malformed JSON-LD sibling does not hide an ordinary exact time value.
    }
  }
  return exactCalendarDate(timeValue(document.querySelector("time[datetime]")));
}

function anthropicListing(
  document: Document,
  baseUrl: string,
): ReviewedPublicationListingEntry[] {
  const rows = Array.from(
    document.querySelectorAll('a[href^="/research/"]'),
  ).filter((row) =>
    !row.getAttribute("href")?.startsWith("/research/team/") &&
    row.querySelector("time") !== null,
  ).slice(0, 20);
  return rows.flatMap((row): ReviewedPublicationListingEntry[] => {
    const href = resolvedUrl(row.getAttribute("href"), baseUrl);
    const time = row.querySelector("time");
    const dateValue = timeValue(time);
    const dateDisplayText = time?.textContent?.trim() ?? null;
    const publishedAt = exactCalendarDate(dateValue);
    const heading = Array.from(row.querySelectorAll("h2,h3,h4,h5"))
      .map((element) => providerTitle(element.textContent))
      .find((value): value is string => value !== null);
    const spans = directChildren(row, "span").map((element) => ({
      element,
      rawText: element.textContent?.trim() ?? "",
      value: providerTitle(element.textContent),
    }));
    const fallback = [...spans]
      .filter(({ rawText, value }) =>
        value !== null &&
        rawText !== dateDisplayText &&
        codePointLength(value) >= 12,
      )
      .sort((left, right) => codePointLength(right.value!) - codePointLength(left.value!))
      .at(0);
    const title = heading ?? fallback?.value ?? null;
    if (href === null || title === null) return [];
    const category = spans.find(({ element, rawText, value }) =>
      value !== null &&
      value !== title &&
      rawText !== dateDisplayText &&
      element !== fallback?.element &&
      codePointLength(value) <= 80,
    )?.value ?? null;
    return [{
      title,
      url: href,
      publishedAt,
      summary: providerEvidence(row.querySelector("p")?.textContent),
      category,
      authors: [],
    }];
  });
}

function deepMindListing(
  document: Document,
  baseUrl: string,
): ReviewedPublicationListingEntry[] {
  const rows = Array.from(document.querySelectorAll(".card__inner")).slice(0, 20);
  return rows.flatMap((row): ReviewedPublicationListingEntry[] => {
    const link = row.querySelector('.card__overlay-link[href^="/blog/"]');
    const title = providerTitle(row.querySelector(".card__title")?.textContent);
    const category = providerTitle(row.querySelector(".meta__category")?.textContent);
    const time = row.querySelector("time");
    const href = resolvedUrl(link?.getAttribute("href") ?? null, baseUrl);
    if (href === null || title === null || category === null || time === null) return [];
    return [{
      title,
      url: href,
      publishedAt: exactCalendarDate(timeValue(time)),
      summary: providerEvidence(row.querySelector("p")?.textContent),
      category,
      authors: [],
    }];
  });
}

function googleResearchListing(
  document: Document,
  baseUrl: string,
): ReviewedPublicationListingEntry[] {
  const rows = Array.from(
    document.querySelectorAll('a.glue-card--blog[href^="/blog/"]'),
  ).slice(0, 20);
  return rows.flatMap((row): ReviewedPublicationListingEntry[] => {
    const href = resolvedUrl(row.getAttribute("href"), baseUrl);
    const title = providerTitle(row.querySelector(".js-gt-item-id")?.textContent);
    const eyebrow = row.querySelector(".glue-card__eyebrow");
    const dateText = eyebrow?.getAttribute("datetime") ?? eyebrow?.textContent;
    const category = providerTitle(
      row.querySelector(".glue-card__label, .glue-card__category, [data-category]")
        ?.textContent,
    );
    if (href === null || title === null || eyebrow === null || category === null) return [];
    return [{
      title,
      url: href,
      publishedAt: exactCalendarDate(dateText),
      summary: providerEvidence(row.querySelector("p")?.textContent),
      category,
      authors: [],
    }];
  });
}

const profiles: Readonly<Record<ReviewedPublicationProfileId, ReviewedPublicationProfile>> = {
  anthropic: {
    maxListingEntries: 20,
    maxDetailFetches: 5,
    parseListing: anthropicListing,
    parseDetailPublishedAt: detailPublishedAt,
  },
  "google-deepmind": {
    maxListingEntries: 20,
    maxDetailFetches: 5,
    parseListing: deepMindListing,
    parseDetailPublishedAt: detailPublishedAt,
  },
  "google-research": {
    maxListingEntries: 20,
    maxDetailFetches: 5,
    parseListing: googleResearchListing,
    parseDetailPublishedAt: detailPublishedAt,
  },
};

export function reviewedPublicationProfile(
  sourceId: string,
): ReviewedPublicationProfile | null {
  return Object.hasOwn(profiles, sourceId)
    ? profiles[sourceId as ReviewedPublicationProfileId]
    : null;
}
