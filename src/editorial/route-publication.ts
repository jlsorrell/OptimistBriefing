import {
  deriveNewsSignals,
  hasExplicitAiPolicyEvidence,
} from "../sources/news-signals";
import { normalizeArxivIdentifier, normalizeDoi } from "../sources/identifiers";
import {
  RawNewsCandidateSchema,
  RawPublicationCandidateSchema,
  RawResearchCandidateSchema,
  type RawNewsCandidate,
  type RawPublicationCandidate,
  type RawResearchCandidate,
} from "../sources/types";
import { preparedProviderSignalText } from "../sources/provider-text";
import { mapResearchTopicIds } from "./research-topics";

const SUBSTANTIVE_RESEARCH = /\b(?:study|studies|method|methodology|experiment|analysis|result|results|finding|findings|proof|theorem)\b/i;
const TECHNOLOGY = /\b(?:product|model|capability|deployment|deploy|launch|release|released|code release|open[- ]source|software|assistant|api|benchmark release)\b/i;
const EXPLICIT_PAPER_LINK = /(?:arxiv\.org\/(?:abs|html|pdf)\/|doi\.org\/|\/papers?\/|\bdoi:\s*|\barxiv:\s*)/i;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

type PublicationSignalText = {
  title: string | null;
  abstract: string | null;
  content: string | null;
};

function material(
  candidate: RawPublicationCandidate,
  signals: PublicationSignalText,
): string {
  return [signals.title, signals.abstract, signals.content, candidate.originalUrl, ...candidate.relatedPaperIds]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function explicitIdentifiers(candidate: RawPublicationCandidate, searchable: string): string[] {
  const identifiers = candidate.relatedPaperIds.flatMap((value) => {
    const arxiv = normalizeArxivIdentifier(value);
    if (arxiv !== null) return [arxiv];
    const doi = normalizeDoi(value);
    return doi === null ? [] : [`doi:${doi}`];
  });
  for (const match of searchable.matchAll(/(?:arxiv:\s*|arxiv\.org\/(?:abs|html|pdf)\/)([a-z.-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/gi)) {
    const identifier = normalizeArxivIdentifier(match[1] ?? "");
    if (identifier !== null) identifiers.push(identifier);
  }
  for (const match of searchable.matchAll(/(?:doi:\s*|doi\.org\/)(10\.\d{4,9}\/[^\s<>"']+)/gi)) {
    const identifier = normalizeDoi(match[1] ?? "");
    if (identifier !== null) identifiers.push(`doi:${identifier}`);
  }
  return unique(identifiers);
}

function routeResearch(
  candidate: RawPublicationCandidate,
  topics: string[],
  identifiers: string[],
  explicitPaperEvidence: boolean,
): RawResearchCandidate {
  const externalIds = unique([...identifiers, candidate.externalId, ...candidate.externalIds]);
  const primarySection = candidate.sectionEligibility.includes("research") ? "research" : "research_radar";
  return RawResearchCandidateSchema.parse({
    ...candidate,
    kind: explicitPaperEvidence ? "paper" : "blog",
    externalId: identifiers[0] ?? candidate.externalId,
    externalIds,
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics,
    metadata: {
      ...candidate.metadata,
      discoveryFamily: candidate.discoveryFamily,
      relatedPaperIds: candidate.relatedPaperIds,
      primarySection,
      canCorroborateFacts: false,
    },
  });
}

function routeNews(
  candidate: RawPublicationCandidate,
  signals: PublicationSignalText,
): RawNewsCandidate {
  const metadata = {
    ...candidate.metadata,
    discoveryFamily: candidate.discoveryFamily,
    relatedPaperIds: candidate.relatedPaperIds,
    canCorroborateFacts: false,
  };
  return RawNewsCandidateSchema.parse({
    ...candidate,
    kind: "article",
    canCorroborateFacts: false,
    ...deriveNewsSignals({
      kind: "article",
      title: signals.title ?? "",
      abstract: signals.abstract,
      content: signals.content,
      originalUrl: candidate.originalUrl,
      sectionEligibility: candidate.sectionEligibility,
      metadata,
      preferredSection: undefined,
    }),
  });
}

export function routePublication(
  input: RawPublicationCandidate,
): RawResearchCandidate | RawNewsCandidate | null {
  const candidate = RawPublicationCandidateSchema.parse(input);
  const signals = {
    title: preparedProviderSignalText(candidate.title),
    abstract: preparedProviderSignalText(candidate.abstract),
    content: preparedProviderSignalText(candidate.content),
  };
  if (signals.title === null && signals.abstract === null && signals.content === null) {
    return null;
  }
  const searchable = material(candidate, signals);
  const topics = mapResearchTopicIds([
    signals.title ?? "",
    signals.abstract ?? "",
    signals.content ?? "",
  ]);
  const identifiers = explicitIdentifiers(candidate, searchable);
  const explicitPaperEvidence = identifiers.length > 0 || EXPLICIT_PAPER_LINK.test(searchable);
  const aiPolicyEvidence = hasExplicitAiPolicyEvidence([
    signals.title,
    signals.abstract,
    signals.content,
  ]);
  const researchEligible = candidate.sectionEligibility.includes("research") || candidate.sectionEligibility.includes("research_radar");
  if (researchEligible && topics.length > 0 && (explicitPaperEvidence || SUBSTANTIVE_RESEARCH.test(searchable))) {
    return routeResearch(candidate, topics, identifiers, explicitPaperEvidence);
  }
  if (candidate.sectionEligibility.includes("ai_policy") && aiPolicyEvidence) {
    const routed = routeNews(candidate, signals);
    return routed.metadata.primarySection === "ai_policy" ? routed : null;
  }
  if (candidate.sectionEligibility.includes("technology") && TECHNOLOGY.test(searchable)) {
    return routeNews(candidate, signals);
  }
  if (candidate.discoveryFamily === "official-publication" && candidate.sectionEligibility.includes("technology")) {
    return routeNews(candidate, signals);
  }
  return null;
}
