-- P4: running a public hub. All additive.

-- Metered use per account per calendar month (UTC, 'YYYY-MM'), for the fair-use allowance.
-- A new month is simply a new row, so the allowance resets by itself.
CREATE TABLE usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  call_minutes INTEGER NOT NULL DEFAULT 0,
  voicemails INTEGER NOT NULL DEFAULT 0,
  voicemail_bytes INTEGER NOT NULL DEFAULT 0,
  knocks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

-- Operator actions: a suspended account can't sign in, call or be reached; an exempt one (e.g. a
-- venue) isn't held to the fair-use allowance.
ALTER TABLE accounts ADD COLUMN suspended_at INTEGER;
ALTER TABLE accounts ADD COLUMN fair_use_exempt INTEGER NOT NULL DEFAULT 0;

-- One row per party on this server per call, written when the call ends (local and federated
-- calls). The base for a per-connection ("buddy") timeline, hence the (account, peer) index.
-- `peer` is the other side: `handle@host` for someone elsewhere, `user:<id>` or `device:<id>`
-- here. `account_id` is null for a household phone's own log (`device_id` set).
CREATE TABLE call_log (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  peer TEXT NOT NULL,
  peer_label TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  started_at INTEGER NOT NULL,
  answered INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,
  voicemail_id TEXT REFERENCES voicemails(id) ON DELETE SET NULL,
  expires_at INTEGER
);
CREATE INDEX call_log_peer ON call_log(account_id, peer, started_at);
CREATE INDEX call_log_space ON call_log(household_id, started_at);
