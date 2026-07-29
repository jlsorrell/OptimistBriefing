import { ItemSchema, type Item } from "../contracts/editorial";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "../sources/identifiers";
import {
  NewsMaterialFactSchema,
  RawItemSchema,
  type NewsMaterialFact,
} from "../sources/types";
import {
  deriveEventFamilies,
  deriveMaterialFacts,
} from "../sources/news-signals";
import { mapResearchTopicIds } from "./research-topics";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
]);

function normalizedWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized);
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Editorial URLs must use HTTP or HTTPS.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("Editorial URLs must not contain credentials.");
  }

  const doi = normalizeDoi(url.toString());
  if (doi !== null) return `https://doi.org/${doi}`;
  const arxiv = normalizeArxivIdentifier(url.toString());
  if (arxiv !== null) {
    return `https://arxiv.org/abs/${arxiv.slice("arXiv:".length)}`;
  }

  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParameter(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/(?:amp)\/?$/i, "") || "/";
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\?$/, "");
}

function canonicalIdentifier(value: string): string {
  const doi = normalizeDoi(value);
  if (doi !== null) return `DOI:${doi}`;
  const arxiv = normalizeArxivIdentifier(value);
  if (arxiv !== null) return arxiv;
  try {
    return canonicalizeUrl(value);
  } catch {
    return normalizedWhitespace(value);
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizedWhitespace)
        .filter((entry) => entry.length > 0)
    : [];
}

function materialFacts(value: unknown): NewsMaterialFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): NewsMaterialFact[] => {
    const parsed = NewsMaterialFactSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function optionalDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function candidateCanonicalUrl(
  originalUrl: string,
  metadata: Readonly<Record<string, unknown>>,
): string {
  for (const key of [
    "canonicalUrl",
    "syndicationCanonicalUrl",
    "publisherCanonicalUrl",
  ]) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    try {
      return canonicalizeUrl(value);
    } catch {
      // Ignore an invalid optional hint and fall back to the collected URL.
    }
  }
  return canonicalizeUrl(originalUrl);
}

