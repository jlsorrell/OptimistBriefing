import type { EditionEntry, SourceRef } from "../../contracts/editorial";
import { FeedbackActions } from "./FeedbackActions";

const sourceRoleLabels: Readonly<Record<SourceRef["role"], string>> = {
  primary: "Primary document",
  reporting: "Reporting",
  analysis: "Analysis",
  opinion: "Opinion",
  blog: "Blog",
  forecast: "Forecast signal",
};

type NewsClusterCardProps = {
  entry: EditionEntry;
};

export function NewsClusterCard({ entry }: NewsClusterCardProps) {
  const forecast = entry.section === "forecast";
  const qualifyingSources = new Map(
    entry.sourceRefs
      .filter(
        (source) =>
          source.role === "primary" || source.role === "reporting",
      )
      .map((source) => [source.name.trim().toLowerCase(), source] as const),
  );
  const qualifyingSourceCount = qualifyingSources.size;
  const onlyQualifyingSource = qualifyingSources.values().next().value as
    | SourceRef
    | undefined;
  const evidenceLabel = forecast
    ? "Market signal"
    : qualifyingSourceCount > 1
      ? "Corroborated"
      : onlyQualifyingSource?.role === "primary"
        ? "Primary document"
        : qualifyingSourceCount === 1
          ? "Single report"
          : "Context only";

  return (
    <article
      className={forecast ? "entry-card news-card forecast-card" : "entry-card news-card"}
      data-entry-id={entry.id}
      tabIndex={-1}
    >
      <div className="card-eyebrow">
        <span className="content-label">
          <span aria-hidden="true">{forecast ? "◇" : "●"}</span>
          {forecast ? "Forecast — not a fact" : "Reported development"}
        </span>
        <span className="confidence-label">
          <span aria-hidden="true">{qualifyingSourceCount > 1 ? "✓" : "◎"}</span>
          {evidenceLabel}
        </span>
      </div>
      <h3>{entry.summary.title}</h3>
      <p className="dek">{entry.summary.oneSentence}</p>
      <div className="news-detail">
        <section>
          <h4>Why it matters</h4>
          <p>{entry.summary.whyItMatters}</p>
        </section>
        <section>
          <h4>{forecast ? "What could change" : "What remains uncertain"}</h4>
          <p>{entry.summary.uncertainty}</p>
        </section>
      </div>
      <div className="source-list" aria-label="Sources">
        {entry.sourceRefs.map((source) => (
          <a key={source.id} href={source.url} rel="noreferrer">
            <span aria-hidden="true">
              {source.role === "primary" ? "▣" : source.role === "forecast" ? "◇" : "↗"}
            </span>
            <span>
              {source.name}
              <small>{sourceRoleLabels[source.role]}</small>
            </span>
          </a>
        ))}
      </div>
      <FeedbackActions entryId={entry.id} />
    </article>
  );
}
