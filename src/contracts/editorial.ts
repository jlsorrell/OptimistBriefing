import { z } from "zod";

export const ItemKindSchema = z.enum([
  "paper",
  "blog",
  "article",
  "document",
  "forecast",
]);

export const AccessLevelSchema = z.enum([
  "metadata",
  "abstract",
  "full_text",
  "secondary",
]);

export const EditionSectionSchema = z.enum([
  "morning_brief",
  "research",
  "research_radar",
  "world",
  "technology",
  "ai_policy",
  "dmv",
  "baltimore",
  "forecast",
]);

export const SourceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  role: z.enum(["primary", "reporting", "analysis", "opinion", "blog", "forecast"]),
  retrievedAt: z.string().datetime(),
});

export const SummaryClaimSchema = z.object({
  text: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
  evidenceExcerpt: z.string().min(1).max(800),
});

export const StructuredSummarySchema = z.object({
  title: z.string().min(1),
  oneSentence: z.string().min(1),
  whyItMatters: z.string().min(1),
  uncertainty: z.string().min(1),
  claims: z.array(SummaryClaimSchema).min(1),
  accessLevel: AccessLevelSchema,
});

export const ItemSchema = z.object({
  id: z.string().min(1),
  kind: ItemKindSchema,
  canonicalUrl: z.string().url(),
  title: z.string().min(1),
  publishedAt: z.string().datetime().nullable(),
  sourceRefs: z.array(SourceRefSchema).min(1),
  accessLevel: AccessLevelSchema,
  primaryTopic: z.string().min(1),
  tags: z.array(z.string().min(1)),
  normalizedText: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});

export const ResearchAssessmentSchema = z.object({
  technicalQuality: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  strengths: z.array(z.string().min(1)).min(1),
  limitations: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
  accessLevel: AccessLevelSchema,
});

export const ItemScoreSchema = z.object({
  itemId: z.string().min(1),
  topicalFit: z.number().min(0).max(1),
  technicalQuality: z.number().min(0).max(1),
  researchSignal: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  seriousAttention: z.number().min(0).max(1),
  total: z.number().min(0).max(1),
  selectionReasons: z.array(z.string().min(1)),
});

export const EditionStatusSchema = z.enum([
  "draft",
  "published",
  "partial",
  "failed",
]);

const CompleteEditionMetadataSchema = z.object({
  missingSections: z.array(z.string().min(1).max(200)).max(32),
  sourceFailures: z.array(z.string().min(1).max(200)).max(64),
}).strict();

const LegacyEditionMetadataSchema = z.object({}).strict().transform(() => ({
  missingSections: [] as string[],
  sourceFailures: [] as string[],
}));

export type EditionMetadata = {
  missingSections: string[];
  sourceFailures: string[];
};

export const EditionMetadataSchema: z.ZodType<
  EditionMetadata,
  z.ZodTypeDef,
  unknown
> = z.union([
  LegacyEditionMetadataSchema,
  CompleteEditionMetadataSchema,
]);

export const EditionSchema = z.object({
  id: z.string().min(1),
  editionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runId: z.string().min(1),
  status: EditionStatusSchema,
  readingMinutes: z.number().int().positive().nullable(),
  publishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  metadata: EditionMetadataSchema.optional(),
});

export const EditionEntrySchema = z
  .object({
    id: z.string().min(1),
    editionId: z.string().min(1),
    itemId: z.string().min(1).nullable(),
    section: EditionSectionSchema,
    position: z.number().int().nonnegative(),
    summary: StructuredSummarySchema,
    selectionReasons: z.array(z.string().min(1)),
    sourceRefs: z.array(SourceRefSchema).min(1),
  })
  .strict()
  .superRefine((entry, context) => {
    const sourceIds = new Set(entry.sourceRefs.map((sourceRef) => sourceRef.id));

    entry.summary.claims.forEach((claim, claimIndex) => {
      claim.sourceIds.forEach((sourceId, sourceIndex) => {
        if (!sourceIds.has(sourceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Claim source must be included in the edition entry sources.",
            path: ["summary", "claims", claimIndex, "sourceIds", sourceIndex],
          });
        }
      });
    });
  });

export const EditionWithEntriesSchema = EditionSchema.extend({
  entries: z.array(EditionEntrySchema),
});

export const RetentionReportSchema = z.object({
  deletedUnselectedCandidates: z.number().int().nonnegative(),
  deletedWorkflowRuns: z.number().int().nonnegative(),
  deletedDiagnosticLogs: z.number().int().nonnegative(),
});

export type ItemKind = z.infer<typeof ItemKindSchema>;
export type AccessLevel = z.infer<typeof AccessLevelSchema>;
export type EditionSection = z.infer<typeof EditionSectionSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type SummaryClaim = z.infer<typeof SummaryClaimSchema>;
export type StructuredSummary = z.infer<typeof StructuredSummarySchema>;
export type Item = z.infer<typeof ItemSchema>;
export type ResearchAssessment = z.infer<typeof ResearchAssessmentSchema>;
export type ItemScore = z.infer<typeof ItemScoreSchema>;
export type EditionStatus = z.infer<typeof EditionStatusSchema>;
export type Edition = z.infer<typeof EditionSchema>;
export type EditionEntry = z.infer<typeof EditionEntrySchema>;
export type EditionWithEntries = z.infer<typeof EditionWithEntriesSchema>;
export type RetentionReport = z.infer<typeof RetentionReportSchema>;
