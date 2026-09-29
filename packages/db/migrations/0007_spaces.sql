-- P1b: spaces and handle reservation.
-- A household is now one kind of "space": `home` (a family; kids' phones and quiet hours live
-- here), `team` or `org` (grown-ups only). The table keeps its name; existing rows are homes.
ALTER TABLE households ADD COLUMN type TEXT NOT NULL DEFAULT 'home'
  CHECK (type IN ('home', 'team', 'org'));

-- A handle someone gave up (renamed or left) stays reserved for 90 days, because other servers
-- may still have it pinned in their connections. Only the account that released it may take it
-- back meanwhile. `account_id` is not a foreign key: the account may be gone.
CREATE TABLE released_handles (
  handle TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  released_at INTEGER NOT NULL
);
