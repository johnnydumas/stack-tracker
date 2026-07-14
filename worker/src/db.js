import { newId, nextDueAt } from './util.js';
import schemaSql from '../../schema.sql';

let schemaReady;

/**
 * Applies schema.sql the first time an isolate touches the database.
 * Every statement is `IF NOT EXISTS`, so this is idempotent and makes a
 * freshly created D1 database usable without a manual
 * `npm run db:migrate:remote` step.
 */
export function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = applySchema(env).catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  return schemaReady;
}

async function applySchema(env) {
  const statements = schemaSql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  // Tables first: CREATE TABLE IF NOT EXISTS is a no-op against a tasks
  // table that predates activity_id, so that column needs its own
  // idempotent ALTER TABLE — and it must run before any CREATE INDEX on
  // activity_id, or the index statement fails on a column that isn't
  // there yet for a table that already existed pre-migration.
  for (const sql of statements) {
    if (/^CREATE TABLE/i.test(sql)) await env.DB.prepare(sql).run();
  }

  const { results: columns } = await env.DB.prepare(`PRAGMA table_info(tasks)`).all();
  if (!columns.some((col) => col.name === 'activity_id')) {
    try {
      await env.DB.prepare(`ALTER TABLE tasks ADD COLUMN activity_id TEXT REFERENCES activities(id)`).run();
    } catch (err) {
      // Another isolate may have won the race and already added it.
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }

  for (const sql of statements) {
    if (!/^CREATE TABLE/i.test(sql)) await env.DB.prepare(sql).run();
  }
}

const TASK_COLUMNS = `tasks.*, activities.title AS activity_title`;
const TASK_JOIN = `LEFT JOIN activities ON activities.id = tasks.activity_id`;

export async function listOpenTasks(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks ${TASK_JOIN}
     WHERE status = 'open' ORDER BY due_at IS NULL, due_at ASC`
  ).all();
  return results;
}

export async function listAllTasks(env, limit = 200) {
  const { results } = await env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks ${TASK_JOIN}
     ORDER BY status ASC, due_at IS NULL, due_at ASC LIMIT ?1`
  ).bind(limit).all();
  return results;
}

export async function getTask(env, id) {
  return env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(id).first();
}

