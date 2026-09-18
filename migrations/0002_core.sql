PRAGMA foreign_keys = ON;

CREATE TABLE feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  canonical_feed_url TEXT NOT NULL UNIQUE CHECK (length(trim(canonical_feed_url)) > 0),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 2048),
  site_url TEXT,
  etag TEXT,
  last_modified TEXT,
  last_attempt_at INTEGER CHECK (last_attempt_at IS NULL OR last_attempt_at >= 0),
  last_success_at INTEGER CHECK (last_success_at IS NULL OR last_success_at >= 0),
  next_fetch_at INTEGER NOT NULL CHECK (next_fetch_at >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error_class TEXT,
  last_error_message TEXT,
  last_change_at INTEGER CHECK (last_change_at IS NULL OR last_change_at >= 0),
  dispatch_token TEXT,
  dispatch_deadline_at INTEGER CHECK (dispatch_deadline_at IS NULL OR dispatch_deadline_at >= 0),
  redirect_candidate_url TEXT,
  redirect_candidate_successes INTEGER NOT NULL DEFAULT 0 CHECK (redirect_candidate_successes >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((dispatch_token IS NULL) = (dispatch_deadline_at IS NULL))
) STRICT;

CREATE INDEX feeds_due_refresh
  ON feeds(next_fetch_at, id);
CREATE INDEX feeds_dispatch_expiry
  ON feeds(dispatch_deadline_at, id)
  WHERE dispatch_deadline_at IS NOT NULL;

CREATE TABLE feed_url_aliases (
  url TEXT PRIMARY KEY CHECK (length(trim(url)) > 0),
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX feed_url_aliases_feed
  ON feed_url_aliases(feed_id, url);

CREATE TABLE subscriptions (
  feed_id INTEGER PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  custom_title TEXT,
  bootstrapped_at INTEGER CHECK (bootstrapped_at IS NULL OR bootstrapped_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX subscriptions_active_feed
  ON subscriptions(active, feed_id);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL CHECK (length(identity_key) = 64),
  source_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  author TEXT,
  published_at INTEGER CHECK (published_at IS NULL OR published_at >= 0),
  source_updated_at INTEGER CHECK (source_updated_at IS NULL OR source_updated_at >= 0),
  ingested_at INTEGER NOT NULL CHECK (ingested_at >= 0),
  last_source_seen_at INTEGER NOT NULL CHECK (last_source_seen_at >= 0),
  content_status TEXT NOT NULL CHECK (content_status IN ('stored', 'empty', 'oversized')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (feed_id, identity_key),
  UNIQUE (feed_id, id)
) STRICT;

CREATE INDEX entries_feed_ingested
  ON entries(feed_id, ingested_at DESC, id DESC);
CREATE INDEX entries_ingested
  ON entries(ingested_at DESC, id DESC);

CREATE TABLE entry_contents (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  content_html TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  encoded_size_bytes INTEGER NOT NULL CHECK (encoded_size_bytes >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE TABLE entry_states (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
  read_changed_at INTEGER,
  starred_changed_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE INDEX entry_states_unread
  ON entry_states(is_read, entry_id);
CREATE INDEX entry_states_starred
  ON entry_states(is_starred, entry_id);
