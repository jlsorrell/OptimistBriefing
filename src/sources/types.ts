import { z } from "zod";

import {
  AccessLevelSchema,
  EditionSectionSchema,
  ItemKindSchema,
  SourceRefSchema,
} from "../contracts/editorial";

export const CollectionWindowSchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .superRefine((window, context) => {
    if (Date.parse(window.from) >= Date.parse(window.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Collection window must end after it starts.",
        path: ["to"],
      });
    }
  });

export const CollectionFailureKindSchema = z.enum([
  "fetch",
  "parse",
  "policy",
  "timeout",
  "unknown",
]);

export const ResearchSourceRestrictionsSchema = z
  .object({
    bodyRetrieval: z.enum(["forbidden", "permitted"]).default("forbidden"),
    preferredSection: EditionSectionSchema.optional(),
  })
  .passthrough();

export const ResearchSourceRecordSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  canonicalUrl: z.string().url(),
  role: SourceRefSchema.shape.role,
  enabled: z.boolean(),
  sectionEligibility: z.array(EditionSectionSchema).optional(),
  restrictions: ResearchSourceRestrictionsSchema,
});

export const RawItemSchema = z.object({
  kind: ItemKindSchema,
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceRole: SourceRefSchema.shape.role,
  title: z.string().min(1),
  originalUrl: z.string().url(),
  externalId: z.string().min(1),
  externalIds: z.array(z.string().min(1)).min(1),
  publishedAt: z.string().datetime().nullable(),
  retrievedAt: z.string().datetime(),
  accessLevel: AccessLevelSchema,
  authors: z.array(z.string().min(1)),
  institutions: z.array(z.string().min(1)),
  abstract: z.string().min(1).nullable(),
  content: z.string().min(1).nullable(),
  relatedPaperIds: z.array(z.string().min(1)),
  metadata: z.record(z.string(), z.unknown()),
});

export const RawResearchCandidateSchema = RawItemSchema.extend({
  kind: z.enum(["paper", "blog"]),
  preferredInstitutionMatches: z.array(z.string().min(1)),
  citationCount: z.number().int().nonnegative().nullable(),
  influentialCitationCount: z.number().int().nonnegative().nullable(),
  topics: z.array(z.string().min(1)),
});

export const NewsMaterialFactSchema = z.object({
  kind: z.enum(["status", "number", "date", "amount"]),
  key: z.string().min(1),
  value: z.string().min(1),
});

export const CanonicalEventDomainSchema = z.enum([
  "funding-event",
  "product-event",
  "governance-event",
  "evaluation-event",
]);

export const CanonicalEventInstanceSchema = z.object({
  subject: z.string().min(1),
  domain: CanonicalEventDomainSchema,
  object: z.string().min(1),
});

export const ScopedNewsMaterialFactSchema =
  NewsMaterialFactSchema.extend({
    eventInstance: CanonicalEventInstanceSchema,
  });

export const EditorialSignalRecordSchema = z.object({
  itemId: z.string().min(1),
  itemKind: ItemKindSchema,
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceRole: SourceRefSchema.shape.role,
  accessLevel: AccessLevelSchema,
  canCorroborateFacts: z.boolean(),
  sectionEligibility: z.array(EditionSectionSchema),
  namedEntities: z.array(z.string().min(1)),
  primaryDocumentUrls: z.array(z.string().url()),
  eventFamilies: z.array(z.string().min(1)),
  eventInstances: z.array(CanonicalEventInstanceSchema),
  materialFacts: z.array(NewsMaterialFactSchema),
  scopedMaterialFacts: z.array(ScopedNewsMaterialFactSchema),
});

export const RawNewsCandidateSchema = RawItemSchema.extend({
  kind: z.enum(["article", "document", "forecast"]),
  canCorroborateFacts: z.boolean(),
  sectionEligibility: z.array(EditionSectionSchema).default([]),
  namedEntities: z.array(z.string().min(1)).default([]),
  primaryDocumentUrl: z.string().url().nullable().default(null),
  primaryDocumentUrls: z.array(z.string().url()).default([]),
  eventFamilies: z.array(z.string().min(1)).default([]),
  materialFacts: z.array(NewsMaterialFactSchema).default([]),
  eventInstances: z.array(CanonicalEventInstanceSchema).optional(),
  scopedMaterialFacts: z
    .array(ScopedNewsMaterialFactSchema)
    .optional(),
}).superRefine((candidate, context) => {
  if (
    candidate.canCorroborateFacts &&
    candidate.sourceRole !== "primary" &&
    candidate.sourceRole !== "reporting"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Only primary documents and reporting may corroborate facts.",
      path: ["canCorroborateFacts"],
    });
  }
  if (
    candidate.kind === "forecast" &&
    (candidate.sourceRole !== "forecast" ||
      candidate.canCorroborateFacts)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Forecasts must be non-corroborating forecast sources.",
      path: ["sourceRole"],
    });
  }
});

export type CollectionWindow = z.infer<typeof CollectionWindowSchema>;
export type CollectionFailureKind = z.infer<
  typeof CollectionFailureKindSchema
>;
export type CollectionFailure = {
  sourceId: string;
  kind: CollectionFailureKind;
};
export type SourceCollection<T> = {
  sourceId: string;
  collect(): Promise<readonly T[]>;
};
export type CollectionBatch<T> = {
  candidates: readonly T[];
  succeededSourceIds: readonly string[];
  failures: readonly CollectionFailure[];
};
export type ResearchSourceRecord = z.infer<
  typeof ResearchSourceRecordSchema
>;
export type ResearchSourceInput = Omit<
  ResearchSourceRecord,
  "restrictions"
> & {
  restrictions: Record<string, unknown>;
};
export type RawItem = z.infer<typeof RawItemSchema>;
export type RawResearchCandidate = z.infer<
  typeof RawResearchCandidateSchema
>;
export type RawNewsCandidate = z.infer<typeof RawNewsCandidateSchema>;
export type NewsMaterialFact = z.infer<typeof NewsMaterialFactSchema>;
export type CanonicalEventDomain = z.infer<
  typeof CanonicalEventDomainSchema
>;
export type CanonicalEventInstance = z.infer<
  typeof CanonicalEventInstanceSchema
>;
export type ScopedNewsMaterialFact = z.infer<
  typeof ScopedNewsMaterialFactSchema
>;
export type EditorialSignalRecord = z.infer<
  typeof EditorialSignalRecordSchema
>;

export interface SourceAdapter {
  readonly sourceId: string;
  collect(window: CollectionWindow): Promise<RawItem[]>;
}

export interface ResearchEnricher {
  readonly sourceId: string;
  enrich(
    candidates: readonly RawResearchCandidate[],
  ): Promise<RawResearchCandidate[]>;
}

export interface NewsSourceAdapter {
  readonly sourceId: string;
  collect(window: CollectionWindow): Promise<RawNewsCandidate[]>;
}

export function bodyRetrievalPermitted(
  source: ResearchSourceInput,
): boolean {
  const restrictions = ResearchSourceRecordSchema.parse(source).restrictions;
  return restrictions.bodyRetrieval === "permitted";
}
