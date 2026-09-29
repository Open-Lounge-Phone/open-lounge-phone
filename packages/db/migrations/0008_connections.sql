-- P2 (federation F1): connections and knocks, server identity, rate limits.

-- One row per account per other person (or per blocked server). Each side of a connection keeps
-- its own row, on its own server. `peer_host` is '' for someone on this server. A row with
-- `peer_handle` '*' blocks a whole server for this account.
--   requested + out   I knocked; waiting (expires_at)
--   requested + in    they knocked me; waiting for my answer (expires_at)
--   active            either side may call (subject to the callee's own rules)
--   declined          I declined them; their knocks are dropped until expires_at
--   blocked           I blocked them (or their server); dropped forever
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  peer_host TEXT NOT NULL,
  peer_handle TEXT NOT NULL,
  -- The peer's stable account id on their server, once they have spoken to us.
  peer_account TEXT,
  peer_name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('requested', 'active', 'declined', 'blocked')),
  direction TEXT NOT NULL DEFAULT 'none' CHECK (direction IN ('in', 'out', 'none')),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE (account_id, peer_host, peer_handle)
);
CREATE INDEX connections_peer ON connections(peer_host, peer_account);

-- A remote (or other-household) person on a phone's allow-list: always through an active
-- connection of the guardian who added them. The row goes when that connection does.
CREATE TABLE remote_contacts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  can_call_device INTEGER NOT NULL DEFAULT 0,
  device_can_call INTEGER NOT NULL DEFAULT 0,
  bypass_quiet_hours INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_id, connection_id)
);

CREATE TABLE remote_buttons (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 15),
  remote_id TEXT NOT NULL REFERENCES remote_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, idx)
);

-- Fixed-window counters for rate limits and quotas (`bucket` names the limit and its subject).
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Other servers' federation keys, pinned on first contact (trust on first use). A different key
-- is refused unless the pinned key signed the rotation; the refused key is kept for the operator.
CREATE TABLE server_keys (
  host TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  rejected_key TEXT,
  rejected_at INTEGER
);

-- Signature nonces seen recently (replay protection).
CREATE TABLE fed_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX fed_nonces_expiry ON fed_nonces(expires_at);

-- Servers the operator refuses to talk to.
CREATE TABLE blocked_servers (
  host TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER NOT NULL
);
