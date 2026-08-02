import { z } from "zod";

import {
  ItemSchema,
  type Item,
} from "../contracts/editorial";
import {
  DiscoveryFamilySchema,
  type DiscoveryFamily,
  type DiscoveryObservation,
} from "../sources/types";
import { WorkflowItemPayloadSchema } from "../workflow/types";
import { canonicalResearchIdentity } from "./research-identity";

export const RESEARCH_DISCOVERY_FAMILIES = [
  "arxiv",
  "bibliographic",
  "official-publication",
  "commentary",
] as const satisfies readonly DiscoveryFamily[];

export type ResearchTriageExclusionReason =
  | "invalid_content"
  | "below_topical_fit"
  | "family_cap"
  | "publisher_domain_cap"
  | "queue_capacity";

export type ResearchTriageResult = {
  items: Item[];
  exclusions: Array<{
    itemId: string;
    reason: ResearchTriageExclusionReason;
  }>;
  perFamilyCounts: Partial<Record<DiscoveryFamily, number>>;
};

export type ResearchTriageOptions = {
  maximum: number;
  maximumPerFamily: number;
  maximumPerPublisherDomain: number;
  configuredTopics: readonly string[];
  now: string;
  minimumTopicalFit?: number;
};

const NonnegativeIntegerSchema = z.number().int().nonnegative().max(1_000);
const TopicalFitSchema = z.number().finite().min(0).max(1);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function discoveryFamily(item: Item): DiscoveryFamily {
  const direct = DiscoveryFamilySchema.safeParse(item.metadata.discoveryFamily);
  if (direct.success) return direct.data;
  const stored = stringArray(item.metadata.discoveryFamilies)
    .map((family) => DiscoveryFamilySchema.safeParse(family))
    .find((family) => family.success);
  if (stored?.success === true) return stored.data;
  const sourceIds = new Set(item.sourceRefs.map(({ id }) => id));
  if (sourceIds.has("arxiv")) return "arxiv";
  if (sourceIds.has("semantic-scholar") || sourceIds.has("openalex")) {
    return "bibliographic";
  }
  if (
    item.kind === "blog" ||
    item.sourceRefs.every(({ role }) => role === "blog")
  ) {
    return "commentary";
  }
  return "official-publication";
}

function publisherDomain(item: Item): string {
  if (
    typeof item.metadata.publisherDomain === "string" &&
    item.metadata.publisherDomain.trim().length > 0
  ) {
    return item.metadata.publisherDomain.trim().toLocaleLowerCase("en-US");
  }
  try {
    return new URL(item.canonicalUrl).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./u, "");
  } catch {
    return item.canonicalUrl;
  }
}

function timestamp(item: Item): number {
  const updatedAt = typeof item.metadata.updatedAt === "string"
    ? Date.parse(item.metadata.updatedAt)
    : Number.NaN;
  const publishedAt = item.publishedAt === null
    ? Number.NaN
    : Date.parse(item.publishedAt);
  const valid = [updatedAt, publishedAt].filter(Number.isFinite);
  return valid.length === 0 ? 0 : Math.max(...valid);
}

function workflowTopicalFit(item: Item): number | null {
  const workflow = WorkflowItemPayloadSchema.safeParse(item.metadata.workflow);
  if (workflow.success && workflow.data.topicalFit !== undefined) {
    return workflow.data.topicalFit;
  }
  const metadataFit = TopicalFitSchema.safeParse(item.metadata.topicalFit);
  return metadataFit.success ? metadataFit.data : null;
}

function preferredPrior(item: Item): number {
  const workflow = WorkflowItemPayloadSchema.safeParse(item.metadata.workflow);
  const preferredInstitutionCount = workflow.success
    ? workflow.data.rawResearch?.preferredInstitutionMatches.length ?? 0
    : 0;
  const sourcePrior = item.sourceRefs.some(({ role }) => role === "primary")
    ? 1
    : item.sourceRefs.some(({ role }) => role === "analysis" || role === "blog")
      ? 0.5
      : 0;
  return Math.min(1, preferredInstitutionCount) + sourcePrior;
}

function stableCanonicalKey(item: Item): string {
  return `${canonicalResearchIdentity(item)}\u0000${item.id}`;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function stableEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableEvidenceValue).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableEvidenceValue(entry)]),
    );
  }
  return value;
}

export type ResearchFingerprints = {
  contentFingerprint: string;
  evidenceFingerprint: string;
};

