import type {
  CanonicalEventDomain,
  CanonicalEventInstance,
  NewsMaterialFact,
} from "./types";

export type EventTextFields = Readonly<{
  title: string;
  abstract?: string | null;
  content?: string | null;
}>;

export type EventObjectCandidate = Readonly<{
  domain: CanonicalEventDomain;
  object: string;
}>;

export interface EventClauseSemantics {
  canonicalSubject(subjectText: string): string | null;
  eventObjects(
    objectText: string,
    eventFamilies: readonly string[],
    subject: string,
  ): readonly EventObjectCandidate[];
  materialFacts(
    clauseText: string,
    eventInstance: CanonicalEventInstance,
  ): readonly NewsMaterialFact[];
}

type EventPredicate = ParsedEventClause["predicate"];
type SourceField = ParsedEventClause["sourceField"];

export interface ParsedEventClause {
  sourceField: "title" | "abstract" | "content";
  sentenceIndex: number;
  clauseIndex: number;
  text: string;
  predicate:
    | "proposed"
    | "introduced"
    | "adopted"
    | "approved"
    | "launched"
    | "released"
    | "unveiled"
    | "published"
    | "issued"
    | "announced"
    | "updated";
  subject: string;
  domain: CanonicalEventDomain;
  object: string;
  facts: NewsMaterialFact[];
}

export interface ParsedEventFactClause {
  sourceField: "title" | "abstract" | "content";
  sentenceIndex: number;
  clauseIndex: number;
  text: string;
  domain: CanonicalEventDomain;
  object: string;
  facts: NewsMaterialFact[];
}

const MAX_COMPLEMENT_DEPTH = 3;
const MAX_CLAUSES_PER_SENTENCE = 16;

const ACTIVE_EVENT =
  /^(?<subject>.+?)\s+(?<predicate>proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|announces?|announced|updates?|updated)\b(?<objectText>.+)$/i;

const PASSIVE_EVENT =
  /^(?<objectText>.+?)\s+(?:(?:was|is|has been|had been)\s+)?(?<predicate>proposed|introduced|adopted|approved|launched|released|unveiled|published|issued|announced|updated)\s+by\s+(?<subject>[^.!?]+)$/i;

const HEADLINE_EVENT =
  /^(?<subject>.+?):\s*(?<objectText>.+?)\s+(?<predicate>proposed|introduced|adopted|approved|launched|released|unveiled|published|issued|announced|updated)$/i;

const ORGANIZATION_HEADLINE_EVENT =
  /^(?<subject>.+?(?:Agency|Institute|University|Department|Commission|Administration|Company|Laboratory|Lab))\s+(?<objectText>.+?)\s+(?<predicate>proposed|introduced|adopted|approved|launched|released|unveiled|published|issued|announced|updated)(?:\s+for\s+\d+(?:,\d{3})*(?:\.\d+)?(?:-|\s+)(?:models?|systems?|agenc(?:y|ies)|organizations?|states?|countries?|users?|employees?|requirements?|evaluations?|tests?|benchmarks?))?$/i;

const REPORTING_COMPLEMENT =
  /\b(?:says?|said|reports?|reported|details?|detailed|confirms?|confirmed|announces?|announced)\s+that\s+/i;

const CLAUSE_BOUNDARY =
  /;\s*|,\s*(?=(?:after|before|because|while|whereas|but)\b)|\s+(?=(?:after|before|because|while|whereas|but)\b)/i;

const COORDINATED_EVENT_BOUNDARY =
  /,?\s+and\s+(?=(?:(?:The\s+)?(?:[A-Z][A-Za-z0-9&.'’-]*\s+){0,5}(?:Agency|Institute|University|Department|Commission|Administration|Company|Laboratory|Lab)\s+(?:proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|announces?|announced|updates?|updated)\b|[A-Z][^.!?]*?\s+(?:(?:was|is|has been|had been)\s+)?(?:proposed|introduced|adopted|approved|launched|released|unveiled|published|issued|announced|updated)\s+by\s+(?:The\s+)?(?:[A-Z][A-Za-z0-9&.'’-]*\s+){0,5}(?:Agency|Institute|University|Department|Commission|Administration|Company|Laboratory|Lab)\b))/i;

