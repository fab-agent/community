CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  department TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  revoked INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  pubkey TEXT,
  enc_pubkey TEXT,
  enc_sig TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  topic_id INTEGER,
  ts INTEGER,
  nonce TEXT,
  sig TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_id, id);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_nonce ON messages(from_id, nonce) WHERE nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_topic ON messages(topic_id, id);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  private INTEGER NOT NULL DEFAULT 0,
  bundle_sig TEXT
);
CREATE TABLE IF NOT EXISTS topic_members (
  topic_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  wrap TEXT NOT NULL,
  PRIMARY KEY (topic_id, member_id)
);
