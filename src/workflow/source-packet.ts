import type { Item } from "../contracts/editorial";
import type { NewsDevelopment } from "../editorial/cluster";
import type { SourcePacket } from "../editorial/validate-summary";
import { WorkflowItemPayloadSchema } from "./types";
import { truncateProviderTextAtCodePointBoundary } from "../sources/provider-text";

type SourceDocument = SourcePacket["sources"][number];

type AttachedCommentaryDocument = {
  sourceId: string;
  title: string;
  url: string;
  retrievedAt: string;
  accessLevel: SourceDocument["accessLevel"];
  excerpt: string;
};

const UNSAFE_PACKET_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function sanitizedPacketText(value: string | undefined, maximum: number): string {
  if (value === undefined) return "";
  const scalarSafe = truncateProviderTextAtCodePointBoundary(value, 100_000);
  if (UNSAFE_PACKET_TEXT.test(scalarSafe)) return "";
  const normalized = scalarSafe.replace(/\s+/gu, " ").trim();
  return truncateProviderTextAtCodePointBoundary(normalized, maximum);
}

function firstPacketText(...values: readonly string[]): string {
  return values.find((value) => value.length > 0) ?? "";
}

function stringSet(value: unknown): ReadonlySet<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
}

function attachedCommentaryBySource(
  value: unknown,
): ReadonlyMap<string, AttachedCommentaryDocument> {
  if (!Array.isArray(value)) return new Map();
  const result = new Map<string, AttachedCommentaryDocument>();
  for (const entry of value.slice(0, 16)) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as Partial<AttachedCommentaryDocument>;
    if (
      typeof candidate.sourceId !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.url !== "string" ||
      typeof candidate.retrievedAt !== "string" ||
      typeof candidate.excerpt !== "string" ||
      (candidate.accessLevel !== "metadata" &&
        candidate.accessLevel !== "abstract" &&
        candidate.accessLevel !== "full_text" &&
        candidate.accessLevel !== "secondary")
    ) {
      continue;
    }
    if (!result.has(candidate.sourceId)) {
      result.set(candidate.sourceId, candidate as AttachedCommentaryDocument);
    }
  }
  return result;
}

function sourceDocumentForItem(item: Item): SourcePacket {
  const sources = new Map<string, SourceDocument>();
  const researchItem = item.kind === "paper" || item.kind === "blog";
  const primaryResearchSourceIds = stringSet(
    item.metadata.primaryResearchSourceIds,
  );
  const attachedCommentary = attachedCommentaryBySource(
    item.metadata.attachedCommentary,
  );
  for (const source of item.sourceRefs) {
    if (sources.has(source.id)) continue;
    const commentary = attachedCommentary.get(source.id);
    const commentaryExcerpt = sanitizedPacketText(
      commentary?.excerpt,
      4_000,
    );
    const itemExcerpt = sanitizedPacketText(item.normalizedText, 4_000);
    const titleExcerpt = sanitizedPacketText(item.title, 4_000);
    const itemTitle = sanitizedPacketText(item.title, 500);
    sources.set(source.id, {
      sourceId: source.id,
      sourceName: source.name,
      evidenceKind: researchItem
        ? primaryResearchSourceIds.has(source.id)
          ? "primary-research"
          : "commentary"
        : "news-evidence",
      role: source.role,
      title: firstPacketText(
        sanitizedPacketText(commentary?.title, 500),
        itemTitle,
      ),
      url: commentary?.url ?? source.url,
      retrievedAt: commentary?.retrievedAt ?? source.retrievedAt,
      accessLevel: commentary?.accessLevel ?? item.accessLevel,
      excerpts: [{
        number: 1,
        text: firstPacketText(
          commentaryExcerpt,
          itemExcerpt,
          titleExcerpt,
        ),
      }],
    });
  }
  return {
    itemKind: item.kind,
    sources: [...sources.values()]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .slice(0, 12),
  };
}

function sourceDocumentsForDevelopment(
  item: Item,
  development: NewsDevelopment,
): SourcePacket {
  const grouped = new Map<string, SourceDocument>();
  for (const developmentItem of development.items) {
    for (const source of developmentItem.sourceRefs) {
      const current = grouped.get(source.id);
      if ((current?.excerpts.length ?? 0) >= 4) continue;
      const excerpt = {
        number: (current?.excerpts.length ?? 0) + 1,
        text: firstPacketText(
          sanitizedPacketText(developmentItem.normalizedText, 4_000),
          sanitizedPacketText(developmentItem.title, 4_000),
        ),
      };
      grouped.set(source.id, {
        sourceId: source.id,
        sourceName: source.name,
        evidenceKind: "news-evidence",
        role: source.role,
        title: sanitizedPacketText(developmentItem.title, 500),
        url: source.url,
        retrievedAt: source.retrievedAt,
        accessLevel: developmentItem.accessLevel,
        excerpts: [...(current?.excerpts ?? []), excerpt],
      });
    }
  }
  return {
    itemKind: item.kind,
    sources: [...grouped.values()]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .slice(0, 12),
  };
}

export function sourcePacketForItem(item: Item): SourcePacket {
  const workflow = WorkflowItemPayloadSchema.safeParse(item.metadata.workflow);
  const development = workflow.success ? workflow.data.development : undefined;
  return development === undefined
    ? sourceDocumentForItem(item)
    : sourceDocumentsForDevelopment(item, development);
}
