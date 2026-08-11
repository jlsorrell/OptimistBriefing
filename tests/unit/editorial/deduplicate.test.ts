import { describe, expect, it } from "vitest";

import { clusterNews } from "../../../src/editorial/cluster";
import { deduplicateItems } from "../../../src/editorial/deduplicate";
import {
  canonicalizeUrl,
  normalizeCandidate,
} from "../../../src/editorial/normalize";
import type { Item } from "../../../src/contracts/editorial";
import type { RawNewsCandidate } from "../../../src/sources/types";

function rawNews(
  overrides: Partial<RawNewsCandidate> = {},
): RawNewsCandidate {
  const base: RawNewsCandidate = {
    kind: "article",
    sourceId: "reuters",
    sourceName: "Reuters",
    sourceRole: "reporting",
    title: "  Agency announces a new secure evaluation framework  ",
    originalUrl:
      "https://news.example.com/story/?utm_source=daily&b=2&a=1#top",
    externalId: "Reuters:story-1",
    externalIds: ["Reuters:story-1"],
    publishedAt: "2026-07-29T08:15:00-04:00",
    retrievedAt: "2026-07-29T13:00:00.000Z",
    accessLevel: "full_text",
    authors: ["Ada Reporter"],
    institutions: [],
    abstract: "The agency published a new framework.",
    content: null,
    relatedPaperIds: [],
    canCorroborateFacts: true,
    sectionEligibility: ["ai_policy"],
    namedEntities: [],
    primaryDocumentUrl: null,
    primaryDocumentUrls: [],
    eventFamilies: [],
    materialFacts: [],
    metadata: {
      section: "ai_policy",
      namedEntities: ["Evaluation Agency"],
    },
  };
  const candidate: RawNewsCandidate = { ...base, ...overrides };
  return {
    ...candidate,
    sectionEligibility: candidate.sectionEligibility,
    namedEntities:
      candidate.namedEntities.length > 0
        ? candidate.namedEntities
        : Array.isArray(candidate.metadata.namedEntities)
          ? candidate.metadata.namedEntities.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
    primaryDocumentUrl:
      candidate.primaryDocumentUrl ??
      (typeof candidate.metadata.primaryDocumentUrl === "string"
        ? candidate.metadata.primaryDocumentUrl
        : null),
  };
}

function normalized(
  sourceId: string,
  overrides: Partial<RawNewsCandidate> = {},
): Item {
  return normalizeCandidate(
    rawNews({
      sourceId,
      sourceName: sourceId.toUpperCase(),
      externalId: `${sourceId}:story`,
      externalIds: [`${sourceId}:story`],
      originalUrl: `https://${sourceId}.example.com/story`,
      ...overrides,
    }),
  );
}

describe("normalizeCandidate", () => {
  it("canonicalizes tracking parameters, identifiers, titles, and timestamps", () => {
    const item = normalizeCandidate(
      rawNews({
        externalIds: [
          "https://doi.org/10.1000/EXAMPLE.1",
          "https://arxiv.org/pdf/2607.00001v3.pdf",
        ],
      }),
    );

    expect(item.canonicalUrl).toBe(
      "https://news.example.com/story?a=1&b=2",
    );
    expect(item.title).toBe(
      "Agency announces a new secure evaluation framework",
    );
    expect(item.publishedAt).toBe("2026-07-29T12:15:00.000Z");
    expect(item.metadata.externalIds).toEqual(
      expect.arrayContaining([
        "DOI:10.1000/example.1",
        "arXiv:2607.00001",
      ]),
    );
  });

  it("uses a valid publisher canonical URL for a syndicated copy", () => {
    const item = normalizeCandidate(
      rawNews({
        originalUrl: "https://syndicate.example.net/wire-copy",
        metadata: {
          canonicalUrl:
            "https://publisher.example.org/report/42?utm_medium=rss",
          section: "world",
        },
      }),
    );

    expect(item.canonicalUrl).toBe(
      "https://publisher.example.org/report/42",
    );
    expect(item.metadata.originalUrl).toBe(
      "https://syndicate.example.net/wire-copy",
    );
  });

  it("rejects invalid runtime input instead of emitting a partial item", () => {
    expect(() =>
      normalizeCandidate({
        ...rawNews(),
        retrievedAt: "not-a-date",
      }),
    ).toThrow();
    expect(() => canonicalizeUrl("javascript:alert(1)")).toThrow();
  });
});

