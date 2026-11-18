import { newId, formatLocal, STATUS_LABELS, ARCHIVE_AFTER_MS, ValidationError } from './util.js';
import {
  parseLocalInput, nextOverdueReminder, nextWaitingNudge, nextRecurrenceDue, RECURRENCE_LABELS,
} from '../../public/shared/time.js';

const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = Object.keys(STATUS_LABELS);

// ---------------- Settings ----------------

export async function getSettings(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const settings = { timezone: 'America/Chicago' };
  for (const row of results) settings[row.key] = row.value;
  return settings;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------- Projects ----------------

export async function listProjects(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM projects ORDER BY name COLLATE NOCASE`
  ).all();
  return results;
}

export async function createProject(env, input) {
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw new ValidationError('name is required');
  const project = { id: newId(), name, color: String(input.color || 'blue'), created_at: Date.now() };
  await env.DB.prepare(`INSERT INTO projects (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(project.id, project.name, project.color, project.created_at).run();
  return project;
}

export async function updateProject(env, id, input) {
  const existing = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(id).first();
  if (!existing) return null;
  const name = input.name != null ? String(input.name).trim().slice(0, 60) : existing.name;
  if (!name) throw new ValidationError('name is required');
  const color = input.color != null ? String(input.color) : existing.color;
  await env.DB.prepare(`UPDATE projects SET name = ?1, color = ?2 WHERE id = ?3`).bind(name, color, id).run();
  return { ...existing, name, color };
}

export async function deleteProject(env, id) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE activities SET project_id = NULL WHERE project_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM projects WHERE id = ?1`).bind(id),
  ]);
}

// ---------------- Activities ----------------

const ACTIVITY_SELECT = `
  SELECT a.*,
    (SELECT COUNT(*) FROM activity_notes n WHERE n.activity_id = a.id AND n.kind = 'note') AS notes_count,
    (SELECT COUNT(*) FROM activity_reminders r WHERE r.activity_id = a.id) AS reminders_count
  FROM activities a`;

const NOT_ARCHIVED = `NOT (a.status = 'completed' AND a.completed_at < ?1)`;
const ARCHIVED = `(a.status = 'completed' AND a.completed_at < ?1)`;

/** Everything on the board: all activities except completed ones older than 14 days. */
export async function listBoardActivities(env, now) {
  const { results } = await env.DB.prepare(`${ACTIVITY_SELECT} WHERE ${NOT_ARCHIVED}`)
    .bind(now - ARCHIVE_AFTER_MS).all();
  return results;
}

/**
 * Everything the board needs, in a single round trip to the database
 * (one batch instead of four separate queries).
 */
export async function loadBoardData(env, now) {
  const [settingsRows, projects, activities, unread] = await env.DB.batch([
    env.DB.prepare(`SELECT key, value FROM settings`),
    env.DB.prepare(`SELECT * FROM projects ORDER BY name COLLATE NOCASE`),
    env.DB.prepare(`${ACTIVITY_SELECT} WHERE ${NOT_ARCHIVED}`).bind(now - ARCHIVE_AFTER_MS),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL`),
  ]);
  const settings = { timezone: 'America/Chicago' };
  for (const row of settingsRows.results) settings[row.key] = row.value;
  return {
    settings,
    projects: projects.results,
    activities: activities.results,
    unread: unread.results[0]?.c ?? 0,
  };
}

/** Archived activities, optionally filtered by a search string (title, description, notes). */
export async function listArchived(env, now, q = '') {
  const cutoff = now - ARCHIVE_AFTER_MS;
  const term = String(q || '').trim();
  if (!term) {
    const { results } = await env.DB.prepare(
      `${ACTIVITY_SELECT} WHERE ${ARCHIVED} ORDER BY a.completed_at DESC LIMIT 200`
    ).bind(cutoff).all();
    return results;
  }
  const { results } = await env.DB.prepare(
    `${ACTIVITY_SELECT} WHERE ${ARCHIVED} AND ${MATCHES_TERM} ORDER BY a.completed_at DESC LIMIT 200`
  ).bind(cutoff, likePattern(term)).all();
  return results;
}

const MATCHES_TERM = `(
  a.title LIKE ?2 ESCAPE '\\' OR a.description LIKE ?2 ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM activity_notes n WHERE n.activity_id = a.id AND n.body LIKE ?2 ESCAPE '\\')
)`;