export function researchFingerprints(input: Item): ResearchFingerprints {
  const item = ItemSchema.parse(input);
  const storedContent = typeof item.metadata.contentFingerprint === "string" &&
      item.metadata.contentFingerprint.length > 0
    ? item.metadata.contentFingerprint
    : null;
  const storedEvidence =
    typeof item.metadata.evidenceFingerprint === "string" &&
      item.metadata.evidenceFingerprint.length > 0
      ? item.metadata.evidenceFingerprint
      : null;
  if (storedContent !== null && storedEvidence !== null) {
    return {
      contentFingerprint: storedContent,
      evidenceFingerprint: storedEvidence,
    };
  }
  const workflow = WorkflowItemPayloadSchema.safeParse(item.metadata.workflow);
  const raw = workflow.success ? workflow.data.rawResearch : undefined;
  const contentMaterial = JSON.stringify({
    title: item.title,
    text: item.normalizedText,
    accessLevel: item.accessLevel,
    publishedAt: item.publishedAt,
    updatedAt:
      typeof item.metadata.updatedAt === "string"
        ? item.metadata.updatedAt
        : null,
  });
  const contentFingerprint =
    storedContent ?? `content:${stableHash(contentMaterial)}`;
  const evidenceMaterial = JSON.stringify(stableEvidenceValue({
    contentFingerprint,
    externalIds: stringArray(item.metadata.externalIds),
    relatedPaperIds: stringArray(item.metadata.relatedPaperIds),
    configuredTopics: stringArray(item.metadata.configuredTopics),
    authors: stringArray(item.metadata.normalizedAuthors).length > 0
      ? stringArray(item.metadata.normalizedAuthors)
      : stringArray(item.metadata.authors),
    institutions: stringArray(item.metadata.institutions),
    citationCount: raw?.citationCount ?? null,
    influentialCitationCount: raw?.influentialCitationCount ?? null,
    implementationAvailable: item.metadata.implementationAvailable === true,
    attachedCommentary: item.metadata.attachedCommentary ?? [],
  }));
  return {
    contentFingerprint,
    evidenceFingerprint:
      storedEvidence ?? `evidence:${stableHash(evidenceMaterial)}`,
  };
}

function compareBounded(left: Item, right: Item): number {
  return timestamp(right) - timestamp(left) ||
    preferredPrior(right) - preferredPrior(left) ||
    stableCanonicalKey(left).localeCompare(stableCanonicalKey(right));
}

function compareTriaged(left: Item, right: Item): number {
  return (workflowTopicalFit(right) ?? 0) -
      (workflowTopicalFit(left) ?? 0) ||
    preferredPrior(right) - preferredPrior(left) ||
    timestamp(right) - timestamp(left) ||
    left.id.localeCompare(right.id);
}

function researchTopics(item: Item): string[] {
  const configured = stringArray(item.metadata.configuredTopics);
  if (configured.length > 0) return configured;
  const workflow = WorkflowItemPayloadSchema.safeParse(item.metadata.workflow);
  return workflow.success ? workflow.data.rawResearch?.topics ?? [] : [];
}

function validatedMaximum(value: number, label: string): number {
  const parsed = NonnegativeIntegerSchema.safeParse(value);
  if (!parsed.success) {
    throw new RangeError(`${label} must be an integer from 0 to 1000.`);
  }
  return parsed.data;
}

export function boundResearchDiscoveryPool(
  items: readonly Item[],
  maximum = 500,
): Item[] {
  const limit = validatedMaximum(maximum, "maximum");
  if (limit === 0 || items.length === 0) return [];
  const parsed = items.map((item, index) => ({
    item: ItemSchema.parse(item),
    index,
  }));
  const reservation = Math.floor(limit / RESEARCH_DISCOVERY_FAMILIES.length);
  const selectedIndexes = new Set<number>();

  for (const family of RESEARCH_DISCOVERY_FAMILIES) {
    parsed
      .filter(({ item }) => discoveryFamily(item) === family)
      .sort((left, right) =>
        compareBounded(left.item, right.item) || left.index - right.index
      )
      .slice(0, reservation)
      .forEach(({ index }) => selectedIndexes.add(index));
  }

  for (const entry of [...parsed].sort((left, right) =>
    compareBounded(left.item, right.item) || left.index - right.index
  )) {
    if (selectedIndexes.size >= limit) break;
    selectedIndexes.add(entry.index);
  }
  return parsed
    .filter(({ index }) => selectedIndexes.has(index))
    .sort((left, right) =>
      compareBounded(left.item, right.item) || left.index - right.index
    )
    .map(({ item }) => item);
}

