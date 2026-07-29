import type {
  EditionSection,
  ItemKind,
} from "../contracts/editorial";

const ENTITY_PATTERNS: readonly [string, RegExp][] = [
  ["Baltimore", /\bBaltimore\b/i],
  ["Maryland", /\bMaryland\b/i],
  ["Virginia", /\bVirginia\b/i],
  [
    "Washington, D.C.",
    /\b(?:Washington,\s*D\.?C\.?|District of Columbia|DC)\b/i,
  ],
  ["United States", /\b(?:United States|U\.S\.)\b/i],
  ["Congress", /\bCongress\b/i],
  ["Federal Register", /\bFederal Register\b/i],
  ["NIST", /\bNIST\b/i],
  ["OpenAI", /\bOpenAI\b/i],
  ["Anthropic", /\bAnthropic\b/i],
  ["Google DeepMind", /\b(?:Google )?DeepMind\b/i],
  ["AI", /\bAI\b/i],
];

const AI_POLICY_TERMS =
  /\b(?:AI|artificial intelligence|policy|regulat(?:ion|ory)|law|bill|congress|standard|evaluation|oversight|governance|agency|executive order)\b/i;
const TECHNOLOGY_TERMS =
  /\b(?:AI|artificial intelligence|technology|software|chip|semiconductor|cyber|compute|model|robot|internet|data center)\b/i;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function deriveNamedEntities(
  title: string,
  metadata: Readonly<Record<string, unknown>>,
): string[] {
  const explicit = strings(
    metadata.namedEntities ?? metadata.entities,
  );
  const derived = ENTITY_PATTERNS.flatMap(([name, pattern]) =>
    pattern.test(title) ? [name] : [],
  );
  const capitalizedPhrases = [
    ...title.matchAll(
      /\b[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){1,4}\b/g,
    ),
  ].flatMap((match) => match[0] ?? []);
  return unique([...explicit, ...derived, ...capitalizedPhrases]).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function derivePrimaryDocumentUrl(
  kind: ItemKind,
  originalUrl: string,
  metadata: Readonly<Record<string, unknown>>,
): string | null {
  for (const key of [
    "primaryDocumentUrl",
    "canonicalPrimaryDocument",
    "resolutionSource",
  ]) {
    const value = metadata[key];
    if (typeof value === "string") return value;
  }
  return kind === "document" ? originalUrl : null;
}

export function derivePrimarySection(
  title: string,
  sectionEligibility: readonly EditionSection[],
  namedEntities: readonly string[],
  kind: ItemKind,
): EditionSection {
  if (kind === "forecast") return "forecast";
  const eligible = new Set(sectionEligibility);
  const entities = new Set(namedEntities);
  if (eligible.has("baltimore") && entities.has("Baltimore")) {
    return "baltimore";
  }
  if (
    eligible.has("dmv") &&
    [...entities].some((entity) =>
      ["Baltimore", "Maryland", "Virginia", "Washington, D.C."].includes(
        entity,
      ),
    )
  ) {
    return "dmv";
  }
  if (eligible.has("ai_policy") && AI_POLICY_TERMS.test(title)) {
    return "ai_policy";
  }
  if (eligible.has("technology") && TECHNOLOGY_TERMS.test(title)) {
    return "technology";
  }
  for (const section of [
    "world",
    "technology",
    "ai_policy",
    "dmv",
    "baltimore",
  ] as const) {
    if (eligible.has(section)) return section;
  }
  return "world";
}

export function deriveNewsSignals(input: {
  kind: "article" | "document" | "forecast";
  title: string;
  originalUrl: string;
  sectionEligibility: readonly EditionSection[];
  metadata: Readonly<Record<string, unknown>>;
}): {
  sectionEligibility: EditionSection[];
  namedEntities: string[];
  primaryDocumentUrl: string | null;
  metadata: Record<string, unknown>;
} {
  const sectionEligibility = [...new Set(input.sectionEligibility)];
  const namedEntities = deriveNamedEntities(input.title, input.metadata);
  const primaryDocumentUrl = derivePrimaryDocumentUrl(
    input.kind,
    input.originalUrl,
    input.metadata,
  );
  return {
    sectionEligibility,
    namedEntities,
    primaryDocumentUrl,
    metadata: {
      ...input.metadata,
      primarySection: derivePrimarySection(
        input.title,
        sectionEligibility,
        namedEntities,
        input.kind,
      ),
    },
  };
}
