import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  EditionWithEntriesSchema,
  type EditionEntry,
  type EditionSection,
  type EditionWithEntries,
  type Item,
  type SourceRef,
  type StructuredSummary,
} from "../src/contracts/editorial";

const CREATED_AT = "2026-07-29T09:30:00.000Z";
const PUBLISHED_AT = "2026-07-29T09:45:00.000Z";
const RETRIEVED_AT = "2026-07-29T08:30:00.000Z";
const EDITION_ID = "edition-2026-07-29";

const sources = {
  arxiv: source(
    "source-arxiv-featured",
    "arXiv",
    "https://arxiv.org/abs/2607.01234",
    "primary",
  ),
  researchBlog: source(
    "source-research-blog",
    "Anthropic research commentary",
    "https://www.anthropic.com/research/fixture-concepts",
    "blog",
  ),
  radar: source(
    "source-arxiv-radar",
    "arXiv",
    "https://arxiv.org/abs/2607.05678",
    "primary",
  ),
  reutersWorld: source(
    "source-reuters-world",
    "Reuters",
    "https://www.reuters.com/world/fixture-diplomacy",
    "reporting",
  ),
  apWorld: source(
    "source-ap-world",
    "Associated Press",
    "https://apnews.com/article/fixture-diplomacy",
    "reporting",
  ),
  policyDocument: source(
    "source-policy-document",
    "NIST evaluation guidance",
    "https://www.nist.gov/publications/fixture-ai-evaluations",
    "primary",
  ),
  reutersPolicy: source(
    "source-reuters-policy",
    "Reuters",
    "https://www.reuters.com/technology/artificial-intelligence/fixture-policy",
    "reporting",
  ),
  wtop: source(
    "source-wtop",
    "WTOP",
    "https://wtop.com/local/fixture-transit",
    "reporting",
  ),
  banner: source(
    "source-baltimore-banner",
    "The Baltimore Banner",
    "https://www.thebaltimorebanner.com/fixture-housing",
    "reporting",
  ),
  polymarket: source(
    "source-polymarket",
    "Polymarket",
    "https://polymarket.com/event/fixture-ai-bill",
    "forecast",
  ),
} as const;

function source(
  id: string,
  name: string,
  url: string,
  role: SourceRef["role"],
): SourceRef {
  return { id, name, url, role, retrievedAt: RETRIEVED_AT };
}

function summary(
  title: string,
  oneSentence: string,
  whyItMatters: string,
  uncertainty: string,
  sourceRefs: readonly SourceRef[],
  accessLevel: StructuredSummary["accessLevel"] = "full_text",
  claimTexts: readonly string[] = [oneSentence],
): StructuredSummary {
  return {
    title,
    oneSentence,
    whyItMatters,
    uncertainty,
    accessLevel,
    claims: claimTexts.map((text, index) => ({
      text,
      sourceIds: [sourceRefs[index % sourceRefs.length]?.id ?? sourceRefs[0]?.id ?? ""],
      evidenceExcerpt: `Fixture evidence ${index + 1}: ${text}`,
    })),
  };
}

function entry(
  id: string,
  itemId: string | null,
  section: EditionSection,
  position: number,
  entrySummary: StructuredSummary,
  sourceRefs: readonly SourceRef[],
  selectionReasons: readonly string[],
): EditionEntry {
  return {
    id,
    editionId: EDITION_ID,
    itemId,
    section,
    position,
    summary: entrySummary,
    sourceRefs: [...sourceRefs],
    selectionReasons: [...selectionReasons],
  };
}

