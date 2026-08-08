import { describe, expect, it } from "vitest";

import {
  InvalidRequiredProviderDisplayTextError,
  normalizeCandidate,
} from "../../../src/editorial/normalize";
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
  it.each(["title", "sourceName"] as const)(
    "identifies an empty required provider %s",
    (field) => {
      let observed: unknown;
      try {
        normalizeCandidate(candidate({ [field]: "&#32;" }));
      } catch (error) {
        observed = error;
      }

      expect(observed).toBeInstanceOf(
        InvalidRequiredProviderDisplayTextError,
      );
      expect(
        (observed as InvalidRequiredProviderDisplayTextError).field,
      ).toBe(field);
    },
  );

  it.each(["title", "sourceName"] as const)(
    "rejects encoded tag-only required provider %s text",
    (field) => {
      let observed: unknown;
      try {
        normalizeCandidate(candidate({ [field]: "&lt;br&gt;" }));
      } catch (error) {
        observed = error;
      }

      expect(observed).toBeInstanceOf(
        InvalidRequiredProviderDisplayTextError,
      );
      expect(
        (observed as InvalidRequiredProviderDisplayTextError).field,
      ).toBe(field);
    },
  );

  it.each(["title", "sourceName"] as const)(
    "rejects compatibility-created tag-only required provider %s text",
    (field) => {
      let observed: unknown;
      try {
        normalizeCandidate(candidate({
          [field]: "&#65308;br&#65310;",
        }));
      } catch (error) {
        observed = error;
      }

      expect(observed).toBeInstanceOf(
        InvalidRequiredProviderDisplayTextError,
      );
      expect(
        (observed as InvalidRequiredProviderDisplayTextError).field,
      ).toBe(field);
    },
  );

  it("decodes fullwidth ampersand entity syntax within the two-pass budget", () => {
    const normalized = normalizeCandidate(candidate({
      title: "Compatibility ＆#8217; title",
      sourceName: "Compatibility ＆amp;#8217; source",
      abstract: "Compatibility ＆#8217; evidence",
    }));

    expect(normalized.title).toBe("Compatibility ’ title");
    expect(normalized.sourceRefs[0]?.name).toBe("Compatibility ’ source");
    expect(normalized.normalizedText).toBe("Compatibility ’ evidence");
  });

  it("decodes and strips encoded wrappers from provider display and evidence", () => {
    const originalUrl =
      "https://custom.example/research?label=%26lt%3Bbr%26gt%3B";
    const normalized = normalizeCandidate(candidate({
      kind: "blog",
      sourceId: "custom-＆#8217;",
      title:
        "&#65308;script&#65310;Useful title&#65308;/script&#65310;",
      sourceName: "&#65308;em&#65310;Useful source&#65308;/em&#65310;",
      originalUrl,
      externalId: "custom:useful-title",
      externalIds: ["custom:useful-title"],
      authors: [
        "&#65308;strong&#65310;Useful author&#65308;/strong&#65310;",
      ],
      abstract: "&#65308;p&#65310;Useful evidence&#65308;/p&#65310;",
      metadata: {
        discoveryFamily: "custom",
        venue: "&#65308;em&#65310;Useful venue&#65308;/em&#65310;",
        structuralId: "structural-＆#8217;",
      },
    }));

    expect(normalized.title).toBe("Useful title");
    expect(normalized.sourceRefs[0]?.name).toBe("Useful source");
    expect(normalized.sourceRefs[0]?.id).toBe("custom-＆#8217;");
    expect(normalized.normalizedText).toBe("Useful evidence");
    expect(normalized.metadata.authors).toEqual(["Useful author"]);
    expect(normalized.metadata.venue).toBe("Useful venue");
    expect(normalized.metadata.structuralId).toBe("structural-＆#8217;");
    expect(normalized.canonicalUrl).toBe(originalUrl);
    expect(JSON.stringify(normalized)).not.toMatch(
      /<(?:script|em|strong|p)>/i,
    );
  });

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

  it("keeps a third-layer entity inert in the prepared title key", () => {
    const normalized = normalizeCandidate(candidate({
      title: "Interpretability &amp;amp;#8217; boundary",
    }));

    expect(normalized.title).toBe("Interpretability &#8217; boundary");
    expect(normalized.metadata.normalizedTitle).toBe(
      "interpretability 8217 boundary",
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
