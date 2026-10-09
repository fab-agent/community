-- Discussions (topics) and signed messages. Apply once to an existing database:
--   npx wrangler@4 d1 execute <db> --remote --file migrations/0003_topics_signatures.sql
ALTER TABLE members ADD COLUMN pubkey TEXT;
ALTER TABLE messages ADD COLUMN topic_id INTEGER;
ALTER TABLE messages ADD COLUMN ts INTEGER;
ALTER TABLE messages ADD COLUMN nonce TEXT;
ALTER TABLE messages ADD COLUMN sig TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_nonce ON messages(from_id, nonce) WHERE nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_topic ON messages(topic_id, id);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
