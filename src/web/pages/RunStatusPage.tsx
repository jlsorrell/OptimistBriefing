import { useEffect, useState } from "react";

import type {
  WorkflowRun,
  WorkflowRunDetail,
} from "../../db/repository";

export function RunStatusPage() {
  const [runs, setRuns] = useState<readonly WorkflowRun[] | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/runs", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Run list request failed");
        }
        return await response.json() as readonly WorkflowRun[];
      })
      .then(setRuns)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, []);

  async function selectRun(runId: string) {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) {
      setFailed(true);
      return;
    }
    setDetail(await response.json() as WorkflowRunDetail);
  }

  return (
    <main className="state-page">
      <p className="edition-kicker">Operations</p>
      <h1>Run status</h1>
      {failed ? <p role="alert">Run status is unavailable.</p> : null}
      {runs === null ? (
        <p aria-busy="true">Loading runs…</p>
      ) : (
        <ul>
          {runs.map((run) => (
            <li key={run.id}>
              <button type="button" onClick={() => void selectRun(run.id)}>
                {run.editionDate}: {run.status}
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail === null ? null : (
        <section aria-labelledby="run-detail-heading">
          <h2 id="run-detail-heading">{detail.editionDate} run</h2>
          <p>Published: {detail.publishedAt ?? "Not published"}</p>
          <p>Attempts: {detail.attemptCount}</p>
          <p>
            Estimated monthly cost: ${detail.estimatedMonthlyCostUsd.toFixed(2)}
          </p>
          <h3>Checkpoints</h3>
          <ul>
            {detail.checkpoints.map((checkpoint) => (
              <li key={checkpoint.step}>
                {checkpoint.step}: {checkpoint.state}; {checkpoint.attempts} attempts
              </li>
            ))}
          </ul>
          <h3>Source failures</h3>
          <ul>
            {detail.sourceFailures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
          <h3>Rejected summaries</h3>
          <ul>
            {detail.rejectedSummaryReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <h3>Attempt failures</h3>
          <ul>
            {detail.failures.map((failure) => (
              <li key={`${failure.step}:${failure.attempt}`}>
                {failure.step} attempt {failure.attempt}: {failure.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p><a href="/">Return to today’s edition</a></p>
    </main>
  );
}
