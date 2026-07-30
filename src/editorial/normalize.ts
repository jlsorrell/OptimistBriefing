import { ItemSchema, type Item } from "../contracts/editorial";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "../sources/identifiers";
import {
  CanonicalEventInstanceSchema,
  EditorialSignalRecordSchema,
  ScopedNewsMaterialFactSchema,
  type CanonicalEventInstance,
  RawItemSchema,
  type ScopedNewsMaterialFact,
} from "../sources/types";
import {
  deriveCanonicalEventInstances,
  deriveEventFamilies,
  deriveNamedEntities,
  deriveScopedMaterialFacts,
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

function eventInstances(value: unknown): CanonicalEventInstance[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CanonicalEventInstance[] => {
    const parsed = CanonicalEventInstanceSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function scopedMaterialFacts(
  value: unknown,
): ScopedNewsMaterialFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ScopedNewsMaterialFact[] => {
    const parsed = ScopedNewsMaterialFactSchema.safeParse(entry);
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
  const materialText = [
    title,
    candidate.abstract,
    candidate.content,
  ];
  const namedEntities = uniqueSorted([
    ...stringArray(
      input.namedEntities ?? candidate.metadata.namedEntities,
    ),
    ...deriveNamedEntities(materialText, candidate.metadata),
  ]);
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
    [
      ...explicitEventFamilies,
      ...deriveEventFamilies(
        materialText,
        candidate.metadata,
      ),
    ],
  );
  const explicitEventInstances = eventInstances(
    input.eventInstances ??
      candidate.metadata.eventInstances,
  );
  const derivedEventInstances =
    explicitEventInstances.length > 0
      ? explicitEventInstances
      : deriveCanonicalEventInstances(
          materialText,
          candidate.metadata,
          namedEntities,
          eventFamilies,
        );
  const canonicalEventInstances = [
    ...new Map(
      derivedEventInstances.map((instance) => [
        `${instance.subject}\u0000${instance.domain}\u0000${instance.object}`,
        instance,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.subject.localeCompare(right.subject) ||
      left.domain.localeCompare(right.domain) ||
      left.object.localeCompare(right.object),
  );
  const explicitScopedFacts = scopedMaterialFacts(
    input.scopedMaterialFacts ??
      candidate.metadata.scopedMaterialFacts,
  );
  const {
    materialFacts: _unscopedMaterialFacts,
    scopedMaterialFacts: _upstreamScopedMaterialFacts,
    ...factDerivationMetadata
  } = candidate.metadata;
  const scopedFactMap = new Map<string, ScopedNewsMaterialFact>();
  for (const fact of [
    ...explicitScopedFacts,
    ...deriveScopedMaterialFacts(
      materialText,
      factDerivationMetadata,
      canonicalEventInstances,
    ),
  ]) {
    scopedFactMap.set(
      [
        fact.eventInstance.subject,
        fact.eventInstance.domain,
        fact.eventInstance.object,
        fact.kind,
        fact.key,
        fact.value,
      ].join("\u0000"),
      fact,
    );
  }
  const structuredScopedFacts = [...scopedFactMap.values()].sort(
    (left, right) =>
      left.eventInstance.subject.localeCompare(
        right.eventInstance.subject,
      ) ||
      left.eventInstance.domain.localeCompare(
        right.eventInstance.domain,
      ) ||
      left.eventInstance.object.localeCompare(
        right.eventInstance.object,
      ) ||
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key) ||
      left.value.localeCompare(right.value),
  );
  const instanceMaterialFacts = structuredScopedFacts.map(
    ({ eventInstance: _eventInstance, ...fact }) => fact,
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
  const id = `item-${stableHash(
    `${candidate.kind}:${stableIdentifier}`,
  )}`;
  const sourceUrl = canonicalizeUrl(candidate.originalUrl);
  const signalPrimaryDocumentUrls = uniqueSorted([
    ...primaryDocumentUrls,
    ...(candidate.kind === "document" ? [canonicalUrl] : []),
  ]);

  return ItemSchema.parse({
    id,
    kind: candidate.kind,
    canonicalUrl,
    title,
    publishedAt,
    sourceRefs: [
      {
        id: candidate.sourceId,
        name: normalizedWhitespace(candidate.sourceName),
        url: sourceUrl,
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
      eventInstances: canonicalEventInstances,
      materialFacts: instanceMaterialFacts,
      scopedMaterialFacts: structuredScopedFacts,
      editorialSignals: [
        EditorialSignalRecordSchema.parse({
          itemId: id,
          itemKind: candidate.kind,
          sourceId: candidate.sourceId,
          sourceName: normalizedWhitespace(candidate.sourceName),
          sourceUrl,
          sourceRole: candidate.sourceRole,
          accessLevel: candidate.accessLevel,
          canCorroborateFacts,
          sectionEligibility: uniqueSorted(sectionEligibility),
          namedEntities: uniqueSorted(namedEntities),
          primaryDocumentUrls: signalPrimaryDocumentUrls,
          eventFamilies,
          eventInstances: canonicalEventInstances,
          materialFacts: instanceMaterialFacts,
          scopedMaterialFacts: structuredScopedFacts,
        }),
      ],
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
