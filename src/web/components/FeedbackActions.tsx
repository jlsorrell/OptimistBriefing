import { useState } from "react";

type FeedbackActionsProps = {
  itemId: string | null;
};

type FeedbackAction = "save" | "unsave" | "more_like_this" | "less_like_this";

export function FeedbackActions({ itemId }: FeedbackActionsProps) {
  const [saved, setSaved] = useState(false);
  const [preference, setPreference] = useState<"more" | "less" | null>(null);
  const [pending, setPending] = useState<FeedbackAction | null>(null);
  const [error, setError] = useState("");

  async function record(action: FeedbackAction) {
    if (itemId === null || pending !== null) {
      return;
    }
    setPending(action);
    setError("");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, action, reason: null }),
      });
      if (!response.ok) {
        throw new Error("Feedback request failed");
      }
      if (action === "save" || action === "unsave") {
        setSaved(action === "save");
        window.dispatchEvent(new CustomEvent("briefing:saved-changed"));
      } else {
        setPreference(action === "more_like_this" ? "more" : "less");
      }
    } catch {
      setError("Feedback could not be saved.");
    } finally {
      setPending(null);
    }
  }

  const disabled = itemId === null || pending !== null;

  return (
    <div className="feedback-actions" aria-label="Reader feedback">
      <button
        className={saved ? "feedback-button is-active" : "feedback-button"}
        type="button"
        aria-pressed={saved}
        disabled={disabled}
        onClick={() => void record(saved ? "unsave" : "save")}
      >
        <span aria-hidden="true">{saved ? "★" : "☆"}</span>
        {saved ? "Saved" : "Save"}
      </button>
      <button
        className={preference === "more" ? "feedback-button is-active" : "feedback-button"}
        type="button"
        aria-pressed={preference === "more"}
        disabled={disabled}
        onClick={() => void record("more_like_this")}
      >
        <span aria-hidden="true">↑</span>
        More like this
      </button>
      <button
        className={preference === "less" ? "feedback-button is-active" : "feedback-button"}
        type="button"
        aria-pressed={preference === "less"}
        disabled={disabled}
        onClick={() => void record("less_like_this")}
      >
        <span aria-hidden="true">↓</span>
        Less like this
      </button>
      <span className="visually-hidden" aria-live="polite">
        {[
          pending === null ? "" : "Saving feedback",
          saved && itemId !== null ? `${itemId} saved` : "",
          preference === "more" && itemId !== null
            ? `${itemId}: more like this selected`
            : "",
          preference === "less" && itemId !== null
            ? `${itemId}: less like this selected`
            : "",
        ]
          .filter(Boolean)
          .join(". ")}
      </span>
      {error.length > 0 ? <span role="alert">{error}</span> : null}
    </div>
  );
}
