import {
  ItemSchema,
  type AccessLevel,
  type Item,
  type SourceRef,
} from "../contracts/editorial";
import {
  normalizeArxivIdentifier,
  normalizeDoi,
} from "../sources/identifiers";
import { truncateProviderTextAtCodePointBoundary } from "../sources/provider-text";
import {
  mergeItemGroup,
  preferredItem,
  type ItemMergeGroup,
} from "./deduplicate";
import {
  canonicalizeUrl,
  normalizeAuthorKey,
  normalizeTitleKey,
} from "./normalize";

const PROVIDER_NAMES = new Map([
  ["openalex", "openalex"],
  ["papers-with-code", "papers-with-code"],
  ["semanticscholar", "semanticscholar"],
]);
const COMMENTARY_EXCERPT_LIMIT = 800;

export type AttachedResearchCommentary = {
  sourceId: string;
  role: "blog";
  title: string;
  url: string;
  retrievedAt: string;
  accessLevel: AccessLevel;
  excerpt: string;
  relatedPaperIds: string[];
  implementationAvailable?: true;
};

export type ResearchIdentityMergeReason =
  | "arxiv"
  | "doi"
  | "provider_id"
  | "canonical_url"
  | "title_author"
  | "explicit_commentary_link"
  | "commentary_title_author";

export type ResearchIdentityMerge = {
  keptItemId: string;
  mergedItemId: string;
  reason: ResearchIdentityMergeReason;
};

export type ConsolidatedResearchCandidates = {
  papers: Item[];
  standaloneCommentary: Item[];
  merges: ResearchIdentityMerge[];
  mergeGroups: ItemMergeGroup[];
};

type DurableIdentities = {
  arxiv: ReadonlySet<string>;
  doi: ReadonlySet<string>;
  provider: ReadonlySet<string>;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function itemExternalIds(item: Item): string[] {
  return [
    ...stringArray(item.metadata.externalIds),
    ...(typeof item.metadata.externalId === "string"
      ? [item.metadata.externalId]
      : []),
  ];
}

function providerIdentity(value: string): string | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const provider = PROVIDER_NAMES.get(
    value.slice(0, separator).toLocaleLowerCase("en-US"),
  );
  if (provider === undefined) return null;
  const identifier = value.slice(separator + 1).trim();
  return identifier.length === 0 ? null : `${provider}:${identifier}`;
}

function durableIdentities(values: readonly string[]): DurableIdentities {
  const arxiv = new Set<string>();
  const doi = new Set<string>();
  const provider = new Set<string>();
  for (const value of values) {
    const normalizedArxiv = normalizeArxivIdentifier(value);
    if (normalizedArxiv !== null) {
      arxiv.add(`arxiv:${normalizedArxiv.slice("arXiv:".length)}`);
      continue;
    }
    const normalizedDoi = normalizeDoi(value);
    if (normalizedDoi !== null) {
      doi.add(`doi:${normalizedDoi}`);
      continue;
    }
    const normalizedProvider = providerIdentity(value);
    if (normalizedProvider !== null) provider.add(normalizedProvider);
  }
  return { arxiv, doi, provider };
}

