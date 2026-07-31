import type { RetentionReport } from "../contracts/editorial";

export type RetentionRepository = {
  pruneExpiredData(now: string): Promise<RetentionReport>;
  recordRetentionAudit(now: string, report: RetentionReport): Promise<void>;
};

export async function pruneExpiredData(
  repository: RetentionRepository,
  now: string,
): Promise<RetentionReport> {
  const report = await repository.pruneExpiredData(now);
  await repository.recordRetentionAudit(now, report);
  return report;
}
