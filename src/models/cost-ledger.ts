import { z } from "zod";

const TokenCountSchema = z.number().int().nonnegative().max(10_000_000);
const MoneySchema = z.number().finite().nonnegative().max(1_000_000);

export const ProviderCallRecordSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  embeddingCount: TokenCountSchema,
  unitPriceUsd: MoneySchema,
  estimatedCostUsd: MoneySchema,
}).strict();

export type ProviderCallRecord = z.infer<typeof ProviderCallRecordSchema>;

const CostLedgerConfigSchema = z.object({
  monthlyLimitUsd: MoneySchema.positive(),
  unitPricesUsd: z.record(z.string().min(1).max(200), MoneySchema.positive()),
}).strict();

export type BudgetPolicy = {
  state: "normal" | "warning" | "degraded" | "hard_stop";
  radarSummaryTokens: number;
  featuredSummaryTokens: number;
};

export function policyForSpend(spendUsd: number, monthlyLimitUsd: number): BudgetPolicy {
  if (!Number.isFinite(spendUsd) || spendUsd < 0 || !Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0) {
    throw new RangeError("Budget spend and limit must be finite positive values.");
  }
  const ratio = spendUsd / monthlyLimitUsd;
  if (ratio >= 1) return { state: "hard_stop", radarSummaryTokens: 0, featuredSummaryTokens: 900 };
  if (ratio >= 0.9) return { state: "degraded", radarSummaryTokens: 120, featuredSummaryTokens: 900 };
  if (ratio >= 0.7) return { state: "warning", radarSummaryTokens: 300, featuredSummaryTokens: 900 };
  return { state: "normal", radarSummaryTokens: 300, featuredSummaryTokens: 900 };
}

export class CostLedger {
  readonly #config: z.infer<typeof CostLedgerConfigSchema>;
  #spendUsd = 0;

  constructor(config: z.input<typeof CostLedgerConfigSchema>) {
    this.#config = CostLedgerConfigSchema.parse(config);
  }

  get spendUsd(): number {
    return this.#spendUsd;
  }

  get policy(): BudgetPolicy {
    return policyForSpend(this.#spendUsd, this.#config.monthlyLimitUsd);
  }

  record(usage: Omit<ProviderCallRecord, "unitPriceUsd" | "estimatedCostUsd">): ProviderCallRecord {
    const unitPriceUsd = this.#config.unitPricesUsd[usage.model];
    if (unitPriceUsd === undefined) throw new Error(`UNBUDGETED_MODEL:${usage.model}`);
    const record = ProviderCallRecordSchema.parse({
      ...usage,
      unitPriceUsd,
      estimatedCostUsd: (usage.inputTokens + usage.outputTokens + usage.embeddingCount) * unitPriceUsd,
    });
    this.#spendUsd += record.estimatedCostUsd;
    return record;
  }
}
