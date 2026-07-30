import { z } from "zod";

import {
  ArchiveSearchPageSchema,
  EditionPageSchema,
  type ArchiveSearchPage,
  type EditionPage,
} from "../contracts/api";
import {
  EditionEntrySchema,
  EditionMetadataSchema,
  EditionSectionSchema,
  EditionSchema,
  EditionWithEntriesSchema,
  ItemSchema,
  ItemScoreSchema,
  RetentionReportSchema,
  StructuredSummarySchema,
  type Edition,
  type EditionMetadata,
  type EditionEntry,
  type EditionWithEntries,
  type Item,
  type ItemScore,
  type RetentionReport,
  type StructuredSummary,
} from "../contracts/editorial";
import {
  approvedBaselinePreferences,
  CreateSourceInputSchema,
  FeedbackAdjustmentSchema,
  FeedbackInputSchema,
  PreferenceUpdateInputSchema,
  ReaderPreferencesSchema,
  RepositoryValidationError,
  serializeJsonMutation,
  SourceAlreadyExistsError,
  SourceIdAlreadyExistsError,
  SourceRecordSchema,
  UpdateSourceInputSchema,
  WorkflowRunDetailSchema,
  WorkflowRunSchema,
  type ArchiveSearchInput,
  type BriefingRepository,
  type CreateSourceInput,
  type EditionListInput,
  type FeedbackInput,
  type FeedbackAdjustment,
  type PreferenceUpdateInput,
  type ReaderPreferences,
  type ModelUsageRecord,
  type SourceRecord,
  type UpdateSourceInput,
  type WorkflowRun,
  type WorkflowRunDetail,
} from "./repository";
import {
  decodeEditionCursor,
  encodeEditionCursor,
} from "../pagination/edition-cursor";
import { PIPELINE_STEPS } from "../workflow/types";

const DateTimeSchema = z.string().datetime();
const ModelUsageRecordSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  inputTokens: z.number().int().nonnegative().max(10_000_000),
  outputTokens: z.number().int().nonnegative().max(10_000_000),
  embeddingCount: z.number().int().nonnegative().max(10_000_000),
  unitPriceUsd: z.number().finite().nonnegative().max(1_000_000),
  estimatedCostUsd: z.number().finite().nonnegative().max(1_000_000),
}).strict();
const EditionDateSchema = EditionSchema.shape.editionDate;
const NonemptyIdSchema = z.string().min(1);
const PageInputSchema = z.object({
  limit: z.number().int().min(1).max(100),
  cursor: z.string().min(1).nullable(),
});
const ArchiveInputSchema = PageInputSchema.extend({
  query: z.string().trim().min(1).nullable(),
  topic: z.string().trim().min(1).nullable(),
  author: z.string().trim().min(1).nullable(),
  institution: z.string().trim().min(1).nullable(),
  source: z.string().trim().min(1).nullable(),
  section: EditionSectionSchema.nullable(),
  saved: z.boolean().optional().default(false),
});
const OffsetCursorSchema = z.object({
  offset: z.number().int().nonnegative(),
});

type EditionRow = {
  id: string;
  edition_date: string;
  run_id: string;
  status: string;
  reading_minutes: number | null;
  published_at: string | null;
  created_at: string;
  metadata_json: string;
};

type EntryRow = {
  id: string;
  edition_id: string;
  item_id: string | null;
  section: string;
  position: number;
  structured_json: string;
  selection_reasons_json: string;
  source_refs_json: string;
};

type SourceRow = {
  id: string;
  canonical_name: string;
  canonical_url: string;
  role: string;
  trust_prior: number;
  enabled: number;
  restrictions_json: string;
  last_success_at: string | null;
  health_status: string;
};

type FeedbackRow = {
  id: string;
  item_id: string;
  action: string;
  reason: string | null;
  created_at: string;
};

type PreferencesRow = {
  topic_weights_json: string;
  source_weights_json: string;
  institution_weights_json: string;
  section_budgets_json: string;
};

type WorkflowRunRow = {
  id: string;
  edition_date: string;
  status: string;
  current_step: string | null;
  retryable: number;
  attempt_count: number;
  failure_code: string | null;
  estimated_cost_usd: number;
  created_at: string;
  updated_at: string;
};

type AuditEventRow = {
  event_type: string;
  event_json: string;
  created_at: string;
};

type PublishedRunRow = {
  published_at: string | null;
  metadata_json: string;
};

