-- The firmware a hardware phone runs (docs/security-model.md "Firmware changes"): the build from
-- its last hello (`build_sha` = SHA-256 of the running image, its project and version, and
-- whether the phone installed it itself through its signed update path), and since when it has
-- run it. Browser phones, add-ons and phones that report no build leave these empty.
ALTER TABLE devices ADD COLUMN build_sha TEXT;
ALTER TABLE devices ADD COLUMN build_project TEXT;
ALTER TABLE devices ADD COLUMN build_version TEXT;
ALTER TABLE devices ADD COLUMN build_official INTEGER;
ALTER TABLE devices ADD COLUMN build_at INTEGER;

-- Ask me first (kids' phones; on unless a guardian turns it off): after firmware that isn't an
-- official update, the phone is held (`held_at`) until a guardian allows it. A held phone can't
-- be called and makes no calls.
ALTER TABLE devices ADD COLUMN ask_first INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN held_at INTEGER;
