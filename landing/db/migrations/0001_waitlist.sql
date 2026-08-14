CREATE TABLE IF NOT EXISTS waitlist_entries (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  desktop INTEGER NOT NULL CHECK (desktop IN (0, 1)),
  ios INTEGER NOT NULL CHECK (ios IN (0, 1)),
  android INTEGER NOT NULL CHECK (android IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS waitlist_entries_created_at_idx
  ON waitlist_entries (created_at);