function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Search across board + archive. Returns matching board ids and archived rows. */
export async function searchActivities(env, now, q) {
  const term = String(q || '').trim();
  if (!term) return { ids: [], archived: [] };
  const cutoff = now - ARCHIVE_AFTER_MS;
  const [board, archived] = await Promise.all([
    env.DB.prepare(`SELECT a.id FROM activities a WHERE ${NOT_ARCHIVED} AND ${MATCHES_TERM}`)
      .bind(cutoff, likePattern(term)).all(),
    listArchived(env, now, term),
  ]);
  return { ids: board.results.map((r) => r.id), archived };
}

export async function getActivity(env, id) {
  return env.DB.prepare(`${ACTIVITY_SELECT} WHERE a.id = ?1`).bind(id).first();
}

export async function getActivityDetail(env, id) {
  const activity = await getActivity(env, id);
  if (!activity) return null;
  const [notes, reminders] = await Promise.all([
    env.DB.prepare(`SELECT * FROM activity_notes WHERE activity_id = ?1 ORDER BY created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM activity_reminders WHERE activity_id = ?1 ORDER BY offset_minutes DESC`).bind(id).all(),
  ]);
  return { activity, notes: notes.results, reminders: reminders.results };
}

async function projectExists(env, projectId) {
  if (!projectId) return true;
  return Boolean(await env.DB.prepare(`SELECT 1 FROM projects WHERE id = ?1`).bind(projectId).first());
}

function normalizeRecurrence(value) {
  if (!value) return null;
  return RECURRENCE_LABELS[value] ? value : null;
}

export async function createActivity(env, input, tz) {
  const now = Date.now();
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) throw new ValidationError('title is required');

  const status = STATUSES.includes(input.status) ? input.status : 'not_started';
  const projectId = input.project_id || null;
  if (!(await projectExists(env, projectId))) throw new ValidationError('unknown project');

  const dueAt = input.due ? parseLocalInput(input.due, tz) : null;
  if (input.due && dueAt == null) throw new ValidationError('invalid due date (use a year between 2000 and 2100)');
  const top = await env.DB.prepare(
    `SELECT MIN(sort_order) AS m FROM activities WHERE status = ?1`
  ).bind(status).first();

  const a = {
    id: newId(),
    title,
    description: input.description ? String(input.description).slice(0, 5000) : null,
    status,
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'medium',
    project_id: projectId,
    due_at: dueAt,
    recurrence: normalizeRecurrence(input.recurrence),
    sort_order: (top?.m ?? 1) - 1,
    created_at: now,
    updated_at: now,
    status_changed_at: now,
    completed_at: status === 'completed' ? now : null,
    next_overdue_at: dueAt != null && status !== 'completed' ? nextOverdueReminder(dueAt, now, tz) : null,
    next_waiting_at: status === 'waiting' ? nextWaitingNudge(now, now, tz) : null,
  };

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO activities
        (id, title, description, status, priority, project_id, due_at, recurrence, sort_order,
         created_at, updated_at, status_changed_at, completed_at, next_overdue_at, next_waiting_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    ).bind(
      a.id, a.title, a.description, a.status, a.priority, a.project_id, a.due_at, a.recurrence,
      a.sort_order, a.created_at, a.updated_at, a.status_changed_at, a.completed_at,
      a.next_overdue_at, a.next_waiting_at
    ),
    systemNote(env, a.id, `Created in ${STATUS_LABELS[status]}`, now),
  ]);

  if (Array.isArray(input.reminders) && input.reminders.length > 0) {
    await setReminders(env, a.id, input.reminders, tz);
  }
  return getActivity(env, a.id);
}

function systemNote(env, activityId, body, now) {
  return env.DB.prepare(
    `INSERT INTO activity_notes (id, activity_id, kind, body, created_at) VALUES (?1, ?2, 'system', ?3, ?4)`
  ).bind(newId(), activityId, body, now);
}

/**
 * Applies a partial update. Handles status moves (with log entries), recurring
 * completion (the card returns to Not started with the next due date), and
 * re-plans reminders whenever the due date or status changes.
 */
