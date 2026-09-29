-- Server key rotation and the operator's view of pinned peer keys (docs/federation-spec.md §3).
-- Additive only: two new tables and a nullable column.

-- This server's own federation key after a rotation (one row, created by the first rotation).
-- Until then the key is the platform's (Cloudflare secret FED_PRIVATE_KEY). `wrapped_key` is the
-- private JWK sealed with AES-GCM under a key derived from that secret, so a copy of the database
-- alone reveals nothing. The previous key and its hand-over statement are published in
-- .well-known until `rotation_expires`. Self-hosted servers keep this in DATA_DIR files instead.
CREATE TABLE fed_own_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  previous_key TEXT,
  rotation_created INTEGER,
  rotation_expires INTEGER,
  rotation_sig TEXT,
  legacy_sig TEXT,
  rotated_at INTEGER NOT NULL
);

-- When the currently pinned key of a peer was pinned (first contact, a verified rotation, or an
-- operator's re-trust). NULL for rows pinned before this migration: first_seen applies.
ALTER TABLE server_keys ADD COLUMN key_since INTEGER;

-- What the server's operators did (and automatic key changes), server-wide.
CREATE TABLE operator_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_account TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX operator_audit_at ON operator_audit(at);
