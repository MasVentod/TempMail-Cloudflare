ALTER TABLE chats ADD COLUMN language TEXT;

CREATE TABLE IF NOT EXISTS api_access (
  user_id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL UNIQUE,
  quota_daily INTEGER NOT NULL DEFAULT 1500,
  quota_used INTEGER NOT NULL DEFAULT 0,
  quota_date TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES chats(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_api_access_api_key
  ON api_access (api_key);

CREATE INDEX IF NOT EXISTS idx_api_access_expires_at
  ON api_access (expires_at, revoked_at);
