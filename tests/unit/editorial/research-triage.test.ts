import { describe, expect, it } from "vitest";

import type { Item } from "../../../src/contracts/editorial";
import {
  boundResearchDiscoveryPool,
  classifyDiscoveryWindow,
  classifyDiscoveryWindowDecision,
  researchFingerprints,
  triageResearch,
} from "../../../src/editorial/research-triage";
import { CONFIGURED_RESEARCH_TOPIC_IDS } from "../../../src/editorial/research-topics";
import type { DiscoveryFamily } from "../../../src/sources/types";

const NOW = "2026-08-02T12:00:00.000Z";
const FAMILIES: readonly DiscoveryFamily[] = [
  "arxiv",
  "bibliographic",
  "official-publication",
  "commentary",
];

function researchItem(
  id: string,
  options: {
    family?: DiscoveryFamily;
    topicalFit?: number;
    publishedAt?: string;
    updatedAt?: string;
    domain?: string;
    topics?: readonly string[];
    title?: string;
    preferredInstitution?: boolean;
    normalizedText?: string;
    sourceId?: string;
    contentFingerprint?: string;
    evidenceFingerprint?: string;
  } = {},
): Item {
  const family = options.family ?? "arxiv";
  const domain = options.domain ?? `${family}.example`;
  const topicalFit = options.topicalFit ?? 0.8;
  const topics = options.topics ?? [CONFIGURED_RESEARCH_TOPIC_IDS[0]];
  const title = options.title ?? `Research candidate ${id}`;
  const preferredInstitutionMatches = options.preferredInstitution
    ? ["Stanford"]
    : [];
  const sourceId = options.sourceId ?? `${family}-${id}`;
  return {
    id,
    kind: "paper",
    canonicalUrl: `https://${domain}/papers/${id}`,
    title,
    publishedAt: options.publishedAt ?? "2026-08-02T08:00:00.000Z",
    sourceRefs: [{
      id: sourceId,
      name: `${family} source`,
      url: `https://${domain}/papers/${id}`,
      role: "primary",
      retrievedAt: NOW,
    }],
    accessLevel: "abstract",
    primaryTopic: topics[0] ?? "research",
    tags: [...topics],
    normalizedText:
      options.normalizedText ?? "Substantive methods, evidence, and results.",
    metadata: {
      discoveryFamily: family,
      configuredTopics: [...topics],
      publisherDomain: domain,
      ...(options.contentFingerprint === undefined
        ? {}
        : { contentFingerprint: options.contentFingerprint }),
      ...(options.evidenceFingerprint === undefined
        ? {}
        : { evidenceFingerprint: options.evidenceFingerprint }),
      ...(options.updatedAt === undefined
        ? {}
        : { updatedAt: options.updatedAt }),
      workflow: {
        version: 1,
        topicalFit,
        rawResearch: {
          kind: "paper",
          sourceId,
          sourceName: `${family} source`,
          sourceRole: "primary",
          title,
          originalUrl: `https://${domain}/papers/${id}`,
          externalId: id,
          externalIds: [id],
          publishedAt: options.publishedAt ?? "2026-08-02T08:00:00.000Z",
          retrievedAt: NOW,
          accessLevel: "abstract",
          authors: ["Researcher Example"],
          institutions: preferredInstitutionMatches,
          abstract: "Substantive methods, evidence, and results.",
          content: null,
          relatedPaperIds: [],
          metadata: { discoveryFamily: family },
          preferredInstitutionMatches,
          citationCount: 0,
          influentialCitationCount: 0,
          topics: [...topics],
        },
      },
    },
    createdAt: NOW,
    expiresAt: null,
  };
}

