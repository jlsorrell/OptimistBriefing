import { describe, expect, it } from "vitest";
import {
  EditionEntrySchema,
  EditionSchema,
  ItemSchema,
  StructuredSummarySchema,
} from "../../../src/contracts/editorial";
import {
  DiscoveryLaneDiagnosticSchema,
  DiscoveryObservationSchema,
  RawPublicationCandidateSchema,
} from "../../../src/sources/types";

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

describe("research discovery source contracts", () => {
  const publication = {
    kind: "publication",
    sourceId: "alignment-forum",
    sourceName: "Alignment Forum",
    sourceRole: "blog",
    title: "A new result on debate",
    originalUrl: "https://www.alignmentforum.org/posts/example/result",
    externalId: "example",
    externalIds: ["example"],
    publishedAt: "2026-08-01T12:00:00.000Z",
    retrievedAt: "2026-08-02T09:00:00.000Z",
    accessLevel: "secondary",
    authors: ["Ada Example"],
    institutions: [],
    abstract: "We analyze debate under strategic incentives.",
    content: null,
    relatedPaperIds: [],
    sectionEligibility: ["research", "research_radar"],
    discoveryFamily: "commentary",
    metadata: {},
  };

  it("accepts a bounded publication candidate", () => {
    expect(RawPublicationCandidateSchema.parse(publication)).toMatchObject({
      kind: "publication",
      discoveryFamily: "commentary",
    });
  });

  it("rejects an unknown discovery family", () => {
    expect(
      RawPublicationCandidateSchema.safeParse({
        ...publication,
        discoveryFamily: "newsletter",
      }).success,
    ).toBe(false);
  });

  it("rejects more than 16 related paper IDs", () => {
    expect(
      RawPublicationCandidateSchema.safeParse({
        ...publication,
        relatedPaperIds: Array.from(
          { length: 17 },
          (_, index) => `paper-${index}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects diagnostics with negative counts", () => {
    expect(
      DiscoveryLaneDiagnosticSchema.safeParse({
        laneId: "alignment-forum:frontpage",
        sourceId: "alignment-forum",
        discoveryFamily: "commentary",
        discovered: -1,
        deduplicated: 0,
        triaged: 0,
        assessed: 0,
        outcome: "success",
      }).success,
    ).toBe(false);
  });

  it("rejects observations with non-ISO timestamps", () => {
    expect(
      DiscoveryObservationSchema.safeParse({
        runId: "run-1",
        canonicalId: "https://example.com/publication",
        sourceId: "alignment-forum",
        discoveryFamily: "commentary",
        windowKind: "fresh",
        observedAt: "August 2, 2026",
        publishedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-02T09:00:00.000Z",
        contentFingerprint: "content-1",
        evidenceFingerprint: "evidence-1",
        joinedExternalIds: ["example"],
        route: "research",
        expiresAt: "2026-08-09T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
