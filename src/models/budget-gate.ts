import type { ModelUsage } from "./provider";

const MICROUSD_PER_USD = 1_000_000;

export type ModelBudgetRequest = {
  model: string;
  maximumBillableUnits: number;
};

export type BudgetReservation = {
  id: string;
  maximumCostMicrousd: number;
};

export class BudgetHardStopError extends Error {
  readonly code = "BUDGET_HARD_STOP";

  constructor() {
    super("BUDGET_HARD_STOP");
    this.name = "BudgetHardStopError";
  }
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function nonnegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and nonnegative.`);
  }
  return value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function maximumGenerationUnits(
  billableRequestText: string,
  maxOutputTokens: number,
): number {
  return nonnegativeInteger(
    utf8Length(billableRequestText) +
      nonnegativeInteger(maxOutputTokens, "maxOutputTokens"),
    "maximum generation units",
  );
}

export function maximumEmbeddingUnits(
  texts: readonly string[],
): number {
  return nonnegativeInteger(
    texts.reduce((total, text) => total + utf8Length(text), 0) +
      texts.length,
    "maximum embedding units",
  );
}

export function maximumCostMicrousd(
  units: number,
  unitPriceUsd: number,
): number {
  nonnegativeInteger(units, "units");
  nonnegativeFinite(unitPriceUsd, "unitPriceUsd");
  return nonnegativeInteger(
    Math.ceil(units * unitPriceUsd * MICROUSD_PER_USD),
    "maximum cost",
  );
}

export function actualUsageUnits(usage: ModelUsage): number {
  return nonnegativeInteger(
    usage.inputTokens + usage.outputTokens + usage.embeddingCount,
    "actual usage units",
  );
}
