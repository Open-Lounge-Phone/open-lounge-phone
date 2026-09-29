-- Batch C2: call recording (docs/security-model.md, "Recording"). All additive; existing spaces
-- keep recording off.

-- Recording in this space (1 = on). Off by default; never allowed in a home with kids' phones.
ALTER TABLE households ADD COLUMN recording INTEGER NOT NULL DEFAULT 0;

-- A recording of a call or a room, made by the recording side's own client (1:1 calls are peer
-- to peer: the server never hears them) and uploaded with a single-use ticket. `call_id` is the
-- call (or room) id in its space's hub; `account_id` the person whose app or phone made it.
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'room')),
  call_id TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  -- The other side (calls: `handle@host`, `user:<id>`, `device:<id>`; rooms: the room id) and
  -- its name, for lists and the retention of the recorder's history with them.
  peer TEXT NOT NULL,
  peer_label TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  mime TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (transcript_status IN ('pending', 'done', 'failed', 'unavailable'))
);
CREATE INDEX recordings_space ON recordings(household_id, started_at);
CREATE INDEX recordings_call ON recordings(household_id, call_id);

-- Single-use permission to upload one recording, handed only to the recording side's client
-- together with the announcement every party gets. `data` is JSON.
CREATE TABLE recording_tickets (
  token_hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX recording_tickets_expiry ON recording_tickets(expires_at);

-- The call a call-log row belongs to (its id in the hub), and its recording if one was made.
ALTER TABLE call_log ADD COLUMN call_id TEXT;
ALTER TABLE call_log ADD COLUMN recording_id TEXT REFERENCES recordings(id) ON DELETE SET NULL;
CREATE INDEX call_log_call ON call_log(household_id, call_id);
