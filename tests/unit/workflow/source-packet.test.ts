import { describe, expect, it } from "vitest";

import { ItemSchema, type Item } from "../../../src/contracts/editorial";
import { clusterNews } from "../../../src/editorial/cluster";
import { InvalidRequiredProviderDisplayTextError } from
  "../../../src/editorial/normalize";
import { SourcePacketSchema } from "../../../src/editorial/validate-summary";
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
  it("bounds a current Item source name to the packet-safe contract without touching structure", () => {
    // Removing the packet defense must make the returned packet fail its own
    // authoritative schema on the 500-character durable Item allowance.
    const item = sourceItem(
      "source-a",
      "Packet-safe title",
      "Packet-safe evidence.",
      "abstract",
    );
    item.sourceRefs[0]!.name = "S".repeat(500);
    item.sourceRefs[0]!.url =
      "https://example.com/sources/source-a?cursor=a%26amp%3Bb";

    const packet = sourcePacketForItem(ItemSchema.parse(item));

    expect(packet.sources[0]).toMatchObject({
      sourceId: "source-a",
      sourceName: "S".repeat(200),
      url: "https://example.com/sources/source-a?cursor=a%26amp%3Bb",
      retrievedAt,
      accessLevel: "abstract",
    });
    expect(() => SourcePacketSchema.parse(packet)).not.toThrow();
  });

  it.each(["\u0000", "\u0085", "\u2029"])(
    "raises the typed candidate error for a current Item source name containing %s",
    (unsafe) => {
      // Replacing this typed boundary with a downstream ZodError makes the
      // production synthesize loop retry the whole run instead of one item.
      const item = sourceItem(
        "source-a",
        "Packet-safe title",
        "Packet-safe evidence.",
        "abstract",
      );
      item.sourceRefs[0]!.name = `Unsafe${unsafe}Source`;

      let observed: unknown;
      try {
        sourcePacketForItem(ItemSchema.parse(item));
      } catch (error) {
        observed = error;
      }

      expect(observed).toBeInstanceOf(
        InvalidRequiredProviderDisplayTextError,
      );
      expect(
        (observed as InvalidRequiredProviderDisplayTextError).field,
      ).toBe("sourceName");
    },
  );

  it.each([
    ["empty", ""],
    ["NUL-control", "\u0000"],
    ["C1-control", "\u0085"],
    ["line-separator", "\u2028"],
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
      expect(() => SourcePacketSchema.parse(packet)).not.toThrow();
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
