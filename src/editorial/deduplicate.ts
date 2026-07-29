import {
  ItemSchema,
  type AccessLevel,
  type Item,
  type SourceRef,
} from "../contracts/editorial";
import {
  type NewsMaterialFact,
} from "../sources/types";
import {
  editorialSignalKey,
  editorialSignals,
} from "./editorial-signals";
import { normalizeTitleKey } from "./normalize";

export type DeduplicationReason =
  | "external_identifier"
  | "canonical_url"
  | "near_duplicate_title_time";

export type DeduplicationMerge = {
  keptItemId: string;
  mergedItemId: string;
  reason: DeduplicationReason;
};

export type DeduplicationResult = {
  items: Item[];
  merges: DeduplicationMerge[];
};

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function identifiers(item: Item): ReadonlySet<string> {
  return new Set(stringArray(item.metadata.externalIds));
}

function intersects(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function words(title: string): ReadonlySet<string> {
  return new Set(
    normalizeTitleKey(title)
      .split(" ")
      .filter((word) => word.length > 0),
  );
}

export function titleSimilarity(left: string, right: string): number {
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let intersection = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) intersection += 1;
  }
  const union = leftWords.size + rightWords.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function compatiblePublicationWindow(left: Item, right: Item): boolean {
  if (left.publishedAt === null || right.publishedAt === null) return false;
  const leftTimestamp = Date.parse(left.publishedAt);
  const rightTimestamp = Date.parse(right.publishedAt);
  const isResearch =
    (left.kind === "paper" || left.kind === "blog") &&
    (right.kind === "paper" || right.kind === "blog");
  const windowMs = (isResearch ? 14 : 3) * 24 * 60 * 60 * 1_000;
  return Math.abs(leftTimestamp - rightTimestamp) <= windowMs;
}

function compatibleNearDuplicateKinds(left: Item, right: Item): boolean {
  if (left.kind === right.kind) return left.kind !== "forecast";
  return (
    (left.kind === "article" && right.kind === "document") ||
    (left.kind === "document" && right.kind === "article")
  );
}

function duplicateReason(
  left: Item,
  right: Item,
): DeduplicationReason | null {
  if (intersects(identifiers(left), identifiers(right))) {
    return "external_identifier";
  }
  if (left.canonicalUrl === right.canonicalUrl) return "canonical_url";
  if (
    compatibleNearDuplicateKinds(left, right) &&
    compatiblePublicationWindow(left, right) &&
    titleSimilarity(left.title, right.title) >= 0.82
  ) {
    return "near_duplicate_title_time";
  }
  return null;
}

function sourcePriority(item: Item): number {
  return Math.max(
    ...item.sourceRefs.map((source) => ROLE_PRIORITY[source.role]),
  );
}

function stableItemKey(item: Item): string {
  return [
    item.id,
    item.canonicalUrl,
    item.title,
    ...item.sourceRefs.map(sourceRefKey).sort(),
  ].join("\u0000");
}

function preferredItem(left: Item, right: Item): Item {
  const accessDifference =
    ACCESS_PRIORITY[right.accessLevel] - ACCESS_PRIORITY[left.accessLevel];
  if (accessDifference !== 0) return accessDifference > 0 ? right : left;
  const sourceDifference = sourcePriority(right) - sourcePriority(left);
  if (sourceDifference !== 0) return sourceDifference > 0 ? right : left;
  const textDifference =
    right.normalizedText.length - left.normalizedText.length;
  if (textDifference !== 0) return textDifference > 0 ? right : left;
  return stableItemKey(left).localeCompare(stableItemKey(right)) <= 0
    ? left
    : right;
}

function sourceRefKey(source: SourceRef): string {
  return [
    source.id,
    source.name,
    source.url,
    source.role,
    source.retrievedAt,
  ].join("\u0000");
}

