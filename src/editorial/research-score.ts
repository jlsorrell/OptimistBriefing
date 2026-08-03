import { z } from "zod";

import {
  ItemSchema,
  ItemScoreSchema,
  ResearchAssessmentSchema,
  type Item,
  type ItemScore,
  type ResearchAssessment,
} from "../contracts/editorial";

export const RESEARCH_SCORE_WEIGHTS = Object.freeze({
  topicalFit: 0.35,
  technicalQuality: 0.3,
  researchSignal: 0.15,
  novelty: 0.1,
  seriousAttention: 0.1,
});

const ResearchScoreInputSchema = z.object({
  itemId: z.string().min(1),
  topicalFit: z.number().finite(),
  technicalQuality: z.number().finite().nullable(),
  researchSignal: z.number().finite(),
  novelty: z.number().finite().nullable(),
  seriousAttention: z.number().finite().nullable(),
  assessment: ResearchAssessmentSchema.nullable().optional(),
  candidate: ItemSchema.optional(),
});

export type ResearchScoreInput = {
  itemId: string;
  topicalFit: number;
  technicalQuality: number | null;
  researchSignal: number;
  novelty: number | null;
  seriousAttention: number | null;
  assessment?: ResearchAssessment | null;
  candidate?: Item;
};

export type ResearchContextSignals = {
  implementationAvailability: boolean;
  substantiveCommentary: boolean;
  seriousAttention: number;
};

const MAX_ATTACHED_COMMENTARY_SIGNALS = 16;
const CONTEXT_ATTENTION_INCREMENT = 0.15;
const SUBSTANTIVE_COMMENTARY_CODE_POINTS = 200;
const COMMENTARY_PLACEHOLDERS = new Set([
  "abstract unavailable",
  "commentary unavailable",
  "content unavailable",
  "no abstract available",
  "no commentary available",
  "no content available",
  "no substantive commentary available",
  "no summary available",
  "read more",
  "summary unavailable",
]);

function normalizedContextText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

function attachedCommentary(candidate: Item): Record<string, unknown>[] {
  if (!Array.isArray(candidate.metadata.attachedCommentary)) return [];
  return candidate.metadata.attachedCommentary
    .slice(0, MAX_ATTACHED_COMMENTARY_SIGNALS)
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object",
    );
}

function isCommentaryPlaceholder(value: string): boolean {
  const statements = value.split(/[.!?]+/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  return statements.length > 0 && statements.every((statement) =>
    COMMENTARY_PLACEHOLDERS.has(statement)
  );
}

export function deriveResearchContextSignals(
  candidate: Item,
): ResearchContextSignals {
  const parsed = ItemSchema.parse(candidate);
  const commentary = attachedCommentary(parsed);
  const implementationAvailability =
    parsed.metadata.implementationAvailable === true ||
    commentary.some((entry) => entry.implementationAvailable === true);
  const substantiveCommentary = commentary.some((entry) => {
    if (typeof entry.excerpt !== "string") return false;
    const excerpt = normalizedContextText(entry.excerpt);
    if (excerpt.length === 0) return false;
    const title = typeof entry.title === "string"
      ? normalizedContextText(entry.title)
      : "";
    return excerpt !== title && !isCommentaryPlaceholder(excerpt) &&
      [...excerpt].length >= SUBSTANTIVE_COMMENTARY_CODE_POINTS;
  });
  const contextCount = Number(implementationAvailability) +
    Number(substantiveCommentary);
  return {
    implementationAvailability,
    substantiveCommentary,
    seriousAttention: Math.min(
      1,
      0.5 + contextCount * CONTEXT_ATTENTION_INCREMENT,
    ),
  };
}

function normalized(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function reason(label: string, value: number): string {
  if (value >= 0.8) return `Strong ${label} (${Math.round(value * 100)}%).`;
  if (value >= 0.6) return `Above-average ${label} (${Math.round(value * 100)}%).`;
  return `${label[0]?.toUpperCase()}${label.slice(1)} ${Math.round(value * 100)}%.`;
}

export function scoreResearch(input: ResearchScoreInput): ItemScore {
  const parsed = ResearchScoreInputSchema.parse(input);
  const contextSignals = parsed.candidate === undefined
    ? {
        implementationAvailability: false,
        substantiveCommentary: false,
        seriousAttention: 0.5,
      }
    : deriveResearchContextSignals(parsed.candidate);
  const topicalFit = normalized(parsed.topicalFit);
  const technicalQuality = normalized(
    parsed.technicalQuality ??
      parsed.assessment?.technicalQuality ??
      0.5,
  );
  const researchSignal = normalized(parsed.researchSignal);
  const novelty = normalized(
    parsed.novelty ?? parsed.assessment?.novelty ?? 0.5,
  );
  const seriousAttention = normalized(
    contextSignals.implementationAvailability ||
        contextSignals.substantiveCommentary
      ? Math.max(
          parsed.seriousAttention ?? 0.5,
          contextSignals.seriousAttention,
        )
      : parsed.seriousAttention ?? 0.5,
  );
  const total = Number(
    (
      topicalFit * RESEARCH_SCORE_WEIGHTS.topicalFit +
      technicalQuality * RESEARCH_SCORE_WEIGHTS.technicalQuality +
      researchSignal * RESEARCH_SCORE_WEIGHTS.researchSignal +
      novelty * RESEARCH_SCORE_WEIGHTS.novelty +
      seriousAttention * RESEARCH_SCORE_WEIGHTS.seriousAttention
    ).toFixed(12),
  );

  return ItemScoreSchema.parse({
    itemId: parsed.itemId,
    topicalFit,
    technicalQuality,
    researchSignal,
    novelty,
    seriousAttention,
    total,
    selectionReasons: [
      reason("topical fit", topicalFit),
      reason("technical quality", technicalQuality),
      reason("research signal", researchSignal),
      reason("novelty", novelty),
      reason("serious attention", seriousAttention),
      ...(contextSignals.implementationAvailability
        ? ["Independent implementation located."]
        : []),
      ...(contextSignals.substantiveCommentary
        ? ["Substantive expert commentary located."]
        : []),
    ],
  });
}