const EVENT_PREDICATE_BEFORE_COORDINATION =
  /\b(?:proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|announces?|announced|updates?|updated)\b[^.!?]*?,?\s+and\s+/i;

const UNSAFE_COORDINATED_EVENT =
  /\band\b(?=[^.!?]*\b(?:proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|announces?|announced|updates?|updated)\b)/i;

const MATERIAL_COORDINATION_BOUNDARY = /,?\s+and\s+/gi;
const MATERIAL_DATE =
  "(?:20\\d{2}-\\d{2}-\\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2}(?:,\\s+20\\d{2})?)";
const MATERIAL_PREDICATE = new RegExp(
  `\\b(?:propos(?:e|es|ed)|introduc(?:e|es|ed)|adopt(?:s|ed)?|approv(?:e|es|ed)|pass(?:es|ed)?|launch(?:es|ed)?|releas(?:e|es|ed)|publish(?:es|ed)|unveil(?:s|ed)?|issu(?:e|es|ed)|announc(?:e|es|ed)|updat(?:e|es|ed)|delay(?:s|ed)?|postpon(?:e|es|ed)|reject(?:s|ed)?|block(?:s|ed)?|withdraw(?:s|n)?|repeal(?:s|ed)?|effective|takes?\\s+effect|deadline(?:\\s+is|\\s+of)?|by\\s+${MATERIAL_DATE})\\b`,
  "i",
);
const EXPLICIT_ORGANIZATION_OWNER =
  /^(?:(?:[Tt]he\s+)?(?:[A-Z][A-Za-z0-9&.'’-]*\s+){0,5}(?:Agency|Institute|University|Department|Commission|Administration|Company|Laboratory|Lab))\b/;
const EXPLICIT_EVENT_OBJECT_OWNER =
  /^(?:(?:(?:[Tt]he|[Aa]n?|[Aa]nother)\s+)(?:[A-Za-z0-9&.'’-]+\s+){0,5}(?:act|bill|policy|rule|standard|framework|guidance|order|program|initiative|fund|round|assistant|app|tool|service|product|model|benchmark)|(?:[A-Z][A-Za-z0-9&.'’-]*\s+){0,5}(?:Act|Bill|Policy|Rule|Standard|Framework|Guidance|Order|Program|Initiative|Fund|Round|Assistant|App|Tool|Service|Product|Model|Benchmark))\b/;

const SENTENCE_BOUNDARY = /(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z])/;
const LEADING_DISCOURSE_MARKER =
  /^(?:however|meanwhile|therefore|also|additionally|moreover|finally)\s*,?\s*/i;
const LEADING_CLAUSE_MARKER = /^(?:after|before|because|while|whereas|but)\b\s*/i;
const PRONOUN_SUBJECT = /^(?:it|this|that|they|these|those|he|she)\b/i;
const EVENT_PREDICATE_IN_OBJECT =
  /\b(?:proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|announces?|announced|updates?|updated)\b/i;
const EVENT_OBJECT_IN_HEADLINE_SUBJECT =
  /\b(?:act|bill|rule|standard|framework|guidance|order|program|initiative|fund|round|assistant|app|tool|service|product|model|benchmark)\b/i;

const PAST_TENSE_PREDICATES: Readonly<Record<string, EventPredicate>> = {
  propose: "proposed",
  proposes: "proposed",
  proposed: "proposed",
  introduce: "introduced",
  introduces: "introduced",
  introduced: "introduced",
  adopt: "adopted",
  adopts: "adopted",
  adopted: "adopted",
  approve: "approved",
  approves: "approved",
  approved: "approved",
  launch: "launched",
  launches: "launched",
  launched: "launched",
  release: "released",
  releases: "released",
  released: "released",
  unveil: "unveiled",
  unveils: "unveiled",
  unveiled: "unveiled",
  publish: "published",
  publishes: "published",
  published: "published",
  issue: "issued",
  issues: "issued",
  issued: "issued",
  announce: "announced",
  announces: "announced",
  announced: "announced",
  update: "updated",
  updates: "updated",
  updated: "updated",
};

interface CapturedEvent {
  subjectText: string;
  objectText: string;
  predicate: EventPredicate;
  organizationHeadline: boolean;
}

function normalizePredicate(predicate: string): EventPredicate | null {
  return PAST_TENSE_PREDICATES[predicate.toLocaleLowerCase("en-US")] ?? null;
}

function captureEvent(clauseText: string): CapturedEvent | null {
  const matchableClause = clauseText.replace(/[.!?]+$/, "").trim();

  for (const pattern of [
    PASSIVE_EVENT,
    HEADLINE_EVENT,
    ORGANIZATION_HEADLINE_EVENT,
    ACTIVE_EVENT,
  ]) {
    const match = pattern.exec(matchableClause);
    const groups = match?.groups;
    if (!groups?.subject || !groups.objectText || !groups.predicate) {
      continue;
    }

    const predicate = normalizePredicate(groups.predicate);
    if (!predicate) {
      continue;
    }

    return {
      subjectText: groups.subject.trim(),
      objectText: groups.objectText.trim(),
      predicate,
      organizationHeadline:
        pattern === ORGANIZATION_HEADLINE_EVENT,
    };
  }

  return null;
}

function reportingComplement(
  sentence: string,
  depth = 0,
): string | null {
  const match = REPORTING_COMPLEMENT.exec(sentence);
  if (!match || match.index === undefined) {
    return sentence;
  }
  if (depth >= MAX_COMPLEMENT_DEPTH) {
    return null;
  }

  return reportingComplement(sentence.slice(match.index + match[0].length), depth + 1);
}

function splitMaterialCoordination(candidate: string): string[] {
  const boundaries = [
    ...candidate.matchAll(MATERIAL_COORDINATION_BOUNDARY),
  ].filter((boundary) => {
    if (boundary.index === undefined) {
      return false;
    }

    const left = candidate.slice(0, boundary.index);
    const right = candidate
      .slice(boundary.index + boundary[0].length)
      .trim();

    if (
      !MATERIAL_PREDICATE.test(left) ||
      !MATERIAL_PREDICATE.test(right)
    ) {
      return false;
    }

    return PRONOUN_SUBJECT.test(right) ||
      EXPLICIT_ORGANIZATION_OWNER.test(right) ||
      EXPLICIT_EVENT_OBJECT_OWNER.test(right);
  });

  if (boundaries.length === 0) {
    return [candidate];
  }

  const candidates: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    candidates.push(candidate.slice(start, boundary.index));
    start = (boundary.index ?? 0) + boundary[0].length;
  }
  candidates.push(candidate.slice(start));
  return candidates;
}

function splitCandidates(sentence: string): string[] | null {
  const candidates = sentence
    .split(CLAUSE_BOUNDARY)
    .flatMap((candidate) =>
      EVENT_PREDICATE_BEFORE_COORDINATION.test(candidate)
        ? candidate.split(COORDINATED_EVENT_BOUNDARY)
        : [candidate],
    )
    .flatMap(splitMaterialCoordination)
    .map((candidate) => candidate.replace(LEADING_CLAUSE_MARKER, "").trim())
    .filter(Boolean);

  return candidates.length <= MAX_CLAUSES_PER_SENTENCE &&
    !candidates.some((candidate) =>
      UNSAFE_COORDINATED_EVENT.test(candidate),
    )
    ? candidates
    : null;
}

interface SegmentedClause {
  sourceField: SourceField;
  sentenceIndex: number;
  clauseIndex: number;
  text: string;
}

function segmentedClauses(
  text: EventTextFields,
): SegmentedClause[] {
  const segmented: SegmentedClause[] = [];
  const fields: ReadonlyArray<
    readonly [SourceField, string | null | undefined]
  > = [
    ["title", text.title],
    ["abstract", text.abstract],
    ["content", text.content],
  ];

  for (const [sourceField, value] of fields) {
    if (!value?.trim()) {
      continue;
    }

    const sentences = value.split(SENTENCE_BOUNDARY);
    for (const [sentenceIndex, sourceSentence] of sentences.entries()) {
      const sentence = sourceSentence
        .replace(LEADING_DISCOURSE_MARKER, "")
        .trim();
      if (!sentence) {
        continue;
      }

      const clauses = splitCandidates(sentence);
      if (!clauses) {
        continue;
      }

      for (const [clauseIndex, clauseText] of clauses.entries()) {
        const complement = reportingComplement(clauseText);
        if (!complement) {
          continue;
        }
        segmented.push({
          sourceField,
          sentenceIndex,
          clauseIndex,
          text: complement,
        });
      }
    }
  }

  return segmented;
}

function parseCandidate(
  clauseText: string,
  sourceField: SourceField,
  sentenceIndex: number,
  clauseIndex: number,
  eventFamilies: readonly string[],
  semantics: EventClauseSemantics,
): ParsedEventClause | null {
  const captured = captureEvent(clauseText);
  if (!captured || PRONOUN_SUBJECT.test(captured.subjectText)) {
    return null;
  }
  if (
    captured.organizationHeadline &&
    EVENT_OBJECT_IN_HEADLINE_SUBJECT.test(captured.subjectText)
  ) {
    return null;
  }
  if (EVENT_PREDICATE_IN_OBJECT.test(captured.objectText)) {
    return null;
  }

  const subject = semantics.canonicalSubject(captured.subjectText);
  if (!subject) {
    return null;
  }

  const candidates = semantics.eventObjects(
    captured.objectText,
    eventFamilies,
    subject,
  );
  if (candidates.length !== 1) {
    return null;
  }

  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }
  const eventInstance: CanonicalEventInstance = {
    subject,
    domain: candidate.domain,
    object: candidate.object,
  };

  return {
    sourceField,
    sentenceIndex,
    clauseIndex,
    text: clauseText,
    predicate: captured.predicate,
    subject,
    domain: candidate.domain,
    object: candidate.object,
    facts: [...semantics.materialFacts(clauseText, eventInstance)],
  };
}

