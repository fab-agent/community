-- Roles and single-use invites. Apply once to databases created before this migration.
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
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
