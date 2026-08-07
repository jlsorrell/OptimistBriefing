import { z } from "zod";

const MAX_REJECTION_CODES = 64;
const MAX_RAW_CODE_LENGTH = 200;
const FALLBACK_CODE = "SCHEMA_INVALID:root" as const;

export const SummaryRejectionCodeSchema = z.string()
  .min(1)
  .max(MAX_RAW_CODE_LENGTH)
  .regex(/^(?:SCHEMA_INVALID:[A-Za-z0-9_.-]+|UNKNOWN_SOURCE|EMPTY_EVIDENCE:\d+|EVIDENCE_NOT_FOUND:\d+|CLAIM_EVIDENCE_NOT_EXACT|UNGROUNDED_CLAIM:\d+|PRIMARY_RESEARCH_SOURCE_REQUIRED:\d+|ACCESS_LEVEL_OVERCLAIM|UNGROUNDED_PROSE:(?:title|oneSentence|whyItMatters|uncertainty)|EMPTY_UNCERTAINTY|FORECAST_LABEL_MISSING)$/);

export type SummaryRejectionCode = z.infer<
  typeof SummaryRejectionCodeSchema
>;

export function canonicalSummaryRejectionCodes(
  errors: readonly string[],
): SummaryRejectionCode[] {
  if (errors.length === 0) {
    return [FALLBACK_CODE];
  }
  const normalized = errors.map((error): SummaryRejectionCode => {
    const withoutPayload = error.startsWith("UNKNOWN_SOURCE:")
      ? "UNKNOWN_SOURCE"
      : error;
    const parsed = SummaryRejectionCodeSchema.safeParse(withoutPayload);
    return parsed.success ? parsed.data : FALLBACK_CODE;
  });
  const distinct = [...new Set(normalized)].sort();
  return distinct.length <= MAX_REJECTION_CODES
    ? distinct
    : [FALLBACK_CODE];
}
