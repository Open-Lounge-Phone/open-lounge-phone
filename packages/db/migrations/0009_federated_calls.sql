-- P3 (federation F2): federated calls, presence, phones shared with connections, Lounge guests.

-- "Share my availability with connections" (off by default).
ALTER TABLE accounts ADD COLUMN share_presence INTEGER NOT NULL DEFAULT 0;

-- Last presence a connection shared with us (only if they opted in).
ALTER TABLE connections ADD COLUMN presence_online INTEGER;
ALTER TABLE connections ADD COLUMN presence_available INTEGER;
ALTER TABLE connections ADD COLUMN presence_at INTEGER;

-- Phones in another household (or on another server) that a connection lets us call: the other
-- side's guardian put us on the phone's allow-list. `device_id` is the phone's id over there.
CREATE TABLE connection_phones (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (connection_id, device_id)
);

-- Whether people from other servers may take over this space's Lounge phones (their home server
-- vouches for them; the key press still proves they're at the phone). Off by default.
ALTER TABLE households ADD COLUMN lounge_guests INTEGER NOT NULL DEFAULT 0;

-- Lounge sessions can now belong to a guest from another server (no local membership).
CREATE TABLE lounge_sessions_v2 (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  guest_address TEXT,
  guest_name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  open_to_chat INTEGER NOT NULL DEFAULT 0,
  offline_at INTEGER,
  CHECK ((user_id IS NULL) <> (guest_address IS NULL))
);
INSERT INTO lounge_sessions_v2 (id, household_id, device_id, user_id, started_at, ended_at,
  end_reason, open_to_chat, offline_at)
SELECT id, household_id, device_id, user_id, started_at, ended_at, end_reason, open_to_chat,
  offline_at FROM lounge_sessions;
DROP TABLE lounge_sessions;
ALTER TABLE lounge_sessions_v2 RENAME TO lounge_sessions;
CREATE INDEX lounge_sessions_household ON lounge_sessions(household_id, started_at);

-- This server vouched for one of its accounts at another server's Lounge phone: while `active`,
-- that server may ask us to place calls as them (their key presses there).
CREATE TABLE lounge_away (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  device_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'ended')),
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (account_id, host, device_id)
);
