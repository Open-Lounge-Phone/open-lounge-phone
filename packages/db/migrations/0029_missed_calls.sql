-- Missed calls and call waiting (server 0.7.0, docs/phone-ux.md "Missed calls" and "Call
-- waiting"). All additive: one new table and two new columns with defaults.
--
-- A missed call: a call that rang a person (any of their apps and phones) or a household phone
-- (a kid's) and nobody answered, and the caller left no message (a message moves it to
-- voicemail: `seen_at` is set then). One row per call. Each is the person's (account_id: they see
-- it on all their phones and apps, in every space) or a household phone's (device_id). Clearing
-- marks rows seen; seen rows stay until the space's history setting removes them, as proof that
-- this caller called, so a phone may call them back. `from_peer` names the caller as the call log
-- does: `user:<id>`, `device:<id>`, or `handle@host` for someone on another household or server.
CREATE TABLE missed_calls (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  from_label TEXT NOT NULL,
  from_peer TEXT NOT NULL,
  at INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE INDEX missed_calls_account ON missed_calls(account_id, at);
CREATE INDEX missed_calls_device ON missed_calls(device_id, at);
CREATE INDEX missed_calls_space ON missed_calls(household_id, at);

-- Call waiting: a second call rings softly during a call instead of being refused as busy. On by
-- default: a person's own setting (their apps and own phones follow it), and for a household
-- phone (a kid's) its guardians'.
ALTER TABLE accounts ADD COLUMN call_waiting INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN call_waiting INTEGER NOT NULL DEFAULT 1;
