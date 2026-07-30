import { composeEdition } from "./compose-edition";
import { publishEdition } from "./publish-edition";
import { D1BriefingRepository } from "../db/d1-repository";
import type {
  Edition,
  EditionEntry,
  EditionWithEntries,
} from "../contracts/editorial";
import {
  PIPELINE_STEPS,
  type CheckpointArtifact,
  type PipelineContext,
  type PipelineResult,
  type PipelineRun,
  type PipelineStore,
  type PipelineStatus,
} from "./types";

export { PIPELINE_STEPS } from "./types";
export type { PipelineContext, PipelineRun, PipelineStore } from "./types";

export class WorkflowRunAlreadyExistsError extends Error {
  constructor() {
    super("RUN_ALREADY_EXISTS");
    this.name = "WorkflowRunAlreadyExistsError";
  }
}

export class WorkflowResumeUnavailableError extends Error {
  constructor() {
    super("RUN_NOT_RETRYABLE");
    this.name = "WorkflowResumeUnavailableError";
  }
}

type PersistedRunRow = {
  id: string;
  edition_date: string;
  status: PipelineRun["status"];
  current_step: PipelineRun["currentStep"];
  retryable: number;
  attempt_count: number;
  failure_code: string | null;
  estimated_cost_usd: number;
  created_at: string;
  updated_at: string;
};

class D1PipelineStore implements PipelineStore {
  readonly repository: D1BriefingRepository;

  constructor(private readonly db: D1Database) {
    this.repository = new D1BriefingRepository(db);
  }

  private runFromRow(row: PersistedRunRow): PipelineRun {
    return {
      id: row.id,
      editionDate: row.edition_date,
      status: row.status,
      currentStep: row.current_step,
      retryable: row.retryable === 1,
      attemptCount: row.attempt_count,
      estimatedCostUsd: row.estimated_cost_usd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      failureCode: row.failure_code,
    };
  }

  async getRun(runId: string): Promise<PipelineRun | null> {
    const row = await this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .bind(runId).first<PersistedRunRow>();
    return row === null ? null : this.runFromRow(row);
  }

