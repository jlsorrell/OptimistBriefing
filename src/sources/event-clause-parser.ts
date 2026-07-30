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
  /^(?<subject>.+?(?:Agency|Institute|University|Department|Commission|Administration|Company|Laboratory|Lab))\s+(?<objectText>.+?)\s+(?<predicate>proposed|introduced|adopted|approved|launched|released|unveiled|published|issued|announced|updated)\b.*$/i;

const REPORTING_COMPLEMENT =
  /\b(?:says?|said|reports?|reported|details?|detailed|confirms?|confirmed|announces?|announced)\s+that\s+/i;

const CLAUSE_BOUNDARY =
  /;\s*|,\s*(?=(?:after|before|because|while|whereas|but)\b)|\s+(?=(?:after|before|because|while|whereas|but)\b)/i;

const SENTENCE_BOUNDARY = /(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z])/;
const LEADING_DISCOURSE_MARKER =
  /^(?:however|meanwhile|therefore|also|additionally|moreover|finally)\s*,?\s*/i;
const LEADING_CLAUSE_MARKER = /^(?:after|before|because|while|whereas|but)\b\s*/i;
const PRONOUN_SUBJECT = /^(?:it|this|that|they|these|those|he|she)\b/i;
const EVENT_PREDICATE_IN_OBJECT =
  /\b(?:proposes?|proposed|introduces?|introduced|adopts?|adopted|approves?|approved|launches?|launched|releases?|released|unveils?|unveiled|publishes?|published|issues?|issued|announces?|announced|updates?|updated)\b/i;

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

function splitCandidates(sentence: string): string[] | null {
  const candidates = sentence
    .split(CLAUSE_BOUNDARY)
    .map((candidate) => candidate.replace(LEADING_CLAUSE_MARKER, "").trim())
    .filter(Boolean);

  return candidates.length <= MAX_CLAUSES_PER_SENTENCE ? candidates : null;
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

      const complement = reportingComplement(sentence);
      if (!complement) {
        continue;
      }
      const clauses = splitCandidates(complement);
      if (!clauses) {
        continue;
      }

      for (const [clauseIndex, clauseText] of clauses.entries()) {
        segmented.push({
          sourceField,
          sentenceIndex,
          clauseIndex,
          text: clauseText,
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
