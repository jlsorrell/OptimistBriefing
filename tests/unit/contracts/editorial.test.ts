import { describe, expect, it } from "vitest";
import {
  EditionEntrySchema,
  EditionSchema,
  ItemSchema,
  StructuredSummarySchema,
} from "../../../src/contracts/editorial";

describe("StructuredSummarySchema", () => {
  it("rejects a factual claim without supporting sources", () => {
    const result = StructuredSummarySchema.safeParse({
      title: "A material development",
      oneSentence: "A policy changed.",
      whyItMatters: "The change affects evaluation.",
      uncertainty: "Implementation timing is unknown.",
      claims: [{ text: "The policy changed.", sourceIds: [] }],
      accessLevel: "full_text",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a database-safe item", () => {
    const result = ItemSchema.safeParse({
      id: "item-1",
      kind: "paper",
      canonicalUrl: "https://example.com/paper",
      title: "A valid paper",
      publishedAt: "2026-07-29T12:00:00.000Z",
      sourceRefs: [
        {
          id: "source-1",
          name: "Example Journal",
          url: "https://example.com/paper",
          role: "primary",
          retrievedAt: "2026-07-29T12:30:00.000Z",
        },
      ],
      accessLevel: "full_text",
      primaryTopic: "evaluation",
      tags: ["research"],
      normalizedText: "A normalized body.",
      metadata: { citationCount: 10 },
      createdAt: "2026-07-29T12:30:00.000Z",
      expiresAt: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an edition date outside ISO calendar format", () => {
    const result = EditionSchema.safeParse({
      id: "edition-1",
      editionDate: "29-07-2026",
      runId: "run-1",
      status: "draft",
      readingMinutes: null,
      publishedAt: null,
      createdAt: "2026-07-29T12:30:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects claims that cite sources absent from the edition entry", () => {
    const result = EditionEntrySchema.safeParse({
      id: "entry-1",
      editionId: "edition-1",
      itemId: "item-1",
      section: "research",
      position: 0,
      summary: {
        title: "A material development",
        oneSentence: "A policy changed.",
        whyItMatters: "The change affects evaluation.",
        uncertainty: "Implementation timing is unknown.",
        claims: [
          {
            text: "The policy changed.",
            sourceIds: ["missing-source"],
            evidenceExcerpt: "The policy statement.",
          },
        ],
        accessLevel: "full_text",
      },
      selectionReasons: ["relevant"],
      sourceRefs: [
        {
          id: "source-1",
          name: "Example Journal",
          url: "https://example.com/paper",
          role: "primary",
          retrievedAt: "2026-07-29T12:30:00.000Z",
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
