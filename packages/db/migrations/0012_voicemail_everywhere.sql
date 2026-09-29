-- Voicemail everywhere: for a phone (as before) or for a person (their own inbox), greetings,
-- ring time, and single-use tickets that let a caller (an app or a phone) leave one message.

-- A voicemail is for a household phone (`device_id`) or a person (`to_user`, their inbox).
-- `from_address` identifies the caller for the timeline (`handle@host`, `user:<id>`,
-- `device:<id>`). call_log links survive the rebuild.
CREATE TABLE vm_links_tmp AS SELECT id, voicemail_id FROM call_log WHERE voicemail_id IS NOT NULL;
CREATE TABLE voicemails_v2 (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  to_user TEXT REFERENCES users(id) ON DELETE CASCADE,
  from_user TEXT REFERENCES users(id) ON DELETE SET NULL,
  from_label TEXT NOT NULL,
  from_address TEXT,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  mime TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (transcript_status IN ('pending', 'done', 'failed', 'unavailable')),
  heard_at INTEGER,
  CHECK ((device_id IS NULL) <> (to_user IS NULL))
);
INSERT INTO voicemails_v2 (id, household_id, device_id, from_user, from_label, created_at,
  duration_ms, mime, blob_key, transcript, transcript_status, heard_at)
SELECT id, household_id, device_id, from_user, from_label, created_at, duration_ms, mime, blob_key,
  transcript, transcript_status, heard_at FROM voicemails;
DROP TABLE voicemails;
ALTER TABLE voicemails_v2 RENAME TO voicemails;
CREATE INDEX voicemails_device ON voicemails(device_id, heard_at);
CREATE INDEX voicemails_household ON voicemails(household_id, created_at);
CREATE INDEX voicemails_user ON voicemails(to_user, created_at);
UPDATE call_log SET voicemail_id = (SELECT l.voicemail_id FROM vm_links_tmp l WHERE l.id = call_log.id)
  WHERE id IN (SELECT id FROM vm_links_tmp);
DROP TABLE vm_links_tmp;

-- Voicemail settings of a person (account) or a household phone. No row = the defaults: ring
-- 25 s, the spoken default greeting, and (kids' phones) the child may record the greeting.
-- `greeting_kind`: `name` = a recorded name (≤ 3 s) inside the default sentence; `custom` = a
-- whole greeting (≤ 30 s). Its audio is a blob.
CREATE TABLE voicemail_prefs (
  account_id TEXT UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  ring_seconds INTEGER,
  child_greeting INTEGER NOT NULL DEFAULT 1,
  greeting_kind TEXT CHECK (greeting_kind IN ('name', 'custom')),
  greeting_mime TEXT,
  greeting_blob TEXT,
  greeting_ms INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((account_id IS NULL) <> (device_id IS NULL))
);

-- Single-use, short-lived permission to leave one voicemail (or record a phone's greeting),
-- issued when a call went unanswered after the dial itself was authorized. `data` is JSON.
CREATE TABLE voicemail_tickets (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('voicemail', 'greeting')),
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX voicemail_tickets_expiry ON voicemail_tickets(expires_at);
