import type { Item } from "../contracts/editorial";
import type { NewsDevelopment } from "../editorial/cluster";
import type { SourcePacket } from "../editorial/validate-summary";
import { WorkflowItemPayloadSchema } from "./types";

type SourceDocument = SourcePacket["sources"][number];

function sourceDocumentForItem(item: Item): SourcePacket {
  const sources = new Map<string, SourceDocument>();
  for (const source of item.sourceRefs) {
    if (sources.has(source.id)) continue;
    sources.set(source.id, {
      sourceId: source.id,
      role: source.role,
      title: item.title,
      url: source.url,
      retrievedAt: source.retrievedAt,
      accessLevel: item.accessLevel,
      excerpts: [{
        number: 1,
        text: item.normalizedText.slice(0, 4_000) || item.title,
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
        text: developmentItem.normalizedText.slice(0, 4_000) ||
          developmentItem.title,
      };
      grouped.set(source.id, {
        sourceId: source.id,
        role: source.role,
        title: developmentItem.title,
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