function familyCounts(items: readonly Item[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const family = String(item.metadata.discoveryFamily);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return counts;
}

function domainCounts(items: readonly Item[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const domain = String(item.metadata.publisherDomain);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

describe("boundResearchDiscoveryPool", () => {
  it("reserves all four discovery families inside the shared 500-candidate cap", () => {
    const candidates = FAMILIES.flatMap((family, familyIndex) =>
      Array.from({ length: 200 }, (_, index) =>
        researchItem(`${familyIndex}-${String(index).padStart(3, "0")}`, {
          family,
          publishedAt: new Date(
            Date.parse(NOW) - (familyIndex * 200 + index) * 60_000,
          ).toISOString(),
        })
      )
    );

    const bounded = boundResearchDiscoveryPool(candidates);

    expect(bounded).toHaveLength(500);
    expect(Object.fromEntries(familyCounts(bounded))).toEqual({
      arxiv: 125,
      bibliographic: 125,
      "official-publication": 125,
      commentary: 125,
    });
  });

  it("releases unused family reservations to the strongest remaining candidates", () => {
    const sparse = FAMILIES.slice(1).flatMap((family, familyIndex) =>
      Array.from({ length: 10 }, (_, index) =>
        researchItem(`sparse-${familyIndex}-${index}`, { family })
      )
    );
    const dominant = Array.from({ length: 600 }, (_, index) =>
      researchItem(`arxiv-${String(index).padStart(3, "0")}`, {
        family: "arxiv",
        publishedAt: new Date(Date.parse(NOW) - index * 60_000).toISOString(),
      })
    );

    const bounded = boundResearchDiscoveryPool([...dominant, ...sparse]);

    expect(bounded).toHaveLength(500);
    expect(familyCounts(bounded).get("arxiv")).toBe(470);
    for (const family of FAMILIES.slice(1)) {
      expect(familyCounts(bounded).get(family)).toBe(10);
    }
  });

  it("uses recency, bounded priors, and stable identity independent of arrival order", () => {
    const candidates = [
      researchItem("stable-b", { publishedAt: "2026-08-01T12:00:00.000Z" }),
      researchItem("preferred", {
        publishedAt: "2026-08-01T12:00:00.000Z",
        preferredInstitution: true,
      }),
      researchItem("newest", { updatedAt: "2026-08-02T11:00:00.000Z" }),
      researchItem("stable-a", { publishedAt: "2026-08-01T12:00:00.000Z" }),
    ];

    expect(boundResearchDiscoveryPool(candidates, 4).map(({ id }) => id))
      .toEqual(["newest", "preferred", "stable-a", "stable-b"]);
    expect(boundResearchDiscoveryPool([...candidates].reverse(), 4).map(({ id }) => id))
      .toEqual(["newest", "preferred", "stable-a", "stable-b"]);
  });

  it("bounds candidate occurrences without deduplicating repeated item IDs", () => {
    const repeated = researchItem("repeated");

    expect(boundResearchDiscoveryPool([repeated, structuredClone(repeated)], 2))
      .toHaveLength(2);
  });
});

describe("classifyDiscoveryWindow", () => {
  const fourDaysOld = "2026-07-29T12:00:00.000Z";
  const eightDaysOld = "2026-07-25T12:00:00.000Z";
  const current = researchItem("windowed", {
    publishedAt: fourDaysOld,
    contentFingerprint: "content:v1",
    evidenceFingerprint: "evidence:v1",
  });
  const prior = {
    runId: "prior-run",
    canonicalId: "https://arxiv.example/papers/windowed",
    sourceId: "arxiv-prior",
    discoveryFamily: "arxiv" as const,
    windowKind: "fresh" as const,
    publishedAt: fourDaysOld,
    retrievedAt: "2026-07-29T13:00:00.000Z",
    observedAt: "2026-07-29T13:00:00.000Z",
    contentFingerprint: "content:v1",
    evidenceFingerprint: "evidence:v1",
    joinedExternalIds: ["windowed"],
    route: "research" as const,
    expiresAt: "2026-08-05T13:00:00.000Z",
  };

  it("labels candidates inside 36 hours fresh", () => {
    expect(classifyDiscoveryWindow(researchItem("fresh", {
      publishedAt: "2026-08-01T01:00:00.000Z",
      contentFingerprint: "content:fresh",
      evidenceFingerprint: "evidence:fresh",
    }), [], NOW)).toBe("fresh");
  });

  it("excludes unchanged older candidates and material outside seven days", () => {
    expect(classifyDiscoveryWindow(current, [prior], NOW)).toBeNull();
    expect(classifyDiscoveryWindow(researchItem("expired", {
      publishedAt: eightDaysOld,
      contentFingerprint: "content:new",
      evidenceFingerprint: "evidence:new",
    }), [], NOW)).toBeNull();
  });

  it("returns an out-of-window window decision outside seven days", () => {
    const expired = researchItem("expired-decision", {
      publishedAt: eightDaysOld,
      contentFingerprint: "content:new",
      evidenceFingerprint: "evidence:new",
    });

    expect(classifyDiscoveryWindowDecision(expired, [], NOW)).toEqual({
      windowKind: null,
      rejectionReason: "out_of_window",
    });
    expect(classifyDiscoveryWindow(expired, [], NOW)).toBeNull();
  });

  it("returns an unchanged-observation window decision for repeated evidence", () => {
    expect(classifyDiscoveryWindowDecision(current, [prior], NOW)).toEqual({
      windowKind: null,
      rejectionReason: "unchanged_observation",
    });
    expect(classifyDiscoveryWindow(current, [prior], NOW)).toBeNull();
  });

  it.each([
    ["content:v2", "evidence:v1"],
    ["content:v1", "evidence:v2"],
  ])("reconsiders an older candidate with changed %s / %s fingerprints", (
    contentFingerprint,
    evidenceFingerprint,
  ) => {
    const changed = researchItem("windowed", {
      publishedAt: fourDaysOld,
      contentFingerprint,
      evidenceFingerprint,
    });

    expect(classifyDiscoveryWindow(changed, [prior], NOW))
      .toBe("reconsideration");
  });

  it("does not treat a changed discovery source as changed evidence", () => {
    const changedSource = researchItem("windowed", {
      family: "bibliographic",
      sourceId: "openalex-new-source",
      domain: "arxiv.example",
      publishedAt: fourDaysOld,
      contentFingerprint: "content:v1",
      evidenceFingerprint: "evidence:v1",
    });

    expect(classifyDiscoveryWindow(changedSource, [prior], NOW)).toBeNull();
  });

  it("derives stable fingerprints without discovery-source identity", () => {
    const first = researchItem("fingerprint", {
      family: "arxiv",
      sourceId: "arxiv-source",
    });
    const second = researchItem("fingerprint", {
      family: "bibliographic",
      sourceId: "openalex-source",
    });
    second.canonicalUrl = first.canonicalUrl;
    second.sourceRefs[0] = {
      ...second.sourceRefs[0]!,
      url: first.sourceRefs[0]!.url,
    };
    const secondWorkflow = second.metadata.workflow as {
      rawResearch: Record<string, unknown>;
    };
    secondWorkflow.rawResearch = {
      ...secondWorkflow.rawResearch,
      sourceId: "openalex-source",
      sourceName: "OpenAlex",
      metadata: { discoveryFamily: "bibliographic" },
      originalUrl: first.canonicalUrl,
    };

    expect(researchFingerprints(first)).toEqual(researchFingerprints(second));
  });

  it("keeps evidence fingerprints stable across commentary retrieval timestamps", () => {
    const first = researchItem("commentary-timestamp");
    first.metadata.attachedCommentary = [{
      sourceId: "alignment-forum",
      role: "blog",
      title: "A careful interpretation",
      url: "https://www.alignmentforum.org/posts/example/interpretation",
      retrievedAt: "2026-08-01T08:00:00.000Z",
      observedAt: "2026-08-01T08:01:00.000Z",
      accessLevel: "full_text",
      excerpt: "The commentary critiques the result's external validity.",
      relatedPaperIds: ["arXiv:2608.00001"],
    }];
    const timestampOnly = structuredClone(first);
    timestampOnly.metadata.attachedCommentary = [{
      ...(timestampOnly.metadata.attachedCommentary as Array<
        Record<string, unknown>
      >)[0],
      retrievedAt: "2026-08-02T11:00:00.000Z",
      observedAt: "2026-08-02T11:01:00.000Z",
      lastSeenAt: "2026-08-02T11:02:00.000Z",
    }];

    expect(researchFingerprints(timestampOnly)).toEqual(
      researchFingerprints(first),
    );
  });

  it("changes evidence fingerprints for commentary content and implementation evidence", () => {
    const first = researchItem("commentary-evidence");
    first.metadata.attachedCommentary = [{
      sourceId: "alignment-forum",
      role: "blog",
      title: "A careful interpretation",
      url: "https://www.alignmentforum.org/posts/example/interpretation",
      retrievedAt: "2026-08-01T08:00:00.000Z",
      accessLevel: "full_text",
      excerpt: "The commentary critiques the result's external validity.",
      relatedPaperIds: ["arXiv:2608.00001"],
    }];
    const changedContent = structuredClone(first);
    changedContent.metadata.attachedCommentary = [{
      ...(changedContent.metadata.attachedCommentary as Array<
        Record<string, unknown>
      >)[0],
      excerpt: "The commentary now reports an independent replication.",
    }];
    const implementationLocated = structuredClone(first);
    implementationLocated.metadata.attachedCommentary = [{
      ...(implementationLocated.metadata.attachedCommentary as Array<
        Record<string, unknown>
      >)[0],
      implementationAvailable: true,
    }];

    expect(researchFingerprints(changedContent).evidenceFingerprint)
      .not.toBe(researchFingerprints(first).evidenceFingerprint);
    expect(researchFingerprints(implementationLocated).evidenceFingerprint)
      .not.toBe(researchFingerprints(first).evidenceFingerprint);
  });

  it("invalidates the assessment-cache fingerprint when paper content changes", () => {
    const first = researchItem("content-cache");
    const revised = researchItem("content-cache", {
      normalizedText: "Revised substantive methods, evidence, and results.",
    });

    expect(researchFingerprints(revised).contentFingerprint)
      .not.toBe(researchFingerprints(first).contentFingerprint);
    expect(researchFingerprints(revised).evidenceFingerprint)
      .not.toBe(researchFingerprints(first).evidenceFingerprint);
  });
});

describe("triageResearch", () => {
  describe("fallback and near-match admission", () => {
    const fallbackOptions = {
      maximum: 24,
      maximumPerFamily: 12,
      maximumPerPublisherDomain: 6,
      configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
      now: NOW,
      fallbackTarget: 6,
      fallbackMinimumTopicalFit: 0.35,
    };

    it("fills a sparse normal queue with core then adjacent near-matches", () => {
      const normal = Array.from({ length: 4 }, (_, index) =>
        researchItem(`normal-${index}`, {
          topicalFit: 0.8 - index / 100,
          domain: `normal-${index}.example`,
        })
      );
      const core = researchItem("fallback-core", {
        topicalFit: 0.4,
        domain: "core.example",
        normalizedText: "Capability elicitation reveals hidden model abilities.",
      });
      const adjacent = researchItem("fallback-adjacent", {
        topicalFit: 0.49,
        domain: "adjacent.example",
        normalizedText: "A broad framework for AI safety and governance.",
      });

      const result = triageResearch([...normal, adjacent, core], fallbackOptions);

      expect(result.items.map(({ id }) => id)).toEqual([
        "normal-0",
        "normal-1",
        "normal-2",
        "normal-3",
        "fallback-core",
        "fallback-adjacent",
      ]);
      expect(result.admissions).toEqual([
        ...normal.map(({ id }) => ({ itemId: id, route: "normal" as const })),
        { itemId: "fallback-core", route: "near_match" },
        { itemId: "fallback-adjacent", route: "near_match" },
      ]);
    });

    it("applies the exact fallback and normal boundaries", () => {
      const result = triageResearch([
        researchItem("below", { topicalFit: 0.349999 }),
        researchItem("floor", { topicalFit: 0.35 }),
        researchItem("near", { topicalFit: 0.499999 }),
        researchItem("normal", { topicalFit: 0.5 }),
      ], fallbackOptions);

      expect(result.admissions).toEqual([
        { itemId: "normal", route: "normal" },
        { itemId: "near", route: "near_match" },
        { itemId: "floor", route: "near_match" },
      ]);
      expect(result.exclusions).toContainEqual({
        itemId: "below",
        reason: "below_topical_fit",
      });
    });

    it("does not use near-matches when six normal candidates meet the target", () => {
      const normal = Array.from({ length: 6 }, (_, index) =>
        researchItem(`normal-${index}`, {
          topicalFit: 0.8 - index / 100,
          domain: `normal-${index}.example`,
        })
      );
      const fallback = researchItem("fallback", {
        topicalFit: 0.49,
        domain: "fallback.example",
      });

      const result = triageResearch([...normal, fallback], fallbackOptions);

      expect(result.admissions).toEqual(
        normal.map(({ id }) => ({ itemId: id, route: "normal" })),
      );
    });

    it("admits at most six near-matches when no normal candidates qualify", () => {
      const candidates = Array.from({ length: 7 }, (_, index) =>
        researchItem(`fallback-${index}`, {
          topicalFit: 0.49,
          domain: `fallback-${index}.example`,
        })
      );

      const result = triageResearch(candidates, fallbackOptions);

      expect(result.items).toHaveLength(6);
      expect(result.admissions).toHaveLength(6);
      expect(result.admissions.every(({ route }) => route === "near_match"))
        .toBe(true);
    });

    it.each([
      ["without a configured topic", researchItem("no-topic", {
        topicalFit: 0.49,
        topics: [],
      })],
      ["below the fallback floor despite a preferred institution", researchItem("preferred-low", {
        topicalFit: 0.349999,
        preferredInstitution: true,
      })],
    ])("excludes a near-match %s", (_description, candidate) => {
      const result = triageResearch([candidate], fallbackOptions);

      expect(result.admissions).toEqual([]);
      expect(result.exclusions).toContainEqual({
        itemId: candidate.id,
        reason: "below_topical_fit",
      });
    });

    it("prioritizes a lower-scoring core near-match above an adjacent one", () => {
      const adjacent = researchItem("adjacent", {
        topicalFit: 0.49,
        domain: "adjacent.example",
        normalizedText: "A broad framework for AI safety and governance.",
      });
      const core = researchItem("core", {
        topicalFit: 0.4,
        domain: "core.example",
        normalizedText: "Capability elicitation reveals hidden model abilities.",
      });

      const result = triageResearch([adjacent, core], fallbackOptions);

      expect(result.items.map(({ id }) => id)).toEqual(["core", "adjacent"]);
      expect(result.admissions).toEqual([
        { itemId: "core", route: "near_match" },
        { itemId: "adjacent", route: "near_match" },
      ]);
    });

    it("keeps item and admission order stable when input is reversed", () => {
      const candidates = [
        researchItem("normal-a", { topicalFit: 0.8, domain: "normal-a.example" }),
        researchItem("normal-b", { topicalFit: 0.7, domain: "normal-b.example" }),
        researchItem("adjacent", {
          topicalFit: 0.49,
          domain: "adjacent.example",
          normalizedText: "A broad framework for AI safety and governance.",
        }),
        researchItem("core", {
          topicalFit: 0.4,
          domain: "core.example",
          normalizedText: "Capability elicitation reveals hidden model abilities.",
        }),
      ];

      const forward = triageResearch(candidates, fallbackOptions);
      const reversed = triageResearch([...candidates].reverse(), fallbackOptions);

      expect(reversed.items.map(({ id }) => id))
        .toEqual(forward.items.map(({ id }) => id));
      expect(reversed.admissions).toEqual(forward.admissions);
    });
  });

  it("filters empty and below-gate research with explicit exclusion reasons", () => {
    const result = triageResearch([
      researchItem("empty", { normalizedText: "   " }),
      researchItem("low-fit", { topicalFit: 0.49 }),
      researchItem("qualified", { topicalFit: 0.5 }),
    ], {
      maximum: 24,
      maximumPerFamily: 12,
      maximumPerPublisherDomain: 6,
      configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
      now: NOW,
    });

    expect(result.items.map(({ id }) => id)).toEqual(["qualified"]);
    expect(result.admissions).toEqual([
      { itemId: "qualified", route: "normal" },
    ]);
    expect(result.exclusions).toEqual(expect.arrayContaining([
      { itemId: "empty", reason: "invalid_content" },
      { itemId: "low-fit", reason: "below_topical_fit" },
    ]));
  });

  it("enforces the normal queue, family, and publisher caps", () => {
    const candidates = FAMILIES.flatMap((family, familyIndex) =>
      Array.from({ length: 10 }, (_, index) =>
        researchItem(`${familyIndex}-${String(index).padStart(2, "0")}`, {
          family,
          domain: `${family}-${index % 2}.example`,
          topicalFit: 1 - (familyIndex * 10 + index) / 100,
          topics: [
            CONFIGURED_RESEARCH_TOPIC_IDS[
              (familyIndex * 10 + index) % CONFIGURED_RESEARCH_TOPIC_IDS.length
            ]!,
          ],
        })
      )
    );

    const result = triageResearch(candidates, {
      maximum: 24,
      maximumPerFamily: 12,
      maximumPerPublisherDomain: 6,
      configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
      now: NOW,
    });

    expect(result.items).toHaveLength(24);
    expect(Math.max(...familyCounts(result.items).values())).toBeLessThanOrEqual(12);
    expect(Math.max(...domainCounts(result.items).values())).toBeLessThanOrEqual(6);
    expect(result.perFamilyCounts).toEqual(
      Object.fromEntries(familyCounts(result.items)),
    );
  });

  it.each([4, 0])("supports a budget-derived maximum of %i uncached candidates", (maximum) => {
    const result = triageResearch(
      Array.from({ length: 10 }, (_, index) =>
        researchItem(`budget-${index}`, {
          family: FAMILIES[index % FAMILIES.length]!,
          domain: `budget-${index}.example`,
        })
      ),
      {
        maximum,
        maximumPerFamily: 12,
        maximumPerPublisherDomain: 6,
        configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
        now: NOW,
      },
    );

    expect(result.items).toHaveLength(maximum);
  });

  it("reserves qualified topic and discovery-family representatives then releases empty reservations", () => {
    const highFit = Array.from({ length: 8 }, (_, index) =>
      researchItem(`alignment-${index}`, {
        family: "arxiv",
        domain: `alignment-${index}.example`,
        topicalFit: 0.99 - index / 100,
        topics: [CONFIGURED_RESEARCH_TOPIC_IDS[0]],
      })
    );
    const candidates = [
      ...highFit,
      researchItem("oversight", {
        family: "bibliographic",
        domain: "oversight.example",
        topicalFit: 0.7,
        topics: [CONFIGURED_RESEARCH_TOPIC_IDS[1]],
      }),
      researchItem("secure", {
        family: "official-publication",
        domain: "secure.example",
        topicalFit: 0.69,
        topics: [CONFIGURED_RESEARCH_TOPIC_IDS[2]],
      }),
      researchItem("commentary", {
        family: "commentary",
        domain: "commentary.example",
        topicalFit: 0.68,
        topics: [CONFIGURED_RESEARCH_TOPIC_IDS[0]],
      }),
    ];

    const result = triageResearch(candidates, {
      maximum: 6,
      maximumPerFamily: 3,
      maximumPerPublisherDomain: 2,
      configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
      now: NOW,
    });

    expect(result.items.map(({ id }) => id)).toEqual([
      "alignment-0",
      "oversight",
      "secure",
      "commentary",
      "alignment-1",
      "alignment-2",
    ]);
  });

  it("breaks equal-ranked ties by stable item ID instead of arrival order", () => {
    const candidates = ["c", "a", "b"].map((id) =>
      researchItem(id, { domain: `${id}.example` })
    );
    const options = {
      maximum: 3,
      maximumPerFamily: 12,
      maximumPerPublisherDomain: 6,
      configuredTopics: CONFIGURED_RESEARCH_TOPIC_IDS,
      now: NOW,
    };

    expect(triageResearch(candidates, options).items.map(({ id }) => id))
      .toEqual(["a", "b", "c"]);
    expect(triageResearch([...candidates].reverse(), options).items.map(({ id }) => id))
      .toEqual(["a", "b", "c"]);
  });
});
