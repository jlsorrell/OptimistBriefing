import { z } from "zod";

import {
  AccessLevelSchema,
  EditionSectionSchema,
  ItemKindSchema,
  SourceRefSchema,
} from "../contracts/editorial";

export const MAX_PROVIDER_TITLE_CHARACTERS = 500;
export const MAX_PROVIDER_EVIDENCE_CHARACTERS = 4_000;
export const MAX_PROVIDER_CONTENT_CHARACTERS = 100_000;
export const MAX_PROVIDER_ARRAY_ITEMS = 64;
export const MAX_PROVIDER_METADATA_BYTES = 64 * 1_024;

const ProviderIdSchema = z.string().min(1).max(2_048);
const ProviderNameSchema = z.string().min(1).max(500);
const ProviderTitleSchema = z
  .string()
  .min(1)
  .max(MAX_PROVIDER_TITLE_CHARACTERS);
const ProviderUrlSchema = z.string().max(2_048).url();
const ProviderEvidenceSchema = z
  .string()
  .min(1)
  .max(MAX_PROVIDER_EVIDENCE_CHARACTERS);
const ProviderMetadataSchema = z.record(z.string().max(200), z.unknown())
  .superRefine((metadata, context) => {
    let encodedBytes: number;
    try {
      encodedBytes = new TextEncoder().encode(JSON.stringify(metadata))
        .byteLength;
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provider metadata must be JSON serializable.",
      });
      return;
    }
    if (encodedBytes > MAX_PROVIDER_METADATA_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provider metadata exceeds the encoded-byte limit.",
      });
    }
  });

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

export const DiscoveryFamilySchema = z.enum([
  "arxiv",
  "bibliographic",
  "official-publication",
  "commentary",
]);

export const DiscoveryWindowKindSchema = z.enum([
  "fresh",
  "reconsideration",
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
  sourceId: ProviderIdSchema,
  sourceName: ProviderNameSchema,
  sourceRole: SourceRefSchema.shape.role,
  title: ProviderTitleSchema,
  originalUrl: ProviderUrlSchema,
  externalId: ProviderIdSchema,
  externalIds: z.array(ProviderIdSchema).min(1).max(32),
  publishedAt: z.string().datetime().nullable(),
  retrievedAt: z.string().datetime(),
  accessLevel: AccessLevelSchema,
  authors: z.array(ProviderNameSchema).max(MAX_PROVIDER_ARRAY_ITEMS),
  institutions: z.array(ProviderNameSchema).max(MAX_PROVIDER_ARRAY_ITEMS),
  abstract: ProviderEvidenceSchema.nullable(),
  content: z.string().min(1).max(MAX_PROVIDER_CONTENT_CHARACTERS).nullable(),
  relatedPaperIds: z.array(ProviderIdSchema).max(32),
  metadata: ProviderMetadataSchema,
});

export const RawResearchCandidateSchema = RawItemSchema.extend({
  kind: z.enum(["paper", "blog"]),
  preferredInstitutionMatches: z.array(ProviderNameSchema).max(
    MAX_PROVIDER_ARRAY_ITEMS,
  ),
  citationCount: z.number().int().nonnegative().nullable(),
  influentialCitationCount: z.number().int().nonnegative().nullable(),
  topics: z.array(ProviderNameSchema).max(MAX_PROVIDER_ARRAY_ITEMS),
});

export const RawPublicationCandidateSchema = RawItemSchema
  .omit({ kind: true })
  .extend({
    kind: z.literal("publication"),
    sectionEligibility: z.array(EditionSectionSchema).min(1),
    discoveryFamily: DiscoveryFamilySchema,
    relatedPaperIds: z.array(ProviderIdSchema).max(16),
  });

