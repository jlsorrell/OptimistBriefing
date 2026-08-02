import { describe, expect, it } from "vitest";

import { normalizeCandidate } from "../../../src/editorial/normalize";
import {
  canonicalResearchIdentity,
  consolidateResearchCandidates,
} from "../../../src/editorial/research-identity";
import type { Item } from "../../../src/contracts/editorial";
import type { RawResearchCandidate } from "../../../src/sources/types";

function rawResearch(
  sourceId: string,
  overrides: Partial<RawResearchCandidate> = {},
): RawResearchCandidate {
  const base: RawResearchCandidate = {
    kind: "paper",
    sourceId,
    sourceName: sourceId,
    sourceRole: sourceId === "arxiv" ? "primary" : "analysis",
    title: "Debate as a mechanism for scalable oversight",
    originalUrl: `https://${sourceId}.example.org/paper`,
    externalId: `${sourceId}:paper-1`,
    externalIds: [`${sourceId}:paper-1`],
    publishedAt: "2026-08-01T12:00:00.000Z",
    retrievedAt: "2026-08-02T09:00:00.000Z",
    accessLevel: "abstract",
    authors: ["Ada Example"],
    institutions: [],
    abstract: "The paper establishes a bounded oversight result.",
    content: null,
    relatedPaperIds: [],
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics: ["scalable oversight"],
    metadata: { discoveryFamily: "bibliographic" },
  };
  return { ...base, ...overrides };
}

function normalized(
  sourceId: string,
  overrides: Partial<RawResearchCandidate> = {},
): Item {
  return normalizeCandidate(rawResearch(sourceId, overrides));
}

describe("canonicalResearchIdentity", () => {
  it("prioritizes arXiv, DOI, recognized provider IDs, then canonical URL", () => {
    expect(canonicalResearchIdentity(normalized("arxiv", {
      externalIds: [
        "DOI:10.1000/DEBATE",
        "SemanticScholar:S2-DEBATE",
        "arXiv:2608.00001v3",
      ],
    }))).toBe("arxiv:2608.00001");
    expect(canonicalResearchIdentity(normalized("crossref", {
      externalId: "DOI:10.1000/DEBATE",
      externalIds: ["DOI:10.1000/DEBATE"],
    }))).toBe("doi:10.1000/debate");
    expect(canonicalResearchIdentity(normalized("provider", {
      externalId: "SemanticScholar:S2-DEBATE",
      externalIds: ["SemanticScholar:S2-DEBATE", "OpenAlex:W123"],
    }))).toBe("openalex:W123");
    expect(canonicalResearchIdentity(normalized("publisher", {
      externalId: "publisher:paper-1",
      externalIds: ["publisher:paper-1"],
      originalUrl: "https://publisher.example.org/papers/1?utm_source=rss",
    }))).toBe("https://publisher.example.org/papers/1");
  });
});

