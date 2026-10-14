-- Accounts, sign-in and recovery (server 0.5.0). Additive: new nullable or defaulted columns,
-- backfilled here, and indexes.

-- One recovery code per account: only its hash is kept (see packages/core accounts.ts). Null =
-- the account has no code (yet, or it was just used).
ALTER TABLE accounts ADD COLUMN recovery_hash TEXT;
ALTER TABLE accounts ADD COLUMN recovery_created_at INTEGER;

-- Sessions get a public id (the session list names them by it, never by the token's hash), a
-- label ("Chrome on Mac"), when they were last used (they slide: see SESSION_IDLE_MS), how they
-- started, whether a passkey backs them (only those slide), and `limited` for a session from a
-- recovery code, which may only add a passkey.
ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN label TEXT;
ALTER TABLE sessions ADD COLUMN last_used_at INTEGER;
ALTER TABLE sessions ADD COLUMN via TEXT;
ALTER TABLE sessions ADD COLUMN passkey INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN limited INTEGER NOT NULL DEFAULT 0;
-- Existing sessions: how they started is unknown; a session of an account with a passkey counts
-- as backed by one (it keeps sliding), others end on their current date.
UPDATE sessions SET
  id = 'ses_' || lower(hex(randomblob(12))),
  last_used_at = created_at,
  passkey = CASE WHEN EXISTS (SELECT 1 FROM passkeys p WHERE p.account_id = sessions.account_id)
    THEN 1 ELSE 0 END;
CREATE UNIQUE INDEX sessions_id ON sessions(id);

-- Every space has an owner (a membership): homes too. NULL = its founder (the first guardian,
-- who made it); handing it on writes the new owner here. Existing spaces get the owner the server
-- derived until now written down.
ALTER TABLE households ADD COLUMN owner_user TEXT;
UPDATE households SET owner_user = (
  SELECT u.id FROM users u WHERE u.household_id = households.id AND u.role = 'guardian'
  ORDER BY u.created_at, u.rowid LIMIT 1
);

-- Invites and sign-in links get a public id, so guardians can list and cancel them.
ALTER TABLE invites ADD COLUMN id TEXT;
UPDATE invites SET id = 'inv_' || lower(hex(randomblob(12)));
CREATE UNIQUE INDEX invites_id ON invites(id);
CREATE INDEX invites_user ON invites(user_id);
