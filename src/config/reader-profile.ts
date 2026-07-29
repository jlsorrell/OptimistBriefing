type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const child = (value as Record<PropertyKey, unknown>)[key];
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const READER_PROFILE = deepFreeze({
  researchTopics: [
    {
      id: "alignment-interpretability",
      description: "AI safety, alignment, and interpretability",
      positiveExamples: [
        "internal representations of concepts",
        "concept evolution during training",
        "theoretical models of emergent learning phenomena",
        "theoretical models of scaling",
        "capability elicitation",
        "AI safety via debate",
        "game-theoretic multi-agent behavior",
      ],
    },
    {
      id: "oversight-governance",
      description: "Oversight and governance",
      positiveExamples: [
        "cryptographic verification of model training",
        "cryptographic verification of inference",
        "data provenance",
        "secure evaluation frameworks",
      ],
    },
    {
      id: "secure-computation-ml",
      description: "Secure computation and machine learning",
      positiveExamples: [
        "fully homomorphic encryption for machine learning",
        "multiparty computation for machine learning",
        "zero-knowledge proofs for machine learning",
        "functional encryption for machine learning",
      ],
    },
  ],
  preferredInstitutions: [
    "Stanford",
    "UC Berkeley",
    "Harvard",
    "MIT",
    "Carnegie Mellon",
    "University of Pennsylvania",
    "Johns Hopkins",
    "UT Austin",
    "Georgia Tech",
  ],
  preferredLabs: [
    "Google",
    "Google DeepMind",
    "Anthropic",
    "OpenAI",
  ],
  geographicInterests: [
    "District of Columbia",
    "Maryland",
    "Virginia",
    "Baltimore",
  ],
  sectionBudgets: {
    morningBrief: 8,
    featuredResearch: 3,
    researchRadar: 6,
    world: 4,
    technology: 4,
    aiPolicy: 4,
    dmvAndBaltimore: 5,
    forecastSignals: 3,
  },
});

export type ReaderProfile = typeof READER_PROFILE;