describe("consolidateResearchCandidates", () => {
  it("joins paper records by arXiv, DOI, provider mapping, and canonical URL", () => {
    const pairs: [Item, Item][] = [
      [
        normalized("arxiv", {
          externalIds: ["arXiv:2608.00001"],
        }),
        normalized("semantic-scholar", {
          externalId: "SemanticScholar:S2-A",
          externalIds: ["SemanticScholar:S2-A", "arXiv:2608.00001v2"],
        }),
      ],
      [
        normalized("crossref", {
          externalId: "DOI:10.1000/DEBATE",
          externalIds: ["DOI:10.1000/DEBATE"],
        }),
        normalized("openalex", {
          externalId: "OpenAlex:W-DOI",
          externalIds: ["OpenAlex:W-DOI", "https://doi.org/10.1000/debate"],
        }),
      ],
      [
        normalized("provider-a", {
          externalId: "SemanticScholar:S2-SHARED",
          externalIds: ["SemanticScholar:S2-SHARED"],
        }),
        normalized("provider-b", {
          externalId: "SemanticScholar:S2-SHARED",
          externalIds: ["SemanticScholar:S2-SHARED"],
          originalUrl: "https://other.example.org/paper",
        }),
      ],
      [
        normalized("publisher-a", {
          originalUrl: "https://publisher.example.org/paper/1?utm_source=a",
        }),
        normalized("publisher-b", {
          originalUrl: "https://publisher.example.org/paper/1#abstract",
        }),
      ],
    ];

    for (const pair of pairs) {
      const result = consolidateResearchCandidates(pair);
      expect(result.papers).toHaveLength(1);
      expect(result.merges).toHaveLength(1);
    }
  });

  it("uses an exact normalized title only when at least one author overlaps", () => {
    const first = normalized("first", {
      title: "Mechanistic Interpretability: A Causal View",
      authors: ["Ada Example"],
      originalUrl: "https://first.example.org/work",
    });
    const matchingAuthor = normalized("second", {
      title: "  Mechanistic interpretability — a causal view ",
      authors: ["ADA EXAMPLE"],
      originalUrl: "https://second.example.org/work",
    });
    const unrelatedAuthor = normalized("third", {
      title: "Mechanistic Interpretability: A Causal View",
      authors: ["Grace Different"],
      originalUrl: "https://third.example.org/work",
    });

    const joined = consolidateResearchCandidates([first, matchingAuthor]);
    expect(joined.papers).toHaveLength(1);
    expect(consolidateResearchCandidates([first, unrelatedAuthor]).papers)
      .toHaveLength(2);
  });

  it("attaches explicit commentary without replacing paper text or access", () => {
    const paper = normalized("arxiv", {
      externalId: "arXiv:2608.00001",
      externalIds: ["arXiv:2608.00001"],
      accessLevel: "abstract",
      abstract: "Primary abstract evidence.",
      metadata: { discoveryFamily: "arxiv" },
    });
    const commentary = normalized("alignment-forum", {
      kind: "blog",
      sourceRole: "blog",
      title: "Why the debate result may not generalize",
      originalUrl: "https://www.alignmentforum.org/posts/commentary",
      externalId: "alignment-forum:commentary",
      externalIds: ["alignment-forum:commentary"],
      accessLevel: "full_text",
      abstract: null,
      content: "This commentary critiques the result and its assumptions.",
      relatedPaperIds: ["https://arxiv.org/abs/2608.00001v2"],
      metadata: { discoveryFamily: "commentary" },
    });

    const consolidated = consolidateResearchCandidates([commentary, paper]);

    expect(consolidated.papers).toHaveLength(1);
    expect(consolidated.papers[0]).toMatchObject({
      accessLevel: "abstract",
      normalizedText: "Primary abstract evidence.",
      metadata: {
        primaryResearchSourceIds: ["arxiv"],
        attachedCommentary: [expect.objectContaining({
          sourceId: "alignment-forum",
          role: "blog",
          title: "Why the debate result may not generalize",
          url: "https://www.alignmentforum.org/posts/commentary",
          retrievedAt: "2026-08-02T09:00:00.000Z",
          accessLevel: "full_text",
          excerpt: "This commentary critiques the result and its assumptions.",
          relatedPaperIds: ["arXiv:2608.00001"],
        })],
      },
    });
    expect(consolidated.papers[0]?.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "arxiv", role: "primary" }),
        expect.objectContaining({ id: "alignment-forum", role: "blog" }),
      ]),
    );
    expect(consolidated.standaloneCommentary).toHaveLength(0);
  });

  it("attaches title-and-author commentary and retains substantive unlinked posts", () => {
    const paper = normalized("arxiv", {
      externalId: "arXiv:2608.00002",
      externalIds: ["arXiv:2608.00002"],
    });
    const linkedByTitle = normalized("lesswrong-curated", {
      kind: "blog",
      sourceRole: "blog",
      originalUrl: "https://www.lesswrong.com/posts/matching",
      externalId: "lesswrong:matching",
      externalIds: ["lesswrong:matching"],
      authors: ["ada example"],
      content: "An independent interpretation of the oversight result.",
      abstract: null,
      metadata: { discoveryFamily: "commentary" },
    });
    const unlinked = normalized("independent-blog", {
      kind: "blog",
      sourceRole: "blog",
      title: "A different research agenda",
      originalUrl: "https://blog.example.org/different",
      externalId: "blog:different",
      externalIds: ["blog:different"],
      authors: ["Grace Different"],
      content: "A substantive essay about a separate research direction.",
      abstract: null,
      metadata: { discoveryFamily: "commentary" },
    });

    const result = consolidateResearchCandidates([
      unlinked,
      linkedByTitle,
      paper,
    ]);

    expect(result.papers[0]?.metadata.attachedCommentary).toEqual([
      expect.objectContaining({ sourceId: "lesswrong-curated" }),
    ]);
    expect(result.standaloneCommentary).toEqual([
      expect.objectContaining({ id: unlinked.id, kind: "blog" }),
    ]);
  });

  it("is stable across input order and stores all merged paper sources", () => {
    const arxiv = normalized("arxiv", {
      externalId: "arXiv:2608.00003",
      externalIds: ["arXiv:2608.00003"],
      metadata: { discoveryFamily: "arxiv" },
    });
    const openalex = normalized("openalex", {
      externalId: "OpenAlex:W3",
      externalIds: ["OpenAlex:W3", "arXiv:2608.00003"],
      metadata: { discoveryFamily: "bibliographic" },
    });

    const forward = consolidateResearchCandidates([arxiv, openalex]);
    const reverse = consolidateResearchCandidates([openalex, arxiv]);

    expect(forward).toEqual(reverse);
    expect(forward.papers[0]?.sourceRefs.map(({ id }) => id)).toEqual([
      "arxiv",
      "openalex",
    ]);
    expect(forward.papers[0]?.metadata.primaryResearchSourceIds).toEqual([
      "arxiv",
      "openalex",
    ]);
  });
});
