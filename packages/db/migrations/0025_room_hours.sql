-- Party line hours (docs/architecture.md "Rooms"): a room may be open only at set times. All
-- additive.

-- `hours`: JSON array of weekly windows ({days, start, end}, the space's time zone, like quiet
-- hours); NULL = always open. `announced_until`: the end of the window whose opening was
-- announced (rung on the phones and apps), so a restart doesn't announce it twice.
ALTER TABLE rooms ADD COLUMN hours TEXT;
ALTER TABLE rooms ADD COLUMN announced_until INTEGER;
