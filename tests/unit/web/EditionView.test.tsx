// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  EditionEntry,
  EditionWithEntries,
  SourceRef,
} from "../../../src/contracts/editorial";
import { EditionView } from "../../../src/web/components/EditionView";
import { NewsClusterCard } from "../../../src/web/components/NewsClusterCard";

function fixtureEdition(): EditionWithEntries {
  return {
    id: "edition-fixture",
    editionDate: "2026-07-29",
    runId: "run-fixture",
    status: "published",
    readingMinutes: 24,
    publishedAt: "2026-07-29T09:45:00.000Z",
    createdAt: "2026-07-29T09:30:00.000Z",
    entries: [
      {
        id: "paper-featured",
        editionId: "edition-fixture",
        itemId: "paper-fixture",
        section: "research",
        position: 0,
        summary: {
          title: "How concepts emerge during training",
          oneSentence:
            "The paper traces a stable internal concept across checkpoints.",
          whyItMatters:
            "It offers a concrete way to study representation formation.",
          uncertainty:
            "The study uses a narrow model family and synthetic tasks.",
          claims: [
            {
              text: "A representation becomes linearly separable mid-training.",
              sourceIds: ["arxiv-fixture"],
              evidenceExcerpt:
                "Linear probe accuracy increases after the transition.",
            },
            {
              text: "A companion analysis reproduces the transition.",
              sourceIds: ["blog-fixture"],
              evidenceExcerpt: "The independent analysis reports the same phase.",
            },
          ],
          accessLevel: "abstract",
        },
        selectionReasons: [
          "Directly relevant to concept representations",
          "Strong institutional and methodological signal",
        ],
        sourceRefs: [
          {
            id: "arxiv-fixture",
            name: "arXiv paper",
            url: "https://arxiv.org/abs/fixture",
            role: "primary",
            retrievedAt: "2026-07-29T08:00:00.000Z",
          },
          {
            id: "blog-fixture",
            name: "Research commentary",
            url: "https://example.com/commentary",
            role: "blog",
            retrievedAt: "2026-07-29T08:05:00.000Z",
          },
        ],
      },
    ],
  };
}

function newsEntryWithSources(sourceRefs: readonly SourceRef[]): EditionEntry {
  const fixture = fixtureEdition().entries[0];
  if (fixture === undefined) throw new Error("Missing fixture entry.");
  const claim = fixture.summary.claims[0];
  if (claim === undefined) throw new Error("Missing fixture claim.");
  const supportingSource = sourceRefs.find(
    (source) => source.role === "primary" || source.role === "reporting",
  );
  if (supportingSource === undefined) {
    throw new Error("News fixture requires a reporting or primary source.");
  }
  return {
    ...fixture,
    section: "world",
    sourceRefs: [...sourceRefs],
    summary: {
      ...fixture.summary,
      claims: [{ ...claim, sourceIds: [supportingSource.id] }],
    },
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("EditionView", () => {
  it("renders provenance, access level, uncertainty, and feedback controls", () => {
    render(<EditionView edition={fixtureEdition()} />);

    expect(screen.getByText("Abstract only")).toBeTruthy();
    expect(screen.getByText(/Reasons for skepticism/i)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open paper/i }).getAttribute("href"),
    ).toBe("https://arxiv.org/abs/fixture");
    expect(screen.getByRole("button", { name: "More like this" })).toBeTruthy();
    expect(screen.getByText("Primary source")).toBeTruthy();
    expect(
      screen.getByText(
        "Thank you to arXiv for use of its open access interoperability.",
      ),
    ).toBeTruthy();
  });

  it("uses semantic page landmarks and exposes the edition reading time", () => {
    render(<EditionView edition={fixtureEdition()} />);

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Briefing sections" }),
    ).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByText("24 minute read")).toBeTruthy();
  });

  it("labels forecast signals with the required non-factual wording", () => {
    const fixture = fixtureEdition().entries[0];
    if (fixture === undefined) throw new Error("Missing fixture entry.");
    render(
      <NewsClusterCard
        entry={{
          ...fixture,
          section: "forecast",
          sourceRefs: [
            {
              id: "polymarket",
              name: "Polymarket",
              url: "https://polymarket.com/event/fixture",
              role: "forecast",
              retrievedAt: "2026-07-29T08:00:00.000Z",
            },
          ],
          summary: {
            ...fixture.summary,
            claims: fixture.summary.claims.map((claim) => ({
              ...claim,
              sourceIds: ["polymarket"],
            })),
          },
        }}
      />,
    );

    expect(screen.getByText("Forecast, not fact")).toBeTruthy();
  });

  it.each(["forecast", "analysis", "opinion", "blog"] as const)(
    "does not treat a reporting plus %s pair as corroboration",
    (role) => {
      render(
        <NewsClusterCard
          entry={newsEntryWithSources([
            {
              id: "report",
              name: "Reuters",
              url: "https://example.com/report",
              role: "reporting",
              retrievedAt: "2026-07-29T08:00:00.000Z",
            },
            {
              id: "context",
              name: "Context source",
              url: "https://example.com/context",
              role,
              retrievedAt: "2026-07-29T08:00:00.000Z",
            },
          ])}
        />,
      );

      expect(screen.getByText("Single report")).toBeTruthy();
      expect(screen.queryByText("Corroborated")).toBeNull();
    },
  );

  it("requires qualifying reports to come from independent sources", () => {
    render(
      <NewsClusterCard
        entry={newsEntryWithSources([
          {
            id: "report-1",
            name: "Reuters",
            url: "https://example.com/report-1",
            role: "reporting",
            retrievedAt: "2026-07-29T08:00:00.000Z",
          },
          {
            id: "report-2",
            name: "Reuters",
            url: "https://example.com/report-2",
            role: "reporting",
            retrievedAt: "2026-07-29T08:00:00.000Z",
          },
        ])}
      />,
    );

    expect(screen.getByText("Single report")).toBeTruthy();
  });

  it("labels two independent reporting sources as corroborated", () => {
    render(
      <NewsClusterCard
        entry={newsEntryWithSources([
          {
            id: "report-1",
            name: "Reuters",
            url: "https://example.com/report-1",
            role: "reporting",
            retrievedAt: "2026-07-29T08:00:00.000Z",
          },
          {
            id: "report-2",
            name: "Associated Press",
            url: "https://example.com/report-2",
            role: "reporting",
            retrievedAt: "2026-07-29T08:00:00.000Z",
          },
        ])}
      />,
    );

    expect(screen.getByText("Corroborated")).toBeTruthy();
  });
});
