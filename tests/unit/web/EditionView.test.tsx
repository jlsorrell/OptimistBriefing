// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { EditionWithEntries } from "../../../src/contracts/editorial";
import { EditionView } from "../../../src/web/components/EditionView";

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
    expect(screen.getByRole("navigation", { name: "Briefing sections" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByText("24 minute read")).toBeTruthy();
  });
});
