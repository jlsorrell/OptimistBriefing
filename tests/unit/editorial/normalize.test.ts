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
