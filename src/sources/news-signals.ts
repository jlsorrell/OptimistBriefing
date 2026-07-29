import type {
  EditionSection,
  ItemKind,
} from "../contracts/editorial";
import {
  NewsMaterialFactSchema,
  type NewsMaterialFact,
} from "./types";

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

const AI_CONTEXT =
  /\b(?:AI|artificial intelligence|machine learning|algorithmic?|model(?:s)?)\b/i;
const GOVERNANCE_CONTEXT =
  /\b(?:policy|regulat(?:ion|ory)|law|bill|standard(?:s)?|oversight|governance|accountability|audit|executive order)\b/i;
const STRONG_AI_POLICY_CONTEXT =
  /\b(?:AI|artificial intelligence|algorithmic?|model)\s+(?:policy|regulat(?:ion|ory)|law|bill|standard(?:s)?|oversight|governance|accountability)|\b(?:policy|regulat(?:ion|ory)|law|bill|standard(?:s)?|oversight|governance|accountability)\s+(?:for|of|on)?\s*(?:AI|artificial intelligence|algorithmic?|models?)\b/i;
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

const EVENT_FAMILY_PATTERNS: readonly [string, RegExp][] = [
  [
    "evaluation-standards",
    /\b(?:evaluation|safety|security)\s+(?:framework|standard|benchmark|requirements?)\b|\b(?:framework|standard|benchmark)\s+(?:for|on)\s+(?:AI|models?|evaluation)\b/i,
  ],
  [
    "product-release",
    /\b(?:launch|release|unveil|introduc)(?:es|ed|ing)?\b.*\b(?:app|assistant|product|service|model|tool)\b/i,
  ],
  [
    "legislation",
    /\b(?:bill|act|legislation|law)\b/i,
  ],
  [
    "funding-budget",
    /\b(?:budget|funding|appropriation)\b/i,
  ],
  [
    "guidance-rule",
    /\b(?:guidance|rule|requirement|notice)\b/i,
  ],
];

function explicitMaterialFacts(
  metadata: Readonly<Record<string, unknown>>,
): NewsMaterialFact[] {
  const value = metadata.materialFacts;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): NewsMaterialFact[] => {
    const parsed = NewsMaterialFactSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function deriveEventFamilies(
  title: string,
  metadata: Readonly<Record<string, unknown>>,
): string[] {
  return unique([
    ...strings(metadata.eventFamilies),
    ...EVENT_FAMILY_PATTERNS.flatMap(([family, pattern]) =>
      pattern.test(title) ? [family] : [],
    ),
  ]).sort((left, right) => left.localeCompare(right));
}

export function deriveMaterialFacts(
  title: string,
  metadata: Readonly<Record<string, unknown>>,
): NewsMaterialFact[] {
  const facts = [...explicitMaterialFacts(metadata)];
  const statusPatterns: readonly [string, RegExp][] = [
    ["proposed", /\b(?:propos(?:e|es|ed)|introduc(?:e|es|ed))\b/i],
    ["adopted", /\b(?:approv(?:e|es|ed)|adopt(?:s|ed)?|pass(?:es|ed)?)\b/i],
    ["released", /\b(?:launch(?:es|ed)?|releas(?:e|es|ed)|publish(?:es|ed)|unveil(?:s|ed)?)\b/i],
    ["delayed", /\b(?:delay(?:s|ed)?|postpon(?:e|es|ed))\b/i],
    ["blocked", /\b(?:reject(?:s|ed)?|block(?:s|ed)?)\b/i],
    ["withdrawn", /\b(?:withdraw(?:s|n)?|repeal(?:s|ed)?)\b/i],
  ];
  const status = statusPatterns.find(([, pattern]) => pattern.test(title));
  if (status !== undefined) {
    facts.push({ kind: "status", key: "event-status", value: status[0] });
  }
  for (const match of title.matchAll(
    /\b\d+(?:,\d{3})*(?:\.\d+)?%?\b/g,
  )) {
    const value = match[0];
    if (value !== undefined) {
      facts.push({
        kind: "number",
        key: "reported-number",
        value: value.replace(/,/g, ""),
      });
    }
  }
  for (const match of title.matchAll(
    /\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s+20\d{2})?)\b/gi,
  )) {
    const value = match[0];
    if (value !== undefined) {
      facts.push({
        kind: "date",
        key: "reported-date",
        value: value.toLocaleLowerCase("en-US").replace(/\s+/g, " "),
      });
    }
  }
  const uniqueFacts = new Map<string, NewsMaterialFact>();
  for (const fact of facts) {
    uniqueFacts.set(
      `${fact.kind}\u0000${fact.key}\u0000${fact.value}`,
      fact,
    );
  }
  return [...uniqueFacts.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key) ||
      left.value.localeCompare(right.value),
  );
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
  preferredSection: EditionSection | undefined,
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
  if (
    preferredSection !== undefined &&
    eligible.has(preferredSection) &&
    preferredSection !== "morning_brief"
  ) {
    return preferredSection;
  }
  if (
    eligible.has("ai_policy") &&
    (STRONG_AI_POLICY_CONTEXT.test(title) ||
      (AI_CONTEXT.test(title) && GOVERNANCE_CONTEXT.test(title)))
  ) {
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
  preferredSection: EditionSection | undefined;
}): {
  sectionEligibility: EditionSection[];
  namedEntities: string[];
  primaryDocumentUrl: string | null;
  primaryDocumentUrls: string[];
  eventFamilies: string[];
  materialFacts: NewsMaterialFact[];
  metadata: Record<string, unknown>;
} {
  const sectionEligibility = [...new Set(input.sectionEligibility)];
  const namedEntities = deriveNamedEntities(input.title, input.metadata);
  const primaryDocumentUrl = derivePrimaryDocumentUrl(
    input.kind,
    input.originalUrl,
    input.metadata,
  );
  const primaryDocumentUrls = unique([
    ...strings(input.metadata.primaryDocumentUrls),
    ...(primaryDocumentUrl === null ? [] : [primaryDocumentUrl]),
  ]).sort((left, right) => left.localeCompare(right));
  const eventFamilies = deriveEventFamilies(input.title, input.metadata);
  const materialFacts = deriveMaterialFacts(input.title, input.metadata);
  return {
    sectionEligibility,
    namedEntities,
    primaryDocumentUrl,
    primaryDocumentUrls,
    eventFamilies,
    materialFacts,
    metadata: {
      ...input.metadata,
      primarySection: derivePrimarySection(
        input.title,
        sectionEligibility,
        namedEntities,
        input.kind,
        input.preferredSection,
      ),
    },
  };
}
