-- P2b: the buddy timeline (calls and voicemails per connection) and its expiry. Additive.
--
-- How long a person keeps their history (call-log rows and voicemails) with someone, in days:
-- 30, 365, or 0 = forever. NULL on a connection means "use my account default"; NULL on an
-- account means "use the server default" (keep forever). Expired rows and their audio are
-- deleted by a sweep (see `Store.sweepExpired`).
ALTER TABLE connections ADD COLUMN retention_days INTEGER;
ALTER TABLE accounts ADD COLUMN retention_days INTEGER;

-- The sweep and the timeline read a person's history by time.
CREATE INDEX call_log_account ON call_log(account_id, started_at);