  async createRun(run: PipelineRun): Promise<void> {
    const existing = await this.db.prepare("SELECT id FROM workflow_runs WHERE edition_date = ? LIMIT 1")
      .bind(run.editionDate).first<{ id: string }>();
    if (existing !== null) throw new WorkflowRunAlreadyExistsError();
    await this.db.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      run.id, run.editionDate, run.status, run.currentStep,
      run.retryable ? 1 : 0, run.attemptCount, run.failureCode ?? null,
      run.estimatedCostUsd, run.createdAt, run.updatedAt,
    ).run();
  }

  async saveRun(run: PipelineRun): Promise<void> {
    await this.db.prepare(
      `UPDATE workflow_runs SET
        status = ?, current_step = ?, retryable = ?, attempt_count = ?,
        failure_code = ?, estimated_cost_usd = ?, updated_at = ?
      WHERE id = ?`,
    ).bind(
      run.status, run.currentStep, run.retryable ? 1 : 0, run.attemptCount,
      run.failureCode ?? null, run.estimatedCostUsd, run.updatedAt, run.id,
    ).run();
  }

  async readCheckpoint(runId: string, step: (typeof PIPELINE_STEPS)[number]): Promise<boolean> {
    return (await this.readArtifact(runId, step)) !== null;
  }

  async saveCheckpoint(
    runId: string,
    step: (typeof PIPELINE_STEPS)[number],
    artifact: CheckpointArtifact,
  ): Promise<void> {
    await this.db.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), runId, "workflow_checkpoint",
      JSON.stringify({ step, artifact }), new Date().toISOString(),
    ).run();
  }

  async readArtifact<T>(
    runId: string,
    step: (typeof PIPELINE_STEPS)[number],
  ): Promise<CheckpointArtifact<T> | null> {
    const records = await this.db.prepare(
      `SELECT event_json FROM audit_events
       WHERE run_id = ? AND event_type = ? ORDER BY created_at DESC`,
    ).bind(runId, "workflow_checkpoint").all<{ event_json: string }>();
    for (const record of records.results) {
      try {
        const parsed = JSON.parse(record.event_json) as { step?: unknown; artifact?: unknown };
        if (parsed.step !== step || !isCheckpointArtifact(parsed.artifact)) continue;
        return parsed.artifact as CheckpointArtifact<T>;
      } catch {
        // Corrupt diagnostic data is not a completed checkpoint.
      }
    }
    return null;
  }

  async createDraft(edition: Edition): Promise<void> {
    await this.db.prepare(
      `INSERT INTO editions (
        id, edition_date, run_id, status, reading_minutes, published_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      edition.id, edition.editionDate, edition.runId, edition.status,
      edition.readingMinutes, edition.publishedAt, edition.createdAt,
    ).run();
  }

  replaceEntries(editionId: string, entries: readonly EditionEntry[]): Promise<void> {
    return this.repository.replaceEditionEntries(editionId, entries);
  }

  publish(editionId: string, status: "published" | "partial"): Promise<void> {
    return this.repository.publishEdition(editionId, new Date().toISOString(), status);
  }

  getLatestEdition(): Promise<EditionWithEntries | null> {
    return this.repository.getLatestEdition();
  }

  async audit(runId: string | null, eventType: string, actorEmail: string | undefined): Promise<void> {
    await this.db.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), runId, eventType,
      JSON.stringify({ actorEmail: actorEmail ?? null }), new Date().toISOString(),
    ).run();
  }
}

function emptyPipelineContext(
  store: PipelineStore,
  editionDate: string,
  runId: string,
): PipelineContext {
  const passthrough = async (items: readonly import("../contracts/editorial").Item[]) => items;
  return {
    editionDate,
    runId,
    store,
    now: () => new Date().toISOString(),
    collect: async () => [],
    normalize: passthrough,
    enrich: passthrough,
    prefilter: passthrough,
    assess: passthrough,
    score: passthrough,
    cluster: passthrough,
    shortlist: passthrough,
    synthesize: async () => [],
    validate: async () => [],
  };
}

export function createD1WorkflowLauncher(db: D1Database): {
  start(input: { editionDate: string; actorEmail?: string }): Promise<{ runId: string }>;
  resume(input: { runId: string; actorEmail?: string }): Promise<void>;
} {
  const store = new D1PipelineStore(db);
  return {
    async start(input) {
      const runId = crypto.randomUUID();
      try {
        await runEditorialPipeline(emptyPipelineContext(store, input.editionDate, runId));
      } catch (error) {
        await store.audit(
          error instanceof WorkflowRunAlreadyExistsError ? null : runId,
          "manual_run_started",
          input.actorEmail,
        );
        throw error;
      }
      try {
        await store.audit(runId, "manual_run_started", input.actorEmail);
      } catch (error) {
        throw error;
      }
      return { runId };
    },
    async resume(input) {
      const run = await store.getRun(input.runId);
      if (run === null || !run.retryable || (run.status !== "retryable" && run.status !== "partial" && run.status !== "failed")) {
        throw new WorkflowResumeUnavailableError();
      }
      await store.audit(run.id, "manual_run_resumed", input.actorEmail);
      await runEditorialPipeline(emptyPipelineContext(store, run.editionDate, run.id));
    },
  };
}

function countOutput(value: unknown): number {
  return Array.isArray(value) ? value.length : 1;
}

function isCheckpointArtifact(value: unknown): value is CheckpointArtifact {
  return typeof value === "object" && value !== null && "output" in value;
}

function result(
  runId: string,
  status: PipelineStatus,
  missingSections: readonly string[] = [],
): PipelineResult {
  if (status === "retryable") throw new Error("A retryable run cannot be returned as a pipeline result.");
  return { runId, status, missingSections };
}

async function currentRun(context: PipelineContext): Promise<PipelineRun> {
  const existing = await context.store.getRun(context.runId);
  if (existing !== null) return existing;
  const now = context.now();
  const run: PipelineRun = {
    id: context.runId,
    editionDate: context.editionDate,
    status: "pending",
    currentStep: null,
    retryable: false,
    attemptCount: 0,
    estimatedCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    failureCode: null,
  };
  await context.store.createRun(run);
  return run;
}

async function checkpoint<T>(
  context: PipelineContext,
  run: PipelineRun,
  step: (typeof PIPELINE_STEPS)[number],
  execute: () => Promise<T>,
): Promise<T> {
  // The read belongs immediately before every step so a resumed run never repeats it.
  await context.store.getRun(context.runId);
  const completed = await context.store.readCheckpoint(context.runId, step);
  if (completed) {
    const artifact = await context.store.readArtifact<T>(context.runId, step);
    if (artifact === null) throw new Error(`MISSING_CHECKPOINT_ARTIFACT:${step}`);
    return isCheckpointArtifact(artifact) ? artifact.output : artifact as T;
  }

  const startedAt = Date.parse(context.now());
  const output = await execute();
  const estimatedCostUsd = context.estimateCostUsd?.(step, output) ?? 0;
  const artifact: CheckpointArtifact<T> = {
    output,
    attempts: 1,
    durationMs: Math.max(0, Date.parse(context.now()) - startedAt),
    itemCount: countOutput(output),
    estimatedCostUsd,
  };
  await context.store.saveCheckpoint(context.runId, step, artifact);
  const storedRun = await context.store.getRun(context.runId) ?? run;
  await context.store.saveRun({
    ...storedRun,
    status: "running",
    currentStep: step,
    retryable: false,
    estimatedCostUsd: storedRun.estimatedCostUsd + estimatedCostUsd,
    updatedAt: context.now(),
    failureCode: null,
  });
  return output;
}

export async function runEditorialPipeline(
  context: PipelineContext,
): Promise<PipelineResult> {
  let run = await currentRun(context);
  if (run.status === "published" || (run.status === "failed" && !run.retryable)) {
    return result(context.runId, run.status);
  }
  run = {
    ...run,
    status: "running",
    retryable: false,
    attemptCount: run.attemptCount + 1,
    updatedAt: context.now(),
    failureCode: null,
  };
  await context.store.saveRun(run);

  try {
    const collected = await checkpoint(context, run, "collect", context.collect);
    const normalized = await checkpoint(context, run, "normalize", () => context.normalize(collected));
    const enriched = await checkpoint(context, run, "enrich", () => context.enrich(normalized));
    const prefilted = await checkpoint(context, run, "prefilter", () => context.prefilter(enriched));
    const assessed = await checkpoint(context, run, "assess", () => context.assess(prefilted));
    const scored = await checkpoint(context, run, "score", () => context.score(assessed));
    const clustered = await checkpoint(context, run, "cluster", () => context.cluster(scored));
    const shortlisted = await checkpoint(context, run, "shortlist", () => context.shortlist(clustered));
    const synthesized = await checkpoint(context, run, "synthesize", () => context.synthesize(shortlisted));
    const validated = await checkpoint(context, run, "validate", () => context.validate(synthesized));
    const composition = await checkpoint(context, run, "compose", () => composeEdition(context, validated));
    await checkpoint(context, run, "publish", () => publishEdition(context, composition));
    const finalRun = {
      ...(await context.store.getRun(context.runId) ?? run),
      status: composition.status,
      currentStep: "publish" as const,
      retryable: composition.status === "partial",
      updatedAt: context.now(),
      failureCode: composition.status === "failed" ? "MINIMUM_COVERAGE_FAILED" : null,
    };
    await context.store.saveRun(finalRun);
    return result(context.runId, composition.status, composition.missingSections);
  } catch (error) {
    const failureCode = error instanceof Error ? error.message.slice(0, 200) : "PIPELINE_FAILED";
    await context.store.saveRun({
      ...(await context.store.getRun(context.runId) ?? run),
      status: "retryable",
      retryable: true,
      failureCode,
      updatedAt: context.now(),
    });
    throw error;
  }
}
