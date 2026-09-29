-- Batch C1: team and org spaces as a workplace phone system (docs/workplace.md). Home spaces are
-- unchanged. Everything is additive except `voicemails`, rebuilt (as in 0012) so a message can
-- belong to a ring group's shared box; its rows and the call-log links survive.

-- Short numbers per space: a member, a phone, a room or a ring group. A number is unique in its
-- space and each target has at most one. `target_id` is a users, devices, rooms or ring_groups
-- id; the rows go when their target does (the store deletes them, since the target varies).
CREATE TABLE extensions (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'device', 'room', 'group')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, number),
  UNIQUE (household_id, kind, target_id)
);

-- Ring (hunt) groups, e.g. "Front desk": `simultaneous` rings every available member at once;
-- `sequential` one after another in `position` order; `round_robin` likewise, starting after
-- whoever came first last time (`next_index`). `ring_seconds` is how long one step rings (all of
-- them at once, or each person). Unanswered → the group's shared voicemail box.
-- `hours` (JSON quiet-hours-style rules of the OPEN windows) and `after_hours` (JSON action)
-- override the space's; NULL = follow the space.
CREATE TABLE ring_groups (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'simultaneous'
    CHECK (strategy IN ('simultaneous', 'sequential', 'round_robin')),
  ring_seconds INTEGER NOT NULL DEFAULT 20,
  next_index INTEGER NOT NULL DEFAULT 0,
  hours TEXT,
  after_hours TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ring_groups_space ON ring_groups(household_id);

CREATE TABLE ring_group_members (
  group_id TEXT NOT NULL REFERENCES ring_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX ring_group_members_user ON ring_group_members(user_id);

-- Business hours of a team/org space (JSON rules of the open windows, in the space's time zone;
-- NULL = always open) and what happens to calls to its groups after hours (JSON; NULL = the
-- called group's voicemail box).
ALTER TABLE households ADD COLUMN business_hours TEXT;
ALTER TABLE households ADD COLUMN after_hours TEXT;

-- Who changed what, in team/org spaces (admins read it). Kept as long as the space's history.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  actor_account TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX audit_log_space ON audit_log(household_id, at);

-- Voicemail for a phone, a person, or a ring group's shared box (`group_id`); `heard_by` is the
-- member who marked a shared message heard.
CREATE TABLE vm_links_tmp AS SELECT id, voicemail_id FROM call_log WHERE voicemail_id IS NOT NULL;
CREATE TABLE voicemails_v3 (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  to_user TEXT REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES ring_groups(id) ON DELETE CASCADE,
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
  heard_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((device_id IS NOT NULL) + (to_user IS NOT NULL) + (group_id IS NOT NULL) = 1)
);
INSERT INTO voicemails_v3 (id, household_id, device_id, to_user, from_user, from_label,
  from_address, created_at, duration_ms, mime, blob_key, transcript, transcript_status, heard_at)
SELECT id, household_id, device_id, to_user, from_user, from_label, from_address, created_at,
  duration_ms, mime, blob_key, transcript, transcript_status, heard_at FROM voicemails;
DROP TABLE voicemails;
ALTER TABLE voicemails_v3 RENAME TO voicemails;
CREATE INDEX voicemails_device ON voicemails(device_id, heard_at);
CREATE INDEX voicemails_household ON voicemails(household_id, created_at);
CREATE INDEX voicemails_user ON voicemails(to_user, created_at);
CREATE INDEX voicemails_group ON voicemails(group_id, created_at);
UPDATE call_log SET voicemail_id = (SELECT l.voicemail_id FROM vm_links_tmp l WHERE l.id = call_log.id)
  WHERE id IN (SELECT id FROM vm_links_tmp);
DROP TABLE vm_links_tmp;
