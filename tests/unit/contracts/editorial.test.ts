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
  DiscoveryRejectionCountsSchema,
  DiscoveryRejectionReasonSchema,
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

  it("rejects unbounded provider strings, arrays, and metadata", () => {
    expect(RawPublicationCandidateSchema.safeParse({
      ...publication,
      title: "t".repeat(501),
    }).success).toBe(false);
    expect(RawPublicationCandidateSchema.safeParse({
      ...publication,
      externalIds: Array.from({ length: 33 }, (_, index) => `id-${index}`),
    }).success).toBe(false);
    expect(RawPublicationCandidateSchema.safeParse({
      ...publication,
      relatedPaperIds: ["r".repeat(2_049)],
    }).success).toBe(false);
    expect(RawPublicationCandidateSchema.safeParse({
      ...publication,
      abstract: "a".repeat(4_001),
    }).success).toBe(false);
    expect(RawPublicationCandidateSchema.safeParse({
      ...publication,
      metadata: { oversized: "m".repeat(65_536) },
    }).success).toBe(false);
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

  it("rejects diagnostics that violate funnel ordering", () => {
    expect(DiscoveryLaneDiagnosticSchema.safeParse({
      laneId: "papers-with-code-co:page",
      sourceId: "papers-with-code-co",
      discoveryFamily: "commentary",
      discovered: 1,
      deduplicated: 2,
      triaged: 2,
      assessed: 2,
      outcome: "success",
    }).success).toBe(false);
  });

  it("defaults old discovery diagnostics to empty rejection counts", () => {
    const diagnostic = {
      laneId: "arxiv:oversight-governance",
      sourceId: "arxiv",
      discoveryFamily: "arxiv",
      discovered: 3,
      deduplicated: 2,
      triaged: 1,
      assessed: 1,
      outcome: "success",
    };

    expect(DiscoveryLaneDiagnosticSchema.parse(diagnostic).rejectionCounts)
      .toEqual({});
  });

  it("accepts bounded fallback triage counts and treats omission as zero", () => {
    const historical = {
      laneId: "openalex:topic",
      sourceId: "openalex",
      discoveryFamily: "bibliographic" as const,
      discovered: 10,
      deduplicated: 8,
      triaged: 3,
      assessed: 2,
      outcome: "success" as const,
    };

    const parsedHistorical = DiscoveryLaneDiagnosticSchema.parse(historical);
    expect(parsedHistorical.fallbackTriaged ?? 0).toBe(0);
    expect("fallbackTriaged" in parsedHistorical).toBe(false);
    expect(DiscoveryLaneDiagnosticSchema.parse({
      ...historical,
      fallbackTriaged: 2,
    }).fallbackTriaged).toBe(2);
    expect(DiscoveryLaneDiagnosticSchema.safeParse({
      ...historical,
      fallbackTriaged: 4,
    }).success).toBe(false);
  });

  it.each([-1, 0.5, 10_001])(
    "rejects an invalid fallback triage count of %s",
    (fallbackTriaged) => {
      expect(DiscoveryLaneDiagnosticSchema.safeParse({
        laneId: "openalex:topic",
        sourceId: "openalex",
        discoveryFamily: "bibliographic",
        discovered: 10_000,
        deduplicated: 10_000,
        triaged: 10_000,
        assessed: 2,
        fallbackTriaged,
        outcome: "success",
      }).success).toBe(false);
    },
  );

  it("round-trips only fixed bounded discovery rejection reasons", () => {
    const diagnostic = {
      laneId: "arxiv:oversight-governance",
      sourceId: "arxiv",
      discoveryFamily: "arxiv",
      discovered: 3,
      deduplicated: 2,
      triaged: 1,
      assessed: 1,
      outcome: "success",
    };
    const rejectionCounts = {
      unchanged_observation: 2,
      capacity_limited: 1,
    };

    expect(DiscoveryLaneDiagnosticSchema.parse({
      ...diagnostic,
      rejectionCounts,
    }).rejectionCounts).toEqual(rejectionCounts);
    expect(DiscoveryRejectionReasonSchema.options).toEqual([
      "out_of_window",
      "unchanged_observation",
      "identity_merged",
      "route_excluded",
      "topic_mismatch",
      "quality_rejected",
      "capacity_limited",
    ]);
  });

  it.each([
    [{ private_provider_error: 1 }, "unknown reason"],
    [{ route_excluded: -1 }, "negative count"],
    [{ route_excluded: 0.5 }, "fractional count"],
    [{ route_excluded: 10_001 }, "count above the cap"],
  ])("rejects discovery rejection counts with a %s", (rejectionCounts, _label) => {
    expect(DiscoveryRejectionCountsSchema.safeParse(rejectionCounts).success)
      .toBe(false);
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
