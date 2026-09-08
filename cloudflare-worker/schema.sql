-- Novel Translator worker — D1 schema.
-- Run once per deployment: bun run db:init (remote) or bun run db:init:local (dev)

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active | done | cancelled
  model TEXT NOT NULL,
  keys TEXT NOT NULL,                          -- JSON array of OpenRouter keys
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  failed_chunks INTEGER NOT NULL DEFAULT 0,
  active_model TEXT,
  telegram_bot_token TEXT,
  telegram_chat_id TEXT,
  telegram_notify_on_start INTEGER NOT NULL DEFAULT 1,
  telegram_notify_on_progress INTEGER NOT NULL DEFAULT 1,
  telegram_notify_on_error INTEGER NOT NULL DEFAULT 1,
  telegram_notify_on_complete INTEGER NOT NULL DEFAULT 1,
  telegram_status_interval INTEGER NOT NULL DEFAULT 0,
  last_status_notify_at INTEGER NOT NULL DEFAULT 0,
  notified_start INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  job_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | processing | completed | failed
  source_text TEXT NOT NULL,                   -- plain text, or base64 gzip when source_gzip = 1
  source_gzip INTEGER NOT NULL DEFAULT 0,
  translated_text TEXT NOT NULL DEFAULT '',
  retries INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  used_model TEXT,
  processing_since INTEGER,
  PRIMARY KEY (job_id, id)
);

-- Rolling per-key request window (RPM limiting across worker invocations).
CREATE TABLE IF NOT EXISTS key_hits (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_key_hits_key_ts ON key_hits (key, ts);
