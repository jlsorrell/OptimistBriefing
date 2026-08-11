import { describe, expect, it } from "vitest";

import { fixtureEdition } from "../../../scripts/seed-dev";
import {
  expectedCardSourceHosts,
  formatPreviewEditionDate,
  parsePreviewEdition,
  PREVIEW_SECTION_LABELS,
  PREVIEW_SECTIONS,
} from "../../preview-e2e/edition-contract";

function sparseEdition() {
  const seeded = fixtureEdition();
  const editionId = "edition-2026-08-09";
  return {
    ...seeded,
    id: editionId,
    editionDate: "2026-08-09",
    runId: "run-2026-08-09",
    status: "partial",
    readingMinutes: 20,
    publishedAt: "2026-08-09T10:04:00.000Z",
    createdAt: "2026-08-09T10:00:00.000Z",
    entries: seeded.entries
      .filter(({ section }) => section === "research" || section === "baltimore")
      .map((entry) => ({ ...entry, editionId })),
  };
}

describe("preview edition contract", () => {
  it("parses the seeded edition and derives its complete card host set", () => {
    const edition = parsePreviewEdition(fixtureEdition());
    expect(edition.editionDate).toBe("2026-07-29");
    expect(formatPreviewEditionDate(edition.editionDate)).toBe(
      "Wednesday, July 29, 2026",
    );
    expect(expectedCardSourceHosts(edition.entries)).toEqual([
      "apnews.com",
      "arxiv.org",
      "polymarket.com",
      "wtop.com",
      "www.anthropic.com",
      "www.nist.gov",
      "www.reuters.com",
      "www.thebaltimorebanner.com",
    ]);
  });

  it("parses a newer sparse partial edition without inventing sections or hosts", () => {
    const edition = parsePreviewEdition(sparseEdition());
    expect(formatPreviewEditionDate(edition.editionDate)).toBe(
      "Sunday, August 9, 2026",
    );
    expect(new Set(edition.entries.map(({ section }) => section))).toEqual(
      new Set(["research", "baltimore"]),
    );
    expect(expectedCardSourceHosts(edition.entries)).toEqual([
      "arxiv.org",
      "www.anthropic.com",
      "www.thebaltimorebanner.com",
    ]);
  });

  it("exports canonical order and headings", () => {
    expect(PREVIEW_SECTIONS).toEqual([
      "morning_brief", "research", "research_radar", "world", "technology",
      "ai_policy", "dmv", "baltimore", "forecast",
    ]);
    expect(PREVIEW_SECTION_LABELS).toEqual({
      morning_brief: "Morning brief",
      research: "Research",
      research_radar: "On the radar",
      world: "World",
      technology: "Technology",
      ai_policy: "AI policy",
      dmv: "DMV",
      baltimore: "Baltimore",
      forecast: "Forecast signals",
    });
  });

  const valid = fixtureEdition();
  const firstEntry = valid.entries[0]!;
  const firstSource = firstEntry.sourceRefs[0]!;
  it.each([
    ["non-object response", null],
    ["missing entries", { editionDate: "2026-07-29" }],
    ["empty entries", { ...valid, entries: [] }],
    ["invalid calendar date", { ...valid, editionDate: "2026-02-30" }],
    ["unknown section", { ...valid, entries: [{ ...firstEntry, section: "unknown" }] }],
    ["empty entry id", { ...valid, entries: [{ ...firstEntry, id: "" }] }],
    ["invalid source URL", {
      ...valid,
      entries: [{ ...firstEntry, sourceRefs: [{ ...firstSource, url: "file:///tmp/source" }] }],
    }],
    ["unknown source role", {
      ...valid,
      entries: [{ ...firstEntry, sourceRefs: [{ ...firstSource, role: "owner" }] }],
    }],
  ])("rejects %s with a bounded contract error", (_name, body) => {
    expect(() => parsePreviewEdition(body)).toThrow(/^Preview edition contract:/);
  });
});
