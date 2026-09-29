-- P3.5 rooms: party lines, phone rooms, and room entries on phones. All additive.

-- A space's rooms. `party` = an always-open party line of the space (no address); `phone` = a
-- named room with an address `handle@host`, dialable from phones and the companion. Room handles
-- share the namespace of account handles (a handle is either a person or a room). 3-way calls
-- made by merging are live only and never stored here.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('party', 'phone')),
  name TEXT NOT NULL,
  handle TEXT UNIQUE,
  -- Whose connections may come in when `access` is 'connections' (the person who made it).
  owner_account TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  access TEXT NOT NULL DEFAULT 'space' CHECK (access IN ('space', 'connections')),
  locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX rooms_space ON rooms(household_id);

-- A room on a phone's allow-list (guardians decide for kids' phones), usable on a speed-dial key.
CREATE TABLE room_contacts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  UNIQUE (device_id, room_id)
);

CREATE TABLE room_buttons (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 15),
  room_contact_id TEXT NOT NULL REFERENCES room_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);

-- Fair use: minutes people spent in rooms (metered when they leave).
ALTER TABLE usage ADD COLUMN room_minutes INTEGER NOT NULL DEFAULT 0;
