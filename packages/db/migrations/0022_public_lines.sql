-- Public lines (docs/workplace.md): a team or org ring group published at its own address
-- `handle@host`, which people on other servers may call without connecting first. All additive.

-- One row per ring group that has (or had) a line. The handle shares the namespace of account
-- and room handles and stays reserved while the row exists, even with the line turned off.
-- `allow` (JSON array of servers and addresses) is used when `who` = 'allowlist'; `at_max_wait`
-- is JSON ({kind: voicemail | group | user | end, ...}); NULL limits = the server's.
CREATE TABLE public_lines (
  group_id TEXT PRIMARY KEY REFERENCES ring_groups(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  description TEXT,
  who TEXT NOT NULL DEFAULT 'anyone' CHECK (who IN ('anyone', 'connections', 'allowlist')),
  allow TEXT,
  queue INTEGER NOT NULL DEFAULT 1,
  queue_max INTEGER NOT NULL DEFAULT 10,
  queue_wait_s INTEGER NOT NULL DEFAULT 600,
  show_position INTEGER NOT NULL DEFAULT 1,
  offer_voicemail INTEGER NOT NULL DEFAULT 1,
  at_max_wait TEXT,
  voicemail INTEGER NOT NULL DEFAULT 1,
  caller_per_hour INTEGER,
  server_per_hour INTEGER,
  greeting_kind TEXT CHECK (greeting_kind IN ('name', 'custom')),
  greeting_mime TEXT,
  greeting_blob TEXT,
  greeting_ms INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX public_lines_space ON public_lines(household_id);

-- A team/org space's blocklist for its public lines: a caller's address or a whole server.
CREATE TABLE line_blocks (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('address', 'server')),
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, kind, value)
);

-- Recent callers of a line (verified address, name, outcome), for admins to see and block.
-- The store keeps the newest rows per line only; the space's history sweep removes old ones.
CREATE TABLE line_callers (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES ring_groups(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  host TEXT NOT NULL,
  name TEXT NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX line_callers_group ON line_callers(group_id, at);
CREATE INDEX line_callers_space ON line_callers(household_id, at);

-- A public line (by address) on a personal phone's speed-dial keys. Never on a kids' phone.
CREATE TABLE line_contacts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE (device_id, address)
);

CREATE TABLE line_buttons (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 15),
  line_contact_id TEXT NOT NULL REFERENCES line_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);
