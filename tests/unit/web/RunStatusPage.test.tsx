// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorkflowRun,
  WorkflowRunDetail,
} from "../../../src/db/repository";
import {
  RunStatusPage,
  localDateInputValue,
} from "../../../src/web/pages/RunStatusPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}

function workflowRun(
  id: string,
  editionDate: string,
  status: WorkflowRun["status"],
): WorkflowRun {
  return {
    id,
    editionDate,
    status,
    currentStep: null,
    retryable: false,
    attemptCount: 0,
    failureCode: null,
    estimatedCostUsd: 0,
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stubRunListThenStart(result: Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (String(input) === "/api/runs") return jsonResponse([]);
    if (result instanceof Error) throw result;
    return result;
  }));
}

async function submitCanaryDate(editionDate: string) {
  fireEvent.change(await screen.findByLabelText("Edition date"), {
    target: { value: editionDate },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start canary run" }));
}

describe("RunStatusPage", () => {
  it("defaults the canary date from local calendar components", async () => {
    expect(localDateInputValue({
      getFullYear: () => 2026,
      getMonth: () => 7,
      getDate: () => 3,
    })).toBe("2026-08-03");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 3, 8, 30));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    render(<RunStatusPage />);

    expect(screen.getByLabelText("Edition date")).toHaveProperty(
      "value",
      "2026-08-03",
    );
    expect(screen.getByText("Starting a run may incur model costs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start canary run" })).toBeTruthy();
  });

  it("starts one canary and refreshes the run list after success", async () => {
    const pending = deferredResponse();
    const initialRun = workflowRun("existing-run", "2026-08-02", "failed");
    const startedRun = workflowRun("2026-08-01", "2026-08-01", "pending");
    let listRequests = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/admin/runs") return pending.promise;
      listRequests += 1;
      return jsonResponse(listRequests === 1 ? [initialRun] : [startedRun, initialRun]);
    });
    vi.stubGlobal("fetch", fetch);
    render(<RunStatusPage />);

    const date = await screen.findByLabelText("Edition date");
    fireEvent.change(date, { target: { value: "2026-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Start canary run" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/admin/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editionDate: "2026-08-01" }),
      },
    ));
    expect((date as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", {
      name: "Starting canary run…",
    }) as HTMLButtonElement).disabled).toBe(true);

    pending.resolve(jsonResponse({ runId: "2026-08-01" }, 202));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Canary run 2026-08-01 started.",
    );
    expect(await screen.findByRole("button", {
      name: "2026-08-01: pending",
    })).toBeTruthy();
    expect(listRequests).toBe(2);
  });

  it("keeps the refreshed run list when the initial request resolves late", async () => {
    const initialList = deferredResponse();
    const initialRun = workflowRun("existing-run", "2026-08-02", "failed");
    const startedRun = workflowRun("2026-08-01", "2026-08-01", "pending");
    let listRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/admin/runs") {
        return jsonResponse({ runId: "2026-08-01" }, 202);
      }
      listRequests += 1;
      return listRequests === 1
        ? initialList.promise
        : jsonResponse([startedRun]);
    }));
    render(<RunStatusPage />);

    await submitCanaryDate("2026-08-01");
    expect(await screen.findByRole("button", {
      name: "2026-08-01: pending",
    })).toBeTruthy();

    await act(async () => {
      initialList.resolve(jsonResponse([initialRun]));
    });

    expect(screen.getByRole("button", {
      name: "2026-08-01: pending",
    })).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: "2026-08-02: failed",
    })).toBeNull();
  });

  it("explains when the selected edition date already has a run", async () => {
    stubRunListThenStart(jsonResponse({
      error: { code: "RUN_ALREADY_EXISTS", message: "A run already exists." },
    }, 409));
    render(<RunStatusPage />);
    await submitCanaryDate("2026-08-01");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A run already exists for 2026-08-01. Choose another date.",
    );
  });

  it.each([
    ["malformed success", jsonResponse({}, 202)],
    ["HTTP failure", jsonResponse({}, 500)],
  ] as const)("uses a generic safe message for %s", async (_name, response) => {
    stubRunListThenStart(response);
    render(<RunStatusPage />);
    await submitCanaryDate("2026-08-01");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The canary run could not be started.",
    );
  });

  it("uses a generic safe message for a network failure", async () => {
    stubRunListThenStart(new Error("private provider detail"));
    render(<RunStatusPage />);
    await submitCanaryDate("2026-08-01");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The canary run could not be started.",
    );
    expect(document.body.textContent).not.toContain("private provider detail");
  });

  it("renders bounded discovery rejection labels without private fields", async () => {
    const run: WorkflowRun = {
      id: "run-1",
      editionDate: "2026-08-02",
      status: "running",
      currentStep: "assess",
      retryable: false,
      attemptCount: 1,
      failureCode: null,
      estimatedCostUsd: 0,
      createdAt: "2026-08-02T09:00:00.000Z",
      updatedAt: "2026-08-02T09:01:00.000Z",
    };
    const detail: WorkflowRunDetail & Record<string, unknown> = {
      ...run,
      checkpoints: [],
      failures: [],
      sourceFailures: [],
      discoveryDiagnostics: [{
        laneId: "arxiv:oversight-governance",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        discovered: 7,
        deduplicated: 5,
        triaged: 3,
        assessed: 2,
        outcome: "success",
        rejectionCounts: {
          unchanged_observation: 2,
          capacity_limited: 1,
        },
      }, {
        laneId: "arxiv:empty",
        sourceId: "arxiv",
        discoveryFamily: "arxiv",
        discovered: 1,
        deduplicated: 1,
        triaged: 1,
        assessed: 1,
        outcome: "success",
        rejectionCounts: {},
      }],
      rejectedSummaryReasons: [],
      publishedAt: null,
      estimatedMonthlyCostUsd: 0,
      providerError: "private provider body do-not-render",
      providerUrl: "https://provider.example/private?token=do-not-render",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      jsonResponse(String(input) === "/api/runs" ? [run] : detail)
    ));

    render(<RunStatusPage />);
    fireEvent.click(await screen.findByRole("button", {
      name: "2026-08-02: running",
    }));

    const table = await screen.findByRole("table", {
      name: "Discovery diagnostics",
    });
    expect(within(table).getAllByRole("columnheader").map(
      (header) => header.textContent,
    )).toEqual([
      "Lane",
      "Discovered",
      "Deduplicated",
      "Triaged",
      "Assessed",
      "Rejections",
      "Outcome",
    ]);
    const laneRow = within(table).getByText("arxiv:oversight-governance")
      .closest("tr");
    expect(laneRow).not.toBeNull();
    expect(within(laneRow!).getByText(
      "Unchanged observation: 2; Capacity limited: 1",
    )).toBeTruthy();
    expect(within(table).getByText("None")).toBeTruthy();
    for (const value of ["7", "5", "3", "2", "success"]) {
      expect(within(laneRow!).getByText(value)).toBeTruthy();
    }
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("do-not-render");
      expect(document.querySelector(
        'a[href*="provider.example"]',
      )).toBeNull();
    });
  });
});
