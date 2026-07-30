import { describe, expect, it } from "vitest";

import {
  parseEventClauses,
  parseEventFactClauses,
  type EventClauseSemantics,
} from "../../../src/sources/event-clause-parser";

const semantics: EventClauseSemantics = {
  canonicalSubject(subjectText) {
    const match =
      /(Evaluation Agency|Model Institute|Funding Agency)/i.exec(subjectText);
    return match?.[1]
      ?.toLocaleLowerCase("en-US")
      .replace(/\s+/g, "-") ?? null;
  },
  eventObjects(objectText) {
    const candidates = [
      ["frontier-evaluation-standard", "governance-event", /Frontier Evaluation Standard/i],
      ["community-research-program", "funding-event", /Community Research Program/i],
    ] as const;
    return candidates.flatMap(([object, domain, pattern]) =>
      pattern.test(objectText) ? [{ object, domain }] : [],
    );
  },
  materialFacts(clauseText) {
    return /takes effect July 1, 2027/i.test(clauseText)
      ? [{
          kind: "date" as const,
          key: "effective-date",
          value: "2027-07-01",
        }]
      : [];
  },
};

describe("parseEventClauses", () => {
  it("parses an organization-led headline with an explicit actor and object", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Evaluation Agency Frontier Evaluation Standard adopted",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toMatchObject([{
      predicate: "adopted",
      subject: "evaluation-agency",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
  });

  it("parses an object-led passive headline without an auxiliary", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Frontier Evaluation Standard adopted by Evaluation Agency",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toMatchObject([{
      predicate: "adopted",
      subject: "evaluation-agency",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
  });

  it("extracts facts from a clause that names the exact resolved object", () => {
    const parsed = parseEventFactClauses({
      text: {
        title:
          "Frontier Evaluation Standard takes effect July 1, 2027",
      },
      eventFamilies: ["evaluation-standards"],
      eventInstance: {
        subject: "model-institute",
        domain: "governance-event",
        object: "frontier-evaluation-standard",
      },
      semantics,
    });

    expect(parsed).toEqual([{
      sourceField: "title",
      sentenceIndex: 0,
      clauseIndex: 0,
      text:
        "Frontier Evaluation Standard takes effect July 1, 2027",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
      facts: [{
        kind: "date",
        key: "effective-date",
        value: "2027-07-01",
      }],
    }]);
  });

  it.each([
    "It takes effect July 1, 2027",
    "The policy takes effect July 1, 2027",
    "Community Research Program takes effect July 1, 2027",
  ])("rejects a non-exact fact reference: %s", (title) => {
    const parsed = parseEventFactClauses({
      text: { title },
      eventFamilies: ["evaluation-standards", "funding-budget"],
      eventInstance: {
        subject: "model-institute",
        domain: "governance-event",
        object: "frontier-evaluation-standard",
      },
      semantics,
    });

    expect(parsed).toEqual([]);
  });

  it.each([
    [
      "Model Institute adopted Frontier Evaluation Standard",
      "model-institute",
    ],
    [
      "Frontier Evaluation Standard was adopted by Model Institute",
      "model-institute",
    ],
    [
      "Model Institute: Frontier Evaluation Standard adopted",
      "model-institute",
    ],
  ])("parses a supported construction: %s", (title, subject) => {
    const parsed = parseEventClauses({
      text: { title },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toMatchObject([{
      sourceField: "title",
      sentenceIndex: 0,
      clauseIndex: 0,
      predicate: "adopted",
      subject,
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
  });

  it("keeps title, abstract, and content provenance separate", () => {
    const parsed = parseEventClauses({
      text: {
        title: "Model Institute adopted Frontier Evaluation Standard.",
        abstract: "Model Institute adopted Frontier Evaluation Standard.",
        content: "Model Institute adopted Frontier Evaluation Standard.",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed.map(({ sourceField }) => sourceField)).toEqual([
      "title",
      "abstract",
      "content",
    ]);
  });

  it.each([
    "Frontier Evaluation Standard was adopted by Model Institute.",
    "Model Institute: Frontier Evaluation Standard adopted.",
  ])("parses a supported construction with terminal punctuation: %s", (title) => {
    const parsed = parseEventClauses({
      text: { title },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toMatchObject([{
      predicate: "adopted",
      subject: "model-institute",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
  });

  it("uses the explicit subject inside a reporting complement", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Evaluation Agency announced that Model Institute adopted Frontier Evaluation Standard",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toMatchObject([{
      predicate: "adopted",
      subject: "model-institute",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
  });

  it.each(["after", "before", "because", "while", "whereas", "but"])(
    "does not leak an event or fact across %s",
    (boundary) => {
      const parsed = parseEventClauses({
        text: {
          title:
            `Frontier Evaluation Standard was discussed ${boundary} ` +
            "another policy was adopted and takes effect July 1, 2027",
        },
        eventFamilies: ["evaluation-standards"],
        semantics,
      });

      expect(parsed).toEqual([]);
    },
  );

  it("keeps a same-clause material fact with its event", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Model Institute adopted Frontier Evaluation Standard, " +
          "which takes effect July 1, 2027",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed[0]?.facts).toEqual([{
      kind: "date",
      key: "effective-date",
      value: "2027-07-01",
    }]);
  });

  it("returns no record when one clause has multiple event objects", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Model Institute adopted Frontier Evaluation Standard and " +
          "launched Community Research Program",
      },
      eventFamilies: ["evaluation-standards", "funding-budget"],
      semantics,
    });

    expect(parsed).toEqual([]);
  });

  it("does not resolve a pronoun-led fact clause", () => {
    const parsed = parseEventClauses({
      text: {
        title: "Model Institute adopted Frontier Evaluation Standard.",
        abstract: "It takes effect July 1, 2027.",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed[0]?.facts).toEqual([]);
  });

  it("fails open when reporting complements exceed three levels", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Evaluation Agency announced that Model Institute reported that " +
          "Evaluation Agency said that Model Institute announced that " +
          "Evaluation Agency adopted Frontier Evaluation Standard",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toEqual([]);
  });
});
