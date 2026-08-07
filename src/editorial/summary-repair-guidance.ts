import {
  canonicalSummaryRejectionCodes,
  type SummaryRejectionCode,
} from "./summary-rejection-code";

const MAX_GUIDANCE_LINES = 64;
const MAX_GUIDANCE_BYTES = 16_384;
const FALLBACK_GUIDANCE =
  "SCHEMA_INVALID:root — return a complete object matching the schema; use only supplied source IDs and exact source wording.";

const PROMINENT_INSTRUCTION =
  "copy the field exactly from its provenance evidence; that evidence must occur in the title or a numbered excerpt of every cited source";

function instructionFor(code: SummaryRejectionCode): string {
  if (code.startsWith("SCHEMA_INVALID:")) {
    return "return a complete object matching the schema; use only supplied source IDs and exact source wording.";
  }
  if (code.startsWith("EMPTY_EVIDENCE:")) {
    return "provide non-whitespace evidence copied from the cited numbered excerpt.";
  }
  if (code.startsWith("EVIDENCE_NOT_FOUND:")) {
    return "copy claim evidence from a numbered excerpt in every cited source.";
  }
  if (code.startsWith("UNGROUNDED_CLAIM:")) {
    return "copy claim text exactly from evidence found in every cited source.";
  }
  if (code.startsWith("PRIMARY_RESEARCH_SOURCE_REQUIRED:")) {
    return "cite an eligible primary research source for the research claim.";
  }
  if (code.startsWith("UNGROUNDED_PROSE:")) {
    const field = code.slice("UNGROUNDED_PROSE:".length);
    return `${PROMINENT_INSTRUCTION}; field: ${field}.`;
  }

  switch (code) {
    case "UNKNOWN_SOURCE":
      return "use only IDs present in the source packet.";
    case "CLAIM_EVIDENCE_NOT_EXACT":
      return "make claim text an exact extractive match to its evidence.";
    case "ACCESS_LEVEL_OVERCLAIM":
      return "do not imply access beyond supplied access levels.";
    case "EMPTY_UNCERTAINTY":
      return "copy a non-empty uncertainty statement from supplied source wording.";
    case "FORECAST_LABEL_MISSING":
      return "add the literal `Forecast, not fact.` label while keeping remaining prose extractive.";
  }
  return "return a complete schema-valid object.";
}

export function buildSummaryRepairGuidance(
  errors: readonly string[],
): string {
  const codes = canonicalSummaryRejectionCodes(errors);
  const lines = codes.map((code) => `${code} — ${instructionFor(code)}`);
  const guidance = lines.join("\n");
  return lines.length <= MAX_GUIDANCE_LINES &&
    new TextEncoder().encode(guidance).byteLength <= MAX_GUIDANCE_BYTES
      ? guidance
      : FALLBACK_GUIDANCE;
}