describe("deduplicateItems", () => {
  it("does not false-deduplicate an inert third-layer title entity", () => {
    const inertEntity = normalized("entity-source", {
      title: "Agency &amp;amp;#8217; framework",
      publishedAt: "2026-07-29T12:00:00.000Z",
    });
    const plainTitle = normalized("plain-source", {
      title: "Agency framework",
      publishedAt: "2026-07-29T12:00:00.000Z",
    });

    expect(inertEntity.title).toBe("Agency &#8217; framework");
    expect(deduplicateItems([inertEntity, plainTitle]).items).toHaveLength(2);
  });

  it("merges exact identifiers deterministically and retains provenance", () => {
    const a = normalized("reuters", {
      externalIds: ["DOI:10.1000/shared"],
      accessLevel: "metadata",
    });
    const b = normalized("official", {
      kind: "document",
      sourceRole: "primary",
      externalIds: ["https://doi.org/10.1000/SHARED"],
      canCorroborateFacts: true,
      accessLevel: "full_text",
      content: "The full primary document.",
    });

    const forward = deduplicateItems([a, b]);
    const reverse = deduplicateItems([b, a]);

    expect(forward.items).toEqual(reverse.items);
    expect(forward.merges).toEqual(reverse.merges);
    expect(forward.items).toHaveLength(1);
    expect(forward.items[0]?.sourceRefs).toHaveLength(2);
    expect(forward.merges[0]?.reason).toBe("external_identifier");
  });

  it("records an exact merge when normalized identifiers produce the same item ID", () => {
    const first = normalized("first", {
      externalIds: ["DOI:10.1000/same-kind"],
    });
    const second = normalized("second", {
      externalIds: ["https://doi.org/10.1000/SAME-KIND"],
    });

    const result = deduplicateItems([first, second]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sourceRefs).toHaveLength(2);
    expect(result.merges).toEqual([
      {
        keptItemId: first.id,
        mergedItemId: second.id,
        reason: "external_identifier",
      },
    ]);
  });

  it("unions losing-source section, entity, and primary-document signals", () => {
    const first = normalized("first", {
      externalIds: ["DOI:10.1000/signal-union"],
      sectionEligibility: ["world", "technology"],
      namedEntities: ["Example Company"],
      primaryDocumentUrl: "https://company.example/report",
    });
    const second = normalized("second", {
      externalIds: ["DOI:10.1000/signal-union"],
      sectionEligibility: ["ai_policy"],
      namedEntities: ["Evaluation Agency"],
      primaryDocumentUrl: "https://agency.gov/standard",
    });

    const result = deduplicateItems([first, second]);
    const merged = result.items[0];
    expect(merged?.metadata.sectionEligibility).toEqual([
      "ai_policy",
      "technology",
      "world",
    ]);
    expect(merged?.metadata.namedEntities).toEqual([
      "Evaluation Agency",
      "Example Company",
    ]);
    expect(merged?.metadata.primaryDocumentUrls).toEqual([
      "https://agency.gov/standard",
      "https://company.example/report",
    ]);

    const development = clusterNews(result.items, {})[0];
    expect(development?.sectionEligibility).toEqual([
      "ai_policy",
      "technology",
      "world",
    ]);
    expect(development?.namedEntities).toEqual([
      "Evaluation Agency",
      "Example Company",
    ]);
    expect(development?.primaryDocumentUrls).toEqual([
      "https://agency.gov/standard",
      "https://company.example/report",
    ]);
  });

  it("does not promote non-corroborating facts through an exact merge", () => {
    const reporting = normalized("reporting-facts", {
      externalIds: ["DOI:10.1000/fact-authority"],
      title:
        "Evaluation Agency adopts evaluation standard for 100 models",
      abstract: "The standard was adopted for 100 models.",
    });
    const discovery = normalized("discovery-facts", {
      externalIds: ["DOI:10.1000/fact-authority"],
      sourceRole: "primary",
      canCorroborateFacts: false,
      title: "Evaluation Agency funding budget background",
      abstract: "Background discovery metadata.",
      materialFacts: [
        {
          kind: "status",
          key: "event-status",
          value: "proposed",
        },
        {
          kind: "number",
          key: "count:governance-instrument:models",
          value: "200",
        },
      ],
    });

    const merged = deduplicateItems([reporting, discovery]).items[0];

    expect(merged?.metadata.editorialSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "reporting-facts",
          sourceRole: "reporting",
          canCorroborateFacts: true,
          eventFamilies: expect.arrayContaining([
            "evaluation-standards",
          ]),
        }),
        expect.objectContaining({
          sourceId: "discovery-facts",
          sourceRole: "primary",
          canCorroborateFacts: false,
          eventFamilies: expect.arrayContaining(["funding-budget"]),
        }),
      ]),
    );
    expect(merged?.metadata.materialFacts).toEqual(
      expect.arrayContaining([
        {
          kind: "status",
          key: "event-status",
          value: "adopted",
        },
      ]),
    );
    expect(merged?.metadata.materialFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "proposed" }),
        expect.objectContaining({ value: "200" }),
      ]),
    );
    const originalDevelopment = clusterNews([reporting], {})[0];
    const mergedDevelopment =
      merged === undefined ? undefined : clusterNews([merged], {})[0];
    expect(mergedDevelopment?.developmentKey).toBe(
      originalDevelopment?.developmentKey,
    );
    expect(mergedDevelopment?.materialFactsFingerprint).toBe(
      originalDevelopment?.materialFactsFingerprint,
    );
    expect(mergedDevelopment?.repeatable).toBe(true);
    expect(mergedDevelopment?.editorialSignals).toHaveLength(2);
    expect(mergedDevelopment?.sourceEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "reporting-facts",
          canCorroborateFacts: true,
        }),
        expect.objectContaining({
          sourceId: "discovery-facts",
          canCorroborateFacts: false,
        }),
      ]),
    );
  });

  it("retains distinct same-source signals independent of input order", () => {
    const withoutDocument = normalized("same-source", {
      externalIds: ["DOI:10.1000/same-source-signals"],
      primaryDocumentUrl: null,
      primaryDocumentUrls: [],
    });
    const withDocument = normalized("same-source", {
      externalIds: ["DOI:10.1000/same-source-signals"],
      primaryDocumentUrl: "https://agency.gov/canonical-rule",
      primaryDocumentUrls: [],
    });

    const forward = deduplicateItems([
      withoutDocument,
      withDocument,
    ]).items[0];
    const reverse = deduplicateItems([
      withDocument,
      withoutDocument,
    ]).items[0];
    expect(forward?.metadata.editorialSignals).toHaveLength(2);
    expect(reverse?.metadata.editorialSignals).toEqual(
      forward?.metadata.editorialSignals,
    );

    const forwardDevelopment =
      forward === undefined ? undefined : clusterNews([forward], {})[0];
    const reverseDevelopment =
      reverse === undefined ? undefined : clusterNews([reverse], {})[0];
    expect(forwardDevelopment?.canonicalPrimaryDocument).toBe(
      "https://agency.gov/canonical-rule",
    );
    expect(reverseDevelopment?.developmentKey).toBe(
      forwardDevelopment?.developmentKey,
    );
    expect(reverseDevelopment?.materialFactsFingerprint).toBe(
      forwardDevelopment?.materialFactsFingerprint,
    );
  });

  it("requires both similar titles and a compatible publication window", () => {
    const baseline = normalized("ap", {
      title: "Baltimore approves a secure evaluation framework",
      publishedAt: "2026-07-29T10:00:00.000Z",
    });
    const near = normalized("wamu", {
      title: "Baltimore approves secure evaluation framework",
      publishedAt: "2026-07-29T12:00:00.000Z",
    });
    const old = normalized("archive", {
      title: "Baltimore approves a secure evaluation framework",
      publishedAt: "2026-05-01T10:00:00.000Z",
    });
    const unrelated = normalized("other", {
      title: "Orioles announce their opening day roster",
      publishedAt: "2026-07-29T11:00:00.000Z",
    });

    const result = deduplicateItems([baseline, near, old, unrelated]);

    expect(result.items).toHaveLength(3);
    expect(result.merges).toEqual([
      expect.objectContaining({ reason: "near_duplicate_title_time" }),
    ]);
  });

  it("does not near-merge a research paper with commentary about it", () => {
    const paper = normalizeCandidate({
      ...rawNews({
        kind: "article",
        title: "Debate as a mechanism for scalable oversight",
        sourceId: "paper",
        originalUrl: "https://papers.example.com/debate",
        externalId: "paper-id",
        externalIds: ["paper-id"],
      }),
      kind: "paper",
    });
    const commentary = normalizeCandidate({
      ...rawNews({
        kind: "article",
        title: "Debate as a mechanism for scalable oversight",
        sourceId: "blog",
        sourceRole: "blog",
        originalUrl: "https://blog.example.com/debate-commentary",
        externalId: "blog-id",
        externalIds: ["blog-id"],
        canCorroborateFacts: false,
      }),
      kind: "blog",
    });

    expect(deduplicateItems([paper, commentary]).items).toHaveLength(2);
  });

  it("keeps explicitly linked commentary separate from its paper", () => {
    const paper = normalizeCandidate({
      ...rawNews({
        kind: "article",
        sourceId: "arxiv",
        sourceRole: "primary",
        originalUrl: "https://arxiv.org/abs/2608.00001",
        externalId: "arXiv:2608.00001",
        externalIds: ["arXiv:2608.00001"],
      }),
      kind: "paper",
      metadata: { discoveryFamily: "arxiv" },
    });
    const commentary = normalizeCandidate({
      ...rawNews({
        kind: "article",
        sourceId: "papers-with-code-co",
        sourceRole: "blog",
        originalUrl: "https://paperswithcode.co/paper/2608.00001",
        externalId: "arXiv:2608.00001",
        externalIds: ["arXiv:2608.00001"],
        canCorroborateFacts: false,
      }),
      kind: "paper",
      metadata: { discoveryFamily: "commentary" },
    });

    expect(deduplicateItems([paper, commentary]).items).toHaveLength(2);
  });

  it("recognizes paper-shaped commentary from its only source role", () => {
    const paper = normalizeCandidate({
      ...rawNews({
        kind: "article",
        sourceId: "arxiv-role-check",
        sourceRole: "primary",
        originalUrl: "https://arxiv.org/abs/2608.00010",
        externalId: "arXiv:2608.00010",
        externalIds: ["arXiv:2608.00010"],
      }),
      kind: "paper",
      metadata: {},
    });
    const commentary = normalizeCandidate({
      ...rawNews({
        kind: "article",
        sourceId: "blog-role-check",
        sourceRole: "blog",
        originalUrl: "https://blog.example.org/paper-shaped-commentary",
        externalId: "arXiv:2608.00010",
        externalIds: ["arXiv:2608.00010"],
        accessLevel: "full_text",
        content: "Commentary must not become primary paper evidence.",
        canCorroborateFacts: false,
      }),
      kind: "paper",
      metadata: {},
    });

    expect(deduplicateItems([paper, commentary]).items).toHaveLength(2);
  });

  it("does not merge same-title papers without an author match", () => {
    const first = normalizeCandidate({
      ...rawNews({
        kind: "article",
        title: "A shared title for distinct papers",
        sourceId: "first-paper",
        originalUrl: "https://papers.example.com/first",
        externalId: "first-paper-id",
        externalIds: ["first-paper-id"],
        authors: ["Ada Example"],
      }),
      kind: "paper",
    });
    const second = normalizeCandidate({
      ...rawNews({
        kind: "article",
        title: "A shared title for distinct papers",
        sourceId: "second-paper",
        originalUrl: "https://papers.example.com/second",
        externalId: "second-paper-id",
        externalIds: ["second-paper-id"],
        authors: ["Grace Different"],
      }),
      kind: "paper",
    });

    expect(deduplicateItems([first, second]).items).toHaveLength(2);
  });
});

