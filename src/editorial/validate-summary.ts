import { z } from "zod";

import {
  AccessLevelSchema,
  ItemKindSchema,
  SourceRefSchema,
  StructuredSummarySchema,
  type StructuredSummary,
} from "../contracts/editorial";

export const SourcePacketSchema = z
  .object({
    itemKind: ItemKindSchema,
    sources: z
      .array(
        z
          .object({
            sourceId: z.string().min(1),
            role: SourceRefSchema.shape.role,
            title: z.string().min(1).max(500),
            url: z.string().url(),
            retrievedAt: z.string().datetime(),
            accessLevel: AccessLevelSchema,
            excerpts: z
              .array(
                z
                  .object({
                    number: z.number().int().positive(),
                    text: z.string().min(1).max(4_000),
                  })
                  .strict(),
              )
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .min(1)
      .max(12),
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

function permitsAccessLevel(
  summary: StructuredSummary,
  packet: SourcePacket,
): boolean {
  if (summary.accessLevel === "metadata") return true;
  if (summary.accessLevel === "full_text") {
    return packet.sources.some(
      (source) => source.accessLevel === "full_text",
    );
  }
  return packet.sources.some(
    (source) =>
      source.accessLevel === summary.accessLevel ||
      source.accessLevel === "full_text",
  );
}

function impliesFullTextAccess(summary: StructuredSummary): boolean {
  const prose = normalizedText(
    [
      summary.title,
      summary.oneSentence,
      summary.whyItMatters,
      summary.uncertainty,
    ].join(" "),
  );
  return (
    /\b(?:in|from|according to) the full[- ](?:paper|text)\b/.test(
      prose,
    ) ||
    /\bthe full[- ](?:paper|text)\s+(?:demonstrates|reports|shows|finds|describes|establishes|proves|details)\b/.test(
      prose,
    )
  );
}

export function validateSummary(
  summary: unknown,
  packet: SourcePacket,
): ValidationResult {
  const parsed = StructuredSummarySchema.safeParse(summary);
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

  parsed.data.claims.forEach((claim, claimIndex) => {
    const citedSources = claim.sourceIds.flatMap((sourceId) => {
      const source = sources.get(sourceId);
      if (source === undefined) {
        errors.push(`UNKNOWN_SOURCE:${sourceId}`);
        return [];
      }
      return [source];
    });
    const evidence = normalizedText(claim.evidenceExcerpt);
    if (evidence.length === 0) {
      errors.push(`EMPTY_EVIDENCE:${claimIndex}`);
      return;
    }
    const evidenceFound = citedSources.some((source) =>
      normalizedText(
        source.excerpts.map((excerpt) => excerpt.text).join(" "),
      ).includes(evidence),
    );
    if (!evidenceFound) {
      errors.push(`EVIDENCE_NOT_FOUND:${claimIndex}`);
    }
  });

  const hasFullText = packet.sources.some(
    (source) => source.accessLevel === "full_text",
  );
  if (
    !permitsAccessLevel(parsed.data, packet) ||
    (!hasFullText && impliesFullTextAccess(parsed.data))
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
      !prose.includes("forecast") ||
      !/\bnot (?:a )?fact\b/.test(prose)
    ) {
      errors.push("FORECAST_LABEL_MISSING");
    }
  }

  const uniqueErrors = [...new Set(errors)];
  return uniqueErrors.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: uniqueErrors };
}