function itemDurableIdentities(item: Item): DurableIdentities {
  return durableIdentities(itemExternalIds(item));
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

function durableIdentityConflict(
  left: DurableIdentities,
  right: DurableIdentities,
): boolean {
  if (left.arxiv.size > 0 && right.arxiv.size > 0) {
    return !intersects(left.arxiv, right.arxiv);
  }
  if (left.doi.size > 0 && right.doi.size > 0) {
    return !intersects(left.doi, right.doi);
  }
  if (left.provider.size > 0 && right.provider.size > 0) {
    return !intersects(left.provider, right.provider);
  }
  return false;
}

function mergeDurableIdentities(
  left: DurableIdentities,
  right: DurableIdentities,
): DurableIdentities {
  return {
    arxiv: new Set([...left.arxiv, ...right.arxiv]),
    doi: new Set([...left.doi, ...right.doi]),
    provider: new Set([...left.provider, ...right.provider]),
  };
}

function normalizedAuthors(item: Item): ReadonlySet<string> {
  const stored = stringArray(item.metadata.normalizedAuthors);
  const values = stored.length > 0
    ? stored
    : stringArray(item.metadata.authors).map(normalizeAuthorKey);
  return new Set(values.filter((author) => author.length > 0));
}

function titleAndAuthorMatch(left: Item, right: Item): boolean {
  return normalizeTitleKey(left.title) === normalizeTitleKey(right.title) &&
    intersects(normalizedAuthors(left), normalizedAuthors(right));
}

function researchMatchReason(
  left: Item,
  right: Item,
): ResearchIdentityMergeReason | null {
  const leftIds = itemDurableIdentities(left);
  const rightIds = itemDurableIdentities(right);
  if (intersects(leftIds.arxiv, rightIds.arxiv)) return "arxiv";
  if (leftIds.arxiv.size > 0 && rightIds.arxiv.size > 0) return null;
  if (intersects(leftIds.doi, rightIds.doi)) return "doi";
  if (leftIds.doi.size > 0 && rightIds.doi.size > 0) return null;
  if (intersects(leftIds.provider, rightIds.provider)) return "provider_id";
  if (leftIds.provider.size > 0 && rightIds.provider.size > 0) return null;
  if (left.canonicalUrl === right.canonicalUrl) return "canonical_url";
  return titleAndAuthorMatch(left, right) ? "title_author" : null;
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

function stableItemKey(item: Item): string {
  return [
    canonicalResearchIdentity(item),
    item.id,
    item.canonicalUrl,
    ...item.sourceRefs.map(sourceRefKey).sort(),
  ].join("\u0000");
}

function union(parent: number[], left: number, right: number): void {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot === rightRoot) return;
  parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
}

function find(parent: number[], index: number): number {
  const direct = parent[index];
  if (direct === undefined) throw new RangeError("Invalid research identity index.");
  if (direct === index) return index;
  const root = find(parent, direct);
  parent[index] = root;
  return root;
}

function isCommentary(item: Item): boolean {
  if (typeof item.metadata.discoveryFamily === "string") {
    return item.metadata.discoveryFamily === "commentary";
  }
  return item.kind === "blog" ||
    item.sourceRefs.every((source) => source.role === "blog");
}

function commentaryRelatedIds(item: Item): string[] {
  return stringArray(item.metadata.relatedPaperIds);
}

function canonicalUrlIdentity(value: string): string | null {
  try {
    return canonicalizeUrl(value);
  } catch {
    return null;
  }
}

function explicitCommentaryMatch(
  commentary: Item,
  paperMembers: readonly Item[],
): boolean {
  const relatedValues = commentaryRelatedIds(commentary);
  const related = durableIdentities(relatedValues);
  const commentaryIds = itemDurableIdentities(commentary);
  const relatedUrls = new Set(
    relatedValues.flatMap((value) => {
      const canonical = canonicalUrlIdentity(value);
      return canonical === null ? [] : [canonical];
    }),
  );
  return paperMembers.some((paper) => {
    const paperIds = itemDurableIdentities(paper);
    return intersects(related.arxiv, paperIds.arxiv) ||
      intersects(related.doi, paperIds.doi) ||
      intersects(related.provider, paperIds.provider) ||
      intersects(commentaryIds.arxiv, paperIds.arxiv) ||
      intersects(commentaryIds.doi, paperIds.doi) ||
      intersects(commentaryIds.provider, paperIds.provider) ||
      relatedUrls.has(paper.canonicalUrl);
  });
}

function commentaryMatchReason(
  commentary: Item,
  paperMembers: readonly Item[],
): ResearchIdentityMergeReason | null {
  if (explicitCommentaryMatch(commentary, paperMembers)) {
    return "explicit_commentary_link";
  }
  return paperMembers.some((paper) => titleAndAuthorMatch(commentary, paper))
    ? "commentary_title_author"
    : null;
}

function attachedCommentary(
  commentary: Item,
): AttachedResearchCommentary[] {
  const relatedPaperIds = [...new Set(commentaryRelatedIds(commentary))].sort(
    (left, right) => left.localeCompare(right),
  );
  const excerpt = truncateProviderTextAtCodePointBoundary(
    commentary.normalizedText,
    COMMENTARY_EXCERPT_LIMIT,
  );
  return commentary.sourceRefs.map((source) => ({
    sourceId: source.id,
    role: "blog" as const,
    title: commentary.title,
    url: source.url,
    retrievedAt: source.retrievedAt,
    accessLevel: commentary.accessLevel,
    excerpt,
    relatedPaperIds,
    ...(commentary.metadata.implementationAvailable === true
      ? { implementationAvailable: true as const }
      : {}),
  }));
}

function attachedCommentaryKey(commentary: AttachedResearchCommentary): string {
  return [
    commentary.sourceId,
    commentary.url,
    commentary.title,
    commentary.retrievedAt,
  ].join("\u0000");
}

function existingAttachedCommentary(value: unknown): AttachedResearchCommentary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AttachedResearchCommentary[] => {
    if (entry === null || typeof entry !== "object") return [];
    const candidate = entry as Partial<AttachedResearchCommentary>;
    return typeof candidate.sourceId === "string" &&
      candidate.role === "blog" &&
      typeof candidate.title === "string" &&
      typeof candidate.url === "string" &&
      typeof candidate.retrievedAt === "string" &&
      typeof candidate.excerpt === "string" &&
      Array.isArray(candidate.relatedPaperIds) &&
      candidate.relatedPaperIds.every((id) => typeof id === "string") &&
      (candidate.accessLevel === "metadata" ||
        candidate.accessLevel === "secondary" ||
        candidate.accessLevel === "abstract" ||
        candidate.accessLevel === "full_text")
      ? [{
          sourceId: candidate.sourceId,
          role: "blog",
          title: candidate.title,
          url: candidate.url,
          retrievedAt: candidate.retrievedAt,
          accessLevel: candidate.accessLevel,
          excerpt: candidate.excerpt,
          relatedPaperIds: [...candidate.relatedPaperIds],
          ...(candidate.implementationAvailable === true
            ? { implementationAvailable: true as const }
            : {}),
        }]
      : [];
  });
}

