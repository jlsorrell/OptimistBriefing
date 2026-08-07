import {
  ResearchAssessmentSchema,
  type AccessLevel,
  type ResearchAssessment,
} from "../contracts/editorial";
import type { ModelProvider } from "../models/provider";
import { truncateProviderTextAtCodePointBoundary } from "../sources/provider-text";
import type { RawResearchCandidate } from "../sources/types";
import {
  impliesFullTextAccess,
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
  const accessLevel = suppliedAccessLevel(candidate);
  const sourceText =
    accessLevel === "full_text" || accessLevel === "secondary"
      ? (candidate.content ?? candidate.abstract ?? candidate.title)
      : accessLevel === "abstract"
        ? (candidate.abstract ?? candidate.title)
        : candidate.title;
  return {
    itemKind: candidate.kind,
    sources: [
      {
        sourceId: candidate.sourceId,
        sourceName: candidate.sourceName,
        evidenceKind:
          candidate.kind === "blog" || candidate.sourceRole === "blog"
            ? "commentary"
            : "primary-research",
        role: candidate.sourceRole,
        title: candidate.title,
        url: candidate.originalUrl,
        retrievedAt: candidate.retrievedAt,
        accessLevel,
        excerpts: [
          {
            number: 1,
            text: truncateProviderTextAtCodePointBoundary(sourceText
              .normalize("NFKC")
              .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
              .replace(/\s+/g, " ")
              .trim(), 4_000),
          },
        ],
      },
    ],
  };
}

function suppliedAccessLevel(
  candidate: RawResearchCandidate,
): AccessLevel {
  const hasContent =
    candidate.content !== null && candidate.content.trim().length > 0;
  const hasAbstract =
    candidate.abstract !== null && candidate.abstract.trim().length > 0;
  switch (candidate.accessLevel) {
    case "full_text":
      if (hasContent) return "full_text";
      return hasAbstract ? "abstract" : "metadata";
    case "abstract":
      return hasAbstract ? "abstract" : "metadata";
    case "secondary":
      return hasContent || hasAbstract ? "secondary" : "metadata";
    case "metadata":
      return "metadata";
  }
}

const StrictResearchAssessmentSchema =
  ResearchAssessmentSchema.strict();

export async function assessResearch(
  candidate: RawResearchCandidate,
  provider: ModelProvider,
): Promise<ResearchAssessment> {
  const accessLevel = suppliedAccessLevel(candidate);
  const output = await provider.generateObject({
    model: "research-assessment",
    schemaName: "research_assessment",
    jsonSchema: RESEARCH_ASSESSMENT_JSON_SCHEMA,
    system: ASSESSMENT_SYSTEM_PROMPT,
    sourcePacket: serializeSourcePacket(assessmentPacket(candidate)),
    maxOutputTokens: 1_200,
  });
  const assessment = StrictResearchAssessmentSchema.parse(output);
  const assessmentProse = [
    ...assessment.strengths,
    ...assessment.limitations,
    assessment.rationale,
  ];
  if (
    assessment.accessLevel !== accessLevel ||
    (accessLevel !== "full_text" &&
      assessmentProse.some(impliesFullTextAccess))
  ) {
    throw new Error("ACCESS_LEVEL_OVERCLAIM");
  }
  return assessment;
}
