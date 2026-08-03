import { READER_PROFILE } from "../config/reader-profile";
import { ArxivAdapter } from "./arxiv";
import type { SourceHttpClient } from "./http-client";
import { OpenAlexDiscoveryAdapter } from "./openalex";
import { SemanticScholarDiscoveryAdapter } from "./semantic-scholar";
import type {
  DiscoverySourceAdapter,
  ResearchSourceInput,
} from "./types";

const ARXIV_CATEGORY_QUERY =
  "(cat:cs.AI OR cat:cs.LG OR cat:cs.CL OR cat:cs.CR)";

export const ARXIV_TOPIC_QUERIES = [
  {
    laneId: "arxiv:alignment-interpretability",
    query: `${ARXIV_CATEGORY_QUERY} AND ("AI safety" OR "alignment" OR "interpretability" OR "internal representations" OR "emergent learning" OR "scaling" OR "capability elicitation" OR "AI safety via debate" OR "multi-agent behavior")`,
  },
  {
    laneId: "arxiv:oversight-governance",
    query: `${ARXIV_CATEGORY_QUERY} AND ("cryptographic verification" OR "proof of learning" OR "training verification" OR "inference verification" OR "data provenance" OR "provenance" OR "secure evaluation")`,
  },
  {
    laneId: "arxiv:secure-ml",
    query: `${ARXIV_CATEGORY_QUERY} AND ("homomorphic encryption" OR "multiparty computation" OR "zero-knowledge proofs" OR "functional encryption") AND ("machine learning" OR "neural network")`,
  },
] as const;

export const SEMANTIC_SCHOLAR_SEED_SET_V1 = [
  {
    family: "alignment",
    paperId: "ARXIV:2209.10652",
    title: "Toy Models of Superposition",
  },
  {
    family: "oversight-governance",
    paperId: "ARXIV:2103.05633",
    title: "Proof-of-Learning: Definitions and Practice",
  },
  {
    family: "secure-ml",
    paperId: "ARXIV:1801.05507",
    title:
      "Gazelle: A Low Latency Framework for Secure Neural Network Inference",
  },
] as const;

function semanticScholarQuery(
  topic: (typeof READER_PROFILE.researchTopics)[number],
): string {
  return [topic.description, ...topic.positiveExamples]
    .map((term) => `"${term}"`)
    .join(" OR ");
}

function openAlexQuery(
  topic: (typeof READER_PROFILE.researchTopics)[number],
): string {
  return [topic.description, ...topic.positiveExamples].join(" ");
}

export function createPaperDiscoveryAdapters(
  http: SourceHttpClient,
  sources: readonly ResearchSourceInput[],
): readonly DiscoverySourceAdapter[] {
  const arxiv = sources.find((source) => source.id === "arxiv");
  const semanticScholar = sources.find(
    (source) => source.id === "semantic-scholar",
  );
  const openAlex = sources.find((source) => source.id === "openalex");
  return [
    ...(arxiv?.enabled === true
      ? ARXIV_TOPIC_QUERIES.map(
          ({ laneId, query }) =>
            new ArxivAdapter(http, arxiv, {
              laneId,
              query,
              maxResults: 100,
            }),
        )
      : []),
    ...(semanticScholar?.enabled === true
      ? [
          ...READER_PROFILE.researchTopics.map(
            (topic) =>
              new SemanticScholarDiscoveryAdapter(http, semanticScholar, {
                laneId: `semantic-scholar:search:${topic.id}`,
                mode: "search",
                query: semanticScholarQuery(topic),
              }),
          ),
          ...SEMANTIC_SCHOLAR_SEED_SET_V1.map(
            (seed) =>
              new SemanticScholarDiscoveryAdapter(http, semanticScholar, {
                laneId: `semantic-scholar:recommendations:${seed.family}`,
                mode: "recommendations",
                positivePaperIds: [seed.paperId],
              }),
          ),
        ]
      : []),
    ...(openAlex?.enabled === true
      ? [
          ...READER_PROFILE.researchTopics.map(
            (topic) =>
              new OpenAlexDiscoveryAdapter(http, openAlex, {
                laneId: `openalex:text:${topic.id}`,
                mode: "text",
                query: openAlexQuery(topic),
              }),
          ),
          ...READER_PROFILE.researchTopics.map(
            (topic) =>
              new OpenAlexDiscoveryAdapter(http, openAlex, {
                laneId: `openalex:updated:${topic.id}`,
                mode: "updated",
                query: openAlexQuery(topic),
              }),
          ),
          new OpenAlexDiscoveryAdapter(http, openAlex, {
            laneId: "openalex:preferred-institutions",
            mode: "institutions",
            institutionNames: [
              ...READER_PROFILE.preferredInstitutions,
              ...READER_PROFILE.preferredLabs,
            ],
          }),
        ]
      : []),
  ];
}
