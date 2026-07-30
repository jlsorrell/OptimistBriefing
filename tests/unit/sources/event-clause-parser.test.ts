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

const materialStatusSemantics: EventClauseSemantics = {
  ...semantics,
  materialFacts(clauseText) {
    const status =
      /\b(adopted|delayed|postponed|blocked|rejected|withdrawn|repealed)\b/i
        .exec(clauseText)?.[1]
        ?.toLocaleLowerCase("en-US");

    return [
      ...(status
        ? [{
            kind: "status" as const,
            key: "event-status",
            value: status,
          }]
        : []),
      ...(/takes effect July 1, 2027/i.test(clauseText)
        ? [{
            kind: "date" as const,
            key: "effective-date",
            value: "2027-07-01",
          }]
        : []),
    ];
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

  it("allows an enumerated count suffix on an organization-led headline", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Evaluation Agency Frontier Evaluation Standard adopted " +
          "for 100 models",
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

  it("rejects a trailing event after an organization-led headline", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Evaluation Agency Frontier Evaluation Standard adopted as " +
          "Funding Agency launched Community Research Program",
      },
      eventFamilies: ["evaluation-standards", "funding-budget"],
      semantics,
    });

    expect(parsed).toEqual([]);
  });

  it("rejects a reordered organization-led headline", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Frontier Evaluation Standard Evaluation Agency " +
          "Community Research Program adopted",
      },
      eventFamilies: ["evaluation-standards", "funding-budget"],
      semantics,
    });

    expect(parsed).toEqual([]);
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
    "delayed",
    "postponed",
    "blocked",
    "rejected",
    "withdrawn",
    "repealed",
  ])(
    "isolates an unrelated %s status from an exact-object date",
    (status) => {
      const parsed = parseEventFactClauses({
        text: {
          title:
            `Another policy was ${status}, and ` +
            "Frontier Evaluation Standard takes effect July 1, 2027",
        },
        eventFamilies: ["evaluation-standards"],
        eventInstance: {
          subject: "model-institute",
          domain: "governance-event",
          object: "frontier-evaluation-standard",
        },
        semantics: materialStatusSemantics,
      });

      expect(parsed.flatMap(({ facts }) => facts)).toEqual([{
        kind: "date",
        key: "effective-date",
        value: "2027-07-01",
      }]);
    },
  );

  it("isolates an exact-object date from a later unrelated status", () => {
    const parsed = parseEventFactClauses({
      text: {
        title:
          "Frontier Evaluation Standard takes effect July 1, 2027, and " +
          "another policy was blocked",
      },
      eventFamilies: ["evaluation-standards"],
      eventInstance: {
        subject: "model-institute",
        domain: "governance-event",
        object: "frontier-evaluation-standard",
      },
      semantics: materialStatusSemantics,
    });

    expect(parsed.flatMap(({ facts }) => facts)).toEqual([{
      kind: "date",
      key: "effective-date",
      value: "2027-07-01",
    }]);
  });

  it("drops a pronoun-led date after an exact-object status", () => {
    const parsed = parseEventFactClauses({
      text: {
        title:
          "Frontier Evaluation Standard was adopted, and " +
          "it takes effect July 1, 2027",
      },
      eventFamilies: ["evaluation-standards"],
      eventInstance: {
        subject: "model-institute",
        domain: "governance-event",
        object: "frontier-evaluation-standard",
      },
      semantics: materialStatusSemantics,
    });

    expect(parsed.flatMap(({ facts }) => facts)).toEqual([{
      kind: "status",
      key: "event-status",
      value: "adopted",
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

  it.each([
    [
      "a subordinate reporting complement",
      "Model Institute adopted Frontier Evaluation Standard after " +
        "Evaluation Agency announced that Funding Agency launched " +
        "Community Research Program",
    ],
    [
      "sibling reporting complements",
      "Evaluation Agency announced that Model Institute adopted " +
        "Frontier Evaluation Standard while Evaluation Agency announced " +
        "that Funding Agency launched Community Research Program",
    ],
  ])(
    "retains distinct event evidence across %s",
    (_construction, title) => {
      const parsed = parseEventClauses({
        text: { title },
        eventFamilies: ["evaluation-standards", "funding-budget"],
        semantics,
      });

      expect(parsed).toMatchObject([
        {
          subject: "model-institute",
          domain: "governance-event",
          object: "frontier-evaluation-standard",
        },
        {
          subject: "funding-agency",
          domain: "funding-event",
          object: "community-research-program",
        },
      ]);
    },
  );

  it("retains distinct event evidence across explicit actor coordination", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Model Institute adopted Frontier Evaluation Standard and " +
          "Funding Agency launched Community Research Program",
      },
      eventFamilies: ["evaluation-standards", "funding-budget"],
      semantics,
    });

    expect(parsed).toMatchObject([
      {
        subject: "model-institute",
        domain: "governance-event",
        object: "frontier-evaluation-standard",
      },
      {
        subject: "funding-agency",
        domain: "funding-event",
        object: "community-research-program",
      },
    ]);
  });

  it("rejects coordinated actors that share one event predicate", () => {
    const parsed = parseEventClauses({
      text: {
        title:
          "Evaluation Agency and Funding Agency adopted " +
          "Frontier Evaluation Standard",
      },
      eventFamilies: ["evaluation-standards"],
      semantics,
    });

    expect(parsed).toEqual([]);
  });

  it("rejects unsafe coordinated facts for an exact object", () => {
    const parsed = parseEventFactClauses({
      text: {
        title:
          "Frontier Evaluation Standard remains proposed and " +
          "Funding Agency adopted another policy and takes effect " +
          "July 1, 2027",
      },
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
