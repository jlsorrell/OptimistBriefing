import type {
  EditionEntry,
  EditionSection,
} from "../contracts/editorial";
import type {
  CompositionResult,
  PipelineContext,
  ValidatedSummaryCandidate,
} from "./types";

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
): Promise<CompositionResult> {
  const valid = candidates.filter((candidate) => candidate.valid).slice(0, 8);
  const edition = {
    id: `edition:${context.runId}`,
    editionDate: context.editionDate,
    runId: context.runId,
    status: "draft" as const,
    readingMinutes: valid.length === 0 ? null : 20,
    publishedAt: null,
    createdAt: context.now(),
  };
  await context.store.createDraft(edition);

  const entries: EditionEntry[] = valid.map((candidate, position) => ({
    id: `${edition.id}:entry:${position}`,
    editionId: edition.id,
    itemId: candidate.item.id,
    section: sectionFor(candidate),
    position,
    summary: candidate.summary,
    selectionReasons: ["Validated for this edition."],
    sourceRefs: candidate.item.sourceRefs,
  }));
  await context.store.replaceEntries(edition.id, entries);

  const missing = missingSections(entries);
  const complete = entries.length >= 6 && entries.length <= 8;
  const partial = !complete && missing.length === 0;
  return {
    edition,
    entries,
    status: complete ? "published" : partial ? "partial" : "failed",
    missingSections: missing,
    sourceFailures: context.sourceFailures ?? [],
  };
}
