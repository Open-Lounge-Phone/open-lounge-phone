-- Home features on the phones (server 0.7.0, docs/phone-ux.md "Daily check-in", "Chime",
-- "House intercom"), moved from the labs firmware. Each is set per phone and off by default.
-- All additive: new nullable columns, and one column with a default.
--
-- Daily check-in: by this local time (`HH:MM`, the space's time zone) someone presses I'm OK on
-- the phone; if nobody has by then, the space's guardians get an alert. The server keeps the last
-- local day it was pressed and the last day it alerted (`YYYY-MM-DD`), so neither repeats.
ALTER TABLE devices ADD COLUMN checkin_by TEXT;
ALTER TABLE devices ADD COLUMN checkin_ok_day TEXT;
ALTER TABLE devices ADD COLUMN checkin_alert_day TEXT;
-- Chime: the words a phone may post to every phone of its space as a notice ("DINNER'S READY").
ALTER TABLE devices ADD COLUMN chime_text TEXT;
-- House intercom: phones of a space with it on call each other on their local network, no server
-- in between. The space's intercom key (32 random bytes, base64url) protects it: control
-- messages carry an HMAC with it and audio is encrypted with it. Made when the first phone turns
-- it on.
ALTER TABLE devices ADD COLUMN intercom INTEGER NOT NULL DEFAULT 0;
ALTER TABLE households ADD COLUMN intercom_key TEXT;
