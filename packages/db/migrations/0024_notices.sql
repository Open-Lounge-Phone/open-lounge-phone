-- Notices (docs/notices.md): a short message from a space's owner, admins or guardians to its
-- phones, with an optional recording. Local to the space (never federated). All additive.

-- `line2` NULL = one line. `device_ids` NULL = every phone of the space, else a JSON array.
-- The recording (`audio_*`) is fetched by phones with `play_token` while the notice lasts and
-- deleted once it's over; rows go a week after they end.
CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  device_ids TEXT,
  audio_blob TEXT,
  audio_mime TEXT,
  audio_ms INTEGER,
  play_token TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX notices_space ON notices(household_id, created_at);

-- Phones that dismissed a notice (a key): it isn't shown there again.
CREATE TABLE notice_dismissals (
  notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, device_id)
);
