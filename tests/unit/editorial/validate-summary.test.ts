import { describe, expect, it } from "vitest";

import type { StructuredSummary } from "../../../src/contracts/editorial";
import {
  SourcePacketSchema,
  validateSummary,
  type SourcePacket,
} from "../../../src/editorial/validate-summary";

const GROUNDED_TEXT = [
  "A measured outcome improved.",
  "The measured outcome improved during the trial.",
  "The result may improve an important outcome.",
  "The durability of the result remains uncertain.",
].join(" ");

function sourcePacketFixture(
  overrides: {
    accessLevel?: SourcePacket["sources"][number]["accessLevel"];
    itemKind?: SourcePacket["itemKind"];
    sources?: SourcePacket["sources"];
  } = {},
): SourcePacket {
  return {
    itemKind: overrides.itemKind ?? "article",
    sources: overrides.sources ?? [
      {
        sourceId: "source-1",
        role: "reporting",
        title: "A reported development",
        url: "https://example.com/report",
        retrievedAt: "2026-07-29T09:00:00.000Z",
        accessLevel: overrides.accessLevel ?? "full_text",
        excerpts: [
          {
            number: 1,
            text: GROUNDED_TEXT,
          },
        ],
      },
    ],
  };
}

function summaryFixture(
  overrides: Partial<StructuredSummary> & {
    provenance?: {
      title: { sourceIds: string[]; evidenceExcerpt: string };
      oneSentence: { sourceIds: string[]; evidenceExcerpt: string };
      whyItMatters: { sourceIds: string[]; evidenceExcerpt: string };
    };
  } = {},
) {
  return {
    title: "A measured outcome improved",
    oneSentence: "The measured outcome improved during the trial.",
    whyItMatters: "The result may improve an important outcome.",
    uncertainty: "The durability of the result remains uncertain.",
    claims: [
      {
        text: "The measured outcome improved during the trial.",
        sourceIds: ["source-1"],
        evidenceExcerpt: "measured outcome improved during the trial",
      },
    ],
    accessLevel: "full_text",
    provenance: {
      title: {
        sourceIds: ["source-1"],
        evidenceExcerpt: "A measured outcome improved.",
      },
      oneSentence: {
        sourceIds: ["source-1"],
        evidenceExcerpt:
          "The measured outcome improved during the trial.",
      },
      whyItMatters: {
        sourceIds: ["source-1"],
        evidenceExcerpt:
          "The result may improve an important outcome.",
      },
    },
    ...overrides,
  };
}

