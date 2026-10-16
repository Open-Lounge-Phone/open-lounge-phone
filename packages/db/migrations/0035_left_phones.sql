-- Phones of someone who left (docs/device-lifecycle.md "When someone leaves"). When a person
-- leaves a space, is removed from it or deletes their account, their own phones there stay in
-- the space, owned by nobody and marked with whose they were: `left_by` is that person's name
-- ('' when it isn't known), `left_at` when they left. Such a phone isn't a kids' phone: nobody
-- can call it, and it calls out only under the strictest rules (see `deviceMode` 'left').
ALTER TABLE devices ADD COLUMN left_by TEXT;
ALTER TABLE devices ADD COLUMN left_at INTEGER;

-- Phones orphaned before this (they turned into ownerless "household" phones). One set up as
-- someone's own phone says so in the audit trail ('phone.add', mode 'personal', added by its
-- owner): marked with that person's name.
UPDATE devices SET
  left_by = (SELECT a.actor_name FROM audit_log a
    WHERE a.household_id = devices.household_id AND a.action = 'phone.add'
      AND json_extract(a.detail, '$.deviceId') = devices.id
    ORDER BY a.at DESC LIMIT 1),
  left_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE owner_user_id IS NULL AND kind != 'lounge' AND EXISTS (SELECT 1 FROM audit_log a
  WHERE a.household_id = devices.household_id AND a.action = 'phone.add'
    AND json_extract(a.detail, '$.deviceId') = devices.id
    AND json_extract(a.detail, '$.mode') = 'personal');

-- Without that trail: an ownerless phone in a team or organization can't be a kids' phone (only
-- homes have those), so it was someone's; whose isn't known. In a home it stays a kids' phone.
UPDATE devices SET left_by = '', left_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE owner_user_id IS NULL AND kind != 'lounge' AND left_by IS NULL
  AND (SELECT h.type FROM households h WHERE h.id = devices.household_id) != 'home';
