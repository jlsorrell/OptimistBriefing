import {
  EditionSectionSchema,
  ItemSchema,
  type Item,
} from "../contracts/editorial";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "../sources/identifiers";
import {
  EditorialSignalRecordSchema,
  MAX_PROVIDER_CONTENT_CHARACTERS,
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  MAX_PROVIDER_TITLE_CHARACTERS,
  ScopedNewsMaterialFactSchema,
  RawItemSchema,
  RawPublicationCandidateSchema,
  RawResearchCandidateSchema,
  type RawResearchCandidate,
  type ScopedNewsMaterialFact,
} from "../sources/types";
import {
  normalizeProviderText,
  normalizeProviderSourceName,
  preparedProviderSignalText,
} from "../sources/provider-text";
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
const CANDIDATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function normalizedWhitespace(value: string): string {
  return normalizeProviderText(value) ?? "";
}

function normalizedProviderDisplayText(value: string): string {
  return normalizeProviderText(value, {
    stripHtml: true,
    maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
  }) ?? "";
}

function rawWhitespace(value: string): string {
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
    return rawWhitespace(value);
  }
}

function stableExternalIdentifier(value: string): boolean {
  if (
    normalizeDoi(value) !== null ||
    normalizeArxivIdentifier(value) !== null
  ) {
    return true;
  }
  return !/^(?:doi|arxiv)\s*:/i.test(value);
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
        .map(rawWhitespace)
        .filter((entry) => entry.length > 0)
    : [];
}

function providerTextArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizedProviderDisplayText)
        .filter((entry) => entry.length > 0)
    : [];
}

const PREPARED_RAW_CANDIDATE = Symbol("preparedRawCandidate");

export type PreparedRawCandidate = Record<string, unknown> & {
  readonly [PREPARED_RAW_CANDIDATE]: true;
};

export type RequiredProviderDisplayTextField = "title" | "sourceName";

export class InvalidRequiredProviderDisplayTextError extends Error {
  constructor(readonly field: RequiredProviderDisplayTextField) {
    super(`INVALID_REQUIRED_PROVIDER_DISPLAY_TEXT:${field}`);
    this.name = "InvalidRequiredProviderDisplayTextError";
  }
}

export function isPreparedRawCandidate(
  value: unknown,
): value is PreparedRawCandidate {
  return value !== null && typeof value === "object" &&
    (value as Partial<PreparedRawCandidate>)[PREPARED_RAW_CANDIDATE] === true;
}

export function markPreparedRawCandidate<T extends object>(
  value: T,
): T & PreparedRawCandidate {
  Object.defineProperty(value, PREPARED_RAW_CANDIDATE, {
    value: true,
    enumerable: false,
  });
  return value as T & PreparedRawCandidate;
}

export function rebrandPreparedResearchCandidateAfterSchemaClone(
  value: unknown,
): RawResearchCandidate & PreparedRawCandidate {
  return markPreparedRawCandidate(RawResearchCandidateSchema.parse(value));
}

function preparedDisplay(value: string): string {
  return rawWhitespace(value).slice(0, MAX_PROVIDER_TITLE_CHARACTERS);
}

function preparedTextArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map(preparedDisplay)
        .filter((entry) => entry.length > 0)
    : [];
}

