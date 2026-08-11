import {
  InvalidRequiredProviderDisplayTextError,
} from "../editorial/normalize";
import {
  normalizeLegacyStructuredSummaryProviderText,
  prepareCurrentStructuredSummaryProviderText,
} from "../editorial/summary-provider-text";
import {
  boundProviderSourceName,
  boundProviderText,
  normalizeProviderSourceName,
  normalizeProviderText,
  type ProviderTextOptions,
} from "../sources/provider-text";
import {
  MAX_PROVIDER_EVIDENCE_CHARACTERS,
} from "../sources/types";
import type { StructuredSummary } from "../contracts/editorial";
import type { CompositionResult } from "./types";

type ProviderDisplayNormalizer = (
  value: string,
  options: ProviderTextOptions,
) => string | null;

function requiredCompositionDisplay(
  normalize: ProviderDisplayNormalizer,
  value: string,
  maximum: number,
): string {
  const prepared = normalize(value, {
    stripHtml: true,
    maxCharacters: maximum,
  });
  if (prepared !== null) return prepared;
  throw new TypeError("INVALID_REQUIRED_COMPOSITION_PROVIDER_TEXT");
}

function preparedComposition(
  composition: CompositionResult,
  normalize: ProviderDisplayNormalizer,
  prepareSummary: (summary: StructuredSummary) => StructuredSummary,
  prepareSourceName: (value: string) => string | null,
): CompositionResult {
  return {
    ...composition,
    entries: composition.entries.map((entry) => ({
      ...entry,
      summary: prepareSummary(entry.summary),
      selectionReasons: entry.selectionReasons.map((reason) =>
        requiredCompositionDisplay(
          normalize,
          reason,
          MAX_PROVIDER_EVIDENCE_CHARACTERS,
        )
      ),
      sourceRefs: entry.sourceRefs.map((sourceRef) => ({
        ...sourceRef,
        name: (() => {
          const name = prepareSourceName(sourceRef.name);
          if (name === null) {
            throw new InvalidRequiredProviderDisplayTextError("sourceName");
          }
          return name;
        })(),
      })),
    })),
  };
}

export function prepareCurrentCompositionProviderText(
  composition: CompositionResult,
): CompositionResult {
  return preparedComposition(
    composition,
    boundProviderText,
    prepareCurrentStructuredSummaryProviderText,
    boundProviderSourceName,
  );
}

export function normalizeLegacyCompositionProviderText(
  composition: CompositionResult,
): CompositionResult {
  return preparedComposition(
    composition,
    normalizeProviderText,
    normalizeLegacyStructuredSummaryProviderText,
    normalizeProviderSourceName,
  );
}
