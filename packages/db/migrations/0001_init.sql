-- OpenTinCan initial schema. Shared by Cloudflare D1 (wrangler d1 migrations) and self-hosted
-- SQLite. Timestamps are Unix epoch milliseconds. Booleans are 0/1.

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Guardians manage the household; contacts can only call and be called.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('guardian', 'contact')),
  created_at INTEGER NOT NULL
);
CREATE INDEX users_household ON users(household_id);

-- Only SHA-256 hashes of bearer tokens are stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE INDEX devices_household ON devices(household_id);

-- Pending pairing: a device showing `code` until a guardian claims it.
CREATE TABLE pairings (
  code TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- A device's allow-list. Absence of a row means deny.
CREATE TABLE contacts (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  can_call_device INTEGER NOT NULL DEFAULT 0,
  device_can_call INTEGER NOT NULL DEFAULT 0,
  bypass_quiet_hours INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, user_id)
);

CREATE TABLE buttons (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 15),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);

-- Household-wide quiet hours. `days` is a JSON array of weekdays (0 = Sunday).
CREATE TABLE quiet_rules (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  days TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
CREATE INDEX quiet_rules_household ON quiet_rules(household_id);

-- Instance-wide key/value settings (e.g. the first-run setup token hash).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