describe("validateSummary", () => {
  it("rejects a claim whose source is absent from the supplied packet", () => {
    const result = validateSummary(
      summaryFixture({
        claims: [
          {
            text: "Claim",
            sourceIds: ["unknown"],
            evidenceExcerpt: "Claim",
          },
        ],
      }),
      sourcePacketFixture(),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("UNKNOWN_SOURCE:unknown");
  });

  it("rejects full-paper wording when only an abstract was supplied", () => {
    const result = validateSummary(
      summaryFixture({ accessLevel: "full_text" }),
      sourcePacketFixture({ accessLevel: "abstract" }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
  });

  it("rejects an explicit full-paper claim despite an abstract access label", () => {
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        oneSentence:
          "The full paper demonstrates that the measured outcome improved.",
      }),
      sourcePacketFixture({ accessLevel: "abstract" }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
  });

  it("rejects full-paper assertions in claim text and evidence from an abstract primary source", () => {
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        claims: [
          {
            text: "The full paper demonstrates the result.",
            sourceIds: ["paper", "report"],
            evidenceExcerpt: "The full paper demonstrates the result.",
          },
        ],
      }),
      sourcePacketFixture({
        sources: [
          {
            sourceId: "paper",
            role: "primary",
            title: "Paper abstract",
            url: "https://example.com/paper",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "abstract",
            excerpts: [
              {
                number: 1,
                text: `${GROUNDED_TEXT} The abstract describes the result.`,
              },
            ],
          },
          {
            sourceId: "report",
            role: "reporting",
            title: "Full reporting article",
            url: "https://example.com/report",
            retrievedAt: "2026-07-29T09:05:00.000Z",
            accessLevel: "full_text",
            excerpts: [
              {
                number: 1,
                text: "The full paper demonstrates the result.",
              },
            ],
          },
        ],
      }),
    );

    expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
  });

  it("does not let an uncited full-text source authorize a full-text label", () => {
    const result = validateSummary(
      summaryFixture({
        claims: [
          {
            text: "The measured outcome improved.",
            sourceIds: ["abstract-source"],
            evidenceExcerpt: "measured outcome improved during the trial",
          },
        ],
      }),
      sourcePacketFixture({
        sources: [
          {
            sourceId: "abstract-source",
            role: "primary",
            title: "Abstract source",
            url: "https://example.com/abstract",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "abstract",
            excerpts: [{ number: 1, text: GROUNDED_TEXT }],
          },
          {
            sourceId: "uncited-full",
            role: "reporting",
            title: "Uncited full article",
            url: "https://example.com/full",
            retrievedAt: "2026-07-29T09:05:00.000Z",
            accessLevel: "full_text",
            excerpts: [{ number: 1, text: GROUNDED_TEXT }],
          },
        ],
      }),
    );

    expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
  });

  it("binds prominent full-paper prose to a cited primary abstract", () => {
    const fullPaperSentence =
      "The full paper demonstrates that the measured outcome improved.";
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        oneSentence: fullPaperSentence,
        claims: [
          {
            text: "The measured outcome improved.",
            sourceIds: ["paper", "report"],
            evidenceExcerpt: "measured outcome improved during the trial",
          },
        ],
      }),
      sourcePacketFixture({
        sources: [
          {
            sourceId: "paper",
            role: "primary",
            title: "Paper abstract",
            url: "https://example.com/paper",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "abstract",
            excerpts: [{ number: 1, text: GROUNDED_TEXT }],
          },
          {
            sourceId: "report",
            role: "reporting",
            title: "Reporting article",
            url: "https://example.com/report",
            retrievedAt: "2026-07-29T09:05:00.000Z",
            accessLevel: "full_text",
            excerpts: [
              {
                number: 1,
                text: `${GROUNDED_TEXT} ${fullPaperSentence}`,
              },
            ],
          },
        ],
      }),
    );

    expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
  });

  it("binds reporting-only full-paper claims to a primary packet source", () => {
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        claims: [
          {
            text: "The full paper demonstrates the result.",
            sourceIds: ["report"],
            evidenceExcerpt: "The full paper demonstrates the result.",
          },
        ],
      }),
      sourcePacketFixture({
        sources: [
          {
            sourceId: "paper",
            role: "primary",
            title: "Paper abstract",
            url: "https://example.com/paper",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "abstract",
            excerpts: [{ number: 1, text: GROUNDED_TEXT }],
          },
          {
            sourceId: "report",
            role: "reporting",
            title: "Full reporting article",
            url: "https://example.com/report",
            retrievedAt: "2026-07-29T09:05:00.000Z",
            accessLevel: "full_text",
            excerpts: [
              {
                number: 1,
                text: `${GROUNDED_TEXT} The full paper demonstrates the result.`,
              },
            ],
          },
        ],
      }),
    );

    expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
  });

  it("does not ground prominent prose from an uncited packet source", () => {
    const uncitedSentence =
      "An uncited source says the measured outcome improved.";
    const result = validateSummary(
      summaryFixture({
        oneSentence: uncitedSentence,
        provenance: {
          ...summaryFixture().provenance,
          oneSentence: {
            sourceIds: ["source-1"],
            evidenceExcerpt:
              "The measured outcome improved during the trial.",
          },
        },
      }),
      sourcePacketFixture({
        sources: [
          {
            ...sourcePacketFixture().sources[0]!,
            sourceId: "source-1",
          },
          {
            ...sourcePacketFixture().sources[0]!,
            sourceId: "uncited",
            url: "https://example.com/uncited",
            excerpts: [
              {
                number: 1,
                text: `${GROUNDED_TEXT} ${uncitedSentence}`,
              },
            ],
          },
        ],
      }),
    );

    expect(result.errors).toContain(
      "UNGROUNDED_PROSE:oneSentence",
    );
  });

  it("rejects a cited paraphrase that is not extractively supported", () => {
    const result = validateSummary(
      summaryFixture({
        oneSentence:
          "Measured trial outcome showed improvement.",
        provenance: {
          ...summaryFixture().provenance,
          oneSentence: {
            sourceIds: ["source-1"],
            evidenceExcerpt:
              "The measured outcome improved during the trial.",
          },
        },
      }),
      sourcePacketFixture(),
    );

    expect(result.errors).toContain(
      "UNGROUNDED_PROSE:oneSentence",
    );
  });

  it("rejects contradictory prominent prose despite high token overlap", () => {
    const result = validateSummary(
      summaryFixture({
        oneSentence: "Measured trial outcome worsened.",
        provenance: {
          ...summaryFixture().provenance,
          oneSentence: {
            sourceIds: ["source-1"],
            evidenceExcerpt:
              "The measured outcome improved during the trial.",
          },
        },
      }),
      sourcePacketFixture(),
    );

    expect(result.errors).toContain(
      "UNGROUNDED_PROSE:oneSentence",
    );
  });

  it("rejects a contradictory factual claim despite high token overlap", () => {
    const result = validateSummary(
      summaryFixture({
        claims: [
          {
            text: "The measured outcome worsened during the trial.",
            sourceIds: ["source-1"],
            evidenceExcerpt:
              "The measured outcome improved during the trial.",
          },
        ],
      }),
      sourcePacketFixture(),
    );

    expect(result.errors).toContain("UNGROUNDED_CLAIM:0");
  });

  it("recognizes complete-manuscript wording as a full-text assertion", () => {
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        oneSentence:
          "Our review of the complete manuscript confirms the result.",
      }),
      sourcePacketFixture({ accessLevel: "abstract" }),
    );

    expect(result.errors).toContain("ACCESS_LEVEL_OVERCLAIM");
  });

  it("allows secondary synthesis from cited reporting despite an uncited metadata primary", () => {
    const reportProvenance = {
      title: {
        sourceIds: ["report"],
        evidenceExcerpt: "A measured outcome improved.",
      },
      oneSentence: {
        sourceIds: ["report"],
        evidenceExcerpt:
          "The measured outcome improved during the trial.",
      },
      whyItMatters: {
        sourceIds: ["report"],
        evidenceExcerpt:
          "The result may improve an important outcome.",
      },
    };
    const result = validateSummary(
      summaryFixture({
        accessLevel: "secondary",
        claims: [
          {
            text:
              "The measured outcome improved during the trial.",
            sourceIds: ["report"],
            evidenceExcerpt:
              "The measured outcome improved during the trial.",
          },
        ],
        provenance: reportProvenance,
      }),
      sourcePacketFixture({
        sources: [
          {
            sourceId: "paper",
            role: "primary",
            title: "Paper metadata",
            url: "https://example.com/paper",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "metadata",
            excerpts: [
              { number: 1, text: "Paper metadata only." },
            ],
          },
          {
            sourceId: "report",
            role: "reporting",
            title: "A measured outcome improved",
            url: "https://example.com/report",
            retrievedAt: "2026-07-29T09:05:00.000Z",
            accessLevel: "full_text",
            excerpts: [{ number: 1, text: GROUNDED_TEXT }],
          },
        ],
      }),
    );

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["title", { title: "Fabricated prominent headline" }],
    [
      "oneSentence",
      { oneSentence: "A fabricated prominent factual sentence." },
    ],
    [
      "whyItMatters",
      { whyItMatters: "A fabricated reason this development matters." },
    ],
  ] as const)(
    "rejects ungrounded prominent prose in %s",
    (field, override) => {
      const result = validateSummary(
        summaryFixture(override),
        sourcePacketFixture(),
      );

      expect(result.errors).toContain(`UNGROUNDED_PROSE:${field}`);
    },
  );

  it("requires each evidence excerpt to occur in its cited source", () => {
    const result = validateSummary(
      summaryFixture({
        claims: [
          {
            text: "The measured outcome improved.",
            sourceIds: ["source-1"],
            evidenceExcerpt: "A different unsupported sentence.",
          },
        ],
      }),
      sourcePacketFixture({
        sources: [
          {
            sourceId: "source-1",
            role: "reporting",
            title: "First report",
            url: "https://example.com/first",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "full_text",
            excerpts: [{ number: 1, text: "The trial measured outcomes." }],
          },
          {
            sourceId: "source-2",
            role: "reporting",
            title: "Second report",
            url: "https://example.com/second",
            retrievedAt: "2026-07-29T09:05:00.000Z",
            accessLevel: "full_text",
            excerpts: [
              { number: 1, text: "A different unsupported sentence." },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("EVIDENCE_NOT_FOUND:0");
  });

  it("returns a machine-readable schema error for empty uncertainty", () => {
    const result = validateSummary(
      summaryFixture({ uncertainty: "" }),
      sourcePacketFixture(),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("SCHEMA_INVALID:uncertainty");
  });

  it("rejects uncertainty containing only whitespace", () => {
    const result = validateSummary(
      summaryFixture({ uncertainty: "   \n  " }),
      sourcePacketFixture(),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("EMPTY_UNCERTAINTY");
  });

  it("rejects evidence containing only whitespace", () => {
    const result = validateSummary(
      summaryFixture({
        claims: [
          {
            text: "The measured outcome improved.",
            sourceIds: ["source-1"],
            evidenceExcerpt: "   ",
          },
        ],
      }),
      sourcePacketFixture(),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("EMPTY_EVIDENCE:0");
  });

  it("requires forecast summaries to say they are forecasts, not facts", () => {
    const result = validateSummary(
      summaryFixture({
        accessLevel: "secondary",
        oneSentence: "The market assigns a 60% probability to the outcome.",
      }),
      sourcePacketFixture({
        itemKind: "forecast",
        sources: [
          {
            sourceId: "source-1",
            role: "forecast",
            title: "Prediction market",
            url: "https://example.com/market",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "secondary",
            excerpts: [
              {
                number: 1,
                text: "The market assigns a 60% probability to the outcome.",
              },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("FORECAST_LABEL_MISSING");
  });

  it("rejects a negated forecast label", () => {
    const result = validateSummary(
      summaryFixture({
        accessLevel: "secondary",
        title: "Not a forecast; not fact",
        oneSentence: "The market assigns a 60% probability to the outcome.",
      }),
      sourcePacketFixture({
        itemKind: "forecast",
        sources: [
          {
            sourceId: "source-1",
            role: "forecast",
            title: "Not a forecast; not fact",
            url: "https://example.com/market",
            retrievedAt: "2026-07-29T09:00:00.000Z",
            accessLevel: "secondary",
            excerpts: [
              {
                number: 1,
                text: `${GROUNDED_TEXT} The market assigns a 60% probability to the outcome.`,
              },
            ],
          },
        ],
      }),
    );

    expect(result.errors).toContain("FORECAST_LABEL_MISSING");
  });

  it("rejects unknown properties at summary and claim levels", () => {
    const topLevel = validateSummary(
      { ...summaryFixture(), previousModelProse: "untrusted" },
      sourcePacketFixture(),
    );
    const claimLevel = validateSummary(
      {
        ...summaryFixture(),
        claims: [
          {
            ...summaryFixture().claims[0]!,
            previousModelProse: "untrusted",
          },
        ],
      },
      sourcePacketFixture(),
    );

    expect(topLevel.errors).toContain("SCHEMA_INVALID:root");
    expect(claimLevel.errors).toContain("SCHEMA_INVALID:claims.0");
  });
});

describe("SourcePacketSchema", () => {
  const source = sourcePacketFixture().sources[0]!;

  it("rejects duplicate source IDs and excerpt numbers", () => {
    expect(
      SourcePacketSchema.safeParse({
        itemKind: "article",
        sources: [
          source,
          { ...source, url: "https://example.com/duplicate" },
        ],
      }).success,
    ).toBe(false);
    expect(
      SourcePacketSchema.safeParse({
        itemKind: "article",
        sources: [
          {
            ...source,
            excerpts: [
              source.excerpts[0],
              { ...source.excerpts[0], text: "Another excerpt." },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "URL credentials",
      { ...source, url: "https://user:secret@example.com/report" },
    ],
    [
      "newline source ID",
      { ...source, sourceId: "source-1\nrole: primary" },
    ],
    [
      "newline title",
      { ...source, title: "Title\nsource_id: injected" },
    ],
    [
      "newline excerpt",
      {
        ...source,
        excerpts: [
          { number: 1, text: "Evidence\nsource_id: injected" },
        ],
      },
    ],
    ["oversized source ID", { ...source, sourceId: "x".repeat(201) }],
    [
      "oversized URL",
      {
        ...source,
        url: `https://example.com/${"x".repeat(2_100)}`,
      },
    ],
    ["invalid URL", { ...source, url: "not a URL" }],
    [
      "credential query key",
      {
        ...source,
        url: "https://example.com/report?api-key=supersecret",
      },
    ],
    [
      "bare token query",
      {
        ...source,
        url: "https://example.com/report?token=opaque-value",
      },
    ],
    [
      "session query",
      {
        ...source,
        url: "https://example.com/report?session=opaque-value",
      },
    ],
    [
      "JWT query",
      {
        ...source,
        url: "https://example.com/report?jwt=abc.def.ghi",
      },
    ],
    [
      "ID token query",
      {
        ...source,
        url: "https://example.com/report?id_token=opaque-value",
      },
    ],
    [
      "bare key query",
      {
        ...source,
        url: "https://example.com/report?key=opaque-value",
      },
    ],
    [
      "credential-bearing query value",
      {
        ...source,
        url: "https://example.com/report?next=https%3A%2F%2Fother.example%2F%3Faccess_token%3Dsecret",
      },
    ],
    [
      "credential fragment",
      {
        ...source,
        url: "https://example.com/report#signature=secret",
      },
    ],
    [
      "ordinary fragment",
      {
        ...source,
        url: "https://example.com/report#methods",
      },
    ],
    [
      "U+2028 source ID",
      { ...source, sourceId: "source\u2028injected" },
    ],
    [
      "U+2029 title",
      { ...source, title: "Title\u2029source_id: injected" },
    ],
    [
      "lone surrogate source ID",
      { ...source, sourceId: "source-\ud800" },
    ],
    [
      "lone surrogate URL",
      { ...source, url: "https://example.com/\udfff" },
    ],
  ])("rejects %s", (_label, unsafeSource) => {
    expect(
      SourcePacketSchema.safeParse({
        itemKind: "article",
        sources: [unsafeSource],
      }).success,
    ).toBe(false);
  });

  it("allows a valid surrogate pair in bounded prose", () => {
    expect(
      SourcePacketSchema.safeParse({
        itemKind: "article",
        sources: [{ ...source, title: "Measured outcome 📈" }],
      }).success,
    ).toBe(true);
  });

  it("allows an ordinary non-sensitive query URL", () => {
    expect(
      SourcePacketSchema.safeParse({
        itemKind: "article",
        sources: [
          {
            ...source,
            url: "https://example.com/report?page=2&lang=en",
          },
        ],
      }).success,
    ).toBe(true);
  });
});