export async function updateActivity(env, id, patch, tz) {
  const existing = await env.DB.prepare(`SELECT * FROM activities WHERE id = ?1`).bind(id).first();
  if (!existing) return null;

  const now = Date.now();
  const next = { ...existing };
  const logs = [];

  if (patch.title != null) {
    const title = String(patch.title).trim().slice(0, 200);
    if (!title) throw new ValidationError('title is required');
    next.title = title;
  }
  if (patch.description !== undefined) {
    next.description = patch.description ? String(patch.description).slice(0, 5000) : null;
  }
  if (patch.priority !== undefined && PRIORITIES.includes(patch.priority)) next.priority = patch.priority;
  if (patch.project_id !== undefined) {
    const projectId = patch.project_id || null;
    if (!(await projectExists(env, projectId))) throw new ValidationError('unknown project');
    next.project_id = projectId;
  }
  if (patch.recurrence !== undefined) next.recurrence = normalizeRecurrence(patch.recurrence);
  if (patch.sort_order !== undefined && Number.isFinite(Number(patch.sort_order))) {
    next.sort_order = Number(patch.sort_order);
  }

  let dueChanged = false;
  if (patch.due !== undefined) {
    const dueAt = patch.due ? parseLocalInput(patch.due, tz) : null;
    if (patch.due && dueAt == null) throw new ValidationError('invalid due date (use a year between 2000 and 2100)');
    if (dueAt !== existing.due_at) {
      next.due_at = dueAt;
      dueChanged = true;
      logs.push(dueAt == null ? 'Due date removed' : `Due date set to ${formatLocal(dueAt, tz)}`);
    }
  }

  let statusChanged = false;
  if (patch.status !== undefined && STATUSES.includes(patch.status) && patch.status !== existing.status) {
    statusChanged = true;
    if (patch.status === 'completed' && next.recurrence) {
      const dueAt = nextRecurrenceDue(next.recurrence, next.due_at, now, tz);
      next.status = 'not_started';
      next.completed_at = null;
      next.due_at = dueAt;
      dueChanged = true;
      logs.push(
        `Completed — repeats ${RECURRENCE_LABELS[next.recurrence].toLowerCase()}, next due ${formatLocal(dueAt, tz)}. Moved back to ${STATUS_LABELS.not_started}`
      );
    } else {
      next.status = patch.status;
      next.completed_at = patch.status === 'completed' ? now : null;
      logs.push(`Moved from ${STATUS_LABELS[existing.status]} to ${STATUS_LABELS[patch.status]}`);
    }
    next.status_changed_at = now;
    if (patch.sort_order === undefined) {
      const top = await env.DB.prepare(
        `SELECT MIN(sort_order) AS m FROM activities WHERE status = ?1`
      ).bind(next.status).first();
      next.sort_order = (top?.m ?? 1) - 1;
    }
  }

  if (dueChanged || statusChanged) {
    next.next_overdue_at =
      next.due_at != null && next.status !== 'completed' ? nextOverdueReminder(next.due_at, now, tz) : null;
  }
  if (statusChanged) {
    next.next_waiting_at = next.status === 'waiting' ? nextWaitingNudge(now, now, tz) : null;
  }
  next.updated_at = now;

  const statements = [
    env.DB.prepare(
      `UPDATE activities SET
        title = ?1, description = ?2, status = ?3, priority = ?4, project_id = ?5, due_at = ?6,
        recurrence = ?7, sort_order = ?8, updated_at = ?9, status_changed_at = ?10, completed_at = ?11,
        next_overdue_at = ?12, next_waiting_at = ?13
       WHERE id = ?14`
    ).bind(
      next.title, next.description, next.status, next.priority, next.project_id, next.due_at,
      next.recurrence, next.sort_order, next.updated_at, next.status_changed_at, next.completed_at,
      next.next_overdue_at, next.next_waiting_at, id
    ),
    ...logs.map((body, i) => systemNote(env, id, body, now + i)),
  ];
  if (dueChanged) statements.push(resetRemindersStatement(env, id, next.due_at, now));
  await env.DB.batch(statements);

  return getActivity(env, id);
}

/**
 * When the due date moves, reminders are re-armed. Any whose time has
 * already passed are marked as fired so they don't all go off at once.
 */
function resetRemindersStatement(env, activityId, dueAt, now) {
  if (dueAt == null) {
    return env.DB.prepare(`UPDATE activity_reminders SET fired_at = ?2 WHERE activity_id = ?1`)
      .bind(activityId, now);
  }
  return env.DB.prepare(
    `UPDATE activity_reminders
       SET fired_at = CASE WHEN ?2 - offset_minutes * 60000 <= ?3 THEN ?3 ELSE NULL END
     WHERE activity_id = ?1`
  ).bind(activityId, dueAt, now);
}

