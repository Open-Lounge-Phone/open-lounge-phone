-- Add-ons describe themselves, and people who hold a share can stop an add-on calling them
-- (server 0.8.0, docs/add-ons.md). Additive: one nullable column and two new tables.

-- What the add-on said about itself (`addon.about`), as JSON, for its page in the app and the
-- rules the server enforces (whether it may be called or call, shares, keys, calls at once).
-- NULL: it never said (server 0.7.0 rules apply).
ALTER TABLE addons ADD COLUMN about TEXT;

-- "Stop its calls": someone here who doesn't want calls from an add-on (on this server or
-- another one). Their own server refuses its calls to them; they can still call it.
CREATE TABLE addon_mutes (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The add-on's server ('' = this one), its owner's stable account id there, and its name.
  host TEXT NOT NULL,
  owner_account TEXT NOT NULL,
  addon TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, host, owner_account, addon)
);

-- Add-ons in a person's contacts (Home's call list in the app): their own add-ons and shares, and
-- shares given to them, by address. Who may talk to it is still checked on every call.
CREATE TABLE addon_contacts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
);
