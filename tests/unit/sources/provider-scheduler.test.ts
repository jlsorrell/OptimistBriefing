import { describe, expect, it, vi } from "vitest";

import {
  createProviderRequestAdmission,
  runProviderTasks,
} from "../../../src/sources/provider-scheduler";

function runtime() {
  let currentTime = 0;
  return {
    now: () => currentTime,
    sleep: vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    }),
  };
}

describe("runProviderTasks", () => {
  it("paces a single-concurrency provider without changing result order", async () => {
    const clock = runtime();
    const starts: number[] = [];

    const result = await runProviderTasks(
      ["a", "b", "c"].map((value) => async () => {
        starts.push(clock.now());
        return value;
      }),
      { maxConcurrency: 1, minimumStartIntervalMs: 1_000 },
      clock,
    );

    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("paces concurrent workers in deterministic start order", async () => {
    const clock = runtime();
    const starts: number[] = [];

    const result = await runProviderTasks(
      ["a", "b", "c"].map((value) => async () => {
        starts.push(clock.now());
        return value;
      }),
      { maxConcurrency: 3, minimumStartIntervalMs: 1_000 },
      clock,
    );

    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("never exceeds configured concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 4 }, (_, index) => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return index;
    });

    const pending = runProviderTasks(tasks, {
      maxConcurrency: 2,
      minimumStartIntervalMs: 0,
    });

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    releases.shift()?.();

    expect(await pending).toEqual([0, 1, 2, 3]);
    expect(maximum).toBe(2);
  });

  it("returns results in input order when tasks complete out of order", async () => {
    const releases: Array<() => void> = [];
    const pending = runProviderTasks(
      ["first", "second", "third"].map((value) => async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return value;
      }),
      { maxConcurrency: 3, minimumStartIntervalMs: 0 },
    );

    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[2]!();
    releases[1]!();
    releases[0]!();

    expect(await pending).toEqual(["first", "second", "third"]);
  });

  it("returns an empty result without starting a worker", async () => {
    expect(await runProviderTasks([], {
      maxConcurrency: 1,
      minimumStartIntervalMs: 0,
    })).toEqual([]);
  });

  it.each([
    { maxConcurrency: 0, minimumStartIntervalMs: 0 },
    { maxConcurrency: 17, minimumStartIntervalMs: 0 },
    { maxConcurrency: 1.5, minimumStartIntervalMs: 0 },
  ])("rejects invalid concurrency policy %#", async (policy) => {
    await expect(runProviderTasks([], policy)).rejects.toThrow(
      "Provider concurrency must be from 1 through 16.",
    );
  });

  it.each([
    { maxConcurrency: 1, minimumStartIntervalMs: -1 },
    { maxConcurrency: 1, minimumStartIntervalMs: 60_001 },
    { maxConcurrency: 1, minimumStartIntervalMs: 1.5 },
  ])("rejects invalid pacing policy %#", async (policy) => {
    await expect(runProviderTasks([], policy)).rejects.toThrow(
      "Provider pacing interval is outside the safe bound.",
    );
  });

  it("propagates a task rejection", async () => {
    const failure = new Error("provider unavailable");

    await expect(runProviderTasks([
      async () => "first",
      async () => { throw failure; },
      async () => "third",
    ], {
      maxConcurrency: 1,
      minimumStartIntervalMs: 0,
    })).rejects.toBe(failure);
  });
});

describe("createProviderRequestAdmission", () => {
  it("paces actual request admissions and holds one in-flight lease", async () => {
    const clock = runtime();
    const admission = createProviderRequestAdmission(new Map([
      ["semantic-scholar", {
        maxConcurrency: 1,
        minimumStartIntervalMs: 1_000,
      }],
    ]), clock);

    const first = await admission.acquire("semantic-scholar");
    let secondStarted = false;
    const secondPending = admission.acquire("semantic-scholar").then(
      (lease) => {
        secondStarted = true;
        return lease;
      },
    );
    await Promise.resolve();

    expect(secondStarted).toBe(false);
    expect(clock.now()).toBe(0);

    first.release();
    const second = await secondPending;

    expect(secondStarted).toBe(true);
    expect(clock.now()).toBe(1_000);
    second.release();
  });

  it("allows the configured request concurrency without using inherited keys", async () => {
    const admission = createProviderRequestAdmission(new Map([
      ["openalex", { maxConcurrency: 2, minimumStartIntervalMs: 0 }],
    ]));

    const first = await admission.acquire("openalex");
    const second = await admission.acquire("openalex");
    let thirdStarted = false;
    const thirdPending = admission.acquire("openalex").then((lease) => {
      thirdStarted = true;
      return lease;
    });
    const inherited = await admission.acquire("constructor");
    await Promise.resolve();

    expect(thirdStarted).toBe(false);
    inherited.release();
    first.release();
    const third = await thirdPending;
    expect(thirdStarted).toBe(true);

    second.release();
    third.release();
  });
});
