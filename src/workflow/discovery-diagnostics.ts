import {
  DiscoveryDiagnosticsOwnerStageSchema,
  DiscoveryDiagnosticsStateSchema,
  DiscoveryLaneDiagnosticSchema,
  type DiscoveryDiagnosticsOwnerStage,
  type DiscoveryDiagnosticsState,
  type DiscoveryLaneDiagnostic,
  type DiscoveryRejectionCounts,
  type DiscoveryRejectionReason,
} from "../sources/types";

export type DiscoveryDiagnosticRef = {
  laneId: string;
  identity: string;
};

export class DiscoveryDiagnosticsTracker {
  private diagnostics: DiscoveryLaneDiagnostic[];
  private rejectionCountsByStage: DiscoveryDiagnosticsState["rejectionCountsByStage"];
  private rejected = new Set<string>();
  private activeStage: DiscoveryDiagnosticsOwnerStage = "normalize";

  constructor(
    input: readonly DiscoveryLaneDiagnostic[] | DiscoveryDiagnosticsState,
  ) {
    const state = DiscoveryDiagnosticsStateSchema.parse(
      Array.isArray(input)
        ? {
            diagnostics: input.map((diagnostic) => ({
              ...diagnostic,
              rejectionCounts: {},
            })),
            rejectionCountsByStage: emptyRejectionCountsByStage(),
          }
        : input,
    );
    this.diagnostics = state.diagnostics.map((value) =>
      DiscoveryLaneDiagnosticSchema.parse({ ...value, rejectionCounts: {} })
    );
    this.rejectionCountsByStage = structuredClone(
      state.rejectionCountsByStage,
    );
    this.refreshRejectionCounts();
  }

  beginStage(stage: DiscoveryDiagnosticsOwnerStage): void {
    this.activeStage = DiscoveryDiagnosticsOwnerStageSchema.parse(stage);
    this.rejectionCountsByStage[this.activeStage] = [];
    this.rejected = new Set<string>();
    this.refreshRejectionCounts();
  }

  setStage(
    stage: "deduplicated" | "triaged" | "assessed",
    refs: readonly DiscoveryDiagnosticRef[],
  ): void {
    const identities = this.identitiesByLane(refs);
    this.diagnostics = this.diagnostics.map((diagnostic) => {
      const preceding = stage === "deduplicated"
        ? diagnostic.discovered
        : stage === "triaged"
          ? diagnostic.deduplicated
          : diagnostic.triaged;
      return DiscoveryLaneDiagnosticSchema.parse({
        ...diagnostic,
        [stage]: Math.min(
          preceding,
          identities.get(diagnostic.laneId)?.size ?? 0,
        ),
      });
    });
  }

  reject(
    reason: DiscoveryRejectionReason,
    refs: readonly DiscoveryDiagnosticRef[],
  ): void {
    for (const ref of refs) {
      const diagnostic = this.diagnostics.find(
        ({ laneId }) => laneId === ref.laneId,
      );
      if (!diagnostic) continue;
      const key = `${this.activeStage}\u0000${reason}\u0000${ref.laneId}\u0000${ref.identity}`;
      if (this.rejected.has(key)) continue;
      this.rejected.add(key);
      const stageCounts = this.stageCountsForLane(ref.laneId);
      stageCounts[reason] = Math.min(
        10_000,
        (stageCounts[reason] ?? 0) + 1,
      );
    }
    this.refreshRejectionCounts();
  }

  snapshot(): DiscoveryLaneDiagnostic[] {
    return this.diagnostics
      .map((value) => DiscoveryLaneDiagnosticSchema.parse(value))
      .sort((left, right) => left.laneId.localeCompare(right.laneId));
  }

  state(): DiscoveryDiagnosticsState {
    const rejectionCountsByStage = Object.fromEntries(
      DiscoveryDiagnosticsOwnerStageSchema.options.map((stage) => [
        stage,
        [...this.rejectionCountsByStage[stage]].sort((left, right) =>
          left.laneId.localeCompare(right.laneId)
        ),
      ]),
    );
    return DiscoveryDiagnosticsStateSchema.parse({
      diagnostics: this.snapshot(),
      rejectionCountsByStage,
    });
  }

  private identitiesByLane(
    refs: readonly DiscoveryDiagnosticRef[],
  ): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const ref of refs) {
      const identities = result.get(ref.laneId) ?? new Set<string>();
      identities.add(ref.identity);
      result.set(ref.laneId, identities);
    }
    return result;
  }

  private stageCountsForLane(
    laneId: string,
  ): DiscoveryRejectionCounts {
    const entries = this.rejectionCountsByStage[this.activeStage];
    const existing = entries.find((entry) => entry.laneId === laneId);
    if (existing !== undefined) return existing.rejectionCounts;
    const created = { laneId, rejectionCounts: {} };
    entries.push(created);
    return created.rejectionCounts;
  }

  private refreshRejectionCounts(): void {
    this.diagnostics = this.diagnostics.map((diagnostic) => {
      const rejectionCounts: DiscoveryRejectionCounts = {};
      for (const stage of DiscoveryDiagnosticsOwnerStageSchema.options) {
        const stageCounts = this.rejectionCountsByStage[stage].find(
          ({ laneId }) => laneId === diagnostic.laneId,
        )?.rejectionCounts ?? {};
        for (const [reason, count] of Object.entries(stageCounts) as Array<
          [DiscoveryRejectionReason, number]
        >) {
          rejectionCounts[reason] = Math.min(
            10_000,
            (rejectionCounts[reason] ?? 0) + count,
          );
        }
      }
      return DiscoveryLaneDiagnosticSchema.parse({
        ...diagnostic,
        rejectionCounts,
      });
    });
  }
}

function emptyRejectionCountsByStage(): DiscoveryDiagnosticsState[
  "rejectionCountsByStage"
] {
  return {
    normalize: [],
    prefilter: [],
    assess: [],
    shortlist: [],
  };
}
