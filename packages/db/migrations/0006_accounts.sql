-- P1 (federation F0): accounts and handles, several households per server.
-- A person has one account per server (`handle@host`). Each `users` row is now that account's
-- membership in one household (guardian or contact). Passkeys and sessions belong to the
-- account; a session remembers which membership (household) is active.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  -- Unique per server, [a-z0-9._-]{2,30}. Changeable (rate-limited); `id` is the stable key.
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Last time the person changed their handle (null = never; the backfilled one is free to change).
  handle_changed_at INTEGER
);

ALTER TABLE users ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX users_account ON users(account_id);

-- Backfill: one account per existing person. The handle comes from their name: lower-case, with
-- spaces, dashes and underscores turned into dots and apostrophes dropped; names that still
-- contain anything outside [a-z0-9.] (or are too short) become "user". Duplicates get "-2",
-- "-3", ... in creation order; base handles never contain "-", so suffixed ones can't collide.
INSERT INTO accounts (id, handle, name, created_at)
SELECT
  'acc_' || substr(id, 5),
  CASE WHEN n = 1 THEN h ELSE h || '-' || n END,
  name,
  created_at
FROM (
  SELECT id, name, created_at, h,
    row_number() OVER (PARTITION BY h ORDER BY created_at, id) AS n
  FROM (
    SELECT id, name, created_at,
      CASE WHEN length(slug) < 2 OR slug GLOB '*[^a-z0-9.]*' THEN 'user' ELSE slug END AS h
    FROM (
      SELECT id, name, created_at,
        substr(
          replace(replace(replace(replace(replace(lower(trim(name)),
            ' ', '.'), '-', '.'), '_', '.'), '''', ''), '..', '.'),
          1, 24) AS slug
      FROM users
    )
  )
);

UPDATE users SET account_id = 'acc_' || substr(id, 5);

-- Sessions move to the account. `user_id` is the active membership; it falls back to another
-- membership when that one is removed.
CREATE TABLE sessions_v2 (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT INTO sessions_v2 (token_hash, account_id, user_id, created_at, expires_at)
SELECT s.token_hash, u.account_id, s.user_id, s.created_at, s.expires_at
FROM sessions s JOIN users u ON u.id = s.user_id;
DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;
CREATE INDEX sessions_account ON sessions(account_id);

-- Passkeys move to the account.
CREATE TABLE passkeys_v2 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
INSERT INTO passkeys_v2 (id, account_id, public_key, counter, transports, name, created_at, last_used_at)
SELECT p.id, u.account_id, p.public_key, p.counter, p.transports, p.name, p.created_at, p.last_used_at
FROM passkeys p JOIN users u ON u.id = p.user_id;
DROP TABLE passkeys;
ALTER TABLE passkeys_v2 RENAME TO passkeys;
CREATE INDEX passkeys_account ON passkeys(account_id);

-- Challenges are short-lived; pending ones are simply dropped. `signup` challenges carry the
-- chosen handle and names in `data` (JSON) until the passkey is verified.
DROP TABLE auth_challenges;
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login', 'signup')),
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  data TEXT,
  expires_at INTEGER NOT NULL
);
