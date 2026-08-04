import type {
  EditionSection,
  ItemKind,
} from "../contracts/editorial";
import {
  ScopedNewsMaterialFactSchema,
  type CanonicalEventDomain,
  type CanonicalEventInstance,
  type NewsMaterialFact,
  type ScopedNewsMaterialFact,
} from "./types";
import {
  parseEventClauses,
  parseEventFactClauses,
  type EventClauseSemantics,
  type EventTextFields,
  type ParsedEventClause,
  type ParsedEventFactClause,
} from "./event-clause-parser";

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

const EXPLICIT_AI_EVIDENCE =
  /\b(?:artificial intelligence|AI (?:systems?|models?|governance|training|inference)|machine learning|foundation models?|frontier models?|generative AI|automated decision systems?|neural networks?|compute governance|model evaluations?|algorithmic accountability)\b/i;
const EXPLICIT_POLICY_ACTION =
  /\b(?:legislation|bill|regulation|rulemaking|rule (?:requires?|mandates?|governs?)|executive order|standards?|audit (?:requirement|mandate)|requires? audits?|evaluation policy|enforcement|oversight|accountability|procurement rule|reporting obligation|treaty)\b/i;
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

function materialParts(input: MaterialTextInput): string[] {
  return (typeof input === "string" ? [input] : input)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function hasExplicitAiPolicyEvidence(
  values: readonly (string | null | undefined)[],
): boolean {
  const material = values
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .slice(0, 12_000);
  return EXPLICIT_AI_EVIDENCE.test(material) && EXPLICIT_POLICY_ACTION.test(material);
}

function sentences(input: MaterialTextInput): string[] {
  return materialParts(input).flatMap(
    (part) =>
      part
        .split(/(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z])/)
        .map((sentence) => sentence.trim())
        .filter(Boolean),
  );
}

function normalizedIdentityPart(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/^(?:the|a|an)\s+/, "")
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function withoutDiscourseMarker(value: string): string {
  return value.replace(
    /^(?:(?:meanwhile|separately|however|previously|earlier|elsewhere|in contrast|by contrast|for context|in a statement|according to [^,]+),?\s+)+/i,
    "",
  );
}

function normalizedEventObject(
  value: string,
  subject: string,
): string {
  let normalized = value.startsWith(`${subject}-`)
    ? value.slice(subject.length + 1)
    : value;
  const predicate =
    "(?:proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|confirms?|confirmed|announces?|announced|details?|detailed|updates?|updated|reports?|reported|says?|said)";
  normalized = normalized.replace(
    new RegExp(`^.*-${predicate}-`),
    "",
  );
  let previous = "";
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized
      .replace(
        /^(?:(?:the|a|an|its|current|earlier|previous|new|later)-)+/,
        "",
      )
      .replace(new RegExp(`^(?:${predicate}-)+`), "")
      .replace(/^\d+(?:-model)?-/, "");
  }
  if (normalized === "governance-rule") {
    return "generic-governance-instrument";
  }
  return /^(?:(?:ai|model)-)?(?:evaluation|safety|security)-(?:standard|framework|requirements?)$/.test(
    normalized,
  )
    ? "model-evaluation-standard"
    : /^frontier-(?:model-)?evaluation-(?:standard|framework|proposal|requirements?)$/.test(
          normalized,
        )
      ? "frontier-evaluation-standard"
      : normalized;
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

