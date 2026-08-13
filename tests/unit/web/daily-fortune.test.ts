import { describe, expect, it } from "vitest";

import { dailyFortuneForDate } from "../../../src/web/daily-fortune";

describe("dailyFortuneForDate", () => {
  it("uses the edition date for a deterministic seven-tone rotation", () => {
    const dates = [
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ];
    const fortunes = dates.map(dailyFortuneForDate);

    expect(fortunes.map(({ tone }) => tone)).toEqual([
      "silly",
      "creepy",
      "cryptic",
      "bizarre",
      "profound",
      "encouraging",
      "sweet",
    ]);
    expect(new Set(fortunes.map(({ text }) => text)).size).toBe(7);
    expect(dailyFortuneForDate(dates[0]!)).toEqual(fortunes[0]);
  });
});