export async function deleteActivity(env, id) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM activity_notes WHERE activity_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM activity_reminders WHERE activity_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM notifications WHERE activity_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM activities WHERE id = ?1`).bind(id),
  ]);
}

/** Restores an archived (or any completed) activity back to Not started. */
export async function restoreActivity(env, id, tz) {
  return updateActivity(env, id, { status: 'not_started' }, tz);
}

async function touch(env, activityId, now) {
  await env.DB.prepare(`UPDATE activities SET updated_at = ?1 WHERE id = ?2`).bind(now, activityId).run();
}

// ---------------- Notes ----------------

export async function addNote(env, activityId, body) {
  const text = String(body || '').trim().slice(0, 5000);
  if (!text) throw new ValidationError('note is empty');
  if (!(await env.DB.prepare(`SELECT 1 FROM activities WHERE id = ?1`).bind(activityId).first())) return null;
  const now = Date.now();
  const note = { id: newId(), activity_id: activityId, kind: 'note', body: text, created_at: now, edited_at: null };
  await env.DB.prepare(
    `INSERT INTO activity_notes (id, activity_id, kind, body, created_at) VALUES (?1, ?2, 'note', ?3, ?4)`
  ).bind(note.id, activityId, text, now).run();
  await touch(env, activityId, now);
  return note;
}

export async function editNote(env, noteId, body) {
  const text = String(body || '').trim().slice(0, 5000);
  if (!text) throw new ValidationError('note is empty');
  const note = await env.DB.prepare(`SELECT * FROM activity_notes WHERE id = ?1`).bind(noteId).first();
  if (!note) return null;
  if (note.kind !== 'note') throw new ValidationError('automatic entries cannot be edited');
  const now = Date.now();
  await env.DB.prepare(`UPDATE activity_notes SET body = ?1, edited_at = ?2 WHERE id = ?3`)
    .bind(text, now, noteId).run();
  await touch(env, note.activity_id, now);
  return { ...note, body: text, edited_at: now };
}

export async function deleteNote(env, noteId) {
  const note = await env.DB.prepare(`SELECT * FROM activity_notes WHERE id = ?1`).bind(noteId).first();
  if (!note) return false;
  if (note.kind !== 'note') throw new ValidationError('automatic entries cannot be deleted');
  await env.DB.prepare(`DELETE FROM activity_notes WHERE id = ?1`).bind(noteId).run();
  return true;
}

// ---------------- Reminders (before due date) ----------------

/**
 * Replaces an activity's reminder set with `offsets` (minutes before due).
 * Reminders that already existed keep their fired state; new ones whose
 * time has already passed start out as fired so they don't fire late.
 */
export async function setReminders(env, activityId, offsets) {
  const activity = await env.DB.prepare(`SELECT * FROM activities WHERE id = ?1`).bind(activityId).first();
  if (!activity) return null;
  const now = Date.now();
  const wanted = [...new Set(
    (offsets || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 60 * 24 * 365)
  )].slice(0, 10);

  const { results: current } = await env.DB.prepare(
    `SELECT * FROM activity_reminders WHERE activity_id = ?1`
  ).bind(activityId).all();
  const currentOffsets = new Set(current.map((r) => r.offset_minutes));

  const statements = [];
  for (const r of current) {
    if (!wanted.includes(r.offset_minutes)) {
      statements.push(env.DB.prepare(`DELETE FROM activity_reminders WHERE id = ?1`).bind(r.id));
    }
  }
  for (const offset of wanted) {
    if (currentOffsets.has(offset)) continue;
    const alreadyPast = activity.due_at == null || activity.due_at - offset * 60000 <= now;
    statements.push(
      env.DB.prepare(
        `INSERT INTO activity_reminders (id, activity_id, offset_minutes, fired_at) VALUES (?1, ?2, ?3, ?4)`
      ).bind(newId(), activityId, offset, alreadyPast ? now : null)
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);

  const { results } = await env.DB.prepare(
    `SELECT * FROM activity_reminders WHERE activity_id = ?1 ORDER BY offset_minutes DESC`
  ).bind(activityId).all();
  return results;
}

// ---------------- Notifications (in-app inbox) ----------------

export async function listNotifications(env, limit = 50) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?1`
  ).bind(limit).all();
  return results;
}

