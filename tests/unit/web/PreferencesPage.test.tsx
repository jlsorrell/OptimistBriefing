// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReaderPreferences } from "../../../src/db/repository";
import { PreferencesPage } from "../../../src/web/pages/PreferencesPage";

afterEach(cleanup);

function preferences(): ReaderPreferences {
  return {
    baseline: {
      topicWeights: { alignment: 1 },
      sourceWeights: { arxiv: 1 },
      institutionWeights: { Stanford: 1 },
      sectionBudgets: { research: 3 },
    },
    topicWeights: { alignment: 0.9 },
    sourceWeights: { arxiv: 1 },
    institutionWeights: { Stanford: 1 },
    sectionBudgets: { research: 3 },
    feedbackHistory: [
      {
        id: "feedback-1",
        itemId: "paper-1",
        action: "less_like_this",
        reason: "too_incremental",
        adjustments: [
          {
            dimension: "topic",
            key: "alignment",
            delta: -0.1,
            resultingWeight: 0.9,
          },
        ],
        createdAt: "2034-01-01T10:00:00.000Z",
      },
    ],
  };
}

describe("PreferencesPage", () => {
  it("separates approved baseline preferences from feedback-derived adjustments", () => {
    render(<PreferencesPage initialPreferences={preferences()} />);

    expect(
      screen.getByRole("heading", { name: "Approved baseline" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Feedback adjustments" }),
    ).toBeTruthy();
    expect(screen.getAllByText("alignment")).toHaveLength(2);
    expect(screen.getByText("−0.1")).toBeTruthy();
    expect(screen.getByText("Too incremental")).toBeTruthy();
  });

  it("gives every adjustment an accessible remove control and announces completion", async () => {
    const onRemoveAdjustment = vi.fn(async () => undefined);
    render(
      <PreferencesPage
        initialPreferences={preferences()}
        onRemoveAdjustment={onRemoveAdjustment}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove alignment feedback adjustment",
      }),
    );

    expect(onRemoveAdjustment).toHaveBeenCalledWith("feedback-1");
    expect(await screen.findByText("Adjustment removed.")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Remove alignment feedback adjustment",
      }),
    ).toBeNull();
  });

  it("resets to the exact approved baseline with a keyboard-operable button", async () => {
    const reset = preferences();
    reset.topicWeights = { alignment: 1 };
    reset.feedbackHistory = [];
    const onReset = vi.fn(async () => reset);
    render(
      <PreferencesPage
        initialPreferences={preferences()}
        onReset={onReset}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Reset to approved baseline",
    });
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);

    expect(button.getAttribute("type")).toBe("button");
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Preferences reset.")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Remove alignment feedback adjustment",
      }),
    ).toBeNull();
  });
});
