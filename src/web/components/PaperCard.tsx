import type { EditionEntry, SourceRef } from "../../contracts/editorial";
import { FeedbackActions } from "./FeedbackActions";

const accessLabels = {
  metadata: "Metadata only",
  abstract: "Abstract only",
  full_text: "Full text",
  secondary: "Secondary coverage",
} as const;

const sourceRoleLabels: Readonly<Record<SourceRef["role"], string>> = {
  primary: "Primary source",
  reporting: "Reporting",
  analysis: "Analysis",
  opinion: "Opinion",
  blog: "Research blog",
  forecast: "Forecast",
};

type PaperCardProps = {
  entry: EditionEntry;
  compact?: boolean;
};

export function PaperCard({ entry, compact = false }: PaperCardProps) {
  const primarySource = entry.sourceRefs.find((source) => source.role === "primary");

  return (
    <article
      className={compact ? "entry-card paper-card is-compact" : "entry-card paper-card"}
      data-entry-id={entry.id}
      tabIndex={-1}
    >
      <div className="card-eyebrow">
        <span className="content-label">
          <span aria-hidden="true">⌁</span>
          {compact ? "Research radar" : "Featured research"}
        </span>
        <span className="access-label">{accessLabels[entry.summary.accessLevel]}</span>
      </div>
      <h3>{entry.summary.title}</h3>
      <p className="dek">{entry.summary.oneSentence}</p>
      {!compact && (
        <>
          <div className="paper-grid">
            <section>
              <h4>Why it matters</h4>
              <p>{entry.summary.whyItMatters}</p>
            </section>
            <section>
              <h4>Reasons for skepticism</h4>
              <p>{entry.summary.uncertainty}</p>
            </section>
          </div>
          <section className="claim-list" aria-labelledby={`${entry.id}-claims`}>
            <h4 id={`${entry.id}-claims`}>What the evidence says</h4>
            <ol>
              {entry.summary.claims.map((claim) => (
                <li key={`${entry.id}-${claim.text}`}>
                  <p>{claim.text}</p>
                  <small>{claim.evidenceExcerpt}</small>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
      <details className="selection-reasons">
        <summary>Why this was selected</summary>
        <ul>
          {entry.selectionReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </details>
      <div className="source-list" aria-label="Sources">
        {entry.sourceRefs.map((source) => (
          <a key={source.id} href={source.url} rel="noreferrer">
            <span aria-hidden="true">
              {source.role === "primary" ? "▣" : source.role === "blog" ? "✦" : "↗"}
            </span>
            <span>
              {source.id === primarySource?.id ? "Open paper" : source.name}
              <small>{sourceRoleLabels[source.role]}</small>
            </span>
          </a>
        ))}
      </div>
      <FeedbackActions entryId={entry.id} />
    </article>
  );
}
