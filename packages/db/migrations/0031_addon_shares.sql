-- Sharing add-ons (server 0.7.0, docs/add-ons.md "Sharing"). An add-on says which parts of itself
-- can be shared (its shares); its owner gives each share to people (grants); a share has its own
-- address, `handle+name+share@host`, which only the people holding it can call. This replaces the
-- whole-add-on allow-list of 0028. Additive: new tables and one column with a default; the old
-- `addon_allow` table stays but is no longer read or written.

-- What an add-on offers for sharing, as it last said (`addon.shares`), in its order.
CREATE TABLE addon_shares (
  addon_id TEXT NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  -- 1-30 of [a-z0-9-], unique per add-on: the part after the second `+`.
  share_id TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (addon_id, share_id)
);

-- Who holds a share: a person here (`host` '') or on another server, by their stable account id
-- there. `handle` and `name` are as of granting (shown to the owner; calls match the account id).
-- `connection_id`: given through one of the owner's connections (always for another server); the
-- grant goes when that connection does. A share the add-on drops takes its grants with it.
CREATE TABLE addon_grants (
  id TEXT PRIMARY KEY,
  addon_id TEXT NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL,
  host TEXT NOT NULL,
  account_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (addon_id, share_id, host, account_id)
);
CREATE INDEX addon_grants_holder ON addon_grants(host, account_id);
CREATE INDEX addon_grants_connection ON addon_grants(connection_id);

-- "New shared project with…": the owner asks the add-on for a new share for some people. The
-- add-on answers (created / refused), or the request lapses (offline when asked, or no answer in
-- time). `holders` is JSON: the people to give it to, resolved when asked. No content.
CREATE TABLE addon_share_requests (
  id TEXT PRIMARY KEY,
  addon_id TEXT NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  holders TEXT NOT NULL,
  -- waiting | created | refused | offline | timeout
  state TEXT NOT NULL,
  share_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX addon_share_requests_addon ON addon_share_requests(addon_id);

-- Shares of add-ons on the other side of a connection that its owner gave us (another server
-- tells us with `/fed/v1/addon-shares`), for listing and keys; that server decides every call.
CREATE TABLE connection_addon_shares (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  addon TEXT NOT NULL,
  share_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (connection_id, addon, share_id)
);

-- The whole-add-on allow-list goes away: it granted everything, which sharing rules out. Owners
-- whose add-ons had entries see a one-time note on the add-on's card (until they dismiss it).
ALTER TABLE addons ADD COLUMN allow_note INTEGER NOT NULL DEFAULT 0;
UPDATE addons SET allow_note = 1 WHERE id IN (SELECT addon_id FROM addon_allow);
DELETE FROM addon_allow;
