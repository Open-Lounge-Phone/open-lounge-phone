-- M4: invites, passkeys, voicemail, and device key algorithms.

-- One-time links. With user_id set, accepting signs that existing person in on a new device;
-- otherwise it creates a new person with `name` and `role`.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('guardian', 'contact')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX invites_household ON invites(household_id);

-- WebAuthn credentials. `id` and `public_key` are base64url.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- Short-lived WebAuthn challenges (single use).
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE voicemails (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  from_user TEXT REFERENCES users(id) ON DELETE SET NULL,
  from_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  mime TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (transcript_status IN ('pending', 'done', 'failed', 'unavailable')),
  heard_at INTEGER
);
CREATE INDEX voicemails_device ON voicemails(device_id, heard_at);
CREATE INDEX voicemails_household ON voicemails(household_id, created_at);

ALTER TABLE devices ADD COLUMN key_alg TEXT NOT NULL DEFAULT 'ed25519';
ALTER TABLE pairings ADD COLUMN key_alg TEXT NOT NULL DEFAULT 'ed25519';
