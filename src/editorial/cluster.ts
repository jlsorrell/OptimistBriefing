import { z } from "zod";

import {
  EditionSectionSchema,
  ItemSchema,
  SourceRefSchema,
  type AccessLevel,
  type EditionSection,
  type Item,
  type SourceRef,
} from "../contracts/editorial";
import {
  EditorialSignalRecordSchema,
  NewsMaterialFactSchema,
  type EditorialSignalRecord,
  type NewsMaterialFact,
} from "../sources/types";
import { canonicalizeUrl } from "./normalize";
import {
  editorialSignalKey,
  editorialSignals,
} from "./editorial-signals";

const NEWS_KINDS = new Set<Item["kind"]>([
  "article",
  "document",
  "forecast",
]);
const CLUSTER_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;
const SEMANTIC_THRESHOLD = 0.86;

export const ClusterSourceEvidenceSchema = z.object({
  itemId: z.string().min(1),
  sourceId: z.string().min(1),
  role: z.enum([
    "primary",
    "reporting",
    "analysis",
    "opinion",
    "blog",
    "forecast",
  ]),
  accessLevel: z.enum([
    "metadata",
    "abstract",
    "full_text",
    "secondary",
  ]),
  provenanceUrl: z.string().url(),
  canCorroborateFacts: z.boolean(),
});

export type ClusterSourceEvidence = z.infer<
  typeof ClusterSourceEvidenceSchema
>;

const NewsSectionSchema = z.enum([
  "world",
  "technology",
  "ai_policy",
  "dmv",
  "baltimore",
  "forecast",
]);

export const NewsDevelopmentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1),
  items: z.array(ItemSchema).min(1),
  representativeItem: ItemSchema,
  canonicalPrimaryDocument: z.string().url().nullable(),
  primaryDocumentUrls: z.array(z.string().url()),
  namedEntities: z.array(z.string().min(1)),
  eventFamilies: z.array(z.string().min(1)),
  materialFacts: z.array(NewsMaterialFactSchema),
  sectionEligibility: z.array(EditionSectionSchema),
  primarySection: NewsSectionSchema,
  developmentKey: z.string().min(1),
  repeatable: z.boolean(),
  materialFactsFingerprint: z.string().min(1),
  materialChange: z.boolean(),
  publishedFrom: z.string().datetime().nullable(),
  publishedTo: z.string().datetime().nullable(),
  sourceRefs: z.array(SourceRefSchema).min(1),
  editorialSignals: z.array(EditorialSignalRecordSchema).min(1),
  sourceEvidence: z.array(ClusterSourceEvidenceSchema).min(1),
  corroboratingSourceIds: z.array(z.string().min(1)),
  corroboratingSourceCount: z.number().int().nonnegative(),
});

export type NewsDevelopment = z.infer<typeof NewsDevelopmentSchema>;
export type NewsCluster = NewsDevelopment;

export type EmbeddingLookup =
  | Readonly<Record<string, readonly number[]>>
  | ReadonlyMap<string, readonly number[]>;

function isEmbeddingMap(
  value: EmbeddingLookup,
): value is ReadonlyMap<string, readonly number[]> {
  return (
    typeof (value as { get?: unknown }).get === "function"
  );
}

function embedding(
  embeddings: EmbeddingLookup,
  itemId: string,
): readonly number[] | undefined {
  return isEmbeddingMap(embeddings)
    ? embeddings.get(itemId)
    : embeddings[itemId];
}

