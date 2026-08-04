import { describe, expect, it } from "vitest";

import { deriveNewsSignals } from "../../../src/sources/news-signals";

function signals(input: {
  title: string;
  abstract?: string | null;
  content?: string | null;
}) {
  return deriveNewsSignals({
    kind: "article",
    title: input.title,
    ...(input.abstract === undefined
      ? {}
      : { abstract: input.abstract }),
    ...(input.content === undefined
      ? {}
      : { content: input.content }),
    originalUrl: "https://example.com/story",
    sectionEligibility: ["ai_policy"],
    metadata: { primarySection: "ai_policy" },
    preferredSection: "ai_policy",
  });
}

function primary(title: string, abstract?: string | null, content?: string | null) {
  return signals({
    title,
    ...(abstract === undefined ? {} : { abstract }),
    ...(content === undefined ? {} : { content }),
  }).metadata.primarySection;
}

describe("AI Policy evidence", () => {
  it.each([
    "National Center for Advancing Translational Sciences; Notice of Meeting",
    "Formations of, Acquisitions by, and Mergers of Bank Holding Companies",
    "Annual audit notice for regional health grants",
    "Acme launches an AI assistant product",
  ])("does not let preferredSection route %s into AI Policy", (title) => {
    expect(primary(title)).not.toBe("ai_policy");
  });

  it.each([
    "Senate bill requires frontier AI model evaluations",
    "AI training compute reporting obligation",
    "Secure foundation model evaluation standard",
    "Automated decision system procurement rule",
  ])("routes explicit policy evidence in %s to AI Policy", (title) => {
    expect(primary(title)).toBe("ai_policy");
  });
});

