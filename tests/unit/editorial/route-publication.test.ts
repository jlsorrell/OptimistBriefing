import { describe, expect, it } from "vitest";

import { routePublication } from "../../../src/editorial/route-publication";
import type { RawPublicationCandidate } from "../../../src/sources/types";
import { createProductionPipelineContext } from "../../../src/workflow/run-editorial-pipeline";
import type { PipelineStore } from "../../../src/workflow/types";

function publication(overrides: Partial<RawPublicationCandidate> = {}): RawPublicationCandidate {
  return {
    kind: "publication",
    sourceId: "anthropic",
    sourceName: "Anthropic Research",
    sourceRole: "blog",
    title: "Publication update",
    originalUrl: "https://www.anthropic.com/research/publication-update",
    externalId: "https://www.anthropic.com/research/publication-update",
    externalIds: ["https://www.anthropic.com/research/publication-update"],
    publishedAt: "2026-08-01T12:00:00.000Z",
    retrievedAt: "2026-08-02T09:00:00.000Z",
    accessLevel: "secondary",
    authors: ["Ada Example"],
    institutions: [],
    abstract: null,
    content: null,
    relatedPaperIds: [],
    sectionEligibility: ["research", "research_radar", "technology", "ai_policy"],
    discoveryFamily: "official-publication",
    metadata: { canCorroborateFacts: false },
    ...overrides,
  };
}

describe("routePublication", () => {
  it("routes a topical technical paper post to neutral research", () => {
    const technicalPaperPost = publication({
      title: "A method for mechanistic interpretability",
      abstract: "We study internal representations and report a new alignment result.",
      relatedPaperIds: ["arXiv:2608.00001"],
    });

    expect(routePublication(technicalPaperPost)).toMatchObject({
      kind: "paper",
      citationCount: null,
      influentialCitationCount: null,
      topics: ["alignment-interpretability"],
      metadata: { discoveryFamily: "official-publication", primarySection: "research" },
    });
  });

  it("routes eligible governance publications to AI Policy", () => {
    const governancePost = publication({
      title: "AI oversight standard and regulatory accountability framework",
      abstract: "The lab publishes an official evaluation-policy standard.",
    });

    expect(routePublication(governancePost)).toMatchObject({
      kind: "article",
      canCorroborateFacts: false,
      metadata: { primarySection: "ai_policy" },
    });
  });

  it("routes eligible product publications to Technology", () => {
    const productPost = publication({
      title: "We launch a new AI assistant product",
      abstract: "The model deployment adds a software capability.",
    });

    expect(routePublication(productPost)).toMatchObject({
      kind: "article",
      canCorroborateFacts: false,
      metadata: { primarySection: "technology" },
    });
  });

  it("defaults an ambiguous official-lab publication to Technology", () => {
    const ambiguousOfficialLabPost = publication({
      title: "Notes from the lab this week",
      abstract: "A short update from our team.",
    });

    expect(routePublication(ambiguousOfficialLabPost)).toMatchObject({
      metadata: { primarySection: "technology" },
    });
  });

  it("excludes ambiguous independent commentary", () => {
    const ambiguousIndependentPost = publication({
      sourceId: "alignment-forum",
      sourceName: "Alignment Forum",
      originalUrl: "https://www.alignmentforum.org/posts/example/update",
      externalId: "af-update",
      externalIds: ["af-update"],
      title: "Some thoughts on recent work",
      abstract: "A short commentary without an original technical result.",
      sectionEligibility: ["research", "research_radar"],
      discoveryFamily: "commentary",
    });

    expect(routePublication(ambiguousIndependentPost)).toBeNull();
  });

  it("does not let catalog eligibility alone route a governance post", () => {
    const disallowed = publication({
      title: "AI regulation and legal enforcement update",
      sectionEligibility: ["research", "research_radar", "technology"],
      discoveryFamily: "commentary",
    });

    expect(routePublication(disallowed)?.metadata.primarySection).not.toBe("ai_policy");
  });

  it("routes or excludes every publication before item normalization", async () => {
    const technical = publication({
      title: "A method for mechanistic interpretability",
      abstract: "We study internal representations and report an alignment result.",
      relatedPaperIds: ["arXiv:2608.00001"],
    });
    const governance = publication({
      title: "AI oversight standard and regulatory accountability framework",
      abstract: "An official evaluation-policy update.",
      originalUrl: "https://www.anthropic.com/research/oversight-standard",
      externalId: "https://www.anthropic.com/research/oversight-standard",
      externalIds: ["https://www.anthropic.com/research/oversight-standard"],
    });
    const ambiguous = publication({
      sourceId: "lesswrong-curated",
      sourceName: "LessWrong Curated",
      originalUrl: "https://www.lesswrong.com/posts/example/thoughts",
      externalId: "lw-thoughts",
      externalIds: ["lw-thoughts"],
      title: "Some thoughts from this week",
      sectionEligibility: ["research", "research_radar"],
      discoveryFamily: "commentary",
    });
    const provider = {} as never;
    const context = createProductionPipelineContext({
      editionDate: "2026-08-02",
      runId: "publication-routing-boundary",
      store: {} as PipelineStore,
      now: () => "2026-08-02T09:00:00.000Z",
      providers: { summary: provider, assessment: provider },
      collectCandidates: async () => [technical, governance, ambiguous],
    });

    const normalized = await context.normalize(await context.collect());

    expect(normalized.map((item) => item.kind)).toEqual(["paper", "article"]);
    expect(normalized.every((item) => item.kind !== ("publication" as never))).toBe(true);
    expect(normalized[0]?.metadata.workflow).toMatchObject({
      rawResearch: { kind: "paper", externalId: "arXiv:2608.00001" },
    });
  });
});