export const DiscoveryObservationSchema = z
  .object({
    runId: ProviderIdSchema,
    canonicalId: ProviderIdSchema,
    sourceId: ProviderIdSchema,
    discoveryFamily: DiscoveryFamilySchema,
    windowKind: DiscoveryWindowKindSchema,
    publishedAt: z.string().datetime().nullable(),
    retrievedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    contentFingerprint: z.string().min(1).max(200),
    evidenceFingerprint: z.string().min(1).max(200),
    joinedExternalIds: z.array(ProviderIdSchema).max(32),
    route: z.enum(["research", "technology", "ai_policy", "excluded"]),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const DiscoveryRejectionReasonSchema = z.enum([
  "out_of_window",
  "unchanged_observation",
  "identity_merged",
  "route_excluded",
  "topic_mismatch",
  "quality_rejected",
  "capacity_limited",
]);
export type DiscoveryRejectionReason = z.infer<
  typeof DiscoveryRejectionReasonSchema
>;

const DiscoveryRejectionCountSchema = z.number()
  .int()
  .nonnegative()
  .max(10_000);

export const DiscoveryRejectionCountsSchema = z
  .object({
    out_of_window: DiscoveryRejectionCountSchema.optional(),
    unchanged_observation: DiscoveryRejectionCountSchema.optional(),
    identity_merged: DiscoveryRejectionCountSchema.optional(),
    route_excluded: DiscoveryRejectionCountSchema.optional(),
    topic_mismatch: DiscoveryRejectionCountSchema.optional(),
    quality_rejected: DiscoveryRejectionCountSchema.optional(),
    capacity_limited: DiscoveryRejectionCountSchema.optional(),
  })
  .strict();

export const DiscoveryLaneDiagnosticSchema = z
  .object({
    laneId: z.string().min(1).max(200),
    sourceId: ProviderIdSchema,
    discoveryFamily: DiscoveryFamilySchema,
    discovered: z.number().int().nonnegative().max(10_000),
    deduplicated: z.number().int().nonnegative().max(10_000),
    triaged: z.number().int().nonnegative().max(10_000),
    assessed: z.number().int().nonnegative().max(10_000),
    outcome: z.enum(["success", "fetch", "parse", "policy", "timeout", "unknown"]),
    rejectionCounts: DiscoveryRejectionCountsSchema.default({}),
  })
  .strict()
  .superRefine((diagnostic, context) => {
    const stages = [
      ["deduplicated", diagnostic.deduplicated, diagnostic.discovered],
      ["triaged", diagnostic.triaged, diagnostic.deduplicated],
      ["assessed", diagnostic.assessed, diagnostic.triaged],
    ] as const;
    for (const [field, count, previous] of stages) {
      if (count > previous) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} cannot exceed the preceding funnel stage.`,
          path: [field],
        });
      }
    }
  });

export const NewsMaterialFactSchema = z.object({
  kind: z.enum(["status", "number", "date", "amount"]),
  key: ProviderNameSchema,
  value: ProviderEvidenceSchema,
});

export const CanonicalEventDomainSchema = z.enum([
  "funding-event",
  "product-event",
  "governance-event",
  "evaluation-event",
]);

export const CanonicalEventInstanceSchema = z.object({
  subject: ProviderNameSchema,
  domain: CanonicalEventDomainSchema,
  object: ProviderNameSchema,
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
  namedEntities: z.array(ProviderNameSchema).max(MAX_PROVIDER_ARRAY_ITEMS)
    .default([]),
  primaryDocumentUrl: ProviderUrlSchema.nullable().default(null),
  primaryDocumentUrls: z.array(ProviderUrlSchema).max(16).default([]),
  eventFamilies: z.array(ProviderNameSchema).max(MAX_PROVIDER_ARRAY_ITEMS)
    .default([]),
  materialFacts: z.array(NewsMaterialFactSchema).max(MAX_PROVIDER_ARRAY_ITEMS)
    .default([]),
  eventInstances: z.array(CanonicalEventInstanceSchema).max(
    MAX_PROVIDER_ARRAY_ITEMS,
  ).optional(),
  scopedMaterialFacts: z
    .array(ScopedNewsMaterialFactSchema)
    .max(MAX_PROVIDER_ARRAY_ITEMS)
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
export type DiscoveryFamily = z.infer<typeof DiscoveryFamilySchema>;
export type DiscoveryWindowKind = z.infer<typeof DiscoveryWindowKindSchema>;
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
  discoveryDiagnostics?: readonly DiscoveryLaneDiagnostic[];
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
export type RawPublicationCandidate = z.infer<
  typeof RawPublicationCandidateSchema
>;
export type DiscoveryObservation = z.infer<typeof DiscoveryObservationSchema>;
export type DiscoveryLaneDiagnostic = z.infer<
  typeof DiscoveryLaneDiagnosticSchema
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

export interface DiscoverySourceAdapter extends SourceAdapter {
  readonly laneId: string;
  readonly discoveryFamily: DiscoveryFamily;
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