function validated<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RepositoryValidationError(
      `${context}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`)
        .join("; ")}`,
      { cause: result.error },
    );
  }
  return result.data;
}

function parsedJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RepositoryValidationError(`${context}: invalid JSON`, {
      cause: error,
    });
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function encodeOffsetCursor(offset: number): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ offset }));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeOffsetCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }

  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error("cursor is not base64url");
    }
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return validated(
      OffsetCursorSchema,
      JSON.parse(new TextDecoder().decode(bytes)),
      "Invalid cursor",
    ).offset;
  } catch (error) {
    if (error instanceof RepositoryValidationError) {
      throw error;
    }
    throw new RepositoryValidationError("Invalid cursor", { cause: error });
  }
}

function editionFromRow(row: EditionRow): Edition {
  return validated(
    EditionSchema,
    {
      id: row.id,
      editionDate: row.edition_date,
      runId: row.run_id,
      status: row.status,
      readingMinutes: row.reading_minutes,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      metadata: EditionMetadataSchema.parse(
        parsedJson(row.metadata_json, "Invalid edition metadata"),
      ),
    },
    "Invalid edition row",
  );
}

function entryFromRow(row: EntryRow): EditionEntry {
  return validated(
    EditionEntrySchema,
    {
      id: row.id,
      editionId: row.edition_id,
      itemId: row.item_id,
      section: row.section,
      position: row.position,
      summary: parsedJson(row.structured_json, "Invalid summary row"),
      selectionReasons: parsedJson(
        row.selection_reasons_json,
        "Invalid edition selection reasons",
      ),
      sourceRefs: parsedJson(
        row.source_refs_json,
        "Invalid edition source references",
      ),
    },
    "Invalid edition entry row",
  );
}

function storedBoolean(value: unknown, context: string): boolean {
  if (value === 0) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  throw new RepositoryValidationError(`${context}: expected 0 or 1`);
}

function publicDiagnostic(
  _value: string,
  fallback: string,
): string {
  return fallback;
}

function publicLabel(value: string, fallback: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) ||
    /(api[-_]?key|authorization|bearer|password|secret|sk_(?:live|test)|token)/i.test(
      value,
    )
  ) {
    return fallback;
  }
  return value;
}

function sourceFromRow(row: SourceRow): SourceRecord {
  const stored = parsedJson(
    row.restrictions_json,
    "Invalid source restrictions",
  );
  if (
    typeof stored !== "object" ||
    stored === null ||
    Array.isArray(stored)
  ) {
    throw new RepositoryValidationError(
      "Invalid source restrictions: expected an object",
    );
  }

  const {
    discoveryMechanism = "manual",
    sectionEligibility = [],
    ...restrictions
  } = stored as Record<string, unknown>;

  return validated(
    SourceRecordSchema,
    {
      id: row.id,
      canonicalName: row.canonical_name,
      canonicalUrl: row.canonical_url,
      role: row.role,
      trustPrior: row.trust_prior,
      enabled: storedBoolean(row.enabled, "Invalid source enabled value"),
      restrictions,
      discoveryMechanism,
      sectionEligibility,
      lastSuccessAt: row.last_success_at,
      healthStatus: row.health_status,
    },
    "Invalid source row",
  );
}

function workflowRunFromRow(row: WorkflowRunRow): WorkflowRun {
  return validated(
    WorkflowRunSchema,
    {
      id: row.id,
      editionDate: row.edition_date,
      status: row.status,
      currentStep: row.current_step,
      retryable: storedBoolean(
        row.retryable,
        "Invalid workflow retryable value",
      ),
      attemptCount: row.attempt_count,
      failureCode:
        row.failure_code === null
          ? null
          : publicLabel(row.failure_code, "REDACTED_FAILURE"),
      estimatedCostUsd: row.estimated_cost_usd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    "Invalid workflow run row",
  );
}

function restrictionsJson(source: {
  restrictions: Record<string, unknown>;
  discoveryMechanism: string;
  sectionEligibility: readonly string[];
}): string {
  return serializeJsonMutation(
    {
      ...source.restrictions,
      discoveryMechanism: source.discoveryMechanism,
      sectionEligibility: source.sectionEligibility,
    },
    "Invalid source restrictions",
  );
}

function feedbackMetadata(row: FeedbackRow): {
  reason: FeedbackInput["reason"];
  adjustments: FeedbackAdjustment[];
} {
  if (row.reason === null) {
    return { reason: null, adjustments: [] };
  }
  try {
    const parsed = parsedJson(row.reason, "Invalid feedback metadata");
    const result = z.object({
      reason: FeedbackInputSchema.shape.reason,
      adjustments: z.array(FeedbackAdjustmentSchema),
    }).strict().safeParse(parsed);
    if (result.success) {
      return result.data;
    }
  } catch {
    // Legacy rows stored the reason directly.
  }
  const legacyReason = FeedbackInputSchema.shape.reason.safeParse(row.reason);
  if (!legacyReason.success) {
    throw new RepositoryValidationError("Invalid feedback reason");
  }
  return { reason: legacyReason.data, adjustments: [] };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function sourceConflict(
  error: unknown,
): "canonical_url" | "id" | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (/UNIQUE constraint failed: sources\.canonical_url/i.test(error.message)) {
    return "canonical_url";
  }
  if (/UNIQUE constraint failed: sources\.id/i.test(error.message)) {
    return "id";
  }
  return null;
}

function canonicalSourceUrl(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function likeContains(value: string): string {
  return `%${value
    .toLocaleLowerCase("en-US")
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

function summaryStatements(
  db: D1Database,
  summaryId: string,
  itemId: string | null,
  summary: StructuredSummary,
  createdAt: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO summaries (
          id, item_id, title, one_sentence, why_it_matters, uncertainty,
          access_level, structured_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          item_id = excluded.item_id,
          title = excluded.title,
          one_sentence = excluded.one_sentence,
          why_it_matters = excluded.why_it_matters,
          uncertainty = excluded.uncertainty,
          access_level = excluded.access_level,
          structured_json = excluded.structured_json,
          created_at = excluded.created_at`,
      )
      .bind(
        summaryId,
        itemId,
        summary.title,
        summary.oneSentence,
        summary.whyItMatters,
        summary.uncertainty,
        summary.accessLevel,
        JSON.stringify(summary),
        createdAt,
      ),
    db.prepare("DELETE FROM summary_claims WHERE summary_id = ?").bind(
      summaryId,
    ),
  ];

  for (const [position, claim] of summary.claims.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO summary_claims (
            id, summary_id, position, text, evidence_excerpt, source_ids_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${summaryId}:claim:${position}`,
          summaryId,
          position,
          claim.text,
          claim.evidenceExcerpt,
          JSON.stringify(claim.sourceIds),
        ),
    );
  }
  return statements;
}

export class D1BriefingRepository implements BriefingRepository {
  constructor(private readonly db: D1Database) {}

  async upsertItems(items: readonly Item[]): Promise<void> {
    const validItems = items.map((item) => {
      serializeJsonMutation(item, "Invalid item mutation");
      return validated(ItemSchema, item, "Invalid item");
    });
    if (validItems.length === 0) {
      return;
    }

    const statements: D1PreparedStatement[] = [];
    for (const item of validItems) {
      const normalizedJson = serializeJsonMutation(
        item,
        "Invalid item JSON",
      );
      const itemSources = [...item.sourceRefs]
        .sort(
          (left, right) =>
            left.id.localeCompare(right.id) ||
            left.url.localeCompare(right.url) ||
            left.name.localeCompare(right.name) ||
            left.role.localeCompare(right.role) ||
            left.retrievedAt.localeCompare(right.retrievedAt),
        )
        .filter(
          (source, index, sources) =>
            index === 0 || sources[index - 1]?.id !== source.id,
        );
      for (const source of itemSources) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO sources (
                id, canonical_name, canonical_url, role, trust_prior, enabled,
                restrictions_json, last_success_at, health_status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                canonical_name = excluded.canonical_name,
                role = excluded.role`,
            )
            .bind(
              source.id,
              source.name,
              source.url,
              source.role,
              0.5,
              1,
              JSON.stringify({
                discoveryMechanism: "manual",
                sectionEligibility: [],
              }),
              null,
              "unknown",
            ),
        );
      }

      statements.push(
        this.db
          .prepare(
            `INSERT INTO items (
              id, kind, canonical_url, title, published_at,
              content_access_level, normalized_json, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              canonical_url = excluded.canonical_url,
              title = excluded.title,
              published_at = excluded.published_at,
              content_access_level = excluded.content_access_level,
              normalized_json = excluded.normalized_json,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at`,
          )
          .bind(
            item.id,
            item.kind,
            item.canonicalUrl,
            item.title,
            item.publishedAt,
            item.accessLevel,
            normalizedJson,
            item.createdAt,
            item.expiresAt,
          ),
        this.db.prepare("DELETE FROM item_sources WHERE item_id = ?").bind(
          item.id,
        ),
      );

      for (const source of itemSources) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO item_sources (
                item_id, source_id, source_name, source_url, role, retrieved_at
              ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              item.id,
              source.id,
              source.name,
              source.url,
              source.role,
              source.retrievedAt,
            ),
        );
      }

      const authors = stringArray(item.metadata.authors);
      const institutions = stringArray(item.metadata.institutions);
      const doi =
        typeof item.metadata.doi === "string" ? item.metadata.doi : null;
      const venue =
        typeof item.metadata.venue === "string" ? item.metadata.venue : null;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO paper_metadata (
              item_id, doi, venue, authors_json, institutions_json,
              author_search, institution_search
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
              doi = excluded.doi,
              venue = excluded.venue,
              authors_json = excluded.authors_json,
              institutions_json = excluded.institutions_json,
              author_search = excluded.author_search,
              institution_search = excluded.institution_search`,
          )
          .bind(
            item.id,
            doi,
            venue,
            JSON.stringify(authors),
            JSON.stringify(institutions),
            authors.join("\n"),
            institutions.join("\n"),
          ),
      );
    }

    await this.db.batch(statements);
  }