function attachCommentary(paper: Item, commentary: Item): Item {
  const discoveryLaneIds = [...new Set([
    ...stringArray(paper.metadata.discoveryLaneIds),
    ...stringArray(commentary.metadata.discoveryLaneIds),
  ])].sort((left, right) => left.localeCompare(right)).slice(0, 64);
  const discoveryLineage = [...new Set([
    ...stringArray(paper.metadata.discoveryLineage),
    ...stringArray(commentary.metadata.discoveryLineage),
  ])].sort((left, right) => left.localeCompare(right)).slice(0, 1_024);
  const commentaryMetadata = new Map<string, AttachedResearchCommentary>();
  for (const entry of [
    ...existingAttachedCommentary(paper.metadata.attachedCommentary),
    ...attachedCommentary(commentary),
  ]) {
    commentaryMetadata.set(attachedCommentaryKey(entry), entry);
  }
  const sourceRefs = new Map<string, SourceRef>();
  for (const source of [
    ...paper.sourceRefs,
    ...commentary.sourceRefs.map((source) => ({ ...source, role: "blog" as const })),
  ]) {
    sourceRefs.set(sourceRefKey(source), source);
  }
  return ItemSchema.parse({
    ...paper,
    sourceRefs: [...sourceRefs.values()].sort((left, right) =>
      sourceRefKey(left).localeCompare(sourceRefKey(right)),
    ),
    metadata: {
      ...paper.metadata,
      discoveryLaneIds,
      discoveryLineage,
      attachedCommentary: [...commentaryMetadata.values()].sort((left, right) =>
        attachedCommentaryKey(left).localeCompare(attachedCommentaryKey(right)),
      ),
    },
  });
}

function substantiveCommentary(item: Item): boolean {
  return item.normalizedText.length > 0 &&
    (item.accessLevel !== "metadata" || item.normalizedText !== item.title);
}

function asStandaloneCommentary(item: Item): Item {
  return ItemSchema.parse({
    ...item,
    kind: "blog",
    sourceRefs: item.sourceRefs.map((source) => ({ ...source, role: "blog" })),
    metadata: {
      ...item.metadata,
      primaryResearchSourceIds: [],
    },
  });
}

export function canonicalResearchIdentity(candidate: Item): string {
  const item = ItemSchema.parse(candidate);
  const identities = itemDurableIdentities(item);
  const arxiv = [...identities.arxiv].sort()[0];
  if (arxiv !== undefined) return arxiv;
  const doi = [...identities.doi].sort()[0];
  if (doi !== undefined) return doi;
  const provider = [...identities.provider].sort()[0];
  return provider ?? item.canonicalUrl;
}

