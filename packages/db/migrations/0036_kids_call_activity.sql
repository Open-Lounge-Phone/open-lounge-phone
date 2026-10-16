-- A kids' phone's call activity for its guardians (docs/privacy.md "A kids' phone's call activity"): the
-- call log already has a row for every call the phone took part in (`device_id`). Calls that
-- never rang (refused: not on its list, quiet hours, busy, offline…) get a row too now, with
-- `refused` saying why, in a word: not_allowed | quiet_hours | busy | offline | unavailable |
-- other. `note` is the plain words the caller was given, if any. Rows follow the space's history
-- retention like every call-log row; nothing about what was said is kept.
ALTER TABLE call_log ADD COLUMN refused TEXT;
ALTER TABLE call_log ADD COLUMN note TEXT;
CREATE INDEX call_log_device ON call_log(device_id, started_at);
