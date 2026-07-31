import { describe, expect, it } from "vitest";

import {
  maximumCostMicrousd,
  maximumEmbeddingUnits,
  maximumGenerationUnits,
} from "../../../src/models/budget-gate";

describe("model budget bounds", () => {
  it("counts UTF-8 bytes and the full output allowance for generation", () => {
    expect(maximumGenerationUnits("évidence", 900)).toBe(909);
  });

  it("counts UTF-8 bytes and one unit for every embedded input", () => {
    expect(maximumEmbeddingUnits(["one", "two"])).toBe(8);
  });

  it("rounds any fractional microdollar upward", () => {
    expect(maximumCostMicrousd(3, 0.0000004)).toBe(2);
  });

  it.each([
    () => maximumGenerationUnits("packet", -1),
    () => maximumCostMicrousd(Number.POSITIVE_INFINITY, 0.1),
    () => maximumCostMicrousd(1, -0.1),
  ])("rejects invalid bounds instead of under-authorizing", (operation) => {
    expect(operation).toThrow(RangeError);
  });
});