function normalizeAmountFact(
  value: string,
  magnitude: string | undefined,
): string {
  const amount = Number(value.replace(/,/g, ""));
  const multiplier =
    magnitude?.toLocaleLowerCase("en-US").startsWith("b") === true
      ? 1_000_000_000
      : magnitude?.toLocaleLowerCase("en-US").startsWith("m") === true
        ? 1_000_000
        : 1;
  return Number.isFinite(amount)
    ? Math.round(amount * multiplier).toString()
    : value;
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

const GENERIC_INSTANCE_SUBJECTS = new Set([
  "ai",
  "artificial-intelligence",
  "united-states",
  "congress",
  "federal-register",
  "baltimore",
  "maryland",
  "virginia",
  "washington-d-c",
  "agency",
  "institute",
  "university",
  "department",
  "commission",
  "administration",
  "company",
  "laboratory",
  "lab",
]);

const EVENT_OBJECT_SUFFIX =
  "(?:Act|Bill|Rule|Standard|Framework|Guidance|Order|Program|Initiative|Fund|Round|Assistant|App|Tool|Service|Product|Model|Benchmark)";

function eventDomainForObject(
  object: string,
  eventFamilies: readonly string[],
): CanonicalEventDomain | null {
  const families = new Set(eventFamilies);
  if (/(?:program|initiative|fund|round)$/.test(object)) {
    return "funding-event";
  }
  if (/(?:assistant|app|tool|service|product|model)$/.test(object)) {
    return "product-event";
  }
  if (/benchmark$/.test(object)) {
    return "evaluation-event";
  }
  if (
    /(?:act|bill|rule|standard|framework|guidance|order)$/.test(
      object,
    )
  ) {
    return "governance-event";
  }
  if (families.has("funding-budget")) return "funding-event";
  if (families.has("product-release")) return "product-event";
  if (families.has("evaluation-benchmark")) {
    return "evaluation-event";
  }
  if (
    [...families].some((family) =>
      [
        "legislation",
        "guidance-rule",
        "evaluation-standards",
      ].includes(family),
    )
  ) {
    return "governance-event";
  }
  return null;
}

function eventObjectCandidates(
  text: string,
  eventFamilies: readonly string[],
): { object: string; domain: CanonicalEventDomain }[] {
  const candidateText = withoutDiscourseMarker(text.trim());
  const candidates = new Map<
    string,
    { object: string; domain: CanonicalEventDomain }
  >();
  const namedPatterns = [
    new RegExp(
      `\\b(?:[A-Z][A-Za-z0-9&.-]*\\s+){0,5}${EVENT_OBJECT_SUFFIX}\\b`,
      "g",
    ),
    new RegExp(
      `\\b(?:[A-Z0-9&.-]+\\s+){0,5}${EVENT_OBJECT_SUFFIX.toUpperCase()}\\b`,
      "g",
    ),
  ];
  for (const pattern of namedPatterns) {
    for (const match of candidateText.matchAll(pattern)) {
      const raw = match[0];
      if (raw === undefined) continue;
      const object = normalizedIdentityPart(raw);
      const domain = eventDomainForObject(object, eventFamilies);
      if (object.length > 0 && domain !== null) {
        candidates.set(`${domain}\u0000${object}`, { object, domain });
      }
    }
  }
  if (candidates.size > 0) return [...candidates.values()];

  const leadingDescription = new RegExp(
    `^(?:the\\s+)?(?<object>(?:[A-Za-z0-9&.-]+\\s+){1,6}${EVENT_OBJECT_SUFFIX})\\b`,
    "i",
  ).exec(candidateText)?.groups?.object;
  if (leadingDescription !== undefined) {
    const object = normalizedEventObject(
      normalizedIdentityPart(leadingDescription),
      "",
    );
    if (object.split("-").length > 1) {
      const domain = eventDomainForObject(object, eventFamilies);
      if (domain !== null) {
        candidates.set(`${domain}\u0000${object}`, {
          object,
          domain,
        });
      }
    }
  }
  if (candidates.size > 0) return [...candidates.values()];

  for (const match of candidateText.matchAll(
    /\b((?:(?:ai|model|frontier|compute|safety|security|data|privacy|transparency|evaluation)\s+){1,4}(?:act|bill|rule|standard|framework|guidance|order|program|initiative|fund|round|assistant|app|tool|service|product|model|benchmark))\b/gi,
  )) {
    const raw = match[1];
    if (raw === undefined) continue;
    const object = normalizedEventObject(
      normalizedIdentityPart(raw),
      "",
    );
    const domain = eventDomainForObject(object, eventFamilies);
    if (object.length > 0 && domain !== null) {
      candidates.set(`${domain}\u0000${object}`, { object, domain });
    }
  }
  if (candidates.size > 0) return [...candidates.values()];

  const genericPatterns: readonly [
    string,
    CanonicalEventDomain,
    RegExp,
  ][] = [
    [
      "frontier-evaluation-standard",
      "governance-event",
      /\bfrontier(?:-|\s+)(?:model\s+)?evaluation\s+(?:standard|framework|proposal|requirements?)\b/i,
    ],
    [
      "model-evaluation-standard",
      "governance-event",
      /\b(?:AI\s+)?(?:evaluation|safety|security)\s+(?:standard|framework|requirements?)\b/i,
    ],
    [
      "generic-governance-instrument",
      "governance-event",
      /\b(?:governance|policy)\s+(?:rule|guidance|proposal|instrument)\b/i,
    ],
    [
      "generic-evaluation-benchmark",
      "evaluation-event",
      /\b(?:evaluation|safety|security)\s+benchmark\b/i,
    ],
  ];
  for (const [object, domain, pattern] of genericPatterns) {
    if (pattern.test(candidateText)) {
      candidates.set(`${domain}\u0000${object}`, { object, domain });
    }
  }
  return [...candidates.values()];
}

function canonicalSubjectCandidates(
  entities: readonly string[],
): string[] {
  const candidates = unique(entities)
    .map((entity) => ({
      raw: entity,
      normalized: normalizedIdentityPart(entity),
    }))
    .filter(
      ({ normalized }) =>
        normalized.length > 0 &&
        !GENERIC_INSTANCE_SUBJECTS.has(normalized) &&
        !/(?:act|bill|rule|standard|framework|guidance|order|program|initiative|fund|round|assistant|app|tool|service|product|model|benchmark)$/.test(
          normalized,
        ),
    )
    .map(({ normalized }) => normalized);
  const organizations = [
    ...new Set(
      candidates.filter((candidate) =>
        /(?:agency|institute|university|department|commission|administration|company|laboratory|lab)$/.test(
          candidate,
        ),
      ),
    ),
  ];
  if (organizations.length > 0) return organizations;
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates;
}

function canonicalInstanceSubject(
  entities: readonly string[],
): string | null {
  const candidates = canonicalSubjectCandidates(entities);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

function eventTextFields(input: MaterialTextInput): EventTextFields {
  if (typeof input === "string") return { title: input };
  return {
    title: input[0] ?? "",
    abstract: input[1] ?? null,
    content: input[2] ?? null,
  };
}

function newsClauseSemantics(): EventClauseSemantics {
  return {
    canonicalSubject(subjectText) {
      return canonicalInstanceSubject(
        deriveNamedEntities(subjectText, {}),
      );
    },
    eventObjects(objectText, families, subject) {
      return eventObjectCandidates(objectText, families)
        .map((candidate) => ({
          ...candidate,
          object: normalizedEventObject(candidate.object, subject),
        }))
        .filter(
          ({ object }) =>
            object !== "generic-governance-instrument",
        );
    },
    materialFacts(clauseText) {
      return extractMaterialFacts(clauseText);
    },
  };
}

function parseNewsEventClauses(
  text: MaterialTextInput,
  eventFamilies: readonly string[],
): ParsedEventClause[] {
  return parseEventClauses({
    text: eventTextFields(text),
    eventFamilies,
    semantics: newsClauseSemantics(),
  });
}

function parseNewsEventFactClauses(
  text: MaterialTextInput,
  eventFamilies: readonly string[],
  eventInstance: CanonicalEventInstance,
): ParsedEventFactClause[] {
  return parseEventFactClauses({
    text: eventTextFields(text),
    eventFamilies,
    eventInstance,
    semantics: newsClauseSemantics(),
  });
}

function canonicalInstances(
  clauses: readonly ParsedEventClause[],
): CanonicalEventInstance[] {
  const instances = new Map(
    clauses.map(({ subject, domain, object }) => [
      `${subject}\u0000${domain}\u0000${object}`,
      { subject, domain, object },
    ]),
  );
  return instances.size === 1 ? [...instances.values()] : [];
}

export function deriveCanonicalEventInstances(
  input: MaterialTextInput,
  _metadata: Readonly<Record<string, unknown>>,
  _namedEntities: readonly string[],
  eventFamilies: readonly string[],
): CanonicalEventInstance[] {
  return canonicalInstances(
    parseNewsEventClauses(input, eventFamilies),
  );
}

function scopedFactsForInstance(
  clauses: readonly ParsedEventClause[],
  factClauses: readonly ParsedEventFactClause[],
  eventInstance: CanonicalEventInstance,
): NewsMaterialFact[] {
  return uniqueMaterialFacts(
    [
      ...clauses.filter((candidate) =>
        candidate.subject === eventInstance.subject &&
        candidate.domain === eventInstance.domain &&
        candidate.object === eventInstance.object,
      ),
      ...factClauses.filter((candidate) =>
        candidate.domain === eventInstance.domain &&
        candidate.object === eventInstance.object,
      ),
    ].flatMap(({ facts }) => facts),
  );
}

function sameEventInstance(
  left: CanonicalEventInstance,
  right: CanonicalEventInstance,
): boolean {
  return left.subject === right.subject &&
    left.domain === right.domain &&
    left.object === right.object;
}

function scopedMaterialFactsForResolvedEvent(input: {
  clauses: readonly ParsedEventClause[];
  factClauses: readonly ParsedEventFactClause[];
  metadata: Readonly<Record<string, unknown>>;
  eventInstances: readonly CanonicalEventInstance[];
}): ScopedNewsMaterialFact[] {
  if (input.eventInstances.length !== 1) return [];
  const eventInstance = input.eventInstances[0];
  if (eventInstance === undefined) return [];

  const explicit = Array.isArray(input.metadata.scopedMaterialFacts)
    ? input.metadata.scopedMaterialFacts.flatMap(
        (entry): ScopedNewsMaterialFact[] => {
          const parsed = ScopedNewsMaterialFactSchema.safeParse(entry);
          return parsed.success &&
            sameEventInstance(
              parsed.data.eventInstance,
              eventInstance,
            )
            ? [parsed.data]
            : [];
        },
      )
    : [];
  const derived = scopedFactsForInstance(
    input.clauses,
    input.factClauses,
    eventInstance,
  ).map((fact) => ({ ...fact, eventInstance }));
  const unique = new Map(
    [...explicit, ...derived].map((fact) => [
      `${fact.kind}\u0000${fact.key}\u0000${fact.value}`,
      fact,
    ]),
  );
  return [...unique.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key) ||
      left.value.localeCompare(right.value),
  );
}

function uniqueMaterialFacts(
  facts: readonly NewsMaterialFact[],
): NewsMaterialFact[] {
  const uniqueFacts = new Map<string, NewsMaterialFact>();
  for (const fact of facts) {
    const normalizedFact = {
      ...fact,
      value:
        fact.kind === "number" || fact.kind === "amount"
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

function extractMaterialFacts(
  sourceText: string,
): NewsMaterialFact[] {
  const facts: NewsMaterialFact[] = [];
  const materialContext =
    /\b(?:standard|framework|requirements?|policy|rule|bill|law|measure|guidance|document|order|program|system|model|funding|budget|appropriation|initiative|fund|round|grant|product|assistant|app|tool|service)\b/i;
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
  for (const match of sourceText.matchAll(
    /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(billion|million|bn|m|b)?\b/gi,
  )) {
    const value = match[1];
    const magnitude = match[2];
    const index = match.index;
    if (
      value === undefined ||
      index === undefined ||
      !/\b(?:funding|budget|appropriation|program|initiative|fund|round|grant)\b/i.test(
        sentenceAround(sourceText, index),
      )
    ) {
      continue;
    }
    facts.push({
      kind: "amount",
      key: "funding-amount:usd",
      value: normalizeAmountFact(value, magnitude),
    });
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
  return uniqueMaterialFacts(facts);
}

export function deriveMaterialFacts(
  text: MaterialTextInput,
  metadata: Readonly<Record<string, unknown>>,
  eventInstance: CanonicalEventInstance | null = null,
): NewsMaterialFact[] {
  if (eventInstance === null) {
    return extractMaterialFacts(combinedText(text));
  }

  const eventFamilies = deriveEventFamilies(text, metadata);
  const clauses = parseNewsEventClauses(text, eventFamilies);
  return scopedFactsForInstance(
    clauses,
    parseNewsEventFactClauses(
      text,
      eventFamilies,
      eventInstance,
    ),
    eventInstance,
  );
}

export function deriveScopedMaterialFacts(
  text: MaterialTextInput,
  metadata: Readonly<Record<string, unknown>>,
  eventInstances: readonly CanonicalEventInstance[],
): ScopedNewsMaterialFact[] {
  const eventFamilies = deriveEventFamilies(text, metadata);
  const clauses = parseNewsEventClauses(text, eventFamilies);
  const eventInstance = eventInstances.length === 1
    ? eventInstances[0] ?? null
    : null;
  return scopedMaterialFactsForResolvedEvent({
    clauses,
    factClauses: eventInstance === null
      ? []
      : parseNewsEventFactClauses(
          text,
          eventFamilies,
          eventInstance,
        ),
    metadata,
    eventInstances,
  });
}

export function deriveNamedEntities(
  text: MaterialTextInput,
  metadata: Readonly<Record<string, unknown>>,
): string[] {
  const sourceText = combinedText(text);
  const explicit = strings(
    metadata.namedEntities ?? metadata.entities,
  );
  const derived = ENTITY_PATTERNS.flatMap(([name, pattern]) =>
    pattern.test(sourceText) ? [name] : [],
  );
  const rawPredicateEntities = sentences(text).flatMap((sentence) => {
    const active =
      /^(?<subject>[A-Za-z0-9&.,'’-]+(?:\s+[A-Za-z0-9&.,'’-]+){0,5})\s+(?:propos(?:e|es|ed)|introduc(?:e|es|ed)|adopt(?:s|ed)?|approv(?:e|es|ed)|launch(?:es|ed)?|releas(?:e|es|ed)|unveil(?:s|ed)?|publish(?:es|ed)|issu(?:e|es|ed)|confirm(?:s|ed)?|announc(?:e|es|ed)|detail(?:s|ed)?|updat(?:es|ed)|report(?:s|ed)|says?|said)\b/i.exec(
        sentence,
      )?.groups?.subject;
    const passive =
      /\b(?:proposed|introduced|adopted|approved|launched|released|unveiled|published|issued)\s+by\s+(?<subject>[A-Z][A-Za-z0-9&,'’-]*(?:\s+[A-Z][A-Za-z0-9&,'’-]*){0,4})/.exec(
        sentence,
      )?.groups?.subject;
    return [active, passive]
      .filter((value): value is string => value !== undefined)
      .filter(
        (value) =>
          !GENERIC_INSTANCE_SUBJECTS.has(
            normalizedIdentityPart(value),
          ),
      );
  });
  const organizationEntities = sentences(text).flatMap((sentence) =>
    [
      /\b(?:[A-Z][A-Za-z0-9&.-]*\s+){1,4}(?:Agency|Institute|University|Department|Commission|Administration|Company|Laboratory|Lab)\b/g,
      /\b(?:[A-Z0-9&.-]+\s+){1,4}(?:AGENCY|INSTITUTE|UNIVERSITY|DEPARTMENT|COMMISSION|ADMINISTRATION|COMPANY|LABORATORY|LAB)\b/g,
    ].flatMap((pattern) =>
      [...sentence.matchAll(pattern)].flatMap(
        (match) => match[0] ?? [],
      ),
    ),
  );
  const predicateEntities = rawPredicateEntities.map((entity) => {
    const normalized = normalizedIdentityPart(entity);
    return [...organizationEntities]
      .filter((organization) =>
        normalized.endsWith(
          normalizedIdentityPart(organization),
        ),
      )
      .sort(
        (left, right) =>
          normalizedIdentityPart(right).length -
          normalizedIdentityPart(left).length,
      )[0] ?? entity;
  });
  const capitalizedPhrases = sentences(text).flatMap((sentence) => [
    ...sentence.matchAll(
      /\b[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){1,4}\b/g,
    ),
  ]).flatMap((match) => match[0] ?? []);
  return unique([
    ...explicit,
    ...derived,
    ...predicateEntities,
    ...organizationEntities,
    ...capitalizedPhrases,
  ]).sort((left, right) =>
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
  aiPolicyEvidence: boolean,
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
    preferredSection !== "morning_brief" &&
    (preferredSection !== "ai_policy" || aiPolicyEvidence)
  ) {
    return preferredSection;
  }
  if (eligible.has("ai_policy") && aiPolicyEvidence) {
    return "ai_policy";
  }
  if (eligible.has("technology") && TECHNOLOGY_TERMS.test(title)) {
    return "technology";
  }
  for (const section of ["world", "technology", "dmv", "baltimore"] as const) {
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
  eventInstances: CanonicalEventInstance[];
  materialFacts: NewsMaterialFact[];
  scopedMaterialFacts: ScopedNewsMaterialFact[];
  metadata: Record<string, unknown>;
} {
  const sectionEligibility = [...new Set(input.sectionEligibility)];
  const materialText = [input.title, input.abstract, input.content];
  const aiPolicyEvidence = hasExplicitAiPolicyEvidence(materialText);
  const namedEntities = deriveNamedEntities(
    materialText,
    input.metadata,
  );
  const primaryDocumentUrl = derivePrimaryDocumentUrl(
    input.kind,
    input.originalUrl,
    input.metadata,
  );
  const primaryDocumentUrls = unique([
    ...strings(input.metadata.primaryDocumentUrls),
    ...(primaryDocumentUrl === null ? [] : [primaryDocumentUrl]),
  ]).sort((left, right) => left.localeCompare(right));
  const eventFamilies = deriveEventFamilies(
    materialText,
    input.metadata,
  );
  const parsedEventClauses = parseNewsEventClauses(
    materialText,
    eventFamilies,
  );
  const eventInstances = canonicalInstances(parsedEventClauses);
  const eventInstance = eventInstances.length === 1
    ? eventInstances[0] ?? null
    : null;
  const parsedEventFactClauses = eventInstance === null
    ? []
    : parseNewsEventFactClauses(
        materialText,
        eventFamilies,
        eventInstance,
      );
  const scopedMaterialFacts = scopedMaterialFactsForResolvedEvent({
    clauses: parsedEventClauses,
    factClauses: parsedEventFactClauses,
    metadata: input.metadata,
    eventInstances,
  });
  const materialFacts = extractMaterialFacts(combinedText(materialText));
  return {
    sectionEligibility,
    namedEntities,
    primaryDocumentUrl,
    primaryDocumentUrls,
    eventFamilies,
    eventInstances,
    materialFacts,
    scopedMaterialFacts,
    metadata: {
      ...input.metadata,
      primarySection: derivePrimarySection(
        input.title,
        sectionEligibility,
        namedEntities,
        input.kind,
        input.preferredSection,
        aiPolicyEvidence,
      ),
    },
  };
}
