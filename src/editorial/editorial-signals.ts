import type { Item } from "../contracts/editorial";
import {
  CanonicalEventInstanceSchema,
  EditorialSignalRecordSchema,
  NewsMaterialFactSchema,
  ScopedNewsMaterialFactSchema,
  type CanonicalEventInstance,
  type EditorialSignalRecord,
  type NewsMaterialFact,
  type ScopedNewsMaterialFact,
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
    ...signal.eventInstances.map(
      (instance) =>
        `${instance.subject}:${instance.domain}:${instance.object}`,
    ),
    ...signal.materialFacts.map(
      (fact) => `${fact.kind}:${fact.key}:${fact.value}`,
    ),
    ...signal.scopedMaterialFacts.map(
      (fact) =>
        `${fact.eventInstance.subject}:${fact.eventInstance.domain}:${fact.eventInstance.object}:${fact.kind}:${fact.key}:${fact.value}`,
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

  const primaryDocumentUrls = [...new Set([
    ...stringArray(item.metadata.primaryDocumentUrls),
    ...(typeof item.metadata.primaryDocumentUrl === "string"
      ? [item.metadata.primaryDocumentUrl]
      : []),
    ...(item.kind === "document" ? [item.canonicalUrl] : []),
  ])].sort((left, right) => left.localeCompare(right));
  const itemEventInstances = eventInstances(
    item.metadata.eventInstances,
  );
  const itemMaterialFacts = materialFacts(item.metadata.materialFacts);
  const itemScopedFacts = scopedMaterialFacts(
    item.metadata.scopedMaterialFacts,
  );
  const boundFacts = itemScopedFacts;
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
        eventInstances: itemEventInstances,
        materialFacts: itemMaterialFacts,
        scopedMaterialFacts: boundFacts,
      }),
    )
    .sort((left, right) =>
      editorialSignalKey(left).localeCompare(
        editorialSignalKey(right),
      ),
    );
}
