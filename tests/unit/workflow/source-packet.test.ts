import { describe, expect, it } from "vitest";

import { ItemSchema, type Item } from "../../../src/contracts/editorial";
import { clusterNews } from "../../../src/editorial/cluster";
import { sourcePacketForItem } from "../../../src/workflow/source-packet";

const retrievedAt = "2026-07-30T09:00:00.000Z";

function sourceItem(
  id: string,
  title: string,
  normalizedText: string,
  accessLevel: Item["accessLevel"],
): Item {
  return {
    id,
    kind: "article",
    canonicalUrl: `https://example.com/articles/${id}`,
    title,
    publishedAt: retrievedAt,
    sourceRefs: [{
      id,
      name: `Source ${id}`,
      url: `https://example.com/sources/${id}`,
      role: id === "source-a" ? "primary" : "reporting",
      retrievedAt,
    }],
    accessLevel,
    primaryTopic: "world",
    tags: ["world"],
    normalizedText,
    metadata: {
      primarySection: "world",
      sectionEligibility: ["world"],
      primaryDocumentUrl: "https://example.com/documents/shared-event",
      namedEntities: ["Example Agency"],
    },
    createdAt: retrievedAt,
    expiresAt: null,
  };
}

describe("sourcePacketForItem", () => {
  it.each([
    ["empty", ""],
    ["malformed-surrogate", "\uDC00"],
  ])(
    "falls back from an %s commentary excerpt to the item's normalized evidence",
    (_label, excerpt) => {
      const item = sourceItem(
        "source-a",
        "Title must be the last fallback",
        "Primary normalized evidence.",
        "abstract",
      );
      const packet = sourcePacketForItem(ItemSchema.parse({
        ...item,
        metadata: {
          ...item.metadata,
          attachedCommentary: [{
            sourceId: "source-a",
            title: "Attached commentary",
            url: "https://example.com/commentary/source-a",
            retrievedAt,
            accessLevel: "secondary",
            excerpt,
          }],
        },
      }));

      expect(packet.sources[0]!.excerpts).toEqual([{
        number: 1,
        text: "Primary normalized evidence.",
      }]);
    },
  );

  it("keeps each clustered development source's bounded evidence separate", () => {
    // This fails if a development's aggregate normalized text is copied to every source.
    const sourceA = sourceItem(
      "source-a",
      "Source A title",
      "fact only from A",
      "abstract",
    );
    const sourceB = sourceItem(
      "source-b",
      "Source B title",
      "different fact from B",
      "full_text",
    );
    const development = clusterNews([sourceA, sourceB], {})[0];
    if (development === undefined) throw new Error("Expected clustered development.");
    const clusteredItem = ItemSchema.parse({
      ...development.representativeItem,
      id: development.id,
      title: development.title,
      sourceRefs: development.sourceRefs,
      normalizedText: development.items.map((item) => item.normalizedText).join(" "),
      metadata: {
        ...development.representativeItem.metadata,
        workflow: { version: 1, development },
      },
    });

    const packet = sourcePacketForItem(clusteredItem);

    expect(packet.sources.find(({ sourceId }) => sourceId === "source-a")!.excerpts)
      .toEqual([{ number: 1, text: "fact only from A" }]);
    expect(packet.sources.find(({ sourceId }) => sourceId === "source-b")!.excerpts)
      .toEqual([{ number: 1, text: "different fact from B" }]);
    expect(packet.sources.find(({ sourceId }) => sourceId === "source-a"))
      .toMatchObject({
        sourceId: "source-a",
        role: "primary",
        title: "Source A title",
        url: "https://example.com/sources/source-a",
        retrievedAt,
        accessLevel: "abstract",
      });
    expect(packet.sources.find(({ sourceId }) => sourceId === "source-b"))
      .toMatchObject({
        sourceId: "source-b",
        role: "reporting",
        title: "Source B title",
        url: "https://example.com/sources/source-b",
        retrievedAt,
        accessLevel: "full_text",
      });
  });
});
