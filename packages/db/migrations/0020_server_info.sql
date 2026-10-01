-- What other servers advertise in their .well-known (federation versions, features, software),
-- cached for version negotiation (docs/federation-spec.md §9). Additive only: one new table. It
-- is a cache: deleting rows is harmless (they are fetched again on the next request).
CREATE TABLE server_info (
  host TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
