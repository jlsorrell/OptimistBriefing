import { describe, expect, it } from "vitest";

import type { StructuredSummary } from "../../../src/contracts/editorial";
import {
  validateSummary,
  type SourcePacket,
} from "../../../src/editorial/validate-summary";

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
            text: "The measured outcome improved during the trial.",
          },
        ],
      },
    ],
  };
}

function summaryFixture(
  overrides: Partial<StructuredSummary> = {},
): StructuredSummary {
  return {
    title: "A measured outcome improved",
    oneSentence: "The measured outcome improved during the trial.",
    whyItMatters: "The result may improve an important outcome.",
    uncertainty: "The durability of the result remains uncertain.",
    claims: [
      {
        text: "The measured outcome improved.",
        sourceIds: ["source-1"],
        evidenceExcerpt: "measured outcome improved during the trial",
      },
    ],
    accessLevel: "full_text",
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
});