describe("news event clause integration", () => {
  it("binds an embedded event to the embedded subject", () => {
    const result = signals({
      title:
        "Evaluation Agency announced that Model Institute adopted " +
        "Frontier Evaluation Standard",
    });

    expect(result.eventInstances).toEqual([{
      subject: "model-institute",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
    expect(result.scopedMaterialFacts).toEqual([
      expect.objectContaining({
        kind: "status",
        key: "event-status",
        value: "adopted",
      }),
    ]);
  });

  it("does not attach a subordinate policy event or date to the standard", () => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        "Frontier Evaluation Standard was discussed after another policy " +
        "was adopted and takes effect July 1, 2026",
    });

    expect(result.eventInstances).toEqual([{
      subject: "evaluation-agency",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
    expect(result.scopedMaterialFacts).toEqual([
      expect.objectContaining({
        kind: "status",
        key: "event-status",
        value: "proposed",
      }),
    ]);
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "adopted" }),
        expect.objectContaining({ value: "2026-07-01" }),
      ]),
    );
  });

  it("keeps status, amount, and date facts in the exact funding clause", () => {
    const result = signals({
      title: "Funding Agency launches Community Research Program",
      abstract:
        "Funding Agency launched Community Research Program with $100 million " +
        "in funding, effective December 1, 2026",
      content:
        "Another program had $125 million in funding before it took effect July 1, 2027",
    });

    expect(result.scopedMaterialFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "status", value: "released" }),
        expect.objectContaining({ kind: "amount", value: "100000000" }),
        expect.objectContaining({ kind: "date", value: "2026-12-01" }),
      ]),
    );
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "125000000" }),
        expect.objectContaining({ value: "2027-07-01" }),
      ]),
    );
  });

  it("returns no canonical instance for conflicting text-derived events", () => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        "Model Institute adopted Model Transparency Rule",
    });

    expect(result.eventInstances).toEqual([]);
    expect(result.scopedMaterialFacts).toEqual([]);
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
    "fails open across distinct events in %s",
    (_construction, title) => {
      const result = signals({ title });

      expect(result.eventInstances).toEqual([]);
      expect(result.scopedMaterialFacts).toEqual([]);
    },
  );

  it("fails open when a repeated event is coordinated with a distinct actor", () => {
    const result = signals({
      title:
        "Model Institute adopted Frontier Evaluation Standard",
      content:
        "Model Institute adopted Frontier Evaluation Standard and " +
        "Funding Agency launched Community Research Program",
    });

    expect(result.eventInstances).toEqual([]);
    expect(result.scopedMaterialFacts).toEqual([]);
  });

  it("does not leak coordinated status or date facts to the exact object", () => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        "Frontier Evaluation Standard remains proposed and Funding Agency " +
        "adopted another policy and takes effect July 1, 2027",
    });

    expect(result.eventInstances).toEqual([{
      subject: "evaluation-agency",
      domain: "governance-event",
      object: "frontier-evaluation-standard",
    }]);
    expect(result.scopedMaterialFacts).toEqual([
      expect.objectContaining({
        kind: "status",
        value: "proposed",
      }),
    ]);
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "adopted" }),
        expect.objectContaining({ value: "2027-07-01" }),
      ]),
    );
  });

  it.each([
    "delayed",
    "postponed",
    "blocked",
    "rejected",
    "withdrawn",
    "repealed",
  ])(
    "does not leak coordinated %s status to the exact event object",
    (status) => {
      const result = signals({
        title:
          "Evaluation Agency proposes Frontier Evaluation Standard",
        abstract:
          `Another policy was ${status}, and ` +
          "Frontier Evaluation Standard takes effect July 1, 2027",
      });

      expect(result.scopedMaterialFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "proposed" }),
          expect.objectContaining({ value: "2027-07-01" }),
        ]),
      );
      expect(result.scopedMaterialFacts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "status",
            value:
              status === "postponed" ? "delayed" :
              status === "rejected" ? "blocked" :
              status === "repealed" ? "withdrawn" :
              status,
          }),
        ]),
      );
    },
  );

  it("preserves same-object adopted and effective facts", () => {
    const result = signals({
      title:
        "Evaluation Agency adopts Frontier Evaluation Standard",
      abstract:
        "Frontier Evaluation Standard was adopted and takes effect July 1, 2027",
    });

    expect(result.scopedMaterialFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "adopted" }),
        expect.objectContaining({ value: "2027-07-01" }),
      ]),
    );
  });

  it("does not resolve a pronoun-led coordinated fact clause", () => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        "Another policy was delayed, and it takes effect July 1, 2027",
    });

    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "2027-07-01" }),
      ]),
    );
  });

  it("keeps an exact-object status without a pronoun-led date", () => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        "Frontier Evaluation Standard was adopted, and " +
        "it takes effect July 1, 2027",
    });

    expect(result.scopedMaterialFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "proposed" }),
        expect.objectContaining({ value: "adopted" }),
      ]),
    );
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "2027-07-01" }),
      ]),
    );
  });

  it("fails open when an object name contains a predicate substring", () => {
    const result = signals({
      title:
        "Model Institute reviewed Unblocked Safety Rule and " +
        "Evaluation Agency adopted Frontier Evaluation Standard",
    });

    expect(result.eventInstances).toEqual([]);
    expect(result.scopedMaterialFacts).toEqual([]);
  });

  it.each(["issued", "announced", "updated"])(
    "preserves ambiguity across an unrelated %s action and exact-object date",
    (action) => {
      const result = signals({
        title:
          "Evaluation Agency proposes Frontier Evaluation Standard",
        abstract:
          `Model Institute ${action} Model Transparency Rule, and ` +
          "Frontier Evaluation Standard takes effect July 1, 2027",
      });

      expect(result.eventInstances).toEqual([]);
      expect(result.scopedMaterialFacts).toEqual([]);
    },
  );

  it.each([
    [
      "forward",
      "Another policy was delayed, and " +
        "Frontier Evaluation Standard must comply by July 1, 2027",
      "delayed",
    ],
    [
      "reverse",
      "Frontier Evaluation Standard must comply by July 1, 2027, and " +
        "another policy was blocked",
      "blocked",
    ],
  ])(
    "does not leak a status across a %s exact-object by-date deadline",
    (_order, abstract, status) => {
      const result = signals({
        title:
          "Evaluation Agency proposes Frontier Evaluation Standard",
        abstract,
      });

      expect(result.scopedMaterialFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "proposed" }),
          expect.objectContaining({
            kind: "date",
            key: "deadline-date",
            value: "2027-07-01",
          }),
        ]),
      );
      expect(result.scopedMaterialFacts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: status }),
        ]),
      );
    },
  );

  it("does not leak a status from lowercase the organization owner", () => {
    const result = signals({
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract:
        "Frontier Evaluation Standard takes effect July 1, 2027, and " +
        "the Evaluation Agency delayed implementation",
    });

    expect(result.scopedMaterialFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "proposed" }),
        expect.objectContaining({ value: "2027-07-01" }),
      ]),
    );
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "delayed" }),
      ]),
    );
  });

  it("fails open for a trailing event after an organization-led headline", () => {
    const result = signals({
      title:
        "Evaluation Agency Frontier Evaluation Standard adopted as " +
        "Funding Agency launched Community Research Program",
    });

    expect(result.eventInstances).toEqual([]);
    expect(result.scopedMaterialFacts).toEqual([]);
  });

  it("fails open for a reordered organization-led headline", () => {
    const result = signals({
      title:
        "Frontier Evaluation Standard Evaluation Agency " +
        "Community Research Program adopted",
    });

    expect(result.eventInstances).toEqual([]);
    expect(result.scopedMaterialFacts).toEqual([]);
  });

  it("accepts only explicitly scoped metadata for the resolved text event", () => {
    const result = deriveNewsSignals({
      kind: "article",
      title:
        "Evaluation Agency proposes Frontier Evaluation Standard",
      abstract: null,
      content: null,
      originalUrl: "https://example.com/scoped",
      sectionEligibility: ["ai_policy"],
      metadata: {
        primarySection: "ai_policy",
        materialFacts: [{
          kind: "status",
          key: "event-status",
          value: "adopted",
        }],
        scopedMaterialFacts: [{
          kind: "date",
          key: "deadline-date",
          value: "2026-12-01",
          eventInstance: {
            subject: "evaluation-agency",
            domain: "governance-event",
            object: "frontier-evaluation-standard",
          },
        }],
      },
      preferredSection: "ai_policy",
    });

    expect(result.scopedMaterialFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "proposed" }),
        expect.objectContaining({ value: "2026-12-01" }),
      ]),
    );
    expect(result.scopedMaterialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "adopted" }),
      ]),
    );
  });

  it("resolves the same unique tuple regardless of which field repeats it", () => {
    const titleOnly = signals({
      title:
        "Evaluation Agency adopts Frontier Evaluation Standard",
    });
    const repeatedInContent = signals({
      title:
        "Evaluation Agency adopts Frontier Evaluation Standard",
      content:
        "Evaluation Agency adopted Frontier Evaluation Standard",
    });

    expect(repeatedInContent.eventInstances).toEqual(
      titleOnly.eventInstances,
    );
  });
});
