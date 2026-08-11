export type ProviderSchedulePolicy = {
  maxConcurrency: number;
  minimumStartIntervalMs: number;
};

export type ProviderSchedulerRuntime = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export type ProviderRequestAdmissionLease = {
  release: () => void;
};

export type ProviderRequestAdmission = {
  acquire: (sourceId: string) => Promise<ProviderRequestAdmissionLease>;
};

const systemRuntime: ProviderSchedulerRuntime = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function validatePolicy(policy: ProviderSchedulePolicy): void {
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
}

type AdmissionWaiter = {
  resolve: (lease: ProviderRequestAdmissionLease) => void;
  reject: (reason: unknown) => void;
};

type ProviderAdmissionState = {
  policy: ProviderSchedulePolicy;
  active: number;
  nextStartAt: number;
  admitting: boolean;
  queue: AdmissionWaiter[];
};

const passThroughLease: ProviderRequestAdmissionLease = Object.freeze({
  release: () => undefined,
});

export function createProviderRequestAdmission(
  policies: ReadonlyMap<string, ProviderSchedulePolicy>,
  runtime: ProviderSchedulerRuntime = systemRuntime,
): ProviderRequestAdmission {
  const states = new Map<string, ProviderAdmissionState>();
  for (const [sourceId, policy] of policies) {
    validatePolicy(policy);
    states.set(sourceId, {
      policy,
      active: 0,
      nextStartAt: runtime.now(),
      admitting: false,
      queue: [],
    });
  }

  const drain = (state: ProviderAdmissionState): void => {
    if (
      state.admitting
      || state.active >= state.policy.maxConcurrency
      || state.queue.length === 0
    ) {
      return;
    }
    const waiter = state.queue.shift()!;
    state.admitting = true;
    const currentTime = runtime.now();
    const startAt = Math.max(currentTime, state.nextStartAt);
    state.nextStartAt = startAt + state.policy.minimumStartIntervalMs;
    const wait = startAt - currentTime;
    const ready = wait > 0 ? runtime.sleep(wait) : Promise.resolve();
    void ready.then(() => {
      state.admitting = false;
      state.active += 1;
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) return;
          released = true;
          state.active -= 1;
          drain(state);
        },
      });
      drain(state);
    }, (error: unknown) => {
      state.admitting = false;
      waiter.reject(error);
      drain(state);
    });
  };

  return {
    acquire: (sourceId) => {
      const state = states.get(sourceId);
      if (state === undefined) return Promise.resolve(passThroughLease);
      return new Promise<ProviderRequestAdmissionLease>((resolve, reject) => {
        state.queue.push({ resolve, reject });
        drain(state);
      });
    },
  };
}

export async function runProviderTasks<T>(
  tasks: readonly (() => Promise<T>)[],
  policy: ProviderSchedulePolicy,
  runtime: ProviderSchedulerRuntime = systemRuntime,
): Promise<T[]> {
  validatePolicy(policy);
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
