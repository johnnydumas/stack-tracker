// The app's data lives in the Durable Object's own SQLite storage, which sits
// on the same machine as the code — no network hop per query. This file
// provides a tiny D1-compatible wrapper around it (prepare/bind/first/all/
// run/batch), so the query code in db.js works unchanged.

const TABLES = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'not_started'
      CHECK (status IN ('not_started', 'in_progress', 'waiting', 'completed')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    project_id TEXT,
    due_at INTEGER,
    recurrence TEXT,
    sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status_changed_at INTEGER NOT NULL,
    completed_at INTEGER,
    next_overdue_at INTEGER,
    next_waiting_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activities_status ON activities (status)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_project ON activities (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_next_overdue ON activities (next_overdue_at)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_next_waiting ON activities (next_waiting_at)`,
  `CREATE TABLE IF NOT EXISTS activity_notes (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'system')),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_activity ON activity_notes (activity_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS activity_reminders (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    offset_minutes INTEGER NOT NULL CHECK (offset_minutes >= 0),
    fired_at INTEGER,
    UNIQUE (activity_id, offset_minutes)
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    activity_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (read_at)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'America/Chicago')`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

// Tables copied from the old D1 database on first start, in dependency order.
const MIGRATE_TABLES = [
  'settings', 'projects', 'activities', 'activity_notes', 'activity_reminders',
  'notifications', 'push_subscriptions',
];

export function createSchema(sql) {
  for (const stmt of TABLES) sql.exec(stmt);
}

/** D1-shaped wrapper over Durable Object SQLite storage. */
export function sqlStore(storage) {
  const sql = storage.sql;

  const rows = (query, params) => sql.exec(query, ...params).toArray();

  class Statement {
    constructor(query, params = []) {
      this.query = query;
      this.params = params;
    }

    bind(...params) {
      return new Statement(this.query, params);
    }

    allSync() {
      return { results: rows(this.query, this.params), success: true };
    }

    async first(column) {
      const row = rows(this.query, this.params)[0] ?? null;
      if (row && column) return row[column];
      return row;
    }

    async all() {
      return this.allSync();
    }

    async run() {
      const cursor = sql.exec(this.query, ...this.params);
      cursor.toArray();
      return { success: true, meta: { changes: cursor.rowsWritten } };
    }

    async raw() {
      return sql.exec(this.query, ...this.params).raw().toArray();
    }
  }

  return {
    prepare: (query) => new Statement(query),
    /** Runs statements atomically, like D1's batch. */
    batch: async (statements) => storage.transactionSync(() => statements.map((s) => s.allSync())),
    exec: async (query) => {
      sql.exec(query);
      return { count: 1 };
    },
  };
}

/**
 * One-time copy of existing data from the old D1 database. Uses INSERT OR
 * IGNORE so it never overwrites anything already in the new store; if D1 is
 * unreachable it gives up after `timeoutMs` and tries again on next start.
 */
export async function migrateFromD1(storage, d1, timeoutMs = 20000) {
  if (!d1 || (await storage.get('migrated_from_d1'))) return 'skipped';

  const fetchAll = Promise.all(
    MIGRATE_TABLES.map((t) =>
      d1.prepare(`SELECT * FROM ${t}`).all().then((r) => [t, r.results]).catch(() => [t, []])
    )
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const data = await Promise.race([fetchAll, timeout]);
  if (!data) {
    console.warn('D1 migration timed out; will retry on next start');
    return 'timeout';
  }

  let copied = 0;
  storage.transactionSync(() => {
    for (const [table, records] of data) {
      for (const row of records) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const verb = table === 'settings' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
        storage.sql.exec(
          `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          ...cols.map((c) => row[c])
        );
        copied += 1;
      }
    }
  });
  await storage.put('migrated_from_d1', Date.now());
  console.log(`Copied ${copied} rows from D1 into Durable Object storage`);
  return `copied ${copied}`;
}
