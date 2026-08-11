# Research Provider Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a briefing's own Semantic Scholar and OpenAlex lanes from creating avoidable provider throttling while preserving cross-provider parallelism and lane isolation.

**Architecture:** Add a deterministic in-memory provider task scheduler with injectable clock and sleep functions. Group research discovery adapters by `sourceId`, run provider groups concurrently, and run lanes inside each group under static policies: Semantic Scholar one at a time with one-second start pacing, OpenAlex at most two at a time, and existing behavior for all other providers.

**Tech Stack:** TypeScript 5.8, Cloudflare Workers, existing `SourceHttpClient` retry boundary, Zod 3, Vitest 4 fake clocks.

**Design specification:** `docs/superpowers/specs/2026-08-07-research-relevance-and-source-reliability-design.md`

## Global Constraints

- Semantic Scholar: maximum concurrency `1`, minimum request-start interval `1,000 ms`.
- OpenAlex: maximum concurrency `2`, minimum request-start interval `0 ms`.
- Different providers may run concurrently.
- Static application policy controls concurrency and pacing; provider bodies cannot change it.
- Preserve the HTTP client's existing maximum of two retries by default, `Retry-After` cap of 60 seconds, and exponential-backoff cap of 8 seconds.
- Retry only the HTTP client's existing retryable statuses and transport failures; do not add retries for authentication, policy, parse, or non-retryable quota failures.
- Preserve deterministic lane ordering, `PAPER_LANE_LIMIT = 100`, `DISCOVERY_DIAGNOSTIC_LIMIT = 64`, and fail-open lane settlement.
- Do not persist schedules, timestamps, provider bodies, URLs, API keys, or candidate text in diagnostics.
- Use strict TDD and commit each independently passing task.
- Do not deploy or run a paid preview canary without separate authorization.

---

### Task 1: Deterministic provider task scheduler

**Files:**
- Create: `src/sources/provider-scheduler.ts`
- Create: `tests/unit/sources/provider-scheduler.test.ts`

**Interfaces:**
- Produces: `ProviderSchedulePolicy = { maxConcurrency: number; minimumStartIntervalMs: number }`.
- Produces: `runProviderTasks<T>(tasks, policy, runtime?): Promise<T[]>`.
- Produces: `ProviderSchedulerRuntime = { now: () => number; sleep: (milliseconds: number) => Promise<void> }`.

- [ ] **Step 1: Write failing scheduler tests**

Create tests using a logical clock rather than real timers:

```ts
function runtime() {
  let now = 0;
  return {
    now: () => now,
    sleep: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
  };
}

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
```

Also test empty tasks, invalid `maxConcurrency`, invalid intervals, task
rejection propagation, and input-order results when task completion order
differs.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/unit/sources/provider-scheduler.test.ts
```

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement the bounded scheduler**

Create `src/sources/provider-scheduler.ts` around this interface and worker
loop:

```ts
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
  sleep: (milliseconds) => new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  ),
};

export async function runProviderTasks<T>(
  tasks: readonly (() => Promise<T>)[],
  policy: ProviderSchedulePolicy,
  runtime: ProviderSchedulerRuntime = systemRuntime,
): Promise<T[]> {
  if (!Number.isSafeInteger(policy.maxConcurrency) ||
      policy.maxConcurrency < 1 || policy.maxConcurrency > 16) {
    throw new RangeError("Provider concurrency must be from 1 through 16.");
  }
  if (!Number.isSafeInteger(policy.minimumStartIntervalMs) ||
      policy.minimumStartIntervalMs < 0 ||
      policy.minimumStartIntervalMs > 60_000) {
    throw new RangeError("Provider pacing interval is outside the safe bound.");
  }
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  let nextStartAt = runtime.now();
  const reserveStart = async () => {
    const startAt = Math.max(runtime.now(), nextStartAt);
    nextStartAt = startAt + policy.minimumStartIntervalMs;
    const wait = startAt - runtime.now();
    if (wait > 0) await runtime.sleep(wait);
  };
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      await reserveStart();
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(policy.maxConcurrency, tasks.length) },
    worker,
  ));
  return results;
}
```

Return `[]` before constructing workers when `tasks.length === 0`. Reserve the
next start synchronously before the first `await` so multiple workers cannot
claim the same paced slot.

- [ ] **Step 4: Verify and commit the primitive**

Run:

```bash
npx vitest run tests/unit/sources/provider-scheduler.test.ts
npm run check
git add src/sources/provider-scheduler.ts tests/unit/sources/provider-scheduler.test.ts
git commit -m "feat: add bounded provider task scheduler"
```

Expected: focused tests and type checking pass without real-time one-second
waits.

---

### Task 2: Provider-aware research collection

**Files:**
- Modify: `src/sources/research-collector.ts`
- Modify: `tests/unit/sources/research-collector.test.ts`

**Interfaces:**
- Consumes: Task 1 `runProviderTasks`.
- Adds optional test seam: `ResearchCollectorOptions.schedulerRuntime?: ProviderSchedulerRuntime`.
- Produces static `RESEARCH_PROVIDER_SCHEDULE_POLICIES` keyed by source ID.

- [ ] **Step 1: Write failing collector scheduling tests**

Add adapters that record start times and hold promises open. Cover these cases:

```ts
function logicalSchedulerRuntime() {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn(async (milliseconds: number) => { current += milliseconds; }),
  };
}

