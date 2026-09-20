PRAGMA foreign_keys = ON;

CREATE TABLE feed_icons (
  feed_id INTEGER PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 8 AND 128),
  status TEXT NOT NULL CHECK (status IN ('found', 'missing')),
  source_url TEXT,
  media_type TEXT,
  body BLOB,
  etag TEXT,
  checked_at INTEGER NOT NULL CHECK (checked_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= checked_at),
  CHECK (
    (status = 'found' AND source_url IS NOT NULL AND media_type IS NOT NULL AND body IS NOT NULL AND etag IS NOT NULL)
    OR
    (status = 'missing' AND body IS NULL)
  )
) STRICT;

CREATE INDEX feed_icons_expiry ON feed_icons(expires_at, feed_id);
