-- Stack: task tracker schema

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  due_at INTEGER,                 -- unix ms, nullable
  recurrence TEXT,                -- JSON string, e.g. {"type":"daily"} or {"type":"every_n_days","n":3}, nullable
  activity_id TEXT REFERENCES activities(id),  -- nullable; the "project" a task is housed under
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_touched_at INTEGER NOT NULL,   -- bumped on create/edit/complete, drives stale detection
  reminded_at INTEGER,                -- last time a push reminder was sent
  escalation_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks (due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_last_touched ON tasks (last_touched_at);
CREATE INDEX IF NOT EXISTS idx_tasks_activity ON tasks (activity_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Singleton row (id is always 1) holding user-configurable reminder behavior.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reminders_enabled INTEGER NOT NULL DEFAULT 1,
  escalation_hours INTEGER NOT NULL DEFAULT 3
);

INSERT OR IGNORE INTO settings (id, reminders_enabled, escalation_hours) VALUES (1, 1, 3);