export function triageResearch(
  items: readonly Item[],
  options: ResearchTriageOptions,
): ResearchTriageResult {
  const maximum = validatedMaximum(options.maximum, "maximum");
  const maximumPerFamily = validatedMaximum(
    options.maximumPerFamily,
    "maximumPerFamily",
  );
  const maximumPerPublisherDomain = validatedMaximum(
    options.maximumPerPublisherDomain,
    "maximumPerPublisherDomain",
  );
  const now = Date.parse(options.now);
  if (!Number.isFinite(now)) throw new RangeError("now must be an ISO timestamp.");
  const minimumTopicalFit = TopicalFitSchema.parse(
    options.minimumTopicalFit ?? 0.5,
  );
  const exclusions: ResearchTriageResult["exclusions"] = [];
  const qualified = items.map((item) => ItemSchema.parse(item)).filter((item) => {
    if (item.normalizedText.trim().length === 0) {
      exclusions.push({ itemId: item.id, reason: "invalid_content" });
      return false;
    }
    const topicalFit = workflowTopicalFit(item);
    if (topicalFit === null || topicalFit < minimumTopicalFit) {
      exclusions.push({ itemId: item.id, reason: "below_topical_fit" });
      return false;
    }
    return true;
  }).sort(compareTriaged);

  const selected: Item[] = [];
  const selectedIds = new Set<string>();
  const perFamily = new Map<DiscoveryFamily, number>();
  const perDomain = new Map<string, number>();
  const canSelect = (item: Item): boolean =>
    selected.length < maximum &&
    (perFamily.get(discoveryFamily(item)) ?? 0) < maximumPerFamily &&
    (perDomain.get(publisherDomain(item)) ?? 0) < maximumPerPublisherDomain;
  const select = (item: Item): boolean => {
    if (selectedIds.has(item.id) || !canSelect(item)) return false;
    selected.push(item);
    selectedIds.add(item.id);
    const family = discoveryFamily(item);
    const domain = publisherDomain(item);
    perFamily.set(family, (perFamily.get(family) ?? 0) + 1);
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    return true;
  };

  for (const topic of options.configuredTopics) {
    const representative = qualified.find((item) =>
      !selectedIds.has(item.id) && researchTopics(item).includes(topic) &&
      canSelect(item)
    );
    if (representative !== undefined) select(representative);
  }
  for (const family of RESEARCH_DISCOVERY_FAMILIES) {
    if ((perFamily.get(family) ?? 0) > 0) continue;
    const representative = qualified.find((item) =>
      !selectedIds.has(item.id) && discoveryFamily(item) === family &&
      canSelect(item)
    );
    if (representative !== undefined) select(representative);
  }
  for (const item of qualified) select(item);

  for (const item of qualified) {
    if (selectedIds.has(item.id)) continue;
    const reason: ResearchTriageExclusionReason =
      (perFamily.get(discoveryFamily(item)) ?? 0) >= maximumPerFamily
        ? "family_cap"
        : (perDomain.get(publisherDomain(item)) ?? 0) >=
            maximumPerPublisherDomain
          ? "publisher_domain_cap"
          : "queue_capacity";
    exclusions.push({ itemId: item.id, reason });
  }

  return {
    items: selected,
    exclusions: exclusions.sort((left, right) =>
      left.itemId.localeCompare(right.itemId) ||
      left.reason.localeCompare(right.reason)
    ),
    perFamilyCounts: Object.fromEntries(perFamily),
  };
}

export function classifyDiscoveryWindow(
  input: Item,
  priorObservations: readonly DiscoveryObservation[],
  now: string,
): "fresh" | "reconsideration" | null {
  const candidate = ItemSchema.parse(input);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be an ISO timestamp.");
  const candidateTimestamp = timestamp(candidate);
  const ageMs = nowMs - candidateTimestamp;
  const hourMs = 60 * 60 * 1_000;
  if (ageMs < 0 || ageMs > 7 * 24 * hourMs) return null;
  if (ageMs <= 36 * hourMs) return "fresh";

  const canonicalId = canonicalResearchIdentity(candidate);
  const relevant = priorObservations.filter(
    (observation) => observation.canonicalId === canonicalId,
  );
  const fingerprints = researchFingerprints(candidate);
  const seenContent = relevant.some(
    (observation) =>
      observation.contentFingerprint === fingerprints.contentFingerprint,
  );
  const seenEvidence = relevant.some(
    (observation) =>
      observation.evidenceFingerprint === fingerprints.evidenceFingerprint,
  );
  return seenContent && seenEvidence ? null : "reconsideration";
}
