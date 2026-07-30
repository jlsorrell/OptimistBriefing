import { describe, expect, it } from "vitest";

import {
  CostLedger,
  ProviderCallRecordSchema,
  policyForSpend,
} from "../../../src/models/cost-ledger";
import type { ModelUsage } from "../../../src/models/provider";

describe("CostLedger", () => {
  it("reduces radar depth at ninety percent without degrading featured summaries", () => {
    expect(policyForSpend(27, 30)).toEqual({
      state: "degraded",
      radarSummaryTokens: 120,
      featuredSummaryTokens: 900,
    });
  });

  it("warns at seventy percent and skips optional radar at the hard limit", () => {
    expect(policyForSpend(21, 30).state).toBe("warning");
    expect(policyForSpend(30, 30).state).toBe("hard_stop");
  });

  it("records one bounded cost record using the configured price", () => {
    const ledger = new CostLedger({
      monthlyLimitUsd: 30,
      unitPricesUsd: { "gpt-test": 0.002 },
    });

    expect(ledger.record({
      provider: "openai",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 50,
      embeddingCount: 3,
    })).toEqual({
      provider: "openai",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 50,
      embeddingCount: 3,
      unitPriceUsd: 0.002,
      estimatedCostUsd: 0.306,
    });
  });

  it("projects complete provider usage into the strict persisted call record", () => {
    const ledger = new CostLedger({
      monthlyLimitUsd: 30,
      unitPricesUsd: { "gpt-test": 0.002 },
    });
    const usage: ModelUsage = {
      provider: "openai",
      operation: "generation",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      embeddingCount: 0,
    };

    expect(ledger.record(usage)).toEqual({
      provider: "openai",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 50,
      embeddingCount: 0,
      unitPriceUsd: 0.002,
      estimatedCostUsd: 0.3,
    });
  });

  it("rejects a monthly budget above the configured thirty-dollar ceiling", () => {
    expect(() => new CostLedger({
      monthlyLimitUsd: 30.01,
      unitPricesUsd: { "gpt-test": 0.002 },
    })).toThrow();
  });

  it("rejects unknown fields instead of accepting an unbudgeted provider record", () => {
    expect(() => ProviderCallRecordSchema.parse({
      provider: "openai",
      model: "gpt-test",
      inputTokens: 1,
      outputTokens: 0,
      embeddingCount: 0,
      unitPriceUsd: 0.002,
      estimatedCostUsd: 0.002,
      sourcePacket: "must never persist",
    })).toThrow();
  });
});
