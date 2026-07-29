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

type MaterialTextInput =
  | string
  | readonly (string | null | undefined)[];

function combinedText(input: MaterialTextInput): string {
  return (typeof input === "string" ? [input] : input)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(". ");
}

function sentenceAround(value: string, index: number): string {
  const starts = [
    value.lastIndexOf(". ", index),
    value.lastIndexOf("? ", index),
    value.lastIndexOf("! ", index),
  ];
  const start = Math.max(...starts) + 2;
  const ends = [
    value.indexOf(". ", index),
    value.indexOf("? ", index),
    value.indexOf("! ", index),
  ].filter((candidate) => candidate >= 0);
  const end = ends.length === 0 ? value.length : Math.min(...ends);
  return value.slice(start, end);
}

function normalizeNumberFact(value: string): string {
  const normalized = Number(value.replace(/,/g, ""));
  return Number.isFinite(normalized)
    ? normalized.toString()
    : value.replace(/,/g, "");
}

const MONTH_NUMBERS: Readonly<Record<string, string>> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function normalizeDateFact(value: string): string {
  if (/^20\d{2}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const match =
    /^(?<month>[A-Za-z]+)\s+(?<day>\d{1,2})(?:,\s+(?<year>20\d{2}))?$/.exec(
      value.trim(),
    );
  const month =
    match?.groups?.month === undefined
      ? undefined
      : MONTH_NUMBERS[
          match.groups.month.toLocaleLowerCase("en-US")
        ];
  const day = match?.groups?.day;
  if (month === undefined || day === undefined) {
    return value.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  }
  const suffix = `${month}-${day.padStart(2, "0")}`;
  const year = match?.groups?.year;
  return year === undefined
    ? `--${suffix}`
    : `${year}-${suffix}`;
}

const EVENT_FAMILY_PATTERNS: readonly [string, RegExp][] = [
  [
    "evaluation-standards",
    /\b(?:evaluation|safety|security)\s+(?:framework|standard|requirements?)\b|\b(?:framework|standard)\s+(?:for|on)\s+(?:AI|models?|evaluation)\b/i,
  ],
  [
    "evaluation-benchmark",
    /\b(?:evaluation|safety|security)\s+benchmark\b|\bbenchmark\s+(?:for|on)\s+(?:AI|models?|evaluation)\b/i,
  ],
  [
    "product-release",
    /\b(?:launch|release|unveil|introduc)(?:es|ed|ing)?\b.*\b(?:app|assistant|product|service|model|tool)\b|\b(?:app|assistant|product|service|model|tool)\b.*\b(?:launch|release|unveil|introduc)(?:es|ed|ing)?\b/i,
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
  text: MaterialTextInput,
  metadata: Readonly<Record<string, unknown>>,
): string[] {
  const sourceText = combinedText(text);
  return unique([
    ...strings(metadata.eventFamilies),
    ...EVENT_FAMILY_PATTERNS.flatMap(([family, pattern]) =>
      pattern.test(sourceText) ? [family] : [],
    ),
  ]).sort((left, right) => left.localeCompare(right));
}

export function deriveMaterialFacts(
  text: MaterialTextInput,
  metadata: Readonly<Record<string, unknown>>,
): NewsMaterialFact[] {
  const sourceText = combinedText(text);
  const facts = [...explicitMaterialFacts(metadata)];
  const materialContext =
    /\b(?:standard|framework|requirements?|policy|rule|bill|law|measure|guidance|document|order|program|system|model)\b/i;
  const statusPatterns: readonly [string, RegExp][] = [
    ["proposed", /\b(?:propos(?:e|es|ed)|introduc(?:e|es|ed))\b/i],
    ["adopted", /\b(?:approv(?:e|es|ed)|adopt(?:s|ed)?|pass(?:es|ed)?)\b/i],
    ["released", /\b(?:launch(?:es|ed)?|releas(?:e|es|ed)|publish(?:es|ed)|unveil(?:s|ed)?)\b/i],
    ["delayed", /\b(?:delay(?:s|ed)?|postpon(?:e|es|ed))\b/i],
    ["blocked", /\b(?:reject(?:s|ed)?|block(?:s|ed)?)\b/i],
    ["withdrawn", /\b(?:withdraw(?:s|n)?|repeal(?:s|ed)?)\b/i],
  ];
  const statusMatches = statusPatterns.flatMap(
    ([value, pattern]): { value: string; index: number }[] => {
      const globalPattern = new RegExp(
        pattern.source,
        pattern.flags.includes("g")
          ? pattern.flags
          : `${pattern.flags}g`,
      );
      return [...sourceText.matchAll(globalPattern)].flatMap(
        (match): { value: string; index: number }[] => {
          const index = match.index;
          if (index === undefined) return [];
          return materialContext.test(sentenceAround(sourceText, index))
            ? [{ value, index }]
            : [];
        },
      );
    },
  );
  const statusPriority: Readonly<Record<string, number>> = {
    proposed: 0,
    released: 1,
    delayed: 2,
    blocked: 2,
    withdrawn: 2,
    adopted: 2,
  };
  const status = statusMatches.sort(
    (left, right) =>
      (statusPriority[right.value] ?? 0) -
        (statusPriority[left.value] ?? 0) ||
      right.index - left.index,
  )[0];
  if (status !== undefined) {
    facts.push({
      kind: "status",
      key: "event-status",
      value: status.value,
    });
  }
  const countUnits: Readonly<Record<string, string>> = {
    model: "models",
    models: "models",
    system: "systems",
    systems: "systems",
    agency: "agencies",
    agencies: "agencies",
    organization: "organizations",
    organizations: "organizations",
    state: "states",
    states: "states",
    country: "countries",
    countries: "countries",
    user: "users",
    users: "users",
    employee: "employees",
    employees: "employees",
    requirement: "requirements",
    requirements: "requirements",
    evaluation: "evaluations",
    evaluations: "evaluations",
    test: "tests",
    tests: "tests",
    benchmark: "benchmarks",
    benchmarks: "benchmarks",
  };
  for (const match of sourceText.matchAll(
    /\b(\d+(?:,\d{3})*(?:\.\d+)?)(?:-|\s+)(models?|systems?|agenc(?:y|ies)|organizations?|states?|countries?|users?|employees?|requirements?|evaluations?|tests?|benchmarks?)\b/gi,
  )) {
    const value = match[1];
    const rawUnit = match[2]?.toLocaleLowerCase("en-US");
    const unit =
      rawUnit === undefined ? undefined : countUnits[rawUnit];
    const index = match.index;
    if (
      value !== undefined &&
      unit !== undefined &&
      index !== undefined
    ) {
      const context = sentenceAround(sourceText, index);
      const eventContext =
        /\b(?:standard|framework|requirements?|policy|rule|bill|law|measure|guidance|document|order)\b/i.test(
          context,
        )
          ? "governance-instrument"
          : /\b(?:benchmark|evaluation|test)\b/i.test(context)
            ? "benchmark"
            : /\b(?:program|pilot|initiative)\b/i.test(context)
              ? "program"
              : null;
      if (eventContext === null) continue;
      facts.push({
        kind: "number",
        key: `count:${eventContext}:${unit}`,
        value: normalizeNumberFact(value),
      });
    }
  }
  const datePattern =
    "(?:20\\d{2}-\\d{2}-\\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2}(?:,\\s+20\\d{2})?)";
  for (const match of sourceText.matchAll(
    new RegExp(
      `\\b(effective|takes? effect|deadline(?: is| of)?|by)\\s+(${datePattern})\\b`,
      "gi",
    ),
  )) {
    const context = match[1]?.toLocaleLowerCase("en-US");
    const value = match[2];
    if (context !== undefined && value !== undefined) {
      facts.push({
        kind: "date",
        key: context.startsWith("deadline") || context === "by"
          ? "deadline-date"
          : "effective-date",
        value: normalizeDateFact(value),
      });
    }
  }
  const uniqueFacts = new Map<string, NewsMaterialFact>();
  for (const fact of facts) {
    const normalizedFact = {
      ...fact,
      value:
        fact.kind === "number"
          ? normalizeNumberFact(fact.value)
          : fact.kind === "date"
            ? normalizeDateFact(fact.value)
            : fact.value.toLocaleLowerCase("en-US").trim(),
    };
    uniqueFacts.set(
      `${normalizedFact.kind}\u0000${normalizedFact.key}\u0000${normalizedFact.value}`,
      normalizedFact,
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
  abstract?: string | null;
  content?: string | null;
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
  const materialText = [input.title, input.abstract, input.content];
  const eventFamilies = deriveEventFamilies(
    materialText,
    input.metadata,
  );
  const materialFacts = deriveMaterialFacts(
    materialText,
    input.metadata,
  );
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
