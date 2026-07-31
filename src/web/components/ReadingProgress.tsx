import { useEffect } from "react";

type ReadingProgressProps = {
  editionDate: string;
  entryIds: readonly string[];
};

export function progressStorageKey(editionDate: string) {
  return `briefing-progress:${editionDate}`;
}

export function ReadingProgress({
  editionDate,
  entryIds,
}: ReadingProgressProps) {
  useEffect(() => {
    const storageKey = progressStorageKey(editionDate);
    const knownEntryIds = new Set(entryIds);
    const detailedCards = [
      ...document.querySelectorAll<HTMLElement>(
        "article[data-entry-id]",
      ),
    ].filter((element) => {
      const entryId = element.getAttribute("data-entry-id");
      return entryId !== null && knownEntryIds.has(entryId);
    });
    const candidates =
      detailedCards.length > 0
        ? detailedCards
        : [
            ...document.querySelectorAll<HTMLElement>(
              "[data-entry-id]",
            ),
          ].filter((element) => {
            const entryId = element.getAttribute("data-entry-id");
            return entryId !== null && knownEntryIds.has(entryId);
          });
    const cards: HTMLElement[] = [];
    const cardById = new Map<string, HTMLElement>();
    for (const element of candidates) {
      const entryId = element.getAttribute("data-entry-id");
      if (entryId === null || cardById.has(entryId)) continue;
      cardById.set(entryId, element);
      cards.push(element);
    }
    const cardIds = cards.flatMap((element) => {
      const entryId = element.getAttribute("data-entry-id");
      return entryId === null ? [] : [entryId];
    });
    const previousEntryId = localStorage.getItem(storageKey);
    if (previousEntryId !== null) {
      cardById.get(previousEntryId)?.scrollIntoView({ block: "start" });
    }

    const persistFinalEntryAtBottom = (): boolean => {
      const finalEntryId = cardIds.at(-1);
      const atBottom =
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 2;
      if (!atBottom || finalEntryId === undefined) return false;
      localStorage.setItem(storageKey, finalEntryId);
      return true;
    };
    const handleScroll = () => {
      persistFinalEntryAtBottom();
    };
    window.addEventListener("scroll", handleScroll, { passive: true });

    if (typeof IntersectionObserver === "undefined") {
      return () => window.removeEventListener("scroll", handleScroll);
    }

    const intersecting = new Set<Element>();
    const entryOrder = new Map(
      cardIds.map((entryId, index) => [entryId, index]),
    );
    const observer = new IntersectionObserver(
      (observations) => {
        for (const observation of observations) {
          if (observation.isIntersecting) {
            intersecting.add(observation.target);
          } else {
            intersecting.delete(observation.target);
          }
        }
        if (persistFinalEntryAtBottom()) return;
        const rootTop =
          observations.find(({ rootBounds }) => rootBounds !== null)
            ?.rootBounds?.top ?? window.innerHeight * 0.15;
        const visible = [...intersecting].map((target) => {
          const entryId = target.getAttribute("data-entry-id");
          return {
            target,
            top: target.getBoundingClientRect().top,
            order: entryId === null ? -1 : (entryOrder.get(entryId) ?? -1),
          };
        });
        const started = visible
          .filter(({ top }) => top <= rootTop)
          .sort(
            (left, right) =>
              right.top - left.top || right.order - left.order,
          );
        const current =
          started[0] ??
          visible.sort(
            (left, right) =>
              left.top - right.top || left.order - right.order,
          )[0];
        const entryId = current?.target.getAttribute("data-entry-id");
        if (entryId !== null && entryId !== undefined) {
          localStorage.setItem(storageKey, entryId);
        }
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );

    for (const card of cards) {
      observer.observe(card);
    }
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", handleScroll);
    };
  }, [editionDate, entryIds]);

  return null;
}
