import {
  DiscoveryLaneDiagnosticSchema,
  type DiscoveryLaneDiagnostic,
  type DiscoveryRejectionReason,
} from "../sources/types";

export type DiscoveryDiagnosticRef = {
  laneId: string;
  identity: string;
};

export class DiscoveryDiagnosticsTracker {
  private diagnostics: DiscoveryLaneDiagnostic[];
  private readonly rejected = new Set<string>();

  constructor(input: readonly DiscoveryLaneDiagnostic[]) {
    this.diagnostics = input.map((value) =>
      DiscoveryLaneDiagnosticSchema.parse(value)
    );
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
      const key = `${reason}\u0000${ref.laneId}\u0000${ref.identity}`;
      if (this.rejected.has(key)) continue;
      this.rejected.add(key);
      diagnostic.rejectionCounts[reason] = Math.min(
        10_000,
        (diagnostic.rejectionCounts[reason] ?? 0) + 1,
      );
    }
  }

  snapshot(): DiscoveryLaneDiagnostic[] {
    return this.diagnostics
      .map((value) => DiscoveryLaneDiagnosticSchema.parse(value))
      .sort((left, right) => left.laneId.localeCompare(right.laneId));
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
}
