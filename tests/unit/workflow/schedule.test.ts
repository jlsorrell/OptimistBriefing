import { describe, expect, it } from "vitest";

import { shouldRunAt } from "../../../src/workflow/schedule";

const noPublishedRun = () => ({ status: "missing" as const });

describe("shouldRunAt", () => {
  it.each([
    ["2026-07-29T08:30:00Z", true],
    ["2026-01-29T08:30:00Z", false],
    ["2026-01-29T09:30:00Z", true],
    ["2026-01-29T10:30:00Z", true],
  ])("evaluates %s in America/New_York", (instant, expected) => {
    expect(shouldRunAt(new Date(instant), "America/New_York", noPublishedRun()).run)
      .toBe(expected);
  });

  it("uses the local date and stops after the 05:50 local cutoff", () => {
    expect(shouldRunAt(new Date("2026-01-29T10:50:00Z"), "America/New_York", noPublishedRun()))
      .toEqual({ run: true, editionDate: "2026-01-29", reason: "scheduled" });
    expect(shouldRunAt(new Date("2026-01-29T10:51:00Z"), "America/New_York", noPublishedRun()))
      .toEqual({ run: false, editionDate: "2026-01-29", reason: "outside_window" });
  });

  it("skips an edition that is already published", () => {
    expect(shouldRunAt(new Date("2026-07-29T08:30:00Z"), "America/New_York", {
      status: "published",
    })).toEqual({ run: false, editionDate: "2026-07-29", reason: "published" });
  });
});
