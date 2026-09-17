PRAGMA foreign_keys = ON;

CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 512),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX folders_name_unique
  ON folders(name COLLATE NOCASE);

CREATE TABLE subscription_folders (
  feed_id INTEGER NOT NULL REFERENCES subscriptions(feed_id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (feed_id, folder_id)
) STRICT;

CREATE INDEX subscription_folders_folder_feed
  ON subscription_folders(folder_id, feed_id);
