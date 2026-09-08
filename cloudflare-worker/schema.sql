-- Cloudflare D1 schema for the translation queue.
-- Apply with: npx wrangler d1 execute novel-translator --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  model TEXT NOT NULL,
  keys_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | done | cancelled
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

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,                      -- original Chinese chunk
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | translating | completed | failed
  translated_text TEXT,
  model_used TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_job_seq ON chunks (job_id, seq);
CREATE INDEX IF NOT EXISTS idx_chunks_claim ON chunks (status, job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at);
