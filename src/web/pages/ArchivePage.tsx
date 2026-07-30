import { useEffect, useState } from "react";

import type { ArchiveSearchPage } from "../../contracts/api";

async function archivePage(url: string, signal?: AbortSignal) {
  const response = await fetch(
    url,
    signal === undefined ? undefined : { signal },
  );
  if (!response.ok) {
    throw new Error("Archive request failed");
  }
  return await response.json() as ArchiveSearchPage;
}

export function ArchivePage() {
  const [page, setPage] = useState<ArchiveSearchPage | null>(null);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void archivePage("/api/archive", controller.signal)
      .then(setPage)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, []);

  async function search() {
    setFailed(false);
    const params = new URLSearchParams();
    if (query.trim().length > 0) {
      params.set("q", query.trim());
    }
    setPage(await archivePage(`/api/archive?${params.toString()}`));
  }

  return (
    <main className="state-page">
      <p className="edition-kicker">Published briefing history</p>
      <h1>Archive</h1>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label htmlFor="archive-query">Search title, topic, author, institution, source, or summary</label>
        <input
          id="archive-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit">Search archive</button>
      </form>
      {failed ? <p role="alert">The archive is unavailable.</p> : null}
      {page === null ? (
        <p aria-busy="true">Loading archive…</p>
      ) : (
        <>
          <ol>
            {page.items.map((entry) => (
              <li key={entry.id}>
                <h2>{entry.summary.title}</h2>
                <p>{entry.summary.oneSentence}</p>
                <p>{entry.section.replaceAll("_", " ")}</p>
              </li>
            ))}
          </ol>
          {page.nextCursor === null ? null : (
            <button
              type="button"
              onClick={() =>
                void archivePage(
                  `/api/archive?cursor=${encodeURIComponent(page.nextCursor!)}`,
                ).then(setPage)
              }
            >
              Next page
            </button>
          )}
        </>
      )}
      <p><a href="/">Return to today’s edition</a></p>
    </main>
  );
}
