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

export type ScheduledWorkflowCreateInput = {
  id: string;
  params: { editionDate: string; runId: string };
  retention: {
    successRetention: "90 days";
    errorRetention: "90 days";
  };
};

export type ScheduledWorkflowBinding = {
  create(input: ScheduledWorkflowCreateInput): Promise<unknown>;
  createBatch(
    inputs: ScheduledWorkflowCreateInput[],
  ): Promise<readonly unknown[]>;
  get(id: string): Promise<ScheduledWorkflowInstance>;
};

export type ScheduledBriefingDependencies = {
  listRuns(): Promise<readonly ScheduledRun[]>;
  workflow: ScheduledWorkflowBinding;
};

type WorkflowRunIdentity = {
  editionDate: string;
  runId: string;
};

function scheduledWorkflowCreateInput(
  input: WorkflowRunIdentity,
): ScheduledWorkflowCreateInput {
  return {
    id: input.editionDate,
    params: {
      editionDate: input.editionDate,
      runId: input.runId,
    },
    retention: {
      successRetention: "90 days",
      errorRetention: "90 days",
    },
  };
}

export function createScheduledWorkflowInstance(
  workflow: ScheduledWorkflowBinding,
  input: WorkflowRunIdentity,
): Promise<unknown> {
  return workflow.create(scheduledWorkflowCreateInput(input));
}

export function createScheduledWorkflowBatch(
  workflow: ScheduledWorkflowBinding,
  input: WorkflowRunIdentity,
): Promise<readonly unknown[]> {
  return workflow.createBatch([scheduledWorkflowCreateInput(input)]);
}

export async function continueScheduledWorkflowInstance(
  workflow: ScheduledWorkflowBinding,
  input: WorkflowRunIdentity,
): Promise<void> {
  const instance = await workflow.get(input.editionDate);
  const state = await instance.status();
  if (state.status === "unknown") {
    await createScheduledWorkflowInstance(workflow, input);
  } else if (state.status === "paused") {
    await instance.resume();
  } else if (
    state.status === "errored" ||
    state.status === "terminated" ||
    state.status === "complete"
  ) {
    await instance.restart();
  }
}

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
    await continueScheduledWorkflowInstance(dependencies.workflow, {
      editionDate: initial.editionDate,
      runId: run.id,
    });
    return;
  }
  if (run !== null) return;
  await createScheduledWorkflowInstance(dependencies.workflow, {
    editionDate: initial.editionDate,
    runId: initial.editionDate,
  });
}
