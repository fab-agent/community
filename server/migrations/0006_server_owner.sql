-- A server agent is the responsibility of the admin who invited it.
ALTER TABLE members ADD COLUMN owner_id TEXT;
