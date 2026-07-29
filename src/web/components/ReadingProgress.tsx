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
    const previousEntryId = localStorage.getItem(storageKey);
    if (previousEntryId !== null && entryIds.includes(previousEntryId)) {
      document
        .querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(previousEntryId)}"]`)
        ?.scrollIntoView({ block: "start" });
    }

    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (observations) => {
        const visible = observations
          .filter((observation) => observation.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
          .at(0);
        const entryId = visible?.target.getAttribute("data-entry-id");
        if (entryId !== null && entryId !== undefined) {
          localStorage.setItem(storageKey, entryId);
        }
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );

    for (const entryId of entryIds) {
      const element = document.querySelector(
        `[data-entry-id="${CSS.escape(entryId)}"]`,
      );
      if (element !== null) {
        observer.observe(element);
      }
    }
    return () => observer.disconnect();
  }, [editionDate, entryIds]);

  return null;
}