export function consolidateResearchCandidates(
  candidates: readonly Item[],
): ConsolidatedResearchCandidates {
  const input = candidates
    .map((candidate) => ItemSchema.parse(candidate))
    .sort((left, right) => stableItemKey(left).localeCompare(stableItemKey(right)));
  const paperCandidates = input.filter((candidate) => !isCommentary(candidate));
  const commentaryCandidates = input.filter(isCommentary);
  const parent = paperCandidates.map((_, index) => index);
  const componentIdentities = paperCandidates.map(itemDurableIdentities);
  const pairReasons = new Map<string, ResearchIdentityMergeReason>();
  for (let left = 0; left < paperCandidates.length; left += 1) {
    for (let right = left + 1; right < paperCandidates.length; right += 1) {
      const leftItem = paperCandidates[left];
      const rightItem = paperCandidates[right];
      if (leftItem === undefined || rightItem === undefined) continue;
      const reason = researchMatchReason(leftItem, rightItem);
      if (reason === null) continue;
      const leftRoot = find(parent, left);
      const rightRoot = find(parent, right);
      if (leftRoot !== rightRoot) {
        const leftIdentities = componentIdentities[leftRoot];
        const rightIdentities = componentIdentities[rightRoot];
        if (
          leftIdentities === undefined ||
          rightIdentities === undefined ||
          durableIdentityConflict(leftIdentities, rightIdentities)
        ) continue;
        const mergedIdentities = mergeDurableIdentities(
          leftIdentities,
          rightIdentities,
        );
        union(parent, leftRoot, rightRoot);
        componentIdentities[find(parent, leftRoot)] = mergedIdentities;
      }
      pairReasons.set(`${left}:${right}`, reason);
    }
  }

  const grouped = new Map<number, Item[]>();
  paperCandidates.forEach((candidate, index) => {
    const root = find(parent, index);
    grouped.set(root, [...(grouped.get(root) ?? []), candidate]);
  });
  const paperGroups = [...grouped.values()].map((members) => ({
    members,
    retainedItem: members.reduce(preferredItem),
    attachedCommentary: [] as Item[],
    paper: mergeItemGroup(members),
  }));
  const merges: ResearchIdentityMerge[] = [];
  for (const { members, paper, retainedItem } of paperGroups) {
    members.forEach((member) => {
      if (member === retainedItem) return;
      const memberIndex = paperCandidates.indexOf(member);
      const reason = members.flatMap((other) => {
        const otherIndex = paperCandidates.indexOf(other);
        const lower = Math.min(memberIndex, otherIndex);
        const upper = Math.max(memberIndex, otherIndex);
        return pairReasons.get(`${lower}:${upper}`) ?? [];
      }).sort()[0] ?? "title_author";
      merges.push({
        keptItemId: paper.id,
        mergedItemId: member.id,
        reason,
      });
    });
  }

  const standaloneCommentary: Item[] = [];
  for (const commentary of commentaryCandidates) {
    const matches = paperGroups.flatMap((group, index) => {
      const reason = commentaryMatchReason(commentary, group.members);
      return reason === null ? [] : [{ index, reason }];
    });
    if (matches.length === 0) {
      if (substantiveCommentary(commentary)) {
        standaloneCommentary.push(asStandaloneCommentary(commentary));
      }
      continue;
    }
    for (const { index, reason } of matches) {
      const group = paperGroups[index];
      if (group === undefined) continue;
      group.paper = attachCommentary(group.paper, commentary);
      group.attachedCommentary.push(commentary);
      merges.push({
        keptItemId: group.paper.id,
        mergedItemId: commentary.id,
        reason,
      });
    }
  }

  return {
    papers: paperGroups
      .map(({ paper }) => paper)
      .sort((left, right) => stableItemKey(left).localeCompare(stableItemKey(right))),
    standaloneCommentary: standaloneCommentary.sort((left, right) =>
      stableItemKey(left).localeCompare(stableItemKey(right)),
    ),
    merges: merges.sort((left, right) =>
      left.keptItemId.localeCompare(right.keptItemId) ||
      left.mergedItemId.localeCompare(right.mergedItemId) ||
      left.reason.localeCompare(right.reason),
    ),
    mergeGroups: paperGroups.map((group) => ({
      retainedItem: group.retainedItem,
      inputItems: [...group.members, ...group.attachedCommentary],
    })),
  };
}
