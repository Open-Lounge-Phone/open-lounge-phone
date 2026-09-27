-- Grown-up app-to-app calling: each person chooses whether they're taking calls.
ALTER TABLE users ADD COLUMN available INTEGER NOT NULL DEFAULT 1;
