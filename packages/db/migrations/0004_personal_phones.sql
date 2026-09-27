-- A phone can belong to a person (a grown-up's own phone, physical or virtual) rather than to
-- the household (e.g. a kid's phone). Calls to that person ring it; their presence follows it.
ALTER TABLE devices ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX devices_owner ON devices(owner_user_id);
