import type { StructuredSummary } from "../contracts/editorial";
import {
  boundProviderText,
  normalizeProviderText,
  type ProviderTextOptions,
} from "../sources/provider-text";
import {
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  MAX_PROVIDER_TITLE_CHARACTERS,
} from "../sources/types";

const MAX_CLAIM_EVIDENCE_CHARACTERS = 800;
const PROMINENT_FIELDS = [
  "title",
  "oneSentence",
  "whyItMatters",
  "uncertainty",
] as const;

type ProviderDisplayNormalizer = (
  value: string,
  options: ProviderTextOptions,
) => string | null;

function normalizedField(
  normalize: ProviderDisplayNormalizer,
  value: unknown,
  maximum: number,
): unknown {
  if (typeof value !== "string") return value;
  return normalize(value, {
    stripHtml: true,
    maxCharacters: maximum,
  }) ?? "";
}

function mappedGeneratedSummary(
  value: unknown,
  normalize: ProviderDisplayNormalizer,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const summary = { ...(value as Record<string, unknown>) };
  for (const field of PROMINENT_FIELDS) {
    summary[field] = normalizedField(
      normalize,
      summary[field],
      field === "title"
        ? MAX_PROVIDER_TITLE_CHARACTERS
        : MAX_PROVIDER_EVIDENCE_CHARACTERS,
    );
  }
  if (Array.isArray(summary.claims)) {
    summary.claims = summary.claims.map((claim) => {
      if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
        return claim;
      }
      const record = { ...(claim as Record<string, unknown>) };
      record.text = normalizedField(
        normalize,
        record.text,
        MAX_PROVIDER_EVIDENCE_CHARACTERS,
      );
      record.evidenceExcerpt = normalizedField(
        normalize,
        record.evidenceExcerpt,
        MAX_CLAIM_EVIDENCE_CHARACTERS,
      );
      return record;
    });
  }
  if (
    summary.provenance !== null &&
    typeof summary.provenance === "object" &&
    !Array.isArray(summary.provenance)
  ) {
    const provenance = {
      ...(summary.provenance as Record<string, unknown>),
    };
    for (const field of PROMINENT_FIELDS) {
      const entry = provenance[field];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = { ...(entry as Record<string, unknown>) };
      record.evidenceExcerpt = normalizedField(
        normalize,
        record.evidenceExcerpt,
        MAX_CLAIM_EVIDENCE_CHARACTERS,
      );
      provenance[field] = record;
    }
    summary.provenance = provenance;
  }
  return summary;
}

export function normalizeGeneratedSummaryProviderText(value: unknown): unknown {
  return mappedGeneratedSummary(value, normalizeProviderText);
}

export function normalizeLegacyStructuredSummaryProviderText(
  summary: StructuredSummary,
): StructuredSummary {
  return mappedGeneratedSummary(
    summary,
    normalizeProviderText,
  ) as StructuredSummary;
}

export function prepareCurrentStructuredSummaryProviderText(
  summary: StructuredSummary,
): StructuredSummary {
  return mappedGeneratedSummary(summary, boundProviderText) as StructuredSummary;
}
