import { describe, expect, it } from "vitest";

import type { CompositionResult } from
  "../../../src/workflow/types";
import {
  normalizeLegacyCompositionProviderText,
  prepareCurrentCompositionProviderText,
} from "../../../src/workflow/composition-provider-text";

const now = "2034-05-02T09:00:00.000Z";

function composition(sourceName = "Source &amp;amp;#83;yndicate"):
  CompositionResult {
  return {
    edition: {
      id: "edition:run-compose-provider-text",
      editionDate: "2034-05-02",
      runId: "run-compose-provider-text",
      status: "draft",
      readingMinutes: 20,
      publishedAt: null,
      createdAt: now,
      metadata: { missingSections: [], sourceFailures: [] },
    },
    entries: [{
      id: "edition:run-compose-provider-text:entry:0",
      editionId: "edition:run-compose-provider-text",
      itemId: "item-structural-id",
      section: "world",
      position: 0,
      summary: {
        title: "Title &amp;amp;#8217; display",
        oneSentence: "Sentence &amp;amp;#8217; display",
        whyItMatters: "Why &amp;amp;#8217; display",
        uncertainty: "Uncertainty &amp;amp;#8217; display",
        claims: [{
          text: "Claim &amp;amp;#8217; display",
          sourceIds: ["source-structural-id"],
          evidenceExcerpt: "Evidence &amp;amp;#8217; display",
        }],
        accessLevel: "secondary",
      },
      selectionReasons: ["Reason &amp;amp;#8217; display"],
      sourceRefs: [{
        id: "source-structural-id",
        name: sourceName,
        url: "https://example.com/report?cursor=a%26amp%3Bb",
        role: "reporting",
        retrievedAt: now,
      }],
    }],
    status: "partial",
    missingSections: [],
    sourceFailures: [],
  };
}

describe("composition provider-text lifecycle", () => {
  it("normalizes legacy human display fields once and keeps current output byte-stable", () => {
    const legacy = composition();

    const normalized = normalizeLegacyCompositionProviderText(legacy);

    expect(normalized.entries[0]).toMatchObject({
      id: "edition:run-compose-provider-text:entry:0",
      editionId: "edition:run-compose-provider-text",
      itemId: "item-structural-id",
      section: "world",
      position: 0,
      summary: {
        title: "Title &#8217; display",
        oneSentence: "Sentence &#8217; display",
        whyItMatters: "Why &#8217; display",
        uncertainty: "Uncertainty &#8217; display",
        claims: [{
          text: "Claim &#8217; display",
          sourceIds: ["source-structural-id"],
          evidenceExcerpt: "Evidence &#8217; display",
        }],
        accessLevel: "secondary",
      },
      selectionReasons: ["Reason &#8217; display"],
      sourceRefs: [{
        id: "source-structural-id",
        name: "Source &#83;yndicate",
        url: "https://example.com/report?cursor=a%26amp%3Bb",
        role: "reporting",
        retrievedAt: now,
      }],
    });
    expect(normalized.edition).toEqual(legacy.edition);
    expect(prepareCurrentCompositionProviderText(normalized)).toEqual(
      normalized,
    );
  });

  it("rejects a legacy composition whose required source name is only markup", () => {
    expect(() => normalizeLegacyCompositionProviderText(
      composition("&lt;br&gt;"),
    )).toThrow("INVALID_REQUIRED_PROVIDER_DISPLAY_TEXT:sourceName");
  });
});
