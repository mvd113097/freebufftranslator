-- Novel Translator worker — D1 schema.
-- MUST match the column names used in src/worker.ts exactly.
-- Run once per deployment: bun run db:init (remote) or bun run db:init:local (dev)

DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS key_hits;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  model TEXT NOT NULL,
  keys_json TEXT NOT NULL,                     -- JSON array of OpenRouter keys
  status TEXT NOT NULL DEFAULT 'active',       -- active | done | cancelled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  telegram_bot_token TEXT,
  telegram_chat_id TEXT,
  telegram_on_start INTEGER NOT NULL DEFAULT 1,
  telegram_on_progress INTEGER NOT NULL DEFAULT 1,
  telegram_on_error INTEGER NOT NULL DEFAULT 1,
  telegram_on_complete INTEGER NOT NULL DEFAULT 1,
  last_milestone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- rowid used by the cron claim query
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                        -- chunk order in the original book
  text TEXT NOT NULL,                          -- source text (plain, or base64 gzip when the client flags it)
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | translating | completed | failed
  translated_text TEXT,
  model_used TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_chunks_job_seq ON chunks (job_id, seq);
CREATE INDEX idx_chunks_status ON chunks (status, updated_at);
