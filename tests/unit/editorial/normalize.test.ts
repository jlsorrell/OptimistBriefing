import { describe, expect, it } from "vitest";

import { normalizeCandidate } from "../../../src/editorial/normalize";
import type { RawResearchCandidate } from "../../../src/sources/types";

function candidate(
  overrides: Partial<RawResearchCandidate> = {},
): RawResearchCandidate {
  const base: RawResearchCandidate = {
    kind: "paper",
    sourceId: "arxiv",
    sourceName: "arXiv",
    sourceRole: "primary",
    title: "A normalized paper",
    originalUrl: "https://arxiv.org/abs/2608.00001v2",
    externalId: "arXiv:2608.00001v2",
    externalIds: ["arXiv:2608.00001v2"],
    publishedAt: "2026-08-01T12:00:00.000Z",
    retrievedAt: "2026-08-02T09:00:00.000Z",
    accessLevel: "abstract",
    authors: ["  AdA  Example ", "Grace O’Example"],
    institutions: [],
    abstract: "Normalized evidence.",
    content: null,
    relatedPaperIds: [],
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics: [],
    metadata: { discoveryFamily: "arxiv" },
  };
  return { ...base, ...overrides };
}

describe("research normalization", () => {
  it("decodes provider entities before normalized items are persisted", () => {
    const normalized = normalizeCandidate(candidate({
      title: "Inspector finds &#8216;systemic breakdown&#8217;",
      abstract: "It&amp;#8217;s documented in yesterday&#8217;s report.",
    }));

    expect(normalized.title).toBe("Inspector finds ‘systemic breakdown’");
    expect(normalized.normalizedText).toContain(
      "It’s documented in yesterday’s report.",
    );
    expect(JSON.stringify(normalized)).not.toMatch(
      /&#(?:x[0-9a-f]+|[0-9]+);/i,
    );
  });

  it("keeps entity-like primary document URLs structural before canonicalization", () => {
    const normalized = normalizeCandidate(candidate({
      metadata: {
        discoveryFamily: "arxiv",
        primaryDocumentUrls: [
          "https://agency.example/reports?label=encoded&amp;next=keep",
        ],
      },
    }));

    expect(normalized.metadata.primaryDocumentUrls).toEqual([
      "https://agency.example/reports?amp%3Bnext=keep&label=encoded",
    ]);
  });

  it("does not decode structural section metadata into a classification", () => {
    const normalized = normalizeCandidate(candidate({
      metadata: {
        discoveryFamily: "arxiv",
        primarySection: "&#114;esearch",
      },
    }));

    expect(normalized.primaryTopic).toBe("general");
    expect(normalized.tags).not.toContain("research");
    expect(normalized.metadata.primarySection).toBe("&#114;esearch");
  });

  it("uses decoded provider abstracts to map research topics", () => {
    const normalized = normalizeCandidate(candidate({
      abstract: "The report studies &#115;ecure computation.",
    }));

    expect(normalized.metadata.configuredTopics).toContain(
      "secure-computation-ml",
    );
  });

  it("decodes provider topic arrays before mapping and persistence", () => {
    const normalized = normalizeCandidate(candidate({
      topics: ["&#115;ecure computation"],
    }));

    expect(normalized.metadata.providerTopics).toEqual([
      "secure computation",
    ]);
    expect(normalized.metadata.configuredTopics).toContain(
      "secure-computation-ml",
    );
  });

  it("fails closed for selected blank evidence while falling back for absent evidence", () => {
    const blankAbstract = normalizeCandidate(candidate({
      abstract: "   ",
      content: null,
    }));
    const absentEvidence = normalizeCandidate(candidate({
      abstract: null,
      content: null,
    }));

    expect(blankAbstract.normalizedText).toBe("");
    expect(absentEvidence.normalizedText).toBe("A normalized paper");
  });

  it("stores conservative author keys and primary research source IDs", () => {
    const paper = normalizeCandidate(candidate());
    const commentary = normalizeCandidate(candidate({
      kind: "blog",
      sourceId: "alignment-forum",
      sourceName: "Alignment Forum",
      sourceRole: "blog",
      originalUrl: "https://www.alignmentforum.org/posts/example",
      externalId: "alignment-forum:example",
      externalIds: ["alignment-forum:example"],
      relatedPaperIds: ["https://arxiv.org/abs/2608.00001v4"],
      metadata: { discoveryFamily: "commentary" },
    }));

    expect(paper.metadata.normalizedAuthors).toEqual([
      "ada example",
      "grace o example",
    ]);
    expect(paper.metadata.primaryResearchSourceIds).toEqual(["arxiv"]);
    expect(commentary.metadata.primaryResearchSourceIds).toEqual([]);
    expect(commentary.metadata.relatedPaperIds).toEqual([
      "arXiv:2608.00001",
    ]);
  });
});