  async saveScores(scores: readonly ItemScore[]): Promise<void> {
    const validScores = scores.map((score) =>
      validated(ItemScoreSchema, score, "Invalid item score"),
    );
    if (validScores.length === 0) {
      return;
    }
    const updatedAt = new Date().toISOString();
    await this.db.batch(
      validScores.map((score) =>
        this.db
          .prepare(
            `INSERT INTO scores (
              item_id, topical_fit, technical_quality, research_signal,
              novelty, serious_attention, total, selection_reasons_json,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
              topical_fit = excluded.topical_fit,
              technical_quality = excluded.technical_quality,
              research_signal = excluded.research_signal,
              novelty = excluded.novelty,
              serious_attention = excluded.serious_attention,
              total = excluded.total,
              selection_reasons_json = excluded.selection_reasons_json,
              updated_at = excluded.updated_at`,
          )
          .bind(
            score.itemId,
            score.topicalFit,
            score.technicalQuality,
            score.researchSignal,
            score.novelty,
            score.seriousAttention,
            score.total,
            JSON.stringify(score.selectionReasons),
            updatedAt,
          ),
      ),
    );
  }

  async saveSummary(
    itemId: string,
    summary: StructuredSummary,
  ): Promise<void> {
    const validItemId = validated(
      NonemptyIdSchema,
      itemId,
      "Invalid summary item ID",
    );
    const validSummary = validated(
      StructuredSummarySchema,
      summary,
      "Invalid summary",
    );
    await this.db.batch(
      summaryStatements(
        this.db,
        `item:${validItemId}`,
        validItemId,
        validSummary,
        new Date().toISOString(),
      ),
    );
  }

  async createDraftEdition(
    editionDate: string,
    runId: string,
    metadata: EditionMetadata = { missingSections: [], sourceFailures: [] },
  ): Promise<Edition> {
    const validDate = validated(
      EditionDateSchema,
      editionDate,
      "Invalid edition date",
    );
    const validRunId = validated(
      NonemptyIdSchema,
      runId,
      "Invalid workflow run ID",
    );
    const edition = validated(
      EditionSchema,
      {
        id: crypto.randomUUID(),
        editionDate: validDate,
        runId: validRunId,
        status: "draft",
        readingMinutes: null,
        publishedAt: null,
        createdAt: new Date().toISOString(),
        metadata: EditionMetadataSchema.parse(metadata),
      },
      "Invalid draft edition",
    );
    await this.db
      .prepare(
        `INSERT INTO editions (
          id, edition_date, run_id, status, reading_minutes, published_at,
          created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        edition.id,
        edition.editionDate,
        edition.runId,
        edition.status,
        edition.readingMinutes,
        edition.publishedAt,
        edition.createdAt,
        JSON.stringify(edition.metadata),
      )
      .run();
    return edition;
  }

  async replaceEditionEntries(
    editionId: string,
    entries: readonly EditionEntry[],
  ): Promise<void> {
    const validEditionId = validated(
      NonemptyIdSchema,
      editionId,
      "Invalid edition ID",
    );
    const validEntries = entries.map((entry) => {
      const validEntry = validated(
        EditionEntrySchema,
        entry,
        "Invalid edition entry",
      );
      if (validEntry.editionId !== validEditionId) {
        throw new RepositoryValidationError(
          "Edition entry belongs to a different edition",
        );
      }
      return validEntry;
    });

    const edition = await this.db
      .prepare("SELECT status FROM editions WHERE id = ?")
      .bind(validEditionId)
      .first<{ status: string }>();
    if (edition?.status !== "draft") {
      throw new RepositoryValidationError(
        "Edition entries may only be replaced while the edition is a draft",
      );
    }

    const previous = await this.db
      .prepare(
        "SELECT summary_id FROM edition_entries WHERE edition_id = ?",
      )
      .bind(validEditionId)
      .all<{ summary_id: string }>();

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare("DELETE FROM edition_entries WHERE edition_id = ?")
        .bind(validEditionId),
    ];
    for (const row of previous.results) {
      statements.push(
        this.db.prepare("DELETE FROM summaries WHERE id = ?").bind(
          row.summary_id,
        ),
      );
    }

    const createdAt = new Date().toISOString();
    for (const entry of validEntries) {
      const summaryId = `edition-entry:${entry.id}`;
      statements.push(
        ...summaryStatements(
          this.db,
          summaryId,
          entry.itemId,
          entry.summary,
          createdAt,
        ),
        this.db
          .prepare(
            `INSERT INTO edition_entries (
              id, edition_id, item_id, summary_id, section, position,
              selection_reasons_json, source_refs_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            entry.id,
            validEditionId,
            entry.itemId,
            summaryId,
            entry.section,
            entry.position,
            JSON.stringify(entry.selectionReasons),
            JSON.stringify(entry.sourceRefs),
          ),
      );
    }

