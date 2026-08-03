import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  WorkflowRun,
  WorkflowRunDetail,
} from "../../db/repository";

type LocalDate = Pick<Date, "getFullYear" | "getMonth" | "getDate">;

type StartFeedback =
  | { kind: "success"; message: string }
  | { kind: "failure"; message: string }
  | null;

export function localDateInputValue(date: LocalDate): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startedRunId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("runId" in value)) {
    return null;
  }
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

export function RunStatusPage() {
  const [runs, setRuns] = useState<readonly WorkflowRun[] | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [editionDate, setEditionDate] = useState(() =>
    localDateInputValue(new Date())
  );
  const [starting, setStarting] = useState(false);
  const [startFeedback, setStartFeedback] = useState<StartFeedback>(null);
  const latestRunRequest = useRef(0);

  async function loadRuns(signal?: AbortSignal) {
    const request = ++latestRunRequest.current;
    try {
      const response = await fetch(
        "/api/runs",
        signal === undefined ? {} : { signal },
      );
      if (!response.ok) throw new Error("Run list request failed");
      const loadedRuns = await response.json() as readonly WorkflowRun[];
      if (request === latestRunRequest.current) setRuns(loadedRuns);
    } catch (error) {
      if (request === latestRunRequest.current) throw error;
    }
  }

  async function startCanary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStarting(true);
    setStartFeedback(null);
    try {
      const response = await fetch("/api/admin/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editionDate }),
      });
      if (response.status === 409) {
        setStartFeedback({
          kind: "failure",
          message: `A run already exists for ${editionDate}. Choose another date.`,
        });
        return;
      }
      if (!response.ok) throw new Error("Canary start failed");
      const runId = startedRunId(await response.json().catch(() => null));
      if (runId === null) throw new Error("Canary start response invalid");
      setStartFeedback({
        kind: "success",
        message: `Canary run ${runId} started.`,
      });
      try {
        await loadRuns();
      } catch {
        setFailed(true);
      }
    } catch {
      setStartFeedback({
        kind: "failure",
        message: "The canary run could not be started.",
      });
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadRuns(controller.signal)
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
      <section className="canary-control" aria-labelledby="canary-control-heading">
        <h2 id="canary-control-heading">Start canary run</h2>
        <p>Starting a run may incur model costs.</p>
        <form onSubmit={(event) => void startCanary(event)}>
          <label htmlFor="canary-edition-date">Edition date</label>
          <input
            id="canary-edition-date"
            type="date"
            required
            value={editionDate}
            disabled={starting}
            onChange={(event) => setEditionDate(event.currentTarget.value)}
          />
          <button type="submit" disabled={starting}>
            {starting ? "Starting canary run…" : "Start canary run"}
          </button>
        </form>
        {startFeedback?.kind === "success" ? (
          <p role="status">{startFeedback.message}</p>
        ) : null}
        {startFeedback?.kind === "failure" ? (
          <p role="alert">{startFeedback.message}</p>
        ) : null}
      </section>
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
          <h3>Discovery diagnostics</h3>
          <table aria-label="Discovery diagnostics">
            <thead>
              <tr>
                <th scope="col">Lane</th>
                <th scope="col">Discovered</th>
                <th scope="col">Deduplicated</th>
                <th scope="col">Triaged</th>
                <th scope="col">Assessed</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {detail.discoveryDiagnostics.map((diagnostic) => (
                <tr key={`${diagnostic.laneId}:${diagnostic.sourceId}`}>
                  <td>{diagnostic.laneId}</td>
                  <td>{diagnostic.discovered}</td>
                  <td>{diagnostic.deduplicated}</td>
                  <td>{diagnostic.triaged}</td>
                  <td>{diagnostic.assessed}</td>
                  <td>{diagnostic.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
