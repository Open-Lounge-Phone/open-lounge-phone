-- Lounge phones: shared phones that a household member takes over from the companion app
-- (scan the phone's code, press the key it flashes). Sessions are ephemeral: the phone forgets
-- everything when one ends; only the fact that it happened is kept, for guardians.
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'kids' CHECK (kind IN ('kids', 'lounge'));
-- The kind the phone chose on its first-run screen, until a guardian claims the code.
ALTER TABLE pairings ADD COLUMN kind TEXT;
-- Minutes a Lounge phone may sit hung up and unused before its session ends.
ALTER TABLE households ADD COLUMN lounge_idle_minutes INTEGER NOT NULL DEFAULT 10;

CREATE TABLE lounge_sessions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX lounge_sessions_household ON lounge_sessions(household_id, started_at);
