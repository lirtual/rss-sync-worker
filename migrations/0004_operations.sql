PRAGMA foreign_keys = ON;

CREATE TABLE service_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_cron_at INTEGER CHECK (last_cron_at IS NULL OR last_cron_at >= 0),
  last_maintenance_at INTEGER CHECK (last_maintenance_at IS NULL OR last_maintenance_at >= 0),
  budget_day TEXT,
  dispatches_today INTEGER NOT NULL DEFAULT 0 CHECK (dispatches_today >= 0),
  last_queue_success_at INTEGER CHECK (last_queue_success_at IS NULL OR last_queue_success_at >= 0),
  last_queue_error_at INTEGER CHECK (last_queue_error_at IS NULL OR last_queue_error_at >= 0),
  last_queue_error_class TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
) STRICT;

INSERT INTO service_state (id, dispatches_today, updated_at)
VALUES (1, 0, 0);

CREATE INDEX entry_states_retention_eligible
  ON entry_states(entry_id)
  WHERE is_read = 1 AND is_starred = 0;