export async function createTask(env, input) {
  const now = Date.now();
  const id = newId();
  const task = {
    id,
    title: String(input.title || '').trim(),
    notes: input.notes ? String(input.notes) : null,
    priority: ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium',
    status: 'open',
    due_at: input.due_at != null ? Number(input.due_at) : null,
    recurrence: input.recurrence ? JSON.stringify(input.recurrence) : null,
    activity_id: input.activity_id || null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    last_touched_at: now,
    reminded_at: null,
    escalation_count: 0,
  };
  if (!task.title) {
    throw new Error('title is required');
  }
  await env.DB.prepare(
    `INSERT INTO tasks
      (id, title, notes, priority, status, due_at, recurrence, activity_id, created_at, updated_at, completed_at, last_touched_at, reminded_at, escalation_count)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
  )
    .bind(
      task.id, task.title, task.notes, task.priority, task.status, task.due_at,
      task.recurrence, task.activity_id, task.created_at, task.updated_at, task.completed_at,
      task.last_touched_at, task.reminded_at, task.escalation_count
    )
    .run();
  return task;
}

/**
 * Updates a task. If the update marks it done and it has a recurrence rule,
 * a fresh open task is created for the next occurrence.
 * Returns { task, spawned } where spawned is the new task or null.
 */
export async function updateTask(env, id, patch) {
  const existing = await getTask(env, id);
  if (!existing) return { task: null, spawned: null };

  const now = Date.now();
  const next = { ...existing };

  if (patch.title != null) next.title = String(patch.title).trim();
  if (patch.notes !== undefined) next.notes = patch.notes ? String(patch.notes) : null;
  if (patch.priority && ['low', 'medium', 'high'].includes(patch.priority)) next.priority = patch.priority;
  if (patch.due_at !== undefined) next.due_at = patch.due_at != null ? Number(patch.due_at) : null;
  if (patch.recurrence !== undefined) {
    next.recurrence = patch.recurrence ? JSON.stringify(patch.recurrence) : null;
  }
  if (patch.activity_id !== undefined) next.activity_id = patch.activity_id || null;

  let spawned = null;
  const completingNow = patch.status === 'done' && existing.status !== 'done';
  const reopening = patch.status === 'open' && existing.status !== 'open';

  if (completingNow) {
    next.status = 'done';
    next.completed_at = now;
    if (existing.recurrence) {
      const from = existing.due_at ?? now;
      const due = nextDueAt(existing.recurrence, from);
      if (due != null) {
        spawned = await createTask(env, {
          title: existing.title,
          notes: existing.notes,
          priority: existing.priority,
          due_at: due,
          recurrence: JSON.parse(existing.recurrence),
        });
      }
    }
  } else if (reopening) {
    next.status = 'open';
    next.completed_at = null;
  }

  next.updated_at = now;
  next.last_touched_at = now;
  // Any manual edit or interaction resets the reminder/escalation state
  // so a changed due date gets fresh notifications instead of none.
  if (patch.due_at !== undefined || completingNow || reopening) {
    next.reminded_at = null;
    next.escalation_count = 0;
  }

  await env.DB.prepare(
    `UPDATE tasks SET
      title = ?1, notes = ?2, priority = ?3, status = ?4, due_at = ?5, recurrence = ?6, activity_id = ?7,
      updated_at = ?8, completed_at = ?9, last_touched_at = ?10, reminded_at = ?11, escalation_count = ?12
     WHERE id = ?13`
  )
    .bind(
      next.title, next.notes, next.priority, next.status, next.due_at, next.recurrence, next.activity_id,
      next.updated_at, next.completed_at, next.last_touched_at, next.reminded_at, next.escalation_count,
      id
    )
    .run();

  return { task: next, spawned };
}

export async function touchTask(env, id) {
  const now = Date.now();
  await env.DB.prepare(`UPDATE tasks SET last_touched_at = ?1 WHERE id = ?2`).bind(now, id).run();
}

export async function deleteTask(env, id) {
  await env.DB.prepare(`DELETE FROM tasks WHERE id = ?1`).bind(id).run();
}

export async function markReminded(env, id, escalationCount) {
  await env.DB.prepare(
    `UPDATE tasks SET reminded_at = ?1, escalation_count = ?2 WHERE id = ?3`
  ).bind(Date.now(), escalationCount, id).run();
}

export async function saveSubscription(env, sub) {
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).bind(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now()).run();
}

export async function removeSubscription(env, endpoint) {
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(endpoint).run();
}

export async function listSubscriptions(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM push_subscriptions`).all();
  return results;
}

export async function removeSubscriptionById(env, id) {
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?1`).bind(id).run();
}

// ---- Activities (aka "projects") ----

export async function listActivities(env) {
  const { results } = await env.DB.prepare(
    `SELECT activities.*,
       SUM(CASE WHEN tasks.status = 'open' THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN tasks.status = 'done' THEN 1 ELSE 0 END) AS done_count
     FROM activities
     LEFT JOIN tasks ON tasks.activity_id = activities.id
     GROUP BY activities.id
     ORDER BY activities.created_at ASC`
  ).all();
  return results;
}

export async function createActivity(env, input) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title is required');
  const now = Date.now();
  const activity = { id: newId(), title, created_at: now, updated_at: now };
  await env.DB.prepare(
    `INSERT INTO activities (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)`
  ).bind(activity.id, activity.title, activity.created_at, activity.updated_at).run();
  return activity;
}

export async function renameActivity(env, id, title) {
  const trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('title is required');
  const result = await env.DB.prepare(
    `UPDATE activities SET title = ?1, updated_at = ?2 WHERE id = ?3`
  ).bind(trimmed, Date.now(), id).run();
  return result.meta.changes > 0;
}

// Deleting an activity unassigns its tasks rather than deleting them —
// a task should never silently disappear because its project was removed.
export async function deleteActivity(env, id) {
  await env.DB.prepare(`UPDATE tasks SET activity_id = NULL WHERE activity_id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM activities WHERE id = ?1`).bind(id).run();
}
