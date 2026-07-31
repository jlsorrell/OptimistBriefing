import { z } from "zod";

import type { WorkflowLauncher } from "../api/app";
import {
  D1PipelineStore,
  WorkflowResumeUnavailableError,
  WorkflowRunAlreadyExistsError,
} from "./run-editorial-pipeline";
import {
  continueScheduledWorkflowInstance,
  createScheduledWorkflowBatch,
  type ScheduledWorkflowBinding,
} from "./schedule";
import type { PipelineRun } from "./types";

const AuditActorSchema = z.string().trim().max(254).email()
  .transform((value) => value.toLowerCase());

function sanitizedActorEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = AuditActorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function pendingRun(editionDate: string): PipelineRun {
  const now = new Date().toISOString();
  return {
    id: editionDate,
    editionDate,
    status: "pending",
    currentStep: null,
    retryable: false,
    attemptCount: 0,
    estimatedCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    failureCode: null,
  };
}

async function recordCreateFailure(
  db: D1Database,
  run: PipelineRun,
): Promise<void> {
  await db.prepare(
    `UPDATE workflow_runs
     SET status = 'retryable',
         retryable = 1,
         failure_code = 'WORKFLOW_CREATE_FAILED',
         updated_at = ?
     WHERE id = ?
       AND status = 'pending'
       AND current_step IS NULL
       AND retryable = 0
       AND attempt_count = 0`,
  ).bind(new Date().toISOString(), run.id).run();
}

export function createDurableWorkflowLauncher(
  db: D1Database,
  workflow: ScheduledWorkflowBinding,
): WorkflowLauncher {
  const store = new D1PipelineStore(db);
  return {
    async start(input) {
      const runId = input.editionDate;
      const run = pendingRun(input.editionDate);
      await store.createRun(run);
      let created: readonly unknown[];
      try {
        created = await createScheduledWorkflowBatch(workflow, {
          editionDate: input.editionDate,
          runId,
        });
      } catch (error) {
        await recordCreateFailure(db, run);
        throw error;
      }
      if (created.length === 0) throw new WorkflowRunAlreadyExistsError();
      await store.audit(
        runId,
        "manual_run_started",
        sanitizedActorEmail(input.actorEmail),
      );
      return { runId };
    },

    async resume(input) {
      const run = await store.getRun(input.runId);
      if (
        run === null ||
        !run.retryable ||
        (
          run.status !== "retryable" &&
          run.status !== "partial" &&
          run.status !== "failed"
        )
      ) {
        throw new WorkflowResumeUnavailableError();
      }
      await continueScheduledWorkflowInstance(workflow, {
        editionDate: run.editionDate,
        runId: run.id,
      });
      await store.audit(
        run.id,
        "manual_run_resumed",
        sanitizedActorEmail(input.actorEmail),
      );
    },
  };
}
