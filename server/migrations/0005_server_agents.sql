-- Server Agents: member kind + policy, invite kind + policy, signed via/at labels on messages.
ALTER TABLE members ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE members ADD COLUMN policy TEXT NOT NULL DEFAULT '';
ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE invites ADD COLUMN policy TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN via TEXT;
ALTER TABLE messages ADD COLUMN at TEXT;
