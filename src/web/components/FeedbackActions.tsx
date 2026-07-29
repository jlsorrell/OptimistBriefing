import { useState } from "react";

type FeedbackActionsProps = {
  entryId: string;
};

export function FeedbackActions({ entryId }: FeedbackActionsProps) {
  const [saved, setSaved] = useState(false);
  const [preference, setPreference] = useState<"more" | "less" | null>(null);

  return (
    <div className="feedback-actions" aria-label="Reader feedback">
      <button
        className={saved ? "feedback-button is-active" : "feedback-button"}
        type="button"
        aria-pressed={saved}
        onClick={() => setSaved((current) => !current)}
      >
        <span aria-hidden="true">{saved ? "★" : "☆"}</span>
        {saved ? "Saved" : "Save"}
      </button>
      <button
        className={preference === "more" ? "feedback-button is-active" : "feedback-button"}
        type="button"
        aria-pressed={preference === "more"}
        onClick={() =>
          setPreference((current) => (current === "more" ? null : "more"))
        }
      >
        <span aria-hidden="true">↑</span>
        More like this
      </button>
      <button
        className={preference === "less" ? "feedback-button is-active" : "feedback-button"}
        type="button"
        aria-pressed={preference === "less"}
        onClick={() =>
          setPreference((current) => (current === "less" ? null : "less"))
        }
      >
        <span aria-hidden="true">↓</span>
        Less like this
      </button>
      <span className="visually-hidden" aria-live="polite">
        {[
          saved ? `${entryId} saved` : "",
          preference === "more" ? `${entryId}: more like this selected` : "",
          preference === "less" ? `${entryId}: less like this selected` : "",
        ]
          .filter(Boolean)
          .join(". ")}
      </span>
    </div>
  );
}
