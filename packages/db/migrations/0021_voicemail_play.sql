-- A phone can play its owner's voicemail: a third ticket purpose, `play` (one message's audio,
-- single use, 10 minutes). SQLite can't change a CHECK constraint, so the table is rebuilt with
-- its rows (tickets live 10 minutes; nothing else refers to it).
CREATE TABLE voicemail_tickets_new (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('voicemail', 'greeting', 'play')),
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT INTO voicemail_tickets_new (token_hash, purpose, data, expires_at)
  SELECT token_hash, purpose, data, expires_at FROM voicemail_tickets;
DROP TABLE voicemail_tickets;
ALTER TABLE voicemail_tickets_new RENAME TO voicemail_tickets;
CREATE INDEX voicemail_tickets_expiry ON voicemail_tickets(expires_at);
