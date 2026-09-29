-- Security and privacy settings per space (docs/security-model.md). Additive; existing spaces
-- keep everything (NULL = forever) and keep transcribing.
--
-- Retention defaults, in days (30 or 365; NULL = forever): `history_days` for call logs and the
-- Lounge usage history, `voicemail_days` for voicemail. A person's own setting (per connection,
-- or their account default, migration 0013) comes first; these apply when they have none, and
-- to the space's phones.
ALTER TABLE households ADD COLUMN history_days INTEGER;
ALTER TABLE households ADD COLUMN voicemail_days INTEGER;
-- Voicemail transcription in this space (1 = on).
ALTER TABLE households ADD COLUMN transcribe INTEGER NOT NULL DEFAULT 1;

-- What a phone last reported in its hello: its firmware (or app) version and model.
ALTER TABLE devices ADD COLUMN fw TEXT;
ALTER TABLE devices ADD COLUMN model TEXT;
