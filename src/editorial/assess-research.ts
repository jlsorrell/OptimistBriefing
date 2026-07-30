import {
  ResearchAssessmentSchema,
  type ResearchAssessment,
} from "../contracts/editorial";
import type { ModelProvider } from "../models/provider";
import type { RawResearchCandidate } from "../sources/types";
import {
  serializeSourcePacket,
  type SourcePacket,
} from "./validate-summary";

const ASSESSMENT_SYSTEM_PROMPT = `Use only the supplied source packet.
Every factual claim must cite one or more supplied source IDs.
State uncertainty and disagreement.
Do not imply full-paper access when access_level is abstract or metadata.
Return only data matching the supplied JSON schema.
Assess technical quality, novelty, strengths, limitations, and rationale from the available evidence.`;

const RESEARCH_ASSESSMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "technicalQuality",
    "novelty",
    "strengths",
    "limitations",
    "rationale",
    "accessLevel",
  ],
  properties: {
    technicalQuality: { type: "number", minimum: 0, maximum: 1 },
    novelty: { type: "number", minimum: 0, maximum: 1 },
    strengths: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    limitations: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    rationale: { type: "string", minLength: 1 },
    accessLevel: {
      type: "string",
      enum: ["metadata", "abstract", "full_text", "secondary"],
    },
  },
};

function assessmentPacket(
  candidate: RawResearchCandidate,
): SourcePacket {
  const sourceText =
    candidate.accessLevel === "full_text"
      ? (candidate.content ?? candidate.abstract ?? candidate.title)
      : (candidate.abstract ?? candidate.title);
  return {
    itemKind: candidate.kind,
    sources: [
      {
        sourceId: candidate.sourceId,
        role: candidate.sourceRole,
        title: candidate.title,
        url: candidate.originalUrl,
        retrievedAt: candidate.retrievedAt,
        accessLevel: candidate.accessLevel,
        excerpts: [
          {
            number: 1,
            text: sourceText.slice(0, 4_000),
          },
        ],
      },
    ],
  };
}

export async function assessResearch(
  candidate: RawResearchCandidate,
  provider: ModelProvider,
): Promise<ResearchAssessment> {
  const output = await provider.generateObject({
    model: "research-assessment",
    schemaName: "research_assessment",
    jsonSchema: RESEARCH_ASSESSMENT_JSON_SCHEMA,
    system: ASSESSMENT_SYSTEM_PROMPT,
    sourcePacket: serializeSourcePacket(assessmentPacket(candidate)),
    maxOutputTokens: 1_200,
  });
  const assessment = ResearchAssessmentSchema.parse(output);
  if (assessment.accessLevel !== candidate.accessLevel) {
    throw new Error("ACCESS_LEVEL_OVERCLAIM");
  }
  return assessment;
}
