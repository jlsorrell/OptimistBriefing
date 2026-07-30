import { useEffect, useMemo, useState } from "react";

import type {
  FeedbackRecord,
  ReaderPreferences,
} from "../../db/repository";

type PreferencesPageProps = {
  initialPreferences?: ReaderPreferences;
  onRemoveAdjustment?: (feedbackId: string) => Promise<void>;
  onReset?: () => Promise<ReaderPreferences>;
};

const reasonLabels: Readonly<Record<string, string>> = {
  topic: "Topic",
  quality: "Quality",
  source: "Source",
  depth: "Depth",
  repetitive: "Repetitive",
  too_incremental: "Too incremental",
  other: "Other",
};

async function readPreferences(response: Response): Promise<ReaderPreferences> {
  if (!response.ok) {
    throw new Error("Preferences request failed");
  }
  return await response.json() as ReaderPreferences;
}

function feedbackAdjustments(history: readonly FeedbackRecord[]) {
  return history.flatMap((record) =>
    record.adjustments.map((adjustment) => ({ record, adjustment })),
  );
}

export function PreferencesPage({
  initialPreferences,
  onRemoveAdjustment,
  onReset,
}: PreferencesPageProps) {
  const [preferences, setPreferences] = useState<ReaderPreferences | null>(
    initialPreferences ?? null,
  );
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialPreferences !== undefined) {
      return;
    }
    const controller = new AbortController();
    void fetch("/api/preferences", { signal: controller.signal })
      .then(readPreferences)
      .then(setPreferences)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [initialPreferences]);

  const adjustments = useMemo(
    () => feedbackAdjustments(preferences?.feedbackHistory ?? []),
    [preferences],
  );

  async function removeAdjustment(feedbackId: string) {
    if (onRemoveAdjustment === undefined) {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ removeFeedbackId: feedbackId }),
      });
      setPreferences(await readPreferences(response));
    } else {
      await onRemoveAdjustment(feedbackId);
      setPreferences((current) =>
        current === null
          ? current
          : {
              ...current,
              feedbackHistory: current.feedbackHistory.filter(
                (record) => record.id !== feedbackId,
              ),
            },
      );
    }
    setMessage("Adjustment removed.");
  }

  async function reset() {
    const next =
      onReset === undefined
        ? await readPreferences(
            await fetch("/api/preferences/reset", { method: "POST" }),
          )
        : await onReset();
    setPreferences(next);
    setMessage("Preferences reset.");
  }

  if (failed) {
    return (
      <main className="state-page">
        <h1>Preferences are unavailable.</h1>
      </main>
    );
  }
  if (preferences === null) {
    return (
      <main className="state-page" aria-busy="true">
        <h1>Loading preferences…</h1>
      </main>
    );
  }

  return (
    <main className="state-page">
      <p className="edition-kicker">Reader controls</p>
      <h1>Preferences</h1>
      <p>
        Your approved profile stays visible separately from changes you make
        through briefing feedback.
      </p>

      <section aria-labelledby="baseline-heading">
        <h2 id="baseline-heading">Approved baseline</h2>
        <dl>
          {Object.entries(preferences.baseline.topicWeights).map(
            ([topic, weight]) => (
              <div key={topic}>
                <dt>{topic}</dt>
                <dd>{weight}</dd>
              </div>
            ),
          )}
        </dl>
      </section>

      <section aria-labelledby="adjustments-heading">
        <h2 id="adjustments-heading">Feedback adjustments</h2>
        {adjustments.length === 0 ? (
          <p>No feedback adjustments.</p>
        ) : (
          <ul>
            {adjustments.map(({ record, adjustment }) => (
              <li key={`${record.id}:${adjustment.dimension}:${adjustment.key}`}>
                <strong>{adjustment.key}</strong>{" "}
                <span>
                  {adjustment.delta < 0
                    ? `−${Math.abs(adjustment.delta)}`
                    : `+${adjustment.delta}`}
                </span>{" "}
                <span>{reasonLabels[record.reason ?? ""] ?? "No reason"}</span>
                <button
                  type="button"
                  aria-label={`Remove ${adjustment.key} feedback adjustment`}
                  onClick={() => void removeAdjustment(record.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <button type="button" onClick={() => void reset()}>
        Reset to approved baseline
      </button>
      <p role="status" aria-live="polite">{message}</p>
      <p><a href="/">Return to today’s edition</a></p>
    </main>
  );
}
