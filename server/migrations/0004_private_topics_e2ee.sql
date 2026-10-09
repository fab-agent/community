-- Private (end-to-end encrypted) topics and per-device encryption keys. Apply once:
--   npx wrangler@4 d1 execute <db> --remote --file migrations/0004_private_topics_e2ee.sql
ALTER TABLE members ADD COLUMN enc_pubkey TEXT;
ALTER TABLE members ADD COLUMN enc_sig TEXT;
ALTER TABLE topics ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN bundle_sig TEXT;
CREATE TABLE IF NOT EXISTS topic_members (
  topic_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  wrap TEXT NOT NULL,
  PRIMARY KEY (topic_id, member_id)
);