function cosine(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): number | null {
  if (
    left === undefined ||
    right === undefined ||
    left.length === 0 ||
    left.length !== right.length ||
    left.some((value) => !Number.isFinite(value)) ||
    right.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) return null;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return null;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizedEntityValues(
  values: readonly string[],
): Map<string, string> {
  return new Map(
    values.map((value) => [
      value.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
      value.normalize("NFKC").trim(),
    ]),
  );
}

function normalizedEntities(item: Item): Map<string, string> {
  return normalizedEntityValues(
    stringArray(
      item.metadata.namedEntities ?? item.metadata.entities,
    ),
  );
}

const GENERIC_IDENTITY_ENTITIES = new Set([
  "ai",
  "artificial intelligence",
  "united states",
  "congress",
  "federal register",
  "baltimore",
  "maryland",
  "virginia",
  "washington, d.c.",
]);

function entityOverlap(left: Item, right: Item): boolean {
  const leftEntities = normalizedEntities(left);
  const rightEntities = normalizedEntities(right);
  for (const entity of leftEntities.keys()) {
    if (
      entity.length > 0 &&
      !GENERIC_IDENTITY_ENTITIES.has(entity) &&
      rightEntities.has(entity)
    ) {
      return true;
    }
  }
  return false;
}

function primaryDocuments(item: Item): string[] {
  const candidates = [
    ...stringArray(item.metadata.primaryDocumentUrls),
    ...(typeof item.metadata.primaryDocumentUrl === "string"
      ? [item.metadata.primaryDocumentUrl]
      : []),
    ...(typeof item.metadata.canonicalPrimaryDocument === "string"
      ? [item.metadata.canonicalPrimaryDocument]
      : []),
    ...(item.kind === "document" ? [item.canonicalUrl] : []),
  ];
  return [
    ...new Set(
      candidates.flatMap((value) => {
        try {
          return [canonicalizeUrl(value)];
        } catch {
          return [];
        }
      }),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function signalPrimaryDocuments(
  signals: readonly EditorialSignalRecord[],
): string[] {
  return [
    ...new Set(
      signals.flatMap((signal) =>
        signal.primaryDocumentUrls.flatMap((value) => {
          try {
            return [canonicalizeUrl(value)];
          } catch {
            return [];
          }
        }),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function timestamp(item: Item): number | null {
  return item.publishedAt === null ? null : Date.parse(item.publishedAt);
}

function withinWindow(left: Item, right: Item): boolean {
  const leftTimestamp = timestamp(left);
  const rightTimestamp = timestamp(right);
  return (
    leftTimestamp !== null &&
    rightTimestamp !== null &&
    Math.abs(leftTimestamp - rightTimestamp) <= CLUSTER_WINDOW_MS
  );
}

function related(
  left: Item,
  right: Item,
  embeddings: EmbeddingLookup,
): boolean {
  if (!withinWindow(left, right)) return false;
  const leftPrimary = new Set(primaryDocuments(left));
  const rightPrimary = primaryDocuments(right);
  if (rightPrimary.some((document) => leftPrimary.has(document))) {
    return true;
  }
  const similarity = cosine(
    embedding(embeddings, left.id),
    embedding(embeddings, right.id),
  );
  return (
    similarity !== null &&
    similarity >= SEMANTIC_THRESHOLD &&
    entityOverlap(left, right)
  );
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

const ACCESS_PRIORITY: Record<AccessLevel, number> = {
  metadata: 0,
  secondary: 1,
  abstract: 2,
  full_text: 3,
};
const ROLE_PRIORITY: Record<SourceRef["role"], number> = {
  forecast: 0,
  opinion: 1,
  blog: 2,
  analysis: 3,
  reporting: 4,
  primary: 5,
};
const SECTION_PRIORITY = [
  "baltimore",
  "dmv",
  "ai_policy",
  "technology",
  "world",
  "forecast",
] as const;

function representative(items: readonly Item[]): Item {
  return [...items].sort((left, right) => {
    const leftRole = Math.max(
      ...left.sourceRefs.map((source) => ROLE_PRIORITY[source.role]),
    );
    const rightRole = Math.max(
      ...right.sourceRefs.map((source) => ROLE_PRIORITY[source.role]),
    );
    return (
      rightRole - leftRole ||
      ACCESS_PRIORITY[right.accessLevel] -
        ACCESS_PRIORITY[left.accessLevel] ||
      (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
      left.id.localeCompare(right.id)
    );
  })[0] as Item;
}

function itemSections(item: Item): EditionSection[] {
  return stringArray(item.metadata.sectionEligibility).flatMap(
    (value): EditionSection[] => {
      const parsed = EditionSectionSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    },
  );
}

function primarySection(items: readonly Item[]): NewsDevelopment["primarySection"] {
  const counts = new Map<NewsDevelopment["primarySection"], number>();
  for (const item of items) {
    const values = [
      ...stringArray(item.metadata.primarySections),
      ...(typeof item.metadata.primarySection === "string"
        ? [item.metadata.primarySection]
        : []),
    ];
    for (const value of new Set(values)) {
      const parsed = NewsSectionSchema.safeParse(value);
      if (!parsed.success) continue;
      counts.set(parsed.data, (counts.get(parsed.data) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return items.every((item) => item.kind === "forecast")
      ? "forecast"
      : "world";
  }
  return [...SECTION_PRIORITY].sort(
    (left, right) =>
      (counts.get(right) ?? 0) - (counts.get(left) ?? 0) ||
      SECTION_PRIORITY.indexOf(left) - SECTION_PRIORITY.indexOf(right),
  )[0] ?? "world";
}

function eventDomainForFamilies(
  eventFamilies: readonly string[],
): string | null {
  const values = new Set(eventFamilies);
  const domains = new Set<string>();
  if (values.has("funding-budget")) domains.add("funding-event");
  if (values.has("product-release")) domains.add("product-event");
  if (
    values.has("legislation") ||
    values.has("guidance-rule") ||
    values.has("evaluation-standards")
  ) {
    domains.add("governance-event");
  }
  if (values.has("evaluation-benchmark")) {
    domains.add("evaluation-event");
  }
  return domains.size === 1 ? [...domains][0] ?? null : null;
}

function canonicalSubject(
  entities: readonly string[],
): string | null {
  return [...normalizedEntityValues(entities).keys()]
    .filter((entity) => !GENERIC_IDENTITY_ENTITIES.has(entity))
    .sort((left, right) => {
      const leftOrganization =
        /\b(?:agency|institute|university|department|commission|administration|company|laboratory|lab)\b/.test(
          left,
        )
          ? 1
          : 0;
      const rightOrganization =
        /\b(?:agency|institute|university|department|commission|administration|company|laboratory|lab)\b/.test(
          right,
        )
          ? 1
          : 0;
      return (
        rightOrganization - leftOrganization ||
        right.split(/\s+/).length - left.split(/\s+/).length ||
        left.localeCompare(right)
      );
    })[0] ?? null;
}

function stableStructuredIdentity(
  signals: readonly EditorialSignalRecord[],
): { subject: string; eventDomain: string } | null {
  const subjects = new Set(
    signals
      .filter((signal) => signal.canCorroborateFacts)
      .flatMap(
        (signal) =>
          canonicalSubject(signal.namedEntities) ?? [],
      ),
  );
  const eventDomain = stableEventDomain(signals);
  if (subjects.size !== 1 || eventDomain === null) return null;
  const subject = [...subjects][0];
  return subject === undefined ? null : { subject, eventDomain };
}

function stableEventDomain(
  signals: readonly EditorialSignalRecord[],
): string | null {
  const corroboratingSignals = signals.filter(
    (signal) => signal.canCorroborateFacts,
  );
  const authoritativeSignals = corroboratingSignals.filter(
    (signal) => signal.sourceRole === "primary",
  );
  const candidateSignals =
    authoritativeSignals.length > 0
      ? authoritativeSignals
      : corroboratingSignals;
  const eventDomains = new Set(
    candidateSignals.flatMap(
      (signal) =>
        eventDomainForFamilies(
          signal.eventFamilies,
        ) ?? [],
    ),
  );
  return eventDomains.size === 1 ? [...eventDomains][0] ?? null : null;
}

type FactEvidence = {
  fact: NewsMaterialFact;
  evidenceId: string;
  rolePriority: number;
  accessPriority: number;
};

function reconciledMaterialFacts(
  signals: readonly EditorialSignalRecord[],
  semantic: string,
): NewsMaterialFact[] {
  const logicalFacts = new Map<
    string,
    Map<string, FactEvidence[]>
  >();
  for (const signal of signals) {
    if (!signal.canCorroborateFacts) continue;
    const rolePriority = ROLE_PRIORITY[signal.sourceRole];
    const accessPriority = ACCESS_PRIORITY[signal.accessLevel];
    const evidenceId = [
      signal.itemId,
      signal.sourceId,
      signal.sourceUrl,
    ].join("\u0000");
    for (const fact of signal.materialFacts) {
      const logicalKey = `${fact.kind}\u0000${fact.key}`;
      const values =
        logicalFacts.get(logicalKey) ??
        new Map<string, FactEvidence[]>();
      const evidence = values.get(fact.value) ?? [];
      evidence.push({
        fact,
        evidenceId,
        rolePriority,
        accessPriority,
      });
      values.set(fact.value, evidence);
      logicalFacts.set(logicalKey, values);
    }
  }

  const logicalEntries = [...logicalFacts.entries()].map(
    ([logicalKey, values]) => ({
      logicalKey,
      values,
      kind: [...values.values()][0]?.[0]?.fact.kind,
    }),
  );

  return logicalEntries
    .filter(
      ({ kind, logicalKey }) =>
        kind !== "number" ||
        semantic === "unclassified-event" ||
        (semantic === "governance-event" &&
          logicalKey.includes(
            "\u0000count:governance-instrument:",
          )) ||
        (semantic === "evaluation-event" &&
          logicalKey.includes("\u0000count:benchmark:")) ||
        (semantic === "product-event" &&
          logicalKey.includes("\u0000count:program:")),
    )
    .flatMap(({ values }): NewsMaterialFact[] => {
      const ranked = [...values.values()].sort((left, right) => {
        const leftAuthority = Math.max(
          ...left.map(({ rolePriority }) => rolePriority),
        );
        const rightAuthority = Math.max(
          ...right.map(({ rolePriority }) => rolePriority),
        );
        const leftAuthoritySupport = new Set(
          left
            .filter(
              ({ rolePriority }) => rolePriority === leftAuthority,
            )
            .map(({ evidenceId }) => evidenceId),
        ).size;
        const rightAuthoritySupport = new Set(
          right
            .filter(
              ({ rolePriority }) => rolePriority === rightAuthority,
            )
            .map(({ evidenceId }) => evidenceId),
        ).size;
        const leftSupport = new Set(
          left.map(({ evidenceId }) => evidenceId),
        ).size;
        const rightSupport = new Set(
          right.map(({ evidenceId }) => evidenceId),
        ).size;
        const leftAccess = Math.max(
          ...left.map(({ accessPriority }) => accessPriority),
        );
        const rightAccess = Math.max(
          ...right.map(({ accessPriority }) => accessPriority),
        );
        const statusPriority: Readonly<Record<string, number>> = {
          proposed: 0,
          released: 1,
          delayed: 2,
          blocked: 2,
          withdrawn: 2,
          adopted: 2,
        };
        const leftFact = left[0]?.fact;
        const rightFact = right[0]?.fact;
        return (
          rightAuthority - leftAuthority ||
          rightAuthoritySupport - leftAuthoritySupport ||
          rightSupport - leftSupport ||
          (rightFact?.kind === "status"
            ? (statusPriority[rightFact.value] ?? 0)
            : 0) -
            (leftFact?.kind === "status"
              ? (statusPriority[leftFact.value] ?? 0)
              : 0) ||
          rightAccess - leftAccess ||
          (left[0]?.fact.value ?? "").localeCompare(
            right[0]?.fact.value ?? "",
          )
        );
      });
      const selected = ranked[0]?.[0]?.fact;
      return selected === undefined ? [] : [selected];
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.key.localeCompare(right.key) ||
        left.value.localeCompare(right.value),
    );
}

function sourceRefKey(source: SourceRef): string {
  return `${source.id}\u0000${source.url}\u0000${source.role}`;
}

function cluster(items: readonly Item[]): NewsCluster {
  const sortedItems = [...items].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const signalMap = new Map(
    sortedItems
      .flatMap(editorialSignals)
      .map((signal) => [editorialSignalKey(signal), signal]),
  );
  const signals = [...signalMap.values()].sort((left, right) =>
    editorialSignalKey(left).localeCompare(
      editorialSignalKey(right),
    ),
  );
  const corroboratingSignals = signals.filter(
    (signal) => signal.canCorroborateFacts,
  );
  const canonicalPrimaryDocuments = signalPrimaryDocuments(
    corroboratingSignals,
  );
  const entities = new Map<string, string>();
  for (const item of sortedItems) {
    for (const [key, value] of normalizedEntities(item)) {
      if (!entities.has(key)) entities.set(key, value);
    }
  }
  const sourceRefs = new Map<string, SourceRef>();
  for (const item of sortedItems) {
    for (const source of item.sourceRefs) {
      sourceRefs.set(sourceRefKey(source), source);
    }
  }
  const sourceEvidence = signals.map((signal) =>
    ClusterSourceEvidenceSchema.parse({
      itemId: signal.itemId,
      sourceId: signal.sourceId,
      role: signal.sourceRole,
      accessLevel: signal.accessLevel satisfies AccessLevel,
      provenanceUrl: signal.sourceUrl,
      canCorroborateFacts: signal.canCorroborateFacts,
    }),
  );
  sourceEvidence.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.itemId.localeCompare(right.itemId) ||
      left.provenanceUrl.localeCompare(right.provenanceUrl),
  );
  const corroboratingSourceIds = [
    ...new Set(
      sourceEvidence
        .filter((source) => source.canCorroborateFacts)
        .map((source) => source.sourceId),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const published = sortedItems
    .flatMap((item) => item.publishedAt ?? [])
    .sort((left, right) => left.localeCompare(right));
  const representativeItem = representative(sortedItems);
  const sectionEligibility = [
    ...new Set(sortedItems.flatMap(itemSections)),
  ].sort((left, right) => left.localeCompare(right));
  const eventFamilies = [
    ...new Set(
      corroboratingSignals.flatMap(
        (signal) => signal.eventFamilies,
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const structuredIdentity = stableStructuredIdentity(signals);
  const semantic =
    stableEventDomain(signals) ?? "unclassified-event";
  const section = primarySection(sortedItems);
  const repeatable =
    canonicalPrimaryDocuments[0] !== undefined ||
    structuredIdentity !== null;
  const developmentIdentity =
    canonicalPrimaryDocuments[0] !== undefined
      ? `document|${canonicalPrimaryDocuments[0]}`
      : structuredIdentity === null
        ? "non-repeatable"
        : [
            "subject",
            structuredIdentity.subject,
            structuredIdentity.eventDomain,
          ].join("|");
  const developmentKey = `development-${stableHash(
    developmentIdentity,
  )}`;
  // One fact is selected per typed logical key. Primary-source facts win;
  // otherwise same-tier consensus wins, followed by access and lexical
  // tie-breakers. Context-free dates and numbers never enter this vote.
  const structuredFacts = reconciledMaterialFacts(
    signals,
    semantic,
  );
  const materialFactsFingerprint = `facts-${stableHash(
    structuredFacts.length > 0
      ? structuredFacts
          .map((fact) => `${fact.kind}|${fact.key}|${fact.value}`)
          .join("\n")
      : "no-structured-change",
  )}`;

  return NewsDevelopmentSchema.parse({
    id: `cluster-${stableHash(sortedItems.map(({ id }) => id).join("|"))}`,
    title: representativeItem.title,
    itemIds: sortedItems.map(({ id }) => id),
    items: sortedItems,
    representativeItem,
    canonicalPrimaryDocument:
      canonicalPrimaryDocuments[0] ?? null,
    primaryDocumentUrls: canonicalPrimaryDocuments,
    namedEntities: [...entities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value),
    eventFamilies,
    materialFacts: structuredFacts,
    sectionEligibility,
    primarySection: section,
    developmentKey,
    repeatable,
    materialFactsFingerprint,
    materialChange: sortedItems.some(
      (item) => item.metadata.materialChange === true,
    ),
    publishedFrom: published[0] ?? null,
    publishedTo: published.at(-1) ?? null,
    sourceRefs: [...sourceRefs.values()].sort((left, right) =>
      sourceRefKey(left).localeCompare(sourceRefKey(right)),
    ),
    editorialSignals: signals,
    sourceEvidence,
    corroboratingSourceIds,
    corroboratingSourceCount: corroboratingSourceIds.length,
  });
}

export function clusterNews(
  input: readonly Item[],
  embeddings: EmbeddingLookup,
): NewsCluster[] {
  const items = input
    .map((item) => ItemSchema.parse(item))
    .filter((item) => NEWS_KINDS.has(item.kind))
    .sort(
      (left, right) =>
        (left.publishedAt ?? "").localeCompare(right.publishedAt ?? "") ||
        left.id.localeCompare(right.id),
    );
  const groups: Item[][] = [];
  for (const item of items) {
    const matchingGroup = groups.find(
      (group) =>
        group.some((member) => related(item, member, embeddings)) &&
        group.every((member) => withinWindow(item, member)),
    );
    if (matchingGroup === undefined) groups.push([item]);
    else matchingGroup.push(item);
  }
  return groups
    .map(cluster)
    .sort((left, right) => left.id.localeCompare(right.id));
}
