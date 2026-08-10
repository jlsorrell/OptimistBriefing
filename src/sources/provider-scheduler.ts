export type ProviderSchedulePolicy = {
  maxConcurrency: number;
  minimumStartIntervalMs: number;
};

export type ProviderSchedulerRuntime = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

const systemRuntime: ProviderSchedulerRuntime = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function runProviderTasks<T>(
  tasks: readonly (() => Promise<T>)[],
  policy: ProviderSchedulePolicy,
  runtime: ProviderSchedulerRuntime = systemRuntime,
): Promise<T[]> {
  if (
    !Number.isSafeInteger(policy.maxConcurrency)
    || policy.maxConcurrency < 1
    || policy.maxConcurrency > 16
  ) {
    throw new RangeError("Provider concurrency must be from 1 through 16.");
  }
  if (
    !Number.isSafeInteger(policy.minimumStartIntervalMs)
    || policy.minimumStartIntervalMs < 0
    || policy.minimumStartIntervalMs > 60_000
  ) {
    throw new RangeError("Provider pacing interval is outside the safe bound.");
  }
  if (tasks.length === 0) return [];

  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  let nextStartAt = runtime.now();
  let previousAdmission = Promise.resolve();

  const startTask = async <U>(task: () => Promise<U>): Promise<U> => {
    let releaseAdmission: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const earlierAdmission = previousAdmission;
    previousAdmission = admission;

    await earlierAdmission;
    let taskPromise: Promise<U>;
    try {
      const currentTime = runtime.now();
      const startAt = Math.max(currentTime, nextStartAt);
      nextStartAt = startAt + policy.minimumStartIntervalMs;
      const wait = startAt - currentTime;
      if (wait > 0) await runtime.sleep(wait);
      taskPromise = task();
    } finally {
      releaseAdmission!();
    }
    return taskPromise!;
  };

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await startTask(tasks[index]!);
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(policy.maxConcurrency, tasks.length) },
    worker,
  ));
  return results;
}
