// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadingProgress } from "../../../src/web/components/ReadingProgress";

function rectangle(top: number): DOMRectReadOnly {
  return {
    bottom: top + 500,
    height: 500,
    left: 0,
    right: 300,
    top,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

class FakeIntersectionObserver implements IntersectionObserver {
  static latest: FakeIntersectionObserver | null = null;

  readonly root = null;
  readonly rootMargin = "-15% 0px -70% 0px";
  readonly thresholds = [0];
  readonly observed: Element[] = [];
  readonly #callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
    FakeIntersectionObserver.latest = this;
  }

  disconnect() {}
  observe(target: Element) {
    this.observed.push(target);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve() {}

  emit(entries: readonly IntersectionObserverEntry[]) {
    this.#callback([...entries], this);
  }
}

function observation(
  target: Element,
  isIntersecting: boolean,
  top: number,
): IntersectionObserverEntry {
  return {
    boundingClientRect: rectangle(top),
    intersectionRatio: isIntersecting ? 1 : 0,
    intersectionRect: rectangle(top),
    isIntersecting,
    rootBounds: rectangle(150),
    target,
    time: 0,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeIntersectionObserver.latest = null;
});

describe("ReadingProgress", () => {
  it("persists the latest started entry while earlier long cards still intersect", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
    vi.spyOn(
      document.documentElement,
      "scrollHeight",
      "get",
    ).mockReturnValue(2_000);
    const { container } = render(
      <>
        <article data-entry-id="entry-baltimore" />
        <article data-entry-id="entry-forecast" />
        <ReadingProgress
          editionDate="2026-07-29"
          entryIds={["entry-baltimore", "entry-forecast"]}
        />
      </>,
    );
    const baltimore = container.querySelector(
      '[data-entry-id="entry-baltimore"]',
    );
    const forecast = container.querySelector(
      '[data-entry-id="entry-forecast"]',
    );
    const observer = FakeIntersectionObserver.latest;
    if (baltimore === null || forecast === null || observer === null) {
      throw new Error("Missing reading progress fixture.");
    }
    vi.spyOn(baltimore, "getBoundingClientRect").mockReturnValue(
      rectangle(-400),
    );
    vi.spyOn(forecast, "getBoundingClientRect").mockReturnValue(
      rectangle(0),
    );

    act(() => {
      observer.emit([
        observation(baltimore, true, -400),
        observation(forecast, true, 0),
      ]);
    });

    expect(localStorage.getItem("briefing-progress:2026-07-29")).toBe(
      "entry-forecast",
    );

    act(() => {
      observer.emit([observation(forecast, false, -500)]);
    });

    expect(localStorage.getItem("briefing-progress:2026-07-29")).toBe(
      "entry-baltimore",
    );
  });

  it("persists the final entry at document bottom despite later observer callbacks", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(500);
    vi.spyOn(
      document.documentElement,
      "scrollHeight",
      "get",
    ).mockReturnValue(1_000);
    const { container } = render(
      <>
        <article data-entry-id="entry-baltimore" />
        <article data-entry-id="entry-forecast" />
        <ReadingProgress
          editionDate="2026-07-29"
          entryIds={["entry-forecast", "entry-baltimore"]}
        />
      </>,
    );
    const baltimore = container.querySelector(
      '[data-entry-id="entry-baltimore"]',
    );
    const observer = FakeIntersectionObserver.latest;
    if (baltimore === null || observer === null) {
      throw new Error("Missing reading progress fixture.");
    }

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(localStorage.getItem("briefing-progress:2026-07-29")).toBe(
      "entry-forecast",
    );

    act(() => {
      observer.emit([observation(baltimore, true, 100)]);
    });
    expect(localStorage.getItem("briefing-progress:2026-07-29")).toBe(
      "entry-forecast",
    );
  });

  it("restores and observes the detailed card instead of a duplicate overview item", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    localStorage.setItem(
      "briefing-progress:2026-07-29",
      "entry-forecast",
    );
    const overviewScroll = vi.fn();
    const cardScroll = vi.fn();
    const { container } = render(
      <>
        <li
          data-entry-id="entry-forecast"
          ref={(element) => {
            if (element !== null) element.scrollIntoView = overviewScroll;
          }}
        />
        <article
          data-entry-id="entry-forecast"
          ref={(element) => {
            if (element !== null) element.scrollIntoView = cardScroll;
          }}
        />
        <ReadingProgress
          editionDate="2026-07-29"
          entryIds={["entry-forecast"]}
        />
      </>,
    );
    const card = container.querySelector(
      'article[data-entry-id="entry-forecast"]',
    );
    const observer = FakeIntersectionObserver.latest;
    if (card === null || observer === null) {
      throw new Error("Missing reading progress fixture.");
    }

    expect(overviewScroll).not.toHaveBeenCalled();
    expect(cardScroll).toHaveBeenCalledWith({ block: "start" });
    expect(observer.observed).toEqual([card]);
  });
});
