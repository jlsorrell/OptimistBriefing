import {
  InvalidRequiredProviderDisplayTextError,
} from "../editorial/normalize";
import {
  boundProviderText,
  normalizeProviderText,
  type ProviderTextOptions,
} from "../sources/provider-text";
import {
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
  MAX_PROVIDER_TITLE_CHARACTERS,
} from "../sources/types";
import type { CompositionResult } from "./types";

const MAX_CLAIM_EVIDENCE_CHARACTERS = 800;

type ProviderDisplayNormalizer = (
  value: string,
  options: ProviderTextOptions,
) => string | null;

function requiredDisplay(
  normalize: ProviderDisplayNormalizer,
  value: string,
  maximum: number,
  field: "title" | "sourceName" | "composition",
): string {
  const prepared = normalize(value, {
    stripHtml: true,
    maxCharacters: maximum,
  });
  if (prepared !== null) return prepared;
  if (field === "title" || field === "sourceName") {
    throw new InvalidRequiredProviderDisplayTextError(field);
  }
  throw new TypeError("INVALID_REQUIRED_COMPOSITION_PROVIDER_TEXT");
}

function preparedComposition(
  composition: CompositionResult,
  normalize: ProviderDisplayNormalizer,
): CompositionResult {
  return {
    ...composition,
    entries: composition.entries.map((entry) => ({
      ...entry,
      summary: {
        ...entry.summary,
        title: requiredDisplay(
          normalize,
          entry.summary.title,
          MAX_PROVIDER_TITLE_CHARACTERS,
          "title",
        ),
        oneSentence: requiredDisplay(
          normalize,
          entry.summary.oneSentence,
          MAX_PROVIDER_EVIDENCE_CHARACTERS,
          "composition",
        ),
        whyItMatters: requiredDisplay(
          normalize,
          entry.summary.whyItMatters,
          MAX_PROVIDER_EVIDENCE_CHARACTERS,
          "composition",
        ),
        uncertainty: requiredDisplay(
          normalize,
          entry.summary.uncertainty,
          MAX_PROVIDER_EVIDENCE_CHARACTERS,
          "composition",
        ),
        claims: entry.summary.claims.map((claim) => ({
          ...claim,
          text: requiredDisplay(
            normalize,
            claim.text,
            MAX_PROVIDER_EVIDENCE_CHARACTERS,
            "composition",
          ),
          evidenceExcerpt: requiredDisplay(
            normalize,
            claim.evidenceExcerpt,
            MAX_CLAIM_EVIDENCE_CHARACTERS,
            "composition",
          ),
        })),
      },
      selectionReasons: entry.selectionReasons.map((reason) =>
        requiredDisplay(
          normalize,
          reason,
          MAX_PROVIDER_EVIDENCE_CHARACTERS,
          "composition",
        )
      ),
      sourceRefs: entry.sourceRefs.map((sourceRef) => ({
        ...sourceRef,
        name: requiredDisplay(
          normalize,
          sourceRef.name,
          MAX_PROVIDER_TITLE_CHARACTERS,
          "sourceName",
        ),
      })),
    })),
  };
}

export function prepareCurrentCompositionProviderText(
  composition: CompositionResult,
): CompositionResult {
  return preparedComposition(composition, boundProviderText);
}

export function normalizeLegacyCompositionProviderText(
  composition: CompositionResult,
): CompositionResult {
  return preparedComposition(composition, normalizeProviderText);
}
