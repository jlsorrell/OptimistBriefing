import {
  StructuredSummarySchema,
  type StructuredSummary,
} from "../contracts/editorial";
import type { ModelProvider } from "../models/provider";
import { canonicalSummaryRejectionCodes } from "./summary-rejection-code";
import { normalizeGeneratedSummaryProviderText } from
  "./summary-provider-text";
import { buildSummaryRepairGuidance } from "./summary-repair-guidance";
import {
  serializeSourcePacket,
  SourcePacketSchema,
  validateSummary,
  type SourcePacket,
} from "./validate-summary";

const GROUNDING_SYSTEM_PROMPT = `Use only the supplied source packet.
Every factual claim must cite one or more supplied source IDs.
State uncertainty and disagreement.
Do not imply full-paper access when access_level is abstract or metadata.
For each prominent field, provenance evidence must appear in the title or a numbered excerpt of every cited source.
For each factual claim, evidence must appear in a numbered excerpt of every cited source; source titles alone do not ground claims.
For forecast items, prefix one prose field with "Forecast, not fact."; this fixed editorial label does not require source support, but all remaining prose does.
Return only data matching the supplied JSON schema.`;

const PROMINENT_FIELD_DESCRIPTION =
  "Copy wording exactly from a cited source title or numbered excerpt in every cited source.";
const PROMINENT_EVIDENCE_DESCRIPTION =
  "Provide exact evidence from the title or a numbered excerpt of every cited source.";
const CLAIM_EVIDENCE_DESCRIPTION =
  "Copy exact evidence from a numbered excerpt of every cited source; source titles alone do not ground claims.";

const STRUCTURED_SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "oneSentence",
    "whyItMatters",
    "uncertainty",
    "claims",
    "accessLevel",
    "provenance",
  ],
  properties: {
    title: {
      type: "string",
      minLength: 1,
      description: PROMINENT_FIELD_DESCRIPTION,
    },
    oneSentence: {
      type: "string",
      minLength: 1,
      description: PROMINENT_FIELD_DESCRIPTION,
    },
    whyItMatters: {
      type: "string",
      minLength: 1,
      description: PROMINENT_FIELD_DESCRIPTION,
    },
    uncertainty: {
      type: "string",
      minLength: 1,
      description: PROMINENT_FIELD_DESCRIPTION,
    },
    claims: {
      type: "array",
      minItems: 1,
      description:
        "For each factual claim, evidence must appear in a numbered excerpt of every cited source; source titles alone do not ground claims.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceIds", "evidenceExcerpt"],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            description:
              "Copy the factual assertion exactly from its evidence or cited source text; evidence must come from a numbered excerpt of every cited source.",
          },
          sourceIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          evidenceExcerpt: {
            type: "string",
            minLength: 1,
            maxLength: 800,
            description: CLAIM_EVIDENCE_DESCRIPTION,
          },
        },
      },
    },
    accessLevel: {
      type: "string",
      enum: ["metadata", "abstract", "full_text", "secondary"],
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      description:
        "For each prominent field, evidence must be exact wording from the title or a numbered excerpt of every cited source.",
      required: [
        "title",
        "oneSentence",
        "whyItMatters",
        "uncertainty",
      ],
      properties: {
        title: {
          type: "object",
          additionalProperties: false,
          required: ["sourceIds", "evidenceExcerpt"],
          properties: {
            sourceIds: {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
            },
            evidenceExcerpt: {
              type: "string",
              minLength: 1,
              maxLength: 800,
              description: PROMINENT_EVIDENCE_DESCRIPTION,
            },
          },
        },
        oneSentence: {
          type: "object",
          additionalProperties: false,
          required: ["sourceIds", "evidenceExcerpt"],
          properties: {
            sourceIds: {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
            },
            evidenceExcerpt: {
              type: "string",
              minLength: 1,
              maxLength: 800,
              description: PROMINENT_EVIDENCE_DESCRIPTION,
            },
          },
        },
        whyItMatters: {
          type: "object",
          additionalProperties: false,
          required: ["sourceIds", "evidenceExcerpt"],
          properties: {
            sourceIds: {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
            },
            evidenceExcerpt: {
              type: "string",
              minLength: 1,
              maxLength: 800,
              description: PROMINENT_EVIDENCE_DESCRIPTION,
            },
          },
        },
        uncertainty: {
          type: "object",
          additionalProperties: false,
          required: ["sourceIds", "evidenceExcerpt"],
          properties: {
            sourceIds: {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
            },
            evidenceExcerpt: {
              type: "string",
              minLength: 1,
              maxLength: 800,
              description: PROMINENT_EVIDENCE_DESCRIPTION,
            },
          },
        },
      },
    },
  },
};

export class SummaryRejectedError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Summary rejected: ${errors.join(", ")}`);
    this.name = "SummaryRejectedError";
    this.errors = Object.freeze([...errors]);
  }
}

function repairPacket(
  errors: readonly string[],
  sourcePacket: string,
): string {
  return [
    "VALIDATION ERRORS AND REQUIRED REPAIRS",
    buildSummaryRepairGuidance(errors),
    "",
    "ORIGINAL SOURCE PACKET",
    sourcePacket,
  ].join("\n");
}

export async function summarizeItem(
  packet: SourcePacket,
  provider: ModelProvider,
  options: { maxOutputTokens?: number } = {},
): Promise<StructuredSummary> {
  const parsedPacket = SourcePacketSchema.parse(packet);
  const sourcePacket = serializeSourcePacket(parsedPacket);
  const request = {
    model: "briefing-summary",
    schemaName: "structured_summary",
    jsonSchema: STRUCTURED_SUMMARY_JSON_SCHEMA,
    system: GROUNDING_SYSTEM_PROMPT,
    sourcePacket,
    maxOutputTokens: options.maxOutputTokens ?? 1_800,
  };
  const initial = normalizeGeneratedSummaryProviderText(
    await provider.generateObject(request),
  );
  const initialValidation = validateSummary(initial, parsedPacket);
  if (initialValidation.ok) {
    return StructuredSummarySchema.parse(initial);
  }

  const repaired = normalizeGeneratedSummaryProviderText(
    await provider.generateObject({
      ...request,
      system: `${GROUNDING_SYSTEM_PROMPT}
Repair every listed validation error. Do not add unsupported claims.`,
      sourcePacket: repairPacket(initialValidation.errors, sourcePacket),
    }),
  );
  const repairValidation = validateSummary(repaired, parsedPacket);
  if (repairValidation.ok) {
    return StructuredSummarySchema.parse(repaired);
  }

  throw new SummaryRejectedError(
    canonicalSummaryRejectionCodes([
      ...initialValidation.errors,
      ...repairValidation.errors,
    ]),
  );
}
