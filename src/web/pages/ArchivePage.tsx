import { useEffect, useState } from "react";

import type { ArchiveSearchPage } from "../../contracts/api";
import type { EditionSection } from "../../contracts/editorial";

type ArchiveFilters = {
  query: string;
  topic: string;
  author: string;
  institution: string;
  source: string;
  section: "" | EditionSection;
};

const initialFilters: ArchiveFilters = {
  query: "",
  topic: "",
  author: "",
  institution: "",
  source: "",
  section: "",
};

function archiveParams(filters: ArchiveFilters): URLSearchParams {
  const params = new URLSearchParams();
  const values: ReadonlyArray<readonly [string, string]> = [
    ["q", filters.query],
    ["topic", filters.topic],
    ["author", filters.author],
    ["institution", filters.institution],
    ["source", filters.source],
    ["section", filters.section],
  ];
  for (const [key, value] of values) {
    if (value.trim().length > 0) {
      params.set(key, value.trim());
    }
  }
  return params;
}

function archiveUrl(params: URLSearchParams): string {
  const query = params.toString();
  return query.length === 0 ? "/api/archive" : `/api/archive?${query}`;
}

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
  const [filters, setFilters] = useState<ArchiveFilters>(initialFilters);
  const [activeParams, setActiveParams] = useState(new URLSearchParams());
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

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
    setLoading(true);
    const params = archiveParams(filters);
    try {
      setPage(await archivePage(archiveUrl(params)));
      setActiveParams(params);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  async function nextPage(cursor: string) {
    setFailed(false);
    setLoading(true);
    const params = new URLSearchParams(activeParams);
    params.set("cursor", cursor);
    try {
      setPage(await archivePage(archiveUrl(params)));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  function updateFilter<Key extends keyof ArchiveFilters>(
    key: Key,
    value: ArchiveFilters[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
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
        <label htmlFor="archive-query">Search archive</label>
        <input
          id="archive-query"
          value={filters.query}
          onChange={(event) => updateFilter("query", event.target.value)}
        />
        <label htmlFor="archive-topic">Topic</label>
        <input
          id="archive-topic"
          value={filters.topic}
          onChange={(event) => updateFilter("topic", event.target.value)}
        />
        <label htmlFor="archive-author">Author</label>
        <input
          id="archive-author"
          value={filters.author}
          onChange={(event) => updateFilter("author", event.target.value)}
        />
        <label htmlFor="archive-institution">Institution</label>
        <input
          id="archive-institution"
          value={filters.institution}
          onChange={(event) => updateFilter("institution", event.target.value)}
        />
        <label htmlFor="archive-source">Source</label>
        <input
          id="archive-source"
          value={filters.source}
          onChange={(event) => updateFilter("source", event.target.value)}
        />
        <label htmlFor="archive-section">Section</label>
        <select
          id="archive-section"
          value={filters.section}
          onChange={(event) =>
            updateFilter(
              "section",
              event.target.value as ArchiveFilters["section"],
            )
          }
        >
          <option value="">All sections</option>
          <option value="morning_brief">Morning brief</option>
          <option value="research">Research</option>
          <option value="research_radar">Research radar</option>
          <option value="world">World</option>
          <option value="technology">Technology</option>
          <option value="ai_policy">AI policy</option>
          <option value="dmv">DMV</option>
          <option value="baltimore">Baltimore</option>
          <option value="forecast">Forecast</option>
        </select>
        <button type="submit" disabled={loading}>Apply filters</button>
      </form>
      {failed ? <p role="alert">The archive is unavailable.</p> : null}
      {page === null ? (
        <p aria-busy="true">Loading archive…</p>
      ) : (
        <>
          {page.items.length === 0 ? <p>No archive items found.</p> : null}
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
              disabled={loading}
              onClick={() => void nextPage(page.nextCursor!)}
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
