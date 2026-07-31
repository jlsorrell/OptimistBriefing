import { describe, expect, it } from "vitest";

import { pruneExpiredData } from "../../../src/maintenance/retention";

const fixedNow = "2026-07-29T10:00:00.000Z";

describe("pruneExpiredData", () => {
  it("deletes expired candidates and logs without deleting published edition items", async () => {
    const events: unknown[] = [];
    const repository = {
      async pruneExpiredData(now: string) {
        expect(now).toBe(fixedNow);
        return {
          deletedUnselectedCandidates: 2,
          deletedWorkflowRuns: 1,
          deletedWorkflowArtifacts: 4,
          deletedDiagnosticLogs: 3,
        };
      },
      async recordRetentionAudit(now: string, report: unknown) {
        events.push({ now, report });
      },
      async getEditionByDate(date: string) {
        return date === "2026-07-28" ? { id: "published-edition" } : null;
      },
    };

    const report = await pruneExpiredData(repository, fixedNow);
    expect(report.deletedUnselectedCandidates).toBe(2);
    expect(report.deletedWorkflowArtifacts).toBe(4);
    expect(report.deletedDiagnosticLogs).toBe(3);
    expect(await repository.getEditionByDate("2026-07-28")).not.toBeNull();
    expect(events).toEqual([{ now: fixedNow, report }]);
  });

  it("does not write an audit event when pruning fails", async () => {
    let audited = false;
    await expect(pruneExpiredData({
      pruneExpiredData: async () => { throw new Error("D1_UNAVAILABLE"); },
      recordRetentionAudit: async () => { audited = true; },
    }, fixedNow)).rejects.toThrow("D1_UNAVAILABLE");
    expect(audited).toBe(false);
  });
});
