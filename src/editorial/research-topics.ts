export const CONFIGURED_RESEARCH_TOPIC_IDS = [
  "alignment-interpretability",
  "oversight-governance",
  "secure-computation-ml",
] as const;

export type ConfiguredResearchTopicId =
  (typeof CONFIGURED_RESEARCH_TOPIC_IDS)[number];

const TOPIC_PATTERNS: Readonly<
  Record<ConfiguredResearchTopicId, readonly RegExp[]>
> = {
  "alignment-interpretability": [
    /\b(?:AI safety|alignment|interpretability|mechanistic|representation learning|internal representation|parametric factuality|knowledge profiling|concept evolution|emergen(?:ce|t)|scaling law|capabilit(?:y|ies) elicitation|debate|multi-agent|game[- ]theoretic)\b/i,
  ],
  "oversight-governance": [
    /\b(?:oversight|governance|data provenance|training verification|inference verification|secure evaluation|model evaluation|audit(?:ing)?|accountability)\b/i,
  ],
  "secure-computation-ml": [
    /\b(?:secure computation|homomorphic encryption|fully homomorphic|\bFHE\b|multi[- ]?party computation|\bMPC\b|zero[- ]knowledge|\bZKP\b|functional encryption|private (?:machine learning|neural network|inference))\b/i,
  ],
};

export function mapResearchTopicIds(
  values: readonly string[],
): ConfiguredResearchTopicId[] {
  const searchable = values.join("\n");
  return CONFIGURED_RESEARCH_TOPIC_IDS.filter((topicId) =>
    TOPIC_PATTERNS[topicId].some((pattern) => pattern.test(searchable)),
  );
}