it("serializes and paces Semantic Scholar lanes", async () => {
  const clock = logicalSchedulerRuntime();
  const starts: number[] = [];
  const collector = new ResearchCollector({
    discoveryAdapters: Array.from({ length: 3 }, (_, index) => ({
      sourceId: "semantic-scholar",
      laneId: `semantic-scholar:test:${index}`,
      discoveryFamily: "bibliographic" as const,
      collect: async () => {
        starts.push(clock.now());
        return [];
      },
    })),
    enrichers: [],
    preferredInstitutions: [],
    schedulerRuntime: clock,
  });
  await collector.collect(window);
  expect(starts).toEqual([0, 1_000, 2_000]);
});
```

Add a two-provider test proving an arXiv lane begins before a blocked Semantic
Scholar group finishes. Add an OpenAlex test with four held lanes proving
maximum active work is two. Add a failure test proving a throttled Semantic
Scholar lane produces its existing sanitized lane failure while later lanes
and an arXiv lane settle normally.

- [ ] **Step 2: Run focused collector tests and confirm RED**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "paces|concurrency|provider group|throttled"
```

Expected: current `Promise.all` starts every lane immediately.

- [ ] **Step 3: Group adapters and apply static policies**

Add:

```ts
export const RESEARCH_PROVIDER_SCHEDULE_POLICIES = Object.freeze({
  "semantic-scholar": {
    maxConcurrency: 1,
    minimumStartIntervalMs: 1_000,
  },
  openalex: {
    maxConcurrency: 2,
    minimumStartIntervalMs: 0,
  },
});

const DEFAULT_PROVIDER_POLICY = Object.freeze({
  maxConcurrency: 16,
  minimumStartIntervalMs: 0,
});
```

Extract the current per-adapter settlement body into:

```ts
async function collectDiscoveryLane(
  adapter: SourceAdapter,
  window: CollectionWindow,
): Promise<{
  batch: CollectionBatch<{ laneId: string; item: RawItem }>;
  diagnostic: DiscoveryLaneDiagnostic;
}>;
```

Group the already sorted adapters in insertion-ordered `Map<string,
SourceAdapter[]>`. Run groups with outer `Promise.all`. For each group, call
`runProviderTasks` with tasks that invoke `collectDiscoveryLane`; select the
static policy by `sourceId` and pass the optional injected runtime. Flatten and
sort diagnostics by `laneId` exactly as before.

Do not move `settleCollectionBatch` outside the individual lane task. A rejected
lane must become one bounded outcome rather than rejecting its provider group.

- [ ] **Step 4: Verify focused behavior and unchanged diagnostics**

Run:

```bash
npx vitest run tests/unit/sources/provider-scheduler.test.ts tests/unit/sources/research-collector.test.ts
npm run check
```

Expected: pacing/concurrency tests pass; existing ordering, identity merging,
lane caps, enrichment, paper-content, and diagnostics tests remain green.

- [ ] **Step 5: Commit collector scheduling**

Run:

```bash
git add src/sources/research-collector.ts tests/unit/sources/research-collector.test.ts
git commit -m "fix: schedule research lanes by provider"
```

---

### Task 3: Retry and regression verification

**Files:**
- Modify: `tests/unit/sources/research-collector.test.ts`
- Verify: `src/sources/http-client.ts`

**Interfaces:**
- Preserves: the existing HTTP retry contract; scheduling changes only request start order.

- [ ] **Step 1: Add one scheduler-plus-retry regression**

Use a `SourceHttpClient` with injected `fetch`, `sleep`, and `now`. Return `429`
with `Retry-After: 2` for the first Semantic Scholar request, success on its
retry, then success for the second lane. Assert the HTTP client performs one
bounded retry, the scheduler never overlaps the two lanes, and serialized
diagnostics contain neither response bodies nor request URLs.

- [ ] **Step 2: Run the HTTP and collector boundary tests**

Run:

```bash
npx vitest run tests/unit/sources/research-collector.test.ts -t "Retry-After|scheduler|Semantic Scholar|OpenAlex"
```

Expected: PASS without changing `SourceHttpClient`. If a test exposes a real
interaction defect, correct only the scheduler/collector seam and preserve the
HTTP client's retry status set and delay caps.

- [ ] **Step 3: Run the full verification ladder**

Run:

```bash
npm run check
npm test
npm run test:worker
npm run evaluate
npm run build
git diff --check
```

Expected: all commands pass; model calls, edition budgets, source schemas, and
public/authenticated diagnostics are unchanged.

- [ ] **Step 4: Commit the interaction regression**

Run:

```bash
git add tests/unit/sources/research-collector.test.ts src/sources/research-collector.ts
git commit -m "test: cover scheduled provider retry isolation"
```

If collector code is unchanged, stage only the test file. Do not create an
empty commit.
