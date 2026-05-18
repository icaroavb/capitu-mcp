// 512 dims — Voyage voyage-3-lite native output. Other valid setups:
//   - Voyage with output_dimension=384 (matches Xenova/all-MiniLM-L6-v2)
//   - OpenAI text-embedding-3-small truncated to 512
// Whichever provider is configured at runtime, its .dim must equal this constant
// or insertDoc/insertLearning will throw. To switch dims, re-index from scratch.
export const EMBEDDING_DIM = 512;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  release TEXT,
  url TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_meta TEXT,
  indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_docs_source_release ON docs(source, release);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts
  USING fts5(content, content=docs, content_rowid=id, tokenize='porter unicode61');

CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec
  USING vec0(embedding float[${EMBEDDING_DIM}]);

CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('error-fix','pattern','decision','gotcha')),
  context TEXT,
  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  validated_at TIMESTAMP,
  source_agent TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_learnings_kind ON learnings(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS learnings_vec
  USING vec0(embedding float[${EMBEDDING_DIM}]);

CREATE TABLE IF NOT EXISTS tenant_catalog (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  release_contract TEXT,
  metadata TEXT,
  refreshed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type, name)
);
CREATE INDEX IF NOT EXISTS idx_tenant_catalog_type ON tenant_catalog(type);

CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT,
  output TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('ok','error'))
);
CREATE INDEX IF NOT EXISTS idx_traces_agent_ts ON traces(agent, ts);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spec_proposals (
  token TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  target_package TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','applied','cancelled','partial')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  applied_at TIMESTAMP,
  applied_log TEXT
);
CREATE INDEX IF NOT EXISTS idx_spec_proposals_status ON spec_proposals(status);
`;

export const SCHEMA_VERSION = 1;
