import { useEffect, useState } from "react";

import type { EditionWithEntries } from "../contracts/editorial";
import { BriefingApiClient } from "./api-client";
import { EditionView } from "./components/EditionView";

const api = new BriefingApiClient();

export function App() {
  const [edition, setEdition] = useState<EditionWithEntries | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .latestEdition(controller.signal)
      .then(setEdition)
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(true);
        }
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <main className="state-page">
        <p className="edition-kicker">Optimist Briefing</p>
        <h1>Today’s edition is taking a little longer.</h1>
        <p>The previous published edition remains safe. Please try again shortly.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  if (edition === null) {
    return (
      <main className="state-page" aria-busy="true">
        <p className="edition-kicker">Optimist Briefing</p>
        <h1>Gathering today’s edition…</h1>
      </main>
    );
  }
  return <EditionView edition={edition} />;
}
