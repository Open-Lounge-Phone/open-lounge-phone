-- Add-on shares that went, kept as a short note for the people concerned so nothing silently
-- disappears: its owner removed an add-on (`removed`: which shares went and who held them), or
-- a share someone held went (`share`: its add-on was removed, its owner took it back, or the
-- add-on stopped offering it). Names and labels only; dismissed (deleted) by the person, and
-- swept with the account.
CREATE TABLE addon_gone (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  what TEXT NOT NULL CHECK (what IN ('removed', 'share')),
  addon TEXT NOT NULL,
  -- `share`: whose add-on it was (name and address); `removed`: ''.
  owner TEXT NOT NULL DEFAULT '',
  -- JSON. `removed`: [{"label": …, "holders": [names]}]; `share`: {"label": …}.
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX addon_gone_account ON addon_gone(account_id, at);
