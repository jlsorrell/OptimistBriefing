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
