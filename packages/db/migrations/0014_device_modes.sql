-- Device modes and lifecycle (docs/device-lifecycle.md). All additive; existing spaces keep
-- today's behaviour (idle timeout, everything optional off).
--
-- A phone's mode is derived: `lounge` = devices.kind 'lounge'; `personal` = owner_user_id set;
-- `kids` = neither. A phone set up as "personal" says so in pairings.kind (no CHECK there).

-- How long a Lounge session lasts in this space: 'idle' = ends after lounge_idle_minutes hung up
-- and unused (the default, as before); 'end_of_day' = ends at lounge_day_end, local time;
-- 'until_logout' = only logout, leave, a new takeover or a disconnect end it.
ALTER TABLE households ADD COLUMN lounge_session TEXT NOT NULL DEFAULT 'idle'
  CHECK (lounge_session IN ('idle', 'end_of_day', 'until_logout'));
ALTER TABLE households ADD COLUMN lounge_day_end TEXT NOT NULL DEFAULT '00:00';
-- What an idle Lounge phone (nobody signed in) offers, as JSON: house-line keys and "who's
-- here". NULL = nothing (the default: dead until someone signs in).
ALTER TABLE households ADD COLUMN lounge_idle TEXT;

-- Phones removed in the app. The server forgot them, but when one connects again and proves it
-- still holds the removed key, it is told to wipe itself; then the row goes.
CREATE TABLE removed_devices (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  key_alg TEXT NOT NULL DEFAULT 'ed25519',
  removed_at INTEGER NOT NULL
);
CREATE INDEX removed_devices_at ON removed_devices(removed_at);
