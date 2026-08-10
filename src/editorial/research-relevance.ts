import { z } from "zod";

import { ItemSchema, type Item } from "../contracts/editorial";

export const ResearchRelevanceTierSchema = z.enum(["core", "adjacent"]);
export type ResearchRelevanceTier = z.infer<
  typeof ResearchRelevanceTierSchema
>;

const CORE_EVIDENCE_LIMIT = 20_000;

function searchable(item: Item): string {
  return [item.title, item.primaryTopic, item.normalizedText]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .slice(0, CORE_EVIDENCE_LIMIT);
}

const directPredicates: readonly ((text: string) => boolean)[] = [
  (text) =>
    /\b(?:internal|latent|distributed|concept) representations?\b/.test(text) &&
    /\b(?:training|learning|model|network|transformer)\b/.test(text),
  (text) =>
    /\b(?:mechanistic interpretability|representation-level interpretability)\b/.test(
      text,
    ),
  (text) =>
    /\b(?:theor(?:y|etical)|mathematical model|phase transition)\b/.test(text) &&
    /\b(?:emergen(?:ce|t)|learning dynamics|scaling law|neural scaling)\b/.test(
      text,
    ),
  (text) =>
    /\b(?:capabilit(?:y|ies) elicitation|hidden capabilities|latent capabilities|sandbagging)\b/.test(
      text,
    ),
  (text) =>
    /\b(?:ai safety via debate|debate protocol|debate-based oversight)\b/.test(
      text,
    ),
  (text) =>
    /\bgame[- ]theoretic\b/.test(text) && /\bmulti[- ]agent\b/.test(text),
  (text) =>
    /\b(?:cryptographic verification|proof[- ]of[- ]learning|verifiable training|verifiable inference)\b/.test(
      text,
    ) &&
    /\b(?:training|inference|provenance|evaluation|model|learning)\b/.test(
      text,
    ),
  (text) =>
    /\b(?:secure|verifiable) evaluation frameworks?\b/.test(text) &&
    /\b(?:ai|model|machine learning|neural network|frontier)\b/.test(text),
  (text) =>
    /\b(?:fully homomorphic encryption|homomorphic encryption|multi[- ]?party computation|zero[- ]knowledge proofs?|functional encryption|\bfhe\b|\bmpc\b|\bzkp\b)\b/.test(
      text,
    ) &&
    /\b(?:machine[- ]learning|neural network|model training|model inference|secure inference)\b/.test(
      text,
    ),
];

export function classifyResearchRelevance(
  input: Item,
): ResearchRelevanceTier {
  const item = ItemSchema.parse(input);
  if (item.kind !== "paper" && item.kind !== "blog") {
    throw new TypeError("Research relevance requires a paper or blog item.");
  }

  const text = searchable(item);
  return directPredicates.some((predicate) => predicate(text))
    ? "core"
    : "adjacent";
}

export function researchRelevanceReason(
  tier: ResearchRelevanceTier,
): string {
  return ResearchRelevanceTierSchema.parse(tier) === "core"
    ? "Direct technical-interest match."
    : "Broader research match used as fallback.";
}
