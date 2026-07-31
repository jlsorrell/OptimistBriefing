import { z } from "zod";

import {
  ItemScoreSchema,
  ResearchAssessmentSchema,
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
});

export type ResearchScoreInput = {
  itemId: string;
  topicalFit: number;
  technicalQuality: number | null;
  researchSignal: number;
  novelty: number | null;
  seriousAttention: number | null;
  assessment?: ResearchAssessment | null;
};

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
  const seriousAttention = normalized(parsed.seriousAttention ?? 0.5);
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
    ],
  });
}
