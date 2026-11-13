-- Stack: LEGACY D1 schema — no longer used for live data.
-- The app now stores everything in its Durable Object (worker/src/store.js
-- creates those tables automatically). Do not run this against the remote
-- database: it drops tables and would wipe the data the Durable Object
-- copies over on first start.

DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS activity_reminders;
DROP TABLE IF EXISTS activity_notes;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS settings;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'waiting', 'completed')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  due_at INTEGER,                    -- unix ms, nullable
  recurrence TEXT,                   -- 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | NULL
  sort_order REAL NOT NULL DEFAULT 0, -- used by the "Manual" sort
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL, -- when it entered its current column
  completed_at INTEGER,               -- archived 14 days after this
  next_overdue_at INTEGER,            -- next "still overdue" reminder slot
  next_waiting_at INTEGER             -- next "waiting 3 work days" nudge slot
);

CREATE INDEX idx_activities_status ON activities (status);
CREATE INDEX idx_activities_project ON activities (project_id);
CREATE INDEX idx_activities_next_overdue ON activities (next_overdue_at);
CREATE INDEX idx_activities_next_waiting ON activities (next_waiting_at);

-- Timestamped work log. kind = 'note' (yours, editable) or 'system' (automatic).
CREATE TABLE activity_notes (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'system')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);

CREATE INDEX idx_notes_activity ON activity_notes (activity_id, created_at);

-- Reminders before the due date. offset_minutes = how long before due_at.
CREATE TABLE activity_reminders (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL CHECK (offset_minutes >= 0),
  fired_at INTEGER,                  -- set once sent (or skipped) for the current due date
  UNIQUE (activity_id, offset_minutes)
);

-- In-app notification inbox (every push is mirrored here).
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  activity_id TEXT REFERENCES activities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- 'overdue' | 'reminder' | 'waiting'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX idx_notifications_created ON notifications (created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('timezone', 'America/Chicago');

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
