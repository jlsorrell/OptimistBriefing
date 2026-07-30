export type ScheduleRunState = {
  status: "missing" | "pending" | "running" | "retryable" | "published" | "partial" | "failed";
};

export type ScheduleDecision = {
  run: boolean;
  editionDate: string;
  reason: "scheduled" | "outside_window" | "published";
};

export type ScheduledRun = {
  id: string;
  editionDate: string;
  status: Exclude<ScheduleRunState["status"], "missing">;
  retryable: boolean;
};

export type ScheduledWorkflowInstance = {
  status(): Promise<{ status: string }>;
  restart(): Promise<void>;
  resume(): Promise<void>;
};

export type ScheduledWorkflowBinding = {
  create(input: {
    id: string;
    params: { editionDate: string; runId: string };
    retention: {
      successRetention: "90 days";
      errorRetention: "90 days";
    };
  }): Promise<unknown>;
  get(id: string): Promise<ScheduledWorkflowInstance>;
};

export type ScheduledBriefingDependencies = {
  listRuns(): Promise<readonly ScheduledRun[]>;
  workflow: ScheduledWorkflowBinding;
};

function localParts(instant: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant).flatMap(({ type, value }) =>
    type === "literal" ? [] : [[type, value]],
  ));
}

export function shouldRunAt(
  instant: Date,
  timeZone: string,
  runState: ScheduleRunState,
): ScheduleDecision {
  if (!Number.isFinite(instant.getTime())) throw new RangeError("Invalid schedule instant.");
  const parts = localParts(instant, timeZone);
  const editionDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (runState.status === "published") {
    return { run: false, editionDate, reason: "published" };
  }
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute < 4 * 60 || minute > 5 * 60 + 50) {
    return { run: false, editionDate, reason: "outside_window" };
  }
  return { run: true, editionDate, reason: "scheduled" };
}

export async function coordinateScheduledBriefing(
  dependencies: ScheduledBriefingDependencies,
  now: Date,
): Promise<void> {
  const initial = shouldRunAt(now, "America/New_York", { status: "missing" });
  if (!initial.run) return;
  const run = (await dependencies.listRuns()).find(
    (candidate) => candidate.editionDate === initial.editionDate,
  ) ?? null;
  const decision = shouldRunAt(now, "America/New_York", {
    status: run?.status ?? "missing",
  });
  if (!decision.run) return;
  if (run?.retryable) {
    const instance = await dependencies.workflow.get(initial.editionDate);
    const state = await instance.status();
    if (state.status === "unknown") {
      await dependencies.workflow.create({
        id: initial.editionDate,
        params: { editionDate: initial.editionDate, runId: run.id },
        retention: { successRetention: "90 days", errorRetention: "90 days" },
      });
    } else if (state.status === "paused") {
      await instance.resume();
    } else if (state.status !== "running" && state.status !== "queued") {
      await instance.restart();
    }
    return;
  }
  if (run !== null) return;
  await dependencies.workflow.create({
    id: initial.editionDate,
    params: { editionDate: initial.editionDate, runId: initial.editionDate },
    retention: { successRetention: "90 days", errorRetention: "90 days" },
  });
}