function mergeGroup(group: readonly Item[]): Item {
  const winner = group.reduce(preferredItem);
  const sources = new Map<string, SourceRef>();
  for (const item of group) {
    for (const source of item.sourceRefs) {
      sources.set(sourceRefKey(source), source);
    }
  }
  const mergedExternalIds = [
    ...new Set(
      group.flatMap((item) => stringArray(item.metadata.externalIds)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const provenance = group.flatMap((item) =>
    Array.isArray(item.metadata.provenance)
      ? item.metadata.provenance
      : [],
  );
  const mergedStringMetadata = (key: string): string[] => [
    ...new Set(
      group.flatMap((item) => stringArray(item.metadata[key])),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const sectionEligibility = mergedStringMetadata(
    "sectionEligibility",
  );
  const signalMap = new Map(
    group
      .flatMap(editorialSignals)
      .map((signal) => [editorialSignalKey(signal), signal]),
  );
  const structuredSignals = [...signalMap.values()].sort(
    (left, right) =>
      editorialSignalKey(left).localeCompare(
        editorialSignalKey(right),
      ),
  );
  const corroboratingSignals = structuredSignals.filter(
    (signal) => signal.canCorroborateFacts,
  );
  const namedEntities = mergedStringMetadata("namedEntities");
  const primaryDocumentUrls = [
    ...new Set(
      group.flatMap((item) => [
        ...stringArray(item.metadata.primaryDocumentUrls),
        ...(typeof item.metadata.primaryDocumentUrl === "string"
          ? [item.metadata.primaryDocumentUrl]
          : []),
      ]),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const allEventFamilies = [
    ...new Set(
      structuredSignals.flatMap((signal) => signal.eventFamilies),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const eventFamilies = [
    ...new Set(
      corroboratingSignals.flatMap(
        (signal) => signal.eventFamilies,
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const primarySections = [
    ...new Set(
      group.flatMap((item) => [
        ...stringArray(item.metadata.primarySections),
        ...(typeof item.metadata.primarySection === "string"
          ? [item.metadata.primarySection]
          : []),
      ]),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const materialFactMap = new Map<string, NewsMaterialFact>();
  for (const fact of corroboratingSignals.flatMap(
    (signal) => signal.materialFacts,
  )) {
    materialFactMap.set(
      `${fact.kind}\u0000${fact.key}\u0000${fact.value}`,
      fact,
    );
  }
  const materialFacts = [...materialFactMap.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key) ||
      left.value.localeCompare(right.value),
  );
  const longestText = [...group].sort(
    (left, right) =>
      right.normalizedText.length - left.normalizedText.length ||
      left.id.localeCompare(right.id),
  )[0]?.normalizedText ?? winner.normalizedText;

  return ItemSchema.parse({
    ...winner,
    sourceRefs: [...sources.values()].sort((left, right) =>
      sourceRefKey(left).localeCompare(sourceRefKey(right)),
    ),
    normalizedText: longestText,
    metadata: {
      ...winner.metadata,
      externalIds: mergedExternalIds,
      provenance,
      sectionEligibility,
      namedEntities,
      primaryDocumentUrl: primaryDocumentUrls[0] ?? null,
      primaryDocumentUrls,
      eventFamilies,
      allEventFamilies,
      materialFacts,
      editorialSignals: structuredSignals,
      primarySections,
      canCorroborateFacts: group.some(
        (item) => item.metadata.canCorroborateFacts === true,
      ),
      mergedItemIds: group
        .map((item) => item.id)
        .sort((left, right) => left.localeCompare(right)),
    },
  });
}

function union(
  parent: number[],
  left: number,
  right: number,
): void {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot === rightRoot) return;
  const lower = Math.min(leftRoot, rightRoot);
  const upper = Math.max(leftRoot, rightRoot);
  parent[upper] = lower;
}

function find(parent: number[], index: number): number {
  const direct = parent[index];
  if (direct === undefined) throw new RangeError("Invalid deduplication index.");
  if (direct === index) return index;
  const root = find(parent, direct);
  parent[index] = root;
  return root;
}

export function deduplicateItems(
  input: readonly Item[],
): DeduplicationResult {
  const items = input
    .map((item) => ItemSchema.parse(item))
    .sort((left, right) =>
      stableItemKey(left).localeCompare(stableItemKey(right)),
    );
  const parent = items.map((_, index) => index);
  const pairReasons = new Map<string, DeduplicationReason>();

  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftItem = items[left];
      const rightItem = items[right];
      if (leftItem === undefined || rightItem === undefined) continue;
      const reason = duplicateReason(leftItem, rightItem);
      if (reason === null) continue;
      union(parent, left, right);
      pairReasons.set(`${left}:${right}`, reason);
    }
  }

  const groups = new Map<number, Item[]>();
  items.forEach((item, index) => {
    const root = find(parent, index);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });

  const mergedItems: Item[] = [];
  const merges: DeduplicationMerge[] = [];
  for (const group of groups.values()) {
    const winner = group.reduce(preferredItem);
    const merged = mergeGroup(group);
    mergedItems.push(merged);
    let retainedWinner = false;
    for (const item of group) {
      if (!retainedWinner && item === winner) {
        retainedWinner = true;
        continue;
      }
      const winnerIndex = items.indexOf(winner);
      const itemIndex = items.indexOf(item);
      const lower = Math.min(winnerIndex, itemIndex);
      const upper = Math.max(winnerIndex, itemIndex);
      const reason =
        pairReasons.get(`${lower}:${upper}`) ??
        group
          .flatMap((candidate) => {
            const candidateIndex = items.findIndex(
              (entry) => entry.id === candidate.id,
            );
            const pairLower = Math.min(candidateIndex, itemIndex);
            const pairUpper = Math.max(candidateIndex, itemIndex);
            return pairReasons.get(`${pairLower}:${pairUpper}`) ?? [];
          })
          .sort()[0] ??
        "near_duplicate_title_time";
      merges.push({
        keptItemId: merged.id,
        mergedItemId: item.id,
        reason,
      });
    }
  }

  return {
    items: mergedItems.sort((left, right) => left.id.localeCompare(right.id)),
    merges: merges.sort(
      (left, right) =>
        left.keptItemId.localeCompare(right.keptItemId) ||
        left.mergedItemId.localeCompare(right.mergedItemId),
    ),
  };
}