export async function unreadCount(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL`).first();
  return row?.c ?? 0;
}

export async function markNotificationRead(env, id) {
  await env.DB.prepare(`UPDATE notifications SET read_at = ?1 WHERE id = ?2 AND read_at IS NULL`)
    .bind(Date.now(), id).run();
}

export async function markAllNotificationsRead(env) {
  await env.DB.prepare(`UPDATE notifications SET read_at = ?1 WHERE read_at IS NULL`).bind(Date.now()).run();
}

export async function insertNotification(env, n) {
  const row = { id: newId(), created_at: Date.now(), read_at: null, ...n };
  await env.DB.prepare(
    `INSERT INTO notifications (id, activity_id, kind, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(row.id, row.activity_id, row.kind, row.title, row.body, row.created_at).run();
  return row;
}

export async function pruneNotifications(env, now) {
  await env.DB.prepare(`DELETE FROM notifications WHERE created_at < ?1`).bind(now - 60 * 24 * 3600 * 1000).run();
}

// ---------------- Scheduler queries ----------------

/** Earliest moment any reminder/nudge needs to go out, or null. */
export async function nextScheduledEvent(env) {
  const row = await env.DB.prepare(
    `SELECT MIN(t) AS next FROM (
       SELECT MIN(next_overdue_at) AS t FROM activities
         WHERE status != 'completed' AND next_overdue_at IS NOT NULL
       UNION ALL
       SELECT MIN(next_waiting_at) FROM activities
         WHERE status = 'waiting' AND next_waiting_at IS NOT NULL
       UNION ALL
       SELECT MIN(a.due_at - r.offset_minutes * 60000) FROM activity_reminders r
         JOIN activities a ON a.id = r.activity_id
         WHERE r.fired_at IS NULL AND a.due_at IS NOT NULL AND a.status != 'completed'
     )`
  ).first();
  return row?.next ?? null;
}

export async function dueOverdueReminders(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM activities WHERE status != 'completed' AND next_overdue_at IS NOT NULL AND next_overdue_at <= ?1`
  ).bind(now).all();
  return results;
}

export async function setNextOverdue(env, id, ts) {
  await env.DB.prepare(`UPDATE activities SET next_overdue_at = ?1 WHERE id = ?2`).bind(ts, id).run();
}

export async function dueWaitingNudges(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM activities WHERE status = 'waiting' AND next_waiting_at IS NOT NULL AND next_waiting_at <= ?1`
  ).bind(now).all();
  return results;
}

export async function setNextWaiting(env, id, ts) {
  await env.DB.prepare(`UPDATE activities SET next_waiting_at = ?1 WHERE id = ?2`).bind(ts, id).run();
}

export async function duePreReminders(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT r.id AS reminder_id, r.offset_minutes, a.*
       FROM activity_reminders r JOIN activities a ON a.id = r.activity_id
      WHERE r.fired_at IS NULL AND a.due_at IS NOT NULL AND a.status != 'completed'
        AND a.due_at - r.offset_minutes * 60000 <= ?1`
  ).bind(now).all();
  return results;
}

export async function markReminderFired(env, reminderId, now) {
  await env.DB.prepare(`UPDATE activity_reminders SET fired_at = ?1 WHERE id = ?2`).bind(now, reminderId).run();
}

// ---------------- Push subscriptions ----------------

export async function saveSubscription(env, sub) {
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).bind(newId(), sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now()).run();
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

/** Recomputes every reminder slot (used when the time zone setting changes). */
export async function replanAllSchedules(env, tz) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, status, due_at, status_changed_at FROM activities WHERE status != 'completed'`
  ).all();
  const statements = results.map((a) =>
    env.DB.prepare(`UPDATE activities SET next_overdue_at = ?1, next_waiting_at = ?2 WHERE id = ?3`).bind(
      a.due_at != null ? nextOverdueReminder(a.due_at, now, tz) : null,
      a.status === 'waiting' ? nextWaitingNudge(a.status_changed_at, now, tz) : null,
      a.id
    )
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

// ---------------- Print sheet ----------------

/** Open (not completed) activities plus each one's most recent work-log note. */
export async function loadPrintData(env) {
  const [activities, notes] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM activities WHERE status != 'completed'`),
    env.DB.prepare(
      `SELECT n.activity_id, n.body, n.created_at FROM activity_notes n
        WHERE n.kind = 'note' AND n.created_at = (
          SELECT MAX(created_at) FROM activity_notes m WHERE m.activity_id = n.activity_id AND m.kind = 'note'
        )`
    ),
  ]);
  const lastNotes = new Map();
  for (const n of notes.results) lastNotes.set(n.activity_id, { body: n.body, created_at: n.created_at });
  return { activities: activities.results, lastNotes };
}
