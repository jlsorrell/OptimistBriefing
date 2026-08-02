CREATE TABLE IF NOT EXISTS discovery_observations (
  run_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  discovery_family TEXT NOT NULL CHECK (
    discovery_family IN ('arxiv', 'bibliographic', 'official-publication', 'commentary')
  ),
  window_kind TEXT NOT NULL CHECK (window_kind IN ('fresh', 'reconsideration')),
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  joined_external_ids_json TEXT NOT NULL,
  route TEXT NOT NULL CHECK (
    route IN ('research', 'technology', 'ai_policy', 'excluded')
  ),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (run_id, canonical_id, source_id, evidence_fingerprint)
);

CREATE TABLE IF NOT EXISTS research_assessment_cache (
  canonical_id TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  assessment_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (canonical_id, evidence_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_discovery_observations_observed_at
  ON discovery_observations (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_canonical_id
  ON discovery_observations (canonical_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_run_id
  ON discovery_observations (run_id);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_expires_at
  ON discovery_observations (expires_at);
CREATE INDEX IF NOT EXISTS idx_research_assessment_cache_expires_at
  ON research_assessment_cache (expires_at);
