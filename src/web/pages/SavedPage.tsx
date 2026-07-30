import { useEffect, useState } from "react";

import type { ArchiveSearchPage } from "../../contracts/api";

async function savedPage(url: string, signal?: AbortSignal) {
  const response = await fetch(
    url,
    signal === undefined ? undefined : { signal },
  );
  if (!response.ok) {
    throw new Error("Saved items request failed");
  }
  return await response.json() as ArchiveSearchPage;
}

export function SavedPage() {
  const [page, setPage] = useState<ArchiveSearchPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      setFailed(false);
      void savedPage("/api/archive?saved=true", controller.signal)
      .then(setPage)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailed(true);
        }
      });
    };
    refresh();
    window.addEventListener("briefing:saved-changed", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("briefing:saved-changed", refresh);
    };
  }, []);

  async function loadMore(cursor: string) {
    setLoading(true);
    setFailed(false);
    try {
      const next = await savedPage(
        `/api/archive?saved=true&cursor=${encodeURIComponent(cursor)}`,
      );
      setPage((current) => ({
        items: [...(current?.items ?? []), ...next.items],
        nextCursor: next.nextCursor,
      }));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="state-page">
      <p className="edition-kicker">Your reading list</p>
      <h1>Saved items</h1>
      {failed ? <p role="alert">Saved items are unavailable.</p> : null}
      {page === null ? (
        <p aria-busy="true">Loading saved items…</p>
      ) : (
        <>
          {page.items.length === 0 ? (
            <p>No saved items yet.</p>
          ) : (
            <ol>
              {page.items.map((entry) => (
                <li key={entry.id}>
                  <h2>{entry.summary.title}</h2>
                  <p>{entry.summary.oneSentence}</p>
                </li>
              ))}
            </ol>
          )}
          {page.nextCursor === null ? null : (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadMore(page.nextCursor!)}
            >
              Load more saved items
            </button>
          )}
        </>
      )}
      <p><a href="/">Return to today’s edition</a></p>
    </main>
  );
}