function normalizedPreparedKey(value: string): string {
  return rawWhitespace(value)
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requiredPreparedProviderDisplayText(
  value: string,
  field: RequiredProviderDisplayTextField,
): string {
  const normalized = field === "sourceName"
    ? normalizeProviderSourceName(value)
    : normalizeProviderText(value, {
        stripHtml: true,
        maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
      });
  if (normalized === null) {
    throw new InvalidRequiredProviderDisplayTextError(field);
  }
  return normalized;
}

export function normalizePreparedTitleKey(value: string): string {
  return normalizedPreparedKey(value);
}

export function normalizePreparedAuthorKey(value: string): string {
  return normalizedPreparedKey(value);
}

export function prepareRawCandidateForPipeline(
  raw: unknown,
): PreparedRawCandidate {
  if (isPreparedRawCandidate(raw)) return raw;
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
  const rawItem = RawItemSchema.safeParse(normalizedInput);
  const candidate = rawItem.success
    ? rawItem.data
    : RawPublicationCandidateSchema.parse(normalizedInput);
  const displayArray = (value: unknown): string[] =>
    providerTextArray(value);
  const metadata: Record<string, unknown> = { ...candidate.metadata };
  if (typeof metadata.venue === "string") {
    metadata.venue = normalizedProviderDisplayText(metadata.venue);
  }
  if (Array.isArray(metadata.topics)) {
    metadata.topics = displayArray(metadata.topics);
  }
  if (Array.isArray(metadata.preferredInstitutionMatches)) {
    metadata.preferredInstitutionMatches = displayArray(
      metadata.preferredInstitutionMatches,
    );
  }
  const title = requiredPreparedProviderDisplayText(
    candidate.title,
    "title",
  );
  const sourceName = requiredPreparedProviderDisplayText(
    candidate.sourceName,
    "sourceName",
  );
  return markPreparedRawCandidate({
    ...input,
    ...candidate,
    title,
    sourceName,
    authors: displayArray(candidate.authors),
    institutions: displayArray(candidate.institutions),
    abstract: candidate.abstract === null
      ? null
      : normalizeProviderText(candidate.abstract, {
          stripHtml: true,
          maxCharacters: MAX_PROVIDER_EVIDENCE_CHARACTERS,
        }) ?? " ",
    content: candidate.content === null
      ? null
      : normalizeProviderText(candidate.content, {
          stripHtml: true,
          maxCharacters: MAX_PROVIDER_CONTENT_CHARACTERS,
        }) ?? " ",
    ...(Array.isArray(input.topics)
      ? { topics: displayArray(input.topics) }
      : {}),
    ...(Array.isArray(input.preferredInstitutionMatches)
      ? {
          preferredInstitutionMatches: displayArray(
            input.preferredInstitutionMatches,
          ),
        }
      : {}),
    metadata,
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

export function candidateExpiry(
  createdAt: string,
  configured: unknown,
): string {
  const explicit = optionalDate(configured);
  const defaultExpiry =
    new Date(Date.parse(createdAt) + CANDIDATE_RETENTION_MS).toISOString();
  return explicit !== null && Date.parse(explicit) < Date.parse(defaultExpiry)
    ? explicit
    : defaultExpiry;
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

export function normalizeAuthorKey(value: string): string {
  return normalizedWhitespace(value)
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePreparedCandidate(
  prepared: PreparedRawCandidate,
): Item {
  const input = prepared;
  const candidate = RawItemSchema.parse(prepared);
  const title = candidate.title;
  const abstract = candidate.abstract === null
    ? null
    : rawWhitespace(candidate.abstract);
  const content = candidate.content === null
    ? null
    : rawWhitespace(candidate.content);
  const selectedNormalizedText = candidate.content !== null
    ? content ?? ""
    : candidate.abstract !== null
      ? abstract ?? ""
      : title;
  const canonicalUrl = candidateCanonicalUrl(
    candidate.originalUrl,
    candidate.metadata,
  );
  const suppliedExternalIds = [
    candidate.externalId,
    ...candidate.externalIds,
  ];
  const hasExplicitArxiv = suppliedExternalIds.some(
    (identifier) => normalizeArxivIdentifier(identifier) !== null,
  );
  const hasExplicitDoi = suppliedExternalIds.some(
    (identifier) => normalizeDoi(identifier) !== null,
  );
  const explicitExternalIds = suppliedExternalIds.map(canonicalIdentifier);
  const restoredOpenAlexArxiv =
    candidate.sourceId === "openalex" &&
      !hasExplicitArxiv &&
      !hasExplicitDoi
    ? normalizeArxivIdentifier(canonicalUrl)
    : null;
  const externalIds = uniqueSorted(
    [
      ...explicitExternalIds,
      ...(restoredOpenAlexArxiv === null ? [] : [restoredOpenAlexArxiv]),
    ],
  );
  const topics = preparedTextArray(input.topics);
  const preferredInstitutionMatches = preparedTextArray(
    input.preferredInstitutionMatches ??
      candidate.metadata.preferredInstitutionMatches,
  );
  const metadataVenue = typeof candidate.metadata.venue === "string"
    ? preparedDisplay(candidate.metadata.venue)
    : undefined;
  const metadataTopics = Array.isArray(candidate.metadata.topics)
    ? uniqueSorted(preparedTextArray(candidate.metadata.topics))
    : undefined;
  const signalTitle = preparedProviderSignalText(title) ?? "";
  const signalAbstract = preparedProviderSignalText(abstract);
  const signalContent = preparedProviderSignalText(content);
  const signalTopics = topics.flatMap((topic) =>
    preparedProviderSignalText(topic) ?? []
  );
  const configuredTopics =
    candidate.kind === "paper" || candidate.kind === "blog"
      ? mapResearchTopicIds([
          signalTitle,
          ...signalTopics,
          signalAbstract ?? "",
        ])
      : [];
  const sectionEligibility = stringArray(
    input.sectionEligibility ?? candidate.metadata.sectionEligibility,
  );
  const materialText = [
    signalTitle,
    signalAbstract,
    signalContent,
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
  const derivedEventInstances = deriveCanonicalEventInstances(
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
  ).filter((fact) =>
    canonicalEventInstances.some(
      (instance) =>
        instance.subject === fact.eventInstance.subject &&
        instance.domain === fact.eventInstance.domain &&
        instance.object === fact.eventInstance.object,
    ),
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
  const rawSection =
    typeof candidate.metadata.primarySection === "string"
      ? rawWhitespace(candidate.metadata.primarySection)
      : typeof candidate.metadata.section === "string"
        ? rawWhitespace(candidate.metadata.section)
      : null;
  const parsedSection = EditionSectionSchema.safeParse(rawSection);
  const section = parsedSection.success ? parsedSection.data : null;
  const primaryTopic =
    configuredTopics[0] ??
    (typeof candidate.metadata.primaryTopic === "string"
      ? rawWhitespace(candidate.metadata.primaryTopic)
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
        normalizeDoi(identifier) !== null ||
        normalizeArxivIdentifier(identifier) !== null,
    ) ??
    externalIds.find(stableExternalIdentifier) ??
    canonicalUrl;
  const id = `item-${stableHash(
    `${candidate.kind}:${stableIdentifier}`,
  )}`;
  const sourceUrl = canonicalizeUrl(candidate.originalUrl);
  const createdAt = new Date(candidate.retrievedAt).toISOString();
  const isCommentary =
    candidate.kind === "blog" ||
    candidate.sourceRole === "blog" ||
    candidate.metadata.discoveryFamily === "commentary";
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
        name: candidate.sourceName,
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
    normalizedText: selectedNormalizedText,
    metadata: {
      ...candidate.metadata,
      ...(metadataVenue === undefined ? {} : { venue: metadataVenue }),
      ...(metadataTopics === undefined ? {} : { topics: metadataTopics }),
      externalId: canonicalIdentifier(candidate.externalId),
      externalIds,
      normalizedTitle: normalizePreparedTitleKey(title),
      originalUrl: candidate.originalUrl,
      authors: uniqueSorted(
        candidate.authors
          .map(preparedDisplay)
          .filter((author) => author.length > 0),
      ),
      normalizedAuthors: uniqueSorted(
        candidate.authors
          .map(normalizePreparedAuthorKey)
          .filter((author) => author.length > 0),
      ),
      institutions: uniqueSorted(
        candidate.institutions
          .map(preparedDisplay)
          .filter((institution) => institution.length > 0),
      ),
      providerTopics: uniqueSorted(topics),
      preferredInstitutionMatches: uniqueSorted(
        preferredInstitutionMatches,
      ),
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
          sourceName: candidate.sourceName,
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
      primaryResearchSourceIds:
        candidate.kind === "paper" && !isCommentary
          ? [candidate.sourceId]
          : [],
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
    createdAt,
    expiresAt: candidateExpiry(createdAt, candidate.metadata.expiresAt),
  });
}

export function normalizeCandidate(raw: unknown): Item {
  return normalizePreparedCandidate(prepareRawCandidateForPipeline(raw));
}
