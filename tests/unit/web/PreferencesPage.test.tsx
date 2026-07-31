// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditionEntry } from "../../../src/contracts/editorial";
import type { ReaderPreferences } from "../../../src/db/repository";
import { FeedbackActions } from "../../../src/web/components/FeedbackActions";
import { NewsClusterCard } from "../../../src/web/components/NewsClusterCard";
import { PaperCard } from "../../../src/web/components/PaperCard";
import { Sidebar } from "../../../src/web/components/Sidebar";
import { ArchivePage } from "../../../src/web/pages/ArchivePage";
import { PreferencesPage } from "../../../src/web/pages/PreferencesPage";
import { SavedPage } from "../../../src/web/pages/SavedPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(id: string, itemId: string | null): EditionEntry {
  return {
    id,
    editionId: "edition-1",
    itemId,
    section: "research",
    position: 0,
    summary: {
      title: `Title ${id}`,
      oneSentence: "A concise summary.",
      whyItMatters: "It matters.",
      uncertainty: "Evidence remains limited.",
      claims: [
        {
          text: "A supported claim.",
          sourceIds: ["source-1"],
          evidenceExcerpt: "Supporting evidence.",
        },
      ],
      accessLevel: "abstract",
    },
    selectionReasons: ["Reader relevance"],
    sourceRefs: [
      {
        id: "source-1",
        name: "Example Source",
        url: "https://example.com/source",
        role: "primary",
        retrievedAt: "2034-01-01T10:00:00.000Z",
      },
    ],
  };
}

function jsonResponse(value: unknown, ok = true): Response {
  return {
    ok,
    json: async () => value,
  } as Response;
}

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

  it("edits explicit topic and source weights while keeping the full baseline visible", async () => {
    const onUpdate = vi.fn(async () => preferences());
    render(
      <PreferencesPage
        initialPreferences={preferences()}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByRole("heading", { name: "Baseline topics" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Baseline institutions" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Baseline section budgets" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Topic weight alignment"), {
      target: { value: "1.2" },
    });
    fireEvent.change(screen.getByLabelText("Source weight arxiv"), {
      target: { value: "0.8" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save explicit preferences" }),
    );

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        topicWeights: { alignment: 1.2 },
        sourceWeights: { arxiv: 0.8 },
        institutionWeights: { Stanford: 1 },
        sectionBudgets: { research: 3 },
      }),
    );
  });
});

describe("reader feedback controls", () => {
  it("persists actions against the underlying item and exposes loading and errors", async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<FeedbackActions itemId="item-42" />);

    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.click(saveButton);
    expect(saveButton.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          itemId: "item-42",
          action: "save",
          reason: null,
        }),
      }),
    );

    resolveRequest(jsonResponse({}, false));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Feedback could not be saved.",
    );
    expect(saveButton.disabled).toBe(false);
  });

  it.each([
    ["paper", PaperCard],
    ["news", NewsClusterCard],
  ] as const)("wires %s cards to item IDs and safely disables missing item IDs", async (_name, Card) => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => jsonResponse({ status: "recorded" }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<Card entry={entry("entry-7", "item-7")} />);

    fireEvent.click(screen.getByRole("button", { name: "More like this" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string),
    ).toMatchObject({ itemId: "item-7", action: "more_like_this" });

    rerender(<Card entry={entry("entry-8", null)} />);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: "Less like this",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("archive and saved controls", () => {
  it("retains every archive filter while advancing the cursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(
        jsonResponse({ items: [entry("entry-one", "item-one")], nextCursor: "next-1" }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ArchivePage />);
    await screen.findByText("No archive items found.");

    for (const [label, value] of [
      ["Search archive", "literal %_"],
      ["Topic", "alignment"],
      ["Author", "Ada"],
      ["Institution", "Stanford"],
      ["Source", "arxiv"],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText("Section"), {
      target: { value: "research" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await screen.findByText("Title entry-one");
    const searchUrl = new URL(
      fetchMock.mock.calls[1]![0] as string,
      "https://example.test",
    );
    expect(Object.fromEntries(searchUrl.searchParams)).toMatchObject({
      q: "literal %_",
      topic: "alignment",
      author: "Ada",
      institution: "Stanford",
      source: "arxiv",
      section: "research",
    });

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const nextUrl = new URL(
      fetchMock.mock.calls[2]![0] as string,
      "https://example.test",
    );
    expect(nextUrl.searchParams.get("cursor")).toBe("next-1");
    expect(nextUrl.searchParams.get("q")).toBe("literal %_");
    expect(nextUrl.searchParams.get("section")).toBe("research");
  });

  it("refreshes saved items after feedback and appends cursor pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ items: [entry("saved-one", "item-one")], nextCursor: "saved-next" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [entry("saved-two", "item-two")], nextCursor: null }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SavedPage />);
    await screen.findByText("Title saved-one");

    fireEvent.click(screen.getByRole("button", { name: "Load more saved items" }));
    expect(await screen.findByText("Title saved-two")).toBeTruthy();
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "/api/archive?saved=true&cursor=saved-next",
    );

    window.dispatchEvent(new CustomEvent("briefing:saved-changed"));
    expect(await screen.findByText("No saved items yet.")).toBeTruthy();
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/archive?saved=true");
  });

  it("links the sidebar to run status", () => {
    render(<Sidebar sections={[]} open onNavigate={() => undefined} />);
    expect(
      screen.getByRole("link", { name: /Run status/ }).getAttribute("href"),
    ).toBe("/run-status");
  });
});