export function parseEventClauses(input: {
  text: EventTextFields;
  eventFamilies: readonly string[];
  semantics: EventClauseSemantics;
}): ParsedEventClause[] {
  const parsed: ParsedEventClause[] = [];
  for (const clause of segmentedClauses(input.text)) {
    const candidate = parseCandidate(
      clause.text,
      clause.sourceField,
      clause.sentenceIndex,
      clause.clauseIndex,
      input.eventFamilies,
      input.semantics,
    );
    if (candidate) {
      parsed.push(candidate);
    }
  }

  return parsed;
}

export function parseEventFactClauses(input: {
  text: EventTextFields;
  eventFamilies: readonly string[];
  eventInstance: CanonicalEventInstance;
  semantics: EventClauseSemantics;
}): ParsedEventFactClause[] {
  const parsed: ParsedEventFactClause[] = [];

  for (const clause of segmentedClauses(input.text)) {
    if (PRONOUN_SUBJECT.test(clause.text.trim())) {
      continue;
    }

    const candidates = input.semantics.eventObjects(
      clause.text,
      input.eventFamilies,
      input.eventInstance.subject,
    );
    if (candidates.length !== 1) {
      continue;
    }

    const candidate = candidates[0];
    if (
      candidate === undefined ||
      candidate.domain !== input.eventInstance.domain ||
      candidate.object !== input.eventInstance.object
    ) {
      continue;
    }

    const facts = [
      ...input.semantics.materialFacts(
        clause.text,
        input.eventInstance,
      ),
    ];
    if (facts.length === 0) {
      continue;
    }

    parsed.push({
      sourceField: clause.sourceField,
      sentenceIndex: clause.sentenceIndex,
      clauseIndex: clause.clauseIndex,
      text: clause.text,
      domain: candidate.domain,
      object: candidate.object,
      facts,
    });
  }

  return parsed;
}
