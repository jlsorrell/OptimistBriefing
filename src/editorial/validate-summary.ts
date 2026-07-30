import { z } from "zod";

import {
  AccessLevelSchema,
  ItemKindSchema,
  SourceRefSchema,
  StructuredSummarySchema,
  type StructuredSummary,
} from "../contracts/editorial";

const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001f\u007f-\u009f]+$/u;

function safeSingleLine(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => NO_CONTROL_CHARACTERS.test(value), {
      message: "Control characters are not allowed.",
    });
}

const SafeSourceIdSchema = safeSingleLine(200);

const SafeUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    if (!NO_CONTROL_CHARACTERS.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Control characters are not allowed.",
      });
      return;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Source URLs must be credential-free HTTP(S) URLs.",
      });
    }
  });

const SourcePacketExcerptSchema = z
  .object({
    number: z.number().int().positive(),
    text: safeSingleLine(4_000),
  })
  .strict();

const SourcePacketSourceSchema = z
  .object({
    sourceId: SafeSourceIdSchema,
    role: SourceRefSchema.shape.role,
    title: safeSingleLine(500),
    url: SafeUrlSchema,
    retrievedAt: z
      .string()
      .min(1)
      .max(40)
      .datetime()
      .refine((value) => NO_CONTROL_CHARACTERS.test(value), {
        message: "Control characters are not allowed.",
      }),
    accessLevel: AccessLevelSchema,
    excerpts: z
      .array(SourcePacketExcerptSchema)
      .min(1)
      .max(8)
      .superRefine((excerpts, context) => {
        const numbers = new Set<number>();
        excerpts.forEach((excerpt, index) => {
          if (numbers.has(excerpt.number)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Excerpt numbers must be unique.",
              path: [index, "number"],
            });
          }
          numbers.add(excerpt.number);
        });
      }),
  })
  .strict();

export const SourcePacketSchema = z
  .object({
    itemKind: ItemKindSchema,
    sources: z
      .array(SourcePacketSourceSchema)
      .min(1)
      .max(12)
      .superRefine((sources, context) => {
        const sourceIds = new Set<string>();
        sources.forEach((source, index) => {
          if (sourceIds.has(source.sourceId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Source IDs must be unique.",
              path: [index, "sourceId"],
            });
          }
          sourceIds.add(source.sourceId);
        });
      }),
  })
  .strict();

export type SourcePacket = z.infer<typeof SourcePacketSchema>;

export type ValidationResult =
  | { ok: true; errors: readonly [] }
  | { ok: false; errors: readonly string[] };

export function serializeSourcePacket(packet: SourcePacket): string {
  const parsed = SourcePacketSchema.parse(packet);
  return [...parsed.sources]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map((source) =>
      [
        `source_id: ${source.sourceId}`,
        `role: ${source.role}`,
        `title: ${source.title}`,
        `url: ${source.url}`,
        `retrieved_at: ${source.retrievedAt}`,
        `access_level: ${source.accessLevel}`,
        ...[...source.excerpts]
          .sort((left, right) => left.number - right.number)
          .map((excerpt) => `[${excerpt.number}] ${excerpt.text}`),
      ].join("\n"),
    )
    .join("\n\n");
}

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

const StrictSummaryClaimSchema = StructuredSummarySchema.shape.claims.element
  .extend({
    sourceIds: z.array(SafeSourceIdSchema).min(1),
  })
  .strict();

const StrictStructuredSummarySchema = StructuredSummarySchema.extend({
  claims: z.array(StrictSummaryClaimSchema).min(1),
}).strict();

type PacketSource = SourcePacket["sources"][number];

function sourceContains(
  source: PacketSource,
  value: string,
): boolean {
  const normalized = normalizedText(value);
  return [source.title, ...source.excerpts.map((excerpt) => excerpt.text)]
    .map(normalizedText)
    .some((sourceText) => sourceText.includes(normalized));
}

function relevantAccessSources(
  sources: readonly PacketSource[],
): readonly PacketSource[] {
  const primarySources = sources.filter(
    (source) => source.role === "primary",
  );
  return primarySources.length > 0 ? primarySources : sources;
}

function allRelevantSourcesHaveAccess(
  sources: readonly PacketSource[],
  accessLevel: StructuredSummary["accessLevel"],
): boolean {
  if (accessLevel === "metadata") return sources.length > 0;
  const relevant = relevantAccessSources(sources);
  if (relevant.length === 0) return false;
  if (accessLevel === "full_text") {
    return relevant.every(
      (source) => source.accessLevel === "full_text",
    );
  }
  return relevant.every(
    (source) =>
      source.accessLevel === accessLevel ||
      source.accessLevel === "full_text",
  );
}

function permitsAccessLevel(
  summary: StructuredSummary,
  citedSources: readonly PacketSource[],
): boolean {
  return allRelevantSourcesHaveAccess(
    citedSources,
    summary.accessLevel,
  );
}

