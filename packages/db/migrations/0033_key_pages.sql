-- Speed-dial pages: ten keys a page, up to ten pages, stored as one index
-- (`(page - 1) * 10 + slot`, so 0-99). SQLite can't change a CHECK constraint, so the four key
-- tables are rebuilt with their rows (nothing refers to them). Keys 10-15, which no app could
-- set, become page 2's first six keys.
CREATE TABLE buttons_new (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 99),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);
INSERT INTO buttons_new (device_id, idx, user_id) SELECT device_id, idx, user_id FROM buttons;
DROP TABLE buttons;
ALTER TABLE buttons_new RENAME TO buttons;

CREATE TABLE remote_buttons_new (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 99),
  remote_id TEXT NOT NULL REFERENCES remote_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);
INSERT INTO remote_buttons_new (device_id, idx, remote_id)
  SELECT device_id, idx, remote_id FROM remote_buttons;
DROP TABLE remote_buttons;
ALTER TABLE remote_buttons_new RENAME TO remote_buttons;

CREATE TABLE room_buttons_new (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 99),
  room_contact_id TEXT NOT NULL REFERENCES room_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);
INSERT INTO room_buttons_new (device_id, idx, room_contact_id)
  SELECT device_id, idx, room_contact_id FROM room_buttons;
DROP TABLE room_buttons;
ALTER TABLE room_buttons_new RENAME TO room_buttons;

CREATE TABLE line_buttons_new (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 99),
  line_contact_id TEXT NOT NULL REFERENCES line_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);
INSERT INTO line_buttons_new (device_id, idx, line_contact_id)
  SELECT device_id, idx, line_contact_id FROM line_buttons;
DROP TABLE line_buttons;
ALTER TABLE line_buttons_new RENAME TO line_buttons;
