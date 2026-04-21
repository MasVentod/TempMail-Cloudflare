CREATE TABLE IF NOT EXISTS api_webhooks (
  user_id TEXT PRIMARY KEY,
  webhook_url TEXT NOT NULL,
  webhook_secret TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_status_code INTEGER,
  last_error TEXT,
  FOREIGN KEY (user_id) REFERENCES api_access(user_id)
);

CREATE INDEX IF NOT EXISTS idx_api_webhooks_active
  ON api_webhooks (is_active, updated_at DESC);
