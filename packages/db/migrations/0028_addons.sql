-- Add-ons (server 0.6.0, docs/add-ons.md): services a person links to their own account, such as
-- an AI companion or a notes taker. Additive: two new tables, nothing else changes.
--
-- An add-on speaks the device protocol like a phone (its own key, the signed challenge on every
-- connection) but it is not a phone: it is never listed among a space's phones and it has no
-- speed-dial keys. Its address is `handle+name@host`, where `handle` is its owner's current
-- handle. Removing it (or its owner leaving the space it was linked in) deletes the row, which
-- revokes it at once.
CREATE TABLE addons (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The space it was linked in (its calls are handled there) and the owner's membership there.
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The part after `+`: unique per owner, validated like a handle.
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  key_alg TEXT NOT NULL DEFAULT 'ed25519',
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  -- What it runs, from its last hello (e.g. `olp-addon/0.1.0`).
  fw TEXT,
  UNIQUE (account_id, name)
);
CREATE INDEX addons_household ON addons(household_id);

-- Who besides the owner may talk to an add-on, both ways: some of the owner's connections. No
-- row = nobody but the owner.
CREATE TABLE addon_allow (
  addon_id TEXT NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  PRIMARY KEY (addon_id, connection_id)
);
CREATE INDEX addon_allow_connection ON addon_allow(connection_id);
