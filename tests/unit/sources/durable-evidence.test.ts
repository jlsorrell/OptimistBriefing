import { describe, expect, it } from "vitest";

import { durableCollectedCandidate } from "../../../src/sources/durable-evidence";
import type {
  RawNewsCandidate,
  RawResearchCandidate,
} from "../../../src/sources/types";

function rawNewsCandidate(
  overrides: Partial<RawNewsCandidate> = {},
): RawNewsCandidate {
  return {
    kind: "article",
    sourceId: "reuters",
    sourceName: "Reuters",
    sourceRole: "reporting",
    title: "A durable evidence boundary",
    originalUrl: "https://example.com/durable-evidence",
    externalId: "reuters:durable-evidence",
    externalIds: ["reuters:durable-evidence"],
    publishedAt: "2026-07-30T08:00:00.000Z",
    retrievedAt: "2026-07-30T08:30:00.000Z",
    accessLevel: "full_text",
    authors: [],
    institutions: [],
    abstract: "A short article abstract.",
    content: null,
    relatedPaperIds: [],
    metadata: {},
    canCorroborateFacts: true,
    sectionEligibility: ["world"],
    namedEntities: [],
    primaryDocumentUrl: null,
    primaryDocumentUrls: [],
    eventFamilies: [],
    materialFacts: [],
    ...overrides,
  };
}

function rawResearchCandidate(
  overrides: Partial<RawResearchCandidate> = {},
): RawResearchCandidate {
  return {
    kind: "paper",
    sourceId: "arxiv",
    sourceName: "arXiv",
    sourceRole: "primary",
    title: "A paper with permissible full text",
    originalUrl: "https://arxiv.org/abs/2607.12345",
    externalId: "arXiv:2607.12345",
    externalIds: ["arXiv:2607.12345"],
    publishedAt: "2026-07-30T08:00:00.000Z",
    retrievedAt: "2026-07-30T08:30:00.000Z",
    accessLevel: "full_text",
    authors: [],
    institutions: [],
    abstract: "A paper abstract.",
    content: "The permitted paper body.",
    relatedPaperIds: [],
    metadata: { retention: "durable" },
    preferredInstitutionMatches: [],
    citationCount: null,
    influentialCitationCount: null,
    topics: [],
    ...overrides,
  };
}

describe("durableCollectedCandidate", () => {
  it("replaces an ephemeral article body with a bounded durable excerpt", () => {
    const body = `${"evidence ".repeat(260)}COPYRIGHTED_BODY_TAIL`;
    const durable = durableCollectedCandidate(rawNewsCandidate({
      abstract: null,
      content: body,
      metadata: { retention: "ephemeral-only" },
    }));

    expect(durable.content).toBeNull();
    expect(durable.abstract).not.toContain("COPYRIGHTED_BODY_TAIL");
    expect([...durable.abstract!]).toHaveLength(2_000);
    expect(durable.metadata).toMatchObject({
      retention: "ephemeral-only",
      durableEvidence: true,
    });
  });

  it("leaves non-ephemeral paper content unchanged", () => {
    const candidate = rawResearchCandidate();

    expect(durableCollectedCandidate(candidate)).toBe(candidate);
  });

  it("normalizes whitespace before bounding the durable excerpt by code points", () => {
    const durable = durableCollectedCandidate(rawNewsCandidate({
      abstract: null,
      content: `  ${"😀\n ".repeat(2_000)}  `,
      metadata: { retention: "ephemeral-only" },
    }));

    expect(durable.abstract).toBe("😀 ".repeat(1_000));
    expect([...durable.abstract!]).toHaveLength(2_000);
  });
});
