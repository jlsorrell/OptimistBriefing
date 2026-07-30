import {
  StructuredSummarySchema,
  type StructuredSummary,
} from "../contracts/editorial";
import type { ModelProvider } from "../models/provider";
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
Copy concise supported wording exactly from cited source titles or excerpts for every factual claim and prominent field.
Return only data matching the supplied JSON schema.`;

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
      description:
        "Copy a concise exact substring from a cited source title or excerpt.",
    },
    oneSentence: {
      type: "string",
      minLength: 1,
      description:
        "Copy one concise supported sentence exactly from a cited source excerpt.",
    },
    whyItMatters: {
      type: "string",
      minLength: 1,
      description:
        "Copy concise supported wording exactly from a cited source excerpt.",
    },
    uncertainty: { type: "string", minLength: 1 },
    claims: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceIds", "evidenceExcerpt"],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            description:
              "Copy the factual assertion exactly from its cited evidence excerpt or source.",
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
      required: ["title", "oneSentence", "whyItMatters"],
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
    "VALIDATION ERRORS",
    ...errors.map((error) => `- ${error}`),
    "",
    "ORIGINAL SOURCE PACKET",
    sourcePacket,
  ].join("\n");
}

export async function summarizeItem(
  packet: SourcePacket,
  provider: ModelProvider,
): Promise<StructuredSummary> {
  const parsedPacket = SourcePacketSchema.parse(packet);
  const sourcePacket = serializeSourcePacket(parsedPacket);
  const request = {
    model: "briefing-summary",
    schemaName: "structured_summary",
    jsonSchema: STRUCTURED_SUMMARY_JSON_SCHEMA,
    system: GROUNDING_SYSTEM_PROMPT,
    sourcePacket,
    maxOutputTokens: 1_800,
  };
  const initial = await provider.generateObject(request);
  const initialValidation = validateSummary(initial, parsedPacket);
  if (initialValidation.ok) {
    return StructuredSummarySchema.parse(initial);
  }

  const repaired = await provider.generateObject({
    ...request,
    system: `${GROUNDING_SYSTEM_PROMPT}
Repair every listed validation error. Do not add unsupported claims.`,
    sourcePacket: repairPacket(initialValidation.errors, sourcePacket),
  });
  const repairValidation = validateSummary(repaired, parsedPacket);
  if (repairValidation.ok) {
    return StructuredSummarySchema.parse(repaired);
  }

  throw new SummaryRejectedError([
    ...new Set([
      ...initialValidation.errors,
      ...repairValidation.errors,
    ]),
  ]);
}