export function fixtureEdition(): EditionWithEntries {
  const featuredSources = [sources.arxiv, sources.researchBlog] as const;
  const worldSources = [sources.reutersWorld, sources.apWorld] as const;
  const policySources = [sources.policyDocument, sources.reutersPolicy] as const;

  return EditionWithEntriesSchema.parse({
    id: EDITION_ID,
    editionDate: "2026-07-29",
    runId: "run-dev-fixture",
    status: "published",
    readingMinutes: 24,
    publishedAt: PUBLISHED_AT,
    createdAt: CREATED_AT,
    entries: [
      entry(
        "entry-brief-research",
        "item-featured-paper",
        "morning_brief",
        0,
        summary(
          "Concept representations become legible mid-training",
          "A new paper maps when a durable concept representation appears across language-model checkpoints.",
          "It gives interpretability researchers a testable picture of how internal representations form.",
          "The result currently covers a narrow family of models and synthetic tasks.",
          featuredSources,
          "abstract",
        ),
        featuredSources,
        ["Direct fit with representation-evolution research"],
      ),
      entry(
        "entry-brief-world",
        "item-world-cluster",
        "morning_brief",
        1,
        summary(
          "Negotiators reopen a narrow diplomatic channel",
          "Two independent reports describe a limited agreement to resume technical talks.",
          "Even a narrow channel could reduce near-term escalation risk.",
          "The timetable and scope remain unsettled.",
          worldSources,
        ),
        worldSources,
        ["Consequential and independently corroborated"],
      ),
      entry(
        "entry-brief-policy",
        "item-policy-cluster",
        "morning_brief",
        2,
        summary(
          "NIST proposes a secure model-evaluation profile",
          "Draft guidance adds provenance and tamper-evidence requirements to high-risk model evaluations.",
          "The proposal connects secure systems work directly to AI oversight practice.",
          "The guidance is a draft and implementation details may change.",
          policySources,
        ),
        policySources,
        ["Primary document with direct relevance to secure evaluation"],
      ),
      entry(
        "entry-featured-paper",
        "item-featured-paper",
        "research",
        0,
        summary(
          "Tracing concept formation across training",
          "The authors identify a repeatable transition where a latent concept becomes linearly accessible and behaviorally useful.",
          "The method could help distinguish genuinely learned concepts from artifacts of final-checkpoint probing.",
          "The evidence is abstract-only, uses small model families, and does not establish causal control.",
          featuredSources,
          "abstract",
          [
            "Probe accuracy rises sharply at the same checkpoint across three training runs.",
            "A companion analysis finds the same transition with a different probe family.",
          ],
        ),
        featuredSources,
        [
          "Strong topical fit for internal representations",
          "Clear empirical claim with independent technical commentary",
        ],
      ),
      entry(
        "entry-radar-paper",
        "item-radar-paper",
        "research_radar",
        0,
        summary(
          "A game-theoretic model of debate incentives",
          "A short theory paper characterizes when debate rewards truthful disclosure under asymmetric information.",
          "The model may clarify which assumptions practical debate protocols need to test.",
          "The equilibrium result depends on stylized judge behavior.",
          [sources.radar],
          "abstract",
        ),
        [sources.radar],
        ["Direct relevance to AI safety via debate"],
      ),
      entry(
        "entry-world-cluster",
        "item-world-cluster",
        "world",
        0,
        summary(
          "Negotiators reopen a narrow diplomatic channel",
          "Officials agreed to restart technical discussions after several weeks of public deadlock.",
          "A working channel lowers the risk of accidental escalation even without a broad settlement.",
          "Neither side has agreed to a final agenda, and talks may still stall.",
          worldSources,
        ),
        worldSources,
        ["Reported independently by Reuters and AP"],
      ),
      entry(
        "entry-policy-cluster",
        "item-policy-cluster",
        "ai_policy",
        0,
        summary(
          "Draft evaluation guidance adds provenance requirements",
          "NIST’s draft asks high-risk evaluations to document model, data, and execution provenance.",
          "The proposal could make secure evaluation frameworks easier to audit across organizations.",
          "The text is non-final and leaves acceptable verification mechanisms open.",
          policySources,
        ),
        policySources,
        ["Primary policy text plus neutral reporting"],
      ),
      entry(
        "entry-dmv",
        "item-dmv-transit",
        "dmv",
        0,
        summary(
          "Regional transit agencies coordinate late-night service",
          "DMV agencies announced a six-month pilot aligning late-night transfers on three busy routes.",
          "The pilot targets a recurring gap for shift workers crossing jurisdictional lines.",
          "Weekend frequency and long-term funding are not yet settled.",
          [sources.wtop],
        ),
        [sources.wtop],
        ["Useful regional service change"],
      ),
      entry(
        "entry-baltimore",
        "item-baltimore-housing",
        "baltimore",
        0,
        summary(
          "Baltimore expands a vacant-home stabilization pilot",
          "The city approved a targeted expansion covering two additional neighborhoods.",
          "The program could stabilize blocks while a larger redevelopment plan is evaluated.",
          "Funding beyond the pilot year remains uncertain.",
          [sources.banner],
        ),
        [sources.banner],
        ["Material Baltimore-specific local development"],
      ),
      entry(
        "entry-forecast",
        "item-forecast-ai-bill",
        "forecast",
        0,
        summary(
          "Market odds rise for a federal AI bill this year",
          "The market-implied probability increased from 31% to 43% over seven days.",
          "The move is a signal that expectations changed, not evidence that legislation will pass.",
          "Forecast markets can be thin and prices may react to short-lived attention.",
          [sources.polymarket],
          "metadata",
        ),
        [sources.polymarket],
        ["Material weekly probability change"],
      ),
    ],
  });
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function itemKind(section: EditionSection): Item["kind"] {
  if (section === "research" || section === "research_radar") return "paper";
  if (section === "ai_policy") return "document";
  if (section === "forecast") return "forecast";
  return "article";
}

export function seedSql(edition = fixtureEdition()): string {
  const sourceById = new Map(
    edition.entries.flatMap((seedEntry) =>
      seedEntry.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef] as const),
    ),
  );
  const itemById = new Map<string, Item>();
  const canonicalEntries = [
    ...edition.entries.filter((seedEntry) => seedEntry.section !== "morning_brief"),
    ...edition.entries.filter((seedEntry) => seedEntry.section === "morning_brief"),
  ];
  for (const seedEntry of canonicalEntries) {
    if (seedEntry.itemId === null || itemById.has(seedEntry.itemId)) continue;
    const canonicalSource = seedEntry.sourceRefs[0];
    if (canonicalSource === undefined) continue;
    itemById.set(seedEntry.itemId, {
      id: seedEntry.itemId,
      kind: itemKind(seedEntry.section),
      canonicalUrl: canonicalSource.url,
      title: seedEntry.summary.title,
      publishedAt: "2026-07-28T18:00:00.000Z",
      sourceRefs: seedEntry.sourceRefs,
      accessLevel: seedEntry.summary.accessLevel,
      primaryTopic: seedEntry.section,
      tags: [seedEntry.section, "development-fixture"],
      normalizedText: seedEntry.summary.oneSentence,
      metadata: {},
      createdAt: CREATED_AT,
      expiresAt: null,
    });
  }

  const statements: string[] = ["PRAGMA foreign_keys = ON", "BEGIN TRANSACTION"];
  for (const sourceRef of sourceById.values()) {
    statements.push(
      `INSERT OR IGNORE INTO sources (
        id, canonical_name, canonical_url, role, trust_prior, enabled,
        restrictions_json, last_success_at, health_status
      ) VALUES (
        ${sqlString(sourceRef.id)}, ${sqlString(sourceRef.name)},
        ${sqlString(sourceRef.url)}, ${sqlString(sourceRef.role)}, 0.8, 1,
        '{}', ${sqlString(RETRIEVED_AT)}, 'healthy'
      )`,
    );
  }
  for (const item of itemById.values()) {
    statements.push(
      `INSERT OR IGNORE INTO items (
        id, kind, canonical_url, title, published_at, content_access_level,
        normalized_json, created_at, expires_at
      ) VALUES (
        ${sqlString(item.id)}, ${sqlString(item.kind)},
        ${sqlString(item.canonicalUrl)}, ${sqlString(item.title)},
        ${sqlString(item.publishedAt ?? "")}, ${sqlString(item.accessLevel)},
        ${sqlString(JSON.stringify(item))}, ${sqlString(item.createdAt)}, NULL
      )`,
    );
    for (const sourceRef of item.sourceRefs) {
      statements.push(
        `INSERT OR IGNORE INTO item_sources (
          item_id, source_id, source_name, source_url, role, retrieved_at
        ) VALUES (
          ${sqlString(item.id)}, ${sqlString(sourceRef.id)},
          ${sqlString(sourceRef.name)}, ${sqlString(sourceRef.url)},
          ${sqlString(sourceRef.role)}, ${sqlString(sourceRef.retrievedAt)}
        )`,
      );
    }
  }
  statements.push(
    `INSERT OR IGNORE INTO editions (
      id, edition_date, run_id, status, reading_minutes, published_at, created_at
    ) VALUES (
      ${sqlString(edition.id)}, ${sqlString(edition.editionDate)},
      ${sqlString(edition.runId)}, 'draft', ${String(edition.readingMinutes)}, NULL,
      ${sqlString(edition.createdAt)}
    )`,
  );
  for (const seedEntry of edition.entries) {
    const summaryId = `edition-entry:${seedEntry.id}`;
    statements.push(
      `INSERT OR IGNORE INTO summaries (
        id, item_id, title, one_sentence, why_it_matters, uncertainty,
        access_level, structured_json, created_at
      ) VALUES (
        ${sqlString(summaryId)},
        ${seedEntry.itemId === null ? "NULL" : sqlString(seedEntry.itemId)},
        ${sqlString(seedEntry.summary.title)},
        ${sqlString(seedEntry.summary.oneSentence)},
        ${sqlString(seedEntry.summary.whyItMatters)},
        ${sqlString(seedEntry.summary.uncertainty)},
        ${sqlString(seedEntry.summary.accessLevel)},
        ${sqlString(JSON.stringify(seedEntry.summary))},
        ${sqlString(CREATED_AT)}
      )`,
    );
    for (const [claimPosition, claim] of seedEntry.summary.claims.entries()) {
      statements.push(
        `INSERT OR IGNORE INTO summary_claims (
          id, summary_id, position, text, evidence_excerpt, source_ids_json
        ) VALUES (
          ${sqlString(`${summaryId}:claim:${claimPosition}`)},
          ${sqlString(summaryId)}, ${String(claimPosition)}, ${sqlString(claim.text)},
          ${sqlString(claim.evidenceExcerpt)},
          ${sqlString(JSON.stringify(claim.sourceIds))}
        )`,
      );
    }
    statements.push(
      `INSERT OR IGNORE INTO edition_entries (
        id, edition_id, item_id, summary_id, section, position,
        selection_reasons_json, source_refs_json
      )
      SELECT
        ${sqlString(seedEntry.id)}, ${sqlString(seedEntry.editionId)},
        ${seedEntry.itemId === null ? "NULL" : sqlString(seedEntry.itemId)},
        ${sqlString(summaryId)}, ${sqlString(seedEntry.section)},
        ${String(seedEntry.position)},
        ${sqlString(JSON.stringify(seedEntry.selectionReasons))},
        ${sqlString(JSON.stringify(seedEntry.sourceRefs))}
      WHERE EXISTS (
        SELECT 1 FROM editions
        WHERE id = ${sqlString(edition.id)} AND status = 'draft'
      )`,
    );
  }
  statements.push(
    `UPDATE editions
    SET status = 'published', published_at = ${sqlString(PUBLISHED_AT)}
    WHERE id = ${sqlString(edition.id)} AND status = 'draft'`,
    "COMMIT",
  );
  return `${statements.join(";\n")};\n`;
}

export function seedDevelopmentDatabase(): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "optimist-briefing",
      "--local",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "optimist-briefing",
      "--local",
      `--command=${seedSql()}`,
    ],
    { stdio: "inherit" },
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  seedDevelopmentDatabase();
}
