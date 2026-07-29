import { z } from "zod";

import {
  AccessLevelSchema,
  SourceRefSchema,
} from "../contracts/editorial";
import {
  NewsDevelopmentSchema,
  type NewsDevelopment,
} from "./cluster";

export const NEWS_SCORE_WEIGHTS = Object.freeze({
  publicImportance: 0.25,
  personalRelevance: 0.2,
  sourceQuality: 0.15,
  corroboration: 0.15,
  recency: 0.1,
  geography: 0.1,
  novelty: 0.05,
});

export const NewsEvidenceSourceSchema = z.object({
  sourceId: z.string().min(1),
  role: SourceRefSchema.shape.role,
  accessLevel: AccessLevelSchema,
  provenanceUrl: z.string().url(),
  canCorroborateFacts: z.boolean(),
});

const NewsScoreInputSchema = z.object({
  itemId: z.string().min(1),
  publicImportance: z.number().finite(),
  personalRelevance: z.number().finite(),
  sourceQuality: z.number().finite(),
  recency: z.number().finite(),
  geography: z.number().finite(),
  novelty: z.number().finite(),
  evidence: z.array(NewsEvidenceSourceSchema),
});

export const NewsScoreSchema = z.object({
  itemId: z.string().min(1),
  publicImportance: z.number().min(0).max(1),
  personalRelevance: z.number().min(0).max(1),
  sourceQuality: z.number().min(0).max(1),
  corroboration: z.number().min(0).max(1),
  recency: z.number().min(0).max(1),
  geography: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  corroboratingSourceCount: z.number().int().nonnegative(),
  corroboratingSourceIds: z.array(z.string().min(1)),
  evidence: z.array(NewsEvidenceSourceSchema),
  total: z.number().min(0).max(1),
  selectionReasons: z.array(z.string().min(1)),
});

export type NewsEvidenceSource = z.infer<typeof NewsEvidenceSourceSchema>;
export type NewsScoreInput = z.input<typeof NewsScoreInputSchema>;
export type NewsScore = z.infer<typeof NewsScoreSchema>;
export type NewsDevelopmentScoreInput = Omit<
  NewsScoreInput,
  "itemId" | "evidence"
>;

function normalized(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function evidenceOrder(
  left: NewsEvidenceSource,
  right: NewsEvidenceSource,
): number {
  return (
    left.sourceId.localeCompare(right.sourceId) ||
    left.role.localeCompare(right.role) ||
    left.provenanceUrl.localeCompare(right.provenanceUrl)
  );
}

function reason(label: string, value: number): string {
  return `${label} ${Math.round(value * 100)}%.`;
}

export function scoreNews(input: NewsScoreInput): NewsScore {
  const parsed = NewsScoreInputSchema.parse(input);
  const evidence = [...parsed.evidence].sort(evidenceOrder);
  const corroboratingSourceIds = [
    ...new Set(
      evidence
        .filter(
          (source) =>
            source.canCorroborateFacts &&
            (source.role === "primary" || source.role === "reporting"),
        )
        .map((source) => source.sourceId),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const corroboration = Math.min(
    1,
    corroboratingSourceIds.length / 3,
  );
  const components = {
    publicImportance: normalized(parsed.publicImportance),
    personalRelevance: normalized(parsed.personalRelevance),
    sourceQuality: normalized(parsed.sourceQuality),
    corroboration,
    recency: normalized(parsed.recency),
    geography: normalized(parsed.geography),
    novelty: normalized(parsed.novelty),
  };
  const total = Number(
    (
      components.publicImportance * NEWS_SCORE_WEIGHTS.publicImportance +
      components.personalRelevance * NEWS_SCORE_WEIGHTS.personalRelevance +
      components.sourceQuality * NEWS_SCORE_WEIGHTS.sourceQuality +
      components.corroboration * NEWS_SCORE_WEIGHTS.corroboration +
      components.recency * NEWS_SCORE_WEIGHTS.recency +
      components.geography * NEWS_SCORE_WEIGHTS.geography +
      components.novelty * NEWS_SCORE_WEIGHTS.novelty
    ).toFixed(12),
  );

  return NewsScoreSchema.parse({
    itemId: parsed.itemId,
    ...components,
    corroboratingSourceCount: corroboratingSourceIds.length,
    corroboratingSourceIds,
    evidence,
    total,
    selectionReasons: [
      reason("Public importance", components.publicImportance),
      reason("Personal relevance", components.personalRelevance),
      reason("Source quality", components.sourceQuality),
      reason("Corroboration", components.corroboration),
      reason("Recency", components.recency),
      reason("Geographic fit", components.geography),
      reason("Novelty", components.novelty),
    ],
  });
}

export function scoreNewsDevelopment(
  development: NewsDevelopment,
  input: NewsDevelopmentScoreInput,
): NewsScore {
  const parsed = NewsDevelopmentSchema.parse(development);
  return scoreNews({
    ...input,
    itemId: parsed.id,
    evidence: parsed.sourceEvidence.map((source) => ({
      sourceId: source.sourceId,
      role: source.role,
      accessLevel: source.accessLevel,
      provenanceUrl: source.provenanceUrl,
      canCorroborateFacts: source.canCorroborateFacts,
    })),
  });
}
