import { describe, expect, it } from "vitest";

import {
  DiscoveryDiagnosticsTracker,
  type DiscoveryDiagnosticRef,
} from "../../../src/workflow/discovery-diagnostics";
import type { DiscoveryLaneDiagnostic } from "../../../src/sources/types";

function diagnostic(
  laneId: string,
  discovered: number,
): DiscoveryLaneDiagnostic {
  return {
    laneId,
    sourceId: laneId.split(":")[0] ?? laneId,
    discoveryFamily: "arxiv",
    discovered,
    deduplicated: 0,
    triaged: 0,
    assessed: 0,
    outcome: "success",
    rejectionCounts: {},
  };
}

describe("DiscoveryDiagnosticsTracker", () => {
  it("deduplicates identities per lane and clamps every funnel stage to its predecessor", () => {
    const tracker = new DiscoveryDiagnosticsTracker([
      diagnostic("lane:b", 2),
      diagnostic("lane:a", 1),
    ]);
    const refs: DiscoveryDiagnosticRef[] = [
      { laneId: "lane:a", identity: "paper-1" },
      { laneId: "lane:a", identity: "paper-1" },
      { laneId: "lane:a", identity: "paper-2" },
      { laneId: "lane:b", identity: "paper-1" },
      { laneId: "unknown:lane", identity: "private-candidate" },
    ];

    tracker.setStage("deduplicated", refs);
    tracker.setStage("triaged", refs);
    tracker.setStage("assessed", refs);

    expect(tracker.snapshot()).toEqual([
      {
        ...diagnostic("lane:a", 1),
        deduplicated: 1,
        triaged: 1,
        assessed: 1,
      },
      {
        ...diagnostic("lane:b", 2),
        deduplicated: 1,
        triaged: 1,
        assessed: 1,
      },
    ]);
  });

  it("counts each rejection identity once per reason and ignores unknown lanes", () => {
    const tracker = new DiscoveryDiagnosticsTracker([
      diagnostic("arxiv:one", 3),
    ]);
    const refs = [
      { laneId: "arxiv:one", identity: "paper-1" },
      { laneId: "arxiv:one", identity: "paper-1" },
      { laneId: "arxiv:one", identity: "paper-2" },
      { laneId: "unknown:lane", identity: "provider-private-id" },
    ];

    tracker.reject("identity_merged", refs);
    tracker.reject("identity_merged", refs);
    tracker.reject("capacity_limited", refs.slice(0, 1));

    expect(tracker.snapshot()[0]?.rejectionCounts).toEqual({
      identity_merged: 2,
      capacity_limited: 1,
    });
    expect(JSON.stringify(tracker.snapshot())).not.toContain("paper-1");
    expect(JSON.stringify(tracker.snapshot())).not.toContain(
      "provider-private-id",
    );
  });

  it("caps a rejection count at 10,000", () => {
    const tracker = new DiscoveryDiagnosticsTracker([
      diagnostic("arxiv:one", 10_000),
    ]);

    tracker.reject(
      "route_excluded",
      Array.from({ length: 10_001 }, (_, index) => ({
        laneId: "arxiv:one",
        identity: `candidate-${index}`,
      })),
    );

    expect(tracker.snapshot()[0]?.rejectionCounts).toEqual({
      route_excluded: 10_000,
    });
  });
});
