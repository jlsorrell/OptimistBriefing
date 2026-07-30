import { composeEdition } from "./compose-edition";
import { publishEdition } from "./publish-edition";
import { D1BriefingRepository } from "../db/d1-repository";
import { z } from "zod";
import { SourceHttpClient } from "../sources/http-client";
import { createNewsCollectorFromCatalog } from "../sources/news-collector";
import { normalizeCandidate } from "../editorial/normalize";
import { deduplicateItems } from "../editorial/deduplicate";
import { summarizeItem } from "../editorial/summarize";
import { validateSummary, type SourcePacket } from "../editorial/validate-summary";
import type { ModelProvider } from "../models/provider";
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

const PersistedRunSchema = z.object({
  id: z.string().min(1), edition_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["pending", "running", "retryable", "published", "partial", "failed"]),
  current_step: z.enum(PIPELINE_STEPS).nullable(), retryable: z.union([z.literal(0), z.literal(1)]),
  attempt_count: z.number().int().nonnegative(), failure_code: z.string().nullable(),
  estimated_cost_usd: z.number().finite().nonnegative(), created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict();
const PersistedArtifactSchema = z.object({
  output: z.unknown(), attempts: z.number().int().positive(), durationMs: z.number().finite().nonnegative(),
  itemCount: z.number().int().nonnegative(), estimatedCostUsd: z.number().finite().nonnegative(),
}).strict();

class D1PipelineStore implements PipelineStore {
  readonly repository: D1BriefingRepository;

  constructor(private readonly db: D1Database) {
    this.repository = new D1BriefingRepository(db);
  }

  private runFromRow(row: PersistedRunRow): PipelineRun {
    const valid = PersistedRunSchema.parse(row);
    return {
      id: valid.id, editionDate: valid.edition_date, status: valid.status,
      currentStep: valid.current_step, retryable: valid.retryable === 1,
      attemptCount: valid.attempt_count, estimatedCostUsd: valid.estimated_cost_usd,
      createdAt: valid.created_at, updatedAt: valid.updated_at, failureCode: valid.failure_code,
    };
  }

  async getRun(runId: string): Promise<PipelineRun | null> {
    const row = await this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .bind(runId).first<PersistedRunRow>();
    return row === null ? null : this.runFromRow(row);
  }

  async createRun(run: PipelineRun): Promise<void> {
    const result = await this.db.prepare(
      `INSERT INTO workflow_runs (
        id, edition_date, status, current_step, retryable, attempt_count,
        failure_code, estimated_cost_usd, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM workflow_runs WHERE edition_date = ?)`,
    ).bind(
      run.id, run.editionDate, run.status, run.currentStep,
      run.retryable ? 1 : 0, run.attemptCount, run.failureCode ?? null,
      run.estimatedCostUsd, run.createdAt, run.updatedAt, run.editionDate,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) throw new WorkflowRunAlreadyExistsError();
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
    const validArtifact = PersistedArtifactSchema.parse(artifact);
    await this.db.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), runId, "workflow_checkpoint",
      JSON.stringify({ step, artifact: validArtifact }), new Date().toISOString(),
    ).run();
  }

  async beginAttempt(runId: string, step: (typeof PIPELINE_STEPS)[number]): Promise<number> {
    const records = await this.db.prepare(
      "SELECT event_json FROM audit_events WHERE run_id = ? AND event_type = ?",
    ).bind(runId, "workflow_attempt").all<{ event_json: string }>();
    const attempt = records.results.filter((row) => {
      try { return (JSON.parse(row.event_json) as { step?: unknown }).step === step; } catch { return false; }
    }).length + 1;
    await this.db.prepare(
      "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), runId, "workflow_attempt", JSON.stringify({ step, attempt, status: "running" }), new Date().toISOString()).run();
    return attempt;
  }

  async failAttempt(runId: string, step: (typeof PIPELINE_STEPS)[number], attempt: number, error: string): Promise<void> {
    await this.db.prepare(
      "INSERT INTO audit_events (id, run_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), runId, "workflow_attempt_failed", JSON.stringify({ step, attempt, error }), new Date().toISOString()).run();
  }

  async invalidateFrom(runId: string, step: (typeof PIPELINE_STEPS)[number]): Promise<void> {
    const steps = PIPELINE_STEPS.slice(PIPELINE_STEPS.indexOf(step));
    const records = await this.db.prepare(
      "SELECT id, event_json FROM audit_events WHERE run_id = ? AND event_type = ?",
    ).bind(runId, "workflow_checkpoint").all<{ id: string; event_json: string }>();
    const ids = records.results.flatMap((row) => {
      try { return steps.includes((JSON.parse(row.event_json) as { step?: unknown }).step as typeof step) ? [row.id] : []; } catch { return []; }
    });
    for (const id of ids) await this.db.prepare("DELETE FROM audit_events WHERE id = ?").bind(id).run();
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
        if (parsed.step !== step) continue;
        return PersistedArtifactSchema.parse(parsed.artifact) as CheckpointArtifact<T>;
      } catch {
        // Corrupt diagnostic data is not a completed checkpoint.
      }
    }
    return null;
  }

  async createDraft(edition: Edition): Promise<void> {
    const result = await this.db.prepare(
      `INSERT INTO editions (
        id, edition_date, run_id, status, reading_minutes, published_at, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edition_date) DO UPDATE SET metadata_json = excluded.metadata_json
      WHERE editions.run_id = excluded.run_id AND editions.status = 'draft'`,
    ).bind(
      edition.id, edition.editionDate, edition.runId, edition.status,
      edition.readingMinutes, edition.publishedAt, edition.createdAt,
      JSON.stringify(edition.metadata ?? { missingSections: [], sourceFailures: [] }),
    ).run();
    if ((result.meta.changes ?? 0) === 0) {
      const existing = await this.db.prepare(
        "SELECT run_id, status FROM editions WHERE edition_date = ?",
      ).bind(edition.editionDate).first<{ run_id: string; status: string }>();
      if (existing?.run_id !== edition.runId || existing.status !== "draft") {
        throw new Error("EDITION_ALREADY_EXISTS");
      }
    }
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

  async persistEdition(
    edition: Edition,
    entries: readonly EditionEntry[],
    status: "draft" | "published" | "partial",
  ): Promise<Edition> {
    return this.repository.persistEdition(
      edition.editionDate,
      edition.runId,
      entries,
      status,
      edition.metadata ?? { missingSections: [], sourceFailures: [] },
    );
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

function configuredPipelineContext(
  store: D1PipelineStore,
  editionDate: string,
  runId: string,
  provider: ModelProvider,
): PipelineContext {
  const passthrough = async (items: readonly import("../contracts/editorial").Item[]) => items;
  const packet = (item: import("../contracts/editorial").Item): SourcePacket => ({
    itemKind: item.kind,
    sources: item.sourceRefs.map((source) => ({
      sourceId: source.id, role: source.role, title: item.title, url: source.url,
      retrievedAt: source.retrievedAt, accessLevel: item.accessLevel,
      excerpts: [{ number: 1, text: item.normalizedText.slice(0, 4_000) || item.title }],
    })),
  });
  return {
    editionDate,
    runId,
    store,
    now: () => new Date().toISOString(),
    collect: async () => {
      const sources = await store.repository.listSources();
      const collector = createNewsCollectorFromCatalog({ http: new SourceHttpClient(), sources });
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 36 * 60 * 60 * 1_000).toISOString();
      return (await collector.collect({ from, to })).map(normalizeCandidate);
    },
    normalize: async (items) => deduplicateItems(items).items,
    enrich: passthrough,
    prefilter: passthrough,
    assess: passthrough,
    score: passthrough,
    cluster: passthrough,
    shortlist: passthrough,
    synthesize: async (items) => Promise.all(items.map(async (item) => ({ item, summary: await summarizeItem(packet(item), provider) }))),
    validate: async (entries) => entries.map((entry) => ({ ...entry, valid: validateSummary(entry.summary, packet(entry.item)).ok })),
  };
}

export function createD1WorkflowLauncher(db: D1Database, provider: ModelProvider): {
  start(input: { editionDate: string; actorEmail?: string }): Promise<{ runId: string }>;
  resume(input: { runId: string; actorEmail?: string }): Promise<void>;
} {
  const store = new D1PipelineStore(db);
  return {
    async start(input) {
      const runId = crypto.randomUUID();
      try {
        await runEditorialPipeline(configuredPipelineContext(store, input.editionDate, runId, provider));
      } catch (error) {
        await store.audit(
          error instanceof WorkflowRunAlreadyExistsError ? null : runId,
          "manual_run_started",
          input.actorEmail,
        );
        if (error instanceof WorkflowRunAlreadyExistsError) throw error;
        return { runId };
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
      await runEditorialPipeline(configuredPipelineContext(store, run.editionDate, run.id, provider));
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

  const attempt = await context.store.beginAttempt(context.runId, step);
  const startedAt = Date.parse(context.now());
  let output: T;
  try {
    output = await execute();
  } catch (error) {
    await context.store.failAttempt(context.runId, step, attempt, error instanceof Error ? error.message : "PIPELINE_FAILED");
    throw error;
  }
  const estimatedCostUsd = context.estimateCostUsd?.(step, output) ?? 0;
  const artifact: CheckpointArtifact<T> = {
    output,
    attempts: attempt,
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
  if (run.status === "partial" && run.retryable) {
    await context.store.invalidateFrom(context.runId, "collect");
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