describe("clusterNews", () => {
  it("does not cluster stories whose only shared entity is generic AI", () => {
    const product = normalized("product", {
      title: "AI assistant launches for developers",
      metadata: {
        namedEntities: ["AI"],
        section: "technology",
      },
    });
    const research = normalized("research", {
      title: "AI benchmark measures scientific reasoning",
      metadata: {
        namedEntities: ["AI"],
        section: "technology",
      },
    });

    expect(
      clusterNews([product, research], {
        [product.id]: [1, 0],
        [research.id]: [1, 0],
      }),
    ).toHaveLength(2);
  });

  it("combines semantic similarity with entities and a publication window", () => {
    const reuters = normalized("reuters", {
      metadata: {
        namedEntities: ["Evaluation Agency"],
        section: "ai_policy",
      },
    });
    const ap = normalized("ap", {
      title: "New framework released by the Evaluation Agency",
      publishedAt: "2026-07-30T09:00:00.000Z",
      metadata: {
        namedEntities: ["Evaluation Agency"],
        section: "ai_policy",
      },
    });
    const semanticOnly = normalized("semantic-only", {
      title: "A separate high-dimensional research result",
      publishedAt: "2026-07-30T09:00:00.000Z",
      metadata: {
        namedEntities: ["Other Lab"],
        section: "technology",
      },
    });
    const stale = normalized("stale", {
      title: "Evaluation Agency framework follow-up",
      publishedAt: "2026-07-20T09:00:00.000Z",
      metadata: {
        namedEntities: ["Evaluation Agency"],
        section: "ai_policy",
      },
    });
    const embeddings = {
      [reuters.id]: [1, 0],
      [ap.id]: [0.99, 0.01],
      [semanticOnly.id]: [0.995, 0.005],
      [stale.id]: [0.99, 0.01],
    };

    const clusters = clusterNews(
      [semanticOnly, stale, ap, reuters],
      embeddings,
    );

    expect(clusters).toHaveLength(3);
    expect(
      clusters.find((cluster) =>
        cluster.itemIds.includes(reuters.id),
      )?.itemIds,
    ).toEqual([ap.id, reuters.id].sort());
  });

  it("clusters matching primary documents and retains evidence provenance", () => {
    const official = normalized("official", {
      kind: "document",
      sourceRole: "primary",
      metadata: {
        primaryDocumentUrl: "https://agency.gov/framework",
        namedEntities: ["Evaluation Agency"],
        section: "ai_policy",
      },
    });
    const report = normalized("report", {
      title: "Reporting on the agency document",
      metadata: {
        primaryDocumentUrl:
          "https://agency.gov/framework?utm_source=release",
        namedEntities: ["Evaluation Agency"],
        section: "ai_policy",
      },
    });
    const forecast = normalized("market", {
      kind: "forecast",
      sourceRole: "forecast",
      canCorroborateFacts: false,
      title: "Will the framework change this year?",
      metadata: {
        primaryDocumentUrl: "https://agency.gov/framework",
        namedEntities: ["Evaluation Agency"],
        section: "forecast",
      },
    });

    const [cluster] = clusterNews(
      [forecast, report, official],
      {},
    );

    expect(cluster?.corroboratingSourceIds).toEqual([
      "official",
      "report",
    ]);
    expect(cluster?.sourceEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "market",
          role: "forecast",
          accessLevel: "full_text",
        }),
      ]),
    );
    expect(cluster?.canonicalPrimaryDocument).toBe(
      "https://agency.gov/framework",
    );
  });
});
