import type {
  EditionEntry,
  EditionMetadata,
  EditionSection,
  Item,
} from "../contracts/editorial";
import { WorkflowItemPayloadSchema } from "./types";
import type {
  CompositionResult,
  PipelineContext,
  ValidatedSummaryCandidate,
} from "./types";
import { boundedSourceFailureMetadata } from "../sources/collection-settlement";

const SECTIONS = new Set<EditionSection>([
  "research",
  "research_radar",
  "world",
  "technology",
  "ai_policy",
  "dmv",
  "baltimore",
  "forecast",
]);

function sectionFor(entry: ValidatedSummaryCandidate): EditionSection {
  const configured = entry.item.metadata.section;
  return typeof configured === "string" && SECTIONS.has(configured as EditionSection)
    ? configured as EditionSection
    : entry.item.kind === "paper" || entry.item.kind === "blog"
      ? "research"
      : "world";
}

function missingSections(entries: readonly EditionEntry[]): string[] {
  const sections = new Set(entries.map((entry) => entry.section));
  return [
    ...(sections.has("research") ? [] : ["research"]),
    ...(entries.some((entry) => !["research", "research_radar", "dmv", "baltimore"].includes(entry.section))
      ? []
      : ["nonlocal_news"]),
    ...(sections.has("dmv") || sections.has("baltimore") ? [] : ["dmv_or_baltimore"]),
  ];
}

export async function composeEdition(
  context: PipelineContext,
  candidates: readonly ValidatedSummaryCandidate[],
  persistedItems: readonly Item[],
): Promise<CompositionResult> {
  const valid = candidates.filter((candidate) => candidate.valid).slice(0, 8);
  const persistedItemIds = new Set(persistedItems.map(({ id }) => id));
  const sourceFailures = boundedSourceFailureMetadata(
    context.sourceFailures ?? [],
  );
  const edition = {
    id: `edition:${context.runId}`,
    editionDate: context.editionDate,
    runId: context.runId,
    status: "draft" as const,
    readingMinutes: valid.length === 0 ? null : 20,
    publishedAt: null,
    createdAt: context.now(),
    metadata: { missingSections: [], sourceFailures } as EditionMetadata,
  };

  const entries: EditionEntry[] = valid.map((candidate, position) => {
    const workflow = WorkflowItemPayloadSchema.safeParse(
      candidate.item.metadata.workflow,
    );
    const itemId = workflow.success && workflow.data.development !== undefined
      ? workflow.data.development.representativeItem.id
      : candidate.item.id;
    if (!persistedItemIds.has(itemId)) {
      throw new Error(`UNPERSISTED_EDITION_ITEM:${itemId}`);
    }
    return {
      id: `${edition.id}:entry:${position}`,
      editionId: edition.id,
      itemId,
      section: sectionFor(candidate),
      position,
      summary: candidate.summary,
      selectionReasons:
        workflow.success &&
          (workflow.data.selectionReasons?.length ?? 0) > 0
          ? [...(workflow.data.selectionReasons ?? [])]
          : ["Selected by the editorial shortlist."],
      sourceRefs: candidate.item.sourceRefs,
    };
  });
  const missing = missingSections(entries);
  edition.metadata = { missingSections: missing, sourceFailures };
  const complete = entries.length >= 6 && entries.length <= 8 && missing.length === 0;
  const partial = !complete && missing.length === 0;
  return {
    edition,
    entries,
    status: complete ? "published" : partial ? "partial" : "failed",
    missingSections: missing,
    sourceFailures,
  };
}