export function normalizeTitleKey(value: string): string {
  return normalizedWhitespace(value)
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCandidate(raw: unknown): Item {
  const input =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const normalizedInput = {
    ...input,
    publishedAt:
      input.publishedAt === null
        ? null
        : optionalDate(input.publishedAt) ?? input.publishedAt,
    retrievedAt: optionalDate(input.retrievedAt) ?? input.retrievedAt,
  };
  const candidate = RawItemSchema.parse(normalizedInput);
  const title = normalizedWhitespace(candidate.title);
  const canonicalUrl = candidateCanonicalUrl(
    candidate.originalUrl,
    candidate.metadata,
  );
  const externalIds = uniqueSorted(
    [candidate.externalId, ...candidate.externalIds].map(
      canonicalIdentifier,
    ),
  );
  const topics = stringArray(input.topics);
  const configuredTopics =
    candidate.kind === "paper" || candidate.kind === "blog"
      ? mapResearchTopicIds([
          title,
          ...topics,
          candidate.abstract ?? "",
        ])
      : [];
  const sectionEligibility = stringArray(
    input.sectionEligibility ?? candidate.metadata.sectionEligibility,
  );
  const namedEntities = stringArray(
    input.namedEntities ?? candidate.metadata.namedEntities,
  );
  const primaryDocumentUrl =
    typeof (input.primaryDocumentUrl ??
      candidate.metadata.primaryDocumentUrl) === "string"
      ? canonicalizeUrl(
          (input.primaryDocumentUrl ??
            candidate.metadata.primaryDocumentUrl) as string,
        )
      : null;
  const primaryDocumentUrls = uniqueSorted([
    ...stringArray(
      input.primaryDocumentUrls ??
        candidate.metadata.primaryDocumentUrls,
    ).map(canonicalizeUrl),
    ...(primaryDocumentUrl === null ? [] : [primaryDocumentUrl]),
  ]);
  const explicitEventFamilies = stringArray(
    input.eventFamilies ?? candidate.metadata.eventFamilies,
  );
  const eventFamilies = uniqueSorted(
    explicitEventFamilies.length > 0
      ? explicitEventFamilies
      : deriveEventFamilies(title, candidate.metadata),
  );
  const explicitMaterialFacts = materialFacts(
    input.materialFacts ?? candidate.metadata.materialFacts,
  );
  const structuredMaterialFacts = (
    explicitMaterialFacts.length > 0
      ? explicitMaterialFacts
      : deriveMaterialFacts(title, candidate.metadata)
  ).sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key) ||
      left.value.localeCompare(right.value),
  );
  const section =
    typeof candidate.metadata.primarySection === "string"
      ? normalizedWhitespace(candidate.metadata.primarySection)
      : typeof candidate.metadata.section === "string"
        ? normalizedWhitespace(candidate.metadata.section)
      : null;
  const primaryTopic =
    configuredTopics[0] ??
    (typeof candidate.metadata.primaryTopic === "string"
      ? normalizedWhitespace(candidate.metadata.primaryTopic)
      : section) ??
    topics[0] ??
    "general";
  const canCorroborateFacts =
    input.canCorroborateFacts === true &&
    (candidate.sourceRole === "primary" ||
      candidate.sourceRole === "reporting");
  const publishedAt =
    candidate.publishedAt === null
      ? null
      : new Date(candidate.publishedAt).toISOString();
  const stableIdentifier =
    externalIds.find(
      (identifier) =>
        identifier.startsWith("DOI:") ||
        identifier.startsWith("arXiv:"),
    ) ??
    externalIds[0] ??
    canonicalUrl;

  return ItemSchema.parse({
    id: `item-${stableHash(`${candidate.kind}:${stableIdentifier}`)}`,
    kind: candidate.kind,
    canonicalUrl,
    title,
    publishedAt,
    sourceRefs: [
      {
        id: candidate.sourceId,
        name: normalizedWhitespace(candidate.sourceName),
        url: canonicalizeUrl(candidate.originalUrl),
        role: candidate.sourceRole,
        retrievedAt: new Date(candidate.retrievedAt).toISOString(),
      },
    ],
    accessLevel: candidate.accessLevel,
    primaryTopic,
    tags: uniqueSorted([
      ...configuredTopics,
      ...sectionEligibility,
      ...stringArray(candidate.metadata.tags),
      ...(section === null ? [] : [section]),
    ]),
    normalizedText: normalizedWhitespace(
      candidate.content ?? candidate.abstract ?? title,
    ),
    metadata: {
      ...candidate.metadata,
      externalId: canonicalIdentifier(candidate.externalId),
      externalIds,
      normalizedTitle: normalizeTitleKey(title),
      originalUrl: candidate.originalUrl,
      authors: uniqueSorted(candidate.authors.map(normalizedWhitespace)),
      institutions: uniqueSorted(
        candidate.institutions.map(normalizedWhitespace),
      ),
      providerTopics: uniqueSorted(topics),
      configuredTopics,
      sectionEligibility: uniqueSorted(sectionEligibility),
      namedEntities: uniqueSorted(namedEntities),
      primaryDocumentUrl,
      primaryDocumentUrls,
      eventFamilies,
      materialFacts: structuredMaterialFacts,
      relatedPaperIds: uniqueSorted(
        candidate.relatedPaperIds.map(canonicalIdentifier),
      ),
      canCorroborateFacts,
      provenance: [
        {
          sourceId: candidate.sourceId,
          sourceName: candidate.sourceName,
          role: candidate.sourceRole,
          accessLevel: candidate.accessLevel,
          url: candidate.originalUrl,
          retrievedAt: candidate.retrievedAt,
          canCorroborateFacts,
        },
      ],
    },
    createdAt: new Date(candidate.retrievedAt).toISOString(),
    expiresAt: optionalDate(candidate.metadata.expiresAt),
  });
}
