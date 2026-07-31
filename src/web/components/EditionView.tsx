import { useMemo, useState } from "react";

import type {
  EditionEntry,
  EditionSection,
  EditionWithEntries,
} from "../../contracts/editorial";
import { NewsClusterCard } from "./NewsClusterCard";
import { PaperCard } from "./PaperCard";
import { ReadingProgress } from "./ReadingProgress";
import { sectionLabels, Sidebar } from "./Sidebar";

type EditionViewProps = {
  edition: EditionWithEntries;
};

const sectionOrder: readonly EditionSection[] = [
  "morning_brief",
  "research",
  "research_radar",
  "world",
  "technology",
  "ai_policy",
  "dmv",
  "baltimore",
  "forecast",
];

function formatEditionDate(editionDate: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${editionDate}T12:00:00.000Z`));
}

function MorningBrief({ entries }: { entries: readonly EditionEntry[] }) {
  return (
    <ol className="morning-list">
      {entries.map((entry, index) => (
        <li key={entry.id} data-entry-id={entry.id} tabIndex={-1}>
          <a href={`#detail-${entry.itemId ?? entry.id}`}>
            <span className="morning-number">{String(index + 1).padStart(2, "0")}</span>
            <span>
              <strong>{entry.summary.title}</strong>
              <span>{entry.summary.oneSentence}</span>
            </span>
            <span aria-hidden="true">↘</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

export function EditionView({ edition }: EditionViewProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const grouped = useMemo(() => {
    const result = new Map<EditionSection, EditionEntry[]>();
    for (const entry of edition.entries) {
      const group = result.get(entry.section) ?? [];
      group.push(entry);
      result.set(entry.section, group);
    }
    return result;
  }, [edition.entries]);
  const sections = sectionOrder.filter((section) => grouped.has(section));
  const entryIds = useMemo(
    () => edition.entries.map((entry) => entry.id),
    [edition.entries],
  );

  return (
    <div className="reader-shell">
      <ReadingProgress editionDate={edition.editionDate} entryIds={entryIds} />
      <header className="site-header">
        <a className="brand" href="/" aria-label="Optimist Briefing home">
          <span className="brand-mark" aria-hidden="true">O</span>
          <span>Optimist Briefing</span>
        </a>
        <button
          className="menu-button"
          type="button"
          aria-label={menuOpen ? "Close briefing menu" : "Open briefing menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
          Menu
        </button>
        <p className="header-date">{formatEditionDate(edition.editionDate)}</p>
      </header>

      <div className="reader-layout">
        <Sidebar
          sections={sections}
          open={menuOpen}
          onNavigate={() => setMenuOpen(false)}
        />
        <main id="briefing-main" className="edition">
          <div className="edition-masthead">
            <p className="edition-kicker">Your private morning briefing</p>
            <h1>The day, thoughtfully distilled.</h1>
            <div className="edition-meta">
              <span>
                {edition.readingMinutes === null
                  ? "Reading time unavailable"
                  : `${edition.readingMinutes} minute read`}
              </span>
              <span>
                {edition.status === "partial" ? "Partial edition" : "Complete edition"}
              </span>
            </div>
          </div>

          {sections.map((section) => {
            const entries = grouped.get(section) ?? [];
            return (
              <section
                className={`edition-section section-${section}`}
                id={section}
                key={section}
                aria-labelledby={`${section}-heading`}
              >
                <div className="section-heading">
                  <p>{section === "morning_brief" ? "3 minute overview" : "Today"}</p>
                  <h2 id={`${section}-heading`}>{sectionLabels[section]}</h2>
                  <span>{entries.length} {entries.length === 1 ? "item" : "items"}</span>
                </div>
                {section === "morning_brief" ? (
                  <MorningBrief entries={entries} />
                ) : section === "research" || section === "research_radar" ? (
                  <div className="card-stack">
                    {entries.map((entry) => (
                      <div id={`detail-${entry.itemId ?? entry.id}`} key={entry.id}>
                        <PaperCard
                          entry={entry}
                          compact={section === "research_radar"}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="card-stack">
                    {entries.map((entry) => (
                      <div id={`detail-${entry.itemId ?? entry.id}`} key={entry.id}>
                        <NewsClusterCard entry={entry} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </main>
      </div>
      <footer className="site-footer">
        <p>Thank you to arXiv for use of its open access interoperability.</p>
        <p>Sources remain the record. Summaries are a reading aid.</p>
      </footer>
    </div>
  );
}
