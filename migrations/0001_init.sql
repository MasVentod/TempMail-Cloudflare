PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inboxes (
  alias TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_message_at TEXT,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_inboxes_chat_id
  ON inboxes (chat_id, is_active, expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  alias TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_address TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  text_body TEXT,
  html_body TEXT,
  raw_size INTEGER,
  sender_message_id TEXT,
  headers_json TEXT,
  received_at TEXT NOT NULL,
  telegram_notified_at TEXT,
  FOREIGN KEY (alias) REFERENCES inboxes(alias),
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_alias_received_at
  ON messages (alias, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id_received_at
  ON messages (chat_id, received_at DESC);