export function impliesFullTextAccess(value: string): boolean {
  const prose = normalizedText(value);
  const withoutHonestLimitations = prose
    .replace(
      /\b(?:full|complete)[- ](?:paper|text|manuscript)\s+(?:(?:was|is|were|are)\s+)?(?:not (?:available|supplied|accessed|reviewed)|unavailable)\b/g,
      "",
    )
    .replace(
      /\bwithout (?:access to|reading|reviewing) (?:the )?(?:full|complete)[- ](?:paper|text|manuscript)\b/g,
      "",
    )
    .replace(
      /\bno (?:[a-z-]+ (?:or|and) )?(?:full|complete)[- ](?:paper|text|manuscript)\s+(?:was|is|were|are)\s+available\b/g,
      "",
    );
  return (
    /\b(?:full|complete)[- ](?:paper|text|manuscript)\b/.test(
      withoutHonestLimitations,
    ) ||
    /\b(?:complete|full) (?:methods|appendix|supplement)\b/.test(
      withoutHonestLimitations,
    )
  );
}

function proseAccessSources(
  matchingSources: readonly PacketSource[],
  citedSources: readonly PacketSource[],
): readonly PacketSource[] {
  const citedPrimarySources = citedSources.filter(
    (source) => source.role === "primary",
  );
  if (citedPrimarySources.length > 0) return citedPrimarySources;
  return matchingSources.length > 0 ? matchingSources : citedSources;
}

export function validateSummary(
  summary: unknown,
  packet: SourcePacket,
): ValidationResult {
  const parsed = StrictStructuredSummarySchema.safeParse(summary);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        ...new Set(
          parsed.error.issues.map(
            (issue) =>
              `SCHEMA_INVALID:${issue.path.join(".") || "root"}`,
          ),
        ),
      ],
    };
  }

  const errors: string[] = [];
  const sources = new Map(
    packet.sources.map((source) => [source.sourceId, source]),
  );
  const allCitedSources: PacketSource[] = [];

  parsed.data.claims.forEach((claim, claimIndex) => {
    const citedSources = claim.sourceIds.flatMap((sourceId) => {
      const source = sources.get(sourceId);
      if (source === undefined) {
        errors.push(
          `UNKNOWN_SOURCE:${encodeURIComponent(sourceId).slice(0, 600)}`,
        );
        return [];
      }
      allCitedSources.push(source);
      return [source];
    });
    const evidence = normalizedText(claim.evidenceExcerpt);
    if (evidence.length === 0) {
      errors.push(`EMPTY_EVIDENCE:${claimIndex}`);
      return;
    }
    const evidenceSources = citedSources.filter((source) =>
      source.excerpts.some((excerpt) =>
        normalizedText(excerpt.text).includes(evidence),
      ),
    );
    if (evidenceSources.length === 0) {
      errors.push(`EVIDENCE_NOT_FOUND:${claimIndex}`);
    }
    if (
      (impliesFullTextAccess(claim.text) ||
        impliesFullTextAccess(claim.evidenceExcerpt)) &&
      !allRelevantSourcesHaveAccess(citedSources, "full_text")
    ) {
      errors.push("ACCESS_LEVEL_OVERCLAIM");
    }
  });

  if (!permitsAccessLevel(parsed.data, allCitedSources)) {
    errors.push("ACCESS_LEVEL_OVERCLAIM");
  }

  (
    [
      ["title", parsed.data.title],
      ["oneSentence", parsed.data.oneSentence],
      ["whyItMatters", parsed.data.whyItMatters],
    ] as const
  ).forEach(([field, prose]) => {
    const matchingSources = packet.sources.filter((source) =>
      sourceContains(source, prose),
    );
    if (matchingSources.length === 0) {
      errors.push(`UNGROUNDED_PROSE:${field}`);
    }
    if (
      impliesFullTextAccess(prose) &&
      !allRelevantSourcesHaveAccess(
        proseAccessSources(matchingSources, allCitedSources),
        "full_text",
      )
    ) {
      errors.push("ACCESS_LEVEL_OVERCLAIM");
    }
  });

  if (
    impliesFullTextAccess(parsed.data.uncertainty) &&
    !allRelevantSourcesHaveAccess(
      proseAccessSources([], allCitedSources),
      "full_text",
    )
  ) {
    errors.push("ACCESS_LEVEL_OVERCLAIM");
  }

  if (normalizedText(parsed.data.uncertainty).length === 0) {
    errors.push("EMPTY_UNCERTAINTY");
  }

  const forecast =
    packet.itemKind === "forecast" ||
    packet.sources.some((source) => source.role === "forecast");
  if (forecast) {
    const prose = normalizedText(
      [
        parsed.data.title,
        parsed.data.oneSentence,
        parsed.data.whyItMatters,
        parsed.data.uncertainty,
      ].join(" "),
    );
    if (
      !/\bforecast\s*,\s*not (?:a )?fact\b/.test(prose) ||
      /\bnot a forecast\b/.test(prose)
    ) {
      errors.push("FORECAST_LABEL_MISSING");
    }
  }

  const uniqueErrors = [...new Set(errors)];
  return uniqueErrors.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: uniqueErrors };
}
