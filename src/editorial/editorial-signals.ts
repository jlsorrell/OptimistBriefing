import type { Item } from "../contracts/editorial";
import {
  EditorialSignalRecordSchema,
  NewsMaterialFactSchema,
  type EditorialSignalRecord,
  type NewsMaterialFact,
} from "../sources/types";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function materialFacts(value: unknown): NewsMaterialFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): NewsMaterialFact[] => {
    const parsed = NewsMaterialFactSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function editorialSignalKey(
  signal: EditorialSignalRecord,
): string {
  return [
    signal.itemId,
    signal.itemKind,
    signal.sourceId,
    signal.sourceName,
    signal.sourceUrl,
    signal.sourceRole,
    signal.accessLevel,
    signal.canCorroborateFacts ? "1" : "0",
    signal.sectionEligibility.join("\u001f"),
    signal.namedEntities.join("\u001f"),
    signal.primaryDocumentUrls.join("\u001f"),
    signal.eventFamilies.join("\u001f"),
    ...signal.materialFacts.map(
      (fact) => `${fact.kind}:${fact.key}:${fact.value}`,
    ),
  ].join("\u0000");
}

export function editorialSignals(item: Item): EditorialSignalRecord[] {
  const rawSignals = item.metadata.editorialSignals;
  if (Array.isArray(rawSignals)) {
    const parsed = rawSignals.flatMap(
      (entry): EditorialSignalRecord[] => {
        const result = EditorialSignalRecordSchema.safeParse(entry);
        return result.success ? [result.data] : [];
      },
    );
    if (parsed.length > 0) {
      return parsed.sort((left, right) =>
        editorialSignalKey(left).localeCompare(
          editorialSignalKey(right),
        ),
      );
    }
  }

  const primaryDocumentUrls = [
    ...stringArray(item.metadata.primaryDocumentUrls),
    ...(typeof item.metadata.primaryDocumentUrl === "string"
      ? [item.metadata.primaryDocumentUrl]
      : []),
    ...(item.kind === "document" ? [item.canonicalUrl] : []),
  ];
  return item.sourceRefs
    .map((source) =>
      EditorialSignalRecordSchema.parse({
        itemId: item.id,
        itemKind: item.kind,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        sourceRole: source.role,
        accessLevel: item.accessLevel,
        canCorroborateFacts:
          item.metadata.canCorroborateFacts !== false &&
          (source.role === "primary" ||
            source.role === "reporting"),
        sectionEligibility: stringArray(
          item.metadata.sectionEligibility,
        ),
        namedEntities: stringArray(item.metadata.namedEntities),
        primaryDocumentUrls,
        eventFamilies: stringArray(item.metadata.eventFamilies),
        materialFacts: materialFacts(item.metadata.materialFacts),
      }),
    )
    .sort((left, right) =>
      editorialSignalKey(left).localeCompare(
        editorialSignalKey(right),
      ),
    );
}
