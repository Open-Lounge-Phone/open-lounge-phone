-- Call me back (docs/workplace.md "Public lines"): a caller waiting in a public line's queue may
-- hang up and keep their place; when it's their turn the line calls them back. All additive.

-- Per line: offer it (on by default), and what a missed call back does ('retry' = one more try
-- at the end of the line, then a voicemail offer; 'voicemail' = the offer at once).
ALTER TABLE public_lines ADD COLUMN callback INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public_lines ADD COLUMN callback_missed TEXT NOT NULL DEFAULT 'retry';

-- The line's side: callers who asked to be called back, holding their place (`since`).
-- `id` is the call they waited under. `host` '' = this server (any space here). While the line
-- calls them back, `ringing_until` is set; the row goes when they call in, are missed for the
-- last time, or `expires_at` passes.
CREATE TABLE line_callbacks (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES ring_groups(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  since INTEGER NOT NULL,
  host TEXT NOT NULL,
  account_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ringing_until INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX line_callbacks_group ON line_callbacks(group_id, since);
CREATE INDEX line_callbacks_space ON line_callbacks(household_id);

-- The caller's side: a call back this person asked a line for. Only a line holding one of
-- these may ring them without a connection (default deny), and only until it expires.
CREATE TABLE line_callback_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  line_host TEXT NOT NULL,
  line_handle TEXT NOT NULL,
  line_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX line_callback_grants_account ON line_callback_grants(account_id);
