-- Missed call backs (docs/workplace.md "Call me back"): a public line called a person back as
-- they asked, and they didn't take it. Their own phones show it as a missed call naming the line
-- (`config.missed`, `callback`) until they clear it on the phone, call the line, or take its next
-- call back. One row per person and line (the latest miss). Kept no longer than the history of
-- the space they asked from. All additive.
CREATE TABLE missed_callbacks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- The line's address, `handle@host`, and the name it calls back with.
  line_address TEXT NOT NULL,
  line_name TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (account_id, line_address)
);
CREATE INDEX missed_callbacks_space ON missed_callbacks(household_id, at);
