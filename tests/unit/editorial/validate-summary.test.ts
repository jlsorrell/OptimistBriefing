import { describe, expect, it } from "vitest";

import type {
  Item,
  StructuredSummary,
} from "../../../src/contracts/editorial";
import {
  SourcePacketSchema,
  validateSummary,
  type SourcePacket,
} from "../../../src/editorial/validate-summary";
import { sourcePacketForItem } from "../../../src/workflow/source-packet";

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
    sources?: Array<
      Omit<
        SourcePacket["sources"][number],
        "sourceName" | "evidenceKind"
      > & Partial<Pick<
        SourcePacket["sources"][number],
        "sourceName" | "evidenceKind"
      >>
    >;
  } = {},
): SourcePacket {
  const sources = overrides.sources ?? [
    {
      sourceId: "source-1",
      sourceName: "Example News",
      evidenceKind: "news-evidence" as const,
      role: "reporting" as const,
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
  ];
  return {
    itemKind: overrides.itemKind ?? "article",
    sources: sources.map((source) => ({
      ...source,
      sourceName: source.sourceName ?? source.title,
      evidenceKind: source.evidenceKind ?? "news-evidence",
    })),
  };
}

function summaryFixture(
  overrides: Partial<StructuredSummary> & {
    provenance?: {
      title: { sourceIds: string[]; evidenceExcerpt: string };
      oneSentence: { sourceIds: string[]; evidenceExcerpt: string };
      whyItMatters: { sourceIds: string[]; evidenceExcerpt: string };
      uncertainty: { sourceIds: string[]; evidenceExcerpt: string };
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
      uncertainty: {
        sourceIds: ["source-1"],
        evidenceExcerpt:
          "The durability of the result remains uncertain.",
      },
    },
    ...overrides,
  };
}

function researchPacket(commentaryClaim: string): SourcePacket {
  return {
    itemKind: "paper",
    sources: [
      {
        sourceId: "source-1",
        sourceName: "arXiv",
        evidenceKind: "primary-research",
        role: "primary",
        title: "A measured research result",
        url: "https://arxiv.org/abs/2608.00001",
        retrievedAt: "2026-08-02T09:00:00.000Z",
        accessLevel: "abstract",
        excerpts: [{ number: 1, text: GROUNDED_TEXT }],
      },
      {
        sourceId: "commentary-1",
        sourceName: "Alignment Forum",
        evidenceKind: "commentary",
        role: "blog",
        title: "A review of the measured result",
        url: "https://www.alignmentforum.org/posts/measured-result",
        retrievedAt: "2026-08-02T09:00:00.000Z",
        accessLevel: "secondary",
        excerpts: [{ number: 1, text: commentaryClaim }],
      },
    ],
  } as SourcePacket;
}

function mixedAuthorityPacket(
  primaryEvidence: string,
  commentaryEvidence: string,
): SourcePacket {
  const sharedEvidence = "The sources discuss a measured result.";
  return {
    itemKind: "paper",
    sources: [
      {
        sourceId: "source-1",
        sourceName: "arXiv",
        evidenceKind: "primary-research",
        role: "primary",
        title: "A measured research result",
        url: "https://arxiv.org/abs/2608.00001",
        retrievedAt: "2026-08-02T09:00:00.000Z",
        accessLevel: "abstract",
        excerpts: [{
          number: 1,
          text: `${GROUNDED_TEXT} ${sharedEvidence} ${primaryEvidence}`,
        }],
      },
      {
        sourceId: "commentary-1",
        sourceName: "Alignment Forum",
        evidenceKind: "commentary",
        role: "blog",
        title: "A review of the measured result",
        url: "https://www.alignmentforum.org/posts/measured-result",
        retrievedAt: "2026-08-02T09:00:00.000Z",
        accessLevel: "secondary",
        excerpts: [{
          number: 1,
          text: `${sharedEvidence} ${commentaryEvidence}`,
        }],
      },
    ],
  } as SourcePacket;
}

function researchItemWithAuthority(
  metadata: Record<string, unknown>,
): Item {
  return {
    id: "paper-authority",
    kind: "paper",
    canonicalUrl: "https://arxiv.org/abs/2608.00001",
    title: "A measured research result",
    publishedAt: "2026-08-01T12:00:00.000Z",
    sourceRefs: [{
      id: "arxiv",
      name: "arXiv",
      url: "https://arxiv.org/abs/2608.00001",
      role: "primary",
      retrievedAt: "2026-08-02T09:00:00.000Z",
    }],
    accessLevel: "abstract",
    primaryTopic: "oversight",
    tags: ["research"],
    normalizedText: GROUNDED_TEXT,
    metadata,
    createdAt: "2026-08-02T09:00:00.000Z",
    expiresAt: null,
  };
}

describe("validateSummary", () => {
  it("requires primary research authority for an unattributed paper-result claim", () => {
    const claim = "The paper reports a twenty percent improvement.";
    const result = validateSummary(
      summaryFixture({
        accessLevel: "secondary",
        claims: [{
          text: claim,
          sourceIds: ["commentary-1"],
          evidenceExcerpt: claim,
        }],
      }),
      researchPacket(claim),
    );

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "PRIMARY_RESEARCH_SOURCE_REQUIRED:0",
      ]),
    });
  });

  it.each([
    "argues",
    "notes",
    "suggests",
    "critiques",
    "interprets",
  ])("allows commentary-only attribution using the verb %s", (verb) => {
    const claim =
      `Alignment Forum ${verb} that the paper's assumptions are fragile.`;
    const result = validateSummary(
      summaryFixture({
        accessLevel: "secondary",
        claims: [{
          text: claim,
          sourceIds: ["commentary-1"],
          evidenceExcerpt: claim,
        }],
      }),
      researchPacket(claim),
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    "A review reports that the paper's assumptions are fragile.",
    "The source critiques the paper's assumptions.",
  ])("rejects commentary-only prose without exact source attribution: %s", (claim) => {
    const result = validateSummary(
      summaryFixture({
        accessLevel: "secondary",
        claims: [{
          text: claim,
          sourceIds: ["commentary-1"],
          evidenceExcerpt: claim,
        }],
      }),
      researchPacket(claim),
    );

    expect(result.errors).toContain(
      "PRIMARY_RESEARCH_SOURCE_REQUIRED:0",
    );
  });

  it("rejects mixed citations when only commentary supports an unattributed result claim", () => {
    const claim = "The paper improves performance by ninety percent.";
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        claims: [{
          text: claim,
          sourceIds: ["source-1", "commentary-1"],
          evidenceExcerpt: "The sources discuss a measured result.",
        }],
      }),
      mixedAuthorityPacket("", claim),
    );

    expect(result.errors).toContain(
      "PRIMARY_RESEARCH_SOURCE_REQUIRED:0",
    );
  });

  it("accepts mixed citations when primary research supports the result claim", () => {
    const claim = "The paper improves performance by ninety percent.";
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        claims: [{
          text: claim,
          sourceIds: ["source-1", "commentary-1"],
          evidenceExcerpt: "The sources discuss a measured result.",
        }],
      }),
      mixedAuthorityPacket(claim, ""),
    );

    expect(result.errors).not.toContain(
      "PRIMARY_RESEARCH_SOURCE_REQUIRED:0",
    );
  });

  it("accepts mixed citations when commentary support has exact attribution", () => {
    const claim =
      "Alignment Forum notes that the paper's assumptions are fragile.";
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        claims: [{
          text: claim,
          sourceIds: ["source-1", "commentary-1"],
          evidenceExcerpt: "The sources discuss a measured result.",
        }],
      }),
      mixedAuthorityPacket("", claim),
    );

    expect(result.errors).not.toContain(
      "PRIMARY_RESEARCH_SOURCE_REQUIRED:0",
    );
  });

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
      uncertainty: {
        sourceIds: ["report"],
        evidenceExcerpt:
          "The durability of the result remains uncertain.",
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

  it("requires generation-only provenance for uncertainty", () => {
    const fixture = summaryFixture();
    const result = validateSummary(
      {
        ...fixture,
        provenance: {
          title: fixture.provenance.title,
          oneSentence: fixture.provenance.oneSentence,
          whyItMatters: fixture.provenance.whyItMatters,
        },
      },
      sourcePacketFixture(),
    );

    expect(result.errors).toContain(
      "SCHEMA_INVALID:provenance.uncertainty",
    );
  });

  it("rejects unsupported uncertainty despite cited provenance", () => {
    const result = validateSummary(
      summaryFixture({
        uncertainty: "The result will remain durable for a decade.",
        provenance: {
          ...summaryFixture().provenance,
          uncertainty: {
            sourceIds: ["source-1"],
            evidenceExcerpt:
              "The durability of the result remains uncertain.",
          },
        },
      }),
      sourcePacketFixture(),
    );

    expect(result.errors).toContain(
      "UNGROUNDED_PROSE:uncertainty",
    );
  });

  it("rejects whitespace-only prominent provenance evidence", () => {
    const result = validateSummary(
      summaryFixture({
        provenance: {
          ...summaryFixture().provenance,
          title: {
            sourceIds: ["source-1"],
            evidenceExcerpt: " \t ",
          },
        },
      }),
      sourcePacketFixture(),
    );

    expect(result.errors).toContain(
      "SCHEMA_INVALID:provenance.title.evidenceExcerpt",
    );
  });

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

  it.each([
    "Forecast, not fact.",
    "FORECAST, NOT FACT —",
  ])(
    "allows trusted forecast label %s before exact cited prose",
    (label) => {
      const citedSentence =
        "The measured outcome improved during the trial.";
      const result = validateSummary(
        summaryFixture({
          accessLevel: "secondary",
          oneSentence: `${label} ${citedSentence}`,
          provenance: {
            ...summaryFixture().provenance,
            oneSentence: {
              sourceIds: ["source-1"],
              evidenceExcerpt: citedSentence,
            },
          },
        }),
        sourcePacketFixture({
          itemKind: "forecast",
          sources: [
            {
              ...sourcePacketFixture({
                accessLevel: "secondary",
              }).sources[0]!,
              role: "forecast",
            },
          ],
        }),
      );

      expect(result).toEqual({ ok: true, errors: [] });
    },
  );

  it("rejects unsupported prose surrounding a trusted forecast label", () => {
    const citedSentence =
      "The measured outcome improved during the trial.";
    const result = validateSummary(
      summaryFixture({
        accessLevel: "secondary",
        oneSentence:
          `Forecast, not fact. Experts guarantee success. ${citedSentence}`,
        provenance: {
          ...summaryFixture().provenance,
          oneSentence: {
            sourceIds: ["source-1"],
            evidenceExcerpt: citedSentence,
          },
        },
      }),
      sourcePacketFixture({
        itemKind: "forecast",
        sources: [
          {
            ...sourcePacketFixture({
              accessLevel: "secondary",
            }).sources[0]!,
            role: "forecast",
          },
        ],
      }),
    );

    expect(result.errors).toContain(
      "UNGROUNDED_PROSE:oneSentence",
    );
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

  it("does not infer primary research authority from a source role", () => {
    const packet = sourcePacketForItem(researchItemWithAuthority({}));
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        claims: [{
          text: GROUNDED_TEXT,
          sourceIds: ["arxiv"],
          evidenceExcerpt: GROUNDED_TEXT,
        }],
      }),
      packet,
    );

    expect(packet.sources[0]?.evidenceKind).toBe("commentary");
    expect(result.errors).toContain("PRIMARY_RESEARCH_SOURCE_REQUIRED:0");
  });

  it("accepts explicit primary research source IDs as claim authority", () => {
    const packet = sourcePacketForItem(researchItemWithAuthority({
      primaryResearchSourceIds: ["arxiv"],
    }));
    const result = validateSummary(
      summaryFixture({
        accessLevel: "abstract",
        claims: [{
          text: GROUNDED_TEXT,
          sourceIds: ["arxiv"],
          evidenceExcerpt: GROUNDED_TEXT,
        }],
      }),
      packet,
    );

    expect(packet.sources[0]?.evidenceKind).toBe("primary-research");
    expect(result.errors).not.toContain("PRIMARY_RESEARCH_SOURCE_REQUIRED:0");
  });

  it("requires a bounded source name and exact evidence kind", () => {
    const attributed = {
      ...source,
      sourceName: "arXiv",
      evidenceKind: "primary-research",
    };

    expect(SourcePacketSchema.safeParse({
      itemKind: "paper",
      sources: [attributed],
    }).success).toBe(true);
    expect(SourcePacketSchema.safeParse({
      itemKind: "paper",
      sources: [{ ...attributed, sourceName: undefined }],
    }).success).toBe(false);
    expect(SourcePacketSchema.safeParse({
      itemKind: "paper",
      sources: [{ ...attributed, evidenceKind: "search-result" }],
    }).success).toBe(false);
  });

  it("keeps primary and attached commentary excerpts separately attributed", () => {
    const item: Item = {
      id: "paper-1",
      kind: "paper",
      canonicalUrl: "https://arxiv.org/abs/2608.00001",
      title: "A measured research result",
      publishedAt: "2026-08-01T12:00:00.000Z",
      sourceRefs: [
        {
          id: "arxiv",
          name: "arXiv",
          url: "https://arxiv.org/abs/2608.00001",
          role: "primary",
          retrievedAt: "2026-08-02T09:00:00.000Z",
        },
        {
          id: "alignment-forum",
          name: "Alignment Forum",
          url: "https://www.alignmentforum.org/posts/measured-result",
          role: "blog",
          retrievedAt: "2026-08-02T09:00:00.000Z",
        },
      ],
      accessLevel: "abstract",
      primaryTopic: "oversight",
      tags: ["research"],
      normalizedText: "Primary abstract evidence.",
      metadata: {
        primaryResearchSourceIds: ["arxiv"],
        attachedCommentary: [{
          sourceId: "alignment-forum",
          role: "blog",
          title: "A review of the measured result",
          url: "https://www.alignmentforum.org/posts/measured-result",
          retrievedAt: "2026-08-02T09:00:00.000Z",
          accessLevel: "secondary",
          excerpt: "Alignment Forum critiques an assumption in the result.",
          relatedPaperIds: ["arXiv:2608.00001"],
        }],
      },
      createdAt: "2026-08-02T09:00:00.000Z",
      expiresAt: null,
    };

    expect(sourcePacketForItem(item).sources).toEqual([
      expect.objectContaining({
        sourceId: "alignment-forum",
        sourceName: "Alignment Forum",
        evidenceKind: "commentary",
        title: "A review of the measured result",
        excerpts: [{
          number: 1,
          text: "Alignment Forum critiques an assumption in the result.",
        }],
      }),
      expect.objectContaining({
        sourceId: "arxiv",
        sourceName: "arXiv",
        evidenceKind: "primary-research",
        title: "A measured research result",
        excerpts: [{ number: 1, text: "Primary abstract evidence." }],
      }),
    ]);
  });

  it("labels existing article packets as news evidence", () => {
    const item: Item = {
      id: "article-1",
      kind: "article",
      canonicalUrl: "https://example.com/report",
      title: "A reported development",
      publishedAt: "2026-08-01T12:00:00.000Z",
      sourceRefs: [{
        id: "source-1",
        name: "Example News",
        url: "https://example.com/report",
        role: "reporting",
        retrievedAt: "2026-08-02T09:00:00.000Z",
      }],
      accessLevel: "full_text",
      primaryTopic: "technology",
      tags: ["technology"],
      normalizedText: GROUNDED_TEXT,
      metadata: {},
      createdAt: "2026-08-02T09:00:00.000Z",
      expiresAt: null,
    };

    expect(sourcePacketForItem(item).sources[0]).toMatchObject({
      sourceName: "Example News",
      evidenceKind: "news-evidence",
    });
  });

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
      "camel-case session ID query",
      {
        ...source,
        url: "https://example.com/report?sessionId=opaque-value",
      },
    ],
    [
      "camel-case JWT token query",
      {
        ...source,
        url: "https://example.com/report?jwtToken=opaque-value",
      },
    ],
    [
      "compact access token query",
      {
        ...source,
        url: "https://example.com/report?accessToken=opaque-value",
      },
    ],
    [
      "compact ID token query",
      {
        ...source,
        url: "https://example.com/report?idToken=opaque-value",
      },
    ],
    [
      "compact API key query",
      {
        ...source,
        url: "https://example.com/report?apiKey=opaque-value",
      },
    ],
    [
      "authorization token query",
      {
        ...source,
        url:
          "https://example.com/report?authorizationToken=opaque-value",
      },
    ],
    [
      "nested redirect with session ID",
      {
        ...source,
        url:
          "https://example.com/report?next=https%3A%2F%2Fother.example%2F%3FsessionId%3Dopaque-value",
      },
    ],
    [
      "nested JWT token assignment",
      {
        ...source,
        url:
          "https://example.com/report?next=jwtToken%3Dopaque-value",
      },
    ],
    [
      "nested access token assignment",
      {
        ...source,
        url:
          "https://example.com/report?next=accessToken%3Dopaque-value",
      },
    ],
    [
      "double-encoded authorization token redirect",
      {
        ...source,
        url:
          "https://example.com/report?next=https%253A%252F%252Fother.example%252F%253FauthorizationToken%253Dopaque-value",
      },
    ],
    [
      "credential assignment nested inside another assignment",
      {
        ...source,
        url:
          "https://example.com/report?next=redirect%3DsessionId%253Dopaque-value",
      },
    ],
    [
      "nested redirect URL credentials",
      {
        ...source,
        url:
          "https://example.com/report?next=https%3A%2F%2Freader%3Aopaque-value%40other.example%2Freport",
      },
    ],
    [
      "nested redirect URL fragment",
      {
        ...source,
        url:
          "https://example.com/report?next=https%3A%2F%2Fother.example%2Freport%23methods",
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
            url:
              "https://example.com/report?page=2&lang=en&monkey=banana&sessionized=false",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("allows an encoded nested URL with ordinary query parameters", () => {
    expect(
      SourcePacketSchema.safeParse({
        itemKind: "article",
        sources: [
          {
            ...source,
            url:
              "https://example.com/report?next=https%253A%252F%252Fother.example%252F%253Fpage%253D2%2526lang%253Den",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("does not include a nested credential value in validation errors", () => {
    const result = SourcePacketSchema.safeParse({
      itemKind: "article",
      sources: [
        {
          ...source,
          url:
            "https://example.com/report?next=https%3A%2F%2Fother.example%2F%3FsessionId%3Ddo-not-expose",
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain(
        "do-not-expose",
      );
    }
  });
});
