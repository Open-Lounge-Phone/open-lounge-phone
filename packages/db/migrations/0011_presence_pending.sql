-- Presence shared with connections is rate-limited per account. A change that lands inside a
-- full window is kept here (only the latest state per account) and sent when the window opens,
-- by the hub of the household that raised it (its alarm), so the final state is never dropped.
CREATE TABLE presence_pending (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  online INTEGER NOT NULL,
  available INTEGER NOT NULL,
  due_at INTEGER NOT NULL
);
CREATE INDEX presence_pending_due ON presence_pending(household_id, due_at);
