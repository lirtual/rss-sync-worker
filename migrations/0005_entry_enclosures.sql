PRAGMA foreign_keys = ON;

CREATE TABLE entry_enclosures (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  url TEXT NOT NULL CHECK (length(trim(url)) > 0),
  mime_type TEXT,
  length_bytes INTEGER CHECK (length_bytes IS NULL OR length_bytes >= 0),
  title TEXT,
  PRIMARY KEY (entry_id, position)
) STRICT;

CREATE INDEX entry_enclosures_entry
  ON entry_enclosures(entry_id, position);