    await this.db.batch(statements);
  }

  async publishEdition(
    editionId: string,
    publishedAt: string,
    status: "published" | "partial",
  ): Promise<void> {
    const validEditionId = validated(
      NonemptyIdSchema,
      editionId,
      "Invalid edition ID",
    );
    const validPublishedAt = validated(
      DateTimeSchema,
      publishedAt,
      "Invalid publication date",
    );
    const validStatus = validated(
      z.enum(["published", "partial"]),
      status,
      "Invalid publication status",
    );
    const [result] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE editions
          SET status = ?, published_at = ?
          WHERE id = ? AND status = ?`,
        )
        .bind(validStatus, validPublishedAt, validEditionId, "draft"),
    ]);
    if ((result?.meta.changes ?? 0) !== 1) {
      throw new RepositoryValidationError(
        "Only an existing draft edition may be published",
      );
    }
  }

  async persistEdition(
    editionDate: string,
    runId: string,
    entries: readonly EditionEntry[],
    status: "draft" | "published" | "partial",
    metadata: EditionMetadata,
  ): Promise<Edition> {
    const validDate = validated(EditionDateSchema, editionDate, "Invalid edition date");
    const validRunId = validated(NonemptyIdSchema, runId, "Invalid workflow run ID");
    const validMetadata = EditionMetadataSchema.parse(metadata);
    const existing = await this.db.prepare(
      "SELECT * FROM editions WHERE edition_date = ? LIMIT 1",
    ).bind(validDate).first<EditionRow>();
    if (status === "draft" && existing !== null && (existing.status === "published" || existing.status === "partial")) {
      return editionFromRow(existing);
    }
    if (existing !== null && existing.run_id !== validRunId) {
      throw new RepositoryValidationError("Edition date belongs to another workflow run");
    }
    const editionId = existing?.id ?? crypto.randomUUID();
    const createdAt = existing?.created_at ?? new Date().toISOString();
    const validEntries = entries.map((entry) => validated(EditionEntrySchema, {
      ...entry, editionId,
    }, "Invalid edition entry"));
    const previous = existing === null ? [] : (await this.db.prepare(
      "SELECT summary_id FROM edition_entries WHERE edition_id = ?",
    ).bind(editionId).all<{ summary_id: string }>()).results;
    const publishedAt = status === "draft" ? null : new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO editions (id, edition_date, run_id, status, reading_minutes, published_at, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(edition_date) DO UPDATE SET status = excluded.status, reading_minutes = excluded.reading_minutes,
           published_at = excluded.published_at, metadata_json = excluded.metadata_json`,
      ).bind(editionId, validDate, validRunId, "draft", validEntries.length === 0 ? null : 20, null, createdAt, JSON.stringify(validMetadata)),
      this.db.prepare("DELETE FROM edition_entries WHERE edition_id = ?").bind(editionId),
    ];
    for (const row of previous) statements.push(this.db.prepare("DELETE FROM summaries WHERE id = ?").bind(row.summary_id));
    for (const entry of validEntries) {
      const summaryId = `edition-entry:${entry.id}`;
      statements.push(
        ...summaryStatements(this.db, summaryId, entry.itemId, entry.summary, createdAt),
        this.db.prepare(
          `INSERT INTO edition_entries (id, edition_id, item_id, summary_id, section, position, selection_reasons_json, source_refs_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(entry.id, editionId, entry.itemId, summaryId, entry.section, entry.position, JSON.stringify(entry.selectionReasons), JSON.stringify(entry.sourceRefs)),
      );
    }
    if (status !== "draft") {
      statements.push(this.db.prepare("UPDATE editions SET status = ?, published_at = ? WHERE id = ?").bind(status, publishedAt, editionId));
    }
    await this.db.batch(statements);
    return editionFromRow({ id: editionId, edition_date: validDate, run_id: validRunId, status, reading_minutes: validEntries.length === 0 ? null : 20, published_at: publishedAt, created_at: createdAt, metadata_json: JSON.stringify(validMetadata) });
  }

  async getLatestEdition(): Promise<EditionWithEntries | null> {
    const row = await this.db
      .prepare(
        `SELECT *
        FROM editions
        WHERE status IN (?, ?)
        ORDER BY edition_date DESC, id DESC
        LIMIT 1`,
      )
      .bind("published", "partial")
      .first<EditionRow>();
    return row === null ? null : this.editionWithEntries(row);
  }

  async getEditionByDate(
    editionDate: string,
  ): Promise<EditionWithEntries | null> {
    const validDate = validated(
      EditionDateSchema,
      editionDate,
      "Invalid edition date",
    );
    const row = await this.db
      .prepare(
        `SELECT *
        FROM editions
        WHERE edition_date = ? AND status IN (?, ?)
        LIMIT 1`,
      )
      .bind(validDate, "published", "partial")
      .first<EditionRow>();
    return row === null ? null : this.editionWithEntries(row);
  }

  async listEditions(input: EditionListInput): Promise<EditionPage> {
    const validInput = validated(
      PageInputSchema,
      input,
      "Invalid edition list input",
    );
    let lastEditionDate: string | null = null;
    if (validInput.cursor !== null) {
      try {
        lastEditionDate = decodeEditionCursor(validInput.cursor);
      } catch (error) {
        throw new RepositoryValidationError("Invalid edition cursor", {
          cause: error,
        });
      }
    }
    const statement =
      lastEditionDate === null
        ? this.db
            .prepare(
              `SELECT *
              FROM editions
              WHERE status IN (?, ?)
              ORDER BY edition_date DESC, id DESC
              LIMIT ?`,
            )
            .bind("published", "partial", validInput.limit + 1)
        : this.db
            .prepare(
              `SELECT *
              FROM editions
              WHERE status IN (?, ?) AND edition_date < ?
              ORDER BY edition_date DESC, id DESC
              LIMIT ?`,
            )
            .bind(
              "published",
              "partial",
              lastEditionDate,
              validInput.limit + 1,
            );
    const result = await statement.all<EditionRow>();
    const hasMore = result.results.length > validInput.limit;
    const items = result.results
      .slice(0, validInput.limit)
      .map(editionFromRow);
    const lastItem = items.at(-1);
    return validated(
      EditionPageSchema,
      {
        items,
        nextCursor:
          hasMore && lastItem !== undefined
            ? encodeEditionCursor(lastItem.editionDate)
            : null,
      },
      "Invalid edition page",
    );
  }

  async searchArchive(
    input: ArchiveSearchInput,
  ): Promise<ArchiveSearchPage> {
    const validInput = validated(
      ArchiveInputSchema,
      input,
      "Invalid archive search input",
    );
    const offset = decodeOffsetCursor(validInput.cursor);
    const clauses = ["e.status IN (?, ?)"];
    const values: unknown[] = ["published", "partial"];

    if (validInput.query !== null) {
      clauses.push(
        `(LOWER(i.title) LIKE ? ESCAPE '\\'
          OR LOWER(json_extract(i.normalized_json, '$.primaryTopic'))
            LIKE ? ESCAPE '\\'
          OR LOWER(json_extract(i.normalized_json, '$.normalizedText'))
            LIKE ? ESCAPE '\\'
          OR LOWER(pm.author_search) LIKE ? ESCAPE '\\'
          OR LOWER(pm.institution_search) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM item_sources query_item_source
            WHERE query_item_source.item_id = i.id
              AND (
                LOWER(query_item_source.source_name) LIKE ? ESCAPE '\\'
                OR LOWER(query_item_source.source_url) LIKE ? ESCAPE '\\'
              )
          )
          OR LOWER(json_extract(s.structured_json, '$.title'))
            LIKE ? ESCAPE '\\'
          OR LOWER(json_extract(s.structured_json, '$.oneSentence'))
            LIKE ? ESCAPE '\\'
          OR LOWER(json_extract(s.structured_json, '$.whyItMatters'))
            LIKE ? ESCAPE '\\'
          OR LOWER(json_extract(s.structured_json, '$.claims'))
            LIKE ? ESCAPE '\\')`,
      );
      const queryPattern = likeContains(validInput.query);
      values.push(
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
        queryPattern,
      );
    }
    if (validInput.topic !== null) {
      clauses.push(
        "json_extract(i.normalized_json, '$.primaryTopic') = ?",
      );
      values.push(validInput.topic);
    }
    if (validInput.author !== null) {
      clauses.push("LOWER(pm.author_search) LIKE ? ESCAPE '\\'");
      values.push(likeContains(validInput.author));
    }
    if (validInput.institution !== null) {
      clauses.push("LOWER(pm.institution_search) LIKE ? ESCAPE '\\'");
      values.push(likeContains(validInput.institution));
    }
    if (validInput.source !== null) {
      clauses.push(
        `EXISTS (
          SELECT 1
          FROM item_sources search_item_source
          JOIN sources search_source
            ON search_source.id = search_item_source.source_id
          WHERE search_item_source.item_id = i.id
            AND LOWER(search_source.canonical_name) LIKE ? ESCAPE '\\'
        )`,
      );
      values.push(likeContains(validInput.source));
    }
    if (validInput.section !== null) {
      clauses.push("ee.section = ?");
      values.push(validInput.section);
    }
    if (validInput.saved) {
      clauses.push(
        `(SELECT saved_feedback.action
          FROM feedback saved_feedback
          WHERE saved_feedback.item_id = i.id
            AND saved_feedback.action IN ('save', 'unsave')
          ORDER BY saved_feedback.created_at DESC, saved_feedback.rowid DESC
          LIMIT 1) = 'save'`,
      );
    }

    values.push(validInput.limit + 1, offset);
    const result = await this.db
      .prepare(
        `SELECT
          ee.id,
          ee.edition_id,
          ee.item_id,
          ee.section,
          ee.position,
          s.structured_json,
          ee.selection_reasons_json,
          ee.source_refs_json
        FROM edition_entries ee
        JOIN editions e ON e.id = ee.edition_id
        LEFT JOIN items i ON i.id = ee.item_id
        LEFT JOIN paper_metadata pm ON pm.item_id = i.id
        JOIN summaries s ON s.id = ee.summary_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.edition_date DESC, ee.section, ee.position, ee.id
        LIMIT ? OFFSET ?`,
      )
      .bind(...values)
      .all<EntryRow>();

    const hasMore = result.results.length > validInput.limit;
    const items = result.results
      .slice(0, validInput.limit)
      .map(entryFromRow);
    return validated(
      ArchiveSearchPageSchema,
      {
        items,
        nextCursor: hasMore
          ? encodeOffsetCursor(offset + validInput.limit)
          : null,
      },
      "Invalid archive search page",
    );
  }

  async recordFeedback(input: FeedbackInput): Promise<void> {
    const validInput = validated(
      FeedbackInputSchema,
      input,
      "Invalid feedback",
    );
    const item = await this.db
      .prepare("SELECT normalized_json FROM items WHERE id = ?")
      .bind(validInput.itemId)
      .first<{ normalized_json: string }>();
    if (item === null) {
      throw new RepositoryValidationError("Feedback item not found");
    }

    if (
      validInput.action === "more_like_this" ||
      validInput.action === "less_like_this"
    ) {
      const delta = validInput.action === "more_like_this" ? 0.1 : -0.1;
      const baseline = approvedBaselinePreferences();
      const dimension =
        validInput.reason === "source" ? "source" : "topic";
      let key: string;
      if (dimension === "source") {
        const source = await this.db
          .prepare(
            `SELECT source_id
            FROM item_sources
            WHERE item_id = ?
            ORDER BY source_id
            LIMIT 1`,
          )
          .bind(validInput.itemId)
          .first<{ source_id: string }>();
        if (source === null) {
          throw new RepositoryValidationError(
            "Feedback item has no source",
          );
        }
        key = source.source_id;
      } else {
        const storedItem = validated(
          ItemSchema,
          parsedJson(item.normalized_json, "Invalid feedback item"),
          "Invalid feedback item",
        );
        key = storedItem.primaryTopic;
      }
      const field =
        dimension === "source"
          ? "source_weights_json"
          : "topic_weights_json";
      const baselineMap =
        dimension === "source"
          ? baseline.sourceWeights
          : baseline.topicWeights;
      const createdAt = new Date().toISOString();
      const result = await this.db
        .prepare(
          `INSERT INTO feedback (id, item_id, action, reason, created_at)
          SELECT
            ?, ?, ?,
            json_object(
              'reason', ?,
              'adjustments', json_array(
                json_object(
                  'dimension', ?,
                  'key', ?,
                  'delta', ?,
                  'resultingWeight', ROUND(
                    COALESCE(
                      json_extract(
                        preferences.${field},
                        '$.' || json_quote(?)
                      ),
                      ?
                    )
                    + COALESCE((
                      SELECT SUM(
                        CAST(
                          json_extract(
                            existing.reason,
                            '$.adjustments[0].delta'
                          ) AS REAL
                        )
                      )
                      FROM feedback existing
                      WHERE existing.action IN (
                        'more_like_this',
                        'less_like_this'
                      )
                        AND json_extract(
                          existing.reason,
                          '$.adjustments[0].dimension'
                        ) = ?
                        AND json_extract(
                          existing.reason,
                          '$.adjustments[0].key'
                        ) = ?
                    ), 0)
                    + ?,
                    1
                  )
                )
              )
            ),
            ?
          FROM preferences
          WHERE id = 'reader'`,
        )
        .bind(
          crypto.randomUUID(),
          validInput.itemId,
          validInput.action,
          validInput.reason,
          dimension,
          key,
          delta,
          key,
          baselineMap[key] ?? 0,
          dimension,
          key,
          delta,
          createdAt,
        )
        .run();
      if ((result.meta.changes ?? 0) !== 1) {
        throw new RepositoryValidationError(
          "Reader preference row is missing",
        );
      }
      return;
    }

    await this.db
      .prepare(
        `INSERT INTO feedback (id, item_id, action, reason, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        validInput.itemId,
        validInput.action,
        JSON.stringify({
          reason: validInput.reason,
          adjustments: [],
        }),
        new Date().toISOString(),
      )
      .run();
  }

  async getPreferences(): Promise<ReaderPreferences> {
    const row = await this.preferenceRow();
    const feedback = await this.db
      .prepare(
        `SELECT id, item_id, action, reason, created_at
        FROM feedback
        ORDER BY created_at, rowid`,
      )
      .all<FeedbackRow>();
    const baseline = approvedBaselinePreferences();
    const topicWeights = validated(
      z.record(z.string(), z.number().finite()),
      parsedJson(row.topic_weights_json, "Invalid topic weights"),
      "Invalid topic weights",
    );
    const sourceWeights = validated(
      z.record(z.string(), z.number().finite()),
      parsedJson(row.source_weights_json, "Invalid source weights"),
      "Invalid source weights",
    );
    const running = {
      topic: { ...baseline.topicWeights, ...topicWeights },
      source: { ...baseline.sourceWeights, ...sourceWeights },
    };
    const feedbackHistory = feedback.results.map((record) => {
      const metadata = feedbackMetadata(record);
      const adjustments = metadata.adjustments.map((adjustment) => {
        const weights = running[adjustment.dimension];
        const resultingWeight =
          Math.round(
            ((weights[adjustment.key] ?? 0) + adjustment.delta) * 10,
          ) / 10;
        weights[adjustment.key] = resultingWeight;
        return { ...adjustment, resultingWeight };
      });
      return {
        id: record.id,
        itemId: record.item_id,
        action: record.action,
        reason: metadata.reason,
        adjustments,
        createdAt: record.created_at,
      };
    });

    return validated(
      ReaderPreferencesSchema,
      {
        topicWeights,
        sourceWeights,
        institutionWeights: parsedJson(
          row.institution_weights_json,
          "Invalid institution weights",
        ),
        sectionBudgets: parsedJson(
          row.section_budgets_json,
          "Invalid section budgets",
        ),
        baseline,
        feedbackHistory,
      },
      "Invalid reader preferences",
    );
  }

  async updatePreferences(
    input: PreferenceUpdateInput,
  ): Promise<ReaderPreferences> {
    serializeJsonMutation(input, "Invalid preference mutation");
    const validInput = validated(
      PreferenceUpdateInputSchema,
      input,
      "Invalid preference update",
    );
    await this.db
      .prepare(
        `UPDATE preferences SET
          topic_weights_json = ?,
          source_weights_json = ?,
          institution_weights_json = ?,
          section_budgets_json = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .bind(
        serializeJsonMutation(
          validInput.topicWeights,
          "Invalid topic weights",
        ),
        serializeJsonMutation(
          validInput.sourceWeights,
          "Invalid source weights",
        ),
        serializeJsonMutation(
          validInput.institutionWeights,
          "Invalid institution weights",
        ),
        serializeJsonMutation(
          validInput.sectionBudgets,
          "Invalid section budgets",
        ),
        new Date().toISOString(),
        "reader",
      )
      .run();
    return this.getPreferences();
  }

  async removeFeedbackAdjustment(
    feedbackId: string,
  ): Promise<ReaderPreferences> {
    const validId = validated(
      NonemptyIdSchema,
      feedbackId,
      "Invalid feedback ID",
    );
    const feedback = await this.db
      .prepare(
        `SELECT id, item_id, action, reason, created_at
        FROM feedback
        WHERE id = ?`,
      )
      .bind(validId)
      .first<FeedbackRow>();
    if (feedback === null) {
      throw new RepositoryValidationError("Feedback adjustment not found");
    }
    const metadata = feedbackMetadata(feedback);
    if (metadata.adjustments.length === 0) {
      throw new RepositoryValidationError(
        "Feedback record has no preference adjustment",
      );
    }
    await this.db.prepare("DELETE FROM feedback WHERE id = ?").bind(validId).run();
    return this.getPreferences();
  }

  async resetPreferences(): Promise<ReaderPreferences> {
    const baseline = approvedBaselinePreferences();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE preferences SET
            topic_weights_json = ?,
            source_weights_json = ?,
            institution_weights_json = ?,
            section_budgets_json = ?,
            updated_at = ?
          WHERE id = ?`,
        )
        .bind(
          serializeJsonMutation(
            baseline.topicWeights,
            "Invalid baseline topic weights",
          ),
          serializeJsonMutation(
            baseline.sourceWeights,
            "Invalid baseline source weights",
          ),
          serializeJsonMutation(
            baseline.institutionWeights,
            "Invalid baseline institution weights",
          ),
          serializeJsonMutation(
            baseline.sectionBudgets,
            "Invalid baseline section budgets",
          ),
          new Date().toISOString(),
          "reader",
        ),
      this.db.prepare(
        `DELETE FROM feedback
        WHERE action IN ('more_like_this', 'less_like_this')`,
      ),
    ]);
    return this.getPreferences();
  }

  async listSources(): Promise<readonly SourceRecord[]> {
    const result = await this.db
      .prepare("SELECT * FROM sources ORDER BY canonical_name, id")
      .all<SourceRow>();
    return result.results.map(sourceFromRow);
  }

  async createSource(input: CreateSourceInput): Promise<SourceRecord> {
    serializeJsonMutation(input, "Invalid source mutation");
    const validInput = validated(
      CreateSourceInputSchema,
      { ...input, canonicalUrl: canonicalSourceUrl(input.canonicalUrl) },
      "Invalid source",
    );
    try {
      await this.db
        .prepare(
          `INSERT INTO sources (
            id, canonical_name, canonical_url, role, trust_prior, enabled,
            restrictions_json, last_success_at, health_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          validInput.id,
          validInput.canonicalName,
          validInput.canonicalUrl,
          validInput.role,
          validInput.trustPrior,
          validInput.enabled ? 1 : 0,
          restrictionsJson(validInput),
          null,
          "unknown",
        )
        .run();
    } catch (error) {
      const conflict = sourceConflict(error);
      if (conflict === "canonical_url") {
        throw new SourceAlreadyExistsError();
      }
      if (conflict === "id") {
        throw new SourceIdAlreadyExistsError();
      }
      throw error;
    }
    const created = await this.sourceById(validInput.id);
    if (created === null) {
      throw new RepositoryValidationError(
        "Created source could not be read",
      );
    }
    return created;
  }

  async updateSource(
    sourceId: string,
    input: UpdateSourceInput,
    actorEmail = "system",
  ): Promise<SourceRecord> {
    serializeJsonMutation(input, "Invalid source update mutation");
    const validId = validated(
      NonemptyIdSchema,
      sourceId,
      "Invalid source ID",
    );
    const validInput = validated(
      UpdateSourceInputSchema,
      {
        ...input,
        ...(
          input.canonicalUrl === undefined
            ? {}
            : { canonicalUrl: canonicalSourceUrl(input.canonicalUrl) }
        ),
      },
      "Invalid source update",
    );
    const current = await this.sourceById(validId);
    if (current === null) {
      throw new RepositoryValidationError("Source not found");
    }
    const merged = validated(
      SourceRecordSchema,
      { ...current, ...validInput },
      "Invalid updated source",
    );
    const updateStatement = this.db
      .prepare(
        `UPDATE sources SET
          canonical_name = ?,
          canonical_url = ?,
          role = ?,
          trust_prior = ?,
          enabled = ?,
          restrictions_json = ?
        WHERE id = ?`,
      )
      .bind(
        merged.canonicalName,
        merged.canonicalUrl,
        merged.role,
        merged.trustPrior,
        merged.enabled ? 1 : 0,
        restrictionsJson(merged),
        validId,
      );
    try {
      const validActor = validated(
        z.union([z.literal("system"), z.string().email()]),
        actorEmail,
        "Invalid audit actor",
      );
      await this.db.batch([
        updateStatement,
        this.db
          .prepare(
            `INSERT INTO audit_events (
              id, run_id, event_type, event_json, created_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            null,
            "source_updated",
            serializeJsonMutation(
              {
                sourceId: validId,
                actorEmail: validActor,
                changes: validInput,
              },
              "Invalid source audit event",
            ),
            new Date().toISOString(),
          ),
      ]);
    } catch (error) {
      const conflict = sourceConflict(error);
      if (conflict === "canonical_url") {
        throw new SourceAlreadyExistsError();
      }
      if (conflict === "id") {
        throw new SourceIdAlreadyExistsError();
      }
      throw error;
    }
    const updated = await this.sourceById(validId);
    if (updated === null) {
      throw new RepositoryValidationError(
        "Updated source could not be read",
      );
    }
    return updated;
  }

  async listWorkflowRuns(): Promise<readonly WorkflowRun[]> {
    const result = await this.db
      .prepare(
        `SELECT *
        FROM workflow_runs
        ORDER BY created_at DESC, id DESC`,
      )
      .all<WorkflowRunRow>();
    return result.results.map(workflowRunFromRow);
  }

  async getWorkflowRun(runId: string): Promise<WorkflowRun | null> {
    const validId = validated(
      NonemptyIdSchema,
      runId,
      "Invalid workflow run ID",
    );
    const row = await this.db
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .bind(validId)
      .first<WorkflowRunRow>();
    return row === null ? null : workflowRunFromRow(row);
  }

  async getWorkflowRunDetail(
    runId: string,
  ): Promise<WorkflowRunDetail | null> {
    const run = await this.getWorkflowRun(runId);
    if (run === null) {
      return null;
    }
    const events = await this.db
      .prepare(
        `SELECT event_type, event_json, created_at
        FROM audit_events
        WHERE run_id = ?
          AND event_type IN ('workflow_checkpoint', 'workflow_attempt_failed')
        ORDER BY created_at, id`,
      )
      .bind(run.id)
      .all<AuditEventRow>();
    const checkpointByStep = new Map<
      string,
      {
        step: string;
        state: "completed";
        attempts: number;
        itemCount: number;
      }
    >();
    const failures: Array<{
      step: string;
      attempt: number;
      reason: string;
    }> = [];
    const rejectedSummaryReasons: string[] = [];
    for (const event of events.results) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.event_json);
      } catch {
        continue;
      }
      if (event.event_type === "workflow_attempt_failed") {
        const failure = z.object({
          step: z.enum(PIPELINE_STEPS),
          attempt: z.number().int().positive(),
          error: z.string().min(1),
        }).passthrough().safeParse(parsed);
        if (failure.success) {
          failures.push({
            step: failure.data.step,
            attempt: failure.data.attempt,
            reason: publicDiagnostic(
              failure.data.error,
              "REDACTED_FAILURE",
            ),
          });
        }
        continue;
      }
      const checkpoint = z.object({
        step: z.string().min(1),
        artifact: z.object({
          attempts: z.number().int().nonnegative(),
          itemCount: z.number().int().nonnegative(),
          output: z.unknown(),
        }).passthrough(),
      }).passthrough().safeParse(parsed);
      if (!checkpoint.success) {
        continue;
      }
      checkpointByStep.set(checkpoint.data.step, {
        step: checkpoint.data.step,
        state: "completed",
        attempts: checkpoint.data.artifact.attempts,
        itemCount: checkpoint.data.artifact.itemCount,
      });
      if (
        checkpoint.data.step === "validate" &&
        Array.isArray(checkpoint.data.artifact.output)
      ) {
        for (const output of checkpoint.data.artifact.output) {
          const validation = z.object({
            valid: z.boolean(),
            validationErrors: z.array(z.string().min(1)).optional(),
          }).passthrough().safeParse(output);
          if (validation.success && !validation.data.valid) {
            rejectedSummaryReasons.push(
              ...(validation.data.validationErrors ?? ["rejected"]),
            );
          }
        }
      }
    }
    const edition = await this.db
      .prepare(
        `SELECT published_at, metadata_json
        FROM editions
        WHERE run_id = ?
        ORDER BY edition_date DESC
        LIMIT 1`,
      )
      .bind(run.id)
      .first<PublishedRunRow>();
    let sourceFailures: string[] = [];
    if (edition !== null) {
      const metadata = EditionMetadataSchema.safeParse(
        parsedJson(edition.metadata_json, "Invalid run edition metadata"),
      );
      if (metadata.success) {
        sourceFailures = [...metadata.data.sourceFailures];
      }
    }
    const monthlyCost = await this.db
      .prepare(
        `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
        FROM workflow_runs
        WHERE substr(created_at, 1, 7) = substr(?, 1, 7)`,
      )
      .bind(run.createdAt)
      .first<{ total: number }>();
    return validated(
      WorkflowRunDetailSchema,
      {
        ...run,
        checkpoints: [...checkpointByStep.values()],
        failures,
        sourceFailures: uniqueStrings(
          sourceFailures.map((failure) =>
            publicLabel(failure, "REDACTED_SOURCE"),
          ),
        ),
        rejectedSummaryReasons: uniqueStrings(
          rejectedSummaryReasons.map((reason) =>
            publicLabel(reason, "REDACTED_REJECTION"),
          ),
        ),
        publishedAt: edition?.published_at ?? null,
        estimatedMonthlyCostUsd: monthlyCost?.total ?? 0,
      },
      "Invalid workflow run detail",
    );
  }

  async pruneExpiredData(now: string): Promise<RetentionReport> {
    const validNow = validated(
      DateTimeSchema,
      now,
      "Invalid retention timestamp",
    );
    const runCutoff = new Date(Date.parse(validNow) - 90 * 24 * 60 * 60 * 1_000).toISOString();
    const diagnosticCutoff = new Date(Date.parse(validNow) - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const [candidateCount, runCount, workflowArtifactCount, eventCount] =
      await this.db.batch([
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
          FROM items
          WHERE expires_at IS NOT NULL
            AND expires_at <= ?
            AND NOT EXISTS (
              SELECT 1
              FROM edition_entries ee
              WHERE ee.item_id = items.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM feedback f WHERE f.item_id = items.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM summaries s WHERE s.item_id = items.id
            )`,
        )
        .bind(validNow),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
          FROM workflow_runs
          WHERE created_at <= ?`,
        )
        .bind(runCutoff),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
          FROM audit_events
          WHERE created_at <= ?
            AND event_type IN (
              'workflow_checkpoint',
              'workflow_attempt',
              'workflow_attempt_failed'
            )`,
        )
        .bind(runCutoff),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
          FROM audit_events
          WHERE created_at <= ? AND event_type = 'diagnostic_log'`,
        )
        .bind(diagnosticCutoff),
      this.db
        .prepare(
          `DELETE FROM items
          WHERE expires_at IS NOT NULL
            AND expires_at <= ?
            AND NOT EXISTS (
              SELECT 1
              FROM edition_entries ee
              WHERE ee.item_id = items.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM feedback f WHERE f.item_id = items.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM summaries s WHERE s.item_id = items.id
            )`,
        )
        .bind(validNow),
      this.db
        .prepare(
          `DELETE FROM audit_events
          WHERE created_at <= ?
            AND event_type IN (
              'workflow_checkpoint',
              'workflow_attempt',
              'workflow_attempt_failed'
            )`,
        )
        .bind(runCutoff),
      this.db
        .prepare(
          `DELETE FROM workflow_runs
          WHERE created_at <= ?`,
        )
        .bind(runCutoff),
      this.db
        .prepare(
          `DELETE FROM audit_events
          WHERE created_at <= ? AND event_type = 'diagnostic_log'`,
        )
        .bind(diagnosticCutoff),
    ]);
    return validated(
      RetentionReportSchema,
      {
        deletedUnselectedCandidates:
          (
            candidateCount?.results[0] as
              | { count: number }
              | undefined
          )?.count ?? 0,
        deletedWorkflowRuns:
          (
            runCount?.results[0] as
              | { count: number }
              | undefined
          )?.count ?? 0,
        deletedWorkflowArtifacts:
          (
            workflowArtifactCount?.results[0] as
              | { count: number }
              | undefined
          )?.count ?? 0,
        deletedDiagnosticLogs:
          (
            eventCount?.results[0] as
              | { count: number }
              | undefined
          )?.count ?? 0,
      },
      "Invalid retention report",
    );
  }

  async recordModelUsage(runId: string, usage: ModelUsageRecord): Promise<void> {
    const validRunId = validated(NonemptyIdSchema, runId, "Invalid model usage run ID");
    const validUsage = validated(ModelUsageRecordSchema, usage, "Invalid model usage");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), validRunId, "model_usage", JSON.stringify(validUsage), createdAt, expiresAt,
      ),
      this.db.prepare(
        `UPDATE workflow_runs
         SET estimated_cost_usd = estimated_cost_usd + ?, updated_at = ?
         WHERE id = ?`,
      ).bind(validUsage.estimatedCostUsd, createdAt, validRunId),
    ]);
  }

  async listMonthlyModelUsage(monthStart: string): Promise<readonly ModelUsageRecord[]> {
    const validMonthStart = validated(DateTimeSchema, monthStart, "Invalid model usage month start");
    const records = await this.db.prepare(
      `SELECT event_json FROM audit_events
       WHERE event_type = ? AND created_at >= ? ORDER BY created_at, id`,
    ).bind("model_usage", validMonthStart).all<{ event_json: string }>();
    return records.results.map((record) => validated(
      ModelUsageRecordSchema,
      parsedJson(record.event_json, "Invalid model usage record"),
      "Invalid model usage record",
    ));
  }

  async recordRetentionAudit(now: string, report: RetentionReport): Promise<void> {
    const createdAt = validated(DateTimeSchema, now, "Invalid retention audit timestamp");
    const validReport = validated(RetentionReportSchema, report, "Invalid retention audit report");
    const expiresAt = new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
    await this.db.prepare(
      `INSERT INTO audit_events (id, run_id, event_type, event_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), null, "retention_pruned", JSON.stringify(validReport), createdAt, expiresAt,
    ).run();
  }

  private async sourceById(id: string): Promise<SourceRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM sources WHERE id = ?")
      .bind(id)
      .first<SourceRow>();
    return row === null ? null : sourceFromRow(row);
  }

  private async preferenceRow(): Promise<PreferencesRow> {
    const row = await this.db
      .prepare(
        `SELECT
          topic_weights_json,
          source_weights_json,
          institution_weights_json,
          section_budgets_json
        FROM preferences
        WHERE id = ?`,
      )
      .bind("reader")
      .first<PreferencesRow>();
    if (row === null) {
      throw new RepositoryValidationError(
        "Reader preference row is missing",
      );
    }
    return row;
  }

  private async editionWithEntries(
    row: EditionRow,
  ): Promise<EditionWithEntries> {
    const entryRows = await this.db
      .prepare(
        `SELECT
          ee.id,
          ee.edition_id,
          ee.item_id,
          ee.section,
          ee.position,
          s.structured_json,
          ee.selection_reasons_json,
          ee.source_refs_json
        FROM edition_entries ee
        JOIN summaries s ON s.id = ee.summary_id
        WHERE ee.edition_id = ?
        ORDER BY ee.section, ee.position, ee.id`,
      )
      .bind(row.id)
      .all<EntryRow>();
    return validated(
      EditionWithEntriesSchema,
      {
        ...editionFromRow(row),
        entries: entryRows.results.map(entryFromRow),
      },
      "Invalid edition with entries",
    );
  }
}
