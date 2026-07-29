PRAGMA foreign_keys = ON;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  trust_prior REAL NOT NULL DEFAULT 0.5,
  enabled INTEGER NOT NULL DEFAULT 1,
  restrictions_json TEXT NOT NULL DEFAULT '{}',
  last_success_at TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown'
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published_at TEXT,
  content_access_level TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE item_sources (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  role TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  PRIMARY KEY (item_id, source_id)
);

CREATE TABLE paper_metadata (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  doi TEXT,
  venue TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]',
  institutions_json TEXT NOT NULL DEFAULT '[]',
  author_search TEXT NOT NULL DEFAULT '',
  institution_search TEXT NOT NULL DEFAULT ''
);

CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  representative_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  cluster_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE scores (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  topical_fit REAL NOT NULL,
  technical_quality REAL NOT NULL,
  research_signal REAL NOT NULL,
  novelty REAL NOT NULL,
  serious_attention REAL NOT NULL,
  total REAL NOT NULL,
  selection_reasons_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  one_sentence TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  uncertainty TEXT NOT NULL,
  access_level TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE summary_claims (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  evidence_excerpt TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  UNIQUE (summary_id, position)
);

CREATE TABLE editions (
  id TEXT PRIMARY KEY,
  edition_date TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','partial','failed')),
  reading_minutes INTEGER,
  published_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE edition_entries (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE RESTRICT,
  summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE RESTRICT,
  section TEXT NOT NULL,
  position INTEGER NOT NULL,
  selection_reasons_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  UNIQUE (edition_id, section, position)
);

CREATE TABLE preferences (
  id TEXT PRIMARY KEY,
  topic_weights_json TEXT NOT NULL DEFAULT '{}',
  source_weights_json TEXT NOT NULL DEFAULT '{}',
  institution_weights_json TEXT NOT NULL DEFAULT '{}',
  section_budgets_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  edition_date TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX idx_editions_date
  ON editions (edition_date DESC);
CREATE INDEX idx_items_published_at
  ON items (published_at DESC);
CREATE INDEX idx_sources_health
  ON sources (health_status, enabled);
CREATE INDEX idx_edition_entries_section_position
  ON edition_entries (edition_id, section, position);
CREATE INDEX idx_workflow_runs_status
  ON workflow_runs (status, updated_at DESC);
CREATE INDEX idx_feedback_created_at
  ON feedback (created_at, id);
CREATE INDEX idx_item_sources_source
  ON item_sources (source_id, item_id);
CREATE INDEX idx_items_expires_at
  ON items (expires_at);
CREATE INDEX idx_workflow_runs_expires_at
  ON workflow_runs (expires_at);
CREATE INDEX idx_audit_events_expires_at
  ON audit_events (expires_at);

CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id UNINDEXED,
  title,
  normalized_text
);

CREATE TRIGGER items_fts_insert
AFTER INSERT ON items
BEGIN
  INSERT INTO items_fts (item_id, title, normalized_text)
  VALUES (
    new.id,
    new.title,
    json_extract(new.normalized_json, '$.normalizedText')
  );
END;

CREATE TRIGGER items_fts_update
AFTER UPDATE OF title, normalized_json ON items
BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
  INSERT INTO items_fts (item_id, title, normalized_text)
  VALUES (
    new.id,
    new.title,
    json_extract(new.normalized_json, '$.normalizedText')
  );
END;

CREATE TRIGGER items_fts_delete
AFTER DELETE ON items
BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
END;

CREATE TRIGGER edition_entries_insert_draft_only
BEFORE INSERT ON edition_entries
WHEN (SELECT status FROM editions WHERE id = new.edition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'edition entries are immutable after publication');
END;

CREATE TRIGGER edition_entries_update_draft_only
BEFORE UPDATE ON edition_entries
WHEN (SELECT status FROM editions WHERE id = old.edition_id) <> 'draft'
  OR (SELECT status FROM editions WHERE id = new.edition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'edition entries are immutable after publication');
END;

CREATE TRIGGER edition_entries_delete_draft_only
BEFORE DELETE ON edition_entries
WHEN (SELECT status FROM editions WHERE id = old.edition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'edition entries are immutable after publication');
END;

INSERT INTO preferences (
  id,
  topic_weights_json,
  source_weights_json,
  institution_weights_json,
  section_budgets_json,
  updated_at
) VALUES ('reader', '{}', '{}', '{}', '{}', '1970-01-01T00:00:00.000Z');
