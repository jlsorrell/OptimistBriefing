import { useEffect, useState } from "react";

import type { ArchiveSearchPage } from "../../contracts/api";

export function SavedPage() {
  const [page, setPage] = useState<ArchiveSearchPage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/archive?saved=true", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Saved items request failed");
        }
        return await response.json() as ArchiveSearchPage;
      })
      .then(setPage)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="state-page">
      <p className="edition-kicker">Your reading list</p>
      <h1>Saved items</h1>
      {failed ? <p role="alert">Saved items are unavailable.</p> : null}
      {page === null ? (
        <p aria-busy="true">Loading saved items…</p>
      ) : page.items.length === 0 ? (
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
      <p><a href="/">Return to today’s edition</a></p>
    </main>
  );
}
