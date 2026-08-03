// @vitest-environment jsdom

import {
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
import { RunStatusPage } from "../../../src/web/pages/RunStatusPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

describe("RunStatusPage", () => {
  it("renders only bounded discovery counts and sanitized labels", async () => {
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
      "Outcome",
    ]);
    expect(within(table).getByText("arxiv:oversight-governance")).toBeTruthy();
    for (const value of ["7", "5", "3", "2", "success"]) {
      expect(within(table).getByText(value)).toBeTruthy();
    }
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("do-not-render");
      expect(document.querySelector(
        'a[href*="provider.example"]',
      )).toBeNull();
    });
  });
});
