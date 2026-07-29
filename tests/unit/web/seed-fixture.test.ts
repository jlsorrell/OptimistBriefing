import { describe, expect, it } from "vitest";

import { fixtureEdition } from "../../../scripts/seed-dev";

describe("development seed edition", () => {
  it("contains the complete deterministic dashboard fixture", () => {
    const edition = fixtureEdition();
    const sections = edition.entries.map((entry) => entry.section);

    expect(edition).toMatchObject({
      id: "edition-2026-07-29",
      editionDate: "2026-07-29",
      publishedAt: "2026-07-29T09:45:00.000Z",
      createdAt: "2026-07-29T09:30:00.000Z",
    });
    expect(sections.filter((section) => section === "morning_brief")).toHaveLength(3);
    expect(sections).toEqual(
      expect.arrayContaining([
        "research",
        "research_radar",
        "world",
        "ai_policy",
        "dmv",
        "baltimore",
        "forecast",
      ]),
    );

    const featured = edition.entries.find((entry) => entry.section === "research");
    expect(featured?.summary.accessLevel).toBe("abstract");
    expect(featured?.summary.claims).toHaveLength(2);
    expect(featured?.sourceRefs).toHaveLength(2);

    const world = edition.entries.find((entry) => entry.section === "world");
    expect(world?.sourceRefs.filter((source) => source.role === "reporting")).toHaveLength(2);

    const policy = edition.entries.find((entry) => entry.section === "ai_policy");
    expect(policy?.sourceRefs.some((source) => source.role === "primary")).toBe(true);

    const forecast = edition.entries.find((entry) => entry.section === "forecast");
    expect(forecast?.sourceRefs).toContainEqual(
      expect.objectContaining({ name: "Polymarket", role: "forecast" }),
    );
  });
});
